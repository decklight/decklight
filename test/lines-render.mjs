#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * How a line walk (`data-lines`, SPEC CODE_AND_MATH) ends, as a browser draws
 * it (#1186). `data-lines-end="all"` lifts the dimming with no step of its own:
 * not while its last step is the click on screen, but at the next build of the
 * slide, as the slide leaves, in the overview and in a still. The printed page
 * (`?print`, and the pptx export's `?capture=print`) shows every stepped block
 * whole unless it says `data-lines-print="last"`; a video frame (`?capture`)
 * keeps a plain walk's last step as the room saw it.
 *
 * Read as computed opacity, the thing the audience sees, not as class names.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-lines-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const code = (id, attrs) => `<pre id="${id}" data-lines="1|2" ${attrs}><code class="language-sql">SELECT a
FROM t
WHERE b = 1;</code></pre>`;

const file = path.join(dir, 'deck.html');
writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}">
<style>.decklight .code-line { transition: none !important; }</style></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><h2>Then a point</h2>${code('then', 'data-lines-end="all"')}<p data-build>And what it means.</p></section>
<section><h2>Plain</h2>${code('plain', '')}</section>
<section><h2>Ends lit</h2>${code('lit', 'data-lines-end="all"')}</section>
<section><h2>Printed as the last step</h2>${code('last', 'data-lines-print="last"')}</section>
<section><h2>End</h2></section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'fade' });
// the faintest line of each block: below 1 is a block still dimmed
const dim = () => Object.fromEntries([...document.querySelectorAll('.decklight-stage pre[id]')].map((p) =>
  [p.id, Math.min(...[...p.querySelectorAll('.code-line')].map((l) => +getComputedStyle(l).opacity))]));
const out = { url: location.search + location.hash };
setTimeout(() => {
  out.at = dim();
  if (!location.search) {
    // live: the walk, step by step
    deck.goto(2, 2); out.thenLast = dim().then;
    deck.goto(2, 3); out.thenNext = dim().then;
    deck.goto(2, 2); out.thenBack = dim().then;
    deck.goto(3, 2); out.plainLast = dim().plain;
    deck.goto(4, 0); out.plainLeaving = dim().plain;
    deck.goto(4, 2); out.litLast = dim().lit;
    out.litLastLeavingClass = document.getElementById('lit').classList.contains('lines-last');
    deck.goto(5, 0); out.litLeaving = dim().lit;
    out.leavingClass = document.getElementById('lit').closest('section').classList.contains('leaving');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    const clone = [...document.querySelectorAll('.ov-clone pre')].find((p) => p.id === 'lit');
    out.overview = clone ? Math.min(...[...clone.querySelectorAll('.code-line')].map((l) => +getComputedStyle(l).opacity)) : null;
  }
  document.getElementById('test-sink').textContent = 'DECKLIGHT-LINES-RESULTS ' + JSON.stringify(out);
}, 300);
</script></body></html>`);

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(60)} ${detail}`);
};
const run = (query) => resultsFrom(
  dumpDom(`file://${file}${query}`, { fileAccess: true, budget: 4000, quietStderr: true, who: 'lines-render' }), 'LINES', query);
const DIM = (v) => typeof v === 'number' && v < 1;
const LIT = (v) => v === 1;

// ── live ────────────────────────────────────────────────────────────────────
{
  const r = run('');
  check('ends lit: its last step still dims while it is on screen', DIM(r.thenLast), `opacity ${r.thenLast}`);
  check('ends lit: the next build lifts it, with no step of its own', LIT(r.thenNext), `opacity ${r.thenNext}`);
  check('ends lit: stepping back onto its last step dims again', DIM(r.thenBack), `opacity ${r.thenBack}`);
  check('plain walk: its last step dims', DIM(r.plainLast), `opacity ${r.plainLast}`);
  check('plain walk: and leaves the slide dimmed, as before', DIM(r.plainLeaving), `opacity ${r.plainLeaving}`);
  check('ends lit, last step on the slide: dimmed', DIM(r.litLast) && r.litLastLeavingClass, `opacity ${r.litLast}`);
  check('ends lit: whole in the outgoing transition', r.leavingClass && LIT(r.litLeaving), `leaving=${r.leavingClass} opacity ${r.litLeaving}`);
  check('ends lit: whole in the overview', LIT(r.overview), `opacity ${r.overview}`);
}

// ── print: every stepped block whole, unless it asks for its last step ─────
{
  const r = run('?print');
  check('print: a walk that ends lit is whole', LIT(r.at.lit) && LIT(r.at.then), `lit ${r.at.lit} then ${r.at.then}`);
  check('print: a plain walk is whole too', LIT(r.at.plain), `opacity ${r.at.plain}`);
  check('print: data-lines-print="last" keeps the last step', DIM(r.at.last), `opacity ${r.at.last}`);
}

// ── stills ──────────────────────────────────────────────────────────────────
{
  const lit = run('?capture#/4/999');
  check('a still (?capture): a walk that ends lit is whole', LIT(lit.at.lit), `opacity ${lit.at.lit}`);
  const plain = run('?capture#/3/999');
  check('a still (?capture): a plain walk keeps its last step', DIM(plain.at.plain), `opacity ${plain.at.plain}`);
  const pptx = run('?capture=print#/3/999');
  check('the pptx picture (?capture=print): a plain walk is whole', LIT(pptx.at.plain), `opacity ${pptx.at.plain}`);
  const last = run('?capture=print#/5/999');
  check('the pptx picture: data-lines-print="last" keeps the last step', DIM(last.at.last), `opacity ${last.at.last}`);
}

if (bad) {
  console.error(`\nlines-render: ${bad} check(s) failed`);
  process.exit(1);
}
console.log('\nlines-render: all checks passed');
