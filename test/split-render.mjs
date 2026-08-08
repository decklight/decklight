#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What `data-layout="split"` actually puts on screen.
 *
 * Both halves of #69 are geometry, and geometry is the thing unit tests cannot
 * see. A class can be on the right element while the box is in the wrong place.
 *
 *   shared top edge — two comparison columns of unequal height used to centre
 *     independently, so the shorter one's heading floated down the slide and
 *     the pair stopped reading as a pair. Authors were hand-rolling
 *     `display:flex; flex-direction:column; height:100%` per column to fix it.
 *
 *   the footer — a third block is a note about BOTH columns, and "first block
 *     left, everything else right" put it inside the right one, hanging under
 *     one side of a comparison it was about equally.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-split-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// deliberately lopsided: five bullets against two is what made the old
// centring visible, and equal columns would have hidden the bug
const COLUMNS = `
  <div><h3>Pros</h3><ul><li>fast</li><li>offline</li><li>ubiquitous</li><li>scriptable</li><li>battle-tested</li></ul></div>
  <div><h3>Cons</h3><ul><li>sharp edges</li><li>submodules</li></ul></div>`;

function deck({ footer, flip = false }) {
  const file = path.join(dir, `split-${footer ? 'footer' : 'plain'}${flip ? '-flip' : ''}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section data-layout="${flip ? 'split-flip' : 'split'}">
  <h2>git</h2>
  <p>Distributed version control.</p>
${COLUMNS}
${footer ? '  <p id="foot"><strong>Alternatives:</strong> Mercurial; Jujutsu</p>' : ''}
</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
Decklight.init();
setTimeout(() => {
  const sec = document.querySelector('.decklight-stage > section');
  const cols = [...sec.querySelectorAll(':scope > div')];
  const box = (el) => el.getBoundingClientRect();
  const foot = sec.querySelector('#foot');
  const f = foot && box(foot);
  const a = box(cols[0]);
  const b = box(cols[1]);
  document.getElementById('test-sink').textContent = 'DECKLIGHT-SPLIT-RESULTS ' + JSON.stringify({
    columns: cols.length,
    topGap: Math.round(Math.abs(a.top - b.top)),
    // the headings inside them must line up too, not just the boxes
    headingGap: Math.round(Math.abs(
      box(cols[0].querySelector('h3')).top - box(cols[1].querySelector('h3')).top)),
    // direction-agnostic: they occupy one row without overlapping. WHICH side
    // each is on is asserted separately, because split-flip reverses it
    sideBySide: (a.right <= b.left + 1) || (b.right <= a.left + 1),
    firstIsLeft: a.left < b.left,
    footerMarked: !!foot?.classList.contains('split-footer'),
    // a footer spans the columns rather than sitting in one of them
    footerSpans: f ? Math.round(f.width) >= Math.round(b.right - a.left) - 4 : null,
    footerBelow: f ? Math.round(f.top) >= Math.round(Math.max(a.bottom, b.bottom)) - 1 : null,
    overflow: sec.hasAttribute('data-overflow'),
    conflict: sec.hasAttribute('data-split-conflict'),
  });
}, 400);
</script></body></html>`);
  return file;
}

/**
 * The recipe SPEC COMPARISON_SLIDES tells authors to copy, rendered.
 *
 * A documented recipe that no longer matches the layout is worse than none:
 * it is wrong with authority, and every agent reading the skill copies it. So
 * the markup is lifted out of SPEC.md itself rather than restated here — if
 * the two ever disagree, this fails.
 */
function recipeFromSpec() {
  const spec = readFileSync(path.join(root, 'SPEC.md'), 'utf8');
  const at = spec.indexOf('### COMPARISON_SLIDES');
  if (at < 0) throw new Error('SPEC has no COMPARISON_SLIDES comparison recipe to check');
  const fence = /```html\n([\s\S]*?)```/.exec(spec.slice(at));
  if (!fence) throw new Error('SPEC COMPARISON_SLIDES has no html example');
  return fence[1];
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(40)} ${detail}`);
};
const run = (file) => resultsFrom(
  dumpDom(`file://${file}`, { fileAccess: true, budget: 5000, quietStderr: true, who: 'split-render' }),
  'SPLIT', file);

for (const flip of [false, true]) {
  const tag = flip ? 'split-flip' : 'split';
  const r = run(deck({ footer: false, flip }));
  check(`${tag}: two columns, side by side`, r.columns === 2 && r.sideBySide, `${r.columns} columns`);
  // split puts the first block left; split-flip is the mirror, which is its
  // entire reason for existing
  check(`${tag}: first block on the ${flip ? 'right' : 'left'}`,
    r.firstIsLeft === !flip, `firstIsLeft=${r.firstIsLeft}`);
  // the whole of the first half of #69, in one number
  check(`${tag}: columns share a top edge`, r.topGap <= 1, `${r.topGap}px apart`);
  check(`${tag}: and so do their headings`, r.headingGap <= 1, `${r.headingGap}px apart`);
  check(`${tag}: nothing clipped`, r.overflow === false, `data-overflow=${r.overflow}`);
  check(`${tag}: plain blocks raise no conflict`, r.conflict === false, `data-split-conflict=${r.conflict}`);
}

