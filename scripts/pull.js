// Pulls all workflows from your local n8n instance and saves each as a
// pretty-printed JSON file in ./workflows, so they can be diffed and
// version-controlled with git. Machine-specific paths and URLs are saved as
// @@NAME@@ tokens (scripts/lib/env.mjs); push fills them in again.
//
// Usage: npm run pull

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { templatize } from './lib/env.mjs';

const HOST = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/+$/, '');
const API_KEY = process.env.N8N_API_KEY;

if (!API_KEY) {
  console.error('Missing N8N_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const WORKFLOWS_DIR = new URL('../workflows/', import.meta.url);

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

async function apiFetch(pathname, params = {}) {
  const url = new URL(`/api/v1${pathname}`, HOST);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { 'X-N8N-API-KEY': API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllWorkflows() {
  const all = [];
  let cursor;
  do {
    const page = await apiFetch('/workflows', { limit: 100, cursor });
    all.push(...(page.data ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

async function main() {
  await fs.mkdir(WORKFLOWS_DIR, { recursive: true });

  // Archived workflows are kept out of workflows/ (their last copies are in archive/workflows/).
  const all = await fetchAllWorkflows();
  const workflows = all.filter((wf) => !wf.isArchived);
  console.log(`Fetched ${workflows.length} workflow(s) from ${HOST} (${all.length - workflows.length} archived, skipped)`);

  const keepFiles = new Set();

  for (const wf of workflows) {
    const filename = `${sanitize(wf.name)}__${wf.id}.json`;
    keepFiles.add(filename);
    const filePath = new URL(filename, WORKFLOWS_DIR);
    await fs.writeFile(filePath, JSON.stringify(templatize(wf), null, 2) + '\n', 'utf8');
    console.log(`  wrote workflows/${filename}`);
  }

  // Warn about local files that no longer correspond to a workflow on the server
  const existing = await fs.readdir(WORKFLOWS_DIR).catch(() => []);
  for (const file of existing) {
    if (file.endsWith('.json') && !keepFiles.has(file)) {
      console.warn(`  note: workflows/${file} has no matching workflow on the server (deleted upstream?)`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
