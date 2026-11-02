#!/usr/bin/env node
// Database tool of the APEX Expert agent (n8n workflow APEX_Agent_Tools runs it).
// Everything goes through SQLcl on the connection + APEX workspace configured in
// squad-install.config.json (APEX_AI); agents cannot choose another target.
//
// Usage: node scripts/apex-agent-db.mjs --op <op> [--session <key>] [--app-id <n>] [--text-file <file>] [--json]
//   target      connection, schema, APEX and compiler versions (asks the database)
//   query       ONE read-only SELECT / WITH from --text-file; CSV, at most 200 rows
//   execute     a SQL / PL/SQL script from --text-file, committed; reports errors and invalid objects
//   export      APEXlang export of application --app-id into workspace/<session>/app/, pinned
//               so a later install updates that application in place
//   validate    live check of the session's app: SQLcl `apex validate` (no import)
//   install     scripts + validate + import of the session's app (scripts/squad-install.mjs)
//   page_check  logs into application --app-id through ORDS and fetches its pages
//               (--text-file may list page numbers; default all except login/global pages)
//   ui_test     runs a scenario of browser steps on application --app-id in headless Edge
//               (--text-file: a JSON array of steps, or a scenario file in the project; scripts/lib/ui-test.mjs)
// --json prints { ok, status, text }: ok true = done/clean, false = errors to fix, null = could not run.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  ROOT, WS_ROOT, CONFIG_FILE, REGISTRY_DIR, TMP_ROOT, readJson, writeJson, clip, posix, loadConfig, configPaths, findAppRoot, walk, runSqlcl, sections,
  SETTINGS, TARGET_SQL, workspaceSql, parseTarget, connectFailure, target, parseSqlErrors, parseCompilerOutput, groupByMessage, stageApp,
} from './lib/sqlcl.mjs';

const SQLCL_TIMEOUT_MS = 100 * 1000; // n8n cancels a workflow tool after 120 s
const MAX_ROWS = 200;
const MAX_TEXT = 24000;
const AGENT_CFG = path.join(ROOT, 'agents', 'apex-expert', 'apex-expert.json');
const SQL_LOG_DIR = path.join(WS_ROOT, '.apex-agent', 'sql-log');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
};
const json = args.includes('--json');
const op = option('--op');
const session = option('--session').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
const appIdArg = option('--app-id').trim();
const textFile = option('--text-file');
const text = textFile && fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : '';

let note = '';
function finish(result) {
  if (note) result = { ...result, text: result.text + '\n' + note };
  result.text = clip(result.text, MAX_TEXT);
  process.stdout.write((json ? JSON.stringify(result) : result.text) + '\n');
  process.exit(result.ok === false ? 1 : 0);
}
const env = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  } catch {
    return {};
  }
})();

// ---------------------------------------------------------------- SQL text checks
// Text with string literals, quoted identifiers and comments blanked out, so the
// checks below only see real SQL tokens.
function codeOnly(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; continue; }
    if (two === '/*') { const j = sql.indexOf('*/', i + 2); out += ' '; i = j < 0 ? sql.length : j + 2; continue; }
    const q = /^[nN]?[qQ]'(.)/.exec(sql.slice(i, i + 4));
    if (q) {
      const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[q[1]] || q[1];
      const start = i + q[0].length;
      const j = sql.indexOf(close + "'", start);
      out += "''"; i = j < 0 ? sql.length : j + 2; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j++; continue; } break; }
      }
      out += c + c; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

function checkQuery(sql) {
  let s = sql.trim();
  // A trailing terminator is fine; anything after it is a second statement.
  s = s.replace(/[\s;\/]+$/, '');
  const code = codeOnly(s).trim();
  if (!code) return { problem: 'no SQL given. Pass ONE SELECT (or WITH ... SELECT) statement.' };
  if (!/^(select|with)\b/i.test(code)) return { problem: 'SQL_Query runs only ONE SELECT or WITH statement. Use SQL_Execute for DDL, DML or PL/SQL (the user approves each run).' };
  if (code.includes(';')) return { problem: 'only ONE statement per SQL_Query call (found a ";" inside it). Split it into separate calls.' };
  if (/\bfor\s+update\b/i.test(code)) return { problem: 'SELECT ... FOR UPDATE locks rows; SQL_Query is read-only.' };
  return { sql: s };
}

