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

if (bad) { console.error('overflow-render: FAILED'); process.exit(1); }
console.log('overflow-render: PASS');
