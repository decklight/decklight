#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The overflow guardrail (SPEC PRESENTING) has to stay true as the slide
 * settles, not just at the instant it activated.
 *
 * It used to be measured exactly once per `goto`, one frame later. On a deep
 * link `goto` runs once, at init — so that one frame was the only measurement
 * a directly-linked slide would ever get, and whatever it happened to see was
 * latched forever. Anything that changes height after it (a webfont resolving,
 * an image decoding, a chart or terminal mounting into its container) landed
 * too late to be seen.
 *
 * The failure direction is the dangerous one. The authoring contract has agents
 * assert `[data-overflow]` is ABSENT, and `decklight pdf` scrapes the same
 * attribute to name clipped slides — so a slide that overflows only after that
 * frame does not fail the check, it passes it, silently. This harness pins the
 * live behaviour: content that grows after the first frame still gets flagged,
 * and content that shrinks back gets un-flagged.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-overflow-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/**
 * Slide 2 fits on arrival and is grown (or shrunk) well after init's frame —
 * `mutate` runs at 250ms, the DOM is read at 900ms. The deck is deep-linked so
 * `goto` fires exactly once: without a live watch there is no second look.
 *
 * `late` runs at 550ms, after the 250ms mutation has been observed AND
 * measured (the flag is sampled between the two, at 420ms) — the second act
 * for content that arrives and only then grows.
 */
function deck(name, items, mutate, late = '') {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section>
  <h2>Late arrivals</h2>
  <ul id="grower">${items.map((t) => `<li>${t}</li>`).join('')}</ul>
</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const warns = [];
console.warn = ((orig) => (...a) => { warns.push(a.join(' ')); orig(...a); })(console.warn);
Decklight.init();
const sec = document.querySelectorAll('.decklight-stage > section')[1];
const ul = document.getElementById('grower');
// What the engine concluded on arrival, sampled on a TIMER at a point both
// sides of the ordering have long passed. A requestAnimationFrame sample
// raced the engine's own timer-scheduled check and read the attribute before
// it was written — which is the same lesson the fix under test is about, so
// leaving a frame-scheduled probe in its own harness would be a poor joke.
const onArrival = { flagged: null };
setTimeout(() => { onArrival.flagged = sec.hasAttribute('data-overflow'); }, 120);
setTimeout(() => { ${mutate} }, 250);
const afterMutation = { flagged: null };
setTimeout(() => { afterMutation.flagged = sec.hasAttribute('data-overflow'); }, 420);
setTimeout(() => { ${late} }, 550);
setTimeout(() => {
  const lateEl = document.getElementById('late');
  document.getElementById('test-sink').textContent = 'DECKLIGHT-OVERFLOW-RESULTS ' + JSON.stringify({
    atFirstFrame: onArrival.flagged,
    afterMutation: afterMutation.flagged,
    flagged: sec.hasAttribute('data-overflow'),
    scrolls: sec.scrollHeight > sec.clientHeight + 2,
    lateScrolls: lateEl ? lateEl.scrollHeight > lateEl.clientHeight + 2 : null,
    warns: warns.filter((w) => /overflows/.test(w)).length,
  });
}, 900);
</script></body></html>`);
  return file;
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
};

function run(file) {
  const html = dumpDom(`file://${file}#/2/0`,
    { fileAccess: true, budget: 5000, quietStderr: true, who: 'overflow-render' });
  const m = html.match(/DECKLIGHT-OVERFLOW-RESULTS ([^<]+)/);
  if (!m) throw new Error('overflow-render: no results in the dumped DOM');
  return JSON.parse(m[1]);
}

// ---- grows after the first frame -------------------------------------------
// Six short items fit; twenty-four long ones cannot. The <ul> is a direct child
// of the section, so growing it is the shape a mounting chart or a decoded
// image has: an existing container changing height, not a new slide.
const grew = run(deck('grow', ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
  `for (let i = 0; i < 24; i++) {
     const li = document.createElement('li');
     li.textContent = 'a line long enough to wrap and push the list past the slide ' + i;
     ul.appendChild(li);
   }`));

check('grew: it really does overflow at read time', grew.scrolls === true, `scrolls=${grew.scrolls}`);
check('grew: it did NOT overflow on arrival', grew.atFirstFrame === false, `on arrival=${grew.atFirstFrame}`);
// the whole regression, in one line: the guardrail noticed the late growth
check('grew: flagged anyway', grew.flagged === true, `data-overflow=${grew.flagged}`);
check('grew: warned exactly once', grew.warns === 1, `${grew.warns} warning(s)`);

