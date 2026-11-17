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
 * A step's callout (`data-callouts`, #1182) arrives and leaves with it: in a
 * gutter at the block's right, never over the code, a bracket spanning its
 * lines and the label level with their middle; under its lines in a block too
 * narrow for a gutter, pushing nothing; earlier ones kept and muted with
 * `data-callouts-keep`; gone with the dimming of a walk that ends lit; and
 * every one of them on the printed page. A narrow block that shows several at
 * once (kept, or printed) numbers them beside its lines, never over its code,
 * and lists the labels under it, in room the block took from the start, and
 * `data-fit` shrinks the code to leave that list room.
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
<style>.decklight .code-line, .decklight .code-callout, .decklight .code-callout-entry { transition: none !important; }</style></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><h2>Then a point</h2>${code('then', 'data-lines-end="all"')}<p data-build>And what it means.</p></section>
<section><h2>Plain</h2>${code('plain', '')}</section>
<section><h2>Ends lit</h2>${code('lit', 'data-lines-end="all"')}</section>
<section><h2>Printed as the last step</h2>${code('last', 'data-lines-print="last"')}</section>
<section><h2>End</h2></section>
<section><h2>Gutter</h2><pre id="gut" data-fit data-lines="1|2-3|4" data-callouts="One|Two and three|Four" data-callouts-keep><code class="language-sql">SELECT a
FROM t
JOIN u ON t.id = u.id
WHERE b = 1;</code></pre></section>
<section><h2>Narrow</h2><div style="width: 520px; margin: 0 auto"><pre id="nar" data-lines="1|2" data-callouts="One|Two"><code class="language-sql">SELECT a
FROM t
WHERE b = 1;</code></pre></div></section>
<section><h2>Callouts end lit</h2><pre id="endc" data-lines="1|2" data-lines-end="all" data-callouts="One|Two"><code class="language-sql">SELECT a
FROM t;</code></pre><p data-build>And then.</p></section>
<section><h2>Aside</h2><pre id="asd" data-lines="1|2"><code class="language-sql">SELECT a
FROM t;</code></pre><aside class="callouts"><p>The <strong>columns</strong></p><p data-step="2">The table</p></aside></section>
<section><h2>Long lines</h2><pre id="long" data-fit data-lines="1|2" data-callouts="The first, at some length|The second"><code class="language-js">const someVeryLongVariableName = await fetchTheThingFromTheServer(withThisArgument, andThatOne);
const anotherQuiteLongName = someVeryLongVariableName.map((x) => x.value * 2).filter(Boolean);</code></pre></section>
<section><h2>Narrow, kept</h2><div style="width: 520px; margin: 0 auto"><pre id="nark" data-lines="1|2-3|4" data-callouts="One|Two and three|Four" data-callouts-keep><code class="language-sql">SELECT a
FROM t
JOIN u ON t.id = u.id
WHERE b = 1;</code></pre></div></section>
<section><h2>Narrow, kept, fitted</h2><div id="tight" style="width: 520px; height: 300px; margin: 0 auto; overflow: hidden"><pre id="narf" data-fit data-lines="1-3|4-6|7-8" data-callouts="The first three lines, at some length|The middle of it|The end" data-callouts-keep><code class="language-sql">SELECT a,
       b,
       c
FROM t
JOIN u ON t.id = u.id
JOIN v ON u.id = v.id
WHERE b = 1
ORDER BY a;</code></pre></div></section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'fade' });
// the faintest line of each block: below 1 is a block still dimmed
const dim = () => Object.fromEntries([...document.querySelectorAll('.decklight-stage pre[id]')].map((p) =>
  [p.id, Math.min(...[...p.querySelectorAll('.code-line')].map((l) => +getComputedStyle(l).opacity))]));
