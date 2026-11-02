---
name: APEXlang page types
description: Use when designing or writing a whole APEX page in APEXlang - interactive report, interactive grid, classic report, form (normal or modal), master-detail, faceted search, smart filters, cards, dashboard, chart, calendar, map, login or blank page - or choosing which page type fits a requirement. Holds Oracle's page-type policies. Load apexlang-edit for the edit/check roundtrip.
---
## Overview
Choose the right page type for a requirement and build it the way Oracle's page policies and examples prescribe.

## Inputs
- The page's purpose, source table/view and columns (SQL_Query user_tab_columns), page number, mode (normal / modal dialog), navigation.

## Steps
1. Pick the page type: list + search -> interactive report (or faceted search / smart filters for many filter fields); bulk editing -> interactive grid; single-record edit -> form, usually a modal dialog opened from the report; overview KPIs -> dashboard with charts/cards; dates -> calendar; locations -> map.
2. Load the matching reference below and read Oracle's rules for that page type.
3. Read Oracle's full-page example: Example("<type>-page"), e.g. "interactive-report-page", "form-page", "dashboard-page", "classic-report-page".
4. Build the page from the example (apexlang-edit steps), with the real table and column names.
5. Wire it: report link column / Create button -> form page with the primary key item; the form closes the dialog and the report refreshes; navigation menu and breadcrumb entries.

## Rules
- One purpose per page; a report page and its form are two pages.
- Form pages: primary key item hidden, `formInitialization` + `formAutoRowProcessing` processes, Create/Save/Delete buttons with server-side conditions on the primary key, delete confirmation.
- Modal dialogs: page mode modal dialog; close with the close-dialog process/DA; the calling page refreshes its report on dialog close (Oracle's dialog pattern).
- Foreign key columns are select lists on a LOV; dates use the date picker.

## Example
"Users manage tasks": page 2 interactive report on TASKS (link column -> page 3 with P3_ID), Create button -> page 3; page 3 modal form on TASKS with P3_ID hidden, P3_TITLE text, P3_STATUS select list on LOV task-status, P3_DUE_DATE date picker; dialog close refreshes page 2.

## Gotchas
- Reference files (load_skill with this skill and filePath), Oracle's page policies -- load only the one for the page type at hand:
  - `references/apex.page.md` (general page rules, load first), `references/apex.layout.md` (grid layout, columns)
  - `references/apex.interactive-report.md`, `references/apex.interactive-grid-page.md`, `references/apex.classic-report.md`, `references/apex.report-column-rendering.md`
  - `references/apex.form.md`, `references/apex.faceted-search.md`, `references/apex.smart-filter-search.md`
  - `references/apex.dashboard.md`, `references/apex.chart-page.md`, `references/apex.calendar.md`, `references/apex.map-page.md`
  - `references/apex.login-page.md`, `references/apex.blank-page.md`
