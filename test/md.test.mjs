// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedent, splitNotes, applyBuildDirective, renderMarkdownSlide } from '../src/md/markdown.js';

test('dedent strips common indentation', () => {
  const out = dedent('\n      ## Title\n\n      - a\n        - nested\n    ');
  assert.equal(out, '## Title\n\n- a\n  - nested');
});

test('splitNotes divides at the Note: line', () => {
  const { body, notes } = splitNotes('body text\n\nNote:\nthe notes\nmore');
  assert.equal(body, 'body text');
  assert.equal(notes, 'the notes\nmore');
});

test('splitNotes without marker returns null notes', () => {
  assert.equal(splitNotes('just body').notes, null);
  assert.equal(splitNotes('just body').rehearse, null);
});

test('splitNotes: Rehearse: inside the notes splits off cue cards', () => {
  const { body, notes, rehearse } = splitNotes(
    'body\n\nNote:\nfull prose\n\n⟨CLICK⟩\n\nmore prose\n\nRehearse:\ncue one\n\n⟨CLICK⟩\n\ncue two');
  assert.equal(body, 'body');
  assert.equal(notes, 'full prose\n\n⟨CLICK⟩\n\nmore prose');
  assert.equal(rehearse, 'cue one\n\n⟨CLICK⟩\n\ncue two');
  // segmentation parity: same number of markers on both sides
  assert.equal((notes.match(/⟨CLICK⟩/g) ?? []).length, (rehearse.match(/⟨CLICK⟩/g) ?? []).length);
});

test('renderMarkdownSlide carries rehearseHtml', () => {
  const { notesHtml, rehearseHtml } = renderMarkdownSlide('x\n\nNote:\nprose\n\nRehearse:\na cue');
  assert.match(notesHtml, /prose/);
  assert.match(rehearseHtml, /a cue/);
  assert.doesNotMatch(notesHtml, /a cue/);
});

test('applyBuildDirective wraps in data-build div', () => {
  const out = applyBuildDirective('::: build\n- a\n- b\n:::');
  assert.match(out, /^<div data-build>\n/);
  assert.match(out, /\n<\/div>$/);
});

test('applyBuildDirective carries a style', () => {
  assert.match(applyBuildDirective('::: build fade-up\nx\n:::'), /<div data-build="fade-up">/);
});

test('renderMarkdownSlide: html, list inside build parses as markdown', () => {
  const { html, notesHtml } = renderMarkdownSlide(`
    ## Title

    ::: build
    - one with **bold**
    - two
    :::

    Note:
    hello ⟨CLICK⟩ world
  `);
  assert.match(html, /<h2[^>]*>Title<\/h2>/);
  assert.match(html, /<div data-build>/);
  assert.match(html, /<li>one with <strong>bold<\/strong><\/li>/);
  assert.match(notesHtml, /hello ⟨CLICK⟩ world/);
});

test('closing directive must not swallow the separating blank line', () => {
  const out = applyBuildDirective('::: build\n- a\n:::\n\n| t | v |\n|---|---|\n| 1 | 2 |');
  assert.match(out, /<\/div>\n\n\| t \| v \|/);
});

test('content after a build block still parses (table)', () => {
  const { html } = renderMarkdownSlide('::: build\n- a\n- b\n:::\n\n| t | v |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
});

test('renderMarkdownSlide: gfm table renders', () => {
  const { html } = renderMarkdownSlide('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
});

test('renderMarkdownSlide: fenced code keeps language class and escapes html', () => {
  const { html } = renderMarkdownSlide('```sql\nSELECT * FROM t WHERE a < 2;\n```');
  assert.match(html, /class="language-sql"/);
  assert.match(html, /&lt;/);
});
