#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What `data-fit` (SPEC CODE_AND_MATH, #958) actually puts on screen.
 *
 * The fit is geometry, so it is checked as geometry: in a real browser, in the
 * shape that asked for it — a design-system slot that centres its content and
 * hides its overflow. Such a slot clips past its TOP as well as its bottom, and
 * neither shows up as a scrollHeight, which is the trap the fit must not fall
 * into. Each case is a page of its own, deep-linked, so the slide under test is
 * the active one; the last one is the print view, which `decklight pdf` reads.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-fit-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const lines = (n, w = 24) => Array.from({ length: n }, (_, i) => `SELECT ${'x'.repeat(w)} FROM t${i};`).join('\n');
const code = (n, attrs = 'data-fit', w) => `<pre ${attrs}><code class="language-sql">${lines(n, w)}</code></pre>`;

// The slot, as the confluent-developer/code template has it: flexible,
// centring, overflow hidden.
const SLOT = 'flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; overflow:hidden;';

/**
 * One page: the cover, then `body` as slide 2. `probe` runs at 300ms, once the
 * first fit has landed; `act` may change the slide in between, and the sample
 * at 700ms is after the watch has heard it and refitted.
 */
function page(name, body, { act = '', print = false } = {}) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section id="s">${body}</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
Decklight.init();
const sec = document.getElementById('s');
const inside = (el, box) => {
  const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
};
const sample = () => {
  const pres = [...sec.querySelectorAll('pre')];
  const slot = sec.querySelector('.slot') || sec;
  return {
    sizes: pres.map((p) => parseFloat(getComputedStyle(p).fontSize)),
    scale: sec.querySelector('[data-fit-scale]')?.getAttribute('data-fit-scale') ?? null,
    inline: pres.map((p) => p.style.fontSize),
    inSlot: pres.every((p) => inside(p, slot)),
    captionInSlot: sec.querySelector('.cap') ? inside(sec.querySelector('.cap'), slot) : null,
    scrolls: pres.some((p) => p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1),
    overflow: sec.hasAttribute('data-overflow'),
  };
};
let before = null;
setTimeout(() => { before = sample(); ${act} }, 300);
setTimeout(() => {
  document.getElementById('test-sink').textContent = 'DECKLIGHT-FIT-RESULTS ' + JSON.stringify({ before, after: sample() });
}, 700);
</script></body></html>`);
  return `file://${file}${print ? '?print' : '#/2/0'}`;
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
};
const run = (url, extraFlags = []) => resultsFrom(
  dumpDom(url, { fileAccess: true, budget: 5000, quietStderr: true, extraFlags, who: 'fit-render' }), 'FIT', url);

const slot = (inner) => `<h2>Query</h2><div class="slot" style="${SLOT}">${inner}</div>`;
const caption = '<p class="cap">A caption under the code, taking its share of the slot.</p>';

// ── short code keeps the deck's own size ───────────────────────────────────
{
  const own = run(page('own', slot(code(3, '') + caption)));
  const fit = run(page('short', slot(code(3) + caption)));
  check('short code: the size it has with no fit at all', fit.before.sizes[0] === own.before.sizes[0],
    `${fit.before.sizes[0]}px vs ${own.before.sizes[0]}px`);
  check('short code: no font-size of its own', fit.before.inline[0] === '', `inline="${fit.before.inline[0]}"`);
}

// ── long code shrinks, and stays inside a centring, clipping slot ──────────
{
  const r = run(page('long', slot(code(30) + caption)));
  check('long code: shrunk', Number(r.before.scale) < 1, `scale=${r.before.scale}`);
  // the slot centres: an overfull block would leave through its top too
  check('long code: inside the slot, top and bottom', r.before.inSlot, `inSlot=${r.before.inSlot}`);
  check('long code: the caption still inside', r.before.captionInSlot, `captionInSlot=${r.before.captionInSlot}`);
  check('long code: nothing scrolls inside the block', !r.before.scrolls, `scrolls=${r.before.scrolls}`);
  check('long code: the guardrail sees a clean slide', !r.before.overflow, `data-overflow=${r.before.overflow}`);
}

