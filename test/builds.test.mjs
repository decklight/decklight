// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGroups } from '../src/core/builds.js';
import { parseLineRanges } from '../src/code/code.js';

test('computeGroups: document order when all auto', () => {
  const items = [0, 1, 2, 3].map((key) => ({ key, explicit: false }));
  const groups = computeGroups(items);
  assert.deepEqual(groups, [[0], [1], [2], [3]]);
});

test('computeGroups: explicit order overrides document order', () => {
  // doc order: a(auto 0), b(explicit 5), c(auto 2) — b sorts after c
  const items = [
    { key: 0, explicit: false },
    { key: 5, explicit: true },
    { key: 2, explicit: false },
  ];
  assert.deepEqual(computeGroups(items), [[0], [2], [1]]);
});

test('computeGroups: explicit ties advance together', () => {
  const items = [
    { key: 1, explicit: true },
    { key: 1, explicit: true },
    { key: 2, explicit: true },
  ];
  assert.deepEqual(computeGroups(items), [[0, 1], [2]]);
});

test('computeGroups: auto steps never merge, even with equal keys', () => {
  const items = [
    { key: 1, explicit: false },
    { key: 1, explicit: true },
  ];
  assert.equal(computeGroups(items).length, 2);
});

test('computeGroups: empty input', () => {
  assert.deepEqual(computeGroups([]), []);
});

test('parseLineRanges: singles, ranges, all', () => {
  assert.deepEqual(parseLineRanges('1|3-5|all', 6), [
    [1],
    [3, 4, 5],
    [1, 2, 3, 4, 5, 6],
  ]);
});

test('parseLineRanges: comma lists and clamping', () => {
  assert.deepEqual(parseLineRanges('1,3|2-99', 4), [
    [1, 3],
    [2, 3, 4],
  ]);
});

test('parseLineRanges: empty segment means all', () => {
  assert.deepEqual(parseLineRanges('', 2), [[1, 2]]);
});

// ── data-draw-stops (#522): one stroke, several steps ─────────────────────
import { parseDrawStops } from '../src/core/builds.js';

test('parseDrawStops: path lengths, fractions, percentages — clamped to the stroke', () => {
  assert.deepEqual(parseDrawStops('347 542 767', 747), [347, 542, 747], 'lengths, the last clamped');
  assert.deepEqual(parseDrawStops('0.25, 0.5, 1', 800), [200, 400, 800], 'every value ≤ 1 reads as a fraction');
  assert.deepEqual(parseDrawStops('25% 50% 100%', 800), [200, 400, 800]);
  assert.deepEqual(parseDrawStops('1 2', 800), [1, 2], 'a value above 1 makes them all lengths');
  assert.deepEqual(parseDrawStops('', 800), [], 'nothing to stop at');
  assert.deepEqual(parseDrawStops('347 x', 800), [], 'a value that is not a number voids the list');
  assert.deepEqual(parseDrawStops('-1 5', 800), [], 'and so does a negative one');
});
