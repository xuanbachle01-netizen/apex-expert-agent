
// ---- View_Screenshot: load a screenshot (workflow APEX_Agent_Tools) ----
// n8n hands an agent only the JSON of a workflow tool, never an image. So this branch reads a
// UI_Test screenshot of a project and passes it, with the agent's question, to the Anthropic
// node "Look at Screenshot", which answers in text. Without an image the branch ends at
// "Has Image" with the error in "result".
const trig = $('When Executed by Another Workflow').first().json;
const fail = (text) => [{ json: { result: 'View_Screenshot: ' + text } }];
let dir;
try { dir = sessionDir(trig.session); } catch (e) { return fail('pass session, the project key the screenshot belongs to.'); }
const rel = String(trig.file_path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
if (!/\.png$/i.test(rel)) return fail('file_path must name a .png screenshot of the project as UI_Test lists it, e.g. test-results/2026-11-02T13-59-33/end.png.');
const file = pathMod.resolve(dir, rel);
if (!file.startsWith(pathMod.resolve(dir) + pathMod.sep) || !fsMod.existsSync(file)) return fail(rel + ' does not exist in project ' + CURRENT_SESSION + '. Use a path from the "Screenshots:" line of a UI_Test result (UI_Test with this session).');
const buf = fsMod.readFileSync(file);
// The API takes at most 5 MB per image (base64 grows it by a third).
if (buf.length > 3.5 * 1024 * 1024) return fail(rel + ' is ' + Math.round(buf.length / 1048576) + ' MB, too large to look at; take a "shot" of a shorter page state.');
const question = String(trig.question || '').trim();
const prompt = 'This is a screenshot of a page of an Oracle APEX application (Universal Theme), taken by an automated browser test (UI_Test). ' +
  'A tester who cannot see it asks you about it. Answer from what is visible only: quote the visible texts exactly, and say plainly when something cannot be seen or is cut off. ' +
  'Mention visible defects that matter to a user (overlapping or cut-off elements, empty regions, raw HTML or substitution strings such as &P1_X. or #COLUMN#, untranslated or garbled text, error messages), even if not asked. ' +
  'Normal Universal Theme behaviour is NOT a defect: success and error notifications float at the top right and may cover content until closed; a red corner marker on a field means "required"; the page behind an open modal dialog is dimmed; a red outline and red text under a field mark its validation error.\n\n' +
  'Question: ' + (question || 'Describe the page: title, regions, reports (columns and a few rows), form items with their values, buttons, and any messages.');
return [{
  json: { file: rel, prompt },
  binary: { data: { data: buf.toString('base64'), mimeType: 'image/png', fileName: pathMod.basename(file) } },
}];
