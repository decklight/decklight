// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The notes editor's before/after (src/core/worddiff.js): what changed, word
// by word, between the notes as last saved and the box.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, diffCounts, refineRuns, diffHunks, punctuationOnly } from '../src/core/worddiff.js';

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

test('a word that only changed a little is read letter by letter: the comma, not the whole word', () => {
  const a = "Data freshness is not a nice-to-have, it's a requirement";
  const b = "Data freshness is not a nice-to-have; it's a requirement";
  const runs = refineRuns(wordDiff(a, b));
  assert.deepEqual(runs.filter((r) => r.op !== '='), [{ op: '-', text: ',' }, { op: '+', text: ';' }]);
  assert.equal(side(runs, '-'), a);
  assert.equal(side(runs, '+'), b);
  const typo = refineRuns(wordDiff('a recieved letter', 'a received letter'));
  assert.equal(side(typo, '-'), 'a recieved letter');
  assert.equal(side(typo, '+'), 'a received letter');
  assert.ok(typo.filter((r) => r.op !== '=').every((r) => r.text.length === 1), 'only the swapped letters are marked');
});

test('a word swapped for an unlike one stays a whole word', () => {
  assert.deepEqual(refineRuns(wordDiff('a dog barks', 'a cat barks')),
    [{ op: '=', text: 'a ' }, { op: '-', text: 'dog' }, { op: '+', text: 'cat' }, { op: '=', text: ' barks' }]);
  assert.deepEqual(refineRuns(wordDiff('end.', 'end!')).filter((r) => r.op !== '='), [{ op: '-', text: '.' }, { op: '+', text: '!' }]);
  assert.deepEqual(refineRuns(wordDiff('—', '-')), [{ op: '-', text: '—' }, { op: '+', text: '-' }], 'nothing but punctuation in common is no likeness');
});

test('the changes as pieces, one per place, whole words, with where each starts', () => {
  assert.deepEqual(diffHunks(wordDiff('one two three four five', 'one 2 3 four five six')),
    [{ before: 'two three', after: '2 3', at: 4 }, { before: '', after: 'six', at: 23 }]);
  assert.deepEqual(diffHunks(wordDiff('the the cat', 'the cat')), [{ before: 'the', after: '', at: 4 }]);
  assert.deepEqual(diffHunks(wordDiff('same', 'same')), []);
});

test('punctuation only: a comma for a semicolon, a hyphen, a space, but no letter', () => {
  assert.equal(punctuationOnly('nice-to-have, it', 'nice-to-have; it'), true);
  assert.equal(punctuationOnly('re use', 're-use'), true);
  assert.equal(punctuationOnly('teh', 'the'), false);
  assert.equal(punctuationOnly('Word', 'word'), false, 'case is a letter changing');
  assert.equal(punctuationOnly('same', 'same'), false);
});
