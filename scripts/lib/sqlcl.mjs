// SQLcl helpers shared by scripts/squad-install.mjs (the squad's installer) and
// scripts/apex-agent-db.mjs (the APEX Expert agent's database tool): config and
// target, one SQLcl session per call, and the parsers for SQL script output and
// for the live APEXlang compiler (apex validate / apex import).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CONFIG_FILE = path.join(ROOT, 'squad-install.config.json');
export const WS_ROOT = path.join(ROOT, 'workspace');
export const SESSIONS_DIR = path.join(WS_ROOT, '.squad-sessions');
export const REGISTRY_DIR = path.join(WS_ROOT, '.squad-install');
export const TARGET_FILE = path.join(REGISTRY_DIR, '_target.json');
export const TMP_ROOT = path.join(ROOT, 'apexlang-skill', '.tmp-validate');
const SQLCL_TIMEOUT_MS = 3 * 60 * 1000; // n8n ends a Code node task after 5 minutes

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
export const clip = (s, n) => {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n) + ' ...' : s;
};
export const posix = (p) => p.split(path.sep).join('/');

// Paths in squad-install.config.json may start with ~ (the user's home folder) or be
// relative to the project; a bare "sqlcl" name ("sql") is left for the PATH. Same as
// squadConfig() in agents/src/shared-helpers.js.
const configPath = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : path.resolve(ROOT, p));
export function configPaths(cfg) {
  if (cfg.sqlcl && /^~|[\\/]/.test(cfg.sqlcl)) cfg.sqlcl = configPath(cfg.sqlcl);
  if (cfg.workingFolder) cfg.workingFolder = configPath(cfg.workingFolder);
  if (Array.isArray(cfg.allowedFolders)) cfg.allowedFolders = cfg.allowedFolders.map(configPath);
  return cfg;
}

// squad-install.config.json with a session's saved database choice applied, or { problem }.
// A `note` is set when the configured SQLcl was missing and another one was picked.
export function loadConfig(sessionSettings) {
  if (!fs.existsSync(CONFIG_FILE)) return { problem: 'NOT CONFIGURED -- squad-install.config.json does not exist.' };
  const cfg = readJson(CONFIG_FILE);
  if (!cfg) return { problem: 'NOT CONFIGURED -- squad-install.config.json is not valid JSON.' };
  configPaths(cfg);
  const db = (sessionSettings && sessionSettings.database) || null;
  if (db) {
    if (db.enabled === false) return { problem: 'DISABLED for this session (no database chosen on the APEX Squad page).' };
    cfg.enabled = true;
    cfg.connection = db.connection;
    cfg.workspace = db.workspace;
  }
  if (cfg.enabled === false) return { problem: 'DISABLED ("enabled": false in squad-install.config.json).' };
  // Both values end up in SQLcl commands, so keep them to plain identifiers.
  if (!/^[A-Za-z0-9_$#.-]{1,128}$/.test(cfg.connection || '')) return { problem: 'NOT CONFIGURED -- "connection" must be the name of a saved SQLcl connection.' };
  if (!/^[A-Za-z0-9_$#-]{1,255}$/.test(cfg.workspace || '')) return { problem: 'NOT CONFIGURED -- "workspace" must be the APEX workspace name.' };
  if (/prod/i.test(cfg.connection) && cfg.allowProduction !== true) {
    return { problem: 'BLOCKED -- connection "' + cfg.connection + '" looks like production. Agent-written SQL is not installed there unless "allowProduction": true is set.' };
  }
  return resolveSqlcl(cfg);
}

// APEXlang compiler version bundled with a SQLcl (from lib/apexlang-compiler-<version>.jar), or ''.
export function compilerBuild(sqlExe) {
  const lib = path.join(path.dirname(path.dirname(sqlExe)), 'lib');
  const jar = fs.existsSync(lib) ? fs.readdirSync(lib).find((f) => /^apexlang-compiler-\d/.test(f)) : null;
  return jar ? jar.match(/^apexlang-compiler-(\d+\.\d+\.\d+)/)[1] : '';
}
export const majorMinor = (v) => String(v || '').split('.').slice(0, 2).join('.');
const versionKey = (v) => String(v || '').split('.').map((n) => String(+n || 0).padStart(5, '0')).join('.');

// The configured sql.exe, or else a SQLcl from an installed VS Code SQL Developer extension.
// The configured one has been a link into an extension folder that VS Code later deleted,
// which turned every install into "SQLcl not found". The fallback prefers the SQLcl whose
// compiler matches the database's APEX version (from the last successful probe), else the newest.
function resolveSqlcl(cfg) {
  if (cfg.sqlcl && fs.existsSync(cfg.sqlcl)) return cfg;
  const extDir = path.join(process.env.USERPROFILE || '', '.vscode', 'extensions');
  const found = (fs.existsSync(extDir) ? fs.readdirSync(extDir) : [])
    .filter((d) => /^oracle\.sql-developer-/.test(d))
    .map((d) => path.join(extDir, d, 'dbtools', 'sqlcl', 'bin', 'sql.exe'))
    .filter((exe) => fs.existsSync(exe))
    .map((exe) => ({ exe, build: compilerBuild(exe) }))
    .sort((a, b) => versionKey(b.build).localeCompare(versionKey(a.build)));
  if (!found.length) return cfg;
  const apex = (readJson(TARGET_FILE) || {}).apex;
  const pick = found.find((f) => apex && majorMinor(f.build) === majorMinor(apex)) || found[0];
  const note = 'Note: the SQLcl in squad-install.config.json ("' + (cfg.sqlcl || '') + '") does not exist; used ' + pick.exe + ' instead. Set "sqlcl" in the config to keep this choice.';
  return { ...cfg, sqlcl: pick.exe, note };
}

// Workspace-relative folder holding application.apx ('' = the session root), or null.
// Same search as findAppRoot in the Squad Code nodes.
export function findAppRoot(dir) {
  let level = [''];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next = [];
    for (const rel of level) {
      const abs = path.join(dir, rel);
      if (fs.existsSync(path.join(abs, 'application.apx'))) return rel;
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && !['.apexlang', 'node_modules', '.git'].includes(e.name)) next.push(path.join(rel, e.name));
      }
    }
    level = next;
  }
  return null;
}

export function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(posix(path.relative(base, full)));
  }
  return out.sort();
}

