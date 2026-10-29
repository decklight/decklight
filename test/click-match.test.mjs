// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clickMismatch, clickMismatchText, clickCounts, clickCountsShort, readClickMismatch, stampClickMismatch,
} from '../tools/click-match.mjs';

test('one [click] per build click, and notes without a [click] make no claim (#929)', () => {
  assert.equal(clickMismatch({ markers: 3, clicks: 3 }), null, 'in step');
  assert.equal(clickMismatch({ markers: 0, clicks: 4 }), null, 'no [click]: one beat, whatever the builds');
  assert.equal(clickMismatch({ markers: 0, clicks: 0 }), null, 'a title or a quote');
  assert.deepEqual(clickMismatch({ markers: 2, clicks: 3 }), { markers: 2, clicks: 3, cause: null }, 'too few');
  assert.deepEqual(clickMismatch({ markers: 5, clicks: 4, cause: 'lead-click' }), { markers: 5, clicks: 4, cause: 'lead-click' }, 'too many');
  assert.deepEqual(clickMismatch({ markers: 2, clicks: 0 }), { markers: 2, clicks: 0, cause: null },
    'a [click] on a slide with no builds waits for one that never comes');
  assert.equal(clickMismatch({ markers: 1, clicks: 2, cause: 'nonsense' }).cause, null);
});

test('the sentence names markers and build clicks, never segments', () => {
  const m = clickMismatch({ markers: 5, clicks: 6, cause: 'empty-build' });
  assert.equal(clickCounts(m), '5 [click] markers, 6 build clicks');
  const text = clickMismatchText(m, { steps: 10 });
  assert.match(text, /^5 \[click\] markers, 6 build clicks \(10 build steps, tied by data-build-order\): the notes want 6 \[click\]s/);
  assert.match(text, /likely an empty build group/);
  assert.doesNotMatch(text, /segment/);
  assert.equal(clickCounts({ markers: 1, clicks: 1 }), '1 [click] marker, 1 build click');
  assert.equal(clickCountsShort({ markers: 2, clicks: 4 }), '2 [click], 4 builds', 'a slide row\'s width');
});

test('the print view stamp reads back as the same verdict', () => {
  const m = clickMismatch({ markers: 2, clicks: 4, cause: 'lead-click' });
  assert.equal(stampClickMismatch(m), '2 4 lead-click');
  assert.deepEqual(readClickMismatch(stampClickMismatch(m)), m);
  assert.deepEqual(readClickMismatch('2 3'), { markers: 2, clicks: 3, cause: null });
  assert.equal(readClickMismatch(undefined), null);
  assert.equal(readClickMismatch('4 4'), null);
});
