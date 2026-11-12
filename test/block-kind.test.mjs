// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Turn into ▸ (PRESENTING_EDITING): a text block made another kind, the
// words, their emphasis and a nested list carried as written, only the tags
// around them changed, and a build that keeps meaning the same thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retagBlock, kindOf, kindsFor, KINDS } from '../src/core/block-kind.js';

const LIST = '<ul data-build class="tight">\n      <li>One <strong>bold</strong></li>\n      <li>Two\n        <ul>\n          <li>Two a</li>\n        </ul>\n      </li>\n    </ul>';

test('bullets to numbered and back: the two tag names, every point, its nesting and its emphasis kept', () => {
  const ol = retagBlock(LIST, 'numbered');
  assert.equal(ol.html, LIST.replace(/^<ul/, '<ol').replace(/<\/ul>$/, '</ol>'));
  assert.equal(ol.build, 'same');
  assert.equal(retagBlock(ol.html, 'bullets').html, LIST);
  assert.equal(retagBlock('<ol start="3" type="a" reversed><li>x</li></ol>', 'bullets').html, '<ul><li>x</li></ul>', 'what only a numbered list means goes');
});

test('text, a heading and a small heading are the same words under another tag', () => {
  assert.equal(retagBlock('<p class="lead">Hello <em>there</em></p>', 'heading').html, '<h2 class="lead">Hello <em>there</em></h2>');
  assert.equal(retagBlock('<h2>Title</h2>', 'small').html, '<h3>Title</h3>');
  assert.equal(retagBlock('<h3>Small</h3>', 'text').html, '<p>Small</p>');
  assert.equal(retagBlock('<p>Words</p>', 'quote').html, '<blockquote>Words</blockquote>');
  assert.equal(retagBlock('<blockquote>Said <em>this</em></blockquote>', 'text').html, '<p>Said <em>this</em></p>');
});

test('a paragraph made a list is one point; a list made text is one paragraph a point, its build still a step a point', () => {
  assert.equal(retagBlock('<p data-build>Only <b>one</b></p>', 'bullets').html, '<ul data-build><li>Only <b>one</b></li></ul>');
  const out = retagBlock(LIST, 'text');
  assert.equal(out.blocks, 3);
  assert.equal(out.build, 'same');
  assert.equal(out.html, '<p data-build class="tight">One <strong>bold</strong></p>\n    <p data-build class="tight">Two</p>\n    <p data-build class="tight">Two a</p>',
    'on lines of their own, at the list\'s indentation, each with its attributes');
  assert.equal(retagBlock('<ul><li>a</li><li>b</li></ul>', 'heading').html, '<h2>a</h2><h2>b</h2>', 'a list on one line stays on one line');
  assert.equal(retagBlock('<ul id="x"><li>a</li><li>b</li></ul>', 'text').html, '<p id="x">a</p><p>b</p>', 'an id is one: the first keeps it');
});

test('a list made a quote is one quote of its points, and a build on it is now one step', () => {
  const q = retagBlock('<ul data-build><li>a</li><li>b</li></ul>', 'quote');
  assert.equal(q.html, '<blockquote data-build><p>a</p><p>b</p></blockquote>');
  assert.equal(q.build, 'one');
  assert.equal(retagBlock('<ul><li>a</li></ul>', 'quote').html, '<blockquote>a</blockquote>');
  assert.equal(retagBlock('<blockquote data-build><p>a</p><p>b</p></blockquote>', 'bullets').build, 'each');
  assert.equal(retagBlock('<blockquote><p>a</p><p>b</p></blockquote>', 'text').html, '<p>a</p><p>b</p>');
});

test('the same kind is no change; anything else is refused', () => {
  assert.equal(retagBlock('<p>x</p>', 'text').html, '<p>x</p>');
  assert.equal(retagBlock('<h1>Title card</h1>', 'heading').html, '<h1>Title card</h1>', 'a title card stays the heading it is');
  assert.throws(() => retagBlock('<table><tr><td>x</td></tr></table>', 'text'), /only text, a heading, a quote or a list/);
  assert.throws(() => retagBlock('<p>x</p>', 'table'), /not a kind/);
  assert.throws(() => retagBlock('<ul></ul>', 'text'), /nothing in it/);
});

test('what the menu offers: every kind, its own ticked, a title held to a heading with the reason', () => {
  assert.deepEqual(KINDS.map(([k]) => k), ['text', 'heading', 'small', 'quote', 'bullets', 'numbered']);
  assert.equal(kindOf('H2'), 'heading');
  assert.equal(kindOf('div'), null);
  const p = kindsFor('p');
  assert.deepEqual(p.filter((k) => k.current).map((k) => k.kind), ['text']);
  assert.ok(p.every((k) => !k.disabled));
  const title = kindsFor('h2', { isTitle: true });
  assert.deepEqual(title.filter((k) => !k.disabled).map((k) => k.kind), ['heading']);
  assert.match(title[0].disabled, /title/);
});

import { joinBlocks, JOIN_KINDS } from '../src/core/block-kind.js';

test('joinBlocks: several blocks into one list or one quote, what is inside each carried as written', () => {
  assert.deepEqual(JOIN_KINDS, ['bullets', 'numbered', 'quote']);
  const list = joinBlocks(['<p>One <strong>bold</strong></p>', '<h3>Two</h3>', '<ul><li>three</li><li>four</li></ul>'], 'bullets');
  assert.equal(list.html, '<ul>\n  <li>One <strong>bold</strong></li>\n  <li>Two</li>\n  <li>three</li>\n  <li>four</li>\n</ul>');
  assert.equal(list.pieces, 4);
  assert.equal(list.build, 'none');
  // every one built: the list builds a point a step, as they did
  assert.deepEqual(joinBlocks(['<p data-build>a</p>', '<p data-build="fade">b</p>'], 'numbered'), { html: '<ol data-build>\n  <li>a</li>\n  <li>b</li>\n</ol>', pieces: 2, build: 'same' });
  // a quote that builds arrives whole; only some built: none, and said
  assert.equal(joinBlocks(['<p data-build>a</p>', '<p data-build>b</p>'], 'quote').build, 'one');
  assert.equal(joinBlocks(['<p data-build>a</p>', '<p>b</p>'], 'quote').html, '<blockquote>\n  <p>a</p>\n  <p>b</p>\n</blockquote>');
  assert.equal(joinBlocks(['<p data-build>a</p>', '<p>b</p>'], 'quote').build, 'some');
  assert.throws(() => joinBlocks(['<p>a</p>'], 'bullets'), /two blocks or more/);
  assert.throws(() => joinBlocks(['<p>a</p>', '<img src="x.png">'], 'bullets'), /only text, headings, quotes and lists/);
  assert.throws(() => joinBlocks(['<p>a</p>', '<p>b</p>'], 'heading'), /a list or a quote/);
});
