# n8n Workflows: APEX Expert

The **APEX Expert** agent on a locally hosted n8n instance (n8n Agents, with
skills), plus scripts that build it and keep its workflows in sync with this
folder through n8n's REST API.

**How to use the agent** (what to ask, approvals, builds, tests):
[docs/USING-THE-AGENT.md](docs/USING-THE-AGENT.md). This README covers
installing and maintaining it.

## Setup

1. In n8n: **Settings → API → Create an API key**.
2. Copy the env template and fill it in:
   ```
   cp .env.example .env
   ```
   Set `N8N_BASE_URL` (default `http://localhost:5678`; not `N8N_HOST`: n8n reads `.env` from the folder it starts in and takes `N8N_HOST` as its own hostname), `N8N_API_KEY`, `N8N_EMAIL` / `N8N_PASSWORD` (your n8n login, for the Agents API) and `APEX_TEST_USER` / `APEX_TEST_PASSWORD` (for Page_Check).
3. Install dependencies:
   ```
   npm install
   ```
4. Copy `squad-install.config.example.json` to `squad-install.config.json`
   if you don't have one yet, and set your SQLcl connection, APEX workspace
   and SQLcl path (see **Database target** below).
5. Start n8n from this folder with
   `NODE_FUNCTION_ALLOW_BUILTIN=fs,path,child_process` (set it user-wide with
   `setx NODE_FUNCTION_ALLOW_BUILTIN "fs,path,child_process"`). The tool Code
   nodes run the scripts and file operations with those Node built-ins.

## Sharing it: install on another machine

Get the code from the git repo (clone it), or as a zip:
```
node scripts/pack-apex-expert.mjs                  # -> dist/apex-expert-<date>.zip
node scripts/pack-apex-expert.mjs --dir <folder>   # sync a separate folder (the git repo); its .git is kept
```
The pack holds the sources, the scripts, the docs, Oracle's APEXlang skill
package and the templates of the two helper workflows
(`workflows/FS_Workspace_Tool__.json`, `workflows/Squad_APEXlang_Tools__.json`).
Left out: `.env`, `squad-install.config.json`, this n8n's ids
(`agents/apex-expert/apex-expert.local.json`), `node_modules/`, `workspace/`
(projects), `logs/` and the build outputs. The script stops if the copy
contains a `.env` value or the home folder path.

**Install** (on the other machine, Windows):

1. Requirements:
   - Node.js 18+
   - n8n 2.43.x (`npm install -g n8n@2.43.8`; the patch in step 4 is written for that version)
   - SQLcl
   - Microsoft Edge or Chrome (for UI_Test)
   - network access to the database and ORDS (VPN)
   - an Anthropic API key (or the company AI gateway)
2. Unzip into any folder, open a terminal there and run `npm install`.
3. Start n8n from that folder:
   `$env:NODE_FUNCTION_ALLOW_BUILTIN = 'fs,path,child_process'; $env:N8N_RUNNERS_TASK_TIMEOUT = '300'; n8n start`.
   Create the owner account, then **Settings → API → Create an API key**.
4. Run `node scripts/patch-n8n-tool-history.mjs`, then restart n8n
   (see **Local n8n patch** below).
5. In n8n, create an **Anthropic** credential named `Anthropic account 2`, or
   put your credential's name in `credentialName` in
   `agents/apex-expert/apex-expert.json`. In the same file, set `ordsBaseUrl`
   to your ORDS address.
6. Save a SQLcl connection with its password, for example
   `sql /nolog`, then `conn -save APEX_AI -savepwd <user>/<password>@//<host>:<port>/<service>`.
7. Copy `squad-install.config.example.json` to `squad-install.config.json`
   and set `connection`, `workspace`, `schema` and the paths. Use **absolute**
   paths for `sqlcl`, `workingFolder` and `allowedFolders`, because the helper
   workflows' Code nodes do not expand `~` yet.
