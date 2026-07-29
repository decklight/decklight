#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict mode (MARKETPLACE.md PRESENT#STRICT), measured in a real browser.
 *
 * The unit tests prove the transform removes the right bytes. What they cannot
 * see is the claim that actually decides whether anyone leaves strict on: that
 * the deck still RENDERS the same. A stripper is easy to write and easy to have
 * subtly broken — a spliced offset, a swallowed boot call, a runtime that no
 * longer parses — and every one of those failures looks fine as a string diff
 * and blank as a slide.
 *
 * So this renders the same bundled deck three ways and compares what Chrome
 * built:
 *   clean     — the deck as `decklight bundle` produced it
 *   poisoned  — clean, plus an appended <script>, served as-is
 *   stripped  — that same poisoned deck put through the transform
 *
 * `stripped` must fingerprint identical to `clean` (the deck is unharmed) while
 * the payload that ran in `poisoned` does not run. `poisoned` is not decoration:
 * without it, a transform that broke the payload's script tag by accident would
 * pass, and so would a browser that never ran the payload in the first place.
 *
 * The probe is appended AFTER stripping, to all three. Adding it before would
 * make it unaccounted script — and strict would eat the instrument.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';
import { stripUnaccounted } from '../cli/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-strict-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// A real deck, bundled the way one that reaches you would be: runtime inlined,
// assets inlined, self-contained. Anything less would test a fixture, and the
// fixture is not what the classifier has to survive.
const bundled = path.join(dir, 'deck.html');
execFileSync(process.execPath,
  [path.join(root, 'cli/decklight.mjs'), 'bundle', path.join(root, 'demo/intro.html'), '-o', bundled],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const clean = readFileSync(bundled, 'utf8');

/**
 * Insert just before the document's own `</body>` — the LAST one.
 * A bundled deck contains the string twice: the inlined runtime carries one in
 * its source, and splicing there would corrupt the engine and fail every check
 * below for a reason that has nothing to do with strict mode.
 */
function atBodyEnd(html, insert) {
  const at = html.lastIndexOf('</body>');
  return `${html.slice(0, at)}${insert}\n${html.slice(at)}`;
}

// The realistic attack: someone appends a block before forwarding the file.
const PAYLOAD = `<script>
  window.__pwned = 1;
  document.addEventListener('DOMContentLoaded', () => {
    const p = document.createElement('p');
    p.id = 'injected';
    p.textContent = 'this should never be on anyone\\'s screen';
    document.body.appendChild(p);
  });
</script>`;
const poisoned = atBodyEnd(clean, PAYLOAD);
const stripped = stripUnaccounted(poisoned).html;

/**
 * What the page became, once it settled. Sampled on a timer rather than a
 * frame: under --virtual-time-budget a requestAnimationFrame booked after the
 * page goes idle never runs at all, which is the lesson pin-render and
 * overflow-render both paid for.
 */
const PROBE = (name) => `<pre id="test-sink">running…</pre><script>
setTimeout(() => {
  const stage = document.querySelector('.decklight-stage');
  const sections = [...document.querySelectorAll('.decklight-stage > section')];
  const active = document.querySelector('.decklight-stage > section.active') ?? sections[0];
  const cs = active ? getComputedStyle(active) : {};
  const box = active ? active.getBoundingClientRect() : {};
  document.getElementById('test-sink').textContent = 'DECKLIGHT-STRICT-RESULTS ' + JSON.stringify({
    mounted: !!stage,
    sections: sections.length,
    // the rendered shape, not the source bytes: what the engine actually built
    fingerprint: sections.map((s) => [
      s.className, s.getAttribute('data-layout') ?? '', s.children.length, s.textContent.replace(/\\s+/g, ' ').trim(),
    ].join('|')).join('\\n'),
    // and how it looks — a stripper that damaged the runtime css shows up here
    look: [cs.fontSize, cs.color, cs.backgroundColor, Math.round(box.width), Math.round(box.height)].join(' '),
    pwned: window.__pwned ?? 0,
    injected: !!document.getElementById('injected'),
    who: ${JSON.stringify(name)},
  });
}, 400);
</script>`;

function render(name, html) {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, atBodyEnd(html, PROBE(name)));
  const dom = dumpDom(`file://${file}`,
    { fileAccess: true, budget: 8000, quietStderr: true, who: 'strict-render' });
  return resultsFrom(dom, 'STRICT', name);
}

const A = render('clean', clean);
const B = render('poisoned', poisoned);
const C = render('stripped', stripped);

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
};

// The control. If the payload does not run here, nothing below means anything.
check('poisoned: the appended script really does run', B.pwned === 1 && B.injected === true,
  `pwned=${B.pwned} injected=${B.injected}`);

// It never runs the unaccounted script.
check('stripped: the payload did not run', C.pwned === 0, `window.__pwned=${C.pwned}`);
check('stripped: and left nothing on the page', C.injected === false, `#injected present=${C.injected}`);

// It never breaks the deck — the claim that decides whether strict stays on.
check('stripped: the engine mounted', C.mounted === true, `stage=${C.mounted}`);
check('stripped: every slide is there', C.sections === A.sections, `${C.sections} vs ${A.sections} clean`);
check('stripped: renders identically to the clean deck', C.fingerprint === A.fingerprint,
  C.fingerprint === A.fingerprint ? `${A.sections} sections match` : 'DOM differs — see below');
check('stripped: and looks identical', C.look === A.look, `${C.look} vs ${A.look}`);

if (C.fingerprint !== A.fingerprint) {
  const a = A.fingerprint.split('\n'); const c = C.fingerprint.split('\n');
  for (let i = 0; i < Math.max(a.length, c.length); i++) {
    if (a[i] !== c[i]) console.error(`  slide ${i + 1}\n    clean:    ${a[i]}\n    stripped: ${c[i]}`);
  }
}

if (bad) { console.error('strict-render: FAILED'); process.exit(1); }
console.log('strict-render: PASS');
