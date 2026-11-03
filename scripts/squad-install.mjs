// Installs one "APEXlang Dev Squad v2" session into the database with SQLcl:
// runs the SQL scripts under <app>/supporting-objects/ (tables, views,
// packages, seed data), then live-validates and imports the APEXlang app
// (`apex validate` + `apex import`, same SQLcl session). Called by the
// Install_App agent tool and after every Engineer attempt; also usable by hand.
//
// Usage:
//   node scripts/squad-install.mjs --session <id> [--force] [--json]
//   node scripts/squad-install.mjs --target [--json]   # connection, schema, versions (cached)
//   node scripts/squad-install.mjs --probe  [--json]   # same, always asks the database
//
// The target (SQLcl saved connection + APEX workspace) comes from
// squad-install.config.json, or for a session started on the APEX Squad web
// page from workspace/.squad-sessions/<session>.json (validated when it was
// saved; the same file sets the session's working folder) -- agents cannot
// choose it. The SQLcl program itself always comes from the config. The APEX
// application id each session installed is remembered in
// workspace/.squad-install/<session>.json (outside every session folder, so
// agents cannot edit it) and reused with `apex import -id`, because an import
// without an id creates a NEW application every time.
//
// --json prints { ok, status, text, ... }: ok true = installed, false = the
// app's SQL or APEXlang has errors (fix the files), null = install could not
// run (not configured, SQLcl/database unavailable, blocked by the id guard).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  WS_ROOT, SESSIONS_DIR, REGISTRY_DIR, TARGET_FILE, TMP_ROOT, readJson, writeJson, clip, posix, loadConfig, findAppRoot, walk,
  runSqlcl, sections, SETTINGS, TARGET_SQL, workspaceSql, parseTarget, connectFailure, target, parseSqlErrors, parseCompilerOutput,
  groupByMessage, stageApp,
} from './lib/sqlcl.mjs';

const MAX_LISTED = 40;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
};

function finish(result) {
  if (sqlclNote) result = { ...result, text: result.text + '\n' + sqlclNote };
  if (flag('--json')) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stdout.write(result.text + '\n');
  process.exit(result.ok === false ? 1 : 0);
}

let sqlclNote = '';

// Same sanitising as the Squad Code nodes and FS_Workspace_Tool.
const session = option('--session').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
// Settings saved for this session by the APEX Squad web page, or null.
const sessionSettings = session ? readJson(path.join(SESSIONS_DIR, session + '.json')) : null;

function hashApp(appDir, cfg) {
  const h = crypto.createHash('sha1').update(cfg.connection + '\0' + cfg.workspace + '\0');
  for (const rel of walk(appDir)) h.update(rel + '\0').update(fs.readFileSync(path.join(appDir, rel))).update('\0');
  return h.digest('hex');
}

// Install scripts: every .sql under supporting-objects/, in name order
// (01-tables.sql before 02-views.sql). Deinstall scripts are never run.
function installScripts(appDir) {
  const dir = path.join(appDir, 'supporting-objects');
  if (!fs.existsSync(dir)) return [];
  return walk(dir)
    .filter((rel) => /\.sql$/i.test(rel) && !/^(de|un)install/i.test(path.posix.basename(rel)))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((rel) => 'supporting-objects/' + rel);
}

