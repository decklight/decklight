// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Concept colors — SPEC §3. Pure-function tests for the slot resolution;
// the DOM application is covered by the deck-level headless verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptSlot, conceptFill } from '../src/core/svg.js';

test('conceptSlot: deterministic, in range, name-sensitive', () => {
  for (const name of ['agent', 'kafka', 'flink', 'context-engine', 'llm', 'tools']) {
    const s = conceptSlot(name);
    assert.equal(s, conceptSlot(name), `${name}: unstable`);
    assert.ok(s >= 1 && s <= 6, `${name}: slot ${s} out of range`);
  }
  assert.notEqual(conceptSlot('agent'), conceptSlot('tools'), 'distinct names should usually differ');
});

test('conceptFill: hash fallback, numeric override, raw CSS override', () => {
  assert.equal(conceptFill('agent'), `var(--d-fill-${conceptSlot('agent')})`);
  assert.equal(conceptFill('agent', { agent: 5 }), 'var(--d-fill-5)');
  assert.equal(conceptFill('agent', { agent: 'var(--d-accent)' }), 'var(--d-accent)');
  assert.equal(conceptFill('agent', { kafka: 2 }), `var(--d-fill-${conceptSlot('agent')})`, 'other names untouched');
});