// ---- shrinks after the first frame ------------------------------------------
// The flag has to be able to come back off, or a slide that transiently
// overflows while mounting stays branded for the rest of the deck's life.
const shrank = run(deck('shrink',
  Array.from({ length: 24 }, (_, i) => `a line long enough to wrap and push the list past the slide ${i}`),
  'ul.textContent = \'\';'));

check('shrank: it fits at read time', shrank.scrolls === false, `scrolls=${shrank.scrolls}`);
check('shrank: it DID overflow on arrival', shrank.atFirstFrame === true, `on arrival=${shrank.atFirstFrame}`);
check('shrank: flag cleared', shrank.flagged === false, `data-overflow=${shrank.flagged}`);

// ---- a node added after arming grows later, silently ------------------------
// The mutation observer sees the <ul> arrive at 250ms and measures it — it
// fits. At 550ms an image INSIDE it gets its src and loads: setting an
// attribute fires no watched mutation, the list’s own box is a fixed 200px so
// no sibling moves, and nothing armed at goto time resizes. Worse, this
// harness runs out of frames the moment the page goes idle (the same trap the
// engine's timer comment describes), so even a ResizeObserver aimed straight
// at the image reports the growth in a frame that never comes. Without a
// frame-independent ear on late media, the slide settles into clipping
// unmeasured — and passes the `[data-overflow]`-is-absent assertion (SPEC
// PRESENTING) silently.
const lateGrew = run(deck('late-grow', ['alpha', 'beta', 'gamma'],
  `const late = document.createElement('ul');
   late.id = 'late';
   late.style.cssText = 'height:200px;overflow-y:auto;margin:0';
   const item = document.createElement('li');
   const img = document.createElement('img');
   img.id = 'late-img';
   item.appendChild(img);
   late.appendChild(item);
   sec.appendChild(late);`,
  `document.getElementById('late-img').src = 'data:image/svg+xml,'
     + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="600"></svg>');`));

check('late: clean on arrival', lateGrew.atFirstFrame === false, `on arrival=${lateGrew.atFirstFrame}`);
check('late: clean once the arrival was measured', lateGrew.afterMutation === false, `after mutation=${lateGrew.afterMutation}`);
check('late: the added node really clips at read time', lateGrew.lateScrolls === true, `late scrolls=${lateGrew.lateScrolls}`);
// the whole ticket, in one line: growth after the arrival was measured, seen
check('late: flagged anyway', lateGrew.flagged === true, `data-overflow=${lateGrew.flagged}`);
check('late: warned exactly once', lateGrew.warns === 1, `${lateGrew.warns} warning(s)`);

// ---- a diagram cut by the box that holds it (#1183) -------------------------
// A title long enough to wrap to two lines, above a 16:9 diagram with its own
// width. When the diagram sits in a block box that hides its overflow (a
// design-system slot is often one), the box does the cutting: the slide itself
// is not over, so nothing reached the section's scrollHeight and the slide
// passed every check with the bottom of the diagram missing.
const TITLE = 'A title long enough that it has to wrap onto a second line on this slide';
const DIAGRAM = `<svg viewBox="0 0 800 420" width="1100">
  <rect x="10" y="10" width="780" height="400" rx="12" fill="none" stroke="currentColor" stroke-width="4"/>
  <rect id="last-row" x="40" y="330" width="720" height="60" rx="8" fill="currentColor" opacity=".35"/>
</svg>`;
// the slot, as a template writes it: flexible, a plain block, overflow hidden
const SLOT = 'flex:1; min-height:0; display:block; overflow:hidden';
// a design system on the page, as the servers inject one (DESIGN_SYSTEMS): a diagram template
const DS = `<script type="application/json" data-design-system-meta="acme">{"name":"acme","version":"1.0.0","title":"Acme"}</script>
<template data-design-system-templates="acme"><template data-template="diagram" data-title="Diagram">
  <div class="acme-diagram"><div data-slot="title" data-slot-hint="h2"></div><div data-slot="diagram" data-slot-default></div></div>
</template></template>
<style>
.decklight .acme-diagram { position: absolute; inset: 0; box-sizing: border-box; padding: 40px 60px; display: flex; flex-direction: column; }
.decklight .acme-diagram > [data-slot="diagram"] { ${SLOT}; }
</style>`;

/**
 * Slide 2 is `body`, read at 600ms: whether the guardrail flagged it, what the
 * flag names, and whether the diagram's last row is inside the slide, the box
 * that holds it, and the slide's own box.
 */
