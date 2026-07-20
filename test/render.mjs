// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Headless-render verification of demo/smoke.html — the "prove the deck
// works" harness (SPEC intro + §10). Exits non-zero on any failed assertion.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const dump = (url) => dumpDom(url, {
  budget: 5000, maxBuffer: 64 * 1024 * 1024,
  // autoplay flag: the background-video checks call play() on a muted <video>
  // — allowed by policy anyway, but pinned here so the assertion can never
  // flake on a policy default change
  extraFlags: ['--autoplay-policy=no-user-gesture-required'],
});

function sink(html) {
  const m = html.match(/<div id="test-sink"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) throw new Error('test-sink not found in rendered DOM');
  const out = {};
  for (const line of m[1].trim().split('\n')) {
    const [k, ...v] = line.split('=');
    out[k.trim()] = v.join('=').trim();
  }
  return out;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const deckUrl = 'file://' + resolve(here, '../demo/smoke.html');

// --- default load ---------------------------------------------------------
{
  const html = dump(deckUrl);
  const s = sink(html);
  check('no runtime errors', s.errors, 'none');
  check('slide count', s.slides, '19');
  check('slide 1 build steps (3 li + 1 leaf)', s.slide1steps, '4');
  check('slide 2 svg steps (3 g, caption stays)', s.svgsteps, '3');
  check('markdown build steps', s.mdsteps, '2');
  check('code lines wrapped', Number(s.codelines) >= 8, true);
  check('hljs tokens present', s.hljs, 'true');
  check('svg ids namespaced', Number(s.nsids) >= 1, true);
  check('url(#) refs rewritten', s.nsrefs, 'true');
  check('markdown rendered to h2', s.mdrendered, 'true');
  check('markdown notes extracted', s.mdnotes, 'true');
  check('markdown gfm table', s.mdtable, 'true');
  check('draw strokes prepared', Number(s.drawlen) >= 3, true);
  check('auto layout pins by default', s.autopinned, 'true');
  check('data-layout=pinned pins the title', s.layoutpinned, 'true');
  check('data-layout=top stays unpinned, top-aligned', s.layouttop, 'true');
  check('data-layout=split is a wrapping flex row', s.splitrow, 'true');
  check('lone-list split gets two columns', s.splitcols, 'true');
  check('cycleLayout without the dev server changes nothing', s.layoutgate, 'true');
  check('layout ring skips pinned when auto already pins', s.ring1, 'auto centered top split split-flip');
  check('lone list: ring skips split-flip too', s.ring11, 'auto centered top split');
  check('math: $$…$$ renders display MathML on an HTML data-math slide', s.mathdisplay, 'true');
  check('math: \\(…\\) renders inline MathML', s.mathinline, 'true');
  check('math: \\$ escapes to a literal dollar', s.mathescape, 'true');
  check('math: code on a data-math slide keeps its dollars', s.mathcode, 'true');
  check('math: markdown data-math slide renders MathML too', s.mathmd, 'true');
  check('math: TeX underscores never become markdown emphasis', s.mathmdnoem, 'true');
  check('math: markdown fenced code is immune', s.mathmdcode, 'true');
  check('math: a section without data-math is untouched', s.mathcontrol, 'true');
  check('clock: off by default', s.clockdefault, 'true');
  check('clock: K shows it', s.clockshown, 'true');
  check('clock: wall time is HH:MM', s.clockwall, 'true');
  check('clock: elapsed idle until the first advance', s.clockidle, '+00:00');
  check('clock: elapsed runs from the first advance', s.clockruns, '+00:02');
  check('clock: K again removes it', s.clockoff, 'true');
  check('progress bar: off by default', s.progressdefault, 'true');
  check('progress bar: H shows it', s.progressshown, 'true');
  check('progress bar: width tracks the position (slide 1 ≠ last, last = full)', s.progresstracks, 'true');
  check('progress bar: H again removes it', s.progressoff, 'true');
  check('chart: svg generated from JSON', s.chartsvg, 'true');
  check('chart: one <g> per series', s.chartseries, '2');
  check('chart: series colored from --d-fill-1', s.chartfill, 'true');
  check('chart: concept series recolored by the pinning', s.chartconcept, 'true');
  check('chart: invalid JSON renders the error box (and no runtime error)', s.chartbroken, 'true');
  check('chart: data-build moved onto the svg — 2 series steps', s.chartsteps, '2');
  check('chart: line strokes prepared for draw', s.chartdraw, '2');
  check('chart: markdown ```chart fence renders', s.chartmdfence, 'true');
  check('ink: no canvas until a tool is asked for', s.inkdefault, 'true');
  check('ink: W mounts the pen overlay, capturing', s.inkpen, 'true');
  check('ink: an API stroke paints the canvas', s.inkdrawn, 'true');
  check('ink: changing slide clears it', s.inkcleared, 'true');
  check('ink: Backspace clears while a tool is active', s.inkbackspace, 'true');
  check('ink: ⇧W switches to the laser', s.inklaser, 'true');
  check('ink: off again stops capturing', s.inkoff, 'true');
  check('background image: .slide-bg first child, cover/center', s.bgimage, 'true');
  check('background dim overlay at authored opacity', s.bgdim, '0.5');
  check('background video: muted/loop/playsinline + poster', s.bgvideo, 'true');
  check('background layer does not read as content (title still pins)', s.bgpinned, 'true');
  check('background video idle until its slide', s.bgvidle, 'true');
  check('background video plays while its slide is active', s.bgvplays, 'true');
  check('background video paused on deactivation (not just hidden)', s.bgvrepaused, 'true');
  check('background slides do not trip the overflow guardrail', s.bgoverflow, 'true');
  check('full-bleed img: absolute + object-fit cover', s.fullbleed, 'true');
  check('split-layout img: contain + max-height cap', s.splitimg, 'true');
  check('no template text leaked',
    /text\/template/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), false);
  check('slide 1 initially unbuilt',
    /data-slide-index="1"[\s\S]*?data-build-state="pending"/.test(html), true);
}

