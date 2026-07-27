#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A pinned title must never have slide content land on top of it.
 *
 * This was #68, and it was reported as a deep-linking bug — the guess being
 * that the pin-measure pass never ran for a slide reached directly. It runs
 * for every section, and the measurement was right: --pin-space came back 238px
 * and padding-top honored it. The content ignored the padding anyway.
 *
 * The cause is that a slide centers its content, and a centered flex container
 * overflows SYMMETRICALLY: content taller than the box puts half the excess out
 * the TOP, which passes straight through the reserved padding and lands on the
 * title. Measured at 85px of overlap — "git" and "Pros" on one baseline, which
 * is exactly what the report showed.
 *
 * So the assertion is geometric and has nothing to do with navigation: for a
 * pinned slide whose content is far too tall, the first content element's top
 * edge must sit BELOW the bottom of the pinned header block. It is checked on a
 * deep link and on a sequential walk, because the report said the two differed
 * and it is worth knowing they no longer do.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pin-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// The reported shape: a leading h2, a subtitle long enough to wrap to two
// lines (which is what makes the header block taller than the 172px fallback),
// then far more content than fits.
function deck(layout) {
  const file = path.join(dir, `pin-${layout || 'auto'}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section${layout ? ` data-layout="${layout}"` : ''}>
  <h2>git</h2>
  <p>Distributed version control — the substrate everything else sits on, and a
     sentence long enough to wrap onto a second line at this size.</p>
  <h3>Pros</h3><ul><li>fast</li><li>offline</li><li>ubiquitous</li><li>scriptable</li><li>battle-tested</li></ul>
  <h3>Cons</h3><ul><li>sharp edges</li><li>rebase confusion</li><li>submodules</li><li>large files</li><li>porcelain sprawl</li></ul>
</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init();
const params = new URLSearchParams(location.search);
setTimeout(() => {
  if (params.get('walk') === '1') { deck.goto(1, 0); deck.goto(2, 0); }
  setTimeout(() => {
    const sec = document.querySelectorAll('.decklight-stage > section')[1];
    const box = (el) => el && el.getBoundingClientRect();
    const title = box(sec.querySelector('.pin-title'));
    const sub = box(sec.querySelector('.pin-subtitle'));
    const first = box(sec.querySelector('h3'));
    const headerBottom = Math.max((title && title.bottom) || 0, (sub && sub.bottom) || 0);
    document.getElementById('test-sink').textContent = 'DECKLIGHT-PIN-RESULTS ' + JSON.stringify({
      pinned: sec.hasAttribute('data-pinned'),
      pinSpace: sec.style.getPropertyValue('--pin-space'),
      overlapPx: Math.round(headerBottom - ((first && first.top) || headerBottom)),
      measured: !!title,
    });
  }, 400);
}, 300);
</script></body></html>`);
  return file;
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} ${detail}`);
};

function run(deckFile, query) {
  const html = dumpDom(`file://${deckFile}?${query}`,
    { fileAccess: true, budget: 5000, quietStderr: true, who: 'pin-render' });
  const m = html.match(/DECKLIGHT-PIN-RESULTS ([^<]+)/);
  if (!m) throw new Error('pin-render: no results in the dumped DOM');
  return JSON.parse(m[1]);
}

for (const [layout, label] of [['', 'auto'], ['split', 'split']]) {
  const deckFile = deck(layout);
  for (const [query, how] of [['', 'deep link'], ['walk=1', 'stepped to']]) {
    // '#/2/0' is the deep link the report used: straight to the slide on load
    const url = query ? `${query}#/2/0` : '#/2/0';
    const r = run(deckFile, url);
    check(`${label}, ${how}: measured`, r.pinned && r.measured && r.pinSpace !== '',
      `pinned=${r.pinned} --pin-space=${r.pinSpace || '(unset)'}`);
    // the whole bug, in one number: content must start below the header
    check(`${label}, ${how}: no title overlap`, r.overlapPx <= 0, `${r.overlapPx}px into the header`);
  }
}

if (bad) { console.error('pin-render: FAILED'); process.exit(1); }
console.log('pin-render: PASS');
