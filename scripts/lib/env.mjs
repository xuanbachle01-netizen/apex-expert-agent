// The environment: machine- and target-specific values that sources in this repo
// refer to as @@NAME@@ tokens instead of hardcoding them (paths under C:\Users\...,
// the node.exe, the APEX connection / workspace / schema, the ORDS URL).
//
//   render(x)     tokens -> values, before anything is sent to n8n (build, push, deploy)
//   templatize(x) values -> tokens, before a server response is saved to the repo (pull, build)
//
// Both take a string or any JSON value. Strings under a "jsCode" key are JavaScript, where a
// backslash is written twice; there the escaped form of a value is used.
//
// Values: .env (or the process environment) overrides the defaults below, which come from
// this checkout's location, os.homedir(), the running node, squad-install.config.json,
// agents/apex-expert/apex-expert.json and the last database probe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readEnvFile() {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  } catch {
    return {};
  }
}
export const env = readEnvFile();

const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return {};
  }
};
const squad = readJson('squad-install.config.json');
const expert = readJson(path.join('agents', 'apex-expert', 'apex-expert.json'));
// A setting from the process environment or .env, '' when neither has it.
export const envValue = (name) => process.env[name] || env[name] || '';
const pick = (name, fallback) => envValue(name) || fallback;

// The database target: .env, else the older keys in squad-install.config.json.
const APEX_CONNECTION = pick('APEX_CONNECTION', squad.connection || '');
const APEX_WORKSPACE = pick('APEX_WORKSPACE', squad.workspace || '');
// What SQLcl last found on the database (scripts/squad-install.mjs --probe writes it), if it
// is about the configured connection: { apex: '26.1.0', db: 'Oracle AI Database 26ai Free 23.26.2.0.0' }.
const probed = readJson(path.join('workspace', '.squad-install', '_target.json'));
const target = probed.connection && probed.connection === APEX_CONNECTION ? probed : {};
const dbMatch = String(target.db || '').match(/^(.*?)\s+(\d+\.\d+)(\.\d+)+\s*$/);

const ORDS_BASE_URL = pick('ORDS_BASE_URL', expert.ordsBaseUrl ? String(expert.ordsBaseUrl).replace(/\/?$/, '/') : '');
export const TOKENS = {
  PROJECT_ROOT: pick('PROJECT_ROOT', ROOT),
  USER_HOME: pick('USER_HOME', os.homedir()),
  NODE_EXE: pick('NODE_EXE', process.execPath),
  APEX_CONNECTION,
  APEX_WORKSPACE,
  APEX_SCHEMA: pick('APEX_SCHEMA', squad.schema || APEX_WORKSPACE),
  ORDS_BASE_URL,
  // Where ORDS serves the workspace's apps: <ORDS>/r/<workspace path prefix>/<app alias>/
  APEX_APP_URL: pick('APEX_APP_URL', ORDS_BASE_URL && APEX_WORKSPACE ? ORDS_BASE_URL + 'r/' + APEX_WORKSPACE.toLowerCase() + '/' : ''),
  // From the probe: '26.1', 'Oracle AI Database 26ai Free', '23.26'.
  APEX_VERSION: pick('APEX_VERSION', String(target.apex || '').split('.').slice(0, 2).join('.')),
  DB_PRODUCT: pick('DB_PRODUCT', dbMatch ? dbMatch[1] : ''),
  DB_VERSION: pick('DB_VERSION', dbMatch ? dbMatch[2] : ''),
};
const PROBED = new Set(['APEX_VERSION', 'DB_PRODUCT', 'DB_VERSION']);
// Saved files get only the tokens whose value says which one it was. APEX_CONNECTION,
// _WORKSPACE and _SCHEMA are often the same name, so those stay literal in saved
// server responses; their sources (prompts, skills, build scripts) use the tokens.
const TEMPLATIZE = ['APEX_APP_URL', 'ORDS_BASE_URL', 'NODE_EXE', 'PROJECT_ROOT', 'USER_HOME'];

const jsEscape = (s) => s.replace(/\\/g, '\\\\');
const TOKEN = /@@([A-Z_]+)@@/g;

function renderString(s, js) {
  return s.replace(TOKEN, (all, name) => {
    if (!(name in TOKENS)) throw new Error('unknown token ' + all + ' (known: ' + Object.keys(TOKENS).join(', ') + ')');
    if (!TOKENS[name]) {
      throw new Error(all + ' has no value: ' + (PROBED.has(name) ? 'run "node scripts/squad-install.mjs --probe" (reads it from the database) or ' : '') + 'set ' + name + ' in .env');
    }
    return js ? jsEscape(TOKENS[name]) : TOKENS[name];
  });
}

function templatizeString(s, js) {
  // Longest value first, so PROJECT_ROOT wins over the USER_HOME it lies in.
  const pairs = TEMPLATIZE.filter((n) => TOKENS[n]).map((n) => [n, js ? jsEscape(TOKENS[n]) : TOKENS[n]]).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of pairs) {
    // Paths on Windows are case-insensitive; a value is replaced only where it ends at a
    // path boundary, so C:\Users\ann does not match inside C:\Users\anna.
    const boundary = /[\\/]$/.test(value) ? '' : '(?![\\w.-])';
    const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + boundary, 'gi');
    s = s.replace(re, '@@' + name + '@@');
  }
  return s;
}

function walk(x, fn, js = false) {
  if (typeof x === 'string') return fn(x, js);
  if (Array.isArray(x)) return x.map((v) => walk(v, fn, js));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v, fn, k === 'jsCode')]));
  return x;
}

export const render = (x, { js = false } = {}) => walk(x, renderString, js);
export const templatize = (x, { js = false } = {}) => walk(x, templatizeString, js);