export function runSqlcl(cfg, script, timeoutMs = SQLCL_TIMEOUT_MS) {
  const r = spawnSync(cfg.sqlcl || 'sql', ['-S', '-nohistory', '-noupdates', '-name', cfg.connection], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // English messages (the output is parsed) and UTF-8 in both directions.
    env: { ...process.env, JAVA_TOOL_OPTIONS: '-Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8' },
  });
  const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: strip(r.stdout),
    stderr: strip(r.stderr).split('\n').filter((l) => !/^\s+at |^Picked up JAVA_TOOL_OPTIONS|SqlCli <init>|HomeMigrationWarning|AccessDeniedException/.test(l)).join('\n').trim(),
    spawnError: r.error ? (r.error.code === 'ENOENT' ? 'SQLcl not found ("' + (cfg.sqlcl || 'sql') + '"); set "sqlcl" in squad-install.config.json to the full path of sql.exe' : String(r.error.message || r.error)) : '',
  };
}

// Output between `prompt ==SQUAD:NAME[:arg]==` markers, in order.
export function sections(stdout) {
  const out = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^==SQUAD:([A-Z]+)(?::(.*))?==$/);
    if (m) {
      cur = { name: m[1], arg: m[2] || '', lines: [] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

export const SETTINGS = ['set define off', 'set sqlblanklines on', 'set echo off', 'set heading off', 'set pagesize 0', 'set linesize 4000', 'set feedback off', 'whenever sqlerror continue', 'whenever oserror continue'];
export const TARGET_SQL = [
  'prompt ==SQUAD:TARGET==',
  "select '#TARGET#' || sys_context('userenv', 'current_schema') || '|' || (select version_no from apex_release) || '|' || (select product || ' ' || version_full from product_component_version where rownum = 1) from dual;",
];
export const workspaceSql = (cfg) => "select '#WS#' || workspace_id from apex_workspaces where workspace = '" + cfg.workspace + "';";

export function parseTarget(cfg, secs) {
  const sec = secs.find((s) => s.name === 'TARGET');
  const line = sec && sec.lines.find((l) => l.startsWith('#TARGET#'));
  if (!line) return null;
  const [schema, apex, ...db] = line.slice('#TARGET#'.length).split('|');
  const ws = sec.lines.find((l) => l.startsWith('#WS#'));
  return {
    connection: cfg.connection, workspace: cfg.workspace, workspaceFound: Boolean(ws),
    schema: schema.trim(), apex: apex.trim(), db: db.join('|').trim(), at: new Date().toISOString(),
  };
}

export function targetText(t) {
  return 'Database target: SQLcl connection ' + t.connection + ' -> schema ' + t.schema + ', ' + t.db + ', APEX ' + t.apex + ', workspace ' + t.workspace +
    (t.workspaceFound ? '' : ' (WARNING: this workspace is not assigned to schema ' + t.schema + ')') + '.';
}

export function connectFailure(run) {
  return clip([run.spawnError, run.stdout, run.stderr].filter(Boolean).join(' | ').replace(/\s+/g, ' '), 500) || 'SQLcl produced no output (exit code ' + run.code + ')';
}

// The SQLcl's own APEXlang compiler, and a warning when it is for another APEX release
// than the database (the extension update moved it from 26.1 to 26.2).
export function compilerText(cfg, t) {
  const build = cfg.sqlcl ? compilerBuild(cfg.sqlcl) : '';
  if (!build) return '';
  return ' SQLcl APEXlang compiler ' + build + (t.apex && majorMinor(build) !== majorMinor(t.apex)
    ? ' -- WARNING: built for APEX ' + majorMinor(build) + ', but the database runs APEX ' + t.apex + '; compile and import may disagree with the database. Point "sqlcl" in squad-install.config.json at a SQLcl whose compiler matches.'
    : '.');
}

export function target(cfg, forceProbe) {
  const cached = readJson(TARGET_FILE);
  if (!forceProbe && cached && cached.connection === cfg.connection && cached.workspace === cfg.workspace) {
    return { ok: true, status: 'target', target: cached, text: targetText(cached) + compilerText(cfg, cached) };
  }
  const run = runSqlcl(cfg, [...SETTINGS, ...TARGET_SQL, workspaceSql(cfg), 'exit'].join('\n') + '\n');
  const t = parseTarget(cfg, sections(run.stdout));
  if (!t) return { ok: null, status: 'unavailable', text: 'Database target: UNAVAILABLE -- could not connect with SQLcl connection ' + cfg.connection + ': ' + connectFailure(run) };
  writeJson(TARGET_FILE, t);
  return { ok: true, status: 'target', target: t, text: targetText(t) + compilerText(cfg, t) };
}

// Errors in one SQL script's output: failed statements ("Error starting at
// line") and PL/SQL compile errors ("Errors for PACKAGE BODY X:").
export function parseSqlErrors(lines) {
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^Error starting at line : (\d+)/);
    if (m) {
      const err = { line: +m[1], command: '', message: '' };
      let part = '';
      for (; i + 1 < lines.length; i++) {
        const l = lines[i + 1];
        if (/^(Error starting at line|Errors for )/.test(l) || (part === 'message' && err.message && !l.trim())) break;
        if (/^In command -/.test(l)) part = 'command';
        else if (/^Error report -/.test(l)) part = 'message';
        else if (/^(Help|https?):/.test(l.trim())) continue;
        else if (part === 'command') err.command += (err.command ? ' ' : '') + l.trim();
        else if (part === 'message') err.message += (err.message ? ' ' : '') + l.trim();
      }
      errors.push(err);
      continue;
    }
    m = line.match(/^ERROR at line (\d+):/);
    if (m) {
      const err = { line: +m[1], command: '', message: '' };
      for (i++; i < lines.length && lines[i].trim(); i++) {
        if (!/^(Help|https?):/.test(lines[i].trim())) err.message += (err.message ? ' ' : '') + lines[i].trim();
      }
      errors.push(err);
      continue;
    }
    m = line.match(/^Errors for (.+):$/);
    if (m) {
      let seen = false;
      for (i++; i < lines.length; i++) {
        const row = lines[i].match(/^(\d+)\/(\d+)\s+(.*)$/);
        if (row) {
          seen = true;
          errors.push({ unit: m[1], line: +row[1], command: '', message: row[3].trim() });
        } else if (seen && !lines[i].trim()) break;
        else if (seen) errors[errors.length - 1].message += ' ' + lines[i].trim();
      }
    }
  }
  if (!errors.length) {
    const raw = lines.find((l) => /\b(ORA|PLS|SP2)-\d{4,5}\b/.test(l));
    if (raw) errors.push({ line: null, command: '', message: raw.trim() });
  }
  // "Statement ignored" only repeats the real compile error on the same line.
  return errors.filter((e) => !/^PL\/SQL: (Statement|SQL Statement) ignored$/.test(e.message) || errors.filter((x) => x.unit === e.unit && x.line === e.line).length === 1);
}

