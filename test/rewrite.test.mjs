// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The slide-text writing tools (cli/rewrite.mjs, SPEC PRESENTING_WRITING):
// the runs the agent is shown, the answer put back, and the checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textRuns, withRuns, parseRuns, rewriteProblem, rewritable, applyRewritten, rewritePrompt, TOOLS } from '../cli/rewrite.mjs';

const CONTENT = '\n  <h2>Hello &amp; welcome</h2>\n  <ul><li>one <em>two</em></li><li>three</li></ul>\n  <pre>code here</pre>\n  <aside class="notes"><p>Say this.</p></aside>\n';
const DECK = `<div class="decklight">\n<section>${CONTENT}</section>\n<section data-hidden>\n<p>hidden</p>\n</section>\n<section>\n<p>last</p>\n</section>\n</div>`;

test('textRuns: the words between tags, numbered, decoded; code, notes and markup are not runs', () => {
  assert.deepEqual(textRuns(CONTENT).map((r) => [r.n, r.text]), [[1, 'Hello & welcome'], [2, 'one'], [3, 'two'], [4, 'three']]);
  assert.deepEqual(textRuns('<p>  </p><p>…</p>'), [], 'whitespace and bare punctuation are not runs');
});

test('withRuns puts the answers back where they came from, encoded, and leaves the rest byte for byte', () => {
  const runs = textRuns(CONTENT);
  const out = withRuns(CONTENT, runs, new Map([[1, 'Hi & bye'], [4, 'tres']]));
  assert.equal(out, '\n  <h2>Hi &amp; bye</h2>\n  <ul><li>one <em>two</em></li><li>tres</li></ul>\n  <pre>code here</pre>\n  <aside class="notes"><p>Say this.</p></aside>\n');
});

test('parseRuns reads `n: text` lines, any separator, and ignores the rest', () => {
  assert.deepEqual([...parseRuns('```\n1: Hi\n2. two\n3) x\nnoise\n4: tres\n```')], [[1, 'Hi'], [2, 'two'], [3, 'x'], [4, 'tres']]);
});

test('rewriteProblem: every run answered, none emptied, no markup, and each tool\'s own rule', () => {
  const runs = textRuns(CONTENT);
  const ok = parseRuns('1: Hello & welcome\n2: one\n3: two\n4: three');
  assert.equal(rewriteProblem('typos', runs, ok), null);
  assert.match(rewriteProblem('typos', runs, parseRuns('1: Hello\n2: one\n4: three')), /skipped run 3/);
  assert.match(rewriteProblem('typos', runs, parseRuns('1: Hello\n2: one\n3: \n4: three')), /emptied run 3/);
  assert.match(rewriteProblem('typos', runs, parseRuns('1: <b>Hello</b>\n2: one\n3: two\n4: three')), /markup/);
  assert.match(rewriteProblem('typos', runs, parseRuns('1: Completely different words here\n2: one\n3: two\n4: three')), /reworded run 1/);
  assert.equal(rewriteProblem('typos', runs, parseRuns('1: Hello & welcome!\n2: One\n3: two\n4: three')), null, 'a few characters per word is a typo fix');
  assert.match(rewriteProblem('tighten', runs, parseRuns('1: Hello and a very warm welcome\n2: one\n3: two\n4: three')), /longer/);
  assert.equal(rewriteProblem('tighten', runs, parseRuns('1: Welcome\n2: one\n3: two\n4: three')), null);
  assert.match(rewriteProblem('match', runs, parseRuns('1: a b c d e f g h i j k l m n o p\n2: q r s t u v\n3: w x y z a b\n4: c d e f g h')), /far longer/);
  assert.match(rewriteProblem('custom', runs, new Map()), /answered nothing/);
});

test('rewritable lists shown slides with text, with their notes; applyRewritten writes only what still reads the same', () => {
  const todo = rewritable(DECK);
  assert.deepEqual(todo.map((t) => [t.slide, t.runs.length, t.notes]), [[1, 4, 'Say this.'], [3, 1, '']]);
  assert.deepEqual(rewritable(DECK, [3]).map((t) => t.slide), [3]);
  const texts = new Map([[1, 'Hey'], [2, 'one'], [3, 'two'], [4, 'three']]);
  const out = applyRewritten(DECK, [{ slide: 1, ok: true, changed: true, runs: todo[0].runs, texts }]);
  assert.deepEqual(out.stale, []);
  assert.match(out.html, /<h2>Hey<\/h2>/);
  assert.match(out.html, /<p>last<\/p>/);
  const moved = DECK.replace('Hello &amp; welcome', 'Hello there');
  const late = applyRewritten(moved, [{ slide: 1, ok: true, changed: true, runs: todo[0].runs, texts }]);
  assert.deepEqual(late.stale, [1], 'a slide edited meanwhile keeps the edit');
  assert.equal(late.html, moved);
});

test('rewritePrompt carries the tool\'s ask, the rules, the runs, and the notes only for match', () => {
  const runs = textRuns(CONTENT);
  const p = rewritePrompt('match', runs, { notes: 'the notes' });
  assert.match(p, /# Notes\n\nthe notes/);
  assert.match(p, /# Runs\n\n1: Hello & welcome\n2: one/);
  assert.doesNotMatch(rewritePrompt('tighten', runs, { notes: 'the notes' }), /# Notes/);
  assert.match(rewritePrompt('custom', runs, { instruction: 'use British spelling' }), /use British spelling/);
  assert.deepEqual(Object.keys(TOOLS), ['tighten', 'typos', 'match', 'custom']);
});
