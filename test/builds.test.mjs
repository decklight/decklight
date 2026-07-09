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
