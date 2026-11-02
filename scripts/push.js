// Pushes one or more workflow JSON files from ./workflows up to your local
// n8n instance. If the file's "id" already exists on the server it is
// updated in place; otherwise a new workflow is created and the file is
// rewritten with the id/metadata n8n assigns. @@NAME@@ tokens in the file are
// filled in from the environment (scripts/lib/env.mjs) before sending.
//
// Usage:
//   npm run push                          # push every file in ./workflows
//   npm run push -- workflows/My_Flow__1.json   # push just one file

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { render, templatize } from './lib/env.mjs';

const HOST = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/+$/, '');
const API_KEY = process.env.N8N_API_KEY;

if (!API_KEY) {
  console.error('Missing N8N_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const WORKFLOWS_DIR = new URL('../workflows/', import.meta.url);

async function apiFetch(pathname, { method = 'GET', body } = {}) {
  const url = new URL(`/api/v1${pathname}`, HOST);
  const res = await fetch(url, {
    method,
    headers: {
      'X-N8N-API-KEY': API_KEY,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

function toPayload(wf) {
  // Only fields the API accepts on create/update; strip read-only metadata.
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? {},
  };
}

async function pushOne(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const wf = JSON.parse(raw);
  const payload = render(toPayload(wf));

  let saved;
  if (wf.id) {
    try {
      saved = await apiFetch(`/workflows/${wf.id}`, { method: 'PUT', body: payload });
      console.log(`  updated "${wf.name}" (id ${wf.id})`);
    } catch (err) {
      console.warn(`  could not update id ${wf.id} (${err.message}); creating new workflow instead`);
      saved = await apiFetch('/workflows', { method: 'POST', body: payload });
      console.log(`  created "${wf.name}" (new id ${saved.id})`);
    }
  } else {
    saved = await apiFetch('/workflows', { method: 'POST', body: payload });
    console.log(`  created "${wf.name}" (id ${saved.id})`);
  }

  await fs.writeFile(filePath, JSON.stringify(templatize(saved), null, 2) + '\n', 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length
    ? args
    : (await fs.readdir(WORKFLOWS_DIR).catch(() => []))
        // <name>__.json are id-less templates for a fresh install (build-apex-expert.mjs imports them).
        .filter((f) => f.endsWith('.json') && !f.endsWith('__.json'))
        .map((f) => new URL(f, WORKFLOWS_DIR).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  if (!targets.length) {
    console.log('No workflow files found in ./workflows. Run "npm run pull" first, or add files manually.');
    return;
  }

  console.log(`Pushing ${targets.length} workflow file(s) to ${HOST}`);
  for (const target of targets) {
    await pushOne(target);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
