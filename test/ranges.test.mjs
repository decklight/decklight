// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The slide ranges the video export and the recorders pick from (src/core/ranges.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, rangeArg, rangeLabel, rangeChoices } from '../src/core/ranges.js';

test('parseRange: the --slides spelling, checked against the deck', () => {
  assert.deepEqual(parseRange('5-9', 10), { from: 5, to: 9 });
  assert.deepEqual(parseRange('7', 10), { from: 7, to: 7 });
  assert.deepEqual(parseRange(' 5 – 9 ', 10), { from: 5, to: 9 }, 'the dash the picker prints reads back');
  for (const bad of ['0', '9-5', '3-11', 'abc', '', null]) assert.equal(parseRange(bad, 10), null, String(bad));
});

test('rangeArg and rangeLabel: the whole deck is no range at all', () => {
  assert.equal(rangeArg({ from: 1, to: 10 }, 10), null);
  assert.equal(rangeArg({ from: 4, to: 4 }, 10), '4');
  assert.equal(rangeArg({ from: 2, to: 5 }, 10), '2-5');
  assert.equal(rangeLabel(null), 'all slides');
  assert.equal(rangeLabel('7'), 'slide 7');
  assert.equal(rangeLabel('5-9'), 'slides 5–9');
});

test('rangeChoices: one keystroke from where you are, never the same range twice', () => {
  const slides = (o) => rangeChoices(o).map((c) => c.slides);
  assert.deepEqual(slides({ slide: 4, total: 10 }), [null, '4', '4-10', '1-4']);
  assert.deepEqual(slides({ slide: 1, total: 10 }), [null, '1'], 'from slide 1 to the end is the whole deck');
  assert.deepEqual(slides({ slide: 1, total: 1 }), [null]);
  const chapters = [{ title: 'Intro', slide: 1 }, { title: 'Deep dive', slide: 5 }];
  const inChapter = rangeChoices({ slide: 6, total: 10, chapters });
  assert.deepEqual(inChapter.map((c) => c.slides), [null, '6', '5-10', '6-10', '1-6']);
  assert.match(inChapter[2].label, /This chapter — Deep dive \(5–10\)/);
  assert.equal(rangeChoices({ slide: 2, total: 10, chapters }).find((c) => /chapter/.test(c.label)).slides, '1-4',
    'a chapter ends where the next begins');
});
