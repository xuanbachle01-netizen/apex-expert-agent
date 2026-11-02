// n8n API helpers shared by the build scripts for n8n Agents
// (scripts/build-apex-expert.mjs):
// .env, the public API (N8N_API_KEY) and the editor REST API (cookie login,
// N8N_EMAIL / N8N_PASSWORD), which the Agents endpoints require.
import { ROOT, env } from './env.mjs';

export { ROOT, env };
export const HOST = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');

export async function api(method, url, body, headers = {}) {
  const res = await fetch(HOST + url, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ': ' + (typeof json === 'string' ? json.slice(0, 600) : JSON.stringify(json).slice(0, 1200)));
  return { json, res };
}
export const pub = (method, url, body) => api(method, '/api/v1' + url, body, { 'X-N8N-API-KEY': env.N8N_API_KEY });

// Editor REST API session. `browserId` must stay the same for the whole session.
export function editorSession(browserId) {
  let cookie = '';
  const rest = async (method, url, body) => (await api(method, '/rest' + url, body, { cookie, 'browser-id': browserId })).json;
  async function login() {
    if (!env.N8N_EMAIL || !env.N8N_PASSWORD) throw new Error('Add N8N_EMAIL and N8N_PASSWORD (your n8n editor login) to .env');
    const res = await fetch(HOST + '/rest/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'browser-id': browserId },
      body: JSON.stringify({ emailOrLdapLoginId: env.N8N_EMAIL, password: env.N8N_PASSWORD }),
    });
    if (!res.ok) throw new Error('login failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
    cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  }
  async function personalProjectId() {
    const p = await rest('GET', '/projects/personal');
    return (p.data || p).id;
  }
  return { rest, login, personalProjectId, loggedIn: () => Boolean(cookie) };
}

// One workflow tool entry of an agent config: fixed values for everything but the `ai` fields.
export function wfTool(name, workflowId, workflowName, description, fixed, aiFields) {
  const inputs = {};
  for (const [k, v] of Object.entries(fixed)) inputs[k] = { mode: 'fixed', value: v };
  for (const k of aiFields) inputs[k] = { mode: 'ai' };
  return { type: 'workflow', workflowId, workflow: workflowName, name, description, inputs };
}
