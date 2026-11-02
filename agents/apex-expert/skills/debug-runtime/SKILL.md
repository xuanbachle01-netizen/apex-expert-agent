---
name: Debug APEX runtime errors
description: Use when an APEX page shows an error, renders wrong, a process or validation misbehaves, a page is slow, or Page_Check reports a FAIL - and when the user asks why something in a running app does not work. Finds the cause from APEX debug messages, the activity log, the page definition and the database. Not for compile errors of .apx files (Check_App lists those).
---
## Overview
Locate the cause of a runtime problem in an APEX application with evidence (debug log, activity log, page definition, object status) and name the exact fix.

## Inputs
- Application id and page number; the error text or symptom (from the user or Page_Check).
- Tools: SQL_Query, Page_Check, Export_App + FS_Read, inspect-apps for dictionary queries.

## Steps
1. Reproduce: Page_Check(app_id, pages) and read the error text it found. For an error that needs a click, a submit or a dialog, reproduce it with UI_Test (if you have it): the failing step shows the message, JavaScript and server errors.
2. Activity log: `select view_date, apex_user, page_id, elapsed_time, error_message, error_on_component_type, error_on_component_name from apex_workspace_activity_log where application_id = :id and error_message is not null order by view_date desc fetch first 20 rows only`.
3. Debug messages (when debug was on for that view): `select message_timestamp, message_level, message from apex_debug_messages where application_id = :id and page_id = :p order by message_timestamp desc fetch first 100 rows only`. Level 1 = errors, 4 = info.
4. Database side: INVALID objects (`select object_type, object_name from user_objects where status = 'INVALID'`) and `user_errors` for them; for a query error, run the region's SQL (from apex_application_page_regions.region_source) through SQL_Query with sample bind values.
5. Map the symptom to its owning component (region source, item source, process, validation, DA, authorization) with the dictionary views; read that component in the exported source when needed.
6. Report: cause (with the evidence line), the component to fix, the fix. Make the fix only if the user asked for it (apexlang-edit or sql-plsql skill).

## Rules
- Evidence first: quote the log line, the ORA- code or the query result. No speculative causes.
- Do not change database or app while diagnosing; diagnosing is read-only.
- An ORA-/PLS- error on a page usually comes from SQL or PL/SQL in the app or an INVALID package; an "Error processing request" without ORA usually from a validation or process condition.

## Example
Page_Check: page 3 FAIL "ORA-00904: STATUS: invalid identifier". Region "Task" source selects STATUS; user_tab_columns of TASKS has no STATUS -> the supporting-objects script never added it. Fix: guarded ALTER (sql-plsql) and reinstall.

## Gotchas
- apex_debug_messages only has rows for page views with debug enabled; if empty, rely on the activity log and the definitions.
- Errors inside a modal dialog appear on the dialog page, not the parent.
- Reference files (load_skill with this skill and filePath), Oracle's debugging guidance:
  - `references/failure-map.md` -- symptom to cause map (load first).
  - `references/owning-surfaces.md` -- which component owns which behaviour.
  - `references/fix-patterns.md` -- standard fixes.
  - `references/apex-debug-messages.md` -- reading debug output.
  - `references/checks-and-commands.md`, `references/example-scenarios.md`, `references/runtime-ui-verification.md` -- more checks and worked cases. Ignore their Oracle CLI commands; use your tools.
