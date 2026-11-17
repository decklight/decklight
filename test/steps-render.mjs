#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A run of slides that shows where it is (SPEC DECK_ANATOMY, #1188), as a
 * browser draws it. Every slide of a run carries its strip: the groups in
 * order, its own in the theme's ink, the ones done muted, and "3 of 7" when
 * the run is counted, over the slides an audience sees. The strip sits in the
 * slide's top padding and meets no content (the fit guardrail is not set off,
 * a title-only slide is not pinned by it), a slide inserted or regrouped
 * renumbers the run, the slide finder folds the run's slides under their
 * groups, the printed page and a still show it, and a design system's
 * template holds it in its steps slot.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-steps-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// a design system on the page, as the servers inject one (DESIGN_SYSTEMS): a template with a steps slot
const DS = `<script type="application/json" data-design-system-meta="acme">{"name":"acme","version":"1.0.0","title":"Acme"}</script>
<template data-design-system-templates="acme"><template data-template="walk" data-title="Walk">
  <div class="acme-walk"><div data-slot="steps"></div><div data-slot="title" data-slot-hint="h2"></div><div data-slot="body" data-slot-default></div></div>
</template></template>`;

const deckFile = (theme) => {
  const file = path.join(dir, `deck-${theme}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, `themes/${theme}.css`)}">
${DS}
</head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section data-module="Build it" data-steps="Foundation, Fresh context, Tools, The agent" data-steps-count><h2>Start with a model call</h2><p>The smallest thing that answers</p>
  <ul><li>One request</li><li>One response</li><li>Nothing kept</li><li>Nothing remembered</li><li>Nothing learned</li><li>Nothing else</li></ul></section>
<section><h2>A title alone</h2></section>
<section data-step="fresh context" data-layout="split"><h2>Fresh context</h2><ul><li>system</li><li>history</li></ul><ul><li>user</li><li>tools</li></ul></section>
<section data-hidden data-step="Tools"><h2>Hidden aside</h2><p>not presented</p></section>
<section data-step="Tools" data-layout="top"><h2>Tools at the top</h2><ul><li>search</li><li>fetch</li><li>run code</li><li>write a file</li><li>ask a person</li><li>wait</li><li>retry</li></ul></section>
<section data-step="The agent" data-template="acme/walk"><h2 data-slot="title">The loop</h2><p>Think, act, look</p></section>
<section data-steps-end><h2>After the run</h2></section>
<section><nav class="steps"><ol><li>Plan</li><li>Ship</li></ol></nav><h2>A listed run</h2></section>
<section data-step="Ship"><h2>Ship it</h2></section>
<section data-module="Next"><h2>The next chapter</h2></section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'none' });
const stage = document.querySelector('.decklight-stage');
const secs = () => deck._sections;
const strip = (n) => secs()[n - 1].querySelector('.decklight-steps');
const read = (n) => {
  const s = strip(n);
  if (!s) return null;
  const cur = s.querySelector('.steps-current');
  return {
    groups: [...s.querySelectorAll('.steps-group')].map((g) => g.textContent),
    current: cur?.textContent ?? null,
    done: [...s.querySelectorAll('.steps-done')].map((g) => g.textContent),
    count: s.querySelector('.steps-count')?.textContent ?? null,
    label: s.getAttribute('aria-label'),
    inSlot: s.classList.contains('steps-in-slot'),
  };
};
const rgb = (c) => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; };
const token = (t) => getComputedStyle(document.querySelector('.decklight')).getPropertyValue(t).trim();
// the strip against everything else the slide shows: no overlap, inside the stage, above a pinned title
const clear = (n) => {
  const sec = secs()[n - 1], s = strip(n);
  const r = s.getBoundingClientRect(), st = stage.getBoundingClientRect();
  const k = st.width / 1280;
  const hit = [];
  for (const el of sec.querySelectorAll('h1, h2, h3, p, li, pre, ul, ol, svg, img, .figure, table')) {
    if (el.closest('.decklight-steps, aside, nav.steps') || el.contains(s)) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) hit.push(el.tagName + ':' + el.textContent.slice(0, 20));
  }
  return { hit, top: Math.round((r.top - st.top) / k), bottom: Math.round((r.bottom - st.top) / k), inside: r.left >= st.left && r.right <= st.right && r.top >= st.top,
    overflow: sec.getAttribute('data-overflow'), pinned: sec.hasAttribute('data-pinned') };
};
const out = { url: location.search };
setTimeout(() => {
  if (location.search.includes('print')) {
    out.printed = secs().filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.querySelector('.decklight-steps .steps-current')?.textContent ?? '-');
    out.printedCount = [...document.querySelectorAll('.decklight-steps .steps-count')].filter((c) => getComputedStyle(c.closest('section')).display !== 'none').map((c) => c.textContent);
    out.overflow = secs().filter((s) => s.hasAttribute('data-overflow')).length;
  } else if (location.search.includes('capture')) {
    out.still = read(deck.state.slide);
  } else {
    out.per = secs().map((_, i) => read(i + 1));
    out.ink = { current: getComputedStyle(strip(2).querySelector('.steps-current')).color, want: rgb(token('--steps-ink') || token('--accent')),
      done: getComputedStyle(strip(4).querySelector('.steps-done')).color, muted: rgb(token('--muted')) };
    out.clear = {};
    for (const n of [2, 3, 4, 6]) { deck.goto(n, 0); out.clear[n] = clear(n); }
    out.navHidden = getComputedStyle(secs()[8].querySelector('nav.steps')).display;
    // a slide inserted before the run's third slide, saying nothing: it continues Foundation, and every slide after it is renumbered
    const added = document.createElement('section');
    added.innerHTML = '<h2>Inserted</h2>';
    stage.insertBefore(added, secs()[3]);
    deck.sync();
    out.inserted = { added: read(4), next: read(5), last: read(8) };
    // a slide regrouped in place (the Slide tab's Step): its run is drawn again
    secs()[4].setAttribute('data-step', 'Tools');
    deck._redrawSteps();
    out.regrouped = read(5);
    deck.sync();
    out.resynced = secs().map((s) => s.querySelectorAll('.decklight-steps').length).join('');
    // the finder: the run's slides under their groups, inside the chapter
    deck.goto(5, 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    out.finder = [...document.querySelectorAll('.decklight-finder .tp-row')].map((r) => (r.classList.contains('tp-group') ? 'G:' : '') + r.textContent.trim());
    out.finderCurrent = document.querySelector('.decklight-finder .tp-row.tp-selected')?.textContent.trim() ?? null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  document.getElementById('test-sink').textContent = 'DECKLIGHT-STEPS-RESULTS ' + JSON.stringify(out);
}, 400);
</script></body></html>`);
  return file;
};

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${detail}`);
};
const run = (file, query) => resultsFrom(
  dumpDom(`file://${file}${query}`, { fileAccess: true, budget: 4000, quietStderr: true, who: 'steps-render' }), 'STEPS', query);