// ── an edit: the caption goes, the code grows into the room ────────────────
{
  const r = run(page('uncaption', slot(code(22) + caption), { act: "sec.querySelector('.cap').remove();" }));
  check('caption removed: the code grows', r.after.sizes[0] > r.before.sizes[0],
    `${r.before.sizes[0]}px → ${r.after.sizes[0]}px`);
  check('caption removed: and still fits', r.after.inSlot && !r.after.scrolls, `inSlot=${r.after.inSlot}`);
}

// ── an edit: ten more lines, the code shrinks ──────────────────────────────
{
  const r = run(page('more', slot(code(14) + caption), {
    act: "sec.querySelector('code').append(document.createTextNode('\\n' + Array.from({ length: 10 }, (_, i) => 'SELECT more FROM u' + i + ';').join('\\n')));",
  }));
  check('ten lines added: the code shrinks', r.after.sizes[0] < r.before.sizes[0],
    `${r.before.sizes[0]}px → ${r.after.sizes[0]}px`);
  check('ten lines added: nothing clipped', r.after.inSlot && !r.after.scrolls && !r.after.overflow,
    `inSlot=${r.after.inSlot} scrolls=${r.after.scrolls} overflow=${r.after.overflow}`);
}

// ── across: a long line is fitted, not scrolled ────────────────────────────
{
  const r = run(page('wide', slot(code(4, 'data-fit', 140))));
  check('a wide line: shrunk until it fits across', Number(r.before.scale) < 1 && !r.before.scrolls,
    `scale=${r.before.scale} scrolls=${r.before.scrolls}`);
}

// ── several blocks under one host share one size ───────────────────────────
{
  const r = run(page('shared', slot(`<div data-fit>${code(4, '')}${code(16, '')}</div>`)));
  check('one host, two blocks: one size', r.before.sizes[0] === r.before.sizes[1], `${r.before.sizes.join('px, ')}px`);
  check('one host, two blocks: both fit', r.before.inSlot && !r.before.scrolls, `inSlot=${r.before.inSlot}`);
}

// ── a pending build keeps its room ─────────────────────────────────────────
{
  const r = run(page('build', slot(code(26) + '<p class="cap" data-build="fade-up">Arrives on the next click.</p>')));
  check('a build still to come: its room is kept', r.before.captionInSlot, `captionInSlot=${r.before.captionInSlot}`);
}

// ── no data-fit: a hand-set size is left exactly alone ─────────────────────
{
  const r = run(page('hand', slot(code(30, 'style="font-size:0.5em"'))));
  check('no data-fit: the author\'s font-size stands', r.before.inline[0] === '0.5em' && r.before.scale === null,
    `inline="${r.before.inline[0]}" scale=${r.before.scale}`);
}

// ── print: the same fit, so `decklight pdf` sees what the browser shows ────
{
  // at the slide's own size: print's section padding is a percentage of the
  // window, so a smaller window is a different slot, fitted or not
  const size = ['--window-size=1280,720'];
  const screen = run(page('print', slot(code(30) + caption)), size);
  const print = run(page('print', slot(code(30) + caption), { print: true }), size);
  check('print: fitted too', Number(print.before.scale) < 1 && print.before.inSlot,
    `scale=${print.before.scale} inSlot=${print.before.inSlot}`);
  check('print: the size the browser shows', Math.abs(print.before.sizes[0] - screen.before.sizes[0]) < 0.5,
    `${print.before.sizes[0]}px vs ${screen.before.sizes[0]}px`);
}

if (bad) {
  console.error(`\nfit-render: ${bad} check(s) failed`);
  process.exit(1);
}
console.log('\nfit-render: all checks passed');
