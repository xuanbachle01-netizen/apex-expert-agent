#!/usr/bin/env node
// Copies the APEX Expert into a separate folder (a git repo) or a zip for another machine:
// the sources, scripts, docs, Oracle's APEXlang skill package and the templates of the two
// helper workflows (workflows/<name>__.json). Left out: .env, squad-install.config.json,
// apex-expert.local.json (this n8n's ids), node_modules, workspace/ (projects), logs/,
// archive/ and the saved *.agent.json / workflows/<name>__<id>.json outputs.
// The copy is scanned for .env values and this machine's home path; nothing is written
// (zip) or the problems are listed (folder) when one is found.
//
// Usage:
//   node scripts/pack-apex-expert.mjs                 # -> dist/apex-expert-<date>.zip
//   node scripts/pack-apex-expert.mjs --dir <folder>  # sync into <folder>; its .git is kept
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, env } from './lib/env.mjs';

const argv = process.argv.slice(2);
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null;
if (argv.includes('--dir') && !dirArg) throw new Error('--dir needs a folder');

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const name = 'apex-expert-' + stamp;
const DIST = path.join(ROOT, 'dist');
const OUT = dirArg ? path.resolve(dirArg) : path.join(DIST, name);
const ZIP = path.join(DIST, name + '.zip');
// The target is emptied (except .git): only a new or empty folder, or one this script filled before.
const MARKER = '.apex-expert-pack';
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
if (dirArg) {
  if (inside(ROOT, OUT) || inside(OUT, ROOT)) throw new Error('--dir must be a folder outside ' + ROOT + ' and not one of its parents');
  const existing = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((e) => e !== '.git') : [];
  if (existing.length && !existing.includes(MARKER)) throw new Error(OUT + ' is not empty and was not made by this script; choose a new folder');
}

const FILES = ['README.md', '.env.example', 'package.json', 'package-lock.json', 'squad-install.config.example.json'];
const DIRS = ['agents', 'scripts', 'docs', 'apexlang-skill'];
const skip = (rel) => /(^|[\\/])(\.tmp-validate|__pycache__)([\\/]|$)/.test(rel) || /\.(agent\.json|local\.json|pyc)$/.test(rel);

// The repo's .gitignore: everything a build or a run writes on a machine.
const GITIGNORE = `node_modules/
.env
*.log
logs/
dist/
squad-install.config.json
agents/apex-expert/apex-expert.local.json
agents/apex-expert/*.agent.json
apexlang-skill/.tmp-validate/
__pycache__/
# workflows/: only the id-less templates <name>__.json are shared; builds and pulls write <name>__<id>.json
workflows/*
!workflows/*__.json
# workspace/: the projects of this machine
workspace/*
!workspace/.gitkeep
`;

// Empty the target except .git, so files removed from the source disappear from the repo too.
fs.mkdirSync(OUT, { recursive: true });
for (const e of fs.readdirSync(OUT)) if (e !== '.git') fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
if (!dirArg) fs.rmSync(ZIP, { force: true });

for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true, filter: (src) => !skip(path.relative(ROOT, src)) });
fs.writeFileSync(path.join(OUT, '.gitignore'), GITIGNORE);
if (dirArg) fs.writeFileSync(path.join(OUT, MARKER), 'Synced from the working copy by scripts/pack-apex-expert.mjs --dir; this folder is emptied on every sync except .git.\n');
fs.mkdirSync(path.join(OUT, 'workflows'));
for (const f of fs.readdirSync(path.join(ROOT, 'workflows')).filter((x) => x.endsWith('__.json'))) {
  fs.copyFileSync(path.join(ROOT, 'workflows', f), path.join(OUT, 'workflows', f));
}
fs.mkdirSync(path.join(OUT, 'workspace'));
fs.writeFileSync(path.join(OUT, 'workspace', '.gitkeep'), '');

// Leak scan: every .env value of 6+ characters, and the home folder in plain and JSON-escaped form.
// Not the URL and the database target names: they are no secrets, and a name like APEX_AI also
// occurs in Oracle's APIs (apex_ai.set_tool_result).
const home = os.homedir();
const NOT_SCANNED = new Set(['N8N_BASE_URL', 'APEX_CONNECTION', 'APEX_WORKSPACE', 'APEX_SCHEMA']);
const needles = [...Object.entries(env).filter(([k, v]) => v && v.length >= 6 && !NOT_SCANNED.has(k)),
  ['home folder', home], ['home folder', home.replace(/\\/g, '\\\\')], ['home folder', home.replace(/\\/g, '/')]];
const hits = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === '.git') continue;
    if (e.isDirectory()) { scan(p); continue; }
    if (fs.statSync(p).size > 5e6) continue;
    const text = fs.readFileSync(p, 'utf8').toLowerCase();
    for (const [what, v] of needles) if (text.includes(v.toLowerCase())) hits.push(path.relative(OUT, p) + ': ' + what);
  }
})(OUT);
if (hits.length) {
  console.error('The copy in ' + OUT + ' contains values from .env or this machine -- do not share it:\n  ' + [...new Set(hits)].join('\n  '));
  process.exit(1);
}

if (dirArg) {
  console.log('synced', OUT);
} else {
  execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', DIST, name]);
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('packed', ZIP, Math.round(fs.statSync(ZIP).size / 1024) + ' KB');
}