function install(cfg, sessionDir, force) {
  const session = path.basename(sessionDir);
  const where = 'Database install on SQLcl connection ' + cfg.connection + ' (APEX workspace ' + cfg.workspace + ')';
  const appRoot = findAppRoot(sessionDir);
  if (appRoot === null) return { ok: false, status: 'failed', text: where + ': FAILED -- no application.apx found in the workspace.' };
  const appDir = path.join(sessionDir, appRoot);
  const appLabel = (posix(appRoot) || '.') + '/';
  const regFile = path.join(REGISTRY_DIR, session + '.json');
  const reg = readJson(regFile) || {};
  // An id is only reused on the connection + workspace it was created in.
  const pinned = reg.appId && reg.connection === cfg.connection && reg.workspace === cfg.workspace ? reg.appId : null;

  const sourceHash = hashApp(appDir, cfg);
  if (!force && pinned && reg.lastOk && reg.lastOk.hash === sourceHash) {
    return {
      ok: true, status: 'unchanged', appId: pinned, alias: reg.alias, appName: reg.appName,
      text: where + ': UP TO DATE -- APEX application ' + pinned + ' "' + reg.appName + '" (alias ' + reg.alias + ') was installed at ' + reg.lastOk.at +
        ' and no file under ' + appLabel + ' has changed since.',
    };
  }

  const scripts = installScripts(appDir);
  for (const rel of scripts) {
    // EXIT/QUIT would end the SQLcl session before the app is imported.
    const bad = fs.readFileSync(path.join(appDir, rel), 'utf8').split(/\r?\n/).findIndex((l) => /^\s*(exit|quit)\s*;?\s*$/i.test(l));
    if (bad >= 0) {
      return { ok: false, status: 'failed', text: where + ': FAILED -- ' + appLabel + rel + ' line ' + (bad + 1) + ' is an EXIT/QUIT command. Remove it: install scripts run inside one SQLcl session together with the app import.' };
    }
  }

  const stage = path.join(TMP_ROOT, 'install-' + session + '-' + Date.now().toString(36));
  try {
    stageApp(appDir, stage, cfg, pinned);

    const L = [...SETTINGS, 'set encoding UTF-8', ...TARGET_SQL, workspaceSql(cfg), 'prompt ==SQUAD:GUARD=='];
    if (pinned && /^[A-Za-z0-9_.$#-]+$/.test(reg.alias || '')) {
      // Refuse to overwrite application <pinned> if it is no longer the one this session installed.
      L.push('whenever sqlerror exit 3', 'declare', '  l_alias varchar2(255);', 'begin',
        "  select alias into l_alias from apex_applications where application_id = " + pinned + " and workspace = '" + cfg.workspace + "';",
        "  if upper(l_alias) <> upper('" + reg.alias + "') then",
        "    raise_application_error(-20001, 'SQUAD_GUARD application " + pinned + " now has alias ' || l_alias);",
        '  end if;', 'exception', '  when no_data_found then null;', 'end;', '/', 'whenever sqlerror continue');
    }
    for (const rel of scripts) {
      // Settings are re-applied after each script because a script may change them.
      L.push('prompt ==SQUAD:SCRIPT:' + rel + '==', 'set feedback on', '@"' + path.join(stage, rel) + '"', ...SETTINGS);
    }
    L.push('prompt ==SQUAD:VALIDATE==', 'apex validate -input "' + stage + '"');
    L.push('prompt ==SQUAD:IMPORT==', 'apex import -input "' + stage + '"' + (pinned ? ' -id ' + pinned : ''));
    L.push('prompt ==SQUAD:APPS==',
      "select '#APP#' || application_id || '|' || alias || '|' || pages || '|' || application_name from apex_applications where workspace = '" + cfg.workspace + "' order by application_id;",
      'prompt ==SQUAD:END==', 'exit');

    const run = runSqlcl(cfg, L.join('\n') + '\n');
    const logRel = '.apexlang/history/install-last.log';
    fs.mkdirSync(path.join(sessionDir, '.apexlang', 'history'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, logRel), ['# ' + new Date().toISOString() + ' exit code ' + run.code, run.stdout, run.stderr && '--- stderr ---\n' + run.stderr].filter(Boolean).join('\n').split(stage).join('<app>') + '\n', 'utf8');

    const secs = sections(run.stdout);
    const sec = (name) => secs.find((s) => s.name === name);
    const t = parseTarget(cfg, secs);
    if (!t) return { ok: null, status: 'unavailable', text: where + ': UNAVAILABLE -- could not connect: ' + connectFailure(run) };
    writeJson(TARGET_FILE, t);
    if (!t.workspaceFound) {
      return { ok: null, status: 'unavailable', text: where + ': UNAVAILABLE -- APEX workspace ' + cfg.workspace + ' is not assigned to schema ' + t.schema + '. Fix APEX_WORKSPACE in .env.' };
    }
    if (/SQUAD_GUARD/.test(run.stdout)) {
      return {
        ok: null, status: 'blocked',
        text: where + ': BLOCKED -- APEX application ' + pinned + ' is no longer the app this session installed (' + clip((run.stdout.match(/SQUAD_GUARD ([^\n]*)/) || [])[1], 120) + ', expected ' + reg.alias +
          '). Nothing was changed. To install as a new application, delete workspace/.squad-install/' + session + '.json.',
      };
    }
    if (!sec('END')) {
      return { ok: null, status: 'unavailable', text: where + ': UNAVAILABLE -- the SQLcl session ended early (exit code ' + run.code + '): ' + clip((run.spawnError + ' ' + run.stdout.split('\n').filter((l) => l.trim()).slice(-6).join(' | ') + ' ' + run.stderr).replace(/\s+/g, ' '), 600) + ' (full log: ' + logRel + ')' };
    }

    const scriptResults = secs.filter((s) => s.name === 'SCRIPT').map((s) => ({ file: s.arg, errors: parseSqlErrors(s.lines) }));
    const sqlErrorCount = scriptResults.reduce((n, s) => n + s.errors.length, 0);
    const valLines = sec('VALIDATE').lines;
    const impLines = sec('IMPORT').lines;
    const validated = valLines.some((l) => /^Validation successful/.test(l));
    const imported = impLines.some((l) => /^Import successful/.test(l));
    const val = parseCompilerOutput(valLines);
    const imp = parseCompilerOutput(impLines);
    // apex import compiles again, so its compile errors and warnings only repeat the validate step.
    const compileErrors = validated ? imp.errors : val.errors;
    const importErrors = imp.importErrors;
    const warnings = validated ? val.warnings : [];
    const idLine = impLines.join('\n').match(/Importing application ID: (\d+) into workspace: (\S+)/);
    const appId = imported && idLine ? +idLine[1] : null;

    let app = null;
    for (const l of sec('APPS').lines) {
      if (!l.startsWith('#APP#')) continue;
      const [id, alias, pages, ...name] = l.slice('#APP#'.length).split('|');
      if (+id === appId) app = { alias: alias.trim(), pages: +pages, name: name.join('|').trim() };
    }

    if (imported && appId) {
      // Link the source to its installed twin, then remember what was installed.
      const srcDeployFile = path.join(appDir, 'deployments', 'default.json');
      const src = readJson(srcDeployFile) || {};
      src.workspace = { name: cfg.workspace };
      src.app = { ...(src.app && typeof src.app === 'object' ? src.app : {}), id: appId };
      writeJson(srcDeployFile, src);
      if (!pinned) {
        // APEX just handed out this id, so any other session still pinning it is stale.
        for (const f of fs.existsSync(REGISTRY_DIR) ? fs.readdirSync(REGISTRY_DIR) : []) {
          const other = f !== session + '.json' && !f.startsWith('_') && readJson(path.join(REGISTRY_DIR, f));
          if (other && other.appId === appId && other.connection === cfg.connection) writeJson(path.join(REGISTRY_DIR, f), { ...other, appId: null, lastOk: null });
        }
      }
      const at = new Date().toISOString();
      writeJson(regFile, {
        session, connection: cfg.connection, workspace: cfg.workspace, schema: t.schema,
        appId, alias: app ? app.alias : reg.alias || '', appName: app ? app.name : reg.appName || '',
        firstInstalledAt: pinned ? reg.firstInstalledAt || at : at,
        // Only a completely clean install may be skipped next time.
        lastOk: sqlErrorCount ? null : { at, hash: hashApp(appDir, cfg) },
      });
    }

    const ok = imported && sqlErrorCount === 0;
    const appText = appId ? 'APEX application ' + appId + (app ? ' "' + app.name + '" (alias ' + app.alias + ', ' + app.pages + ' pages)' : '') : '';
    const out = [];
    if (ok) {
      out.push(where + ': INSTALLED -- ' + appText + (pinned ? ' updated in place' : ' created') + '; ' +
        (scripts.length ? scripts.length + ' SQL script(s) ran without errors in schema ' + t.schema : 'no SQL scripts under ' + appLabel + 'supporting-objects/') + '.');
    } else {
      const parts = [];
      if (sqlErrorCount) parts.push(sqlErrorCount + ' SQL script error(s)');
      if (!imported) {
        parts.push(compileErrors.length ? compileErrors.length + ' APEXlang compile error(s)'
          : importErrors.length ? 'the app compiled, but the database rejected the import (' + importErrors.length + ' import error(s))' : 'the app import failed');
      }
      out.push(where + ': FAILED -- ' + parts.join(', ') + '. ' +
        (imported ? appText + ' was imported, but its database objects are incomplete.' : 'The APEX app was NOT imported' + (pinned ? ' (application ' + pinned + ' still has the previous version).' : '.')) +
        ' File paths are relative to ' + appLabel);
    }
    let shown = 0;
    if (sqlErrorCount) {
      out.push('SQL script errors (schema ' + t.schema + ', ' + t.db + '):');
      for (const s of scriptResults.filter((x) => x.errors.length)) {
        out.push(s.file);
        for (const e of s.errors) {
          if (shown++ >= MAX_LISTED) break;
          out.push('  ' + (e.unit ? e.unit + ' ' : '') + (e.line ? 'line ' + e.line + ': ' : '') + clip(e.message, 300) + (e.command ? '  [statement: ' + clip(e.command, 100) + ']' : ''));
        }
      }
      if (sqlErrorCount > shown) out.push('... and ' + (sqlErrorCount - shown) + ' more.');
    }
    if (!imported) {
      if (compileErrors.length) {
        out.push('APEXlang compile errors (live APEX ' + t.apex + ' compiler):');
        const byFile = {};
        for (const e of compileErrors) (byFile[e.file] = byFile[e.file] || []).push(e);
        shown = 0;
        for (const [file, list] of Object.entries(byFile)) {
          if (shown >= MAX_LISTED) break;
          out.push(file);
          for (const e of list) {
            if (shown++ >= MAX_LISTED) break;
            out.push('  line ' + e.line + ': ' + e.type + ' ' + clip(e.message, /Valid /.test(e.message) ? 900 : 300));
          }
        }
        if (compileErrors.length > shown) out.push('... and ' + (compileErrors.length - shown) + ' more.');
      } else if (importErrors.length) {
        out.push('Import errors (raised by the database after a clean compile; the import stops at the first one, so more may follow):');
        for (const e of importErrors.slice(0, MAX_LISTED)) out.push('  ' + e.file + ' line ' + e.line + ': ' + e.type + ' ' + clip(e.message, 300));
        if (importErrors.some((e) => /ORA-40441|ORA-40587|ORA-40597|JSON/i.test(e.message))) {
          out.push('How to read this: a JSON error at import means a property value near that line has the wrong SHAPE (a plain value where an object is expected, or the reverse). ' +
            'The compiler does not check this. Most often it is a link: links are objects, written as "target: {" on one line, then e.g. "page: 11" on the next, then "}" -- never "target: 11" and never "target {". ' +
            'homeUrl and loginUrl in application.apx are links too. If the error names application.apx line 1, the whole file is suspect: compare it with Oracle\'s original in .apexlang/scaffold/application.apx.');
        }
      } else {
        out.push('SQLcl output: ' + clip(valLines.concat(impLines).filter((l) => l.trim()).join(' | '), 800));
      }
    }
    if (warnings.length) {
      out.push((ok ? 'Compiler warnings' : 'Also ' + warnings.length + ' compiler warning(s)') + ' (not blocking' + (ok ? ', ' + warnings.length : '') + '; fix the "Invalid ..." and "ignored" ones when you touch those files):');
      out.push(...groupByMessage(warnings, 10, 4));
    }
    if (!ok) out.push('(full SQLcl log: ' + logRel + ')');
    return {
      ok, status: ok ? 'installed' : 'failed', appId, alias: app ? app.alias : null, appName: app ? app.name : null,
      imported, sqlErrorCount, compileErrorCount: compileErrors.length, importErrorCount: importErrors.length, warningCount: warnings.length,
      scripts: scriptResults.map((s) => ({ file: s.file, errors: s.errors.length })),
      text: out.join('\n'),
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const cfg = loadConfig(sessionSettings);
sqlclNote = cfg.note || '';
if (cfg.problem) finish({ ok: null, status: 'disabled', text: 'Database install: ' + cfg.problem });
if (flag('--target') || flag('--probe')) finish(target(cfg, flag('--probe')));

if (!session) finish({ ok: null, status: 'usage', text: 'Usage: node scripts/squad-install.mjs --session <id> [--force] [--json] | [--session <id>] --target | --probe' });
// The session's working folder: chosen on the APEX Squad page, else the config default.
const workingFolder = (sessionSettings && sessionSettings.workingFolder) || cfg.workingFolder || WS_ROOT;
const sessionDir = path.join(workingFolder, session);
if (!fs.existsSync(sessionDir)) finish({ ok: false, status: 'failed', text: 'Database install: FAILED -- ' + sessionDir + ' does not exist.' });
try {
  finish(install(cfg, sessionDir, flag('--force')));
} catch (err) {
  finish({ ok: null, status: 'unavailable', text: 'Database install: UNAVAILABLE -- installer error: ' + clip(err && err.stack ? err.stack : String(err), 600) });
}
