#!/usr/bin/env node
// Builds the APEX Expert on n8n's Agents feature (n8n 2.43+):
//   1. the tool workflow "APEX_Agent_Tools" (public API, N8N_API_KEY),
//   2. four n8n Agents -- the lead "APEX Expert" with the saved sub-agents
//      APEX Analyst, APEX Developer and APEX Tester (editor REST API, N8N_EMAIL / N8N_PASSWORD),
//   3. each agent's skills (n8n agent skills: instructions + markdown references).
// Sources: agents/apex-expert/apex-expert.json (models, credential name, skillSource; this n8n's ids
// are in apex-expert.local.json),
// agents/apex-expert/prompts/*.md, agents/apex-expert/skills/<slug>/SKILL.md + references.json
// (reference files come from Oracle's APEXlang skill package under skillSource),
// agents/src/shared-helpers.js + agents/apex-expert/src/agent-tools.js (the Code node).
// Server responses are saved back to agents/apex-expert/ and workflows/.
// @@NAME@@ tokens in all sources are filled in from the environment (scripts/lib/env.mjs).
//
// Usage: node scripts/build-apex-expert.mjs [--tools] [--agents] [--publish] [--workflow] [--check-skills]
//   no flag = --tools --agents --workflow; --workflow (re)builds the "APEX Expert Chat" workflow and
//   publishes the agents it runs; --publish publishes all agents; --check-skills only builds the
//   skills locally and prints their sizes.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, HOST, pub, editorSession, wfTool } from './lib/n8n-agents.mjs';
import { render, templatize } from './lib/env.mjs';

const DIR = path.join(ROOT, 'agents', 'apex-expert');
const args = new Set(process.argv.slice(2));
const all = !['--tools', '--agents', '--publish', '--workflow', '--check-skills'].some((a) => args.has(a));

// apex-expert.json holds the settings (shared); apex-expert.local.json the ids of this
// machine's n8n (git-ignored, written by the build). Ids still in apex-expert.json move there.
const cfgPath = path.join(DIR, 'apex-expert.json');
const localPath = path.join(DIR, 'apex-expert.local.json');
const LOCAL_KEYS = ['credentialId', 'projectId', 'toolsWorkflowId', 'chatWorkflowId', 'agentIds', 'skillIds', 'helperWorkflowIds'];
const shared = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const cfg = { ...shared, ...(fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {}) };
const saveCfg = () => {
  fs.writeFileSync(localPath, JSON.stringify(Object.fromEntries(LOCAL_KEYS.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]])), null, 2) + '\n');
  if (LOCAL_KEYS.some((k) => k in shared)) {
    for (const k of LOCAL_KEYS) delete shared[k];
    fs.writeFileSync(cfgPath, JSON.stringify(shared, null, 2) + '\n');
  }
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');

// Sub-agents first: the leads reference their ids. *Wf = workflow edition (no approvals).
const ROLES = ['analyst', 'developer', 'tester', 'lead', 'developerWf', 'leadWf'];
const SKILLS_BY_ROLE = {
  lead: ['oracle-apexlang', 'inspect-apps', 'sql-plsql', 'debug-runtime', 'apexlang-edit', 'build-and-test-loop', 'sample-data'],
  analyst: ['oracle-apexlang', 'requirements-to-spec', 'inspect-apps', 'apexlang-pages'],
  developer: ['oracle-apexlang', 'sql-plsql', 'apexlang-edit', 'apexlang-pages', 'apexlang-components', 'sample-data'],
  tester: ['oracle-apexlang', 'test-app', 'inspect-apps', 'debug-runtime'],
};
SKILLS_BY_ROLE.leadWf = SKILLS_BY_ROLE.lead;
SKILLS_BY_ROLE.developerWf = SKILLS_BY_ROLE.developer;
// The agents the chat workflow runs; they must be published for production executions.
const WORKFLOW_ROLES = ['analyst', 'tester', 'developerWf', 'leadWf'];

