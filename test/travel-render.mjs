#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A token along a wire (SPEC BUILD_ENTRANCES, travel, #1180), as a browser
 * draws it. A build step names a wire of its svg (`data-along-wire`); when it
 * plays, a token leaves the wire's start and follows its route to its end,
 * above the wire and below the label written after it, in the wire's colour
 * (a chip with `data-label`, a concept's fill with `data-concept`).
 *
 * A headless render never paints a frame, so the trip is driven here by its
 * own clock (`deck._travel.tick`): the end state of every step is put on the
 * page at once (nothing shown, or the token at the end with `stay`), and a
 * frame moves the token on its way there. Arrival fades it, leaves it, or
 * pulses the node it reaches; a repeating token goes again until the next
 * step; a step back takes it away; the route it follows is the wire's as it
 * runs now; reduced motion, a deep link, the overview and the printed page
 * show only the end state.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-travel-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const deckFile = (theme) => {
  const file = path.join(dir, `deck-${theme}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, `themes/${theme}.css`)}">
</head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><h2>Flow</h2>
<svg id="flow" viewBox="0 0 800 300" width="800">
  <g data-node="orders"><rect x="20" y="120" width="140" height="60" rx="8" style="fill: var(--d-fill-2); stroke: var(--d-stroke)" stroke-width="2"/><text x="90" y="150" text-anchor="middle" dominant-baseline="central" font-size="16">Orders</text></g>
  <g data-node="topic" id="topic"><rect id="topic-box" x="330" y="120" width="140" height="60" rx="8" style="fill: var(--d-fill-3); stroke: var(--d-stroke)" stroke-width="2"/><text x="400" y="150" text-anchor="middle" dominant-baseline="central" font-size="16">Topic</text></g>
  <g data-node="agent"><rect id="agent-box" x="640" y="20" width="140" height="60" rx="8" style="fill: var(--d-fill-1); stroke: var(--d-stroke)" stroke-width="2"/><text x="710" y="50" text-anchor="middle" dominant-baseline="central" font-size="16">Agent</text></g>
  <line id="w1" data-from="orders" data-to="topic" data-wire="orders-topic" x1="160" y1="150" x2="330" y2="150" stroke-width="2" style="stroke: var(--d-stroke)"/>
  <path id="w2" data-from="topic" data-to="agent" data-route="elbow" data-wire="topic-agent" d="M 470 150 L 710 150 L 710 80" fill="none" stroke-width="2" style="stroke: var(--d-accent)"/>
  <text id="w1-label" data-on-wire="orders-topic" x="245" y="150" text-anchor="middle" dominant-baseline="central" font-size="12">events</text>
  <g id="t1" data-build="travel" data-along-wire="orders-topic" data-label="order 4417" data-arrive="pulse"></g>
  <g id="t2" data-build="travel" data-along-wire="topic-agent" data-arrive="stay"></g>
  <g id="t3" data-build="travel" data-along-wire="orders-topic" data-concept="event" data-build-with></g>
  <g id="t4" data-build="travel" data-along-wire="topic-agent" data-travel-repeat data-travel-ms="800"></g>
  <g id="t5" data-build="travel" data-along-wire="nowhere"></g>
</svg></section>
<section><h2>In a drawing</h2>
<svg viewBox="0 0 400 100" width="400" data-build="draw">
  <rect data-node="a" x="10" y="30" width="80" height="40" style="fill: var(--d-fill-1); stroke: var(--d-stroke)"/>
  <rect data-node="b" x="300" y="30" width="80" height="40" style="fill: var(--d-fill-2); stroke: var(--d-stroke)"/>
  <line data-from="a" data-to="b" data-wire="a-b" x1="90" y1="50" x2="300" y2="50" stroke-width="2" style="stroke: var(--d-stroke)"/>
  <g id="d1" data-build="travel" data-along-wire="a-b" data-arrive="stay"></g>
</svg></section>
<section><h2>End</h2></section>
</div>
<pre id="test-sink">running…</pre>
<script>
// a runner may ask for reduced motion (a CI Mac does): the trip is what is under test, so motion is on here, and the reduced check asks for it below
const realMM = window.matchMedia.bind(window);
window.matchMedia = (q) => (/reduced-motion/.test(q) ? { matches: false, media: q, addEventListener() {}, removeEventListener() {} } : realMM(q));
</script>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'none' });
const T = deck._travel;
// diagram ids are namespaced at init (SVG_DIAGRAMS): found by their ending
const $ = (id) => document.getElementById(id) ?? document.querySelector('[id$="-' + id + '"]');
const tok = (id) => T.tokenOf($(id));
const xy = (t) => { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(t?.getAttribute('transform') ?? ''); return m ? { x: +m[1], y: +m[2] } : null; };
const look = (id) => { const t = tok(id); if (!t) return null; const cs = getComputedStyle(t); return { on: t.classList.contains('travel-on'), visible: cs.visibility === 'visible' && +(t.style.opacity || 1) > 0, at: xy(t), opacity: t.style.opacity }; };
const tripOf = (id) => T.running().find((r) => r.el === $(id));
const out = { url: location.search };
setTimeout(() => {
  try {
  if (!location.search) {
    out.steps = deck._records[1].groups.length;
    deck.goto(2, 0);
    out.made = ['t1', 't2', 't3', 't4'].map((id) => !!tok(id));
    out.none = !!tok('t5');
    out.start = ['t1', 't2', 't3', 't4'].map(look);
    // where the token is drawn: after its wire, before the label written after it
    const t1 = tok('t1');
    const kids = [...$('flow').children];
    out.order = { wire: kids.indexOf($('w1')), token: kids.indexOf(t1), label: kids.indexOf($('w1-label')) };
    out.chip = { words: t1.textContent, shape: t1.firstElementChild.tagName, ink: t1.querySelector('text').style.fill };
    // step 1: the chip travels
    deck.goto(2, 1);
    const r1 = tripOf('t1');
    out.trip = { running: !!r1, dur: r1?.dur, fade: r1?.fade };
    out.leaving = look('t1');
    T.tick(r1.t0 + r1.dur / 2); out.midway = look('t1');
    T.tick(r1.t0 + r1.dur + 1); out.arrived = look('t1');
    out.pulse = $('topic').classList.contains('travel-pulse');
    T.tick(r1.t0 + r1.dur + r1.fade + 5); out.gone = look('t1');
    out.after = { running: T.running().length };
    // step 2: two tokens on one click, one stays, the other (a concept's colour) goes
    deck.goto(2, 2);
    out.two = ['t2', 't3'].map((id) => !!tripOf(id));
    const r2 = tripOf('t2');
    const w1 = getComputedStyle($('w1')).stroke;
    out.colours = { dot: getComputedStyle(tok('t2').firstElementChild).fill, wire2: getComputedStyle($('w2')).stroke, concept: getComputedStyle(tok('t3').firstElementChild).fill, wire1: w1 };
    T.tick(r2.t0 + r2.dur + r2.fade + 5);
    out.stayed = look('t2'); out.went = look('t3');
    out.agentEnd = { x: 710, y: 80 };
    // step 3: it keeps flowing while its click is on
    deck.goto(2, 3);
    const r4 = tripOf('t4');
    const t0 = r4.t0;
    T.tick(t0 + r4.dur * 3 + r4.fade * 2);
    out.flowing = { running: !!tripOf('t4'), again: tripOf('t4')?.t0 !== t0 };
    deck.goto(2, 4);
    out.stopped = { running: !!tripOf('t4'), look: look('t4') };
    // a step back takes a token away
    deck.goto(2, 1);
    out.back = { t2: look('t2'), t3: look('t3') };
    // a deep link or arriving backwards: the end state at once, nothing travelling
    deck.goto(3, 0); deck.goto(2, 2, { force: true });
    out.instant = { running: T.running().length, t2: look('t2') };
    // the route as it runs now: a node moved, the token that stayed follows its wire's end
    $('agent-box').setAttribute('x', '600'); $('agent-box').setAttribute('y', '200');
    deck.refreshSlide($('flow').closest('section'), { connectors: $('flow'), scan: true, relayout: false });
    out.moved = { d: $('w2').getAttribute('d'), t2: look('t2') };
    // the overview shows a slide as it ends: mid-trip, a token that goes is not in the picture
    deck.goto(2, 0); deck.goto(2, 1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    const clones = [...document.querySelectorAll('.ov-clone .travel-token')];
    const shown = (c) => getComputedStyle(c).visibility === 'visible';
    out.overview = { clones: clones.length, goes: clones.filter((c) => c.getAttribute('data-arrive') !== 'stay' && shown(c)).length,
      stays: clones.filter((c) => c.getAttribute('data-arrive') === 'stay' && shown(c)).length, running: T.running().length };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // a draw build's container: the token is a step of its own, and the stroke is not one twice
    deck.goto(3, 0);
    out.drawn = { steps: deck._records[2].groups.length, styles: deck._records[2].steps.map((s) => s.el.getAttribute('data-build-style')) };
    deck.goto(3, 4); const rd = tripOf('d1'); if (rd) T.tick(rd.t0 + rd.dur + 1);
    out.drawnStay = look('d1');
    // reduced motion: nothing travels, the end state stands
    deck.goto(2, 0);
    window.matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    deck.goto(2, 1); out.reduced1 = { running: T.running().length, t1: look('t1') };
    deck.goto(2, 2); out.reduced2 = { running: T.running().length, t2: look('t2') };
  } else {
    out.printed = ['t1', 't2', 't3', 't4', 'd1'].map(look);
    out.running = T.running().length;
  }
  } catch (e) { out.error = String(e?.stack ?? e); }
  document.getElementById('test-sink').textContent = 'DECKLIGHT-TRAVEL-RESULTS ' + JSON.stringify(out);
}, 300);
</script></body></html>`);
  return file;
};

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${detail}`);
};
const run = (file, query) => resultsFrom(
  dumpDom(`file://${file}${query}`, { fileAccess: true, budget: 4000, quietStderr: true, who: 'travel-render' }), 'TRAVEL', query);
const near = (a, b, d = 1.5) => !!a && !!b && Math.abs(a.x - b.x) <= d && Math.abs(a.y - b.y) <= d;
const j = (v) => JSON.stringify(v);

for (const theme of ['porcelain', 'midnight']) {
  const r = run(deckFile(theme), '');
  const t = `${theme}:`;
  if (r.error) { check(`${t} the page ran`, false, r.error); continue; }
  check(`${t} five travel steps, two of them on one click: four clicks`, r.steps === 4, `${r.steps}`);
  check(`${t} a token is made for each step naming a wire, none for one that names none`, r.made.every(Boolean) && !r.none, j({ made: r.made, none: r.none }));
  check(`${t} before its click, no token shows`, r.start.every((s) => !s.on && !s.visible), j(r.start));
  check(`${t} the token sits after its wire and before the label written after it`, r.order.wire < r.order.token && r.order.token < r.order.label, j(r.order));
  check(`${t} data-label makes a chip with those words`, r.chip.shape === 'rect' && r.chip.words === 'order 4417' && /var\(--(bg|d-text)\)/.test(r.chip.ink), j(r.chip));
  check(`${t} its click starts a trip at the deck's pace (4 build durations)`, r.trip.running && Math.abs(r.trip.dur - 1200) < 1 && Math.abs(r.trip.fade - 300) < 1, j(r.trip));
  check(`${t} it leaves the wire's start, shown`, r.leaving.on && r.leaving.at && r.leaving.at.x < 215 && r.leaving.at.x > 160 && Math.abs(r.leaving.at.y - 150) < 1, j(r.leaving));
  check(`${t} halfway through the time, it is along the wire`, r.midway.on && r.midway.at.x > r.leaving.at.x + 20 && r.midway.at.x < 300, j(r.midway));
  check(`${t} at the end, against the node it reaches`, r.arrived.at.x > 270 && r.arrived.at.x <= 330 && Math.abs(r.arrived.at.y - 150) < 1, j(r.arrived));
  check(`${t} pulse: the node the wire goes to pulses once`, r.pulse, `${r.pulse}`);
  check(`${t} fade: once arrived it fades, and the trip ends`, !r.gone.on && r.after.running === 0, j({ gone: r.gone, after: r.after }));
  check(`${t} with data-build-with, both tokens travel on one click`, r.two.every(Boolean), j(r.two));
  check(`${t} a dot is in its wire's colour; a concept's token in the concept's`, r.colours.dot === r.colours.wire2 && r.colours.concept !== r.colours.wire1, j(r.colours));
  check(`${t} stay: the token stays at the wire's end`, r.stayed.on && r.stayed.visible && near(r.stayed.at, { x: 710, y: 87 }, 3), j(r.stayed));
  check(`${t} fade: the other one is gone`, !r.went.on, j(r.went));
  check(`${t} repeat: it goes again while its click is on`, r.flowing.running && r.flowing.again, j(r.flowing));
  check(`${t} repeat: the next click stops it, and nothing is left`, !r.stopped.running && !r.stopped.look.on, j(r.stopped));
  check(`${t} a step back takes the tokens away`, !r.back.t2.on && !r.back.t3.on, j(r.back));
  check(`${t} instant application: the end state at once, nothing travelling`, r.instant.running === 0 && r.instant.t2.on && near(r.instant.t2.at, { x: 710, y: 87 }, 3), j(r.instant));
  check(`${t} the route as it runs now: a node moved, the token at its new end`, r.moved.t2.on && near(r.moved.t2.at, { x: 670, y: 193 }, 4), j(r.moved));
  check(`${t} the overview, as each slide ends: a token mid-trip is not in it, one that stays is`, r.overview.clones >= 5 && r.overview.goes === 0 && r.overview.stays === 2 && r.overview.running === 0, j(r.overview));
  check(`${t} in a draw build, a travel child is a step of its own, after the strokes`, r.drawn.steps === 4 && r.drawn.styles.join() === 'draw,draw,draw,travel', j(r.drawn));
  check(`${t} … and stays at the end of the wire it names`, r.drawnStay.on && near(r.drawnStay.at, { x: 293, y: 50 }, 3), j(r.drawnStay));
  check(`${t} reduced motion: nothing travels, nothing is left (fade)`, r.reduced1.running === 0 && !r.reduced1.t1.on, j(r.reduced1));
  check(`${t} reduced motion: a token that stays is at the end`, r.reduced2.running === 0 && r.reduced2.t2.on, j(r.reduced2));
}

// ── print: the end of every step, nothing travelling ───────────────────────
{
  const r = run(deckFile('midnight'), '?print');
  if (r.error) check('print: the page ran', false, r.error);
  const [t1, t2, t3, t4, d1] = r.printed;
  check('print: a token that stays is at its end', t2.on && d1.on, j({ t2, d1 }));
  check('print: a token that goes is not printed', !t1.on && !t3.on && !t4.on, j({ t1, t3, t4 }));
  check('print: nothing travels', r.running === 0, `${r.running}`);
}

if (bad) {
  console.error(`\ntravel-render: ${bad} check(s) failed`);
  process.exit(1);
}
console.log('\ntravel-render: all checks passed');