const f = run(deck({ footer: true }));
check('a third block is marked a footer', f.footerMarked === true, `split-footer=${f.footerMarked}`);
check('the footer spans both columns', f.footerSpans === true, `spans=${f.footerSpans}`);
check('the footer sits below them', f.footerBelow === true, `below=${f.footerBelow}`);
check('and the columns still share a top edge', f.topGap <= 1, `${f.topGap}px apart`);

// ── the documented recipe, exactly as an author would copy it ─────────────
{
  const file = path.join(dir, 'recipe.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
${recipeFromSpec()}
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
Decklight.init();
setTimeout(() => {
  const sec = document.querySelector('.decklight-stage > section');
  const cols = [...sec.querySelectorAll(':scope > div')];
  const box = (el) => el.getBoundingClientRect();
  const foot = sec.querySelector('.split-footer');
  const a = box(cols[0]), b = box(cols[1]);
  document.getElementById('test-sink').textContent = 'DECKLIGHT-SPLIT-RESULTS ' + JSON.stringify({
    columns: cols.length,
    topGap: Math.round(Math.abs(a.top - b.top)),
    footerIsTheThirdBlock: foot?.textContent.includes('Alternatives') ?? false,
    footerSpans: foot ? Math.round(box(foot).width) >= Math.round(b.right - a.left) - 4 : false,
    overflow: sec.hasAttribute('data-overflow'),
    notes: !!sec.querySelector('aside.notes'),
  });
}, 400);
</script></body></html>`);
  const r = resultsFrom(
    dumpDom(`file://${file}`, { fileAccess: true, budget: 5000, quietStderr: true, who: 'split-render' }),
    'SPLIT', 'the SPEC COMPARISON_SLIDES recipe');
  check('recipe: two columns', r.columns === 2, `${r.columns} columns`);
  check('recipe: sharing a top edge', r.topGap <= 1, `${r.topGap}px apart`);
  check('recipe: the trailing <p> is the footer', r.footerIsTheThirdBlock === true, `${r.footerIsTheThirdBlock}`);
  check('recipe: and it spans both columns', r.footerSpans === true, `${r.footerSpans}`);
  check('recipe: nothing clipped', r.overflow === false, `data-overflow=${r.overflow}`);
  check('recipe: notes included', r.notes === true, `${r.notes}`);
}

// ── the trap itself: split + a hand-rolled column shell (#86) ──────────────
// The deck that shipped broken: data-layout="split" left on a section that
// ALSO brings its own flex row of Pros/Cons. The engine must name the cause
// (data-split-conflict, one warning), keep quiet about column-direction flex
// (it stacks, it does not take sides), and clear the mark when the author
// picks one layout system.
{
  const file = path.join(dir, 'conflict.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section data-layout="split">
  <h2>git</h2>
  <p>Distributed version control.</p>
  <div style="display:flex; gap:24px">
    <div><h3>Pros</h3><ul><li>fast</li><li>offline</li></ul></div>
    <div><h3>Cons</h3><ul><li>sharp edges</li><li>submodules</li></ul></div>
  </div>
  <p><strong>Alternatives:</strong> Mercurial; Jujutsu</p>
</section>
<section data-layout="split">
  <h2>benign</h2>
  <div style="display:flex; flex-direction:column"><h3>Pros</h3><ul><li>stacked, not columned</li></ul></div>
  <div><h3>Cons</h3><ul><li>none</li></ul></div>
</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const warns = [];
console.warn = ((orig) => (...a) => { warns.push(a.join(' ')); orig(...a); })(console.warn);
const deck = Decklight.init();
setTimeout(() => {
  const conflictWarns = () => warns.filter((w) => /column flexbox/.test(w)).length;
  const [mixed, benign] = document.querySelectorAll('.decklight-stage > section');
  const flagged = mixed.hasAttribute('data-split-conflict');
  const benignFlagged = benign.hasAttribute('data-split-conflict');
  const warnsOnEntry = conflictWarns();
  deck.sync();                       // still conflicted: the mark stays, the warning does not repeat
  const stillFlagged = mixed.hasAttribute('data-split-conflict');
  const warnsAfterResync = conflictWarns();
  mixed.removeAttribute('data-layout'); // the fix: one layout system
  deck.sync();
  document.getElementById('test-sink').textContent = 'DECKLIGHT-SPLIT-RESULTS ' + JSON.stringify({
    flagged, benignFlagged, warnsOnEntry, stillFlagged, warnsAfterResync,
    cleared: !mixed.hasAttribute('data-split-conflict'),
  });
}, 400);
</script></body></html>`);
  const r = resultsFrom(
    dumpDom(`file://${file}`, { fileAccess: true, budget: 5000, quietStderr: true, who: 'split-render' }),
    'SPLIT', 'split + hand-rolled column shell');
  check('conflict: the mixed slide is marked', r.flagged === true, `data-split-conflict=${r.flagged}`);
  check('conflict: and warned about, once', r.warnsOnEntry === 1, `${r.warnsOnEntry} warning(s)`);
  check('conflict: column-direction flex is not a conflict', r.benignFlagged === false, `flagged=${r.benignFlagged}`);
  check('conflict: a re-sync repeats the mark, not the warning',
    r.stillFlagged === true && r.warnsAfterResync === 1, `flagged=${r.stillFlagged}, ${r.warnsAfterResync} warning(s)`);
  check('conflict: dropping data-layout clears it', r.cleared === true, `cleared=${r.cleared}`);
}

if (bad) { console.error('split-render: FAILED'); process.exit(1); }
console.log('split-render: PASS');