// ---------------------------------------------------------------- skills (local build)
const LIMITS = { instructions: 65536, refs: 20, ref: 65536, total: 262144 };
function buildSkill(slug) {
  const raw = read(DIR, 'skills', slug, 'SKILL.md');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('skills/' + slug + '/SKILL.md: missing frontmatter');
  const front = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  const skill = { name: front.name, description: front.description, instructions: m[2].trim() };
  const refFile = path.join(DIR, 'skills', slug, 'references.json');
  const source = path.resolve(ROOT, cfg.skillSource || 'apexlang-skill');
  if (fs.existsSync(refFile)) {
    const refs = [];
    for (const r of JSON.parse(read(refFile))) {
      if (r.dir) {
        const dir = path.join(source, r.dir);
        for (const f of fs.readdirSync(dir).filter((x) => /\.md$/i.test(x)).sort()) refs.push({ path: r.as + f, content: read(dir, f) });
      } else {
        refs.push({ path: r.path, content: read(source, r.from) });
      }
    }
    if (refs.length) skill.references = refs;
  }
  Object.assign(skill, render(skill));
  const total = (skill.references || []).reduce((n, r) => n + r.content.length, 0);
  const problems = [];
  if (!skill.name || skill.name.length > 128) problems.push('name');
  if (!skill.description || skill.description.length > 512) problems.push('description is ' + (skill.description || '').length + ' chars (max 512)');
  if (skill.instructions.length > LIMITS.instructions) problems.push('instructions too long');
  if ((skill.references || []).length > LIMITS.refs) problems.push((skill.references || []).length + ' references (max 20)');
  for (const r of skill.references || []) {
    if (r.content.length > LIMITS.ref) problems.push(r.path + ' too long');
    if (!/^references\/.+\.md$/.test(r.path)) problems.push(r.path + ': must be references/....md');
  }
  if (total > LIMITS.total) problems.push('references total ' + total + ' chars (max 262144)');
  // Every reference the body names must exist, and every reference must be named in the body.
  const named = new Set([...skill.instructions.matchAll(/`(references\/[^`]+\.md)`/g)].map((x) => x[1]));
  for (const r of skill.references || []) if (!named.has(r.path)) problems.push(r.path + ' is not mentioned in the instructions');
  for (const p of named) if (!(skill.references || []).some((r) => r.path === p)) problems.push('instructions name ' + p + ', which is not a reference');
  if (problems.length) throw new Error('skill ' + slug + ': ' + problems.join('; '));
  return { skill, stats: skill.name + ': instructions ' + skill.instructions.length + ', ' + (skill.references || []).length + ' refs, ' + total + ' chars' };
}

// ---------------------------------------------------------------- 1. tool workflow
const TOOL_INPUTS = ['operation', 'session', 'app_id', 'sql', 'pages', 'mode', 'steps', 'debug', 'file_path', 'question'];
// The model that looks at screenshots (View_Screenshot): visionModel in apex-expert.json, else the Tester's.
const visionModel = () => String(cfg.visionModel || cfg.models.tester).replace(/^anthropic\//, '');
const ifNode = (id, name, position, leftValue, operation, rightValue) => ({
  id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: id + '-c', leftValue, rightValue, operator: { type: 'string', operation, ...(rightValue === undefined ? { singleValue: true } : {}) } }],
      combinator: 'and',
    },
    options: {},
  },
});
// n8n gives the agent the output of the LAST node that ran, so every branch ends in a node whose item has "result".
const SCREENSHOT_ANSWER = `const r = $input.first().json;
const file = $('Load Screenshot').first().json.file;
const text = Array.isArray(r.content) ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\\n').trim() : '';
const error = r.error ? (r.error.message || JSON.stringify(r.error)) : 'the model gave no answer';
return [{ json: { result: text ? 'View_Screenshot (' + file + '):\\n' + text : 'View_Screenshot: UNAVAILABLE -- ' + String(error).slice(0, 500) } }];`;
function toolsWorkflow() {
  const helpers = read(ROOT, 'agents', 'src', 'shared-helpers.js') + '\n';
  return render({
    name: 'APEX_Agent_Tools',
    nodes: [
      {
        id: 'c2d0a001-0000-4000-8000-000000000001',
        name: 'Notes',
        type: 'n8n-nodes-base.stickyNote',
        typeVersion: 1,
        position: [-420, -300],
        parameters: {
          width: 640, height: 340,
          content: '## APEX_Agent_Tools\nProject and database tools of the APEX Expert agents: New_Project, SQL_Query, SQL_Execute, Export_App, Check_App (SQLcl apex validate), Install_App, Page_Check (ORDS), UI_Test (browser), View_Screenshot.\n\nThe database work is done by scripts/apex-agent-db.mjs with SQLcl on APEX_CONNECTION / APEX_WORKSPACE from .env. n8n stops a workflow tool after 120 s, so every operation stays below that.\n\nView_Screenshot (lower branch): n8n gives agents no images, so the Anthropic node looks at the screenshot and answers in text.\n\nGenerated by scripts/build-apex-expert.mjs from agents/apex-expert/src/ -- edit there.',
        },
      },
      {
        id: 'c2d0a001-0000-4000-8000-000000000002',
        name: 'When Executed by Another Workflow',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1.1,
        position: [-380, 120],
        parameters: { workflowInputs: { values: TOOL_INPUTS.map((name) => ({ name, type: 'string' })) } },
      },
      ifNode('c2d0a001-0000-4000-8000-000000000004', 'Screenshot?', [-160, 120], '={{ $json.operation }}', 'equals', 'view_screenshot'),
      {
        id: 'c2d0a001-0000-4000-8000-000000000003',
        name: 'Run Tool',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [80, 220],
        parameters: { jsCode: helpers + read(DIR, 'src', 'agent-tools.js') },
      },
      {
        id: 'c2d0a001-0000-4000-8000-000000000005',
        name: 'Load Screenshot',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [80, 0],
        parameters: { jsCode: helpers + read(DIR, 'src', 'view-screenshot.js') },
      },
      ifNode('c2d0a001-0000-4000-8000-000000000006', 'Has Image', [300, 0], '={{ $json.prompt }}', 'notEmpty'),
      {
        id: 'c2d0a001-0000-4000-8000-000000000007',
        name: 'Look at Screenshot',
        type: '@n8n/n8n-nodes-langchain.anthropic',
        typeVersion: 1,
        position: [520, -100],
        parameters: {
          resource: 'image', operation: 'analyze',
          modelId: { __rl: true, mode: 'id', value: visionModel() },
          text: '={{ $json.prompt }}', inputType: 'binary', binaryPropertyName: 'data', simplify: true,
          options: { maxTokens: 1500 },
        },
        credentials: { anthropicApi: { id: cfg.credentialId, name: cfg.credentialName } },
        onError: 'continueRegularOutput',
      },
      {
        id: 'c2d0a001-0000-4000-8000-000000000008',
        name: 'Answer',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [740, -100],
        parameters: { jsCode: SCREENSHOT_ANSWER },
      },
    ],
    connections: {
      'When Executed by Another Workflow': { main: [[{ node: 'Screenshot?', type: 'main', index: 0 }]] },
      'Screenshot?': { main: [[{ node: 'Load Screenshot', type: 'main', index: 0 }], [{ node: 'Run Tool', type: 'main', index: 0 }]] },
      'Load Screenshot': { main: [[{ node: 'Has Image', type: 'main', index: 0 }]] },
      'Has Image': { main: [[{ node: 'Look at Screenshot', type: 'main', index: 0 }], []] },
      'Look at Screenshot': { main: [[{ node: 'Answer', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  });
}

async function buildTools() {
  // The Anthropic node of View_Screenshot needs the credential id.
  if (!session.loggedIn()) await session.login();
  await ensureCredential();
  const wf = toolsWorkflow();
  let saved;
  if (cfg.toolsWorkflowId) {
    saved = (await pub('PUT', '/workflows/' + cfg.toolsWorkflowId, wf)).json;
  } else {
    saved = (await pub('POST', '/workflows', wf)).json;
    cfg.toolsWorkflowId = saved.id;
    saveCfg();
  }
  await pub('POST', '/workflows/' + saved.id + '/activate').catch((e) => console.warn('activate:', e.message));
  saved = (await pub('GET', '/workflows/' + saved.id)).json;
  fs.writeFileSync(path.join(ROOT, 'workflows', saved.name + '__' + saved.id + '.json'), JSON.stringify(templatize(saved), null, 2));
  console.log('tool workflow', saved.id, 'active=' + saved.active);
}

// The helper workflows by name: the saved id if it still exists, else a workflow of that name,
// else imported from workflows/<name>__*.json (a fresh n8n). They are activated either way.
// The template workflows/<name>__.json (no id, no metadata) is refreshed from n8n for the repo.
async function ensureHelpers() {
  cfg.helperWorkflowIds = cfg.helperWorkflowIds || {};
  for (const [key, name] of Object.entries(HELPERS)) {
    let id = cfg.helperWorkflowIds[key];
    if (id && !(await pub('GET', '/workflows/' + id).catch(() => null))) id = null;
    if (!id) {
      const list = (await pub('GET', '/workflows?limit=250&name=' + encodeURIComponent(name))).json.data || [];
      id = (list.find((w) => w.name === name && !w.isArchived) || {}).id;
    }
    if (!id) {
      const file = fs.readdirSync(path.join(ROOT, 'workflows')).find((f) => f.startsWith(name + '__') && f.endsWith('.json'));
      if (!file) throw new Error('workflow ' + name + ' not found in n8n nor in workflows/');
      const wf = JSON.parse(read(ROOT, 'workflows', file));
      id = (await pub('POST', '/workflows', render({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} }))).json.id;
      console.log('imported', name, id);
    }
    await pub('POST', '/workflows/' + id + '/activate').catch((e) => console.warn('activate ' + name + ':', e.message));
    cfg.helperWorkflowIds[key] = id;
    const w = (await pub('GET', '/workflows/' + id)).json;
    const template = { name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings || {} };
    fs.writeFileSync(path.join(ROOT, 'workflows', name + '__.json'), JSON.stringify(templatize(template), null, 2) + '\n');
  }
  saveCfg();
  FS[0] = cfg.helperWorkflowIds.fs;
  APX[0] = cfg.helperWorkflowIds.apx;
}

// The Anthropic credential by name when its id is not known yet (another n8n).
async function ensureCredential() {
  if (cfg.credentialId) return;
  const list = data(await rest('GET', '/credentials')) || [];
  const c = list.find((x) => x.name === cfg.credentialName);
  if (!c) throw new Error('n8n has no credential named "' + cfg.credentialName + '": create it (Anthropic) or set credentialName in apex-expert.json');
  cfg.credentialId = c.id;
  saveCfg();
}

// ---------------------------------------------------------------- 2. agent configs
const AT = () => [cfg.toolsWorkflowId, 'APEX_Agent_Tools'];
// Hand-made tool workflows the agents also use; ensureHelpers() fills in their ids.
const HELPERS = { fs: 'FS_Workspace_Tool', apx: 'Squad_APEXlang_Tools' };
const FS = [null, HELPERS.fs];
const APX = [null, HELPERS.apx];
const P = ' session = the 8-character project key (from New_Project, or given in your task).';
const atFixed = Object.fromEntries(TOOL_INPUTS.map((k) => [k, '']));
const DEBUG = ' debug = "yes" turns APEX debug on for the tool\'s own session and adds a debug trace (per page view its time and the errors / warnings logged with the messages before them, from apex_debug_messages) -- use it when something fails or is slow; "no" otherwise (faster).';
const at = (name, op, description, ai, approval) => {
  const fixed = { ...atFixed, operation: op };
  for (const k of ai) delete fixed[k];
  const t = wfTool(name, ...AT(), description, fixed, ai);
  if (approval) t.requireApproval = true;
  return t;
};
const tools = {
  New_Project: () => at('New_Project', 'new_project', 'Create a new project folder and return its PROJECT key (pass it as session to every project tool and sub-agent). mode = "scaffold" for a NEW application (Oracle\'s valid baseline app is put under app/), or "empty" for a folder that Export_App fills with an existing application.', ['mode']),
  SQL_Query: () => at('SQL_Query', 'query', 'Run ONE read-only SELECT (or WITH ... SELECT) on the @@APEX_SCHEMA@@ schema and get the result as CSV (max 200 rows). Use it for the APEX dictionary views (apex_applications, apex_application_pages, ...), user_* views and data. Runs in a read-only transaction; anything else is refused. sql = the statement.', ['sql']),
  SQL_Execute: () => at('SQL_Execute', 'execute', 'Run a SQL / PL/SQL script on the @@APEX_SCHEMA@@ schema and COMMIT it: DDL, DML, packages, anonymous blocks. The user must approve each call. End SQL statements with ";" and PL/SQL units with a line containing only "/"; no EXIT, CONNECT, HOST, SPOOL, @file or & variables. Returns errors per statement, compile errors and the INVALID objects of the schema. sql = the script.', ['sql'], true),
  Export_App: () => at('Export_App', 'export', 'Export an existing APEX application (workspace @@APEX_WORKSPACE@@) as APEXlang into app/ of an EMPTY project (New_Project with mode "empty"). The project is then pinned to that application: Install_App on it updates the application in place.' + P + ' app_id = the numeric application id.', ['session', 'app_id']),
  Check_App: () => at('Check_App', 'validate', 'THE validator: compile the project\'s app with the live APEX compiler through SQLcl (apex validate on @@APEX_CONNECTION@@). No import, no changes. Returns PASSED, or every compile error (file, line, message with the valid values) plus warnings.' + P, ['session']),
  Install_App: () => at('Install_App', 'install', 'Install the project\'s app into @@APEX_CONNECTION@@ with SQLcl: runs the scripts under app/supporting-objects/, compiles and imports the app. Creates a new application on the first install of a scaffolded project, otherwise UPDATES the pinned application in place. The user must approve each call. Call it only after Check_App PASSED. Returns INSTALLED with the application id, or the SQL / compile / import errors.' + P, ['session'], true),
  Page_Check: () => at('Page_Check', 'page_check', 'Load pages of an installed application through ORDS (@@ORDS_BASE_URL@@), logged in as the test user, and report per page the HTTP status, the title and any APEX/ORA error shown. Rendering only (no clicks). app_id = the numeric application id; pages = "all" or a comma-separated list of page numbers.' + DEBUG, ['app_id', 'pages', 'debug']),
  UI_Test: () => at('UI_Test', 'ui_test', 'Use an installed application like a user, in a real (headless) browser logged in as the test user: open pages, fill items, click buttons and links, work inside modal dialogs, and check what is shown. One call runs one scenario (at most 40 steps, about 85 s) and reports each step (ok / FAIL, the page it led to, success and error messages, JavaScript and server errors), then the page it ended on with its regions, buttons, items and text, so you can write the next scenario. A failed action stops the scenario; failed checks do not. app_id = the numeric application id. ' +
    'steps = a JSON array, one action per step: {"go": <page number or alias>} | {"fill": "P10_NAME", "value": "text"} (select lists, radio groups and switches by label; popup LOVs by return value; dates as shown in the field) | {"click": "<visible label of a button, link, tab or menu entry>"} | {"press": "Enter"} | {"wait": <seconds, max 10>} | {"see": "text"} | {"notSee": "text"} | {"seeItem": "P10_NAME", "value": "x"} | {"seePage": <number or alias>} | {"shot": "<name>"} (screenshot of the page as it is now). ' +
    'Example: [{"go": 3}, {"click": "Create"}, {"fill": "P4_NAME", "value": "Test"}, {"click": "Create"}, {"seePage": 3}, {"see": "Test"}]. steps may instead name a scenario file saved in the project with FS_Write, e.g. "tests/ac-1.json". ' +
    'session = the project key (screenshots are saved under test-results/ there, also one at the end and one at a failed step; View_Screenshot looks at them) or "-" for none.' + DEBUG + ' With debug the scenario gets about 70 s instead of 85 s.', ['app_id', 'steps', 'session', 'debug']),
  View_Screenshot: () => at('View_Screenshot', 'view_screenshot', 'Look at a UI_Test screenshot: a vision model sees the image and answers your question in text (you cannot see images yourself). Use it for what the page text cannot tell: layout, overlapping or cut-off elements, colours and highlighting, charts, icons, which message is shown where, empty or broken regions. file_path = a path from the "Screenshots:" line or a "shot" step of a UI_Test result, e.g. test-results/2026-11-02T13-59-33/end.png; question = what to check, as specific as possible (e.g. "Are there three success messages? Quote them."), or "describe".' + P, ['session', 'file_path', 'question']),
  FS_List: () => wfTool('FS_List', ...FS, 'List every file in a project folder (path + size).' + P, { operation: 'list', file_path: '', content: '' }, ['session']),
  FS_Read: () => wfTool('FS_Read', ...FS, 'Read ONE file of a project (up to 15k chars). file_path = relative path exactly as FS_List shows it, e.g. app/pages/p00002-tasks.apx or spec.md.' + P, { operation: 'read', content: '' }, ['session', 'file_path']),
  FS_Write: () => wfTool('FS_Write', ...FS, 'Create or overwrite ONE file of a project. file_path = relative path with forward slashes; content = the COMPLETE file content (never a fragment). Folders are created automatically.' + P, { operation: 'write' }, ['session', 'file_path', 'content']),
  FS_Delete: () => wfTool('FS_Delete', ...FS, 'Delete ONE file of a project, e.g. an experiment under scratch/. file_path exactly as FS_List shows it.' + P, { operation: 'delete', content: '' }, ['session', 'file_path']),
  Valid_Props: () => wfTool('Valid_Props', ...APX, 'Look up the REAL property names, groups, required flags and allowed values of an APEXlang component type from the metadata of the SQLcl compiler. component = region, pageItem, button, process, dynamicAction, action, validation, column, lov, list, entry, ...; parent = disambiguation (region for column, dynamicAction for action) or "-" when not needed; group = one property group (layout, source, behavior, ...) or "-" for all groups.' + P, { operation: 'props', name: '' }, ['session', 'component', 'parent', 'group']),
  Example: () => wfTool('Example', ...APX, 'Read Oracle\'s own APEXlang code from the example library: full pages (form-page, interactive-report-page, dashboard-page, classic-report-page, ...), regions (chart, cards, form, ...), items (select-list, date-picker, ...), buttons, dynamic actions (dynamic-actions.close-dialog, ...), processes (processes.form-initialization, ...), validations and shared components. name = an example name, a family name to list its files, or a search word.' + P, { operation: 'example', component: '', parent: '', group: '' }, ['session', 'name']),
};
const pick = (...names) => names.map((n) => tools[n]());

const caching = { enabled: true, anthropic: { ttl: '5m' } };
function agentConfigs(skillRefs) {
  const m = cfg.models;
  const cred = cfg.credentialId;
  const ids = cfg.agentIds || {};
  const ref = (role) => (skillRefs[role] || []).map((id) => ({ type: 'skill', id }));
  const analyst = {
    name: 'APEX Analyst',
    description: 'Turns a user requirement into the technical requirement spec.md for an Oracle APEX app (data model, pages, components, security, acceptance checks).',
    model: m.analyst, credential: cred, instructions: read(DIR, 'prompts', 'analyst.md'),
    tools: pick('SQL_Query', 'Export_App', 'FS_List', 'FS_Read', 'FS_Write', 'Valid_Props', 'Example'),
    skills: ref('analyst'),
    config: { promptCaching: caching, maxIterations: 40 },
  };
  const developer = {
    name: 'APEX Developer',
    description: 'Builds or changes an Oracle APEX app in APEXlang + SQL/PL/SQL from spec.md, checks it with the live compiler (SQLcl) and installs it.',
    model: m.developer, credential: cred, instructions: read(DIR, 'prompts', 'developer.md'),
    tools: pick('FS_List', 'FS_Read', 'FS_Write', 'FS_Delete', 'Check_App', 'Install_App', 'SQL_Query', 'SQL_Execute', 'Export_App', 'Valid_Props', 'Example'),
    skills: ref('developer'),
    config: { promptCaching: caching, maxIterations: 100, reasoning: 'low' },
  };
  const tester = {
    name: 'APEX Tester',
    description: 'Tests an installed Oracle APEX app against spec.md: SQLcl compile gate, database and APEX dictionary checks, page rendering through ORDS, and browser scenarios (forms, buttons, dialogs) with UI_Test. Returns PASS or FAIL with evidence.',
    model: m.tester, credential: cred, instructions: read(DIR, 'prompts', 'tester.md'),
    tools: pick('Check_App', 'SQL_Query', 'Page_Check', 'UI_Test', 'View_Screenshot', 'FS_List', 'FS_Read', 'Valid_Props', 'Example'),
    skills: ref('tester'),
    config: { promptCaching: caching, maxIterations: 50 },
  };
  const lead = {
    name: 'APEX Expert',
    description: 'Oracle APEX expert for the @@APEX_WORKSPACE@@ workspace: answers APEX/SQL/PL/SQL questions, inspects and changes apps, and builds new apps with its Analyst, Developer and Tester sub-agents.',
    model: m.lead, credential: cred, instructions: read(DIR, 'prompts', 'lead.md'),
    tools: pick('New_Project', 'SQL_Query', 'SQL_Execute', 'Export_App', 'Check_App', 'Install_App', 'Page_Check', 'UI_Test', 'View_Screenshot', 'FS_List', 'FS_Read', 'FS_Write', 'FS_Delete', 'Valid_Props', 'Example'),
    skills: ref('lead'),
    // Thread history, so the lead remembers the conversation across messages (e.g. the spec
    // it is waiting to have confirmed). Without `memory` every chat message starts empty.
    memory: { enabled: true, storage: 'n8n', observationalMemory: { enabled: false } },
    subAgents: {
      maxChildren: 1,
      agents: [
        { agentId: ids.analyst, useWhen: 'Step 1 of a build (skill build-and-test-loop): turn the user\'s requirement into spec.md. Pass the requirement verbatim, the project key, and for a change the application id; on a revision the user\'s answers.' },
        { agentId: ids.developer, useWhen: 'Step 2 of a build, after the user confirmed spec.md: build or fix the app and install it. Pass the project key, the application id once known, and on a fix round the Tester\'s findings verbatim.' },
        { agentId: ids.tester, useWhen: 'Step 3 of a build, after the Developer reports Check_App PASSED and an application id: test the app against spec.md. Pass the project key and the application id.' },
      ].filter((a) => a.agentId),
    },
    config: { promptCaching: caching, maxIterations: 60, reasoning: 'medium' },
  };
  // Workflow edition: n8n cannot pause a workflow execution for a tool approval, so the
  // chat workflow ("APEX Expert Chat") uses copies of the lead and the Developer whose
  // SQL_Execute / Install_App run without one (still only on the configured connection). Analyst and Tester
  // never write and are shared.
  const developerWf = {
    ...noApprovals(developer, 'developer'),
    name: 'APEX Developer (workflow)',
    description: developer.description + ' Workflow edition: installs without approval clicks.',
    skills: ref('developerWf'),
  };
  const leadWf = {
    ...noApprovals(lead, 'lead'),
    name: 'APEX Expert (workflow)',
    description: 'APEX Expert behind the "APEX Expert Chat" workflow: same as APEX Expert, but database changes run without approval clicks (n8n workflows cannot pause for approval).',
    skills: ref('leadWf'),
    subAgents: {
      ...lead.subAgents,
      agents: lead.subAgents.agents.map((a) => (a.agentId === ids.developer ? { ...a, agentId: ids.developerWf } : a)).filter((a) => a.agentId),
    },
  };
  return { analyst, developer, tester, lead, developerWf, leadWf };
}

// The approval-free copy of an agent: tools without requireApproval, and the prompt's
// approval rule replaced by a confirmation the agent asks for itself in the chat.
const NO_APPROVAL_RULE = {
  lead: [
    '- SQL_Execute and Install_App change the database. The user approves each call in the chat. Before calling one, say in one or two sentences what it will change. Never chain several unrelated changes into one script. If the user rejects a call, do not retry it; ask what they want instead.',
    '- SQL_Execute and Install_App change the database and run IMMEDIATELY in this chat: there is no approval click here. So before any change that deletes data, drops or alters an existing object, or updates an existing application (Install_App on a project made by Export_App), describe it and ask the user to confirm in their next message; run it only after a clear yes. New objects of a build whose spec the user confirmed need no further confirmation. Never chain several unrelated changes into one script.',
  ],
  developer: [
    '- Install_App (scripts + validate + import) changes the database: the user approves each call. Call it only after Check_App has PASSED, normally once per task, plus once after a fix.',
    '- Install_App (scripts + validate + import) changes the database and runs immediately (no approval in this channel). Call it only after Check_App has PASSED, normally once per task, plus once after a fix. Never drop, truncate or delete from existing tables, and never use Export_App + Install_App on an application the spec does not name.',
  ],
};
function noApprovals(conf, role) {
  const [from, to] = NO_APPROVAL_RULE[role];
  if (!conf.instructions.includes(from)) throw new Error('prompts/' + role + '.md: approval rule not found; update NO_APPROVAL_RULE in build-apex-expert.mjs');
  return {
    ...conf,
    instructions: conf.instructions.replace(from, to),
    tools: conf.tools.map(({ requireApproval, ...t }) => ({ ...t, description: (t.description || '').replace(/ The user must approve each call\./g, '') })),
  };
}

// ---------------------------------------------------------------- 3. push agents + skills
const session = editorSession('build-apex-expert');
const rest = session.rest;
const base = () => '/projects/' + cfg.projectId + '/agents/v2';
const data = (r) => (r && r.data !== undefined ? r.data : r);

async function ensureAgent(role, name) {
  cfg.agentIds = cfg.agentIds || {};
  if (!cfg.agentIds[role]) {
    const created = data(await rest('POST', base(), { name }));
    cfg.agentIds[role] = created.id;
    saveCfg();
    console.log('created agent', role, created.id);
  }
  return cfg.agentIds[role];
}

async function putConfig(role, conf) {
  const id = cfg.agentIds[role];
  const { config: current, configHash } = data(await rest('GET', base() + '/' + id + '/config'));
  const saved = data(await rest('PUT', base() + '/' + id + '/config', { config: { ...current, ...render(conf) }, baseConfigHash: configHash }));
  return saved.config || saved;
}

// Skills by name: update the existing one in place, else create and attach. Returns the ids in order.
async function upsertSkills(role, built) {
  const id = cfg.agentIds[role];
  const existing = data(await rest('GET', base() + '/' + id + '/skills')) || {};
  const byName = new Map(Object.entries(existing).map(([sid, s]) => [s.name.trim().toLowerCase(), sid]));
  const ids = [];
  for (const slug of SKILLS_BY_ROLE[role]) {
    const { skill } = built[slug];
    const sid = byName.get(skill.name.toLowerCase());
    if (sid) {
      // An empty array removes the references (the API rejects null).
      await rest('PATCH', base() + '/' + id + '/skills/' + sid, { ...skill, references: skill.references || [] });
      ids.push(sid);
    } else {
      const r = data(await rest('POST', base() + '/' + id + '/skills', skill));
      ids.push(r.id);
    }
  }
  cfg.skillIds = cfg.skillIds || {};
  cfg.skillIds[role] = Object.fromEntries(SKILLS_BY_ROLE[role].map((slug, i) => [slug, ids[i]]));
  saveCfg();
  return ids;
}

async function buildAgents() {
  if (!cfg.toolsWorkflowId) throw new Error('toolsWorkflowId missing in apex-expert.json: run with --tools first');
  await session.login();
  if (!cfg.projectId) { cfg.projectId = await session.personalProjectId(); saveCfg(); }
  await ensureCredential();
  const built = Object.fromEntries(Object.keys(Object.fromEntries(Object.values(SKILLS_BY_ROLE).flat().map((s) => [s, 1]))).map((s) => [s, buildSkill(s)]));
  for (const role of ROLES) await ensureAgent(role, agentConfigs({})[role].name);
  const skillRefs = {};
  for (const role of ROLES) {
    // A first config save gives the agent its JSON schema (skills attach to it), then the skills, then the final config.
    const { skills, ...withoutSkills } = agentConfigs({})[role];
    await putConfig(role, withoutSkills);
    skillRefs[role] = await upsertSkills(role, built);
  }
  for (const role of ROLES) {
    const out = await putConfig(role, agentConfigs(skillRefs)[role]);
    fs.writeFileSync(path.join(DIR, role + '.agent.json'), JSON.stringify(templatize(out), null, 2) + '\n');
    const v = await rest('GET', base() + '/' + cfg.agentIds[role] + '/validation').catch((e) => ({ error: e.message }));
    console.log('agent', role, cfg.agentIds[role], 'skills', skillRefs[role].length, 'validation:', JSON.stringify(data(v)).slice(0, 500));
  }
}

async function publish(roles) {
  if (!session.loggedIn()) await session.login();
  for (const role of roles) {
    const r = await rest('POST', base() + '/' + cfg.agentIds[role] + '/publish', {});
    console.log('published', role, cfg.agentIds[role], JSON.stringify(data(r)).slice(0, 160));
  }
}

// ---------------------------------------------------------------- 4. chat workflow
// "APEX Expert Chat": n8n's hosted chat page (n8n login) -> Message an Agent -> APEX Expert (workflow).
// The chat's sessionId becomes the agent session, so the conversation memory carries across messages.
const CHAT_WEBHOOK_ID = 'a9e5c0de-4a11-4c7e-9d2b-7a3e5c0c4a11';
function chatWorkflow() {
  return render({
    name: 'APEX Expert Chat',
    nodes: [
      {
        id: 'c2d0a002-0000-4000-8000-000000000001',
        name: 'Notes',
        type: 'n8n-nodes-base.stickyNote',
        typeVersion: 1,
        position: [-460, -300],
        parameters: {
          width: 600, height: 260,
          content: '## APEX Expert Chat\nChat page for the APEX Expert agent: use the Chat button below, or open the chat URL of the trigger in a browser where you are logged in to n8n.\n\nRuns **APEX Expert (workflow)**: the same agent as "APEX Expert", but SQL_Execute / Install_App run WITHOUT approval clicks, because n8n cannot pause a workflow execution for an approval. The agent asks in the chat before destructive changes. Only @@APEX_CONNECTION@@ is reachable.\n\nGenerated by scripts/build-apex-expert.mjs --workflow.',
        },
      },
      {
        id: 'c2d0a002-0000-4000-8000-000000000002',
        name: 'When chat message received',
        type: '@n8n/n8n-nodes-langchain.chatTrigger',
        typeVersion: 1.4,
        position: [-400, 60],
        webhookId: CHAT_WEBHOOK_ID,
        parameters: {
          public: true,
          mode: 'hostedChat',
          // n8n's own login (the browser's n8n session): the editor's chat panel can send
          // that; with basic auth it failed ("Failed to receive response", no execution).
          authentication: 'n8nUserAuth',
          initialMessages: 'Hi! I am the APEX Expert for workspace @@APEX_WORKSPACE@@.\nAsk me about your APEX apps, SQL or PL/SQL, or tell me which app to build or change.\nNote: in this chat, database changes run without an approval click; I ask before anything destructive.',
          options: { title: 'APEX Expert', subtitle: 'Oracle APEX @@APEX_VERSION@@ · workspace @@APEX_WORKSPACE@@', responseMode: 'streaming' },
        },
      },
      {
        id: 'c2d0a002-0000-4000-8000-000000000003',
        name: 'APEX Expert',
        type: 'n8n-nodes-base.messageAnAgent',
        typeVersion: 3.1,
        position: [-120, 60],
        parameters: {
          agentSource: 'referenced',
          agentId: { __rl: true, mode: 'list', value: cfg.agentIds.leadWf, cachedResultName: 'APEX Expert (workflow)' },
          message: '={{ $json.chatInput }}',
          advanced: { enableStreaming: true },
        },
      },
    ],
    connections: { 'When chat message received': { main: [[{ node: 'APEX Expert', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
  });
}

async function buildChatWorkflow() {
  if (!cfg.agentIds || !cfg.agentIds.leadWf) throw new Error('agent leadWf missing: run with --agents first');
  // Published agents need published (active) workflow tools.
  for (const id of [cfg.toolsWorkflowId, FS[0], APX[0]]) {
    const w = (await pub('GET', '/workflows/' + id)).json;
    if (!w.active) throw new Error('tool workflow ' + w.name + ' (' + id + ') is not active');
  }
  await publish(WORKFLOW_ROLES);
  const wf = chatWorkflow();
  let saved;
  if (cfg.chatWorkflowId) {
    saved = (await pub('PUT', '/workflows/' + cfg.chatWorkflowId, wf)).json;
  } else {
    saved = (await pub('POST', '/workflows', wf)).json;
    cfg.chatWorkflowId = saved.id;
    saveCfg();
  }
  await pub('POST', '/workflows/' + saved.id + '/activate').catch((e) => console.warn('activate:', e.message));
  saved = (await pub('GET', '/workflows/' + saved.id)).json;
  fs.writeFileSync(path.join(ROOT, 'workflows', saved.name + '__' + saved.id + '.json'), JSON.stringify(templatize(saved), null, 2));
  console.log('chat workflow', saved.id, 'active=' + saved.active, 'chat URL:', HOST + '/webhook/' + CHAT_WEBHOOK_ID + '/chat');
}

if (args.has('--check-skills')) {
  for (const slug of [...new Set(Object.values(SKILLS_BY_ROLE).flat())]) console.log(buildSkill(slug).stats);
}
if (all || ['--tools', '--agents', '--workflow'].some((a) => args.has(a))) await ensureHelpers();
if (all || args.has('--tools')) await buildTools();
if (all || args.has('--agents')) await buildAgents();
if (args.has('--publish')) await publish(ROLES);
if (all || args.has('--workflow')) await buildChatWorkflow();
