---
name: Edit APEXlang apps (SQLcl roundtrip)
description: Use when changing the .apx files of an APEX app - adding or changing pages, regions, items, buttons, processes, validations, dynamic actions, navigation or shared components of an existing or new app - and when fixing Check_App compile errors. Covers the export -> edit -> Check_App -> Install_App roundtrip, the APEXlang DSL rules and the SQLcl gates. Load oracle-apexlang as well; load apexlang-pages / apexlang-components for the details of a page or component type.
---
## Overview
Make a correct change to an APEXlang app and prove it with the live compiler: export (if existing), edit files, Check_App until PASSED, Install_App (approved), verify.

## Inputs
- A project key whose app/ holds the app: Export_App(session, app_id) into a New_Project with mode "empty" for an existing app; New_Project (scaffold) for a new one.
- What to change (the user's request or spec.md).

## Steps
1. List and read only what the change touches: FS_List, then FS_Read of application.apx (first 40 lines), the affected page files (app/pages/p000NN-<alias>.apx) and shared components (app/shared-components/lists.apx, lovs.apx, authorizations.apx, breadcrumbs.apx ...).
2. Find the Oracle pattern: Example(name) for the component family (e.g. "form-page", "interactive-report-page", "select-list", "dynamic-actions.close-dialog", "processes.form-initialization"); Valid_Props(component, parent, group) for any property you have not seen.
3. Write each changed file completely with FS_Write (LF endings, Oracle's indentation, one property per line).
4. Check_App(session). Read every error literally (file, line, valid values), fix them all in one batch, Check_App again. Repeat until PASSED.
5. Database objects the change needs: a re-runnable script under app/supporting-objects/ (sql-plsql skill).
6. Install_App(session) -- tell the user first; for an exported app it UPDATES the existing application in place. Read the result: INSTALLED with the application id, or SQL / compile / import errors to fix.
7. Verify: Page_Check(app_id, pages changed); inspect-apps queries for the new components.

## Rules
- DSL shape (from Oracle's DSL reference): a component is `<type> <id> (` ... `)`; a property group without colon `layout {` ... `}`; an object-valued property `target: {` ... `}` on separate lines. Links are always objects: `target: {` / `page: 11` / `}` -- never `target: 11`.
- `@id` references the id written after the component keyword, not its `name:`.
- Multi-line SQL/PL/SQL values: `source:` (or the property) then a fenced block on the following lines, as in Oracle's files.
- application.apx: keep Oracle's/the export's file; change only what the task needs. Never edit shared-components/themes/, .apex/ or shared-components/static-files/ (the Universal Theme subscription and compiler marker). Templates are `@/name` references.
- Page files are named p<5-digit page id>-<alias>.apx; a new page also needs a navigation entry (lists.apx) and a breadcrumb entry when the app has breadcrumbs.
- Form pages: region `type: form`, items with `source { formRegion: ... }`, one formInitialization and one formAutoRowProcessing process bound with `formRegion:`.
- Never "fix" an error by deleting the feature it belongs to; fix the syntax.

## Example
Add an interactive report page 4 "Projects" on table PROJECTS: Example("interactive-report-page") -> write app/pages/p00004-projects.apx with region `type: interactiveReport`, source table PROJECTS, columns from user_tab_columns; add a list entry to the navigation menu in shared-components/lists.apx with `target: {` `page: 4` `}`; Check_App -> 1 error "Invalid value for type" on line 12 with valid values listed -> fix -> PASSED; Install_App (approved) -> INSTALLED application 118; Page_Check pages 4 -> ok.

## Gotchas
- Install_App creates a NEW application on the first install of a scaffolded project; afterwards it updates the same id. A project from Export_App is pinned to the exported id from the start.
- Compiler warnings do not block; fix "Invalid ..." / "... ignored" warnings in files you touch.
- The SQLcl compiler can be built for a newer APEX release than the database (APEX @@APEX_VERSION@@): if Check_App passes but Install_App reports an import error, the database is right; fix what the import error names.
- Reference files (load_skill with this skill and filePath):
  - `references/apexlang-dsl-reference.md` -- Oracle's APEXlang grammar reference (load before writing a new kind of block).
  - `references/compiler-prop-map.md` -- property names as the compiler expects them.
  - `references/apexlang-execution-model.md` -- how APEXlang files map to an app.
  - `references/sqlcl.md`, `references/runtime-gates.md`, `references/01-direct-sqlcl-import.md`, `references/02-direct-sqlcl-validate-gate.md` -- Oracle's SQLcl validate/import gate rules (Check_App and Install_App implement them).