function clipDeck(name, body, { head = '', attrs = '', print = false } = {}) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}">${head}</head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section id="s"${attrs}>${body}</section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const warns = [];
console.warn = ((orig) => (...a) => { warns.push(a.join(' ')); orig(...a); })(console.warn);
Decklight.init();
setTimeout(() => {
  const sec = document.getElementById('s');
  const svg = sec.querySelector('svg, img');
  const row = sec.querySelector('[id$="last-row"]') || svg;
  const holder = svg.closest('[data-ds-injected][data-slot]') || svg.parentElement;
  let outer = svg;
  while (outer.parentElement !== sec) outer = outer.parentElement;
  const r = row.getBoundingClientRect(), h = holder.getBoundingClientRect(), s = sec.getBoundingClientRect();
  const o = outer.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(sec).paddingBottom) * s.width / sec.offsetWidth;
  const k = s.width / sec.offsetWidth;
  const title = sec.querySelector('h2');
  document.getElementById('test-sink').textContent = 'DECKLIGHT-CLIP-RESULTS ' + JSON.stringify({
    flagged: sec.hasAttribute('data-overflow'),
    what: sec.getAttribute('data-overflow'),
    by: Number(sec.getAttribute('data-overflow-by')),
    titleLines: Math.round(title.getBoundingClientRect().height / k / parseFloat(getComputedStyle(title).lineHeight)),
    rowInHolder: r.bottom <= h.bottom + 1,
    rowInSlide: r.bottom <= s.bottom + 1,
    rowInOuter: r.bottom <= o.bottom + 1,
    outerInSlide: o.bottom <= s.bottom - pad + 1,
    outerOver: Math.round((o.bottom - (s.bottom - pad)) / k),
    svgHeight: Math.round(svg.getBoundingClientRect().height / k),
    warns: warns.filter((w) => /overflows/.test(w)),
  });
}, 600);
</script></body></html>`);
  return `file://${file}${print ? '?print' : '#/2/0'}`;
}
const clipRun = (url) => {
  const html = dumpDom(url, { fileAccess: true, budget: 5000, quietStderr: true, who: 'overflow-render',
    extraFlags: ['--window-size=1280,720'] });
  const m = html.match(/DECKLIGHT-CLIP-RESULTS ([^<]+)/);
  if (!m) throw new Error(`overflow-render: no clip results for ${url}`);
  return JSON.parse(m[1]);
};

