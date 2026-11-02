# Using the APEX Expert

The APEX Expert is a chat agent for Oracle APEX. It works on one APEX
workspace and database schema, set when it was installed. It can:

- answer APEX, SQL and PL/SQL questions
- look into your existing apps and data
- make small changes itself
- build or rework whole apps with a team of three sub-agents
  (Analyst, Developer, Tester)

Installing it is described in the [README](../README.md).

## Where to chat

| | Chat page | n8n editor |
|---|---|---|
| Open | `http://localhost:5678/webhook/a9e5c0de-4a11-4c7e-9d2b-7a3e5c0c4a11/chat` (log in to n8n first) | n8n → **Agents** → **APEX Expert** → chat |
| Agent | APEX Expert (workflow) | APEX Expert |
| Database changes | Run at once; the agent asks first before anything destructive | **You approve every** SQL_Execute and Install_App call |
| Good for | Everyday use, longer builds | When you want to see and approve each change |

Both talk to the same database and the same projects. The conversation is
remembered for one chat session; a new chat starts with no memory. Any
earlier project is still there: give its project key.

Before you start, make sure **the database is reachable** (VPN on). If it
isn't, the agent reports SQLcl as UNAVAILABLE or `ORA-12170`.

## What you can ask

**Questions.** It answers from APEX knowledge and, where your system
matters, it looks things up first.
- "How do I make an interactive grid column read-only depending on the status?"
- "Which pages of app 100 use the table TASKS?"
- "Why does my process raise ORA-01403? It's on page 3 of app 100."

**Look at an app.** It queries the APEX dictionary views, or exports the app
and reads its source.
- "Describe app 100: pages, tables, authorization."
- "List all apps in the workspace with their page count."

**Small changes** (one page, a few items, a process, a fix). It does these
itself:
1. exports the app into a new project
2. edits the files
3. checks them with the APEX compiler
4. installs the app
5. loads the changed pages

- "In app 100, add a Priority select list (Low/Medium/High) to the task form on page 3."
- "Page 2 of app 100 shows ORA-00942 -- find and fix it."

**A new app, or a large change** (several pages, new tables). It runs the
build loop with its sub-agents; see below.
- "Build an app to track customer complaints: status, assignee, due date,
  a dashboard with open complaints per assignee."

**Test an app.**
- "Test app 100: create a task, edit it, delete it."
- "Check that every page of app 100 loads without errors."

Name the **application id** when you mean an existing app. Say what you
want to happen, not only what is wrong.

## How a build works

1. **Analyst.** Turns your requirement into a technical spec (`spec.md`):
   - data model
   - pages and components
   - security
   - numbered acceptance checks (AC-1, AC-2, ...)
2. **You confirm the spec.** The agent stops here every time and shows the
   summary, its assumptions and any open questions. Answer the questions or
   ask for changes; the Analyst revises the spec. Say "go" (or "go ahead with
   the assumptions") to continue. Nothing is built before you confirm.
3. **Developer.**
   - Writes the app (and its tables under `supporting-objects/`).
   - Repeats until the APEX compiler reports 0 errors.
   - Installs it.

   The first install creates a new application id.
4. **Tester.** Tests the installed app against every acceptance check:
   - database checks
   - page loads
   - real browser scenarios (logged in as the test user)

   It ends with **PASS** or **FAIL**, with evidence.
5. **Fix rounds.** After a FAIL, the agent sends the findings back to the
   Developer, up to 3 Developer rounds in all. After the third FAIL it stops
   and reports what works and what doesn't.
6. **Report.** You get:
   - the application id, name and URL
   - the pages built
   - the result per acceptance check
   - open issues
   - the project key

A small app takes about 10 minutes. The chat may be quiet for a few minutes
while the Developer works; that is normal.

## Projects

Every piece of work on app files happens in a **project**: a folder
`workspace/<8-character key>/` with the app as APEXlang (`.apx` files) under
`app/`.
- **New app.** The project starts from Oracle's base app; its first install
  creates the application.
- **Existing app.** The app is exported into an empty project. Installing
  that project **updates the existing application in place**, and the agent
  says so before it does.
- The key is in every report. To continue later, say e.g. "continue on
  project 3fa21c09".
- The project also holds `spec.md`, test scenarios (`tests/`) and test
  screenshots (`test-results/`).

## Testing

- **Page_Check** loads pages through ORDS, logged in as the test user, and
  reports HTTP status and APEX/ORA errors. It only shows that pages load.
- **UI_Test** uses the app like a person, in a headless browser:
  - opens pages, fills items, clicks buttons and links
  - works inside modal dialogs and confirmations
  - checks what is shown

  It reports each step, plus the messages, JavaScript errors and server
  errors, and saves screenshots under the project's `test-results/`.
- **Test data the Tester creates starts with `UITEST `.** It must clean that
  data up again and never touch data it did not create.

## Safety: what the agent will and won't do

- It works only on the configured connection, workspace and schema. It
  cannot switch to another database.
- The schema may be shared by several apps. It changes only what your
  request is about, and drops or truncates a table only when you ask for
  exactly that.
- Read-only queries run freely. Changes (SQL scripts, installs) need your
  approval in the editor. On the chat page they run at once, but the agent
  asks first before dropping or changing existing objects, deleting data or
  overwriting an existing app.
- Every SQL script it runs is logged under `workspace/.apex-agent/sql-log/`.
- An app counts as correct only when the live APEX compiler reports
  0 errors. No offline check counts.
- It never prints passwords.

## Tips

- One request per message works best. For big builds, give the users and
  roles, the data, and the pages you expect.
- Answer the spec questions concretely; the spec is what gets built and
  tested.
- If you reject an approval, the agent stops and asks what you want instead.
- Rename or delete an app in APEX yourself only if you are sure. The
  installer refuses to overwrite an app whose alias changed since its last
  install, and answers BLOCKED.

## When something goes wrong

| You see | Meaning / what to do |
|---|---|
| `SQLcl UNAVAILABLE`, `ORA-12170` | The database isn't reachable: switch the VPN on and ask again. |
| Page_Check / UI_Test: NOT CONFIGURED or login failed | `ordsBaseUrl` in `agents/apex-expert/apex-expert.json`, or `APEX_TEST_USER` / `APEX_TEST_PASSWORD` in `.env`. |
| Chat page: "Failed to receive response" | n8n's webhook URL is wrong; see the README (`N8N_BASE_URL`, not `N8N_HOST`, in `.env`). |
| Install BLOCKED | The application changed its alias since the last install; see "Application ids" in the README. |
| Tester FAIL after 3 rounds | Read the findings in the report. Ask for a specific fix, or change the spec. |
| The agent forgot the conversation | That happens in a new chat session. Give it the project key and the application id. |
