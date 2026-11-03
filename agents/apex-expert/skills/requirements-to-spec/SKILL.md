---
name: Requirements to APEX technical spec
description: Use when turning a functional requirement (a user's description of an app or a change) into the technical requirement spec.md for an Oracle APEX app - data model, pages, components, security, acceptance checks. This is the Analyst's main task. Not for writing APEXlang or SQL code.
---
## Overview
Produce `spec.md`: a complete, testable technical requirement for an APEX app (the APEX version DB_Target reports) that a developer can build in APEXlang without asking questions.

## Inputs
- The requirement text, the project key, and for a change the exported app under app/.
- Existing database objects (SQL_Query on user_tables, user_tab_columns, user_constraints) and existing apps (apex_applications, apex_application_pages).

## Steps
1. Extract from the requirement: actors/roles, entities and their attributes, actions per entity (list, search, create, edit, delete, approve ...), rules (statuses, required fields, uniqueness, who may do what), outputs (reports, charts, exports, emails).
2. Check the database: reuse existing tables and columns; note name clashes.
3. Design the data model: table per entity, identity PK `ID`, FKs with indexes, check constraints for status values, NOT NULL for required fields, audit columns only if asked, seed data for lookups.
4. Map functions to APEX building blocks (load apexlang-pages for the choice): list + search -> interactive report / faceted search; edit -> modal form; bulk edit -> interactive grid; KPIs -> dashboard with charts or cards; dates -> calendar. Each FK column -> select list on a LOV. Navigation menu entries for top-level pages.
5. Security: authentication (Oracle APEX Accounts by default), authorization schemes if roles differ, which pages/buttons each role sees.
6. Write acceptance checks: numbered AC-1..n, each verifiable by a SQL query, the APEX dictionary, or loading a page.
7. Write spec.md with FS_Write in the template below; list open questions and assumptions.

## Rules
- Use real names everywhere (tables, columns, page numbers, item names P<page>_<COLUMN>); no placeholders.
- Page 1 is the home page; 9999 login; 0 global page; number other pages in steps (2, 3 ... or 10, 20 ...), forms right after their reports.
- Only page and component types APEXlang has (check Example / Valid_Props when unsure).
- Keep scope to the requirement; propose extras only under "Optional".

## Example
spec.md template (fill every section):
```
# <App name> -- technical requirement
## Goal
## Users and Security
Authentication: ... | Roles and authorization schemes: ... | Access per page: ...
## Data Model
### <TABLE>  (new | existing)
| Column | Type | Null | Key/Constraint | Notes |
Seed data: ...
## Pages
### Page <n> -- <name> (<page type>, normal|modal dialog)
Purpose / Source / Regions / Items / Buttons / Processes / Validations / Dynamic actions / Navigation (from where, to where)
## Shared Components
LOVs, lists (navigation menu), breadcrumbs, authorization schemes, application items
## Acceptance Checks
AC-1 ... (how to verify: query / dictionary / page)
## Assumptions
## Open Questions
## Optional
```

## Gotchas
- A modal form must say how it closes and which report region refreshes.
- Status workflows need an allowed-values LOV and a check constraint with the same values.
- "Users can only see their own records" -> a WHERE clause on :APP_USER in the report source plus a check on the form; write both into the spec.
- Reference files (load_skill with this skill and filePath):
  - `references/application-spec.template.md` -- Oracle's own application-spec template (load before writing; your spec.md may follow it more closely for large apps).
  - `references/workflow-create-app-from-fr-and-model.md` -- Oracle's workflow from functional requirements to an app.
  - `references/apexlang-skeleton-prompt.md` -- what an app skeleton must contain.
  - `references/apex.schema-modeling.md` -- Oracle's data-model conventions.
  - `references/apex.page.md`, `references/apex.layout.md` -- page and layout rules.
