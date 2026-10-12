// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Mac check the undo chord, the style chords and the welcome card hang on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isApplePlatform } from '../src/core/undo-chord.js';

test('Chrome on a Mac says macOS, and that is a Mac', () => {
  // navigator.userAgentData.platform is read first, and Chrome spells it
  // "macOS". The old /Mac|iPhone|iPad/ missed it, so ⌘Z did nothing there.
  assert.equal(isApplePlatform('macOS'), true);
  assert.equal(isApplePlatform('MacIntel'), true, 'navigator.platform on every Mac browser');
  assert.equal(isApplePlatform('iPhone'), true);
  assert.equal(isApplePlatform('iPad'), true);
});

test('Windows, Linux and nothing at all are not', () => {
  for (const p of ['Windows', 'Win32', 'Linux x86_64', 'Linux', 'Android', '', null, undefined]) {
    assert.equal(isApplePlatform(p), false, String(p));
  }
});
