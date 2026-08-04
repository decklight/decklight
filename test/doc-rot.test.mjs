// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Comment rot (#238) — the version-drift pattern from cli.test.mjs applied to
// pointers in comments: a pointer nobody checks is read as a fact, which is
// what makes a stale one worse than none. Each sweep here caught a real
// leftover — charts.js citing `initMarkdown` long after the markdown removal,
// the subtitle notes still offering two authoring surfaces, speaker.js sending
// a reader to `/edit/ping` for a QR the author server refuses to serve — and
// failing in one line under `npm test` beats a reader discovering the drift
// wherever the pointer eventually misleads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([path.relative(srcDir, p), fs.readFileSync(p, 'utf8')]);
  }
})(srcDir);

test('every init* pipeline function src mentions is defined somewhere in src', () => {
  // Comments narrate the init pipeline by function name (charts.js places
  // itself relative to its neighbours), so a rename or removal that misses a
  // mention leaves a pointer to a function that no longer exists.
  const defined = new Set();
  for (const [, text] of files)
    for (const m of text.matchAll(/\bfunction (init[A-Z]\w*)/g)) defined.add(m[1]);
  const stale = [];
  for (const [file, text] of files)
    for (const m of text.matchAll(/\binit[A-Z]\w*\b/g))
      if (!defined.has(m[0])) stale.push(`${file}: ${m[0]}`);
  assert.deepEqual(stale, [],
    'a src file cites an init* function that is defined nowhere in src — fix the pointer');
});

test('no src file still describes slides as markdown-or-HTML authored', () => {
  // Markdown slides were removed in 0.4.0 (SPEC DECK_ANATOMY): HTML is the one
  // authoring surface, and a comment still offering both keeps the removed one
  // alive for whoever reads it. reportMarkdownSlides may talk ABOUT the
  // removal; nothing may present markdown as a live alternative.
  const stale = files
    .filter(([, text]) => /markdown-? ?or ?-?HTML|HTML-? ?or ?-?markdown/i.test(text))
    .map(([file]) => file);
  assert.deepEqual(stale, []);
});

test('speaker.js does not attribute the phone-remote QR to /edit/ping', () => {
  // PRESENT#REMOTE moved the clicker to `decklight present`: the QR is set
  // from /present/ping, and the author server deliberately serves no /remote/*
  // at all — a comment pointing at /edit/ping sends a reader to the one server
  // that refuses to offer one.
  const [, speaker] = files.find(([file]) => file === path.join('core', 'speaker.js'));
  assert.ok(!speaker.includes('/edit/ping'),
    'speaker.js points at /edit/ping — the QR comes from /present/ping (PRESENT#REMOTE)');
});