8. Copy `.env.example` to `.env` and fill it in (see **Setup**).
9. Run `node scripts/squad-install.mjs --probe` (it reads the APEX and DB versions),
   then `node scripts/build-apex-expert.mjs`. On a fresh n8n the build:
   - imports and activates the helper workflows
   - finds the credential by its name
   - creates the tool workflow, the 6 agents with their skills and the chat workflow
   - writes the new ids into `agents/apex-expert/apex-expert.local.json` (git-ignored)
10. Open the chat URL the build prints and log in with the n8n account.

## Environment

Nothing in the sources hardcodes this machine. Paths, the node.exe and the
APEX target are written as `@@NAME@@` tokens, which
[scripts/lib/env.mjs](scripts/lib/env.mjs) fills in:

| Token | Default | Used in |
|---|---|---|
| `@@PROJECT_ROOT@@` | this checkout's folder | Code nodes, saved workflows |
| `@@USER_HOME@@` | your home folder | Code nodes (`~` in the config) |
| `@@NODE_EXE@@` | the node running the script | Code nodes |
| `@@APEX_CONNECTION@@` | `connection` in squad-install.config.json | prompts, skills, tool descriptions |
| `@@APEX_WORKSPACE@@` | `workspace` in squad-install.config.json | prompts, skills, chat page |
| `@@APEX_SCHEMA@@` | `schema`, else `workspace` | prompts, skills |
| `@@ORDS_BASE_URL@@` | `ordsBaseUrl` in agents/apex-expert/apex-expert.json | Page_Check description |
| `@@APEX_APP_URL@@` | `<ORDS>/r/<workspace, lower case>/` | prompts, skills |
| `@@APEX_VERSION@@` | last database probe, e.g. `26.1` | prompts, skills, chat page |
| `@@DB_PRODUCT@@` | last database probe, e.g. `Oracle AI Database 26ai Free` | prompts, skills |
| `@@DB_VERSION@@` | last database probe, e.g. `23.26` | sql-plsql skill |

Any of them can be overridden by a line with the same name in `.env`. The
probe values come from `workspace/.squad-install/_target.json`, which
`node scripts/squad-install.mjs --probe` writes after asking the database;
they are used only when it is about the configured connection. After
switching to another database, run the probe, then rebuild the agents.

The values are filled in when the agents are built, so n8n (and the agent
pages in the editor) always show the concrete values, never the tokens.