const GROUPS = 'Foundation,Fresh context,Tools,The agent';

for (const theme of ['porcelain', 'aurora']) {
  const r = run(deckFile(theme), '');
  const t = `${theme}:`;
  const on = r.per.map((p) => (p ? 1 : 0)).join('');
  check(`${t} a strip on every slide of a run, none outside one`, on === '01111110110', on);
  check(`${t} the groups in order, the first slide in the first`, r.per[1].groups.join() === GROUPS && r.per[1].current === 'Foundation' && r.per[1].done.length === 0,
    `${r.per[1].groups.join(' › ')} · ${r.per[1].current}`);
  check(`${t} counted over the slides shown: 1 of 5`, r.per[1].count === '1 of 5' && r.per[1].label === 'Step 1 of 5: Foundation', `${r.per[1].count} "${r.per[1].label}"`);
  check(`${t} no data-step continues the group before`, r.per[2].current === 'Foundation' && r.per[2].count === '2 of 5', `${r.per[2].current} ${r.per[2].count}`);
  check(`${t} a group named in any case is that group; done ones listed`, r.per[3].current === 'Fresh context' && r.per[3].done.join() === 'Foundation' && r.per[3].count === '3 of 5',
    `${r.per[3].current}, done ${r.per[3].done}`);
  check(`${t} a hidden slide keeps its group and takes no number`, r.per[4].current === 'Tools' && r.per[4].count === null && r.per[5].count === '4 of 5', `${r.per[4].count} then ${r.per[5].count}`);
  check(`${t} a template's steps slot holds the strip`, r.per[6].inSlot && r.per[6].current === 'The agent' && r.per[6].count === '5 of 5', JSON.stringify(r.per[6]));
  check(`${t} a nav.steps list declares a run, uncounted`, r.per[8].groups.join() === 'Plan,Ship' && r.per[8].count === null && r.per[9].current === 'Ship'
    && r.per[8].label === 'Plan, 1 of 2', `${r.per[8].groups} "${r.per[8].label}"`);
  check(`${t} the list itself is not shown, nor read as the slide's words`, r.navHidden === 'none', r.navHidden);
  check(`${t} the current group in the theme's steps ink`, r.ink.current === r.ink.want, `${r.ink.current} want ${r.ink.want}`);
  check(`${t} the groups done are muted`, r.ink.done === r.ink.muted, `${r.ink.done} want ${r.ink.muted}`);
  for (const [n, c] of Object.entries(r.clear)) {
    check(`${t} slide ${n}: the strip meets no content, inside the stage`, !c.hit.length && c.inside && c.bottom <= 45 && !c.overflow,
      `${c.top}-${c.bottom}px ${c.hit.join(' ') || 'clear'}${c.overflow ? ' OVERFLOW' : ''}`);
  }
  check(`${t} a title alone is not pinned by the strip`, !r.clear[3].pinned, `pinned=${r.clear[3].pinned}`);
  check(`${t} a slide inserted continues its group, and the run is renumbered`, r.inserted.added.current === 'Foundation' && r.inserted.added.count === '3 of 6'
    && r.inserted.next.count === '4 of 6' && r.inserted.last.count === '6 of 6', `${r.inserted.added.count} ${r.inserted.next.count} ${r.inserted.last.count}`);
  check(`${t} regrouped in place, drawn again`, r.regrouped.current === 'Tools' && r.regrouped.done.join() === 'Foundation,Fresh context', JSON.stringify(r.regrouped));
  check(`${t} a sync draws one strip a slide, never two`, /^0(1)+$/.test(r.resynced.slice(0, 8)) && !/[2-9]/.test(r.resynced), r.resynced);
  const f = r.finder.join(' | ');
  check(`${t} the finder folds the run's slides under their groups, in the chapter`,
    /▾ Build it — module · 10 slides \| G:Foundation · step 1 of 4 · 3 slides \| 2 · Start with a model call \| 3 · A title alone \| 4 · Inserted \| G:Tools · step 3 of 4 · 3 slides \| 5 · Fresh context \| 6 · Hidden aside \| 7 · Tools at the top \| G:The agent/.test(f), f);
  check(`${t} a listed run outside a chapter fold too`, /G:Plan · step 1 of 2 · 1 slide \| 10 · A listed run \| G:Ship/.test(f), f.slice(-140));
  check(`${t} the finder opens on the slide, not its group`, r.finderCurrent === '5 · Fresh context', r.finderCurrent);
}

// ── the printed page and a still: drawn, as on screen ─────────────────────
{
  const r = run(deckFile('aurora'), '?print');
  check('print: every slide of a run its strip, the hidden one left out', r.printed.join(',') === '-,Foundation,Foundation,Fresh context,Tools,The agent,-,Plan,Ship,-', r.printed.join(','));
  check('print: counted as on screen, nothing clipped', r.printedCount.join(',') === '1 of 5,2 of 5,3 of 5,4 of 5,5 of 5' && r.overflow === 0, `${r.printedCount} overflow=${r.overflow}`);
  const s = run(deckFile('porcelain'), '?capture#/4/0');
  check('a still shows it', s.still?.current === 'Fresh context' && s.still?.count === '3 of 5', JSON.stringify(s.still));
}

if (bad) {
  console.error(`\nsteps-render: ${bad} check(s) failed`);
  process.exit(1);
}
console.log('\nsteps-render: all checks passed');
