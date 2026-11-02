// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What the page holds that the file does not (src/core/drafts.js,
// PRESENTING_EDITING): the reload asks it before throwing the page away, and
// the bar says what it waits for. The bar and the reload are the engine
// harness's (heldreload, savefail); what they are told is decided here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdDraft, unsavedDrafts, draftList, heldReloadText } from '../src/core/drafts.js';

test('a draft is held while its place says so, and let go when it closes', () => {
  let text = '';
  const letGo = holdDraft(() => (text ? 'the notes on slide 3' : null));
  assert.deepEqual(unsavedDrafts(), []);
  text = 'half a sentence';
  assert.deepEqual(unsavedDrafts(), ['the notes on slide 3']);
  letGo();
  assert.deepEqual(unsavedDrafts(), []);
});

test('a place that throws holds nothing, and one said twice is said once', () => {
  const a = holdDraft(() => { throw new Error('closed'); });
  const b = holdDraft(() => 'your comment');
  const c = holdDraft(() => 'your comment');
  assert.deepEqual(unsavedDrafts(), ['your comment']);
  a(); b(); c();
  assert.deepEqual(unsavedDrafts(), []);
});

test('the bar names what it waits for, in one sentence', () => {
  assert.equal(draftList([]), '');
  assert.equal(draftList(['a']), 'a');
  assert.equal(draftList(['a', 'b', 'c']), 'a, b and c');
  assert.equal(heldReloadText(['the notes on slide 2']),
    'The deck changed on disk. It reloads by itself once you save or close the notes on slide 2, so nothing you typed is lost.');
  assert.match(heldReloadText(['the notes on slide 2', 'your comment']), /once you save or close the notes on slide 2 and your comment,/);
});