// each block's callouts: seen (opacity), and where, against its code and lines
const callouts = () => Object.fromEntries([...document.querySelectorAll('.decklight-stage pre.has-callouts')].map((p) => {
  const code = p.querySelector(':scope > code').getBoundingClientRect();
  const lines = [...p.querySelectorAll('.code-line')].map((l) => l.getBoundingClientRect());
  return [p.id, {
    mode: ['gutter', 'under', 'legend'].find((m) => p.classList.contains(\`callouts-\${m}\`)) ?? null,
    codeRight: code.right, codeBottom: code.bottom, preBottom: p.getBoundingClientRect().bottom,
    codeFits: p.querySelector(':scope > code').scrollWidth <= p.querySelector(':scope > code').clientWidth + 1,
    height: p.offsetHeight, lines: lines.map((r) => [r.top, r.bottom]),
    scale: p.getAttribute('data-fit-scale'),
    legend: (() => {
      const g = p.querySelector(':scope > .code-callout-legend');
      const r = g.getBoundingClientRect();
      return { shown: getComputedStyle(g).display !== 'none', top: r.top, bottom: r.bottom,
        each: [...g.querySelectorAll('.code-callout-entry')].map((e) => {
          const cs = getComputedStyle(e);
          return { seen: cs.visibility === 'visible' ? +cs.opacity : 0, color: cs.color,
            mark: e.querySelector('.code-callout-mark').textContent, text: e.querySelector('.code-callout-label').textContent };
        }) };
    })(),
    each: [...p.querySelectorAll('.code-callout')].map((c) => {
      const b = c.querySelector('.code-callout-bracket').getBoundingClientRect();
      const l = c.querySelector('.code-callout-label').getBoundingClientRect();
      const cs = getComputedStyle(c);
      return { step: +c.dataset.step, seen: cs.visibility === 'visible' ? +cs.opacity : 0, color: cs.color,
        bracket: [b.left, b.top, b.bottom, getComputedStyle(c.querySelector('.code-callout-bracket')).borderTopColor],
        label: [l.left, l.top, l.bottom], strong: !!c.querySelector('.code-callout-label strong'),
        labelShown: getComputedStyle(c.querySelector('.code-callout-label')).display !== 'none',
        mark: (() => {
          const m = c.querySelector('.code-callout-mark');
          const r = m.getBoundingClientRect();
          return { shown: getComputedStyle(m).display !== 'none', text: m.textContent, left: r.left, mid: (r.top + r.bottom) / 2 };
        })() };
    }),
  }];
}));
const asideShown = () => [...document.querySelectorAll('.decklight-stage aside.callouts')].some((a) => getComputedStyle(a).display !== 'none');
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
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // callouts (#1182)
    deck.goto(7, 0); out.gut0 = callouts().gut;
    deck.goto(7, 1); out.gut1 = callouts().gut;
    deck.goto(7, 2); out.gut2 = callouts().gut;
    deck.goto(7, 3); out.gut3 = callouts().gut;
    deck.goto(8, 0); out.nar0 = callouts().nar;
    deck.goto(8, 1); out.nar1 = callouts().nar;
    deck.goto(8, 2); out.nar2 = callouts().nar;
    deck.goto(9, 2); out.endc2 = callouts().endc;
    deck.goto(9, 3); out.endc3 = callouts().endc;
    deck.goto(10, 1); out.asd1 = callouts().asd; out.asideShown = asideShown();
    deck.goto(12, 0); out.nark0 = callouts().nark;
    deck.goto(12, 1); out.nark1 = callouts().nark;
    deck.goto(12, 2); out.nark2 = callouts().nark;
    deck.goto(12, 3); out.nark3 = callouts().nark;
    deck.goto(11, 1);
  }
  out.print = location.search === '?print' ? callouts() : null;
  // the fit runs when the guardrail's watch first measures the slide
  setTimeout(() => {
    if (!location.search) out.long1 = callouts().long;
    if (location.search) { document.getElementById('test-sink').textContent = 'DECKLIGHT-LINES-RESULTS ' + JSON.stringify(out); return; }
    deck.goto(13, 3);
    setTimeout(() => {
      out.narf3 = callouts().narf;
      out.tightBottom = document.getElementById('tight').getBoundingClientRect().bottom;
      document.getElementById('test-sink').textContent = 'DECKLIGHT-LINES-RESULTS ' + JSON.stringify(out);
    }, 300);
  }, 300);
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

// ── callouts (#1182) ────────────────────────────────────────────────────────
{
  const r = run('');
  const seen = (b) => b.each.map((c) => c.seen);
  check('callouts: none before the first step', seen(r.gut0).every((v) => v === 0), JSON.stringify(seen(r.gut0)));
  check('callouts: the step\'s own arrives with it', JSON.stringify(seen(r.gut1)) === '[1,0,0]', JSON.stringify(seen(r.gut1)));
  check('callouts: in a gutter, never over the code', r.gut1.mode === 'gutter' && r.gut1.each.every((c) => c.bracket[0] >= r.gut1.codeRight - 1 && c.label[0] > c.bracket[0]),
    `mode ${r.gut1.mode} code ends ${Math.round(r.gut1.codeRight)}, brackets at ${r.gut1.each.map((c) => Math.round(c.bracket[0]))}`);
  const two = r.gut2.each[1];
  const [top, bottom] = [r.gut2.lines[1][0], r.gut2.lines[2][1]];
  check('callouts: the bracket spans the step\'s lines', Math.abs(two.bracket[1] - top) < 8 && Math.abs(two.bracket[2] - bottom) < 8,
    `bracket ${Math.round(two.bracket[1])}-${Math.round(two.bracket[2])}, lines ${Math.round(top)}-${Math.round(bottom)}`);
  const mid = (two.label[1] + two.label[2]) / 2;
  check('callouts: the label is level with the middle of its lines', Math.abs(mid - (top + bottom) / 2) < 3, `label middle ${Math.round(mid)}, lines ${Math.round((top + bottom) / 2)}`);
  check('callouts: data-callouts-keep keeps the earlier one, muted', JSON.stringify(seen(r.gut2)) === '[1,1,0]' && r.gut2.each[0].color !== r.gut2.each[1].color
    && r.gut2.each[0].bracket[3] !== r.gut2.each[1].bracket[3], `${JSON.stringify(seen(r.gut2))} ${r.gut2.each[0].color} vs ${r.gut2.each[1].color}`);
  check('callouts: kept, the last step shows every one', seen(r.gut3).every((v) => v === 1), JSON.stringify(seen(r.gut3)));
  check('callouts: a narrow block shows it under its lines', r.nar1.mode === 'under' && JSON.stringify(seen(r.nar1)) === '[1,0]'
    && r.nar1.each[0].label[1] >= r.nar1.lines[0][1] - 1, `mode ${r.nar1.mode} label top ${Math.round(r.nar1.each[0].label[1])}, line ends ${Math.round(r.nar1.lines[0][1])}`);
  check('callouts: under the lines, it pushes nothing', r.nar0.height === r.nar1.height && r.nar1.height === r.nar2.height, `${r.nar0.height} ${r.nar1.height} ${r.nar2.height}`);
  check('callouts: a narrow block shows one at a time', JSON.stringify(seen(r.nar2)) === '[0,1]', JSON.stringify(seen(r.nar2)));
  check('callouts: a walk that ends lit keeps its last one while it is the click', JSON.stringify(seen(r.endc2)) === '[0,1]', JSON.stringify(seen(r.endc2)));
  check('callouts: and it leaves with the dimming', seen(r.endc3).every((v) => v === 0), JSON.stringify(seen(r.endc3)));
  check('callouts: an aside\'s label keeps its markup, and the aside is not shown', r.asd1.each[0].strong && r.asd1.each[0].seen === 1 && !r.asideShown,
    `strong=${r.asd1.each[0].strong} seen=${r.asd1.each[0].seen} aside shown=${r.asideShown}`);
  check('callouts: data-fit sizes the code to the left of the gutter', r.long1.mode === 'gutter' && r.long1.codeFits, `mode ${r.long1.mode} fits ${r.long1.codeFits}`);
  check('callouts: a narrow block shows no legend for one at a time', r.nar1.mode === 'under' && !r.nar1.legend.shown && r.nar1.each.every((c) => !c.mark.shown),
    `mode ${r.nar1.mode} legend ${r.nar1.legend.shown}`);
  // a narrow block, kept: numbered markers beside the lines, the labels listed under the code
  const k = (x) => x.legend.each.map((e) => e.seen);
  check('callouts: narrow and kept, it numbers them in a legend', r.nark1.mode === 'legend' && r.nark1.legend.shown
    && r.nark1.legend.each.map((e) => e.mark).join() === '1,2,3' && r.nark1.legend.each[1].text === 'Two and three',
    `mode ${r.nark1.mode} ${JSON.stringify(r.nark1.legend.each.map((e) => [e.mark, e.text]))}`);
  check('callouts: narrow and kept, the legend fills as the walk goes', JSON.stringify(k(r.nark0)) === '[0,0,0]' && JSON.stringify(k(r.nark1)) === '[1,0,0]'
    && JSON.stringify(k(r.nark2)) === '[1,1,0]' && JSON.stringify(k(r.nark3)) === '[1,1,1]',
    [r.nark0, r.nark1, r.nark2, r.nark3].map((x) => JSON.stringify(k(x))).join(' '));
  check('callouts: narrow and kept, earlier ones muted', r.nark3.legend.each[0].color !== r.nark3.legend.each[2].color && r.nark3.each[0].color !== r.nark3.each[2].color,
    `${r.nark3.legend.each[0].color} vs ${r.nark3.legend.each[2].color}`);
  check('callouts: narrow and kept, the markers arrive with their steps', JSON.stringify(seen(r.nark2)) === '[1,1,0]'
    && r.nark2.each.every((c) => c.mark.shown && !c.labelShown), JSON.stringify(seen(r.nark2)));
  check('callouts: narrow and kept, markers beside the code, never over it', r.nark3.each.every((c) => c.mark.left >= r.nark3.codeRight - 1 && c.bracket[0] >= r.nark3.codeRight - 1),
    `code right ${Math.round(r.nark3.codeRight)}, markers ${r.nark3.each.map((c) => Math.round(c.mark.left))}`);
  {
    const [top, bottom] = [r.nark3.lines[1][0], r.nark3.lines[2][1]];
    const two = r.nark3.each[1];
    check('callouts: narrow and kept, a marker is level with the middle of its lines', Math.abs(two.mark.mid - (top + bottom) / 2) < 3
      && Math.abs(two.bracket[1] - top) < 8 && Math.abs(two.bracket[2] - bottom) < 8, `marker ${Math.round(two.mark.mid)}, lines ${Math.round((top + bottom) / 2)}`);
  }
  check('callouts: narrow and kept, the legend is under the code, inside the block', r.nark3.legend.top >= r.nark3.codeBottom - 1 && r.nark3.legend.bottom <= r.nark3.preBottom + 1,
    `code bottom ${Math.round(r.nark3.codeBottom)} legend ${Math.round(r.nark3.legend.top)}-${Math.round(r.nark3.legend.bottom)} block ${Math.round(r.nark3.preBottom)}`);
  check('callouts: narrow and kept, it pushes nothing as the walk goes', new Set([r.nark0, r.nark1, r.nark2, r.nark3].map((x) => x.height)).size === 1,
    [r.nark0, r.nark1, r.nark2, r.nark3].map((x) => x.height).join(' '));
  check('callouts: narrow and kept, data-fit shrinks the code to leave the legend room', r.narf3.mode === 'legend' && +r.narf3.scale < 1
    && r.narf3.preBottom <= r.tightBottom + 1 && r.narf3.codeFits,
    `scale ${r.narf3.scale} block bottom ${Math.round(r.narf3.preBottom)} room ${Math.round(r.tightBottom)} fits ${r.narf3.codeFits}`);
}

// ── print: every stepped block whole, unless it asks for its last step ─────
{
  const r = run('?print');
  check('print: a walk that ends lit is whole', LIT(r.at.lit) && LIT(r.at.then), `lit ${r.at.lit} then ${r.at.then}`);
  check('print: a plain walk is whole too', LIT(r.at.plain), `opacity ${r.at.plain}`);
  check('print: data-lines-print="last" keeps the last step', DIM(r.at.last), `opacity ${r.at.last}`);
  const shown = (b) => b.each.map((c) => c.seen);
  check('print: every callout in a gutter, at full ink', [r.print.gut, r.print.endc].every((b) => shown(b).every((v) => v === 1))
    && new Set(r.print.gut.each.map((c) => c.color)).size === 1, `${JSON.stringify(shown(r.print.gut))} ${JSON.stringify(shown(r.print.endc))}`);
  check('print: a narrow block prints every label, numbered in a legend', r.print.nar.mode === 'legend' && r.print.nar.legend.each.every((e) => e.seen === 1)
    && shown(r.print.nar).every((v) => v === 1) && r.print.nar.each.every((c) => c.mark.shown && !c.labelShown),
    `mode ${r.print.nar.mode} legend ${JSON.stringify(r.print.nar.legend.each.map((e) => e.seen))} markers ${JSON.stringify(shown(r.print.nar))}`);
  check('print: a narrow kept block, every label at full ink', r.print.nark.legend.each.every((e) => e.seen === 1)
    && new Set(r.print.nark.legend.each.map((e) => e.color)).size === 1, JSON.stringify(r.print.nark.legend.each.map((e) => e.color)));
  check('print: a narrow block\'s legend is inside the block', r.print.nar.legend.bottom <= r.print.nar.preBottom + 1 && r.print.nar.legend.top >= r.print.nar.codeBottom - 1,
    `legend ${Math.round(r.print.nar.legend.top)}-${Math.round(r.print.nar.legend.bottom)} block ${Math.round(r.print.nar.preBottom)}`);
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
