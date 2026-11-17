#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A slide whose deck fades a box in with its own CSS keyframes has to print
 * with the box in it, and a slide that would still print with a hole has to
 * say so (#1184).
 *
 * The bug is only visible in the PDF. Chrome lays a page out again for print
 * media, and a running CSS animation's value does not survive that: an element
 * whose base style is `opacity: 0` and whose `section.active` rule animates it
 * up printed at its base style, invisible, while every screen render of the
 * same `?print` page (and every `--dump-dom` probe) showed it. So this harness
 * prints a real PDF and compares the keyframed slide's page with the same deck
 * written without the animation; then reads the print, capture and live
 * renders for the state the runtime leaves, and runs `decklight check` on it.
 *
 * Every animation here is slow (a 1s delay, a 3s run) and every probe reads
 * at 600ms of virtual time, inside the delay: an element reading opacity 1
 * there was finished by the runtime, not by the clock.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { dumpDom } from './harness.mjs';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-print-visibility-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const KEYFRAMES = `
  @keyframes kf-in { from { opacity: 0; } to { opacity: 1; } }
  .box { border: 3px solid currentColor; padding: 10px; margin: 8px; }
  .kf, .gone { opacity: 0; }
  /* the shape the report had: hidden at rest, faded in once the slide is on */
  section.active .kf { animation: kf-in 3s ease 1s forwards; }
  /* no fill: on screen too it fades in and drops back out, so print shows it gone */
  section.active .gone { animation: kf-in 3s ease 1s; }
  /* the deck's own loop: it never ends, so it is never finished */
  @keyframes kf-turn { to { transform: rotate(360deg); } }
  section.active .spin { animation: kf-turn 2s linear infinite; }`;
/** The same deck with the boxes simply there: what page 2 should print as. */
const CONTROL = '.box { border: 3px solid currentColor; padding: 10px; margin: 8px; }';

/**
 * 1 cover, 2 keyframed boxes that end visible, 3 a box that ends invisible and
 * one hidden outright, 4 a data-animate loop, 5 a build: the last three are
 * what must NOT change or be reported wrongly.
 */
function deck(name, css, { probe = true } = {}) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}">
<style>${css}</style></head>
<body><div class="decklight">
<section><h1>Cover</h1></section>
<section><h2>Batch vs streaming</h2>
  <div class="box">plain box</div>
  <div class="box kf" id="kf1">keyframed box one</div>
  <div class="box kf" id="kf2">keyframed box two</div></section>
<section><h2>Holes</h2>
  <div class="box gone" id="gone">ends hidden</div>
  <p style="visibility:hidden">never shown</p>
  <div class="box">plain</div></section>
<section><h2>A loop</h2><div class="box" id="loop" data-animate="pulse">pulsing</div>
  <div class="box spin" id="spin">turning</div></section>
<section><h2>A build</h2><p>first</p><p data-build="fade-up">second</p></section>
</div>
${probe ? `<pre id="test-sink">running…</pre>` : ''}
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>
// the hosted macOS runner reports reduced motion, and the stylesheet then turns
// data-animate loops off in CSS (no stub reaches that): noted, so the loop is
// asserted only where it runs. The deck's own loop runs either way.
const mm = window.matchMedia.bind(window);
const reduced = mm('(prefers-reduced-motion: reduce)').matches;
window.matchMedia = (q) => /reduce/.test(q) ? { matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q);
Decklight.init();
${probe ? `setTimeout(() => {
  const secs = [...document.querySelectorAll('.decklight-stage section')];
  const op = (id) => { const el = document.getElementById(id); return el && getComputedStyle(el).opacity; };
  const loop = document.getElementById('loop');
  document.getElementById('test-sink').textContent = 'DECKLIGHT-PRINTVIS-RESULTS ' + JSON.stringify({
    kf1: op('kf1'), kf2: op('kf2'), gone: op('gone'),
    kfState: document.getElementById('kf1').getAnimations().map((a) => a.playState),
    loopAnims: loop.getAnimations().map((a) => a.animationName),
    loopFinished: loop.getAnimations().some((a) => a.playState === 'finished'),
    reduced,
    spin: document.getElementById('spin').getAnimations().map((a) => a.playState),
    marks: secs.map((s) => s.getAttribute('data-invisible')),
    more: secs.map((s) => s.getAttribute('data-invisible-more')),
  });
}, 600);` : ''}
</script></body></html>`);
  return file;
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${detail}`);
};

