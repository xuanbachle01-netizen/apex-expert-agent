// The environment: machine-specific values that sources in this repo refer to as
// @@NAME@@ tokens instead of hardcoding them (paths under C:\Users\..., the node.exe).
//
//   render(x)     tokens -> values, before anything is sent to n8n (build, push, deploy)
//   templatize(x) values -> tokens, before a server response is saved to the repo (pull, build)
//
// Both take a string or any JSON value. Strings under a "jsCode" key are JavaScript, where a
// backslash is written twice; there the escaped form of a value is used.
//
// Values: .env (or the process environment) overrides the defaults below, which come from
// this checkout's location, os.homedir() and the running node.
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

// A setting from the process environment or .env, '' when neither has it. The database
// target (APEX_CONNECTION, APEX_WORKSPACE, APEX_SCHEMA, ORDS_BASE_URL) is read this way at run
// time by scripts/lib/sqlcl.mjs and apex-agent-db.mjs; the agents ask for it with DB_Target,
// so no prompt holds it.
export const envValue = (name) => process.env[name] || env[name] || '';
const pick = (name, fallback) => envValue(name) || fallback;

export const TOKENS = {
  PROJECT_ROOT: pick('PROJECT_ROOT', ROOT),
  USER_HOME: pick('USER_HOME', os.homedir()),
  NODE_EXE: pick('NODE_EXE', process.execPath),
};
const TEMPLATIZE = ['NODE_EXE', 'PROJECT_ROOT', 'USER_HOME'];

const jsEscape = (s) => s.replace(/\\/g, '\\\\');
const TOKEN = /@@([A-Z_]+)@@/g;

function renderString(s, js) {
  return s.replace(TOKEN, (all, name) => {
    if (!(name in TOKENS)) throw new Error('unknown token ' + all + ' (known: ' + Object.keys(TOKENS).join(', ') + ')');
    if (!TOKENS[name]) {
      throw new Error(all + ' has no value: set ' + name + ' in .env');
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
