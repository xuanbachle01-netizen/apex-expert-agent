---
name: Test an APEX app
description: Use when verifying an installed APEX application against its spec.md acceptance checks - the Tester's main task - or when the user asks to test or verify an app. Runs the SQLcl compile gate, database and APEX dictionary checks, page rendering through ORDS and browser scenarios (UI_Test: forms, buttons, dialogs, validations), and returns PASS or FAIL with evidence. Never fixes.
---
## Overview
Turn each acceptance check into a concrete test, run it, and return per-check results, numbered findings with evidence, and a PASS/FAIL verdict.

## Inputs
- Project key (session) with spec.md and app/; application id.
- Tools: Check_App, SQL_Query, Page_Check, UI_Test, FS_Read, Example, Valid_Props.

## Steps
1. FS_Read spec.md; list the acceptance checks AC-1..n.
2. Gate (always first):
   - Check_App(session): PASSED with 0 errors, else FAIL finding with the compiler messages.
   - `select object_type, object_name from user_objects where status = 'INVALID' and object_name in (<the tables, views, packages spec.md names>)` -- any row -> FAIL finding (with `select line, text from user_errors where name = '<OBJ>'`). Older INVALID objects of other apps (e.g. BUTR_*) are not findings.
   - `select application_id, alias, pages from apex_applications where application_id = <id>` -- the app exists.
3. Per acceptance check, choose the cheapest conclusive test:
   - data model: user_tab_columns, user_constraints (`constraint_type`, `search_condition_vc`), user_indexes, row counts for seed data.
   - pages and components: apex_application_pages, _page_regions (source_type, table_name), _page_items (display_as, lov_named_lov), _page_buttons, _page_proc, _page_val, _page_da, apex_application_list_entries (navigation), apex_application_authorization (load inspect-apps for the column names).
   - behaviour in SQL/PL/SQL: run the region or LOV query through SQL_Query; call functions that do not write.
   - rendering: Page_Check(app_id) for all pages, and Page_Check(app_id, pages) for a page an AC is about.
   - what a user does: a UI_Test scenario (see below), then SQL_Query to confirm what it changed in the tables.
4. Record every result with its evidence (the row, the value, the message, the UI_Test step line). An AC you cannot test with these tools is NOT RUN with the reason.
5. Write the answer in the Tester's final format; last line PASS or FAIL.

## UI_Test scenarios
- First learn the page: a scenario of just `[{"go": 3}]` reports its regions, buttons and items (with their names, labels and select-list options). Write the real scenario from that, not from guesses.
- One scenario per acceptance check, starting with a "go". Keep it under 20 steps.
- Use the labels the page shows for clicks ("Create", "Save", "Delete", a menu entry), and item names (P4_NAME) for fills.
- Create flow: `[{"go": 3}, {"click": "Create"}, {"seePage": 4}, {"fill": "P4_NAME", "value": "UITEST task 1"}, {"fill": "P4_STATUS", "value": "Open"}, {"click": "Create"}, {"seePage": 3}, {"see": "UITEST task 1"}]`, then SQL_Query `select * from tasks where name = 'UITEST task 1'`.
- Validation: leave a required item empty, click Save, then `{"see": "<the expected message>"}`; a FAIL on that check is the finding.
- Edit / delete: open the UITEST row you created (click its link text), change or delete it, check the result. Never touch rows you did not create.
- Data you create starts with "UITEST ".

## Rules
- PASS only if the gate passed and every AC passed. NOT RUN checks are listed and make the verdict FAIL only if they cover a core function and no other check could confirm it.
- Findings name the place to fix: file app/pages/p000NN-*.apx, the component name, or the table/package.
- Do not report APEXlang syntax opinions when Check_App passed.
- Never ask the user questions; you report to the APEX Expert.

## Example
AC-4 "Page 3 status is a select list on LOV TASK_STATUS": `select display_as, lov_named_lov from apex_application_page_items where application_id = 131 and page_id = 3 and item_name = 'P3_STATUS'` -> "Select List", "TASK_STATUS" -> PASS. AC-6 "A task can be created from page 2": UI_Test 131 `[{"go": 2}, {"click": "Create"}, ...]` -> "FAIL 5 click \"Create\" -- database error shown: ORA-01400: cannot insert NULL into TASKS.CREATED_BY" -> FAIL finding 1: form process inserts without CREATED_BY; add a default or trigger (01-tables.sql).

## Gotchas
- Page_Check only proves pages render. Use UI_Test for anything that needs a click, a submit or a dialog.
- A UI_Test action that fails stops the scenario (the page is in an unknown state); failed "see"/"seeItem"/"seePage" checks do not. Read the "Ended on" part of the result before writing the next scenario.
- Steps act inside an open modal dialog until it closes; after the dialog's Create/Save the scenario is back on the calling page.
- Item and component names are upper case in the dictionary views and in UI_Test.
- If Page_Check or UI_Test reports LOGIN FAILED or NOT CONFIGURED, report those checks as NOT RUN with that message; do not guess.
- Load debug-runtime when a page fails, to name the cause in the finding.
