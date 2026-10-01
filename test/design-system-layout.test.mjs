// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Referenced layouts in the engine (SPEC DESIGN_SYSTEMS, #623) — the pure
// half: which `data-layout` values name a design-system layout. The DOM half
// (expansion, slots, fallbacks, idempotence, builds) runs in a real browser:
// test/design-system.html, driven by test/design-system-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemLayout, parseSystemLayout } from '../src/core/design-system.js';

test('a slash names a design-system layout; the built-in ring never has one, so the two cannot collide', () => {
  for (const v of ['acme/section-divider', 'x/y']) assert.equal(isSystemLayout(v), true, v);
  for (const v of ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip', '', null, undefined]) assert.equal(isSystemLayout(v), false, String(v));
  assert.deepEqual(parseSystemLayout('acme/section-divider'), { system: 'acme', layout: 'section-divider' });
  for (const v of ['acme/', '/divider', 'Acme/x', 'a/b/c', 'acme/sec divider']) assert.equal(parseSystemLayout(v), null, v);
});