// SQLcl client commands an agent script must not use: they reach outside the
// database (host, spool, scripts on disk), switch the connection, end the
// session early, or run APEX/Liquibase operations that have their own tools.
const CLIENT_COMMANDS = [
  [/^\s*(host|!|\$)/i, 'host commands'],
  [/^\s*conn(ect)?\s+(?!by\b)/i, 'CONNECT (the connection is fixed)'],
  [/^\s*disc(onnect)?\s*;?\s*$/i, 'DISCONNECT'],
  [/^\s*(exit|quit)\b/i, 'EXIT/QUIT'],
  [/^\s*@/, 'running script files (@)'],
  [/^\s*(start|sta)\s+\S+\.(sql|pls|pks|pkb|txt)\b/i, 'running script files (START)'],
  [/^\s*spo(ol)?\s+/i, 'SPOOL'],
  [/^\s*(apex|liquibase|lb|cd|save|get|edit|ed|script|alias|repeat|project|dbms_cloud)\s/i, 'this SQLcl client command'],
  [/^\s*set\s+(define|sqlprompt|echo)\b/i, 'changing these SQLcl settings'],
];
function checkScript(sql) {
  const code = codeOnly(sql);
  if (!code.trim()) return { problem: 'no SQL given.' };
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [re, what] of CLIENT_COMMANDS) {
      if (re.test(lines[i])) return { problem: 'line ' + (i + 1) + ' uses ' + what + ', which SQL_Execute does not allow. Send only SQL and PL/SQL (PL/SQL blocks end with a line containing only "/").' };
    }
  }
  return { sql };
}

function tmpFile(prefix, content) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const f = path.join(TMP_ROOT, prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.sql');
  fs.writeFileSync(f, content.replace(/\r\n?/g, '\n').replace(/\s*$/, '\n'), 'utf8');
  return f;
}

// ---------------------------------------------------------------- operations
function query(cfg) {
  const q = checkQuery(text);
  if (q.problem) return { ok: false, status: 'refused', text: 'SQL_Query: REFUSED -- ' + q.problem };
  const L = ['set define off', 'set sqlblanklines on', 'set echo off', 'set feedback off', 'set heading on', 'set pagesize 50000', 'set linesize 32767',
    'set long 4000', 'set sqlformat csv', 'whenever sqlerror continue',
    // Oracle refuses every INSERT/UPDATE/DELETE/MERGE in a read-only transaction.
    'set transaction read only;',
    'prompt ==SQUAD:QUERY==',
    'select * from (\n' + q.sql + '\n) fetch first ' + (MAX_ROWS + 1) + ' rows only;',
    'prompt ==SQUAD:END==', 'rollback;', 'exit'];
  const run = runSqlcl(cfg, L.join('\n') + '\n', SQLCL_TIMEOUT_MS);
  const sec = sections(run.stdout).find((s) => s.name === 'QUERY');
  if (!sec) return { ok: null, status: 'unavailable', text: 'SQL_Query: UNAVAILABLE -- ' + connectFailure(run) };
  const errors = parseSqlErrors(sec.lines);
  if (errors.length) return { ok: false, status: 'error', text: 'SQL_Query: ERROR -- ' + errors.map((e) => e.message).join(' | ') };
  const rows = sec.lines.filter((l) => l.trim());
  const dataRows = Math.max(0, rows.length - 1);
  const shown = rows.slice(0, MAX_ROWS + 1);
  return {
    ok: true, status: 'rows', rows: Math.min(dataRows, MAX_ROWS),
    text: (dataRows ? 'SQL_Query: ' + (dataRows > MAX_ROWS ? 'first ' + MAX_ROWS + ' rows (more exist; narrow the query)' : dataRows + ' row(s)') + ', CSV:\n' + shown.join('\n') : 'SQL_Query: no rows.'),
  };
}

