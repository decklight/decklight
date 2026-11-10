#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Write mode against a REAL edit server, with real input, read back from the
 * deck FILE (PRESENTING_EDITING).
 *
 * Every other editing harness (engine-render's authoring group) runs the page
 * against a fake fetch: it proves what the page POSTED, and nothing about what
 * the server then did to the author's file. The bugs that lived in that gap
 * were real. A bullet saved through the list session turned the author's own
 * `<b>` into `<strong>`; Tab into a table cell typed after its placeholder
 * instead of over it; an Enter in a bullet straight after a link replaced the
 * words just linked. Each passed the fake-server harness, and each was found
 * by driving a real server and reading the file.
 *
 * So this harness starts `cli/edit.mjs` on a scratch copy of a fixture deck,
 * drives the page with Playwright's real keyboard and mouse (Control or ⌘ as
 * the platform has it), and after each gesture asserts on the FILE: what was
 * written, that nothing else changed, that one gesture is one write and one
 * undo takes it back.
 *
 * Playwright is an OPTIONAL dependency, as for cross-engine; the browser is the
 * system Chrome every other harness uses (tools/chrome.mjs), so nothing is
 * downloaded. A machine without Playwright skips by name, except under
 * EDIT_E2E_STRICT, which CI sets: a job that skipped silently would be a green
 * tick for nothing.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../tools/chrome.mjs';
import { nextFreePort } from '../cli/port-conflict.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STRICT = process.env.EDIT_E2E_STRICT === '1';

const skip = (why) => {
  if (STRICT) {
    console.error(`edit-e2e: ${why}`);
    console.error('  EDIT_E2E_STRICT is set, so this is a failure rather than a skip.');
    process.exit(1);
  }
  console.log(`edit-e2e: SKIP — ${why}`);
  process.exit(0);
};

if (!existsSync(path.join(root, 'dist', 'decklight.js'))) skip('dist/decklight.js is missing — npm run build');
let playwright;
try { playwright = await import('playwright'); } catch { skip('playwright is not installed — npm install --include=optional'); }
const chrome = findChrome();
if (!chrome) skip('no Chrome found — install one, or point $CHROME at it');

// ── the fixtures: decks as data, the shapes each scenario needs ─────────────
const deckOf = (slides) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <script type="application/json" data-decklight-config>
  { "decklight": "0.10.0", "theme": "aurora" }
  </script>
</head>
<body>
  <div class="decklight">
${slides}
  </div>
</body>
</html>
`;
const FIXTURES = {
  // bullets the author wrote with <b>, a list that builds, and a title
  text: deckOf(`    <section>
      <h2>Why the queue</h2>
      <ul data-build="fade-up">
        <li><b>Producers.</b> Never wait for consumers.</li>
        <li><b>Bursts.</b> Absorbed, not dropped.</li>
        <li><b>Retries.</b> Cheap.</li>
      </ul>
      <aside class="notes">Notes. [click] One. [click] Two. [click] Three.</aside>
    </section>
    <section>
      <h2>Empty</h2>
      <aside class="notes">Notes.</aside>
    </section>`),
  // two boxes, no wire yet
  diagram: deckOf(`    <section>
      <h2>Two boxes</h2>
      <svg viewBox="0 0 800 400" width="800" role="img" aria-label="two boxes" data-static-ok>
        <g>
          <rect x="60" y="60" width="200" height="90" rx="10" style="fill: var(--d-fill-1); stroke: var(--d-stroke)" stroke-width="2"/>
          <text x="160" y="112" text-anchor="middle" font-size="22" style="fill: var(--d-text)">Client</text>
        </g>
        <g>
          <rect x="520" y="60" width="200" height="90" rx="10" style="fill: var(--d-fill-2); stroke: var(--d-stroke)" stroke-width="2"/>
          <text x="620" y="112" text-anchor="middle" font-size="22" style="fill: var(--d-text)">Server</text>
        </g>
      </svg>
      <aside class="notes">Notes.</aside>
    </section>`),
};
// a 4×4 PNG, for the picture a file chooser is handed
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGNgYGD4z4AKMFAAKX0B/9g5w2kAAAAASUVORK5CYII=', 'base64');

// ── the server, one per fixture ────────────────────────────────────────────
// the real path: on macOS the temp folder is /var/… and /private/var/…, and the
// server serves only what lives under its own working directory, compared as written
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'decklight-edit-e2e-')));
writeFileSync(path.join(dir, 'picture.png'), PNG);
const servers = [];
let nextPort = 8930;
async function serve(name) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, FIXTURES[name]);
  const port = await nextFreePort(nextPort);
  nextPort = port + 1;
  const log = [];
  const child = spawn(process.execPath, [path.join(root, 'cli', 'edit.mjs'), `${name}.html`, '--port', String(port), '--no-git'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_NO_UPDATE_CHECK: '1' } });
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  servers.push(child);
  const url = `http://127.0.0.1:${port}/${name}.html`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/deck/ping`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`the edit server for ${name} never answered on ${port}:\n${log.join('').slice(-1500)}`);
  return {
    url,
    read: () => readFileSync(file, 'utf8'),
    reset: () => writeFileSync(file, FIXTURES[name]),
    log: () => log.join(''),
    saves: (re) => (log.join('').match(re) ?? []).length,
  };
}

