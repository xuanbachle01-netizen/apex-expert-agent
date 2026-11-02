---
name: APEXlang components
description: Use when writing or changing individual APEX components in APEXlang - buttons, page items (text, select list, date picker, switch, popup LOV, hidden), regions and their data sources, region interactions, media, template components, templates and template options, and app-wide global settings. Holds Oracle's component policies. For whole pages use apexlang-pages; for the edit/check roundtrip apexlang-edit.
---
## Overview
Write each APEX component the way Oracle's component policies and examples define it, so Check_App accepts it on the first try.

## Inputs
- The component type, its parent (page, region), its data (table/column, LOV) and behaviour.

## Steps
1. Load the reference for the component family below.
2. Read an Oracle example of the same component: Example("<family>") (e.g. "select-list", "date-picker", "buttons", "cards", "chart") and look up unfamiliar properties with Valid_Props(component, parent, group).
3. Write the component inside its page file following the example's nesting; give regions and buttons static ids.
4. Check_App.

## Rules
- Items are named P<page>_<COLUMN>; labels in title case; required columns get `required` in the item (value required), not only a validation.
- Buttons: position and hot/normal per Oracle's rules; database actions (insert/update/delete) on form buttons; conditions on the primary key item for Create vs Save/Delete.
- Region data sources: table/view with explicit column list, or SQL query with bind variables; never `select *` in a report.
- Templates and template options come from the Universal Theme (`@/name`); never define your own templates.

## Example
Status select list on a form: Example("select-list") -> item P3_STATUS, type select list, LOV `@task-status` (static LOV in shared-components/lovs.apx), source column STATUS of the form region, display null "- Select -" off because the column is NOT NULL.

## Gotchas
- Reference files (load_skill with this skill and filePath):
  - `references/README.md` -- index of Oracle's component policies (load first if unsure which applies)
  - `references/apex.buttons.md`, `references/apex.items.md`
  - `references/apex.region-contracts.md`, `references/apex.region-data-source.md`, `references/apex.region-interactions.md`, `references/apex.region-media.md`
  - `references/apex.templates.md` -- templates and template options
  - `references/apex.global.md` -- app-wide conventions (naming, global page, navigation)
