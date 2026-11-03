
// ---- APEX Expert agent tools (workflow APEX_Agent_Tools) ----
// One Code node behind the APEX Expert agents' database and project tools. The
// shared helpers above give the session folders and Oracle's scaffolder; the
// database work is done by scripts/apex-agent-db.mjs (SQLcl on APEX_CONNECTION /
// APEX_WORKSPACE from .env). n8n cancels a workflow tool after 120 s, so every
// operation stays below that.
//   new_project            create a project (session folder), Oracle scaffold unless mode = "empty"
//   query | execute        SQL_Query / SQL_Execute (sql)
//   export                 Export_App (session, app_id)
//   validate | install     Check_App / Install_App (session)
//   page_check             Page_Check (app_id, pages = optional page numbers, debug)
//   ui_test                UI_Test (app_id, steps = JSON array or a scenario file, session = optional project, debug)
//   target                 DB_Target: connection, schema, versions, workspace, app URL (live from .env + the database)
// debug = "yes": APEX debug for the tool's own session, and its errors from apex_debug_messages.
// View_Screenshot is the workflow's other branch (view-screenshot.js + the Anthropic node).
const trig = $('When Executed by Another Workflow').first().json;
const op = String(trig.operation || '').trim();
const reply = (result) => [{ json: { result } }];
const DB_TOOL = PROJECT_ROOT + '\\scripts\\apex-agent-db.mjs';

// Async on purpose: SQLcl calls take 5-60 s, and a blocking spawnSync makes the
// Code node's task runner miss its heartbeat.
function runDbTool(args, text, timeoutMs) {
  return new Promise((resolve) => {
    let file = '';
    if (text) {
      fsMod.mkdirSync(TMP_ROOT, { recursive: true });
      file = tmpDir('agent-text') + '.sql';
      fsMod.writeFileSync(file, text, 'utf8');
      args = args.concat(['--text-file', file]);
    }
    const done = (result) => { if (file) fsMod.rmSync(file, { force: true }); resolve(result); };
    let out = '';
    let err = '';
    const child = cpMod.spawn(NODE_EXE, [DB_TOOL, ...args, '--json'], { cwd: PROJECT_ROOT, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs || 115000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: null, text: 'UNAVAILABLE -- the database tool did not start: ' + e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() || '';
      try { done(JSON.parse(last)); } catch (e) {
        done({ ok: null, text: 'UNAVAILABLE -- the database tool ' + (code === null ? 'was stopped after ' + Math.round((timeoutMs || 115000) / 1000) + ' s' : 'exited with code ' + code) + ': ' + clip(err || out, 600) });
      }
    });
  });
}

const sessionArg = () => {
  try { return ['--session', sessionKey(trig.session)]; } catch (e) { return []; }
};
const appArg = () => (/^\d{1,9}$/.test(String(trig.app_id || '').trim()) ? ['--app-id', String(trig.app_id).trim()] : []);
const debugArg = () => (/^\s*(yes|true|y|1|on)\s*$/i.test(String(trig.debug || '')) ? ['--debug'] : []);

if (op === 'new_project') {
  // 8 hex characters like the squad's sessions, so FS_* and Install_App address the folder.
  let key, dir;
  do {
    key = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    dir = sessionDir(key);
  } while (fsMod.existsSync(dir));
  fsMod.mkdirSync(dir, { recursive: true });
  const empty = /^\s*empty\s*$/i.test(String(trig.mode || ''));
  if (empty) {
    return reply('PROJECT: ' + key + '\nA new, EMPTY project folder was created (' + dir + '). Use it for Export_App, which fills app/ with an existing application. Pass session "' + key + '" to every project tool and to every sub-agent.');
  }
  const scaffold = ensureScaffold(dir);
  if (scaffold.appRoot === null) {
    return reply('PROJECT: ' + key + '\nWARNING: Oracle\'s scaffolder failed (' + scaffold.error + '); the project folder is empty. The Developer must create the whole app under app/.');
  }
  return reply('PROJECT: ' + key + '\nA new project was created (' + dir + ') with Oracle\'s baseline app under app/: valid, compiler-checked APEXlang (application.apx, Universal Theme, global page 0, login page 9999, shared components, supporting-objects/). ' +
    'Pass session "' + key + '" to every project tool and to every sub-agent. Install_App creates a NEW application on its first install and updates that same application afterwards.\nFiles:\n' + fileListText(dir));
}

if (op === 'query' || op === 'execute' || op === 'export' || op === 'validate' || op === 'install' || op === 'page_check' || op === 'ui_test' || op === 'target') {
  // The model may send a JSON value instead of a string (UI_Test steps as an array): keep it JSON.
  const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const text = op === 'query' || op === 'execute' ? asText(trig.sql) : op === 'page_check' ? asText(trig.pages) : op === 'ui_test' ? asText(trig.steps) : '';
  if ((op === 'query' || op === 'execute') && !text.trim()) return reply('ERROR: pass the SQL in "sql".');
  if (op === 'ui_test' && !text.trim()) return reply('ERROR: pass the scenario in "steps".');
  const debugFlag = op === 'page_check' || op === 'ui_test' ? debugArg() : [];
  const r = await runDbTool(['--op', op, ...sessionArg(), ...appArg(), ...debugFlag], text, op === 'install' ? 117000 : 112000);
  return reply(r.text || JSON.stringify(r));
}
return reply('ERROR: unknown operation "' + op + '"');