// Output of apex validate / apex import: sections "APEXlang Compile Errors:",
// "APEXlang Compile Warnings:" and "APEXlang Import Errors:", each a list of
// "File: / Line: / Column: / Type: / Error:|Warning:" blocks. Warnings do not
// stop an import; import errors are raised by the database after a clean compile.
export function parseCompilerOutput(lines) {
  const out = { errors: [], warnings: [], importErrors: [] };
  let bucket = out.errors;
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^APEXlang (Compile Errors|Compile Warnings|Import Errors):/);
    if (head) {
      bucket = head[1] === 'Compile Warnings' ? out.warnings : head[1] === 'Import Errors' ? out.importErrors : out.errors;
      cur = null;
      continue;
    }
    const m = line.match(/^(File|Line|Column|Type|Error|Warning): ?(.*)$/);
    if (m && m[1] === 'File') {
      cur = { file: m[2].trim().replace(/\\/g, '/'), line: null, column: null, type: '', message: '' };
      bucket.push(cur);
    } else if (m && cur) {
      if (m[1] === 'Line') cur.line = +m[2];
      else if (m[1] === 'Column') cur.column = +m[2];
      else if (m[1] === 'Type') cur.type = m[2].trim();
      else cur.message = m[2].trim();
    } else if (cur && cur.message && line.trim()) {
      // continuation, e.g. "Valid values are :" followed by one value per line ("-" prefixed)
      const part = line.trim().replace(/^-/, '');
      cur.message += /:\s*$/.test(cur.message) || /:\s*$/.test(line) ? ' ' + part : ', ' + part;
    } else if (!line.trim()) {
      cur = null;
    }
  }
  for (const e of [...out.errors, ...out.warnings, ...out.importErrors]) e.message = e.message.replace(/\s+/g, ' ').replace(/ :/g, ':').trim();
  return out;
}

