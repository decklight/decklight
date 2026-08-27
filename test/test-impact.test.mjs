// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The test picker's map is a CLAIM about the code, and a wrong one is silent:
// a harness stops running for a subsystem it was the only cover for, everything
// stays green, and nobody learns until the bug ships. So the claim is asserted.
//
// Two properties matter more than any individual mapping. The names must be
// harnesses `verify` actually has — a typo maps a path to nothing and reads as
// "no tests needed" — and an unrecognised path must select EVERYTHING, because
// the fallback is the whole reason this is safe to use at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL, forPath } from '../tools/test-impact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the harness list is the one verify actually runs', () => {
  // verify.mjs owns the list; this map must not drift from it. Read it out of
  // the source rather than importing (verify runs a suite on import).
  const src = readFileSync(path.join(here, 'verify.mjs'), 'utf8');
  const block = /const HARNESSES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'could not find verify.mjs HARNESSES');
  const real = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ALL, real, 'test-impact knows a different set of harnesses than verify runs');
});

test('every harness a rule names is a real harness', () => {
  // The map is only as good as its names: one typo and that path silently maps
  // to a harness nobody runs.
  const paths = [
    'src/core/engine.js', 'src/core/review.js', 'src/core/narration.js',
    'src/core/character.js', 'src/decklight.css', 'src/terminal/player.mjs',
    'cli/audit.mjs', 'cli/pdf.mjs', 'cli/plugin.mjs', 'cli/import.mjs',
    'cli/deckfile.mjs', 'cli/present.mjs', 'cli/comments.mjs', 'cli/units.mjs',
    'tools/extension-check.mjs', 'tools/color.mjs', 'tools/chrome.mjs',
    'themes/anything.css', 'demo/smoke.html', 'build.mjs', 'package.json',
  ];
  for (const p of paths) {
    for (const h of forPath(p).harnesses) {
      assert.ok(ALL.includes(h), `${p} names "${h}", which verify has no harness for`);
    }
  }
});

test('an unmapped path falls back to EVERY harness, and says so', () => {
  // The safety property. A picker that answers "probably nothing" for a path it
  // does not recognise turns an unrun suite into a green line.
  for (const p of ['src/brand-new-thing.js', 'cli/whatever.mjs', 'weird/place.js']) {
    const { harnesses, why } = forPath(p);
    assert.deepEqual(harnesses, ALL, `${p} did not fall back to everything`);
    assert.match(why, /UNMAPPED/, `${p} fell back without saying why`);
  }
});

test('a subsystem selects its own harness and not the whole suite', () => {
  // The point of the exercise: the narrow cases must actually be narrow, or the
  // script costs a rule file and saves nothing.
  assert.deepEqual(forPath('src/core/review.js').harnesses, ['review-render']);
  assert.deepEqual(forPath('cli/pdf.mjs').harnesses, ['pdf-render']);
  assert.deepEqual(forPath('src/terminal/player.mjs').harnesses, ['player-render']);
  assert.ok(forPath('src/core/narration.js').harnesses.includes('narration-render'));
  assert.ok(!forPath('src/core/narration.js').harnesses.includes('pdf-render'),
    'narration has no business waiting for the PDF harness');
});

test('core and the stylesheet reach every BROWSER harness, but not the theme lints', () => {
  // contrast/palette-rules read themes/ and tools/, never the built runtime —
  // making them ride on every src/ edit would put 2 harnesses back on every run
  // for no signal.
  for (const p of ['src/core/engine.js', 'src/decklight.css']) {
    const { harnesses } = forPath(p);
    assert.equal(harnesses.length, ALL.length - 2, `${p} should reach every browser harness`);
    assert.ok(!harnesses.includes('contrast'), `${p} must not drag in the theme lint`);
    assert.ok(harnesses.includes('narration-render') && harnesses.includes('render'));
  }
  // …and a theme is the mirror image: the lints, plus the deck that renders one.
  assert.deepEqual(forPath('themes/dark.css').harnesses.sort(),
    ['contrast', 'palette-rules', 'render'].sort());
});

test('prose and unit tests select no harness at all', () => {
  // "Nothing" has to be a decision on the record, not the fallback misfiring.
  for (const p of ['SPEC.md', 'README.md', 'docs/guide.md', '.github/workflows/ci.yml',
    'test/audit.test.mjs']) {
    const { harnesses, why } = forPath(p);
    assert.deepEqual(harnesses, [], `${p} should need no harness`);
    assert.doesNotMatch(why, /UNMAPPED/, `${p} landed on the fallback instead of a rule`);
  }
});

test('a harness fixture selects its own harness', () => {
  // test/review.html and test/review-render.mjs are both about review-render.
  assert.deepEqual(forPath('test/review.html').harnesses, ['review-render']);
  assert.deepEqual(forPath('test/review-render.mjs').harnesses, ['review-render']);
  assert.deepEqual(forPath('test/narration.html').harnesses, ['narration-render']);
});
