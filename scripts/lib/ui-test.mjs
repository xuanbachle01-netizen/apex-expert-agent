// Browser test of an APEX application for the APEX Expert's UI_Test tool
// (scripts/apex-agent-db.mjs --op ui_test). Runs one scenario of steps in a headless
// Edge (or Chrome) through playwright-core, logged in as the test user, and reports per
// step what happened plus what the page shows at the end, so the agent can write the
// next scenario. A scenario is one call: n8n stops a workflow tool after 120 s, and a
// browser cannot stay open between two tool calls.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ACTION_MS = 10000; // finding / clicking one element
const IDLE_MS = 15000; // a page load or APEX AJAX call settling
const SEE_MS = 5000; // waiting for expected text
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + ' ...' : s; };

export const STEPS_HELP = 'Steps: a JSON array, one action per step: ' +
  '{"go": <page number or alias>} | {"fill": "P10_NAME", "value": "text"} (text fields; select lists, radio groups and switches by label or value; popup LOVs by return value; dates as shown in the field) | ' +
  '{"click": "<visible label of a button, link, tab or menu entry>"} | {"press": "Enter"} | {"wait": <seconds, max 10>} | ' +
  '{"see": "text"} | {"notSee": "text"} | {"seeItem": "P10_NAME", "value": "x"} | {"seePage": <number or alias>} | {"shot": "<name>"} (a screenshot; View_Screenshot looks at it). ' +
  'Steps act inside an open modal dialog until it closes.';

const ACTIONS = ['go', 'fill', 'click', 'press', 'wait', 'see', 'notSee', 'seeItem', 'seePage', 'shot'];
// Steps that only look: they do not wait for the page, and a failed one does not stop the scenario.
const CHECKS = new Set(['see', 'notSee', 'seeItem', 'seePage', 'shot']);

// Steps from the tool input: a JSON array, or { "steps": [...] }. Returns { steps } or { problem }.
export function parseSteps(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { return { problem: 'steps is not valid JSON (' + e.message + '). ' + STEPS_HELP }; }
  if (v && !Array.isArray(v) && Array.isArray(v.steps)) v = v.steps;
  if (!Array.isArray(v) || !v.length) return { problem: 'steps must be a non-empty JSON array. ' + STEPS_HELP };
  if (v.length > 40) return { problem: v.length + ' steps; at most 40 per call (split the scenario).' };
  for (const [i, s] of v.entries()) {
    const keys = s && typeof s === 'object' ? Object.keys(s).filter((k) => ACTIONS.includes(k)) : [];
    if (keys.length !== 1) return { problem: 'step ' + (i + 1) + ' ' + JSON.stringify(s) + ' must have exactly one of: ' + ACTIONS.join(', ') + '. ' + STEPS_HELP };
    if ((keys[0] === 'fill' || keys[0] === 'seeItem') && s.value === undefined) return { problem: 'step ' + (i + 1) + ': "' + keys[0] + '" needs a "value".' };
  }
  return { steps: v };
}

const describeStep = (s) => {
  const k = ACTIONS.find((a) => a in s);
  return k + ' ' + JSON.stringify(s[k]) + (s.value !== undefined ? ' = ' + JSON.stringify(s.value) : '');
};

