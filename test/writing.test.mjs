// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Writing picker's pure half (src/core/writing.js, SPEC PRESENTING_VOICE):
// the tools it lists and the scope rows it offers for a slide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITING_TOOLS, scopeRows } from '../src/core/writing.js';

test('the tools are listed in groups, the script ones first, each with the kind the server knows', () => {
  assert.deepEqual(WRITING_TOOLS.map((t) => [t.id, t.group, t.kind]),
    [['rewrite', 'script', 'rewrite'], ['tags', 'script', 'tags'], ['spoken', 'script', 'spoken'], ['match-slide', 'script', 'match-slide'], ['tighten', 'text', 'tighten'], ['typos', 'text', 'typos'], ['match', 'text', 'match'], ['custom', 'text', 'custom']]);
  for (const t of WRITING_TOOLS) assert.ok(t.label && t.flavor, `${t.id} has a label and a flavor`);
  assert.ok(WRITING_TOOLS.find((t) => t.id === 'custom').asks, 'the custom tool asks for a line first');
  assert.ok(WRITING_TOOLS.filter((t) => t.id !== 'custom').every((t) => !t.asks));
});

test('scopeRows: this slide and the whole deck always, the module only when the slide is in one', () => {
  assert.deepEqual(scopeRows(4, 42, null).map((r) => [r.scope, r.label]), [['slide', 'this slide · 4'], ['all', 'whole deck · 42']]);
  assert.deepEqual(scopeRows(4, 42, { title: 'Setup', from: 3, to: 8 }).map((r) => [r.scope, r.label]),
    [['slide', 'this slide · 4'], ['module', 'module “Setup” · 6'], ['all', 'whole deck · 42']]);
  assert.match(scopeRows(4, 42, { title: 'Setup', from: 3, to: 8 })[1].flavor, /slides 3–8/);
});

test('scopeRows: a passage of the notes (the selection, or a build) leads, and this slide says it means all of it', () => {
  const sel = { scope: 'selection', label: 'the selection · 4 words', flavor: '“the cache pays off”', text: 'the cache pays off', from: 10, to: 28 };
  const rows = scopeRows(4, 42, null, sel);
  assert.deepEqual(rows.map((r) => r.scope), ['selection', 'slide', 'all']);
  assert.deepEqual([rows[0].label, rows[0].flavor], [sel.label, sel.flavor]);
  assert.equal(rows[0].passage, sel, 'the row carries what to send');
  assert.equal(rows[1].flavor, 'all of its notes');
});

test('the tools that take a passage: rewrite, the tags and the spoken rewrite; matching and the slide text never', () => {
  assert.deepEqual(WRITING_TOOLS.filter((t) => t.part).map((t) => t.id), ['rewrite', 'tags', 'spoken']);
});