// Same message on many lines -> one line with a count and a few places.
export function groupByMessage(items, maxGroups, maxPlaces) {
  const groups = new Map();
  for (const e of items) {
    const key = e.type + ' ' + e.message;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.file + ':' + e.line);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines = rows.slice(0, maxGroups).map(([key, places]) =>
    '  ' + places.length + 'x ' + clip(key, 420) + '  -- ' + places.slice(0, maxPlaces).join(', ') + (places.length > maxPlaces ? ', ...' : ''));
  if (rows.length > maxGroups) lines.push('  ... and ' + (rows.length - maxGroups) + ' more kinds.');
  return lines;
}

// Copy an app to a staging folder the compiler can read: LF line endings (the live
// APEXlang compiler rejects CRLF) and deployments/default.json pointing at the
// configured workspace and, when known, the pinned application id.
export function stageApp(appDir, stage, cfg, pinned) {
  fs.cpSync(appDir, stage, { recursive: true });
  for (const rel of walk(stage).filter((f) => /\.apx$/i.test(f))) {
    const file = path.join(stage, rel);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\r')) fs.writeFileSync(file, text.replace(/\r\n?/g, '\n'), 'utf8');
  }
  // The deployment target is decided here, not by whatever the agents wrote.
  const deployFile = path.join(stage, 'deployments', 'default.json');
  const deployment = readJson(deployFile) || {};
  deployment.workspace = { name: cfg.workspace };
  deployment.app = deployment.app && typeof deployment.app === 'object' ? deployment.app : {};
  if (pinned) deployment.app.id = pinned;
  else delete deployment.app.id;
  writeJson(deployFile, deployment);
}
