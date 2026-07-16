// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPages, HANDOUT_PER_PAGE } from '../src/core/print.js';

test('groupPages: remainder gets its own short page (ceil)', () => {
  assert.deepEqual(groupPages(7, 3), [[0, 1, 2], [3, 4, 5], [6]]);
});

test('groupPages: exact multiple fills every page', () => {
  assert.deepEqual(groupPages(6, 3), [[0, 1, 2], [3, 4, 5]]);
});

test('groupPages: fewer slides than a page is one page', () => {
  assert.deepEqual(groupPages(2, 3), [[0, 1]]);
  assert.deepEqual(groupPages(1, 3), [[0]]);
});

test('groupPages: zero slides is zero pages', () => {
  assert.deepEqual(groupPages(0, 3), []);
});

test('groupPages: page count is ceil(n/per)', () => {
  for (let n = 0; n <= 20; n++) {
    assert.equal(groupPages(n, HANDOUT_PER_PAGE).length, Math.ceil(n / HANDOUT_PER_PAGE));
  }
});
