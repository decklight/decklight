// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The notes card's per-build view (src/core/notesparts.js, SPEC PRESENTING):
// a slide's notes cut at their [click] lines, one part per build, and a part
// written back into its place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesParts, joinParts, withPart, hasClick, partFor, partLabel, wholeWhy } from '../src/core/notesparts.js';

test('notesParts cuts at every [click], in either spelling, each part trimmed', () => {
  assert.deepEqual(notesParts('Opening.\n\n[click]\n\nFirst build.\n\n[CLICK]\n\nSecond.'), ['Opening.', 'First build.', 'Second.']);
  assert.deepEqual(notesParts('Opening.\n\n⟨CLICK⟩\n\nNext.'), ['Opening.', 'Next.']);
  assert.deepEqual(notesParts('No builds here.\n\nTwo paragraphs.'), ['No builds here.\n\nTwo paragraphs.']);
  assert.deepEqual(notesParts('[click]\n\nOnly after.'), ['', 'Only after.'], 'an empty first part is still a part');
  assert.deepEqual(notesParts(''), ['']);
});

test('withPart puts one part back in place, every [click] around it kept', () => {
  const parts = notesParts('One.\n\n[click]\n\nTwo.\n\n[click]\n\nThree.');
  assert.equal(withPart(parts, 1, 'Two, reworded.\n\nWith a paragraph.'), 'One.\n\n[click]\n\nTwo, reworded.\n\nWith a paragraph.\n\n[click]\n\nThree.');
  assert.equal(withPart(parts, 0, ''), '[click]\n\nTwo.\n\n[click]\n\nThree.', 'an emptied first part keeps its click');
  assert.deepEqual(parts, ['One.', 'Two.', 'Three.'], 'the parts given are not changed');
  assert.equal(joinParts(notesParts('A [pause] B.\n\n[click]\n\nC.')), 'A [pause] B.\n\n[click]\n\nC.', 'a round trip changes nothing');
});

test('hasClick spots a split typed into a part', () => {
  assert.ok(hasClick('Before.\n[click]\nAfter.'));
  assert.ok(hasClick('inline [ Click ] too'));
  assert.ok(!hasClick('A [pause] and a [1] footnote.'));
});

test('partFor: the build on screen gets its part, otherwise the whole slide and why', () => {
  assert.deepEqual(partFor(0, 2, 3), { part: 0 });
  assert.deepEqual(partFor(2, 2, 3), { part: 2 });
  assert.deepEqual(partFor(0, 0, 1), { part: null, why: 'none' }, 'no builds: nothing to follow');
  assert.deepEqual(partFor(0, 0, 2), { part: null, why: 'none' }, 'a [click] with no builds is not a part of its own');
  assert.deepEqual(partFor(1, 3, 1), { part: null, why: 'unsplit' });
  assert.deepEqual(partFor(3, 3, 2), { part: null, why: 'past' });
});

test('partLabel and wholeWhy name what the heading shows', () => {
  assert.equal(partLabel(0, 3), 'before the first build');
  assert.equal(partLabel(2, 3), 'build 2 of 2');
  assert.equal(wholeWhy('unsplit', { builds: 3 }), '3 builds, no [click] to split the notes');
  assert.equal(wholeWhy('unsplit', { builds: 1 }), '1 build, no [click] to split the notes');
  assert.equal(wholeWhy('past', { step: 3, builds: 3, count: 2 }), 'build 3 has no part: 1 [click] for 3 builds');
  assert.equal(wholeWhy('none'), '');
});
