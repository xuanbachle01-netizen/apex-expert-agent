// ---- Squad shared-state helpers (identical block in every Squad Code node) ----
// Shared memory = workspace/<session>/.apexlang/state.json (source of truth,
// written ONLY by these Code nodes) rendered to state.md (bounded, what agents
// see). Full agent outputs are archived under .apexlang/history/ instead of
// being appended to one ever-growing file.
// Requires NODE_FUNCTION_ALLOW_BUILTIN=fs,path,child_process on the n8n process.
const fsMod = require('fs');
const pathMod = require('path');
const cpMod = require('child_process');
// The @@ tokens are environment values, filled in by the build scripts (scripts/lib/env.mjs).
const PROJECT_ROOT = '@@PROJECT_ROOT@@';
const USER_HOME = '@@USER_HOME@@';
const NODE_EXE = '@@NODE_EXE@@';
const WS_ROOT = PROJECT_ROOT + '\\workspace';
const MAX_ATTEMPTS = 3;
// Oracle's APEXlang tooling (vendored apexlang-skill package).
const SKILL_ROOT = PROJECT_ROOT + '\\apexlang-skill';
const TMP_ROOT = SKILL_ROOT + '\\.tmp-validate'; // apexctl only writes inside the project
const SCAFFOLD_DIR = 'app';

// ---- Session settings ----
// Each chat session runs with the settings chosen on the APEX Squad web page (working
// folder, database, attempts, models), saved by the Orchestrator's Load Session State in
// workspace/.squad-sessions/<session>.json. Missing values come from squad-install.config.json;
// chats started elsewhere (the n8n editor) use those defaults.
const SESSIONS_DIR = PROJECT_ROOT + '\\workspace\\.squad-sessions';
const DEFAULT_MODELS = { orchestrator: 'Claude Opus 5.5', skill: 'Claude Sonnet 5', engineer: 'Claude Sonnet 5.5', reviewer: 'Claude Opus 5' };
let CURRENT_SESSION = '';
function sessionKey(sessionId) {
  // Same sanitising as FS_Workspace_Tool and squad-install.mjs, so all address the same folder.
  const s = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  if (!s) throw new Error('missing session id');
  return s;
}
// Paths in squad-install.config.json may start with ~ (the user's home folder) or be
// relative to the project; a bare "sqlcl" name ("sql") is left for the PATH. Same as
// configPaths() in scripts/lib/sqlcl.mjs.
function configPath(p) {
  p = String(p);
  return /^~(?=$|[\\/])/.test(p) ? pathMod.join(USER_HOME, p.slice(1)) : pathMod.resolve(PROJECT_ROOT, p);
}
// A setting from the project's .env ('' if not there); n8n's Code nodes cannot read process.env.
function envValue(name) {
  let text = '';
  try { text = fsMod.readFileSync(PROJECT_ROOT + '\\.env', 'utf8'); } catch (e) { return ''; }
  const m = text.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*?)\\s*$', 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}
