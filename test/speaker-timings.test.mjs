// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Rehearsal timings (PRESENTING REHEARSAL_TIMINGS): the pure half. Which plan
// the speaker view shows, how a clock is written, and what the pace line says.
// The recorder itself runs in the popup and is exercised by presenting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannedTimings, fmtClock, paceLine } from '../src/core/speaker.js';

const sec = (timing) => ({ dataset: timing == null ? {} : { timing: String(timing) } });

test('the deck\'s own data-timing wins; the browser\'s memory fills in only when the deck has none', () => {
  assert.deepEqual(plannedTimings([sec(30), sec(null), sec(90)]), [30, null, 90]);
  assert.deepEqual(plannedTimings([sec(30), sec(null)], [5, 5]), [30, null], 'a deck with any timing ignores the browser');
  assert.deepEqual(plannedTimings([sec(null), sec(null), sec(null)], [12, 0, 40]), [12, null, 40], 'stored zero is no plan');
  assert.deepEqual(plannedTimings([sec(null), sec(null)], null), [null, null]);
  assert.deepEqual(plannedTimings([sec('abc'), sec(-3)]), [null, null], 'garbage is no plan');
});

test('the clock is mm:ss, floored, never a decimal', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(59.9), '00:59');
  assert.equal(fmtClock(60), '01:00');
  assert.equal(fmtClock(3661.2), '61:01');
});

test('the pace line names this slide against its plan and the talk against the total, and goes red past five seconds over', () => {
  const a = paceLine({ slide: 3, spent: 42, planned: 60, total: 190, plannedTotal: 600 });
  assert.equal(a.text, 'slide 3 · 00:42 / 01:00 · total 03:10 / 10:00');
  assert.equal(a.over, false);
  const b = paceLine({ slide: 3, spent: 71, planned: 60, total: 219, plannedTotal: 600 });
  assert.equal(b.text, 'slide 3 · 01:11 / 01:00 · 00:11 over · total 03:39 / 10:00');
  assert.equal(b.over, true);
  const c = paceLine({ slide: 1, spent: 12, planned: null, total: 12, plannedTotal: 0 });
  assert.equal(c.text, 'slide 1 · 00:12 · total 00:12', 'no plan, no comparison');
  assert.equal(c.over, false);
});
