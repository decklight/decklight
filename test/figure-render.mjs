#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Figures (SPEC DECK_ANATOMY, #1181), as a browser draws them. A value is set
 * at the theme's `--figure-size` in its ink, and clamped so it never runs past
 * its column: alone on a slide, three in a row (one size for the row), in a
 * split column, and a value too long for its room. A row that builds brings
 * one figure a click; a lone figure that builds is one step.
 *
 * `data-count` counts a value up when its step arrives. A headless render
 * never paints a frame, so the count is driven here by its own clock
 * (`deck._figures.tick`): the DOM reads as written until a frame is painted,
 * a frame writes the value on its way there in the value's own format, and
 * the end, a step back, the overview, reduced motion and the printed page all
 * show the value as written.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-figure-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const deckFile = (theme) => {
  const file = path.join(dir, `deck-${theme}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, `themes/${theme}.css`)}">
</head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><div class="figure" id="alone"><p data-figure>94%</p><p>of requests never reach the database</p><small>cache hit rate since March</small></div></section>
<section><h2>Three</h2><div class="figures" id="row" data-build>
  <div class="figure"><p data-figure data-count>$1.2M</p><p>saved a year</p></div>
  <div class="figure"><p data-figure>94%</p><p>hit rate</p></div>
  <div class="figure"><p data-figure data-count data-count-from="1">3×</p><p>faster</p><small>p95</small></div>
</div></section>
<section data-layout="split"><h2>Split</h2><div><h3>Why</h3><ul><li>One</li><li>Two</li></ul></div>
  <div class="figure" id="side"><p data-figure data-count>1,500</p><p>queries a second</p></div></section>
<section><h2>Long</h2><div class="figures"><div class="figure" id="long"><p data-figure>$12,500,000</p><p>a year</p></div><div class="figure"><p data-figure>42</p><p>short</p></div></div></section>
<section><h2>Builds whole</h2><div class="figure" id="whole" data-build><p data-figure data-count>-12.5%</p><p>churn</p></div></section>
<section><h2>End</h2></section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'none' });
const F = deck._figures;
const value = (id) => document.querySelector('#' + id + ' [data-figure]') ?? document.querySelector('#' + id);
const box = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
// where each value is drawn against its figure's box, and how large
const fig = (el) => {
  const t = box(el), c = el.closest('.figure').getBoundingClientRect(), cs = getComputedStyle(el);
  return { text: el.textContent, size: parseFloat(cs.fontSize), color: cs.color, inside: t.left >= c.left - 1 && t.right <= c.right + 1 && t.width > 0,
    counting: el.classList.contains('figure-counting'), label: el.getAttribute('aria-label') };
};
const out = { url: location.search };
setTimeout(() => {
  const sizeOf = getComputedStyle(value('alone').closest('section')).fontSize;   // the slide's body size
  out.theme = { size: parseFloat(getComputedStyle(value('alone')).fontSize), body: parseFloat(sizeOf),
    accent: getComputedStyle(document.querySelector('.decklight')).getPropertyValue('--figure-ink').trim() || getComputedStyle(document.querySelector('.decklight')).getPropertyValue('--accent').trim() };
  out.chars = [...document.querySelectorAll('[data-figure]')].map((v) => v.style.getPropertyValue('--figure-chars'));
  if (!location.search) {
    deck.goto(2, 0); out.alone = fig(value('alone'));
    out.aloneSlide = { dense: document.querySelector('.decklight-stage > section.active').getAttribute('data-dense'), overflow: document.querySelector('.decklight-stage > section.active').getAttribute('data-overflow') };
    const row = () => [...document.querySelectorAll('#row [data-figure]')];
    deck.goto(3, 0);
    out.rowSteps = deck._records[2].groups.length;
    out.row0 = [...document.querySelectorAll('#row > .figure')].map((f) => f.getAttribute('data-build-state'));
    deck.goto(3, 1);
    out.row1 = [...document.querySelectorAll('#row > .figure')].map((f) => f.getAttribute('data-build-state'));
    // the first figure's count began: no frame yet, so it reads as written, and a reader hears it as written
    out.arrived = fig(row()[0]);
    const t0 = performance.now();
    F.tick(t0 + 500); out.midway = row()[0].textContent;
    F.tick(t0 + 99999); out.ended = fig(row()[0]);
    deck.goto(3, 3);
    out.third = fig(row()[2]);
    F.tick(performance.now() + 300); out.thirdMid = row()[2].textContent;
    deck.goto(3, 2); out.thirdBack = fig(row()[2]);
    out.row = row().map(fig);
    out.rowSlide = { dense: document.querySelector('.decklight-stage > section.active').getAttribute('data-dense'), overflow: document.querySelector('.decklight-stage > section.active').getAttribute('data-overflow') };
    // a slide that does not build: its value counts as the slide arrives
    deck.goto(4, 0);
    out.side = fig(value('side'));
    F.tick(performance.now() + 400); out.sideMid = value('side').textContent;
    // the overview shows it as written, never half-way
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    const clone = [...document.querySelectorAll('.ov-clone [data-figure]')].find((v) => v.closest('.figure')?.id === 'side');
    out.overview = clone ? clone.textContent : null;
    out.afterOverview = fig(value('side'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    deck.goto(5, 0); out.long = [...document.querySelectorAll('.decklight-stage > section.active [data-figure]')].map(fig);
    deck.goto(6, 0); out.whole0 = document.getElementById('whole').getAttribute('data-build-state');
    out.wholeSteps = deck._records[5].groups.length;
    deck.goto(6, 1); out.whole1 = fig(value('whole'));
    F.tick(performance.now() + 500); out.wholeMid = value('whole').textContent;
    // reduced motion: nothing counts
    deck.goto(7, 0);
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    deck.goto(4, 0, { force: true, direction: 'fwd' }); out.reduced = fig(value('side'));
    window.matchMedia = mm;
  } else {
    out.printed = [...document.querySelectorAll('[data-figure]')].map(fig);
    out.running = F.running().length;
  }
  document.getElementById('test-sink').textContent = 'DECKLIGHT-FIGURE-RESULTS ' + JSON.stringify(out);
}, 300);
</script></body></html>`);
  return file;
};

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(64)} ${detail}`);
};
const run = (file, query) => resultsFrom(
  dumpDom(`file://${file}${query}`, { fileAccess: true, budget: 4000, quietStderr: true, who: 'figure-render' }), 'FIGURE', query);