// The frame steps act in: that of the topmost visible jQuery UI dialog. An APEX modal page is an
// iframe in one; a confirmation ("Delete this task?") is a dialog in the page itself, on top of it.
// A click can start a navigation that destroys the document being looked at: wait and retry.
async function activeFrame(page) {
  for (let attempt = 0; ; attempt++) {
    try {
      const top = await page.evaluateHandle(() => {
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const dialogs = [...document.querySelectorAll('.ui-dialog')].filter(vis);
        let best = null;
        let bestZ = -Infinity;
        for (const d of dialogs) { const z = parseInt(getComputedStyle(d).zIndex, 10) || 0; if (z >= bestZ) { best = d; bestZ = z; } }
        return best ? best.querySelector('iframe') : null;
      });
      const iframe = top.asElement();
      const f = iframe ? await iframe.contentFrame() : null;
      return f || page.mainFrame();
    } catch (e) {
      if (attempt >= 3 || !/context was destroyed|navigat/i.test(e.message)) throw e;
      await page.waitForLoadState('load', { timeout: IDLE_MS }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

// Waits until loads and APEX AJAX calls are done, in the page and in an open dialog.
async function settle(page) {
  for (let round = 0; round < 2; round++) {
    await page.waitForTimeout(300);
    await page.waitForLoadState('load', { timeout: IDLE_MS }).catch(() => {});
    const frames = [page.mainFrame()];
    const f = await activeFrame(page);
    if (f !== page.mainFrame()) frames.push(f);
    for (const fr of frames) {
      await fr.waitForLoadState('load', { timeout: IDLE_MS }).catch(() => {});
      await fr.waitForFunction(() => !(window.jQuery && window.jQuery.active) && !document.querySelector('.u-Processing'), null, { timeout: IDLE_MS }).catch(() => {});
    }
  }
}

// What a frame shows: APEX page, messages, regions, buttons, items and text. Retried like activeFrame.
async function frameState(f) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFrame(f);
    } catch (e) {
      if (attempt >= 3 || !/context was destroyed|navigat/i.test(e.message)) throw e;
      await f.waitForLoadState('load', { timeout: IDLE_MS }).catch(() => {});
      await f.page().waitForTimeout(300);
    }
  }
}
const readFrame = (f) => f.evaluate(() => {
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const texts = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const env = (window.apex && window.apex.env) || {};
  // Page items only, not their _CONTAINER / _LABEL / _DISPLAY ... wrappers.
  const isItem = (id) => /^P\d+_[A-Z0-9_]+$/.test(id) && !/_(CONTAINER|LABEL|ERROR|ERROR_PLACEHOLDER|INLINE_HELP|DISPLAY|LEGEND|GROUP)$/.test(id) &&
    (!window.apex || !window.apex.items || id in window.apex.items);
  const items = [...document.querySelectorAll('[id]')].filter((el) => isItem(el.id) && vis(el.closest('.t-Form-fieldContainer') || el)).map((el) => {
    let kind = el.tagName.toLowerCase();
    if (kind === 'input') kind = el.type;
    let opts = '';
    if (el.tagName === 'SELECT') opts = ' [' + [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 8).join(' | ') + (el.options.length > 8 ? ' | ...' : '') + ']';
    const label = document.querySelector('label[for="' + el.id + '"]');
    let value = '';
    try { value = window.apex.item(el.id).getValue(); } catch (e) { /* not an APEX item */ }
    return el.id + ' (' + kind + (label ? ', "' + label.innerText.trim() + '"' : '') + (value !== '' && value != null ? ', = ' + JSON.stringify(Array.isArray(value) ? value.join(':') : value).slice(0, 60) : '') + ')' + opts;
  });
  const body = document.querySelector('#t_Body_content') || document.body;
  return {
    pageId: env.APP_PAGE_ID != null ? String(env.APP_PAGE_ID) : '',
    session: env.APP_SESSION || '',
    title: document.title,
    errors: [...new Set(texts('#APEX_ERROR_MESSAGE .a-Notification-item, #APEX_ERROR_MESSAGE .htmldbStdErr, .t-Alert--danger .t-Alert-body, .apex-page-error, .t-Form-error, .a-Form-error'))],
    errorPage: !!document.querySelector('#apex_error_page, .t-ErrorPage'),
    success: texts('#APEX_SUCCESS_MESSAGE .t-Alert-title, #APEX_SUCCESS_MESSAGE .t-Alert-body'),
    ora: [...new Set((body.innerText.match(/\b(?:ORA|PLS)-\d{5}:[^\n]{0,160}/g) || []))],
    regions: [...new Set(texts('.t-Region-title, .t-Card-title, .t-IRR-region > h2'))],
    // An open confirmation / alert (a dialog in this document, not a modal page).
    asks: [...document.querySelectorAll('.ui-dialog')].filter((d) => vis(d) && !d.querySelector('iframe')).map((d) => (d.querySelector('.ui-dialog-content') || d).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
    askButtons: [...document.querySelectorAll('.ui-dialog')].filter((d) => vis(d) && !d.querySelector('iframe')).flatMap((d) => [...d.querySelectorAll('.ui-dialog-buttonpane button')].filter(vis).map((b) => b.innerText.trim())),
    buttons: [...new Set([...document.querySelectorAll('button, .t-Button, .a-Button, [role=button], input[type=submit], input[type=button]')].filter(vis).map((b) => (b.innerText || b.value || b.title || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean))],
    links: [...new Set([...document.querySelectorAll('a[href]:not(.t-Button):not(.a-Button):not([role=button])')].filter(vis).map((a) => a.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 60))].slice(0, 40),
    items,
    text: body.innerText,
  };
});

// A button / link / tab / menu entry by its visible label (or a CSS selector starting with # . or containing [).
// Returns { loc, label } or { problem }. An exact label wins; a partial match must be unique, so a
// short label like "OK" cannot click "Book meeting room".
async function findClickable(f, target) {
  if (/^[#.]|\[/.test(target)) return { loc: f.locator(target).first(), label: target };
  const visible = async (loc) => {
    const found = [];
    const n = await loc.count();
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) found.push(loc.nth(i));
    return found;
  };
  const kinds = (exact) => [...['button', 'link', 'tab', 'menuitem', 'option'].map((role) => f.getByRole(role, { name: target, exact })), f.getByText(target, { exact })];
  for (const loc of kinds(true)) {
    const found = await visible(loc);
    if (found.length) return { loc: found[0], label: target };
  }
  // Partial matches only on whole words: "Delete" matches "Delete Task", "OK" does not match "Book".
  const word = new RegExp('(^|\\W)' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\W)', 'i');
  const partial = [];
  for (const loc of kinds(false)) {
    for (const l of await visible(loc)) {
      const label = clip(await l.innerText().catch(() => ''), 60);
      if (word.test(label)) partial.push({ loc: l, label });
    }
  }
  const labels = [...new Set(partial.map((p) => p.label))];
  if (labels.length === 1) return partial[0];
  if (labels.length > 1) return { problem: 'several things match ' + JSON.stringify(target) + ': ' + labels.slice(0, 10).map((l) => JSON.stringify(l)).join(', ') + '; use the full label' };
  return {};
}

async function fillItem(f, name, value) {
  const how = await f.evaluate(([n, v]) => {
    const el = document.getElementById(n);
    if (!el) return 'missing';
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.text.trim() === v) || [...el.options].find((o) => o.value === v);
      if (!opt) return 'no option ' + JSON.stringify(v) + '; options: ' + [...el.options].map((o) => o.text.trim()).join(' | ');
      window.apex.item(n).setValue(opt.value);
      return 'ok';
    }
    if ((el.tagName === 'INPUT' && !/^(checkbox|radio|hidden)$/.test(el.type)) || el.tagName === 'TEXTAREA') return el.readOnly || el.disabled ? 'read-only' : 'type';
    // Radio groups, checkboxes, switches, date pickers, popup LOVs: APEX's own item API, which fires change events.
    const group = [...el.querySelectorAll('input[type=radio], input[type=checkbox]')];
    const byLabel = group.find((i) => { const l = el.querySelector('label[for="' + i.id + '"]'); return l && l.innerText.trim() === v; });
    window.apex.item(n).setValue(byLabel ? byLabel.value : v);
    return 'ok';
  }, [name, String(value)]);
  if (how === 'type') {
    const loc = f.locator('#' + name);
    await loc.fill(String(value), { timeout: ACTION_MS });
    await loc.blur(); // change-triggered dynamic actions fire on blur
    return 'ok';
  }
  return how;
}

// Visible text in the active frame or the page; ms = how long to wait for it (0 = look once;
// Playwright itself reads timeout 0 as "wait forever").
async function seeText(page, f, value, ms) {
  const until = Date.now() + ms;
  do {
    for (const fr of f === page.mainFrame() ? [f] : [f, page.mainFrame()]) {
      const loc = fr.getByText(String(value), { exact: false });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    if (Date.now() < until) await page.waitForTimeout(250);
  } while (Date.now() < until);
  return false;
}

async function launch() {
  const problems = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return { browser: await chromium.launch({ channel, headless: true }) };
    } catch (e) {
      problems.push(channel + ': ' + clip(e.message, 160));
    }
  }
  return { problem: 'no browser could be started (' + problems.join('; ') + ').' };
}

// appUrl = <ORDS>/r/<workspace>/<app alias>/; pages = [{ id, alias, name }] of the app;
// outDir = where screenshots go ('' = none); shotName(file) = how a screenshot is named in the report;
// deadline = Date.now() value to stop by; onLogin(apexSessionId) = called once logged in (debug), returns
// a problem text or ''. Results after the login carry the APEX session id the scenario ran in (apexSession).
export async function runUiTest({ appUrl, pages, steps, user, password, outDir, shotName = (f) => f, deadline, onLogin }) {
  const out = [];
  const shots = [];
  const { browser, problem } = await launch();
  if (problem) return { ok: null, status: 'unavailable', text: 'UI_Test: UNAVAILABLE -- ' + problem };
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_MS);
  // Browser problems since the last step: script errors and failed requests to the app's server.
  let problems = [];
  const host = new URL(appUrl).host;
  page.on('pageerror', (e) => problems.push('JavaScript error: ' + clip(e.message, 200)));
  // Ignored: favicons, and the self-signed certificate making the browser refuse APEX's service worker.
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|SSL certificate error/i.test(m.text())) problems.push('console error: ' + clip(m.text(), 200)); });
  page.on('response', (r) => { if (r.status() >= 500 && new URL(r.url()).host === host) problems.push('HTTP ' + r.status() + ' from ' + clip(r.url().replace(/\?.*/, ''), 120)); });
  page.on('dialog', (d) => { problems.push('browser ' + d.type() + ' "' + clip(d.message(), 120) + '" accepted'); d.accept().catch(() => {}); });
  const drain = () => { const p = [...new Set(problems)]; problems = []; return p; };
  let apexSession = '';
  const shot = async (name) => {
    if (!outDir) return '';
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, name + '.png');
    if (!(await page.screenshot({ path: file, fullPage: true }).then(() => true, () => false))) return '';
    shots.push(shotName(file));
    return shots[shots.length - 1];
  };
  const pageLabel = (id) => {
    const p = pages.find((x) => String(x.id) === String(id));
    return 'page ' + id + (p ? ' "' + p.name + '"' : '');
  };
  const where = async () => {
    const f = await activeFrame(page);
    const s = await frameState(f);
    return (f === page.mainFrame() ? '' : 'dialog ') + pageLabel(s.pageId);
  };

  try {
    // ---- login (Oracle APEX Accounts and other form logins)
    await page.goto(appUrl, { waitUntil: 'load', timeout: IDLE_MS });
    await settle(page);
    const pw = page.locator('input[type=password]');
    if (await pw.count()) {
      if (!user || !password) return { ok: null, status: 'unavailable', text: 'UI_Test: NOT CONFIGURED -- the app asks for a login; set APEX_TEST_USER and APEX_TEST_PASSWORD in .env.' };
      await page.locator('input[id$="_USERNAME"], input[name$="_USERNAME"], input[autocomplete=username]').first().fill(user);
      await pw.first().fill(password);
      await pw.first().press('Enter');
      await settle(page);
      if (await page.locator('input[type=password]').count()) {
        const s = await frameState(page.mainFrame());
        await shot('login-failed');
        return { ok: false, status: 'login_failed', text: 'UI_Test: LOGIN FAILED for user ' + user + (s.errors.length ? ': ' + s.errors.join(' | ') : ' (still on the login page)') + '. No steps were run.' + (shots.length ? '\nScreenshot: ' + shots[0] : '') };
      }
      out.push('Logged in as ' + user + ', now on ' + await where() + '.');
    } else {
      out.push('No login asked, now on ' + await where() + '.');
    }
    apexSession = (await frameState(page.mainFrame())).session;
    if (onLogin) {
      const problem = apexSession ? await onLogin(apexSession) : 'no APEX session id';
      if (problem) out.push('Debug: ' + problem + '; the scenario runs without it.');
    }
    drain();

    // ---- steps
    let failed = 0;
    let stoppedAt = 0;
    let lastShown = '[[],[]]';
    for (const [i, step] of steps.entries()) {
      const n = i + 1;
      if (Date.now() > deadline) { stoppedAt = n; out.push('STOP ' + n + ': time limit reached; run the remaining ' + (steps.length - i) + ' step(s) in another call (start them with a "go").'); break; }
      const action = ACTIONS.find((a) => a in step);
      let f = await activeFrame(page);
      let fail = '';
      let detail = '';
      try {
        if (action === 'go') {
          const p = pages.find((x) => String(x.id) === String(step.go) || (x.alias && x.alias.toLowerCase() === String(step.go).toLowerCase()));
          if (!p) throw new Error('the app has no page ' + JSON.stringify(step.go) + '. Its pages: ' + pages.map((x) => x.id + (x.alias ? ' (' + x.alias.toLowerCase() + ')' : '')).join(', '));
          const s = await frameState(page.mainFrame());
          await page.goto(appUrl + (p.alias ? p.alias.toLowerCase() : String(p.id)) + (s.session ? '?session=' + s.session : ''), { waitUntil: 'load', timeout: IDLE_MS });
        } else if (action === 'fill') {
          const r = await fillItem(f, String(step.fill), step.value);
          if (r === 'missing') {
            const s = await frameState(f);
            throw new Error('no item ' + step.fill + ' on ' + pageLabel(s.pageId) + '. Items here: ' + (s.items.join('; ') || 'none'));
          }
          if (r !== 'ok') throw new Error(step.fill + ': ' + r);
        } else if (action === 'click') {
          const found = await findClickable(f, String(step.click));
          if (found.problem) throw new Error(found.problem);
          if (!found.loc) {
            const s = await frameState(f);
            throw new Error('nothing visible labelled ' + JSON.stringify(step.click) + ' on ' + pageLabel(s.pageId) + '. ' +
              (s.asks.length ? 'A dialog is open asking "' + clip(s.asks.join(' / '), 120) + '"; its buttons: ' + s.askButtons.join(' | ') : 'Buttons here: ' + (s.buttons.join(' | ') || 'none')));
          }
          if (found.label !== String(step.click)) detail = '; clicked ' + JSON.stringify(found.label);
          await found.loc.click({ timeout: ACTION_MS });
        } else if (action === 'press') {
          await page.keyboard.press(String(step.press));
        } else if (action === 'wait') {
          await page.waitForTimeout(Math.min(10, Math.max(0, Number(step.wait) || 1)) * 1000);
        } else if (action === 'shot') {
          if (!outDir) throw new Error('screenshots need a project: pass session');
          const saved = await shot('step-' + n + '-' + String(step.shot).replace(/[^\w-]+/g, '-').slice(0, 40));
          if (!saved) throw new Error('the screenshot could not be taken');
          detail = ' -> ' + saved;
        }
        if (!CHECKS.has(action)) await settle(page);
        f = await activeFrame(page);

        if (action === 'see') {
          if (!(await seeText(page, f, step.see, SEE_MS))) fail = 'text not shown: ' + JSON.stringify(step.see);
        } else if (action === 'notSee') {
          if (await seeText(page, f, step.notSee, 0)) fail = 'text is shown: ' + JSON.stringify(step.notSee);
        } else if (action === 'seeItem') {
          const v = await f.evaluate((n) => { try { const x = window.apex.item(n).getValue(); return Array.isArray(x) ? x.join(':') : x; } catch (e) { return null; } }, String(step.seeItem));
          if (v === null) fail = 'no item ' + step.seeItem + ' here';
          else if (String(v) !== String(step.value)) fail = step.seeItem + ' is ' + JSON.stringify(v) + ', expected ' + JSON.stringify(String(step.value));
        } else if (action === 'seePage') {
          const s = await frameState(f);
          const p = pages.find((x) => String(x.id) === s.pageId);
          const want = String(step.seePage).toLowerCase();
          if (s.pageId !== want && !(p && p.alias && p.alias.toLowerCase() === want)) fail = 'on ' + pageLabel(s.pageId) + ', expected page ' + step.seePage;
        }
      } catch (e) {
        fail = clip(String(e.message || e).replace(/^\w*Error: /, '').split('\nCall log:')[0], 700);
      }

      // What the step left on screen: messages, database / page errors, browser problems.
      const s = await frameState(f).catch(() => null);
      const main = f === page.mainFrame() ? s : await frameState(page.mainFrame()).catch(() => null);
      const errs = [...new Set([...(s ? s.errors : []), ...(main && main !== s ? main.errors : [])])];
      const ora = [...new Set([...(s ? s.ora : []), ...(main && main !== s ? main.ora : [])])];
      const success = [...new Set([...(s ? s.success : []), ...(main && main !== s ? main.success : [])])];
      const browserProblems = drain();
      if (!fail && !CHECKS.has(action)) {
        if (ora.length) fail = 'database error shown: ' + ora.join(' | ');
        else if (s && s.errorPage) fail = 'APEX error page: ' + clip(s.title, 120);
        else if (browserProblems.some((p) => /^(JavaScript error|HTTP 5)/.test(p))) fail = browserProblems.filter((p) => /^(JavaScript error|HTTP 5)/.test(p)).join(' | ');
      }
      if (!CHECKS.has(action) && s) detail = ' -> ' + (f === page.mainFrame() ? '' : 'dialog ') + pageLabel(s.pageId) + detail;
      if (!CHECKS.has(action) && s && s.asks.length) detail += '; dialog asks: ' + clip(s.asks.join(' / '), 200) + ' (buttons: ' + s.askButtons.join(' | ') + ')';
      // Messages stay on screen: report them when they change, not on every later step.
      const shown = JSON.stringify([success, errs]);
      if (shown !== lastShown) {
        if (success.length) detail += '; success message: ' + clip(success.join(' / '), 200);
        if (errs.length) detail += '; messages: ' + clip(errs.join(' | '), 400);
        lastShown = shown;
      }
      if (browserProblems.length) detail += '; browser: ' + clip(browserProblems.join(' | '), 400);

      out.push((fail ? 'FAIL ' : 'ok   ') + n + ' ' + describeStep(step) + detail + (fail ? '\n      ' + fail : ''));
      if (fail) {
        failed++;
        await shot('step-' + n);
        // A failed action leaves the page in an unknown state: stop. Failed checks do not change it.
        if (!CHECKS.has(action)) { stoppedAt = n + 1; break; }
      }
    }
    if (stoppedAt && stoppedAt <= steps.length && !out[out.length - 1].startsWith('STOP')) out.push('     ' + (stoppedAt === steps.length ? 'step ' + stoppedAt : 'steps ' + stoppedAt + '-' + steps.length) + ' not run (a failed action leaves the page in an unknown state).');

    // ---- where the scenario ended, so the next scenario can be written against it
    const f = await activeFrame(page);
    const s = await frameState(f);
    await shot('end');
    out.push('', 'Ended on ' + (f === page.mainFrame() ? '' : 'dialog ') + pageLabel(s.pageId) + ' (title "' + clip(s.title, 80) + '").');
    if (s.regions.length) out.push('Regions: ' + clip(s.regions.join(' | '), 600));
    if (s.buttons.length) out.push('Buttons: ' + clip(s.buttons.join(' | '), 600));
    if (s.links.length) out.push('Links: ' + clip(s.links.join(' | '), 800));
    if (s.items.length) out.push('Items: ' + clip(s.items.join('; '), 1500));
    out.push('Text: ' + clip(s.text, 1500));
    if (shots.length) out.push('Screenshots: ' + shots.join(', '));
    const ran = Math.min(steps.length, stoppedAt ? stoppedAt - 1 : steps.length);
    return {
      apexSession,
      ok: failed === 0 && !stoppedAt, status: failed ? 'failed' : stoppedAt ? 'incomplete' : 'passed', failed,
      text: (failed ? failed + ' step(s) FAILED' : stoppedAt ? 'stopped after ' + ran + ' of ' + steps.length + ' steps' : 'all ' + steps.length + ' steps passed') + '.\n' + out.join('\n'),
    };
  } catch (e) {
    await shot('error');
    return { apexSession, ok: null, status: 'unavailable', text: 'UI_Test: UNAVAILABLE -- ' + clip(e.message, 500) + '\n' + out.join('\n') + (shots.length ? '\nScreenshot: ' + shots.join(', ') : '') };
  } finally {
    await browser.close().catch(() => {});
  }
}
