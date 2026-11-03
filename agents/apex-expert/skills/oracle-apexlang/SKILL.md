---
name: Oracle APEXlang (Oracle APEX skill)
description: Oracle's official APEX skill (oracle/skills apex/apexlang), adapted to this n8n agent. Use for ANY work on APEXlang (.apx) code - generating, editing, reviewing, checking or debugging an APEX application, page or component - and whenever you must decide what APEXlang can express. Not needed for plain SQL/PL/SQL questions or for reading the APEX dictionary views.
---
## Overview
This is Oracle's APEXlang skill, ported to the tools of this n8n agent. Follow Oracle's rules (in the references) for how to generate and change APEXlang, but run every step with the tools below; Oracle's own commands (`node tools/apexctl.mjs ...`) are not available here.

## Inputs
- The target is fixed: the SQLcl connection, APEX workspace, APEX version and schema that DB_Target reports (or the "Target:" lines of your task). Oracle's skill tells you to ask the user "Offline or Live DB" and for `db_connection_name` / the workspace name: do NOT ask. It is always Live DB with these values.
- A project key (session) whose app/ folder holds the app: from New_Project (new app, Oracle's scaffold) or Export_App (existing app).

## Steps
1. Map Oracle's instructions to your tools:
   | Oracle's skill says | Do this here |
   |---|---|
   | `apexctl runtime validate` / live `apex validate` / "Check APEXlang code" | Check_App(session) -- SQLcl `apex validate` with the live compiler. THE gate. |
   | "Check and import APEXlang code" / `apex import` | Install_App(session) -- the user approves it in chat; that approval is the import choice. |
   | `query-valid-props.mjs`, compiler-truth audit, `component-attributes.json` | Valid_Props(component, parent, group) -- reads the SQLcl compiler's own metadata. |
   | `templates/**` canonical templates, page examples | Example(name) -- Oracle's example library (same templates). |
   | `new-app materialize`, `templates/base-app-structure/scaffold-example` | New_Project -- puts Oracle's scaffold under app/. |
   | `.apexlang/application-spec.md`, Application Composition Plan | the project's `spec.md` written by the Analyst (requirements-to-spec skill). |
   | `workspace probe`, `context-resolution.json`, `APEXLANG_OUTPUT_ROOT`, grammar contract / grammar audit commands, `apexlang format` | not available. Use FS_List/FS_Read for the files and Check_App + Valid_Props for grammar truth. |
   | `problems.json` + `validator-fix-recipes.json` | the error list Check_App returns; fix each message literally, then Check_App again. |
2. Before non-trivial generation, write a short Generation Plan (as Oracle requires): the files to create or change, the template/example each one follows, the ordered region/item/button inventory, sources and navigation targets.
3. Generate from an Oracle example of the same component family (Example) and look up every property you have not seen with Valid_Props. Never invent a property, `type:` value, slot or block shape.
4. Run Check_App. Fix all reported errors in one batch, run it again, until PASSED.
5. Only then Install_App (approval) when the task includes installing.

## Rules
- Precedence: live compiler (Check_App) > compiler metadata (Valid_Props) > Oracle examples/templates > Oracle's prose references > your memory. If Valid_Props or Check_App contradicts an example, the compiler is right and the example is defective for this case.
- Keep APEXlang block-structured: one top-level declaration per block, a blank line between sibling declarations, one property per line, nested blocks multiline, LF line endings.
- Never leave `{{...}}` placeholders or prompt pseudo-identifiers (SOURCE_TABLE, LOOKUP_ID, ...) in .apx files; bind every name to a real table/column (query it with SQL_Query).
- Translations: localise with text messages (`messages.apx`) and `&APP_TEXT$...` references, never by writing translated literals into component attributes.
- Treat exported apps as the source of truth for an existing application; do not assume an `applications/` folder exists -- the app is under app/ in the project.
- If the compiler cannot confirm a structural choice and no example covers it, stop and report Missing Inputs instead of guessing.

## Example
Task: "add a date picker DUE_DATE to the task form on page 3". Generation Plan: change app/pages/p00003-*.apx, add item P3_DUE_DATE after P3_TITLE following Example("date-picker"), source column DUE_DATE of the form region. Valid_Props("pageItem", "", "source") to confirm the source block. Write the file, Check_App -> PASSED, Install_App (approved), Page_Check pages 3.

## Gotchas
- Oracle's references were written for a coding assistant with Oracle's CLI; skip their orchestration steps (probe, context files, GUI choice prompts, multi-agent suite) and keep their APEXlang rules.
- The reference files are loaded with load_skill on this skill and a filePath:
  - `references/oracle/SKILL.md` -- Oracle's skill entry (precedence rules, stop conditions). Load it when a rule above is unclear.
  - `references/oracle/domains-README.md` -- Oracle's router of the domain guidance (page components, business logic, shared components, template components, debugging). Load it to find which topic skill or Example family covers a component.
  - `references/oracle/prompt-contracts.md` -- Oracle's instruction hierarchy, rule IDs and stop conditions. Load it before a full-app generation.
- More of the package lives in the topic skills: apexlang-edit (DSL, SQLcl roundtrip), apexlang-pages (page types), apexlang-components (buttons, items, regions, templates), requirements-to-spec, debug-runtime, sql-plsql.