function probe(url) {
  const html = dumpDom(url, { fileAccess: true, budget: 5000, quietStderr: true, who: 'print-visibility-render',
    extraFlags: ['--window-size=1280,720'] });
  const m = html.match(/DECKLIGHT-PRINTVIS-RESULTS ([^<]+)/);
  if (!m) throw new Error(`print-visibility-render: no results for ${url}`);
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

const kf = deck('keyframes', KEYFRAMES);

// ---- ?print: entrances finished, holes named, the engine's own untouched ----
{
  const r = probe(`file://${kf}?print`);
  check('print: a forwards entrance is shown arrived', r.kf1 === '1' && r.kf2 === '1', `opacity ${r.kf1}, ${r.kf2}`);
  check('print: ...because the runtime finished it', r.kfState.every((s) => s === 'finished'), JSON.stringify(r.kfState));
  check('print: an entrance with no fill ends where the live one does', r.gone === '0', `opacity ${r.gone}`);
  check('print: the keyframed slide is not marked', r.marks[1] === null, `data-invisible=${r.marks[1]}`);
  check('print: the slide with holes names the first', r.marks[2] === 'a box “ends hidden” (opacity 0)', `data-invisible=${r.marks[2]}`);
  check('print: ...and counts the other', r.more[2] === '1', `data-invisible-more=${r.more[2]}`);
  check('print: the loop slide and the build slide are clean', r.marks[3] === null && r.marks[4] === null && r.marks[0] === null,
    JSON.stringify(r.marks));
  check('print: the data-animate loop still runs, unfinished',
    (r.reduced ? r.loopAnims.length === 0 : r.loopAnims.includes('dl-pulse')) && !r.loopFinished,
    `${JSON.stringify(r.loopAnims)} finished=${r.loopFinished}${r.reduced ? ' (reduced motion: the stylesheet turns it off)' : ''}`);
  check('print: the deck\'s own endless loop is left running', r.spin.length === 1 && r.spin[0] === 'running', JSON.stringify(r.spin));
}

// ---- ?print=handout: the sections are moved into pages, which restarts ----
// ---- their animations; they are finished after the move -------------------
{
  const r = probe(`file://${kf}?print=handout`);
  check('handout: the entrance is shown arrived', r.kf1 === '1' && r.kf2 === '1', `opacity ${r.kf1}, ${r.kf2}`);
  check('handout: the same slide is marked', r.marks[2] === 'a box “ends hidden” (opacity 0)', `data-invisible=${r.marks[2]}`);
}

// ---- ?capture: a still of the slide is the slide as it ends up -------------
{
  const r = probe(`file://${kf}?capture#/2/0`);
  check('capture: a still shows the entrance arrived', r.kf1 === '1' && r.kf2 === '1', `opacity ${r.kf1}, ${r.kf2}`);
  check('capture: no mark outside print', r.marks.every((m) => m === null), JSON.stringify(r.marks));
}

// ---- live: the deck still plays its own entrance ---------------------------
{
  const r = probe(`file://${kf}#/2/0`);
  check('live: the entrance is still in its delay at 600ms', r.kf1 === '0', `opacity ${r.kf1}`);
  check('live: ...and running, not finished', r.kfState.length > 0 && r.kfState.every((s) => s === 'running'), JSON.stringify(r.kfState));
}

// ---- the PDF: page 2 prints the boxes --------------------------------------
// Page content streams are compared, keyframed deck against the same deck with
// the boxes simply there. Text runs (Tj/TJ) count what was painted as words.
function pdfPages(file) {
  const out = file.replace(/\.html$/, '.pdf');
  execFileSync(chromeBin('print-visibility-render'), [
    ...chromeArgs('--allow-file-access-from-files', '--virtual-time-budget=6000'),
    '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${file}?print`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  const buf = readFileSync(out);
  const s = buf.toString('latin1');
  const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) objs.set(m[1], { body: m[2], at: m.index + m[0].indexOf('obj') + 3 });
  const stream = (id) => {
    const o = objs.get(id);
    if (!o) return '';
    let start = o.at + o.body.indexOf('stream') + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const raw = buf.subarray(start, start + Number(/\/Length (\d+)/.exec(o.body)?.[1]));
    try { return inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
  };
  const tree = [...objs.values()].find((o) => /\/Type\s*\/Pages/.test(o.body) && /\/Kids/.test(o.body));
  const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(tree?.body ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => m[1]);
  return kids.map((k) => (stream(/\/Contents\s*(\d+) 0 R/.exec(objs.get(k).body)?.[1]).match(/T[jJ]\b/g) ?? []).length);
}
{
  console.log('     printing the keyframed deck and its control to PDF…');
  const got = pdfPages(deck('keyframes-print', KEYFRAMES, { probe: false }));
  const want = pdfPages(deck('control-print', CONTROL, { probe: false }));
  check('pdf: one page a slide', got.length === 5 && want.length === 5, `${got.length} / ${want.length} pages`);
  check('pdf: the keyframed slide prints its boxes', got[1] > 0 && got[1] === want[1], `${got[1]} text runs, control ${want[1]}`);
}

// ---- decklight check names the hole, and nothing else ----------------------
{
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(root, 'cli/decklight.mjs'), 'check', kf, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NO_COLOR: '1' } });
  } catch (e) { out = e.stdout ?? ''; }
  const found = JSON.parse(out.slice(out.indexOf('['))).filter((f) => f.rule === 'invisible-in-print');
  check('check: invisible-in-print on slide 3 only', found.length === 1 && found[0].slide === 3,
    JSON.stringify(found.map((f) => f.slide)));
  check('check: it names the element', /a box “ends hidden” \(opacity 0\), and 1 more element/.test(found[0]?.message ?? ''),
    found[0]?.message ?? '(none)');
}

if (bad) { console.error('print-visibility-render: FAILED'); process.exit(1); }
console.log('print-visibility-render: PASS');
