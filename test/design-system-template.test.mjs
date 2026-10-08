// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Referenced templates in the engine (SPEC DESIGN_SYSTEMS, #623) — the pure
// half: which `data-template` values name a slide template. The DOM half
// (expansion, slots, fallbacks, idempotence, builds) runs in a real browser:
// test/design-system.html, driven by test/design-system-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTemplateRef, parseTemplateRef } from '../src/core/design-system.js';

test('a slash names a slide template; the built-in ring never has one, so the two cannot collide', () => {
  for (const v of ['acme/section-divider', 'x/y']) assert.equal(isTemplateRef(v), true, v);
  for (const v of ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip', '', null, undefined]) assert.equal(isTemplateRef(v), false, String(v));
  assert.deepEqual(parseTemplateRef('acme/section-divider'), { system: 'acme', template: 'section-divider' });
  for (const v of ['acme/', '/divider', 'Acme/x', 'a/b/c', 'acme/sec divider']) assert.equal(parseTemplateRef(v), null, v);
});