- **Render** (tokens → values) runs on everything sent to n8n: `npm run push`
  and `build-apex-expert.mjs`. Inside `jsCode` the value is
  JavaScript-escaped (`\` doubled). An unknown or empty token stops the run.
- **Templatize** (values → tokens) runs on everything saved from n8n
  (`npm run pull`, and the server responses the build script saves). It
  covers only the tokens whose value is unambiguous (paths, node.exe, ORDS
  URLs). Connection, workspace and schema are often the same name, so they
  stay literal in saved files and are tokens only in the sources.

## Usage

- **Pull** every (non-archived) workflow from the running instance into
  `workflows/*.json`:
  ```
  npm run pull
  ```
- **Push** local workflow file(s) back up to the instance:
  ```
  npm run push                                   # push everything in workflows/
  npm run push -- workflows/My_Flow__1.json       # push a single file
  ```
  A file with an existing `id` is updated in place; a file with no `id` is
  created as a new workflow, and the file is rewritten with the assigned `id`.

  **`npm run pull` overwrites local files with whatever the server currently
  has, including a file you edited locally but never pushed.** Push your
  local edits first, or pull only when you know the files are safe. Pulled
  files (`workflows/<name>__<id>.json`) belong to one n8n and are git-ignored.

## Layout

```
agents/apex-expert/   the APEX Expert: apex-expert.json (models, credential name, ORDS URL), prompts/, skills/,
                      src/agent-tools.js; written by the build (git-ignored): apex-expert.local.json (this
                      n8n's ids) and the saved agent configs *.agent.json
agents/src/           shared-helpers.js: the helper block in every tool Code node
apexlang-skill/       vendored copy of Oracle's official APEXlang skill package
docs/                 USING-THE-AGENT.md: the user guide
scripts/              build-apex-expert.mjs, apex-agent-db.mjs (database tools), squad-install.mjs (Install_App),
                      squad-examples.mjs (Example tool), pack-apex-expert.mjs, pull.js / push.js,
                      lib/ (env, n8n API, SQLcl, UI test)
workflows/            <name>__.json: templates of the two helper workflows (imported on a fresh n8n);
                      <name>__<id>.json: this n8n's workflows as saved by build / pull (git-ignored)
workspace/            one folder per project (8-char key); .apex-agent/sql-log/; .squad-install/ (app pins)
squad-install.config.json           database target + SQLcl (per machine, git-ignored)
squad-install.config.example.json   portable template of it
```

Credentials are never exported by n8n's API. `.env` is git-ignored; don't
commit your API key. Requires Node.js 18+.

## APEX Expert agent

A chat agent that specialises in Oracle APEX, made on n8n's Agents feature.
It answers APEX / SQL / PL/SQL questions, inspects the apps in the configured
workspace, changes them, and builds new apps with three saved sub-agents.
All agents run the models in `apex-expert.json` (`anthropic/claude-sonnet-5-5`)
on the credential named there. The ids of a machine's agents are in
`apex-expert.local.json`.

| Agent | Role |
|---|---|
| APEX Expert | Lead (editor version, with approvals) |
| APEX Expert (workflow) | Lead behind the chat workflow (no approvals) |
| APEX Analyst | Turns the requirement into the technical spec `spec.md` |
| APEX Developer | Builds / fixes the app (editor version, with approvals) |
| APEX Developer (workflow) | Same, for the chat workflow (no approvals) |
| APEX Tester | Tests against `spec.md`; PASS / FAIL with evidence |

| Workflow | Provides |
|---|---|
| APEX Expert Chat | The chat page that runs APEX Expert (workflow) |
| APEX_Agent_Tools | New_Project, SQL_Query, SQL_Execute, Export_App, Check_App, Install_App, Page_Check, UI_Test |
| FS_Workspace_Tool | FS_List, FS_Read, FS_Write, FS_Delete |
| Squad_APEXlang_Tools | Valid_Props, Example (the name is from an earlier project) |

For a new app or a larger change the lead runs: Analyst -> you confirm the
spec -> Developer -> Tester, with up to 3 Developer rounds.

**Tools.**
- SQL_Query runs one read-only SELECT in a read-only transaction (200 rows).
- SQL_Execute runs a script and commits it. It refuses SQLcl client commands
  (host, connect, exit, spool, `@file`, apex, ...), writes every script it runs
  to `workspace/.apex-agent/sql-log/`, and lists INVALID objects it created or
  changed apart from the schema's older INVALID objects (the `BUTR_*` objects
  of another app).
- Export_App exports an app as APEXlang into a project, pinned to that app id.
- They all run through `scripts/apex-agent-db.mjs` with SQLcl on the
  connection in `squad-install.config.json`.
- A project is a folder `workspace/<8-char key>/` with the app under `app/`.
  A project made by Export_App UPDATES that application when installed.

**SQLcl is the validator.** Check_App runs `apex validate` with the live
compiler (no import). The offline apexctl validator is not given to any agent.

**Page_Check** logs into the app through ORDS (`ordsBaseUrl` in
`agents/apex-expert/apex-expert.json`; the server has a self-signed
certificate). It uses `APEX_TEST_USER` / `APEX_TEST_PASSWORD` from `.env`, then
loads each page and reports HTTP status and APEX / ORA errors. It only checks
rendering; it does not click.

**UI_Test** (Tester and lead) uses an installed app like a user, in headless
Edge (or Chrome) through `playwright-core`, logged in as `APEX_TEST_USER`. The
agent passes a scenario as JSON steps: `go` (page number or alias), `fill`
(item name + value; select lists by label), `click` (visible label of a
button, link, tab or menu entry), `press`, `wait`, and the checks `see`,
`notSee`, `seeItem`, `seePage`. Steps act inside the topmost dialog: a modal
page's iframe, or a confirmation on top of it. One call is one scenario (at
most 40 steps, stopped at 85 s, watchdog at 105 s, since n8n stops a tool at
120 s). The result has one line per step (the page it led to, success and
error messages, JavaScript errors and HTTP 5xx), then the page it ended on with
its regions, buttons, links, items (with values and select options) and text,
so the agent can write the next scenario from what is really there. A failed
action stops the scenario and takes a screenshot (under
`<project>/test-results/` when a project is given); failed checks don't stop
it. Partial labels must match whole words and be unique. Test data the Tester
creates starts with `UITEST `. Code: [scripts/lib/ui-test.mjs](scripts/lib/ui-test.mjs),
run by `apex-agent-db.mjs --op ui_test`. Try it by hand:

```
echo [{"go": 2}, {"click": "Create Task"}] > steps.json
node scripts/apex-agent-db.mjs --op ui_test --app-id 100 --text-file steps.json
```

**Valid_Props and Example** give the real property names from the SQLcl
compiler's metadata and Oracle's compiler-backed examples under
`apexlang-skill/templates/` (backend: `scripts/squad-examples.mjs`). Both use
the compiler of the SQLcl in `squad-install.config.json`, so they describe
the compiler that installs.

**Skills** (n8n agent skills, loaded on demand with `load_skill`) come from
`agents/apex-expert/skills/<slug>/SKILL.md`. Their reference files come from
Oracle's APEXlang skill package (`skillSource`, default `apexlang-skill/`
v2026.08.01).
- `oracle-apexlang` is Oracle's skill, adapted: it maps Oracle's `apexctl`
  steps to these tools. Every agent has it.
- Topic skills: inspect-apps, sql-plsql, debug-runtime, apexlang-edit,
  apexlang-pages, apexlang-components, requirements-to-spec, test-app,
  build-and-test-loop.

**Build:** `node scripts/build-apex-expert.mjs` (`--tools`, `--agents`,
`--workflow`, `--publish`, `--check-skills`). It needs `N8N_EMAIL` /
`N8N_PASSWORD` in `.env`. After changing a prompt or skill, run `--agents`
and then `--workflow`.

### Chat workflow "APEX Expert Chat"

Chat Trigger (hosted chat, streaming) -> **Message an Agent** -> "APEX
Expert (workflow)". Open
**http://localhost:5678/webhook/a9e5c0de-4a11-4c7e-9d2b-7a3e5c0c4a11/chat** in a
browser where you are logged in to n8n, or use the Chat button in the
workflow editor. The trigger uses n8n's own login (`n8nUserAuth`); with basic
auth, the editor's chat panel failed with "Failed to receive response". The
chat's session keeps the conversation memory.

n8n cannot pause a workflow execution for a tool approval ("Suspend/resume is
not supported in workflow execution context"). So the workflow runs copies of
the lead and the Developer **without approvals**. Their SQL_Execute /
Install_App run at once, still only on the configured connection. Before a
destructive change (dropping or altering existing objects, deleting data,
overwriting an existing app) the lead asks in the chat.

The copies share the Analyst and Tester with the editor version. The build
script makes them from the same prompts and skills, replacing only the
approval rule. Workflow executions run the **published** agents, so
`--workflow` publishes Analyst, Tester and the two copies.

## Database install (Install_App)

Install_App runs `scripts/squad-install.mjs` on the project:

1. Every `.sql` file under `<app>/supporting-objects/` runs in file-name
   order (`01-tables.sql`, `02-views.sql`, ...). `deinstall*.sql` never runs.
   The scripts run again on every install, so they must be re-runnable
   (`create table if not exists`, `create or replace`, `merge` for seed rows).
2. `apex validate` and `apex import` run on the app in the same SQLcl
   session. A failed import leaves the previously installed version as it was.

The result separates three things the compiler prints in the same format:

- **Compile errors** (file, line, message): the app is not imported.
- **Compiler warnings**: not blocking. They are grouped by message with a few
  places each, including the valid values the compiler lists.
- **Import errors**: raised by the database after a clean compile, typically
  `ORA-40441`/`ORA-40587` (JSON) with nothing but a file and line. They mean
  a value has the wrong shape, most often a link written as `target: 11`
  instead of an object. The result explains this.

### Database target

`squad-install.config.json` decides where everything goes. Agents cannot
choose or change it.

```json
{
  "enabled": true,
  "connection": "APEX_AI",
  "workspace": "APEX_AI",
  "schema": "APEX_AI",
  "sqlcl": "~\\AppData\\Local\\sqlcl-current\\sqlcl\\bin\\sql.exe",
  "workingFolder": "workspace"
}
```

- `connection` is a saved SQLcl connection (`connmgr list`), `workspace` the
  APEX workspace that connection's schema is assigned to. New apps are
  scaffolded with this workspace name. `schema` (default: `workspace`) is
  only used in the agents' prompts. `workingFolder` is where New_Project
  creates projects.
- Paths may start with `~` (your home folder) or be relative to the project.
  The current file still uses absolute paths, which also work.
- `"enabled": false` switches the database tools off.
- A connection whose name contains `prod` is refused unless you add
  `"allowProduction": true`. The scripts are written by an agent, and the
  only real limit on what they can do is the privileges of that database
  user, so point this at a dedicated development schema.
- If the configured `sqlcl` is missing, a SQLcl from an installed VS Code SQL
  Developer extension is used (preferring one whose compiler matches the
  database's APEX version), and the result says so.
- Keys `maxAttempts`, `models`, `modelChoices` and `allowedFolders` belong to
  the retired Dev Squad and are not used by the APEX Expert.

**Application ids.** An `apex import` without an id creates a new
application every time. The installer remembers the id APEX assigned on a
project's first install in `workspace/.squad-install/<project>.json` and
imports with `-id` from then on. That file is outside every project folder,
so agents cannot edit it. Before overwriting, the installer checks that the
application still has the alias it had after the last install and answers
`BLOCKED` otherwise. Delete the project's file to install as a new
application.

By hand:

```
node scripts/squad-install.mjs --session <project key>   # install (skipped if nothing changed)
node scripts/squad-install.mjs --session <project key> --force
node scripts/squad-install.mjs --probe                   # connection, schema, DB + APEX version
```

Details that cost time to find:

- The live compiler rejects CRLF line endings, and the scaffolder writes
  CRLF on Windows. The installer converts a staged copy to LF.
- SQLcl exits with 0 even when a script or the import fails, and prints in
  the Windows display language. The installer forces English and parses the
  output.
- The Code nodes call the installer asynchronously. An install takes
  20-60 s, and a Code node that blocks that long cannot answer the task
  runner heartbeat (30 s).
- Set `N8N_RUNNERS_TASK_TIMEOUT` to 300 s (`setx N8N_RUNNERS_TASK_TIMEOUT 300`), because
  validation plus install can take longer than n8n's announced new default
  of 60 s. n8n also stops a workflow tool after 120 s, so every tool
  operation stays below that.
- `apex validate` passes things the import then rejects.

## Local n8n patch: agents saw their own tool calls as empty

`scripts/patch-n8n-tool-history.mjs` patches the installed n8n. **Re-run it
after every n8n upgrade, then restart n8n.** Use `--check` to see whether the
patch is in place and `--revert` to undo it; the original file is backed up
as `common.js.orig`.

It fixes n8n's AI Agent node (`@n8n/n8n-nodes-langchain/.../ToolsAgent/common.js`):
its `fixEmptyContentMessage()` turned the input of every earlier tool call
into `{}` in the history sent to Claude, so agents believed they had called
tools without arguments. The patch restores the real arguments from
`tool_calls`. The APEX Expert runs on n8n's Agents feature, not that node, so
it may not need the patch; it is kept because it is harmless and cheap to
re-apply.
