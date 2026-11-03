---
name: Generate sample data
description: Use when the user agreed to have sample (test) data generated for an APEX app's tables - in a build after they answered yes at the spec confirmation, or when they ask for test data for an existing app. Writes realistic, constraint-safe rows in dependency order with one SQL_Execute script, saves it plus a delete script in the project, and reports the row counts. Never without the user's yes.
---
## Overview
Fill an app's own tables with realistic rows so reports, filters, pagination, LOVs and charts can be tested and shown. It is optional: the user decides.

## Inputs
- The user's yes, and how much (default: about 25 rows per main table, 3-8 child rows per parent, lookup tables only if empty).
- Project key (session) and the tables the app owns (spec.md, or the app's region sources for an existing app).
- Tools: SQL_Query, SQL_Execute, FS_Write.

## Steps
1. Ask first, unless the user already answered: "Should I generate sample data (about 25 rows per table) so the app can be tested with realistic data?" No answer or no -> skip this skill. For an existing app, add that the rows go into the tables the live app uses.
2. Learn the model with SQL_Query (one query per call):
   - columns: `select table_name, column_name, data_type, data_length, nullable, identity_column, data_default from user_tab_columns where table_name in (...) order by table_name, column_id`
   - keys and checks: `select c.table_name, c.constraint_type, c.search_condition_vc, cc.column_name, r.table_name ref_table from user_constraints c join user_cons_columns cc on cc.constraint_name = c.constraint_name left join user_constraints r on r.constraint_name = c.r_constraint_name where c.table_name in (...) and c.constraint_type in ('P','U','R','C')`
   - triggers that fill columns: `select table_name, trigger_name from user_triggers where table_name in (...)`
   - existing rows: `select count(*) from <t>` per table; lookup values the LOVs use.
3. Order the tables: parents and lookup tables first, then children (foreign keys).
4. Write ONE script, re-runnable in the sense that it inserts only the sample rows:
   - INSERT ... SELECT with `connect by level <= n` or a PL/SQL loop; omit identity and trigger-filled columns.
   - Values: plausible names, titles and texts in the app's language; statuses and categories only from the check constraint or the lookup table; dates spread from about 60 days ago to 30 days ahead (some overdue, some done); numbers in realistic ranges; NULLs where the column is optional and a real user would leave it empty.
   - Foreign keys: pick existing parent keys (`select id from parent order by dbms_random.value fetch first 1 rows only` per row, or join on row numbers).
   - Mark every row so it can be found again: a free-text column (notes, description) ends with " [sample]"; a table without one gets its key range noted in the delete script.
   - End with `commit;`.
5. FS_Write the script to `test-data/sample-data.sql` and a matching `test-data/delete-sample-data.sql` (children first; only rows with the marker or the noted key range).
6. Run test-data/sample-data.sql's content with SQL_Execute (the user approves it in the editor chat). On errors: fix the script and run only the failed part again; never delete existing rows to make room.
7. Confirm with SQL_Query: row counts per table, and one check that the foreign keys resolve (a join count).
8. Report: rows per table, where the delete script is.

## Rules
- Never generate data without the user's yes. Never put sample data into app/supporting-objects/ (that runs on every Install_App and would ship with the app).
- Never update or delete rows that are not sample rows.
- No real personal data: invented names, example.com e-mail addresses, 555 phone numbers.
- At most about 500 rows in total unless the user asks for more (a test of pagination or performance).

## Example
Spec: PROJECTS (id identity, name, status check in OPEN/CLOSED, start_date) and TASKS (id, project_id FK, title, status, due_date, notes). User: "yes, sample data". Script: 6 projects (4 OPEN, 2 CLOSED), then 30 tasks over them with due dates from sysdate-45 to sysdate+30, notes ending " [sample]". Delete script: `delete from tasks where notes like '% [sample]'; delete from projects where id between 41 and 46;`. Report: PROJECTS 6, TASKS 30.

## Gotchas
- SQL_Execute runs with substitution off: `&` in a text is a plain character, and `&name` variables are never filled in.
- Unique constraints: build names with the row number (`'Project ' || level` is unique; random picks are not).
- A trigger that sets created_by from the APEX user gets NULL outside APEX: pass the column explicitly when it is NOT NULL.
- Dates: use date literals or sysdate arithmetic, never strings that depend on NLS settings.
