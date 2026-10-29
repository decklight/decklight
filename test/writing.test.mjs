// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Writing picker's pure half (src/core/writing.js, SPEC PRESENTING_VOICE):
// the tools it lists and the scope rows it offers for a slide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITING_TOOLS, scopeRows } from '../src/core/writing.js';

test('the tools are listed in groups, the script ones first, each with the kind the server knows', () => {
  assert.deepEqual(WRITING_TOOLS.map((t) => [t.id, t.group, t.kind]), [['tags', 'script', 'tags'], ['spoken', 'script', 'spoken']]);
  for (const t of WRITING_TOOLS) assert.ok(t.label && t.flavor, `${t.id} has a label and a flavor`);
});

test('scopeRows: this slide and the whole deck always, the module only when the slide is in one', () => {
  assert.deepEqual(scopeRows(4, 42, null).map((r) => [r.scope, r.label]), [['slide', 'this slide · 4'], ['all', 'whole deck · 42']]);
  assert.deepEqual(scopeRows(4, 42, { title: 'Setup', from: 3, to: 8 }).map((r) => [r.scope, r.label]),
    [['slide', 'this slide · 4'], ['module', 'module “Setup” · 6'], ['all', 'whole deck · 42']]);
  assert.match(scopeRows(4, 42, { title: 'Setup', from: 3, to: 8 })[1].flavor, /slides 3–8/);
});