function execute(cfg) {
  const s = checkScript(text);
  if (s.problem) return { ok: false, status: 'refused', text: 'SQL_Execute: REFUSED -- ' + s.problem };
  const file = tmpFile('exec', s.sql);
  try {
    // The schema is shared and may hold INVALID objects of other apps, so objects whose DDL
    // ran during this script (last_ddl_time after :t0) are reported apart from older ones.
    const L = [...SETTINGS, 'set feedback on', 'set serveroutput on size unlimited', ...TARGET_SQL, workspaceSql(cfg),
      'variable t0 varchar2(14)', "exec :t0 := to_char(sysdate - 1/86400, 'yyyymmddhh24miss')",
      'prompt ==SQUAD:SCRIPT:script==', '@"' + file + '"', ...SETTINGS, 'commit;',
      'prompt ==SQUAD:INVALID==',
      "select case when last_ddl_time >= to_date(:t0, 'yyyymmddhh24miss') then '#NEW#' else '#OLD#' end || object_type || ' ' || object_name from user_objects where status = 'INVALID' order by object_type, object_name;",
      'prompt ==SQUAD:END==', 'exit'];
    const run = runSqlcl(cfg, L.join('\n') + '\n', SQLCL_TIMEOUT_MS);
    const secs = sections(run.stdout);
    const t = parseTarget(cfg, secs);
    if (!t) return { ok: null, status: 'unavailable', text: 'SQL_Execute: UNAVAILABLE -- could not connect: ' + connectFailure(run) };
    const script = secs.find((x) => x.name === 'SCRIPT');
    const end = secs.find((x) => x.name === 'END');
    const inv = secs.find((x) => x.name === 'INVALID');
    const errors = script ? parseSqlErrors(script.lines) : [];
    const tagged = (tag) => (inv ? inv.lines.filter((l) => l.startsWith(tag)).map((l) => l.slice(tag.length).trim()) : []);
    const invalid = tagged('#NEW#');
    const olderInvalid = tagged('#OLD#');
    // Audit trail of what ran (outside every session folder).
    fs.mkdirSync(SQL_LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(SQL_LOG_DIR, stamp + (session ? '-' + session : '') + '.sql'),
      '-- ' + new Date().toISOString() + ' on ' + cfg.connection + (session ? ' (project ' + session + ')' : '') + '\n' + s.sql + '\n\n/* output:\n' + (script ? script.lines.join('\n') : run.stdout).replace(/\*\//g, '* /') + '\n*/\n', 'utf8');
    const out = [];
    const feedback = script ? script.lines.filter((l) => l.trim() && !/^(Error|In command|Error report|Help:|https?:)/.test(l.trim())).slice(0, 60) : [];
    if (!end) out.push('SQL_Execute: the SQLcl session ended early (exit code ' + run.code + '); the script may be incomplete.');
    out.push('SQL_Execute on ' + cfg.connection + ' (schema ' + t.schema + '): ' + (errors.length ? errors.length + ' ERROR(S)' : 'no errors') + '; committed.');
    for (const e of errors.slice(0, 40)) out.push('  ' + (e.unit ? e.unit + ' ' : '') + (e.line ? 'line ' + e.line + ': ' : '') + clip(e.message, 300) + (e.command ? '  [statement: ' + clip(e.command, 120) + ']' : ''));
    if (feedback.length) out.push('Output:', ...feedback.map((l) => '  ' + clip(l, 300)));
    out.push(invalid.length ? 'INVALID objects created or changed by this script (' + invalid.length + '): ' + invalid.join(', ') : 'Objects created or changed by this script: all valid.');
    if (invalid.length) out.push('Their compile errors are listed above; check one with SQL_Query: select line, text from user_errors where name = \'<NAME>\' order by sequence');
    if (olderInvalid.length) out.push('Note: ' + olderInvalid.length + ' older INVALID object(s) in the schema, not touched by this script (other apps; leave them alone unless asked): ' + clip(olderInvalid.join(', '), 600));
    return { ok: errors.length === 0 && invalid.length === 0 && Boolean(end), status: errors.length || invalid.length ? 'errors' : 'done', errors: errors.length, invalid: invalid.length, text: out.join('\n') };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function sessionDirOf(key) {
  const settings = readJson(path.join(WS_ROOT, '.squad-sessions', key + '.json')) || {};
  const cfg = configPaths(readJson(CONFIG_FILE) || {});
  return path.join(settings.workingFolder || cfg.workingFolder || WS_ROOT, key);
}

function appInfo(cfg, appId) {
  const run = runSqlcl(cfg, [...SETTINGS, ...TARGET_SQL, workspaceSql(cfg), 'prompt ==SQUAD:APP==',
    "select '#APP#' || application_id || '|' || alias || '|' || pages || '|' || application_name from apex_applications where application_id = " + appId + " and workspace = '" + cfg.workspace + "';",
    "select '#PG#' || page_id || '|' || page_alias || '|' || page_mode || '|' || page_requires_authentication || '|' || page_name from apex_application_pages where application_id = " + appId + ' order by page_id;',
    'prompt ==SQUAD:END==', 'exit'].join('\n') + '\n', SQLCL_TIMEOUT_MS);
  const secs = sections(run.stdout);
  const t = parseTarget(cfg, secs);
  if (!t) return { problem: 'UNAVAILABLE -- could not connect: ' + connectFailure(run) };
  const lines = (secs.find((s) => s.name === 'APP') || { lines: [] }).lines;
  const a = lines.find((l) => l.startsWith('#APP#'));
  if (!a) return { problem: 'application ' + appId + ' does not exist in APEX workspace ' + cfg.workspace + '.' };
  const [id, alias, pages, ...name] = a.slice(5).split('|');
  const pageList = lines.filter((l) => l.startsWith('#PG#')).map((l) => {
    const [pid, palias, mode, auth, ...pname] = l.slice(4).split('|');
    return { id: +pid, alias: palias.trim(), mode: mode.trim(), auth: auth.trim(), name: pname.join('|').trim() };
  });
  return { t, app: { id: +id, alias: alias.trim(), pages: +pages, name: name.join('|').trim() }, pages: pageList };
}

function exportApp(cfg) {
  if (!session) return { ok: false, status: 'usage', text: 'Export_App: pass session (the project key from New_Project).' };
  if (!/^\d{1,9}$/.test(appIdArg)) return { ok: false, status: 'usage', text: 'Export_App: pass app_id, the numeric APEX application id.' };
  const dir = sessionDirOf(session);
  if (!fs.existsSync(dir)) return { ok: false, status: 'usage', text: 'Export_App: unknown project "' + session + '". Create one with New_Project first.' };
  if (findAppRoot(dir) !== null) return { ok: false, status: 'refused', text: 'Export_App: REFUSED -- project ' + session + ' already contains an app. Export into a new, empty project (New_Project with text "empty").' };
  const info = appInfo(cfg, +appIdArg);
  if (info.problem) return { ok: null, status: 'unavailable', text: 'Export_App: ' + info.problem };
  const tmp = path.join(TMP_ROOT, 'export-' + session + '-' + Date.now().toString(36));
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const run = runSqlcl(cfg, [...SETTINGS, 'prompt ==SQUAD:EXPORT==',
      'apex export -applicationid ' + info.app.id + ' -exptype APEXLANG -dir "' + tmp + '" -skipexportdate',
      'prompt ==SQUAD:END==', 'exit'].join('\n') + '\n', SQLCL_TIMEOUT_MS);
    const root = findAppRoot(tmp);
    if (root === null) {
      return { ok: null, status: 'failed', text: 'Export_App: FAILED -- SQLcl wrote no application.apx: ' + clip(run.stdout.split('\n').filter((l) => l.trim()).slice(-8).join(' | ') + ' ' + run.stderr, 600) };
    }
    const dest = path.join(dir, 'app');
    fs.cpSync(path.join(tmp, root), dest, { recursive: true });
    // Pin the id like squad-install does after an install, so Install_App updates
    // this application in place instead of creating a copy (its alias guard still applies).
    writeJson(path.join(REGISTRY_DIR, session + '.json'), {
      session, connection: cfg.connection, workspace: cfg.workspace, schema: info.t.schema,
      appId: info.app.id, alias: info.app.alias, appName: info.app.name,
      firstInstalledAt: null, exportedAt: new Date().toISOString(), lastOk: null,
    });
    const files = walk(dest);
    return {
      ok: true, status: 'exported', appId: info.app.id,
      text: 'Export_App: application ' + info.app.id + ' "' + info.app.name + '" (alias ' + info.app.alias + ', ' + info.app.pages + ' pages) exported as APEXlang into project ' + session + ' under app/ (' + files.length + ' files). ' +
        'The project is pinned to application ' + info.app.id + ': Install_App on this project UPDATES that application.\nFiles:\n' +
        files.slice(0, 120).map((f) => '- app/' + f).join('\n') + (files.length > 120 ? '\n... and ' + (files.length - 120) + ' more (FS_List shows all)' : ''),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function validate(cfg) {
  if (!session) return { ok: false, status: 'usage', text: 'Check_App: pass session (the project key).' };
  const dir = sessionDirOf(session);
  const appRoot = fs.existsSync(dir) ? findAppRoot(dir) : null;
  if (appRoot === null) return { ok: false, status: 'failed', text: 'Check_App: FAILED -- no application.apx in project ' + session + '.' };
  const reg = readJson(path.join(REGISTRY_DIR, session + '.json')) || {};
  const pinned = reg.appId && reg.connection === cfg.connection && reg.workspace === cfg.workspace ? reg.appId : null;
  const stage = path.join(TMP_ROOT, 'validate-' + session + '-' + Date.now().toString(36));
  const appLabel = (posix(appRoot) || '.') + '/';
  try {
    stageApp(path.join(dir, appRoot), stage, cfg, pinned);
    const run = runSqlcl(cfg, [...SETTINGS, 'set encoding UTF-8', ...TARGET_SQL, workspaceSql(cfg),
      'prompt ==SQUAD:VALIDATE==', 'apex validate -input "' + stage + '"', 'prompt ==SQUAD:END==', 'exit'].join('\n') + '\n', SQLCL_TIMEOUT_MS);
    const secs = sections(run.stdout);
    const t = parseTarget(cfg, secs);
    if (!t) return { ok: null, status: 'unavailable', text: 'Check_App: UNAVAILABLE -- could not connect: ' + connectFailure(run) + '. Do not fall back to offline checks; report that SQLcl is unavailable.' };
    const sec = secs.find((s) => s.name === 'VALIDATE');
    if (!sec || !secs.find((s) => s.name === 'END')) return { ok: null, status: 'unavailable', text: 'Check_App: UNAVAILABLE -- the SQLcl session ended early (exit code ' + run.code + ').' };
    const passed = sec.lines.some((l) => /^Validation successful/.test(l));
    const res = parseCompilerOutput(sec.lines);
    const out = [];
    if (passed && !res.errors.length) {
      out.push('Check_App: PASSED -- the live APEXlang compiler (SQLcl apex validate on ' + cfg.connection + ', APEX ' + t.apex + ') accepts ' + appLabel + ' with 0 errors' + (pinned ? ' (pinned to application ' + pinned + ')' : '') + '.');
    } else {
      out.push('Check_App: FAILED -- ' + (res.errors.length || 'unknown') + ' APEXlang compile error(s) from the live APEXlang compiler (SQLcl apex validate on ' + cfg.connection + ', APEX ' + t.apex + '). File paths are relative to ' + appLabel);
      const byFile = {};
      for (const e of res.errors) (byFile[e.file] = byFile[e.file] || []).push(e);
      let shown = 0;
      for (const [file, list] of Object.entries(byFile)) {
        if (shown >= 60) break;
        out.push(file);
        for (const e of list) {
          if (shown++ >= 60) break;
          out.push('  line ' + e.line + (e.column ? ':' + e.column : '') + ': ' + e.type + ' ' + clip(e.message, /Valid /.test(e.message) ? 900 : 300));
        }
      }
      if (res.errors.length > shown) out.push('... and ' + (res.errors.length - shown) + ' more.');
      if (!res.errors.length) out.push('SQLcl output: ' + clip(sec.lines.filter((l) => l.trim()).join(' | '), 1200));
    }
    if (res.warnings.length) {
      out.push('Compiler warnings (' + res.warnings.length + ', not blocking; fix the "Invalid ..." and "ignored" ones in files you touch):');
      out.push(...groupByMessage(res.warnings, 12, 4));
    }
    return { ok: passed && !res.errors.length, status: passed ? 'passed' : 'failed', errors: res.errors.length, warnings: res.warnings.length, text: out.join('\n') };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function install() {
  if (!session) return { ok: false, status: 'usage', text: 'Install_App: pass session (the project key).' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'squad-install.mjs'), '--session', session, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 110 * 1000, windowsHide: true });
  try {
    return JSON.parse(String(r.stdout || '').trim().split('\n').pop());
  } catch {
    return { ok: null, status: 'unavailable', text: 'Install_App: UNAVAILABLE -- the installer did not answer (' + clip((r.error && r.error.message) || r.stderr || 'timeout', 400) + ').' };
  }
}

// ---------------------------------------------------------------- page check through ORDS
function httpClient(base) {
  const jar = new Map();
  const request = (method, url, body, headers = {}) => new Promise((resolve) => {
    const u = new URL(url, base);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, {
      method,
      // The development ORDS uses a self-signed certificate.
      rejectUnauthorized: false,
      headers: {
        'user-agent': 'apex-agent-page-check', accept: 'text/html,application/json',
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      for (const c of res.headers['set-cookie'] || []) {
        const kv = c.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (data.length < 4e6) data += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: data, url: u.href }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, body: '', url: u.href }));
    r.setTimeout(20000, () => r.destroy(new Error('timeout after 20 s')));
    if (body) r.write(body);
    r.end();
  });
  const get = async (url) => {
    let res = await request('GET', url);
    for (let i = 0; i < 8 && res.status >= 300 && res.status < 400 && res.location; i++) res = await request('GET', new URL(res.location, res.url).href);
    return res;
  };
  return { request, get };
}
const unescapeHtml = (s) => String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const inputValue = (html, attr, name) => {
  const tag = (html.match(new RegExp('<input[^>]*\\b' + attr + '="' + name + '"[^>]*>')) || [''])[0];
  return unescapeHtml((tag.match(/\bvalue="([^"]*)"/) || [])[1] || '');
};
const titleOf = (html) => unescapeHtml((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
// Signs of a failed page: APEX's error page, an inline error or a raw ORA-/PLS- message.
function pageErrors(html) {
  const found = [];
  const add = (s) => { s = unescapeHtml(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (s && !found.includes(s)) found.push(clip(s, 300)); };
  for (const m of html.matchAll(/class="[^"]*\bt-Alert--danger\b[^"]*"[\s\S]{0,1500}?<div class="t-Alert-body">([\s\S]*?)<\/div>/g)) add(m[1]);
  for (const m of html.matchAll(/<div class="apex-page-error[^"]*"[^>]*>([\s\S]{0,800}?)<\/div>/g)) add(m[1]);
  for (const m of html.matchAll(/\b((?:ORA|PLS)-\d{5}:[^<"\n]{0,200})/g)) add(m[1]);
  if (/id="apex_error_page"|class="[^"]*\bt-ErrorPage\b/.test(html)) add('APEX error page: ' + titleOf(html));
  for (const m of html.matchAll(/apex\.message\.showErrors\(\s*\[\s*\{[^}]*"message"\s*:\s*"([^"]{1,300})"/g)) add(m[1]);
  return found;
}

async function pageCheck(cfg) {
  const agentCfg = readJson(AGENT_CFG) || {};
  const base = String(agentCfg.ordsBaseUrl || '').replace(/\/?$/, '/');
  if (base === '/') return { ok: null, status: 'unavailable', text: 'Page_Check: NOT CONFIGURED -- set "ordsBaseUrl" in agents/apex-expert/apex-expert.json.' };
  if (!/^\d{1,9}$/.test(appIdArg)) return { ok: false, status: 'usage', text: 'Page_Check: pass app_id, the numeric APEX application id.' };
  const info = appInfo(cfg, +appIdArg);
  if (info.problem) return { ok: null, status: 'unavailable', text: 'Page_Check: ' + info.problem };
  const wanted = (text.match(/\d+/g) || []).map(Number);
  const pages = info.pages.filter((p) => (wanted.length ? wanted.includes(p.id) : p.id !== 0 && p.id < 9999 && !/login/i.test(p.alias)));
  if (!pages.length) return { ok: false, status: 'usage', text: 'Page_Check: application ' + info.app.id + ' has none of the requested pages. Its pages: ' + info.pages.map((p) => p.id).join(', ') };
  const ws = cfg.workspace.toLowerCase();
  const appUrl = base + 'r/' + ws + '/' + info.app.alias.toLowerCase() + '/';
  const client = httpClient(base);
  const out = [];
  const started = Date.now();

  // Log in through the app's own login page when it asks for one (Oracle APEX Accounts
  // and other form logins): the same JSON submit the browser sends on "Sign In".
  let sessionId = '';
  const first = await client.get(appUrl);
  if (!first.status) return { ok: null, status: 'unavailable', text: 'Page_Check: UNAVAILABLE -- ORDS at ' + base + ' did not answer: ' + first.error };
  const html = first.body;
  const isLogin = /name="P\d+_USERNAME"|name="P\d+_PASSWORD"/.test(html) && /p_flow_step_id/.test(html);
  if (isLogin) {
    if (!env.APEX_TEST_USER || !env.APEX_TEST_PASSWORD) return { ok: null, status: 'unavailable', text: 'Page_Check: NOT CONFIGURED -- the app asks for a login; set APEX_TEST_USER and APEX_TEST_PASSWORD in .env.' };
    const step = inputValue(html, 'name', 'p_flow_step_id');
    const items = [...new Set([...html.matchAll(/name="(P\d+_[A-Z0-9_]+)"/g)].map((m) => m[1]))];
    const user = items.find((n) => /_USERNAME$/.test(n));
    const pass = items.find((n) => /_PASSWORD$/.test(n));
    const submit = [{ n: user, v: env.APEX_TEST_USER }, { n: pass, v: env.APEX_TEST_PASSWORD }];
    for (const n of items.filter((x) => /_REMEMBER$/.test(x))) submit.push({ n, v: 'N' });
    const action = unescapeHtml((html.match(/<form[^>]*\baction="([^"]+)"/) || [])[1] || 'wwv_flow.accept');
    // Like a browser: the relative action resolves against <base href="/ords/">, not the page URL.
    const baseHref = new URL(unescapeHtml((html.match(/<base[^>]*\bhref="([^"]+)"/) || [])[1] || '.'), first.url).href;
    const form = new URLSearchParams({
      p_flow_id: inputValue(html, 'name', 'p_flow_id'), p_flow_step_id: step, p_instance: inputValue(html, 'name', 'p_instance'),
      p_debug: '', p_request: 'LOGIN', p_reload_on_submit: inputValue(html, 'name', 'p_reload_on_submit') || 'S',
      p_page_submission_id: inputValue(html, 'name', 'p_page_submission_id'),
      p_json: JSON.stringify({ pageItems: { itemsToSubmit: submit, protected: inputValue(html, 'id', 'pPageItemsProtected'), rowVersion: '', formRegionChecksums: [] }, salt: inputValue(html, 'id', 'pSalt') }),
    }).toString();
    const post = await client.request('POST', new URL(action, baseHref).href, form, { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/html' });
    let next = post.location;
    let loginError = '';
    try {
      const j = JSON.parse(post.body);
      next = j.redirectURL || next;
      if (j.error || (j.errors && j.errors.length)) loginError = clip(j.error || j.errors.map((e) => e.message).join('; '), 300);
    } catch { /* an HTML answer or a plain redirect */ }
    const home = next ? await client.get(new URL(next, post.url).href) : post;
    sessionId = (home.url.match(/[?&]session=(\d+)/) || [])[1] || '';
    if (loginError || !sessionId || /name="P\d+_PASSWORD"/.test(home.body)) {
      return { ok: false, status: 'login_failed', text: 'Page_Check: LOGIN FAILED for user ' + env.APEX_TEST_USER + ' on application ' + info.app.id + (loginError ? ': ' + loginError : ' (still on the login page; HTTP ' + home.status + ')') + '. Pages were not checked.' };
    }
    out.push('Logged in as ' + env.APEX_TEST_USER + ' (APEX session ' + sessionId + ').');
  } else {
    sessionId = (first.url.match(/[?&]session=(\d+)/) || [])[1] || '';
    out.push('No login asked (public start page).');
  }

  let failed = 0;
  for (const p of pages) {
    if (Date.now() - started > 90 * 1000) { out.push('... stopped after 90 s; check the remaining pages in another call: ' + pages.slice(pages.indexOf(p)).map((x) => x.id).join(', ')); break; }
    const url = appUrl + (p.alias ? p.alias.toLowerCase() : String(p.id)) + (sessionId ? '?session=' + sessionId : '');
    const res = await client.get(url);
    const errs = pageErrors(res.body);
    const relogin = /name="P\d+_PASSWORD"/.test(res.body) && p.auth !== 'Public';
    const bad = res.status !== 200 || errs.length || relogin;
    if (bad) failed++;
    out.push((bad ? 'FAIL' : 'ok  ') + ' page ' + p.id + ' ' + JSON.stringify(p.name) + (p.mode && p.mode !== 'Normal' ? ' [' + p.mode + ']' : '') + ' -- HTTP ' + (res.status || res.error) +
      (titleOf(res.body) ? ', title "' + clip(titleOf(res.body), 80) + '"' : '') + (relogin ? ', redirected to the login page' : '') + (errs.length ? '\n      errors: ' + errs.join(' | ') : ''));
  }
  return {
    ok: failed === 0, status: failed ? 'failed' : 'passed', failed,
    text: 'Page_Check: application ' + info.app.id + ' "' + info.app.name + '" at ' + appUrl + ' -- ' + (failed ? failed + ' of ' + pages.length + ' page(s) FAILED' : 'all ' + pages.length + ' page(s) rendered without errors') + '.\n' + out.join('\n') +
      '\n(Rendering only: the page loaded without an APEX error. Clicks, dialogs and form submits are not exercised.)',
  };
}

// ---------------------------------------------------------------- ui_test
// A scenario of browser steps (scripts/lib/ui-test.mjs) from --text-file: a JSON array, or the
// path of a saved scenario in the project (e.g. tests/ac-1.json). Screenshots go to
// <project>/test-results/<time>/ when a session is given.
async function uiTest(cfg) {
  const started = Date.now();
  const { runUiTest, parseSteps, STEPS_HELP } = await import('./lib/ui-test.mjs');
  const agentCfg = readJson(AGENT_CFG) || {};
  const base = String(agentCfg.ordsBaseUrl || '').replace(/\/?$/, '/');
  if (base === '/') return { ok: null, status: 'unavailable', text: 'UI_Test: NOT CONFIGURED -- set "ordsBaseUrl" in agents/apex-expert/apex-expert.json.' };
  if (!/^\d{1,9}$/.test(appIdArg)) return { ok: false, status: 'usage', text: 'UI_Test: pass app_id, the numeric APEX application id.' };
  const dir = session ? sessionDirOf(session) : '';
  if (session && !fs.existsSync(dir)) return { ok: false, status: 'usage', text: 'UI_Test: unknown project "' + session + '". Pass a project key from New_Project, or "-" for none.' };
  let stepsText = text.trim();
  let source = '';
  if (/^[\w./-]+\.json$/.test(stepsText)) {
    if (!dir) return { ok: false, status: 'usage', text: 'UI_Test: steps names the file ' + stepsText + '; pass the session (project key) it belongs to.' };
    const file = path.resolve(dir, stepsText);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) return { ok: false, status: 'usage', text: 'UI_Test: ' + stepsText + ' does not exist in project ' + session + '.' };
    source = ' (' + posix(path.relative(dir, file)) + ')';
    stepsText = fs.readFileSync(file, 'utf8');
  }
  const parsed = parseSteps(stepsText);
  if (parsed.problem) return { ok: false, status: 'usage', text: 'UI_Test: ' + parsed.problem };
  const info = appInfo(cfg, +appIdArg);
  if (info.problem) return { ok: null, status: 'unavailable', text: 'UI_Test: ' + info.problem };
  const appUrl = base + 'r/' + cfg.workspace.toLowerCase() + '/' + info.app.alias.toLowerCase() + '/';
  // Watchdog: whatever hangs, answer before n8n cancels the tool at 120 s (finish() exits the process).
  const watchdog = new Promise((resolve) => setTimeout(() => resolve({ ok: null, status: 'unavailable', text: 'UI_Test: UNAVAILABLE -- the browser did not finish within 105 s; split the scenario or check the step that hangs.' }), Math.max(10000, started + 105 * 1000 - Date.now())).unref());
  const r = await Promise.race([watchdog, runUiTest({
    appUrl, pages: info.pages, steps: parsed.steps, user: env.APEX_TEST_USER, password: env.APEX_TEST_PASSWORD,
    outDir: dir ? path.join(dir, 'test-results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) : '',
    // n8n cancels the tool after 120 s; leave time for the last step and the report.
    deadline: started + 85 * 1000,
  })]);
  const head = 'UI_Test: application ' + info.app.id + ' "' + info.app.name + '" at ' + appUrl + source + ' -- ';
  return { ...r, text: (r.text.startsWith('UI_Test:') ? r.text : head + r.text) + (r.status === 'usage' ? '\n' + STEPS_HELP : '') };
}

// ---------------------------------------------------------------- main
const cfg = loadConfig(null);
if (cfg.problem) finish({ ok: null, status: 'disabled', text: 'APEX database tool: ' + cfg.problem });
note = cfg.note || '';
try {
  if (op === 'target') finish(target(cfg, true));
  else if (op === 'query') finish(query(cfg));
  else if (op === 'execute') finish(execute(cfg));
  else if (op === 'export') finish(exportApp(cfg));
  else if (op === 'validate') finish(validate(cfg));
  else if (op === 'install') finish(install());
  else if (op === 'page_check') finish(await pageCheck(cfg));
  else if (op === 'ui_test') finish(await uiTest(cfg));
  else finish({ ok: null, status: 'usage', text: 'Usage: node scripts/apex-agent-db.mjs --op target|query|execute|export|validate|install|page_check|ui_test [--session <key>] [--app-id <n>] [--text-file <file>] [--json]' });
} catch (err) {
  finish({ ok: null, status: 'unavailable', text: 'APEX database tool: UNAVAILABLE -- ' + clip(err && err.stack ? err.stack : String(err), 600) });
}