// ── the checks ──────────────────────────────────────────────────────────────
let bad = 0;
const results = [];
const check = (scenario, name, ok, detail = '') => {
  if (!ok) bad++;
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${scenario.padEnd(10)} ${name}${ok ? '' : `\n       ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (html, n) => html.split(/<section\b/)[n] ?? '';
const ACTIVE = '.decklight-stage > section.active';

const browser = await playwright.chromium.launch({ executablePath: chrome, args: process.env.CI ? ['--no-sandbox'] : [] });
const errors = [];
async function open(srv, hash) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(srv.url + hash);
  await page.waitForSelector(`${ACTIVE}`);
  await wait(1200);
  await page.keyboard.press('Escape');   // a fresh browser opens on the editing tour
  await wait(250);
  return page;
}
const MOD = 'ControlOrMeta';
/** The key that turns a drag's snapping off: ⌘ on a Mac, Control elsewhere. */
const NO_SNAP = process.platform === 'darwin' ? 'Meta' : 'Control';
async function menuRow(page, label) {
  await page.locator('.decklight-ctxmenu .cm-row', { hasText: label }).first().click();
  await wait(350);
}
async function chooseFile(page, click) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null), click()]);
  if (chooser) await chooser.setFiles(path.join(dir, 'picture.png'));
  return !!chooser;
}

async function scenario(name, fn) {
  try { await fn(); } catch (e) { check(name, 'ran to the end', false, e.message.split('\n')[0]); }
}

try {
  const text = await serve('text');
  const diagram = await serve('diagram');

  // 1 · a bullet session: a new point by Enter, one moved by Control-Shift-↓,
  //     the author's <b> kept, one write, one undo
  await scenario('bullets', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/3');
    const original = text.read();
    const before = text.saves(/element content saved/g);
    await page.locator(`${ACTIVE} > ul > li`).first().dblclick(); await wait(500);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Queues decouple.');
    await page.keyboard.press('Control+Shift+ArrowDown'); await wait(250);
    check('bullets', 'nothing written while typing', text.read() === original);
    await page.keyboard.press(`${MOD}+Enter`); await wait(1500);
    const s = section(text.read(), 1);
    const points = [...s.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    check('bullets', 'the new point, moved one place down', points.length === 4 && points[2] === 'Queues decouple.', points);
    check('bullets', 'the author\'s <b> survives', points.filter((p) => p.startsWith('<b>')).length === 3, points);
    check('bullets', 'no browser furniture in the file', !/<br>|&nbsp;|<div|style=|contenteditable|dl-editing/.test(s));
    check('bullets', 'one write for the session', text.saves(/element content saved/g) - before === 1);
    await page.keyboard.press(`${MOD}+z`); await wait(1500);
    check('bullets', 'one undo takes it back', text.read() === original);
    await page.close();
  });

  // 2 · a link with ⌘K / Ctrl+K on words of the title
  await scenario('link', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/0');
    const h2 = page.locator(`${ACTIVE} > h2`);
    await h2.dblclick(); await wait(400);
    await page.evaluate((sel) => {
      const t = document.querySelector(sel).firstChild;
      const r = document.createRange(); r.setStart(t, 8); r.setEnd(t, 13);   // "queue"
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, `${ACTIVE} > h2`);
    await page.keyboard.press(`${MOD}+k`); await wait(300);
    await page.keyboard.type('example.com/queues');
    await page.keyboard.press('Enter'); await wait(200);
    await page.keyboard.press('Enter'); await wait(1500);
    const title = (section(text.read(), 1).match(/<h2>[\s\S]*?<\/h2>/) ?? [''])[0];
    check('link', 'the title carries the link, the rest as it was', title === '<h2>Why the <a href="https://example.com/queues">queue</a></h2>', title);
    await page.close();
  });

  // 3 · Add ▾: a table typed across cells with Tab, a chart's number typed in
  //     the Data tab, a picture resized by a corner
  await scenario('add', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/2/0');
    const add = async (label) => {
      await page.keyboard.press('Escape'); await wait(150);
      await page.click('.eb-add'); await wait(300);
      await menuRow(page, new RegExp(`^${label}$`)); await wait(700);
    };
    await add('Table');
    await page.keyboard.type('Name');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Score');
    await page.keyboard.press(`${MOD}+Enter`); await wait(1200);
    check('add', 'a table typed with Tab: each cell replaced', /<th>Name<\/th><th>Score<\/th>/.test(section(text.read(), 2)),
      (section(text.read(), 2).match(/<thead>[\s\S]*?<\/thead>/) ?? [''])[0]);
    await add('Chart');
    await page.keyboard.press('Escape'); await wait(200);
    await page.click(`${ACTIVE} .chart`); await wait(300);
    await page.keyboard.press('i'); await wait(500);
    await page.locator('.ins-tab', { hasText: /^Data$/ }).click(); await wait(600);
    const bars = () => page.locator(`${ACTIVE} .chart svg rect`).evaluateAll((rs) => rs.map((r) => r.getAttribute('height')).join());
    const was = await bars();
    await page.locator('.dg-num').first().fill('9'); await wait(300);
    check('add', 'the chart redraws as its number is typed', (await bars()) !== was);
    await page.keyboard.press('Tab'); await wait(1500);
    check('add', 'the chart\'s JSON has the number', /"data": \[9, 5, 2\]/.test(section(text.read(), 2)));
    await page.keyboard.press('i'); await wait(200);
    await page.keyboard.press('Escape'); await wait(150);
    await page.click('.eb-add'); await wait(300);
    const chose = await chooseFile(page, () => menuRow(page, /^Picture$/));
    check('add', 'Picture opens a file chooser', chose);
    await wait(2500);
    await page.goto(text.url + '#/2/0'); await wait(1500);
    await page.locator(`${ACTIVE} img`).first().click(); await wait(400);
    const se = await page.locator('.dl-pic-handle.dl-pic-se').boundingBox();
    if (se) {
      await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(se.x + i * 10, se.y + i * 10); await wait(20); }
      await page.mouse.up(); await wait(1500);
    }
    check('add', 'a resized picture has a width', /<img[^>]* width="\d+"/.test(section(text.read(), 2)), (section(text.read(), 2).match(/<img[^>]*>/) ?? ['no img'])[0]);
    await page.close();
  });

  // 4 · a background picture, then a bullet edited on that slide: the edit
  //     lands on the bullet clicked, not the element after it
  await scenario('background', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/0');
    const box = await page.locator(ACTIVE).boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' }); await wait(300);
    await menuRow(page, /^Slide ▸$/);
    const chose = await chooseFile(page, () => menuRow(page, /^Background picture/));
    await wait(1800);
    check('background', 'written on the slide', chose && /^[^>]*data-background-image="assets\/picture[^"]*"/.test(section(text.read(), 1)), section(text.read(), 1).slice(0, 120));
    check('background', 'drawn without a reload', await page.locator(`${ACTIVE} > .slide-bg`).count() === 1);
    await page.goto(text.url + '#/1/3'); await wait(1500);
    const before = section(text.read(), 1);
    await page.locator(`${ACTIVE} > ul > li`).nth(1).dblclick(); await wait(500);
    await page.keyboard.press('End'); await page.keyboard.type(' Always.');
    await page.keyboard.press(`${MOD}+Enter`); await wait(1500);
    const after = section(text.read(), 1);
    check('background', 'the second bullet, and nothing else', after === before.replace('Absorbed, not dropped.', 'Absorbed, not dropped. Always.'),
      (after.match(/<ul[\s\S]*?<\/ul>/) ?? [''])[0]);
    await page.close();
  });

  // 5 · a selected element moved by Control-Shift-↑
  await scenario('move', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/3');
    await page.click(`${ACTIVE} > ul`, { position: { x: 4, y: 4 } }); await wait(300);
    await page.keyboard.press('Control+Shift+ArrowUp'); await wait(1500);
    check('move', 'the list moved above the title', /^[^>]*>\s*<ul/.test(section(text.read(), 1)), section(text.read(), 1).slice(0, 120));
    await page.close();
  });

  // 6 · a connector drawn from a box's dot; the box moved, the wire following
  //     in the same write; one undo for both; Route ▸ Elbow
  await scenario('diagram', async () => {
    diagram.reset(); await wait(400);
    const page = await open(diagram, '#/1/0');
    const rects = page.locator(`${ACTIVE} svg rect`);
    const a = await rects.nth(0).boundingBox();
    const b = await rects.nth(1).boundingBox();
    await page.mouse.click(a.x + 24, a.y + 24); await wait(400);
    const dots = await page.locator('.dl-wire-dot').evaluateAll((ds) => ds.map((d) => { const r = d.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    check('diagram', 'a selected box shows four connection dots', dots.length === 4, dots.length);
    const from = dots.sort((p, q) => q.x - p.x)[0];
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(from.x + ((b.x + 24 - from.x) * i) / 12, from.y + ((b.y + 24 - from.y) * i) / 12); await wait(20); }
    await page.mouse.up(); await wait(1500);
    const wire = () => (diagram.read().match(/<(line|path|polyline)\b[^>]*data-from[^>]*>/) ?? [''])[0];
    check('diagram', 'both boxes named, a wire joining them', (diagram.read().match(/data-node="/g) ?? []).length === 2 && /data-to="/.test(wire()), wire());
    const joined = wire();
    const moves = diagram.saves(/diagram moved/g);
    await page.keyboard.press('Escape'); await wait(200);
    await page.mouse.click(b.x + 24, b.y + 24); await wait(300);
    await page.mouse.move(b.x + 24, b.y + 24); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(b.x + 24, b.y + 24 + i * 10); await wait(20); }
    await page.keyboard.down(NO_SNAP);   // the guides would snap the drop: the move is exact without them
    await page.mouse.up();
    await page.keyboard.up(NO_SNAP); await wait(1500);
    check('diagram', 'the wire followed the box', wire() !== joined && /data-from/.test(wire()), wire());
    check('diagram', 'one write for the box and its wire', diagram.saves(/diagram moved/g) - moves === 1);
    await page.keyboard.press('Escape'); await wait(200);
    await page.keyboard.press(`${MOD}+z`); await wait(1800);
    check('diagram', 'one undo puts both back', wire() === joined, wire());
    await page.goto(diagram.url + '#/1/0'); await wait(1500);
    await page.keyboard.press('Escape'); await wait(200);
    const w = await page.locator(`${ACTIVE} svg [data-from]`).boundingBox();
    await page.mouse.click(w.x + w.width / 2, w.y + w.height / 2, { button: 'right' }); await wait(400);
    await menuRow(page, /^Wire ▸$|^Route ▸$/);
    if (await page.locator('.decklight-ctxmenu .cm-row', { hasText: /^Route ▸$/ }).count()) await menuRow(page, /^Route ▸$/);
    await menuRow(page, /Elbow$/); await wait(1200);
    check('diagram', 'Route ▸ Elbow writes an elbow', /data-route="elbow"/.test(wire()), wire());
    await page.close();
  });
} finally {
  await browser.close().catch(() => {});
  for (const s of servers) s.kill();
  rmSync(dir, { recursive: true, force: true });
}

for (const e of errors) { bad++; results.push(`FAIL page error  ${e.split('\n')[0]}`); }
console.log(results.join('\n'));
console.log(`\nedit-e2e: ${bad ? `FAILED (${bad})` : 'PASS'}`);
process.exit(bad ? 1 : 0);