{
  // a plain deck: the author's own block box, hiding its overflow, with words
  // sharing the box with the diagram. Its room is the words' as much as the
  // diagram's, so the diagram is not resized: it is cut, and the slide must
  // say so.
  for (const print of [false, true]) {
    const r = clipRun(clipDeck(`box${print ? '-print' : ''}`,
      `<h2>${TITLE}</h2><div style="${SLOT}">A line of words above the diagram. ${DIAGRAM}</div>`, { print }));
    const t = print ? 'box with words, print:' : 'box with words:';
    check(`${t} the title wraps to two lines`, r.titleLines === 2, `${r.titleLines} line(s)`);
    check(`${t} the diagram really is cut`, !r.rowInHolder, `rowInHolder=${r.rowInHolder}`);
    check(`${t} flagged`, r.flagged, `data-overflow=${r.flagged}`);
    check(`${t} the flag names the diagram`, r.what === 'a diagram' && r.by > 2, `what="${r.what}" by=${r.by}`);
    if (!print) check(`${t} the warning names it too`, r.warns.length === 1 && /a diagram/.test(r.warns[0]), JSON.stringify(r.warns));
  }
}
{
  // the main visual of a plain slide, in the author's own wrappers: a box
  // that hides its overflow round a plain div round the diagram, and a plain
  // div alone, nothing else in either. It is given the room left under the
  // two-line title and scales into it: its last row is whole, nothing flagged.
  const WRAPS = [
    ['wrapped, hidden box', (d) => `<div style="${SLOT}"><div>${d}</div></div>`],
    ['wrapped, plain div', (d) => `<div class="figure-frame">${d}</div>`],
  ];
  for (const [name, wrap] of WRAPS) {
    for (const print of [false, true]) {
      const r = clipRun(clipDeck(`${name.replace(/\W+/g, '-')}${print ? '-print' : ''}`,
        `<h2>${TITLE}</h2>${wrap(DIAGRAM)}`, { print }));
      const t = `${name}${print ? ', print' : ''}:`;
      check(`${t} the title wraps to two lines`, r.titleLines === 2, `${r.titleLines} line(s)`);
      check(`${t} the diagram shrinks to the room`, r.svgHeight < 577, `${r.svgHeight}px tall`);
      check(`${t} its last row is whole`, r.rowInHolder && r.rowInOuter && r.outerInSlide,
        `inHolder=${r.rowInHolder} inWrapper=${r.rowInOuter} wrapperInSlide=${r.outerInSlide}`);
      check(`${t} so nothing is flagged`, !r.flagged, `data-overflow=${r.flagged} "${r.what}" ${r.by}`);
    }
  }
}
{
  // a split slide (COMPARISON_SLIDES) under a long title: a tall diagram, or
  // picture, alone in its column takes the room the column has, not its own
  // height, and scales into it. The list in the other column is left alone.
  const TALL = `<svg viewBox="0 0 400 520" width="400">
  <rect x="10" y="10" width="380" height="500" rx="12" fill="none" stroke="currentColor" stroke-width="4"/>
  <rect id="last-row" x="30" y="440" width="340" height="60" rx="8" fill="currentColor" opacity=".35"/>
</svg>`;
  const PIC = `<img width="400" height="520" alt="A tall picture" src="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520"><rect width="400" height="520" fill="#888"/></svg>')}">`;
  const LIST = '<ul><li>One point</li><li>Another point</li></ul>';
  const CASES = [
    ['split, diagram in a column', `<div class="column">${TALL}</div>${LIST}`, 520],
    ['split, bare diagram', `${TALL}${LIST}`, 520],
    ['split, picture in a column', `<div><picture><source media="(max-width: 1px)" srcset="${PIC.match(/src="([^"]+)"/)[1]}">${PIC}</picture></div>${LIST}`, 480],
  ];
  for (const [name, body, natural] of CASES) {
    for (const print of [false, true]) {
      const r = clipRun(clipDeck(`${name.replace(/\W+/g, '-')}${print ? '-print' : ''}`,
        `<h2>${TITLE}, and longer</h2>${body}`, { attrs: ' data-layout="split"', print }));
      const t = `${name}${print ? ', print' : ''}:`;
      check(`${t} the title wraps to two lines`, r.titleLines === 2, `${r.titleLines} line(s)`);
      check(`${t} the diagram shrinks to the room`, r.svgHeight < natural, `${r.svgHeight}px tall`);
      check(`${t} it is whole, inside the slide`, r.rowInOuter && r.outerInSlide,
        `inColumn=${r.rowInOuter} columnInSlide=${r.outerInSlide} ${r.svgHeight}px over=${r.outerOver}`);
      check(`${t} so nothing is flagged`, !r.flagged, `data-overflow=${r.flagged} "${r.what}" ${r.by}`);
    }
  }
}
{
  // a diagram that fits is left exactly as it was: the same wrapper, a short title
  const r = clipRun(clipDeck('wrapped-fits', `<h2>Short</h2><div>${DIAGRAM.replace('width="1100"', 'width="500"')}</div>`));
  check('wrapped, fits: left at its own size', Math.abs(r.svgHeight - 263) <= 1 && !r.flagged, `${r.svgHeight}px tall, flagged=${r.flagged}`);
}
{
  // a design-system template's diagram slot: the diagram is the slot's main
  // block, so it is given the room left under the title and scales into it
  for (const print of [false, true]) {
    const r = clipRun(clipDeck(`slot${print ? '-print' : ''}`,
      `<h2 data-slot="title">${TITLE}</h2>${DIAGRAM.replace('<svg ', '<svg data-slot="diagram" ')}`,
      { head: DS, attrs: ' data-template="acme/diagram"', print }));
    const t = print ? 'template slot, print:' : 'template slot:';
    check(`${t} the title wraps to two lines`, r.titleLines === 2, `${r.titleLines} line(s)`);
    check(`${t} the diagram shrinks to the room`, r.svgHeight < 577, `${r.svgHeight}px tall`);
    check(`${t} its last row is whole`, r.rowInHolder && r.rowInSlide, `inSlot=${r.rowInHolder} inSlide=${r.rowInSlide}`);
    check(`${t} so nothing is flagged`, !r.flagged, `data-overflow=${r.flagged} "${r.what}"`);
  }
}
{
  // the same slot with a caption under the diagram: the diagram is not the
  // slot's only block, so it is left at its size, and what is cut is reported
  const r = clipRun(clipDeck('slot-caption',
    `<h2 data-slot="title">${TITLE}</h2><div data-slot="diagram">${DIAGRAM}<p>A caption under it.</p></div>`,
    { head: DS, attrs: ' data-template="acme/diagram"' }));
  check('template slot, not alone: cut, and flagged', !r.rowInHolder && r.flagged,
    `rowInSlot=${r.rowInHolder} data-overflow=${r.flagged} "${r.what}"`);
}

if (bad) { console.error('overflow-render: FAILED'); process.exit(1); }
console.log('overflow-render: PASS');