// --- deep link: slide 1, step 2 -------------------------------------------
{
  const html = dump(deckUrl + '#/1/2');
  const section = html.match(/<section[^>]*data-slide-index="1"[\s\S]*?<\/section>/)[0];
  const done = (section.match(/data-build-state="(done|current)"/g) || []).length;
  const pending = (section.match(/data-build-state="pending"/g) || []).length;
  check('deep link: 2 steps built', done, 2);
  check('deep link: 2 steps pending', pending, 2);
}

// --- print mode ------------------------------------------------------------
{
  const html = dump(deckUrl + '?print');
  check('print: everything built',
    (html.match(/data-build-state="pending"/g) || []).length, 0);
  check('print: print class set', /decklight-print/.test(html), true);
  check('print: no presenter clock', /decklight-clock"/.test(html), false);
  check('print: no progress bar', /decklight-progress"/.test(html), false);
  check('print: no annotation canvas', /decklight-annotate"/.test(html), false);
  check('print: math renders in ?print output', /<math[^>]*display="block"/.test(html), true);
  check('print: plain mode has no variant pages', /print-page/.test(html), false);
  // background media (SPEC §8): print shows a still, never a <video> — the
  // poster renders as the background image instead
  check('print: no <video> element', /<video\b/i.test(html), false);
  check('print: poster renders as the background image',
    /class="slide-bg"[^>]*style="[^"]*clip-poster\.jpg/.test(html), true);
  check('print: background slides not flagged as overflowing',
    /<section[^>]*data-background-[^>]*data-overflow/.test(html), false);
}

// --- print variant: ?print=handout (3-up pages with ruled note lines) ------
{
  const html = dump(deckUrl + '?print=handout');
  check('handout: ceil(19/3) = 7 pages',
    (html.match(/class="print-page print-handout"/g) || []).length, 7);
  check('handout: every slide gets a slot',
    (html.match(/class="print-slot"/g) || []).length, 19);
  check('handout: note lines beside every slide',
    (html.match(/class="print-notelines"/g) || []).length, 19);
  check('handout: everything built',
    (html.match(/data-build-state="pending"/g) || []).length, 0);
}

// --- print variant: ?print=notes (one page per slide, notes underneath) ----
{
  const html = dump(deckUrl + '?print=notes');
  check('notes: one page per slide',
    (html.match(/class="print-page print-notes-page"/g) || []).length, 19);
  check('notes: a notes block on every page',
    (html.match(/class="print-notes"/g) || []).length, 19);
  // 6 slides carry notes (markdown's Note: included); the other 13 keep their
  // page with an empty block
  check('notes: slides without notes get an empty block',
    (html.match(/<div class="print-notes"><\/div>/g) || []).length, 13);
  check('notes: markdown Note: content lands in its block (aside + copy)',
    (html.match(/Markdown notes body/g) || []).length, 2);
  check('notes: HTML aside content lands in its block (aside + copy)',
    (html.match(/Second point beat/g) || []).length, 2);
}

// --- demo/intro.html: the short "what is Decklight" deck a newcomer opens
// first. It has no test-sink, so assert against the rendered DOM directly.
// This block exists because the inline terminal cast once shipped with raw
// ESC bytes that broke JSON.parse and rendered a `.terminal-broken` box on
// the flagship "Truthful Terminals" slide — invisible to a harness that only
// renders smoke.html.
{
  const introUrl = 'file://' + resolve(here, '../demo/intro.html');
  const html = dump(introUrl);
  check('intro: 12 slides', /data-slide-index="12"/.test(html) && !/data-slide-index="13"/.test(html), true);
  check('intro: no clipped slides', /data-overflow/.test(html), false);
  check('intro: terminal cast parsed (a real terminal, not the error box)',
    /terminal-window/.test(html) && !/terminal-broken/.test(html), true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall render checks passed');
process.exit(failures ? 1 : 0);