// The database target: APEX_CONNECTION / APEX_WORKSPACE in .env over the config file. Same as
// loadConfig() in scripts/lib/sqlcl.mjs.
function squadConfig() {
  let cfg;
  try { cfg = JSON.parse(fsMod.readFileSync(PROJECT_ROOT + '\\squad-install.config.json', 'utf8')) || {}; } catch (e) { return {}; }
  if (envValue('APEX_CONNECTION')) cfg.connection = envValue('APEX_CONNECTION');
  if (envValue('APEX_WORKSPACE')) cfg.workspace = envValue('APEX_WORKSPACE');
  if (cfg.sqlcl && /^~|[\\/]/.test(cfg.sqlcl)) cfg.sqlcl = configPath(cfg.sqlcl);
  if (cfg.workingFolder) cfg.workingFolder = configPath(cfg.workingFolder);
  if (Array.isArray(cfg.allowedFolders)) cfg.allowedFolders = cfg.allowedFolders.map(configPath);
  return cfg;
}
function savedSettings(key) {
  key = key || CURRENT_SESSION;
  if (!key) return null;
  try { return JSON.parse(fsMod.readFileSync(pathMod.join(SESSIONS_DIR, key + '.json'), 'utf8')); } catch (e) { return null; }
}
// The settings a session runs with: its saved choices over the config defaults.
function settingsFor(key) {
  const cfg = squadConfig();
  const s = savedSettings(key) || {};
  const db = s.database || {};
  const enabled = db.enabled !== undefined ? db.enabled : cfg.enabled !== false;
  return {
    workingFolder: s.workingFolder || cfg.workingFolder || WS_ROOT,
    maxAttempts: s.maxAttempts || cfg.maxAttempts || MAX_ATTEMPTS,
    models: { ...DEFAULT_MODELS, ...(cfg.models || {}), ...(s.models || {}) },
    database: {
      enabled,
      connection: enabled ? db.connection || cfg.connection || '' : '',
      workspace: enabled ? db.workspace || cfg.workspace || '' : '',
    },
  };
}
function sessionDir(sessionId) {
  CURRENT_SESSION = sessionKey(sessionId);
  return pathMod.join(settingsFor().workingFolder, CURRENT_SESSION);
}
// Checks the settings sent from the web page: { settings } to save, or { errors }.
function validateSettings(raw) {
  raw = raw || {};
  const cfg = squadConfig();
  const errors = [];
  const given = String(raw.workingFolder || '').trim();
  const folder = given ? pathMod.resolve(given) : '';
  const roots = (Array.isArray(cfg.allowedFolders) && cfg.allowedFolders.length ? cfg.allowedFolders : [WS_ROOT]).map((r) => pathMod.resolve(r));
  const inside = (f) => roots.some((r) => f.toLowerCase() === r.toLowerCase() || f.toLowerCase().startsWith(r.toLowerCase() + pathMod.sep));
  if (!/^[A-Za-z]:\\/.test(folder)) errors.push('Working folder: give a full path such as C:\\Users\\you\\apex-apps.');
  else if (!inside(folder)) errors.push('Working folder: must be inside ' + roots.join(' or ') + ' ("allowedFolders" in squad-install.config.json).');
  else if (!fsMod.existsSync(folder) || !fsMod.statSync(folder).isDirectory()) errors.push('Working folder: ' + folder + ' does not exist.');
  const db = raw.database || {};
  const enabled = db.enabled !== false;
  if (enabled) {
    if (!/^[A-Za-z0-9_$#.-]{1,128}$/.test(db.connection || '')) errors.push('Database connection: the name of a saved SQLcl connection (letters, digits, _ $ # . -).');
    if (!/^[A-Za-z0-9_$#-]{1,255}$/.test(db.workspace || '')) errors.push('APEX workspace: letters, digits and _ $ # - only.');
    if (/prod/i.test(db.connection || '') && cfg.allowProduction !== true) errors.push('Database connection: "' + db.connection + '" looks like production. The squad only installs there with "allowProduction": true in squad-install.config.json.');
  }
  const attempts = Number(raw.maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) errors.push('Engineer attempts: a whole number from 1 to 5.');
  const models = {};
  for (const k of Object.keys(DEFAULT_MODELS)) {
    const m = String((raw.models || {})[k] || '').trim();
    if (!/^[\w .:\/-]{1,80}$/.test(m)) errors.push('Model for the ' + k + ': required (letters, digits, spaces, . : / -).');
    models[k] = m;
  }
  if (errors.length) return { errors };
  return { settings: {
    workingFolder: folder,
    database: { enabled, connection: enabled ? db.connection : '', workspace: enabled ? db.workspace : '' },
    maxAttempts: attempts,
    models,
    savedAt: new Date().toISOString(),
  } };
}
// One line for prompts and the web page: where this session works and installs.
function settingsText(key) {
  const s = settingsFor(key);
  return 'Working folder: ' + s.workingFolder + ' | Database: ' +
    (s.database.enabled ? 'SQLcl connection ' + s.database.connection + ', APEX workspace ' + s.database.workspace : 'none (offline validation only)') +
    ' | Engineer attempts: ' + s.maxAttempts + ' | Models: ' + Object.entries(s.models).map(([k, v]) => k + ' ' + v).join(', ');
}
// ---- end session settings ----
function metaPath(dir, rel) { return pathMod.join(dir, '.apexlang', ...rel.split('/')); }
function readText(file) { return fsMod.existsSync(file) ? fsMod.readFileSync(file, 'utf8') : null; }
function writeText(file, text) {
  fsMod.mkdirSync(pathMod.dirname(file), { recursive: true });
  fsMod.writeFileSync(file, text, 'utf8');
}
function loadState(dir) {
  const raw = readText(metaPath(dir, 'state.json'));
  return raw ? JSON.parse(raw) : null;
}
function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n) + '\n...[clipped; full text in the history file]' : s;
}
function pad(n) { return String(n).padStart(2, '0'); }
function headline(s) {
  return (String(s || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '').slice(0, 160);
}
function goalOf(brief) {
  const m = String(brief || '').match(/##\s*Goal\s*\n+([^\n]+)/i);
  return (m ? m[1] : headline(brief)).trim().slice(0, 160);
}
function verdictOf(review) {
  const last = (String(review || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '').toUpperCase();
  if (last.startsWith('APPROVED')) return 'APPROVED';
  if (last.startsWith('NEEDS REVISION')) return 'NEEDS REVISION';
  return 'NO VERDICT';
}
function archive(dir, st, name, text) {
  const rel = 'history/brief-' + pad(st.briefNo) + '/' + name;
  writeText(metaPath(dir, rel), String(text || ''));
  return '.apexlang/' + rel;
}
function listFiles(dir, d) {
  d = d || dir;
  const out = [];
  if (!fsMod.existsSync(d)) return out;
  for (const e of fsMod.readdirSync(d, { withFileTypes: true })) {
    const full = pathMod.join(d, e.name);
    const rel = pathMod.relative(dir, full).split(pathMod.sep).join('/');
    if (e.isDirectory()) { if (rel !== '.apexlang/history' && rel !== '.apexlang/scaffold') out.push(...listFiles(dir, full)); }
    else out.push({ path: rel, bytes: fsMod.statSync(full).size });
  }
  return out;
}
function fileListText(dir) {
  const files = listFiles(dir);
  return files.length ? files.map((f) => '- ' + f.path + ' (' + f.bytes + ' bytes)').join('\n') : '(workspace is empty)';
}
const STATUS_LABEL = {
  grounding: 'GROUNDING', ready: 'READY FOR ENGINEER', engineering: 'ENGINEER WORKING',
  awaiting_review: 'AWAITING REVIEW', reviewing: 'REVIEWER WORKING', needs_revision: 'NEEDS REVISION',
  approved: 'APPROVED', limit_reached: 'ATTEMPT LIMIT REACHED (not approved)',
};
function renderState(st) {
  const L = [];
  L.push('# Shared task state');
  L.push('_Maintained automatically after every delegation. No agent edits this file or state.json._');
  L.push('');
  L.push('Brief #' + st.briefNo + ' | Status: ' + (STATUS_LABEL[st.status] || st.status) +
    ' | Engineer attempts used: ' + st.attempt + ' of ' + st.maxAttempts + ' | Updated: ' + st.updatedAt);
  L.push('');
  L.push('## Current brief');
  L.push(String(st.brief || '').trim());
  L.push('');
  if (st.lastReview) {
    L.push('## Latest review (attempt ' + st.lastReview.attempt + ') -- ' + st.lastReview.verdict);
    L.push(clip(st.lastReview.review, 8000));
    L.push('(full text: ' + st.lastReview.file + ')');
  } else {
    L.push('## Latest review');
    L.push('(none yet for this brief)');
  }
  L.push('');
  if (st.lastEngineer) {
    L.push('## Latest engineer report (attempt ' + st.lastEngineer.attempt + ')');
    L.push(clip(st.lastEngineer.report, 4000));
    L.push('(full text: ' + st.lastEngineer.file + ')');
  } else {
    L.push('## Latest engineer report');
    L.push('(none yet for this brief)');
  }
  L.push('');
  if (st.lastValidation) {
    L.push('## Latest Oracle validation (after attempt ' + st.lastValidation.attempt + ')');
    L.push(clip(st.lastValidation.text, 5000));
    L.push('');
  }
  if (st.lastInstall) {
    L.push('## Latest database install (after attempt ' + st.lastInstall.attempt + ')');
    L.push(clip(st.lastInstall.text, 4000));
    L.push('');
  }
  L.push('## Attempt log (this brief)');
  if (!st.attempts.length) L.push('(no attempts yet)');
  for (const a of st.attempts) {
    L.push('- Attempt ' + a.attempt + ': ' + (a.verdict || 'not reviewed yet') +
      (a.validation ? ' | validator: ' + a.validation : '') +
      (a.install ? ' | install: ' + a.install : '') +
      (a.reviewHeadline ? ' -- ' + a.reviewHeadline : '') +
      ' [engineer: ' + (a.engineerFile || '-') + '; review: ' + (a.reviewFile || '-') + ']');
  }
  if (st.pastBriefs.length) {
    L.push('');
    L.push('## Earlier briefs in this session');
    for (const b of st.pastBriefs) L.push('- #' + b.briefNo + ' (' + b.at + '): ' + b.goal + ' -> ' + b.outcome);
  }
  return L.join('\n') + '\n';
}
// ---- Oracle apexctl helpers ----
function runApexTool(args, timeoutMs) {
  const r = cpMod.spawnSync(NODE_EXE, args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: timeoutMs || 180000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.error) return { code: 1, stdout: '', out: String(r.error.message || r.error) };
  return { code: typeof r.status === 'number' ? r.status : 1, stdout: String(r.stdout || ''), out: String(r.stdout || '') + String(r.stderr || '') };
}
function tmpDir(prefix) {
  return pathMod.join(TMP_ROOT, prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}
// Workspace-relative folder holding application.apx ('' = workspace root), or null.
function findAppRoot(dir) {
  let level = [''];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next = [];
    for (const rel of level) {
      const abs = pathMod.join(dir, rel);
      if (fsMod.existsSync(pathMod.join(abs, 'application.apx'))) return rel.split(pathMod.sep).join('/');
      if (!fsMod.existsSync(abs)) continue;
      for (const e of fsMod.readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && !['.apexlang', 'node_modules', '.git'].includes(e.name)) next.push(pathMod.join(rel, e.name));
      }
    }
    level = next;
  }
  return null;
}
// Compiler metadata of the SQLcl that installs, so Valid_Props and the offline validator
// use the same compiler build as Install_App. [] = Oracle's default discovery (newest
// VS Code extension), which had drifted to a different build than the database.
function compilerHomeArgs() {
  const cfg = installConfig();
  const m = cfg && String(cfg.sqlcl || '').match(/^(.*)[\\/]bin[\\/]sql(\.exe)?$/i);
  return m && fsMod.existsSync(m[1]) ? ['--compiler-oracle-home', m[1]] : [];
}
// Pristine copy of Oracle's scaffold in .apexlang/scaffold/: shown to the Engineer as the
// syntax reference and used to restore baseline files that must not change.
function ensureScaffoldReference(dir) {
  const ref = metaPath(dir, 'scaffold');
  if (fsMod.existsSync(pathMod.join(ref, 'application.apx'))) return { ref };
  const tmp = tmpDir('scaffold');
  try {
    const r = runApexTool([SKILL_ROOT + '\\tools\\apexctl.mjs', 'new-app', 'materialize', '--app-path', tmp, '--workspace-name', (installConfig() || {}).workspace || 'CHANGE_ME_WORKSPACE']);
    if (!fsMod.existsSync(pathMod.join(tmp, 'application.apx'))) return { ref: null, error: clip(r.out, 600) };
    fsMod.cpSync(tmp, ref, { recursive: true });
    return { ref };
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
}
// Generate the whole-app baseline with Oracle's own scaffolder (valid, compiler-checked
// APEXlang: application.apx, theme, Page 0, login Page 9999, shared components,
// supporting objects) unless the workspace already has an app.
function ensureScaffold(dir) {
  const existing = findAppRoot(dir);
  if (existing !== null) return { created: false, appRoot: existing };
  const made = ensureScaffoldReference(dir);
  if (!made.ref) return { created: false, appRoot: null, error: made.error };
  fsMod.cpSync(made.ref, pathMod.join(dir, SCAFFOLD_DIR), { recursive: true });
  return { created: true, appRoot: SCAFFOLD_DIR };
}
// Baseline files no brief needs to change: the Universal Theme subscription, the compiler
// version marker and the app icons. Agents have overwritten them with invented content
// (their own page templates), so Oracle's version is put back. Returns the restored paths.
const PROTECTED_BASELINE = ['shared-components/themes/', '.apex/', 'shared-components/static-files/'];
function restoreProtected(dir) {
  const appRoot = findAppRoot(dir);
  const ref = ensureScaffoldReference(dir).ref;
  if (appRoot === null || !ref) return [];
  const restored = [];
  for (const f of listFiles(ref)) {
    if (!PROTECTED_BASELINE.some((p) => f.path.startsWith(p))) continue;
    const src = pathMod.join(ref, ...f.path.split('/'));
    const dst = pathMod.join(dir, appRoot, ...f.path.split('/'));
    if (fsMod.existsSync(dst) && fsMod.readFileSync(src).equals(fsMod.readFileSync(dst))) continue;
    fsMod.mkdirSync(pathMod.dirname(dst), { recursive: true });
    fsMod.copyFileSync(src, dst);
    restored.push(f.path);
  }
  return restored;
}
// Oracle's example library (apexlang-skill/templates) through scripts/squad-examples.mjs.
function exampleLibrary(args) {
  return runApexTool([PROJECT_ROOT + '\\scripts\\squad-examples.mjs', ...args]).stdout.trim();
}
// Validator findings that are limits of the offline validator, not defects in the app.
// COMPILER_TRUTH_COMPONENT_AMBIGUOUS: it cannot tell which of the five 'column' component
// types a report column is; Oracle's own classic-report example gets it too. In the 2026-10-12
// run it cost two Engineer attempts. They are listed, but not counted as errors.
const ADVISORY_CODES = ['COMPILER_TRUTH_COMPONENT_AMBIGUOUS'];
// Oracle's structural format check + compiler-truth audit on a COPY of the app
// (format rewrites files). ok: true = clean, false = errors, null = validator unavailable.
function validateApp(dir) {
  const appRoot = findAppRoot(dir);
  if (appRoot === null) {
    return { ok: false, appRoot: null, errorCount: 1, text: 'Oracle APEXlang validation: FAILED -- no application.apx found in the workspace.' };
  }
  const tmp = tmpDir('validate');
  const tmpName = pathMod.basename(tmp);
  const rel = (p) => {
    p = String(p).replace(/\\/g, '/');
    const i = p.indexOf(tmpName + '/');
    return i >= 0 ? p.slice(i + tmpName.length + 1) : p;
  };
  try {
    fsMod.cpSync(pathMod.join(dir, appRoot), tmp, { recursive: true });
    const apexctl = SKILL_ROOT + '\\tools\\apexctl.mjs';
    const fmt = runApexTool([apexctl, 'apexlang', 'format', '--app-path', tmp, '--strict-structure']);
    let aud = runApexTool([apexctl, 'apexlang', 'compiler-truth', 'audit', '--app-path', tmp, '--verify-component-attributes', ...compilerHomeArgs()]);
    // STALE = the vendored property catalog (apexlang-skill/assets/component-attributes.json) is older
    // than the installed compiler metadata. A setup problem, not an app error: audit the app without that self-check.
    const staleCatalog = /COMPILER_TRUTH_COMPONENT_ATTRIBUTES_STALE/.test(aud.out);
    if (staleCatalog) aud = runApexTool([apexctl, 'apexlang', 'compiler-truth', 'audit', '--app-path', tmp, ...compilerHomeArgs()]);
    let fmtJson = null;
    try { fmtJson = JSON.parse(fmt.stdout); } catch (e) { fmtJson = null; }
    const auditRan = /APEXLANG_COMPILER_TRUTH_AUDIT_(OK|FAILED)/.test(aud.out);
    const where = (appRoot || '.') + '/';
    if (!fmtJson || !auditRan) {
      return { ok: null, appRoot, errorCount: 0, text: 'Oracle APEXlang validation of ' + where + ': UNAVAILABLE (validator did not run: ' + clip(fmt.out + ' ' + aud.out, 400) + ')' };
    }
    let errors = [];
    for (const f of fmtJson.findings || []) {
      const m = String(f.finding).match(/^line (\d+): (.*)$/);
      errors.push({ file: rel(f.path), line: m ? +m[1] : null, code: 'FORMAT_STRUCTURE', message: m ? m[2] : String(f.finding) });
    }
    for (const line of aud.out.split(/\r?\n/)) {
      const m = line.match(/^\s*-\s+(.+?):(\d+):\s+(\S+)\s+(.*)$/);
      if (m) errors.push({ file: rel(m[1]), line: +m[2], code: m[3], message: m[4] });
    }
    const advisory = errors.filter((e) => ADVISORY_CODES.includes(e.code));
    errors = errors.filter((e) => !ADVISORY_CODES.includes(e.code));
    // An audit that failed only on advisory findings counts as passed.
    const auditOk = /APEXLANG_COMPILER_TRUTH_AUDIT_OK/.test(aud.out) ||
      (advisory.length > 0 && !errors.some((e) => e.code !== 'FORMAT_STRUCTURE'));
    const advisoryText = !advisory.length ? '' : '\nNot counted as errors: ' + advisory.length + ' finding(s) the offline validator cannot decide (' +
      ADVISORY_CODES.join(', ') + '; Oracle\'s own examples get them too, and the live compiler decides). Leave these alone: ' +
      advisory.slice(0, 12).map((e) => e.file + (e.line ? ':' + e.line : '')).join(', ') + (advisory.length > 12 ? ', ...' : '') + '.';
    if (!auditOk && !errors.some((e) => e.code !== 'FORMAT_STRUCTURE')) {
      errors.push({ file: '-', line: null, code: 'AUDIT_FAILED', message: clip(aud.out, 600) });
    }
    const ok = errors.length === 0 && fmtJson.status === 'ok' && auditOk;
    if (ok) return { ok: true, appRoot, errorCount: 0, text: 'Oracle APEXlang validation of ' + where + ': PASSED (structure ok, compiler-truth audit ok' + (staleCatalog ? '; apexlang-skill property catalog is older than the compiler metadata, its self-check was skipped' : '') + ').' + advisoryText };
    const byFile = {};
    for (const e of errors) (byFile[e.file] = byFile[e.file] || []).push(e);
    const L = ['Oracle APEXlang validation of ' + where + ': FAILED -- ' + errors.length + ' error(s) in ' + Object.keys(byFile).length +
      ' file(s) (format status: ' + fmtJson.status + '). File paths are relative to ' + where];
    let shown = 0;
    for (const [file, list] of Object.entries(byFile)) {
      if (shown >= 80) break;
      L.push(file);
      for (const e of list) {
        if (shown >= 80) break;
        L.push('  ' + (e.line ? 'line ' + e.line + ': ' : '') + e.code + ' ' + e.message);
        shown++;
      }
    }
    if (errors.length > shown) L.push('... and ' + (errors.length - shown) + ' more.');
    if (errors.some((e) => /PROP_UNKNOWN|COMPONENT_UNKNOWN|AMBIGUOUS/.test(e.code))) {
      L.push('Hint: *_PROP_UNKNOWN means the property name is invented or misplaced -- look up the real names with Valid_Props(component), e.g. Valid_Props("button").');
    }
    return { ok: false, appRoot, errorCount: errors.length, text: L.join('\n') + advisoryText };
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
}
// Compiler-truth property list for one component type, compacted for an LLM.
// component = a type name (region, button, ...) or the number of one variant;
// group = one property group (layout, source, ...) instead of the whole component.
function validProps(component, parent, group) {
  const ok = (s) => /^[A-Za-z0-9][A-Za-z0-9.]{0,60}$/.test(s);
  component = String(component || '').trim();
  parent = String(parent || '').trim();
  group = String(group || '').trim();
  if (!ok(component)) return 'ERROR: component is required, e.g. button, region, pageItem, process, dynamicAction, validation, column.';
  // Agents pass things like "page[type=form]" as parent; a wrong parent must not cost a round.
  if (parent && !ok(parent)) parent = '';
  if (group && !ok(group)) group = '';
  const tool = [SKILL_ROOT + '\\tools\\query-valid-props.mjs', ...compilerHomeArgs()];
  const run = (args) => {
    const r = runApexTool([...tool, ...args]);
    return r.code === 0 ? r.stdout : r.out;
  };
  // Every component type: "id <tab> name <tab> parent=x <tab> props=n", optionally followed by "  valid when ...".
  const types = [];
  for (const line of run(['--list']).split(/\r?\n/)) {
    const c = line.split('\t');
    if (c.length >= 4 && /^\d+$/.test(c[0])) types.push({ id: c[0], name: c[1], parent: c[2].replace('parent=', ''), props: c[3].replace('props=', ''), when: '' });
    else if (/^\s+valid when/.test(line) && types.length) types[types.length - 1].when = line.trim();
  }
  let selector;
  let note = '';
  if (/^\d+$/.test(component)) {
    if (!types.some((t) => t.id === component)) return 'ERROR: there is no component type number ' + component + '.';
    selector = ['--component-type-id', component];
  } else if (component.includes('.')) {
    selector = ['--component', component];   // dotted alias such as chart.series, resolved by Oracle's tool
  } else {
    const named = types.filter((t) => t.name.toLowerCase() === component.toLowerCase());
    if (!named.length) return componentHelp(component, types);
    const under = parent ? named.filter((t) => t.parent.toLowerCase() === parent.toLowerCase()) : named;
    if (parent && !under.length) note = '(There is no "' + component + '" under parent "' + parent + '".)\n';
    const candidates = under.length ? under : named;
    if (candidates.length > 1) {
      // e.g. column: a different component type per kind of report region
      return note + '"' + component + '" exists as ' + candidates.length + ' component types. Which one applies depends on its parent:\n' +
        candidates.map((t) => '- ' + t.id + ': parent ' + t.parent + (t.when ? ', ' + t.when : '') + ' (' + t.props + ' properties)').join('\n') +
        '\nCall Valid_Props again with component set to the number of the one you need, e.g. component "' + candidates[0].id + '".';
    }
    selector = ['--component-type-id', candidates[0].id];
  }
  const format = (text) => {
    const out = [];
    let values = [];
    const flush = () => {
      if (!values.length) return;
      out[out.length - 1] += ' values: ' + values.slice(0, 15).join(' | ') + (values.length > 15 ? ' | ... (' + values.length + ' total)' : '');
      values = [];
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^Using compiler metadata/.test(line)) continue;
      const v = line.match(/^\s+value: (\S+)/);
      if (v) { values.push(v[1]); continue; }
      flush();
      if (line.trim()) out.push(line.replace(/^- active\s+/, '- ').replace(/^- conditional\s+/, '- (conditional) '));
    }
    flush();
    return out;
  };
  const raw = run(group ? [...selector, '--group', group] : selector);
  if (/No matching component types|Unknown dotted component alias/.test(raw)) return componentHelp(component, types);
  const lines = format(raw);
  if (group && !lines.some((l) => l.startsWith('- '))) {
    const groups = format(run(selector)).filter((l) => /^\[.+\]$/.test(l)).map((l) => l.slice(1, -1));
    return note + '"' + component + '" has no property group "' + group + '". Its groups: ' + groups.join(', ') + '.';
  }
  const text = lines.join('\n').trim();
  if (!text) return 'ERROR: no compiler metadata output for component "' + component + '".';
  const hint = !group && text.length > 6000 ? '\n(Long list. Next time pass group, e.g. Valid_Props("' + component + '", group "layout"), to get one group.)' : '';
  return note + clip(text, 12000) + hint;
}
// What to say when the name is not a component type: nearby names plus where to look instead.
function componentHelp(component, types) {
  const term = component.toLowerCase().split('.').pop();
  const near = types.filter((t) => t.name.toLowerCase().includes(term) || (term.length > 3 && term.includes(t.name.toLowerCase())));
  return [
    '"' + component + '" is not a component type, so there is no property list for it.',
    near.length ? 'Component types with a similar name: ' + near.slice(0, 12).map((t) => t.name + ' (parent ' + t.parent + ')').join(', ') + '.' : '',
    'The main component types: app, page, region (parent page), pageItem, button, process, dynamicAction, action (parent dynamicAction), validation, computation, branch, column (parent region), lov, list, breadcrumb, entry (parent list, lov or breadcrumb).',
    'target, source, layout, behavior, appearance, link, pagination and the like are property GROUPS or object values inside a component: ask for the component with a group, e.g. Valid_Props("button", group "behavior").',
    'interactiveReport, form, chart, formInitialization, closeDialog and the like are values of a "type:" property, not components: read an Oracle example instead, e.g. Example("interactive-report-page"), Example("form-page"), Example("chart"), Example("processes.form-initialization").',
  ].filter(Boolean).join('\n');
}
// ---- end apexctl helpers ----
// ---- SQLcl install helpers (scripts/squad-install.mjs does the work) ----
// Target connection + APEX workspace: the session's choice over squad-install.config.json;
// null = switched off. squad-install.mjs applies the same session settings itself.
function installConfig() {
  const db = settingsFor().database;
  return db.enabled && db.connection ? { ...squadConfig(), ...db } : null;
}
// Async on purpose: an install takes 20-60 s, and blocking the Code node that long
// (spawnSync) makes its task runner miss the heartbeat.
function runInstaller(args, timeoutMs) {
  return new Promise((resolve) => {
    const unavailable = (why) => resolve({ ok: null, status: 'unavailable', text: 'Database install: UNAVAILABLE (installer did not run: ' + clip(why, 400) + ')' });
    let out = '';
    let err = '';
    // --session makes the installer use this session's database and working folder.
    const session = CURRENT_SESSION && !args.includes('--session') ? ['--session', CURRENT_SESSION] : [];
    const child = cpMod.spawn(NODE_EXE, [PROJECT_ROOT + '\\scripts\\squad-install.mjs', ...args, ...session, '--json'], { cwd: PROJECT_ROOT, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); unavailable(String(e.message || e)); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { unavailable((out + ' ' + err).trim() || 'timed out'); }
    });
  });
}
// Run the app's SQL scripts and import the app with SQLcl on the configured connection.
// ok: true = installed, false = SQL/APEXlang errors to fix, null = could not run or switched off.
function installApp(dir, force) {
  return runInstaller(['--session', pathMod.basename(dir)].concat(force ? ['--force'] : []), 200000);
}
// One line for prompts: connection, schema, database and APEX version ('' when switched off).
async function installTargetText() {
  return installConfig() ? (await runInstaller(['--target'], 60000)).text : '';
}
// Put an install result into the shared state, against the current attempt.
function recordInstall(st, ins) {
  st.lastInstall = { attempt: st.attempt, at: new Date().toISOString(), ok: ins.ok, status: ins.status, appId: ins.appId || null, text: ins.text };
  const entry = st.attempts.find((a) => a.attempt === st.attempt);
  if (entry) entry.install = ins.ok === true ? 'app ' + ins.appId + ' installed' : ins.ok === false ? 'FAILED' : 'not run';
}
// ---- end SQLcl install helpers ----

function saveState(dir, st) {
  st.updatedAt = new Date().toISOString();
  writeText(metaPath(dir, 'state.json'), JSON.stringify(st, null, 2));
  writeText(metaPath(dir, 'state.md'), renderState(st));
}
// ---- end shared helpers ----
