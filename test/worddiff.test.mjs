// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The notes editor's before/after (src/core/worddiff.js): what changed, word
// by word, between the notes as last saved and the box.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, diffCounts } from '../src/core/worddiff.js';

const side = (runs, keep) => runs.filter((r) => r.op === '=' || r.op === keep).map((r) => r.text).join('');

test('both texts come back out of the diff, exactly — line breaks and [click] lines included', () => {
  const a = 'Fluffed a line? Backspace retakes it.\n\n[click]\n\nEscape stops.';
  const b = 'And if you fluff a line, just press Backspace to take it again.\n\n[click]\n\nWhen you press Escape, it stops.';
  const runs = wordDiff(a, b);
  assert.equal(side(runs, '-'), a);
  assert.equal(side(runs, '+'), b);
  assert.ok(runs.some((r) => r.op === '=' && r.text.includes('[click]')), 'the beat is untouched, so it shows as untouched');
});

test('an added audio tag is one insertion and nothing removed', () => {
  const runs = wordDiff('Hello there.', '[warm] Hello there.');
  assert.deepEqual(runs, [{ op: '+', text: '[warm] ' }, { op: '=', text: 'Hello there.' }]);
  assert.deepEqual(diffCounts(runs), { removed: 0, added: 1 });
});

test('the same text is one unchanged run; empty against something is all one side', () => {
  assert.deepEqual(wordDiff('same words', 'same words'), [{ op: '=', text: 'same words' }]);
  assert.deepEqual(wordDiff('', 'new'), [{ op: '+', text: 'new' }]);
  assert.deepEqual(wordDiff('old', ''), [{ op: '-', text: 'old' }]);
  assert.deepEqual(diffCounts(wordDiff('one two three', 'one three four')), { removed: 1, added: 1 });
});

test('a pair too big for the word table falls back to whole lines, still exact', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `line ${i} words here`).join('\n');
  const b = a.replace('line 7 words here', 'line seven words here');
  const runs = wordDiff(a, b);
  assert.equal(side(runs, '-'), a);
  assert.equal(side(runs, '+'), b);
  assert.deepEqual(diffCounts(runs), { removed: 4, added: 4 }, 'the changed LINE, not the whole text');
});
