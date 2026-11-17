#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation (SPEC DECK_ANATOMY, #1179), as a browser draws it. Each turn
 * is a bubble labelled with its role (a tool's name after it), the user's on
 * the right and everyone else's on the left; a thought is italic, a tool's
 * turn monospace and, when it parses as JSON or reads as a call, coloured as
 * code. It builds one turn a click.
 *
 * A conversation taller than its slide's room scrolls inside its box and
 * keeps the newest turn in view as it builds, alone on a slide (where the
 * slide's column gives it the room left) and in a split column (where the
 * runtime holds it to the room); the slide is never clipped. `?print` shows
 * it whole, shrunk to fit, every turn inside the page. A turn in a concept,
 * its own or its role's (`roleConcepts`), is the concept's slot. All of it is
 * applied with no frame painted: a headless render paints none.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-conversation-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const LONG = [
  '<p data-role="system">You are the support agent.</p>',
  '<p data-role="user">Where is my order 4417?</p>',
  '<p data-role="agent" data-kind="thought">I need the order\'s latest status, then the carrier\'s.</p>',
  '<p data-role="agent" data-kind="tool-call">get_order(4417)</p>',
  `<p data-role="tool" data-name="get_order">{
        "status": "delayed",
        "carrier": "DHL",
        "eta": "Friday"
      }</p>`,
  '<p data-role="agent" data-kind="tool-call">track_parcel("DHL", "JD0144")</p>',
  '<p data-role="tool" data-name="track_parcel">{ "last_scan": "Leipzig hub", "delay": "weather" }</p>',
  '<p data-role="agent">It is delayed by weather at the Leipzig hub and should arrive Friday.</p>',
  '<p data-role="user">Can I change the address?</p>',
  '<p data-role="agent" data-kind="tool-call">update_address(4417, "12 Rue Oberkampf")</p>',
  '<p data-role="tool" data-name="update_address">{ "ok": true }</p>',
  '<p data-role="agent">Done: it will go to 12 Rue Oberkampf.</p>',
].join('\n  ');

const deckFile = (theme) => {
  const file = path.join(dir, `deck-${theme}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, `themes/${theme}.css`)}">
</head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><h2>Short</h2><div class="conversation" id="short" data-build>
  <p data-role="user">Where is my order 4417?</p>
  <p data-role="agent" data-kind="thought">I need the order's latest status.</p>
  <p data-role="agent" data-kind="tool-call">get_order(4417)</p>
  <p data-role="tool" data-name="get_order">{ "status": "delayed", "eta": "Friday" }</p>
  <p data-role="agent">It is delayed and should arrive Friday.</p>
</div></section>
<section><h2>Long</h2><div class="conversation" id="long" data-build>
  ${LONG}
</div></section>
<section data-layout="split"><h2>Long, in a column</h2><div class="conversation" id="side" data-build>
  ${LONG}
</div><div><ul><li>Think</li><li>Act</li><li>Observe</li></ul></div></section>
<section><h2>Concepts</h2><div class="conversation" id="concepts" data-build="highlight">
  <p data-role="user">Summarise it.</p>
  <p data-role="agent" data-concept="agent">The cache fell over.</p>
  <p data-role="planner">Plan the fix.</p>
  <p data-role="tool" data-name="logs" data-concept="tools">{ "errors": 1423 }</p>
  <p data-role="agent">Words, (not a call).</p>
</div></section>
<section><h2>End</h2></section>
</div>
<pre id="test-sink">running…</pre>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
const deck = Decklight.init({ hash: true, transition: 'none', roleConcepts: { planner: 'agent' } });
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const conv = (id) => document.getElementById(id);
const turns = (id) => [...conv(id).children];
const label = (el) => getComputedStyle(el, '::before').content;
// the turn the conversation should be showing: inside its visible box, top to bottom
const inView = (id, i) => {
  const c = conv(id).getBoundingClientRect(), t = turns(id)[i].getBoundingClientRect();
  return t.top >= c.top - 1 && t.bottom <= c.bottom + 1;
};
const slideState = () => { const s = document.querySelector('.decklight-stage > section.active'); return { overflow: s.getAttribute('data-overflow'), dense: s.getAttribute('data-dense') }; };
const inside = (el, box) => { const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1; };
const out = { url: location.search };
(async () => {
  await wait(300);
  if (!location.search) {
    // the bubbles: who speaks, which side, what kind
    deck.goto(2, 5); await wait(200);
    const t = turns('short');
    out.steps = deck._records[1].groups.length;
    out.labels = t.map(label);
    const r = t.map((n) => n.getBoundingClientRect());
    out.userRight = r[0].right > Math.max(...r.slice(1).map((x) => x.right)) && r[0].left > Math.max(...r.slice(1).map((x) => x.left));
    out.othersLeft = r.slice(1).every((x) => Math.abs(x.left - r[1].left) < 1);
    out.thought = getComputedStyle(t[1]).fontStyle;
    out.mono = [2, 3].map((i) => getComputedStyle(t[i]).fontFamily !== getComputedStyle(t[4]).fontFamily);
    out.coded = t.map((n) => n.classList.contains('turn-code'));
    out.codeSpans = t[3].querySelectorAll('.hljs-attr, .hljs-string').length;
    out.callSpans = t[2].querySelectorAll('[class^="hljs-"]').length;
    out.wordsKept = t[3].textContent;
    out.colors = t.map((n) => [getComputedStyle(n).color, getComputedStyle(n).backgroundColor]);
    out.shortSlide = slideState();
    deck.goto(2, 0); out.short0 = t.map((n) => n.getAttribute('data-build-state')).join();
    deck.goto(2, 1); out.short1 = t.map((n) => n.getAttribute('data-build-state')).join();
    // a long one, alone on its slide: the slide's column gives it the room left, it scrolls inside, the newest in view
    deck.goto(3, 0); await wait(200);
    const L = conv('long');
    out.long = { scrolls: L.scrollHeight > L.clientHeight + 20, top0: L.scrollTop, slide: slideState(), steps: deck._records[2].groups.length };
    out.longSeen = [];
    for (const step of [1, 3, 5, 8, 12]) {
      deck.goto(3, step);   // no wait: the scroll is set as the step is
      out.longSeen.push({ step, top: Math.round(L.scrollTop), newest: inView('long', step - 1), faded: L.classList.contains('conversation-scrolled') });
    }
    deck.goto(3, 4);
    out.longBack = { top: Math.round(L.scrollTop), newest: inView('long', 3) };
    out.longEnd = slideState();
    // in a split column: held to the room by the runtime, the newest in view
    deck.goto(4, 0); await wait(300);
    const S = conv('side');
    out.side = { held: S.style.maxHeight, scrolls: S.scrollHeight > S.clientHeight + 20, slide: slideState(), inSlide: inside(S, S.closest('section')) };
    out.sideSeen = [];
    for (const step of [2, 7, 12]) {
      deck.goto(4, step);
      out.sideSeen.push({ step, newest: inView('side', step - 1) });
    }
    // a slide arrived at its last step (a step back from the next): the newest in view at once
    deck.goto(5, 0); await wait(100);
    deck.goto(4, 12, { direction: 'back' });
    out.sideArrived = inView('side', 11);
    // concepts: its own, and its role's from roleConcepts; a highlight build lights one
    deck.goto(5, 2); await wait(100);
    const c = turns('concepts');
    out.concept = c.map((n) => n.style.getPropertyValue('--turn-concept'));
    out.conceptClass = c.map((n) => n.classList.contains('turn-concept'));
    out.conceptBg = getComputedStyle(c[1]).backgroundColor !== getComputedStyle(c[0]).backgroundColor;
    out.highlight = c.map((n) => n.getAttribute('data-build-state')).join();
    out.wordsNotCode = !c[4].classList.contains('turn-code');
  } else {
    // print: whole, shrunk to fit, every turn on its page
    out.printed = ['short', 'long', 'side', 'concepts'].map((id) => {
      const el = conv(id), sec = el.closest('section');
      return { id, scale: el.getAttribute('data-fit-scale'), whole: el.scrollHeight <= el.clientHeight + 1,
        turnsIn: turns(id).every((t) => inside(t, sec)), shown: turns(id).every((t) => getComputedStyle(t).opacity === '1'), overflow: sec.getAttribute('data-overflow') };
    });
  }
  document.getElementById('test-sink').textContent = 'DECKLIGHT-CONVERSATION-RESULTS ' + JSON.stringify(out);
})();
</script></body></html>`);
  return file;
};

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${detail}`);
};
const run = (file, query) => resultsFrom(
  dumpDom(`file://${file}${query}`, { fileAccess: true, budget: 6000, quietStderr: true, who: 'conversation-render' }), 'CONVERSATION', query);

// ── a light and a dark theme ───────────────────────────────────────────────
for (const theme of ['porcelain', 'aurora']) {
  const r = run(deckFile(theme), '');
  const t = `${theme}:`;
  check(`${t} each turn says who speaks, a tool its name, a thought and a call theirs`,
    JSON.stringify(r.labels) === JSON.stringify(['"user"', '"agent · thinking"', '"agent · calls a tool"', '"tool · get_order"', '"agent"']), r.labels.join(' | '));
  check(`${t} the user on the right, everyone else on the left`, r.userRight && r.othersLeft, `user right=${r.userRight}, others aligned=${r.othersLeft}`);
  check(`${t} a thought is italic, a call and a tool's answer monospace`, r.thought === 'italic' && r.mono.every(Boolean), `${r.thought} ${r.mono}`);
  check(`${t} a call and JSON are coloured as code, speech is not`, r.coded.join() === 'false,false,true,true,false' && r.codeSpans >= 4 && r.callSpans >= 1,
    `${r.coded} · ${r.codeSpans} JSON tokens, ${r.callSpans} call tokens`);
  check(`${t} the words are kept as written`, r.wordsKept === '{ "status": "delayed", "eta": "Friday" }', r.wordsKept);
  check(`${t} every bubble has its own ink on its own ground`, r.colors.every(([fg, bg]) => fg !== bg), r.colors.map((c) => c.join(' on ')).join(' · '));
  check(`${t} it builds one turn a click`, r.steps === 5 && r.short0 === 'pending,pending,pending,pending,pending' && r.short1 === 'current,pending,pending,pending,pending',
    `${r.steps} steps: ${r.short0} → ${r.short1}`);
  check(`${t} a short one is neither crowded nor clipped`, !r.shortSlide.dense && !r.shortSlide.overflow, JSON.stringify(r.shortSlide));
  check(`${t} a long one scrolls inside its box, from its top, its slide never clipped`,
    r.long.scrolls && r.long.top0 === 0 && !r.long.slide.overflow && !r.longEnd.overflow && !r.long.slide.dense && r.long.steps === 12, JSON.stringify(r.long));
  check(`${t} as it builds, the newest turn is in view`, r.longSeen.every((s) => s.newest) && r.longSeen.at(-1).top > r.longSeen[0].top,
    r.longSeen.map((s) => `${s.step}:${s.top}${s.newest ? '' : '✗'}`).join(' '));
  check(`${t} scrolled past its start, its top edge fades`, !r.longSeen[0].faded && r.longSeen.at(-1).faded, r.longSeen.map((s) => s.faded).join());
  check(`${t} a step back shows the turn it is on`, r.longBack.newest, JSON.stringify(r.longBack));
  check(`${t} in a split column, held to the room and scrolling, never clipping`,
    /px$/.test(r.side.held) && r.side.scrolls && !r.side.slide.overflow && r.side.inSlide, JSON.stringify(r.side));
  check(`${t} in a split column, the newest turn in view`, r.sideSeen.every((s) => s.newest) && r.sideArrived,
    `${r.sideSeen.map((s) => `${s.step}:${s.newest}`).join(' ')} arrived=${r.sideArrived}`);
  check(`${t} a turn's concept, its own or its role's, is its diagram slot`,
    r.concept[0] === '' && /--d-fill-\d/.test(r.concept[1]) && r.concept[2] === r.concept[1] && /--d-fill-\d/.test(r.concept[3]) && r.conceptClass.join() === 'false,true,true,true,false' && r.conceptBg,
    r.concept.map((c) => c || '-').join(' '));
  check(`${t} a highlight build lights one turn, the rest stay`, r.highlight === 'done,current,pending,pending,pending', r.highlight);
  check(`${t} a tool's words that are no call stay words`, r.wordsNotCode, String(r.wordsNotCode));
}

// ── print: every conversation whole, shrunk to fit its page ────────────────
{
  const r = run(deckFile('aurora'), '?print');
  const by = Object.fromEntries(r.printed.map((p) => [p.id, p]));
  check('print: a short one at its own size', by.short.scale === '1' && by.short.whole, JSON.stringify(by.short));
  check('print: a long one shrunk to fit, whole', +by.long.scale < 1 && by.long.whole && by.side.whole && +by.side.scale < 1,
    `long ${by.long.scale}, side ${by.side.scale}`);
  check('print: every turn shown, inside its page, nothing clipped', r.printed.every((p) => p.turnsIn && p.shown && !p.overflow),
    r.printed.map((p) => `${p.id} in=${p.turnsIn} shown=${p.shown} overflow=${p.overflow}`).join(', '));
}

if (bad) {
  console.log(`\n${bad} conversation check(s) failed`);
  process.exit(1);
}
console.log('\nconversation-render: all checks passed');
