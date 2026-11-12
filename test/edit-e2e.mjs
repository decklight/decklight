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

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
// a picture on a slide, for its own menu and a caption
FIXTURES.picture = deckOf(`    <section>
      <h2>Throughput</h2>
      <img src="picture.png" alt="the queue" width="200">
      <aside class="notes">Notes.</aside>
    </section>`);
// three slides, for the file to change under the page (outside)
FIXTURES.outside = deckOf(`    <section>
      <h2>Alpha</h2>
      <aside class="notes">Notes.</aside>
    </section>
    <section>
      <h2>Beta</h2>
      <ul><li>one</li></ul>
      <aside class="notes">Notes.</aside>
    </section>
    <section>
      <h2>Gamma</h2>
      <aside class="notes">Notes.</aside>
    </section>`);
// a 4×4 PNG, for the picture a file chooser is handed
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGNgYGD4z4AKMFAAKX0B/9g5w2kAAAAASUVORK5CYII=', 'base64');

// ── the server, one per fixture ────────────────────────────────────────────
// the real path: on macOS the temp folder is /var/… and /private/var/…, and the
// server serves only what lives under its own working directory, compared as written
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'decklight-edit-e2e-')));
writeFileSync(path.join(dir, 'picture.png'), PNG);
const servers = [];
let nextPort = 8930;
async function serve(name, env = {}) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, FIXTURES[name]);
  const port = await nextFreePort(nextPort);
  nextPort = port + 1;
  const log = [];
  const child = spawn(process.execPath, [path.join(root, 'cli', 'edit.mjs'), `${name}.html`, '--port', String(port), '--no-git'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_NO_UPDATE_CHECK: '1', ...env } });
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
    await menuRow(page, /^Wire ▸$/);
    const heads = await page.locator('.decklight-ctxmenu .cm-head').allTextContents();
    check('diagram', 'Wire ▸ is one submenu: Route, Arrows and Line as headed groups', heads.join() === 'Route,Arrows,Line', heads);
    await menuRow(page, /Elbow$/); await wait(1200);
    check('diagram', 'Wire ▸ Elbow writes an elbow', /data-route="elbow"/.test(wire()), wire());
    // Line ▸ Dashed: the dashes inline in its style, and they survive the next re-route (SVG_DIAGRAMS)
    await page.keyboard.press('Escape'); await wait(200);
    const mid = await page.locator(`${ACTIVE} svg [data-from]`).evaluate((p) => {
      const q = p.getPointAtLength(p.getTotalLength() / 2); const m = p.getScreenCTM();
      return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
    });
    await page.mouse.click(mid.x, mid.y, { button: 'right' }); await wait(400);
    await menuRow(page, /^Wire ▸$/);
    await menuRow(page, /^Dashed$/); await wait(1200);
    check('diagram', 'Wire ▸ Line ▸ Dashed writes its dashes inline', /style="[^"]*stroke-dasharray: 6 4/.test(wire()), wire());
    await page.keyboard.press('Escape'); await wait(200);
    await page.mouse.click(mid.x, mid.y, { button: 'right' }); await wait(400);
    await menuRow(page, /^Wire ▸$/);
    await menuRow(page, /^Curved$/); await wait(1200);
    check('diagram', 'a dashed wire stays dashed when its route changes', /data-route="curve"/.test(wire()) && /stroke-dasharray: 6 4/.test(wire()), wire());
    // the whole diagram duplicated from its canvas by ⌘D: a second diagram, its node names its own
    await page.goto(diagram.url + '#/1/0'); await wait(1500);
    await page.keyboard.press('Escape'); await wait(200);
    const svgBox = await page.locator(`${ACTIVE} svg`).boundingBox();
    await page.mouse.click(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height - 12); await wait(300);
    const before = diagram.read();
    await page.keyboard.press(`${MOD}+d`); await wait(1500);
    const names = (diagram.read().match(/data-node="([^"]+)"/g) ?? []);
    check('diagram', '⌘D on the canvas: a second diagram after it, its names its own',
      (section(diagram.read(), 1).match(/<svg\b/g) ?? []).length === 2 && new Set(names).size === names.length && names.length === 4, names);
    check('diagram', 'shown in place, the copy selected', await page.locator(`${ACTIVE} > svg`).count() === 2
      && await page.locator(`${ACTIVE} > svg`).nth(1).evaluate((n) => n.classList.contains('dl-selected')));
    await page.keyboard.press('Escape'); await wait(200);
    await page.keyboard.press(`${MOD}+z`); await wait(1800);
    check('diagram', 'one undo takes the copy back', diagram.read() === before);
    await page.close();
  });

  // 7 · the element menu: the same short list on a paragraph as on anything,
  //     a table's rows behind one Table ▸; Duplicate and ⌘D one write each
  await scenario('menus', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/3');
    const labels = () => page.locator('.decklight-ctxmenu .cm-row').evaluateAll((rs) => rs.map((r) => r.firstChild?.textContent ?? ''));
    const box = await page.locator(`${ACTIVE} > ul`).boundingBox();
    await page.mouse.click(box.x + 6, box.y + 6, { button: 'right' }); await wait(400);
    const rows = (await labels()).filter((t) => t !== 'Writing tools…');
    check('menus', 'the top level on a list', JSON.stringify(rows) === JSON.stringify(['Inspect', 'Colors…', 'Type…', 'Copy style', 'Paste style', 'Build: fade-up ▸', 'Animate ▸', 'Move up', 'Move down', 'Duplicate', 'Remove', 'Edit content (HTML)', 'Open in your editor', 'Slide ▸']), rows);
    const original = text.read();
    await menuRow(page, /^Duplicate/); await wait(1500);
    const lists = section(text.read(), 1).match(/<ul data-build="fade-up">[\s\S]*?<\/ul>/g) ?? [];
    check('menus', 'Duplicate: the list copied right after itself', lists.length === 2 && lists[0] === lists[1]
      && /<\/ul>\n {6}<ul data-build="fade-up">/.test(section(text.read(), 1)), section(text.read(), 1).slice(0, 400));
    check('menus', 'one write', text.saves(/element duplicated/g) === 1);
    await page.keyboard.press(`${MOD}+z`); await wait(1800);
    check('menus', 'one undo takes it back', text.read() === original);
    // ⌘D on the selected title, shown at once, nothing reloaded
    await page.goto(text.url + '#/1/3'); await wait(1500);
    await page.keyboard.press('Escape'); await wait(200);
    await page.locator(`${ACTIVE} > h2`).click(); await wait(300);
    const marker = await page.evaluate(() => { window.__noReload = true; return true; });
    await page.keyboard.press(`${MOD}+d`); await wait(1500);
    check('menus', '⌘D on the title: two titles in the file and on the page, no reload',
      (section(text.read(), 1).match(/<h2>Why the queue<\/h2>/g) ?? []).length === 2
      && await page.locator(`${ACTIVE} > h2`).count() === 2 && marker && await page.evaluate(() => window.__noReload === true));
    await page.close();
  });

  // 8 · a picture's menu: one Picture ▸; a caption typed is ONE write, and Esc writes nothing
  await scenario('caption', async () => {
    const picture = await serve('picture');
    const page = await open(picture, '#/1/0');
    const original = picture.read();
    const img = page.locator(`${ACTIVE} > img`);
    const menuOn = async () => { const b = await img.boundingBox(); await page.mouse.click(b.x + 10, b.y + 10, { button: 'right' }); await wait(400); };
    await menuOn();
    const top = await page.locator('.decklight-ctxmenu .cm-row').evaluateAll((rs) => rs.map((r) => r.firstChild?.textContent ?? ''));
    check('caption', 'the picture\'s rows behind one Picture ▸, just above Slide ▸', top.at(-2) === 'Picture ▸' && !top.includes('Add caption'), top);
    await menuRow(page, /^Picture ▸$/);
    const sub = await page.locator('.decklight-ctxmenu .cm-row').allTextContents();
    check('caption', 'Picture ▸: Replace…, Add caption, Use as slide background, Reset size', sub.join('|') === '← back|Replace…|Add caption|Use as slide background|Reset size', sub);
    await menuRow(page, /^Add caption$/); await wait(400);
    check('caption', 'the caption is in edit at once, nothing written', await page.locator(`${ACTIVE} figure > figcaption[contenteditable]`).count() === 1 && picture.read() === original);
    await page.keyboard.press('Escape'); await wait(800);
    check('caption', 'Esc writes nothing and puts the picture back', picture.read() === original && await page.locator(`${ACTIVE} > img`).count() === 1);
    await menuOn();
    await menuRow(page, /^Picture ▸$/);
    await menuRow(page, /^Add caption$/); await wait(400);
    await page.keyboard.type('Queue depth');
    await page.keyboard.press('Enter'); await wait(1500);
    check('caption', 'one write: the figure and the words typed', /<figure>\n {8}<img src="picture.png" alt="the queue" width="200">\n {8}<figcaption>Queue depth<\/figcaption>\n {6}<\/figure>/.test(picture.read())
      && picture.saves(/picture changed/g) === 1, section(picture.read(), 1));
    await page.keyboard.press(`${MOD}+z`); await wait(1800);
    check('caption', 'one undo takes the caption back', picture.read() === original);
    await page.close();
  });

  // 9 · New slide offers the same kinds from every door: the palette, the overview's N
  await scenario('newslide', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/0');
    const kinds = () => page.locator('.decklight-ctxmenu .cm-list[aria-label="New slide"] .cm-row').allTextContents();
    await page.keyboard.press('/'); await wait(300);
    await page.keyboard.type('new slide'); await wait(200);
    await page.keyboard.press('Enter'); await wait(400);
    const listed = await kinds();
    check('newslide', 'the palette\'s New slide… opens the kinds, Title and bullets ready',
      listed[0] === 'Title and bullets' && listed.length === 5 && await page.locator('.decklight-ctxmenu .cm-row.cm-selected').textContent() === 'Title and bullets', listed);
    await page.keyboard.press('Enter'); await wait(1500);
    check('newslide', '⏎ adds Title and bullets after this slide', (text.read().match(/<section\b/g) ?? []).length === 3 && /<li>/.test(section(text.read(), 2)), section(text.read(), 2).slice(0, 200));
    await page.keyboard.press('Escape'); await wait(300);   // its title was in edit
    await page.keyboard.press('o'); await wait(500);
    await page.keyboard.press('n'); await wait(400);
    check('newslide', 'the overview\'s N opens the same kinds', (await kinds()).length === 5);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await wait(1500);
    check('newslide', 'a pick adds that kind, the overview still up', (text.read().match(/<section\b/g) ?? []).length === 4
      && await page.locator('.decklight-overview-grid').count() === 1 && await page.locator('.decklight-stage [contenteditable="true"]').count() === 0);
    await page.close();
  });

  // 10 · ⌘K while typing with no words selected: neither a link box nor the palette
  await scenario('linkchord', async () => {
    text.reset(); await wait(400);
    const page = await open(text, '#/1/0');
    await page.locator(`${ACTIVE} > h2`).dblclick(); await wait(400);
    await page.keyboard.press('End');
    await page.keyboard.press(`${MOD}+k`); await wait(400);
    const said = await page.locator('.decklight-toast').allTextContents();
    check('linkchord', 'no link box, no palette, and it says what to do', await page.locator('.dl-link').count() === 0
      && await page.locator('.decklight-palette').count() === 0 && said.some((t) => t === 'select words to link'), said);
    await page.keyboard.press('Escape'); await wait(300);
    await page.keyboard.press(`${MOD}+k`); await wait(300);
    check('linkchord', 'not typing, ⌘K is the palette, its hint saying both',
      /links the selected words/.test(await page.locator('.decklight-palette .pal-hint').textContent().catch(() => '')));
    await page.close();
  });

  // 11 · the file changed from outside (an editor, git): one slide's markup is
  //      swapped in place and the author taken to it; a slide put in above
  //      reloads, and a locked page lands on the same content, not the number
  await scenario('outside', async () => {
    const srv = await serve('outside');
    const page = await open(srv, '#/1/0');
    await page.evaluate(() => { window.__marker = 'kept'; });
    writeFileSync(path.join(dir, 'outside.html'), FIXTURES.outside.replace('<h2>Gamma</h2>', '<h2>Gamma, edited</h2>'));
    await page.waitForFunction((sel) => /Gamma, edited/.test(document.querySelector(sel)?.textContent ?? ''), ACTIVE, { timeout: 5000 }).catch(() => {});
    const title = await page.locator(`${ACTIVE} > h2`).textContent().catch(() => '');
    check('outside', 'one slide changed: no reload, the page kept', await page.evaluate(() => window.__marker) === 'kept');
    check('outside', 'swapped in place, and the author is on it', title === 'Gamma, edited', title);
    await wait(400);
    check('outside', 'the hash follows', /^#\/3\//.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
    check('outside', 'the server says which slide and what', /slide 3 changed: the title · in place/.test(srv.log()), srv.log().slice(-400));
    // a presenter: the deck locked, on Beta; a slide is put in above it
    await page.keyboard.press('Home'); await wait(300);
    await page.keyboard.press('ArrowRight'); await wait(400);
    await page.evaluate(() => fetch('/deck/edit/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked: true }) }));
    await wait(500);
    writeFileSync(path.join(dir, 'outside.html'), srv.read().replace('    <section>\n      <h2>Beta</h2>', '    <section>\n      <h2>Inserted</h2>\n    </section>\n    <section>\n      <h2>Beta</h2>'));
    await page.waitForFunction(() => !window.__marker, null, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(ACTIVE); await wait(800);
    const landed = await page.locator(`${ACTIVE} > h2`).textContent().catch(() => '');
    check('outside', 'a slide put in above reloads', await page.evaluate(() => window.__marker) === undefined);
    check('outside', 'and a locked page lands on the same content', landed === 'Beta' && /^#\/3\//.test(await page.evaluate(() => location.hash)), `${landed} ${await page.evaluate(() => location.hash)}`);
    check('outside', 'the server says a slide was added', /reload × \d+ — slide 2 added/.test(srv.log()), srv.log().slice(-400));
    await page.evaluate(() => fetch('/deck/edit/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked: false }) }));
    await page.close();
  });

  // 12 · Open in your editor: asked once which editor (a command of your own
  //      here: a script that writes down what it was given), then the element
  //      and the slide opened at their lines in the deck file
  await scenario('editor', async () => {
    if (process.platform === 'win32') return;   // the recorder is a shebang script
    const recorder = path.join(dir, 'record-editor.mjs');
    const said = path.join(dir, 'editor-args.json');
    writeFileSync(recorder, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(recorder, 0o755);
    const ed = await serve('text', { XDG_CONFIG_HOME: path.join(dir, 'config'), VISUAL: '', EDITOR: '' });
    ed.reset(); await wait(400);
    const page = await open(ed, '#/1/3');
    const asked = [];
    page.on('dialog', (d) => { asked.push(d.message()); d.accept(`"${recorder}" {file} {line} {column}`); });
    const recorded = async () => {
      for (let i = 0; i < 40 && !existsSync(said); i++) await wait(100);
      try { const args = JSON.parse(readFileSync(said, 'utf8')); rmSync(said); return args; } catch { return null; }
    };
    // the list, by the element menu (a right-click on a point is the list's)
    const li = await page.locator(`${ACTIVE} > ul > li`).nth(1).boundingBox();
    await page.mouse.click(li.x + li.width - 3, li.y + li.height / 2, { button: 'right' }); await wait(400);
    await menuRow(page, /^Open in your editor$/); await wait(600);
    const rows = await page.locator('.decklight-choice .narr-row-label').allTextContents();
    check('editor', 'first use asks which editor, a command of your own among them', rows.some((r) => r.startsWith('A command of your own')), rows);
    await page.locator('.decklight-choice .narr-row', { hasText: 'A command of your own' }).click(); await wait(1500);
    const lines = ed.read().split('\n');
    const line = (re) => lines.findIndex((l) => re.test(l)) + 1;
    let args = await recorded();
    check('editor', 'the template asked for once', asked.length === 1 && /\{file\}/.test(asked[0]), asked);
    const ulLine = line(/<ul data-build/);
    check('editor', 'the element opens at its own line and column, in the deck file',
      args?.[0] === path.join(dir, 'text.html') && args?.[1] === String(ulLine) && args?.[2] === String(lines[ulLine - 1].indexOf('<ul') + 1), [args, ulLine]);
    check('editor', 'the choice is remembered beside the voice settings',
      existsSync(path.join(dir, 'config', 'decklight', 'editor.json')));
    // the palette's row: the slide's <section>, no question this time
    await page.keyboard.press('Escape'); await wait(200);
    await page.keyboard.press('/'); await wait(300);
    await page.keyboard.type('open this slide in your editor'); await wait(200);
    await page.keyboard.press('Enter');
    args = await recorded();
    check('editor', 'the palette opens the slide at its <section>, without asking again',
      asked.length === 1 && args?.[1] === String(line(/<section>/)) && args?.[2] === String(lines[line(/<section>/) - 1].indexOf('<section') + 1), args);
    check('editor', 'nothing written to the deck', ed.read() === FIXTURES.text);
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