// ── a light and a dark theme, the layouts and the count ────────────────────
for (const theme of ['porcelain', 'aurora']) {
  const r = run(deckFile(theme), '');
  const t = `${theme}:`;
  check(`${t} alone, the value is the theme's size, several times the body`, Math.abs(r.alone.size - 4.5 * r.theme.body) < 0.5 && r.alone.inside,
    `${r.alone.size}px on a ${r.theme.body}px body`);
  check(`${t} alone, the slide is neither crowded nor clipped`, !r.aloneSlide.dense && !r.aloneSlide.overflow, JSON.stringify(r.aloneSlide));
  check(`${t} every value is given its length for the clamp`, r.chars.every((c) => +c >= 1), r.chars.join(' '));
  check(`${t} a row that builds is one figure a click`, r.rowSteps === 3 && r.row0.join() === 'pending,pending,pending' && r.row1.join() === 'current,pending,pending',
    `${r.rowSteps} steps, ${r.row0} → ${r.row1}`);
  check(`${t} three in a row: one size, each inside its figure`, Math.max(...r.row.map((v) => v.size)) - Math.min(...r.row.map((v) => v.size)) < 0.1 && r.row.every((v) => v.inside),
    r.row.map((v) => `${v.text} ${v.size}px ${v.inside ? 'in' : 'OUT'}`).join(', '));
  check(`${t} three in a row: one paragraph's worth, not crowded`, !r.rowSlide.dense && !r.rowSlide.overflow, JSON.stringify(r.rowSlide));
  check(`${t} its step arrived: counting, still reading as written`, r.arrived.counting && r.arrived.text === '$1.2M' && r.arrived.label === '$1.2M',
    `counting=${r.arrived.counting} "${r.arrived.text}" label "${r.arrived.label}"`);
  check(`${t} a frame writes the value on its way, as it is written`, /^\$\d\.\dM$/.test(r.midway) && r.midway !== '$1.2M', `"${r.midway}"`);
  check(`${t} the count ends on the value as written`, r.ended.text === '$1.2M' && !r.ended.counting && r.ended.label === null, `"${r.ended.text}" counting=${r.ended.counting}`);
  check(`${t} data-count-from starts it there`, r.third.counting && /^[123]×$/.test(r.thirdMid), `"${r.thirdMid}"`);
  check(`${t} a step back shows the value as written`, r.thirdBack.text === '3×' && !r.thirdBack.counting, `"${r.thirdBack.text}"`);
  check(`${t} in a split column, inside its column`, r.side.inside && r.side.counting, `${r.side.size}px inside=${r.side.inside}`);
  check(`${t} separators kept on the way`, /^(\d{1,3}|1,\d{3})$/.test(r.sideMid) && r.sideMid !== '1,500', `"${r.sideMid}"`);
  check(`${t} the overview shows the value as written`, r.overview === '1,500' && r.afterOverview.text === '1,500' && !r.afterOverview.counting, `clone "${r.overview}"`);
  check(`${t} a long value is clamped to its column`, r.long[0].inside && r.long[0].size < r.theme.size && Math.abs(r.long[1].size - r.long[0].size) < 0.1,
    r.long.map((v) => `${v.text} ${v.size}px`).join(', '));
  check(`${t} a lone figure that builds is one step, value and label together`, r.wholeSteps === 1 && r.whole0 === 'pending' && r.whole1.counting, `${r.wholeSteps} step`);
  check(`${t} a negative value counts with its sign and decimals`, /^-?\d+\.\d%$/.test(r.wholeMid), `"${r.wholeMid}"`);
  check(`${t} reduced motion: no count`, !r.reduced.counting && r.reduced.text === '1,500', `counting=${r.reduced.counting}`);
}

// ── print: every value as written, nothing counting ────────────────────────
{
  const r = run(deckFile('aurora'), '?print');
  check('print: every value as written, none counting', r.running === 0 && r.printed.every((v) => !v.counting)
    && r.printed.map((v) => v.text).join(' ') === '94% $1.2M 94% 3× 1,500 $12,500,000 42 -12.5%', r.printed.map((v) => v.text).join(' '));
  check('print: every value inside its figure', r.printed.every((v) => v.inside), r.printed.filter((v) => !v.inside).map((v) => v.text).join(' ') || 'all');
}

if (bad) {
  console.error(`\nfigure-render: ${bad} check(s) failed`);
  process.exit(1);
}
console.log('\nfigure-render: all checks passed');
