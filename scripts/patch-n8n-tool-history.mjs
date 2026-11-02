// Local patch for the installed n8n: AI agents lose their own tool-call
// arguments from the conversation history they send back to Claude.
//
// @langchain/anthropic stores each tool call in the AI message as a
// `tool_use` block with input "" plus a separate `input_json_delta` block
// holding the JSON. LangChain would rebuild the real input from
// message.tool_calls, but n8n's fixEmptyContentMessage() (used by every AI
// Agent node version) runs first and turns "" into {}, so Claude is shown
// `"input": {}` for every tool call it made earlier in the same agent run.
// The tools themselves receive the right arguments. The model then "sees"
// empty calls, rewrites the same files again and again, and starts sending
// genuinely empty calls itself.
//
// The patch restores the real arguments from message.tool_calls instead of {}.
// n8n updates overwrite it: re-run this script after every n8n upgrade and
// restart n8n.
//
// Usage:
//   node scripts/patch-n8n-tool-history.mjs            # apply (idempotent)
//   node scripts/patch-n8n-tool-history.mjs --check    # report status only
//   node scripts/patch-n8n-tool-history.mjs --revert   # restore the original
//   N8N_LANGCHAIN_DIR=<...>/@n8n/n8n-nodes-langchain node scripts/...  # custom install path

import fs from 'node:fs';
import path from 'node:path';

const LANGCHAIN_DIR = process.env.N8N_LANGCHAIN_DIR ||
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'n8n', 'node_modules', '@n8n', 'n8n-nodes-langchain');
const TARGET = path.join(LANGCHAIN_DIR, 'dist', 'nodes', 'agents', 'Agent', 'agents', 'ToolsAgent', 'common.js');
const BACKUP = TARGET + '.orig';
const MARKER = '[local patch: restore tool_use input from tool_calls]';

const ORIGINAL = `                            if (content.input === '') {
                                content.input = {};
                            }`;
const PATCHED = `                            if (content.input === '') {
                                // ${MARKER}
                                const call = content.type === 'tool_use' && Array.isArray(message.tool_calls)
                                    ? message.tool_calls.find((tc) => tc.id === content.id)
                                    : undefined;
                                content.input = call && call.args ? call.args : {};
                            }`;

const mode = process.argv.includes('--revert') ? 'revert' : process.argv.includes('--check') ? 'check' : 'apply';

if (!fs.existsSync(TARGET)) {
  console.error(`Not found: ${TARGET}\nSet N8N_LANGCHAIN_DIR to your @n8n/n8n-nodes-langchain folder.`);
  process.exit(1);
}
const src = fs.readFileSync(TARGET, 'utf8');
const isPatched = src.includes(MARKER);

if (mode === 'check') {
  console.log(`${isPatched ? 'PATCHED' : 'NOT patched'}: ${TARGET}`);
  process.exit(isPatched ? 0 : 2);
}

if (mode === 'revert') {
  if (!isPatched) { console.log('Not patched; nothing to revert.'); process.exit(0); }
  fs.writeFileSync(TARGET, src.replace(PATCHED, ORIGINAL), 'utf8');
  console.log(`Reverted ${TARGET}. Restart n8n.`);
  process.exit(0);
}

if (isPatched) { console.log(`Already patched: ${TARGET}`); process.exit(0); }
const count = src.split(ORIGINAL).length - 1;
if (count !== 1) {
  console.error(`Expected exactly 1 match of the original code, found ${count}. n8n's code has changed -- check whether the bug is fixed upstream before patching by hand.`);
  process.exit(1);
}
if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, src, 'utf8');
fs.writeFileSync(TARGET, src.replace(ORIGINAL, PATCHED), 'utf8');
console.log(`Patched ${TARGET}\nBackup: ${BACKUP}\nRestart n8n for the change to take effect.`);
