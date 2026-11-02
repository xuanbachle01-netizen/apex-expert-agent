// Read-only access to the example library in Oracle's vendored APEXlang skill
// package (apexlang-skill/templates/): full page examples, region, item,
// button, dynamic action, process and shared-component templates. These are
// Oracle's own compiler-backed APEXlang, so the "APEXlang Dev Squad v2" agents
// read them instead of guessing syntax. Backend of the Example agent tool and
// of the examples that Load State puts into the Engineer's prompt.
//
// Usage:
//   node scripts/squad-examples.mjs catalog                 # what exists (for prompts)
//   node scripts/squad-examples.mjs get <name>              # one example, a family listing, or search hits
//   node scripts/squad-examples.mjs pick <state.json> [maxBytes]   # the page examples that fit a brief
//
// <name> is a full-page example (form-page), a file name without .md
// (dynamic-actions.close-dialog, chart.bar), a family (chart, select-list,
// dynamic-actions), a path below templates/, or any search word.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.join(fileURLToPath(new URL('..', import.meta.url)), 'apexlang-skill', 'templates');
const MAX_EXAMPLE_CHARS = 24000;
const posix = (p) => p.split(path.sep).join('/');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (/\.md$/i.test(e.name) && !/^(README|LEGACY)\.md$/i.test(e.name) && !/\._index\.md$/i.test(e.name)) {
      out.push({ rel: posix(path.relative(base, full)), name: e.name.replace(/\.md$/i, ''), bytes: fs.statSync(full).size });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Drop the YAML front matter; the rest is prose plus ```apexlang blocks.
function body(rel) {
  const text = fs.readFileSync(path.join(TEMPLATES, rel), 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return text.length > MAX_EXAMPLE_CHARS ? text.slice(0, MAX_EXAMPLE_CHARS) + '\n...[clipped at ' + MAX_EXAMPLE_CHARS + ' characters]' : text;
}

const pageExamples = () => fs.readdirSync(path.join(TEMPLATES, 'page-examples'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

function pageExample(name) {
  const dir = 'page-examples/' + name + '/' + name;
  const common = fs.existsSync(path.join(TEMPLATES, dir + '._common.md')) ? body(dir + '._common.md') + '\n\n' : '';
  return '# Oracle example: full page "' + name + '"\n' +
    'Copy its syntax (block nesting, property names, value shapes). {{...}} marks a value to fill in; ids, names and SQL are samples.\n\n' + common + body(dir + '.example.md');
}

function subdirs(family) {
  const dir = path.join(TEMPLATES, family);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort() : [];
}

function catalog() {
  const files = walk(TEMPLATES);
  const names = (prefix) => files.filter((f) => f.rel.startsWith(prefix) && !/\._/.test(f.name)).map((f) => f.name);
  return [
    "Oracle's APEXlang example library (Oracle's own compiler-backed code). Read an entry with the Example tool, e.g. Example(\"form-page\"), Example(\"dynamic-actions.close-dialog\"), Example(\"chart\").",
    '- Full pages: ' + pageExamples().join(', '),
    '- Region families: ' + subdirs('region-components').join(', '),
    '- Item families: ' + subdirs('items').join(', '),
    '- Buttons: ' + names('buttons/').join(', '),
    '- Dynamic actions: ' + names('business-logic/dynamic-actions/').join(', '),
    '- Processes: ' + names('business-logic/processes/').join(', '),
    '- Validations: ' + names('business-logic/validations/').join(', '),
    '- Computations: ' + names('business-logic/computations/').join(', '),
    '- Shared-component families: ' + subdirs('shared-components').join(', '),
    '- Page layout families: ' + subdirs('page-layout-templates').join(', '),
    'A family name lists its files and returns its shared contract; any other word searches the file names.',
  ].join('\n');
}

function listing(title, files) {
  return title + '\n' + files.map((f) => '- ' + f.name + ' (' + kb(f.bytes) + ')').join('\n') + '\nRead one with Example("<name>").';
}

function get(raw) {
  const q = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^(apexlang-skill\/)?templates\//, '').replace(/\.md$/i, '');
  if (!q) return catalog();
  const files = walk(TEMPLATES);
  const lower = q.toLowerCase();
  const page = pageExamples().find((p) => p.toLowerCase() === lower || p.toLowerCase() === lower + '-page' || p.toLowerCase() + '.example' === lower);
  if (page) return pageExample(page);
  const exact = files.filter((f) => f.rel.replace(/\.md$/i, '').toLowerCase() === lower || f.name.toLowerCase() === lower);
  if (exact.length === 1) return '# Oracle example: ' + exact[0].rel + '\n\n' + body(exact[0].rel);
  // a family folder, e.g. chart, select-list, dynamic-actions
  const inFamily = files.filter((f) => f.rel.toLowerCase().split('/').slice(0, -1).includes(lower));
  if (inFamily.length) {
    const common = inFamily.find((f) => /\._common$/.test(f.name) && f.name.split('.').length === 2 && f.bytes <= 8000);
    return listing('Family "' + q + '" -- ' + inFamily.length + ' file(s):', inFamily) + (common ? '\n\n# Shared contract: ' + common.rel + '\n\n' + body(common.rel) : '');
  }
  const hits = files.filter((f) => f.rel.toLowerCase().includes(lower));
  if (hits.length === 1) return '# Oracle example: ' + hits[0].rel + '\n\n' + body(hits[0].rel);
  if (hits.length) return listing('No example is named "' + q + '". ' + hits.length + ' file name(s) contain it' + (hits.length > 40 ? ' (first 40)' : '') + ':', hits.slice(0, 40));
  return 'No example matches "' + q + '".\n\n' + catalog();
}

// Full-page examples whose page type the brief mentions, most common first.
const PICK_RULES = [
  ['form-page', /\bforms?\b|modal|dialog|create\/edit|edit page/i],
  ['interactive-report-page', /interactive report|\bIR\b/i],
  ['dashboard-page', /dashboard|\bcards?\b|\bcharts?\b/i],
  ['classic-report-page', /classic report/i],
  ['interactive-grid', /interactive grid|\bIG\b/i],
  ['faceted-search', /faceted/i],
  ['calendar-page', /calendar/i],
  ['map-page', /\bmap\b/i],
];
const SEE_ALSO = [
  [/modal|dialog/i, ['dynamic-actions.close-dialog', 'dynamic-actions.cancel-dialog', 'dynamic-actions.refresh-region-after-dialog', 'form.dialog-buttons']],
  [/\bcharts?\b/i, ['chart (family)', 'chart.bar', 'chart.pie', 'chart.donut']],
  [/\bcards?\b/i, ['cards.standard']],
  [/filter|refresh/i, ['dynamic-actions.refresh-region-on-change']],
  [/select list|\blov\b|list of values/i, ['select-list (family)', 'lovs (family)']],
  [/validat/i, ['validations (family)']],
];

// Page and region types already used in the session's app, as words the rules below match.
// A follow-up brief ("fix the install errors") names no page types, but the files do.
const TYPE_WORDS = { interactiveReport: 'interactive report', form: 'form', chart: 'chart', cards: 'cards', classicReport: 'classic report', interactiveGrid: 'interactive grid', facetedSearch: 'faceted', calendar: 'calendar', map: 'map' };
function typesInWorkspace(sessionDir) {
  const words = new Set();
  const scan = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (depth < 5 && !e.name.startsWith('.')) scan(path.join(dir, e.name), depth + 1);
      } else if (/\.apx$/i.test(e.name)) {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        for (const m of text.matchAll(/^\s*type:\s*([A-Za-z]+)\s*$/gm)) if (TYPE_WORDS[m[1]]) words.add(TYPE_WORDS[m[1]]);
        if (/pageMode:\s*modalDialog/.test(text)) words.add('modal dialog');
      }
    }
  };
  try {
    scan(sessionDir, 0);
  } catch {
    // an unreadable workspace only means no extra hints
  }
  return [...words].join(', ');
}

function pick(stateFile, maxBytes) {
  let brief = '';
  try {
    brief = String(JSON.parse(fs.readFileSync(stateFile, 'utf8')).brief || '');
  } catch {
    return '';
  }
  brief += '\n' + typesInWorkspace(path.dirname(path.dirname(stateFile)));
  const out = [];
  let used = 0;
  for (const [name, re] of PICK_RULES) {
    if (!re.test(brief)) continue;
    const text = pageExample(name);
    if (used + text.length > maxBytes) continue;
    out.push(text);
    used += text.length;
  }
  const more = [...new Set(SEE_ALSO.filter(([re]) => re.test(brief)).flatMap(([, names]) => names))];
  if (more.length) out.push('Related examples for this brief (read with the Example tool before writing that part): ' + more.join(', '));
  return out.join('\n\n---\n\n');
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'catalog') process.stdout.write(catalog() + '\n');
else if (mode === 'get') process.stdout.write(get(a) + '\n');
else if (mode === 'pick') process.stdout.write(pick(a, Number(b) || 48000) + '\n');
else {
  process.stdout.write('Usage: node scripts/squad-examples.mjs catalog | get <name> | pick <state.json> [maxBytes]\n');
  process.exitCode = 1;
}
