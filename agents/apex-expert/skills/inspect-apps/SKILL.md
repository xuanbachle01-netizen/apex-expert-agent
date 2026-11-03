---
name: Inspect APEX apps
description: Use when the user asks about their existing APEX applications or workspace - which apps exist, what a page or app contains, which tables a page uses, where an item, process, dynamic action, LOV, list or authorization scheme is defined, who changed what - or when you must know an app's structure before changing or testing it. Answers come from the APEX dictionary views through SQL_Query, not from memory. Not for writing new APEXlang.
---
## Overview
Answer questions about existing APEX applications from the APEX dictionary views (read-only SQL_Query), and only export the source (Export_App) when the views are not enough.

## Inputs
- The workspace from DB_Target. The application id or alias (if the user gives a name, find the id first).
- Tools: SQL_Query; Export_App + FS_Read for the full APEXlang source.

## Steps
1. Find the app: `select application_id, alias, application_name, pages, authentication_scheme_type, last_updated_on from apex_applications where workspace = '<workspace>' order by application_id`.
2. Query only the views the question needs (all have APPLICATION_ID; page-level views also PAGE_ID):
   - pages: `apex_application_pages` (page_id, page_name, page_alias, page_mode, page_requires_authentication, authorization_scheme, page_group)
   - regions: `apex_application_page_regions` (region_name, source_type, display_sequence, static_id, query_type, table_name, region_source, parent_region_id)
   - items: `apex_application_page_items` (item_name, display_as, label, region, item_source_type, item_source, lov_named_lov, item_default)
   - buttons: `apex_application_page_buttons` (button_name, label, button_action, region, database_action)
   - processes: `apex_application_page_proc` (process_name, process_type, process_point, execution_sequence, process_source, when_button_pressed)
   - validations: `apex_application_page_val`; computations: `apex_application_page_comp`; branches: `apex_application_page_branches`
   - dynamic actions: `apex_application_page_da` (dynamic_action_name, when_event_name, when_selection_type, when_element) and `apex_application_page_da_acts` (action_name, execute_on_page_init, attribute_01)
   - report columns: `apex_application_page_ir_col` (interactive report), `apex_appl_page_ig_cols` (interactive grid), `apex_application_page_rpt_cols` (classic)
   - shared components: `apex_application_lovs`, `apex_application_lists` + `apex_application_list_entries`, `apex_application_authorization`, `apex_application_auth` (authentication schemes), `apex_application_build_options`, `apex_application_items`, `apex_application_processes`, `apex_application_static_files`
   - activity: `apex_workspace_activity_log` (application_id, page_id, apex_user, view_date, elapsed_time, error_message)
3. When a column name fails (ORA-00904), look it up: `select column_name, comments from apex_dictionary where apex_view_name = 'APEX_APPLICATION_PAGES' and column_id > 0 order by column_id`. Never guess twice.
4. For full detail (exact attributes, SQL of every region, layout), Export_App into a new empty project (New_Project with mode "empty") and FS_Read the page file app/pages/p<5-digit id>-<alias>.apx.
5. Answer with the facts found: names, ids, SQL, and where they are defined.

## Rules
- Always filter by `application_id` (and `page_id` where relevant); never select whole views of the workspace.
- Large CLOB columns (region_source, process_source): select them only for the rows you need; results are capped at 200 rows.
- Report what the dictionary says; if something is not there, say so instead of inferring it.

## Example
"What does page 2 of the Task Tracker do?" -> app id 118 from apex_applications; regions, items, buttons, processes and DAs of page 2 (one query each, or one UNION ALL query); answer: "Page 2 'Tasks' is an interactive report on TASKS (columns ...), a 'Create' button opening modal page 3, ...".

## Gotchas
- Application ids are workspace-wide numbers (110, 118, ...); aliases are upper case in the views but lower case in URLs.
- Page 0 is the global page; 9999 is usually the login page.
- `apex_application_pages.page_mode` is 'Normal' or 'Modal Dialog'.
- Text columns like `authorization_scheme` contain names, not ids.
