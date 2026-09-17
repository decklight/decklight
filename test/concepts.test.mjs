// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Concept colors — SPEC SVG_DIAGRAMS. Pure-function tests for the slot resolution;
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

// ── nested tones (#541): the runtime's derivation, in Node, for the gate ──
import { parseColor, nestedTone, toOklab, fromOklab, mixOklab, rgbToHex, contrast } from '../tools/color.mjs';

test('the nested tone is one lightness step of the panel toward the ink — same hue, in dark and light themes alike', () => {
  const ink = parseColor('#f2ece4'); const panel = parseColor('#33201a');
  const tone = nestedTone(panel, ink);
  assert.ok(toOklab(tone)[0] > toOklab(panel)[0] + 0.06, 'a dark panel steps lighter');
  assert.ok(contrast(ink, tone) >= 3, 'and the ink still reads on it');
  const lightInk = parseColor('#1c1c1c'); const lightPanel = parseColor('#e6ecf7');
  assert.ok(toOklab(nestedTone(lightPanel, lightInk))[0] < toOklab(lightPanel)[0] - 0.06, 'a light panel steps darker');
  // the mix is the CSS one: 82% panel, 18% ink, in OKLab
  assert.deepEqual(nestedTone(panel, ink), mixOklab(panel, ink, 0.82));
  assert.equal(rgbToHex(fromOklab(toOklab([120, 80, 200]))), '#7850c8', 'OKLab round-trips');
  assert.equal(rgbToHex(mixOklab(panel, ink, 1)), '#33201a', 'all panel is the panel');
});
