// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// slideTitle and slideBody, on their own rather than through buildIndex.
// test/finder.test.mjs exercises them from above, where a title is only ever
// as long as the fixture — so the edges were never touched: the exact fallback
// chain, what a body counts as content, and where a title gets cut. These two
// functions are not only the finder's (SPEC PRESENTING): a review comment
// records the title of the slide it was written on and resolves against it
// when the fingerprint no longer matches (SPEC REVIEW), so anything that can
// change a title quietly re-labels somebody's comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slideTitle, slideBody } from '../src/core/finder.js';

// The members these two call: children, textContent, matches (slideBody) and
// querySelector (slideTitle). Nothing else — no parent, no layout, no styles.
function el(tag, { text = '', children = [] } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    children,
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
    matches: (sel) => String(sel).split(',').some((s) => s.trim().toLowerCase() === tag.toLowerCase()),
  };
  return node;
}

function descendants(node, out = []) {
  for (const c of node.children) { out.push(c); descendants(c, out); }
  return out;
}

function section(children = []) {
  const node = {
    children,
    querySelector: (sel) => {
      const tags = String(sel).split(',').map((s) => s.trim().toLowerCase());
      return descendants(node).find((c) => tags.includes(c.tagName.toLowerCase())) ?? null;
    },
  };
  return node;
}

// ── slideTitle ─────────────────────────────────────────────────────────────

test('a heading is the title verbatim, with its whitespace collapsed', () => {
  const s = section([el('h2', { text: '  Deploy\n  the   pipeline  ' }), el('p', { text: 'body' })]);
  assert.equal(slideTitle(s, 0, slideBody(s)), 'Deploy the pipeline',
    'the file\'s line breaks are the author\'s formatting, not part of the name');
});

test('the first heading wins, at whatever level it sits', () => {
  const s = section([el('h3', { text: 'Subhead first' }), el('h1', { text: 'Later h1' })]);
  assert.equal(slideTitle(s, 0, slideBody(s)), 'Subhead first',
    'document order, so the title matches what the audience reads at the top');
});

test('a heading nested inside a wrapper still titles the slide', () => {
  const s = section([el('div', { children: [el('h2', { text: 'Inside a column' })] })]);
  assert.equal(slideTitle(s, 0, slideBody(s)), 'Inside a column',
    'a split layout wraps its heading — that must not lose the slide its name');
});

test('a slide with no heading is titled by the first 60 characters of its body', () => {
  const body = 'A slide that never got a heading but has a great deal of prose on it anyway';
  const title = slideTitle(section(), 0, body);
  assert.equal(title.length, 60, 'a title that fills the finder row is no longer a title');
  assert.equal(title, body.slice(0, 60));
});

test('a shorter body is used whole, not padded or cut', () => {
  assert.equal(slideTitle(section(), 0, 'Just a few words'), 'Just a few words');
});

test('a slide with neither heading nor body is titled by its number, 1-based', () => {
  assert.equal(slideTitle(section(), 0, ''), 'slide 1',
    'a picture-only slide is still something the presenter has to be able to jump to');
  assert.equal(slideTitle(section(), 41, ''), 'slide 42', 'the index is 0-based, the name is not');
});

test('an empty heading does not win over the body', () => {
  const s = section([el('h2', { text: '   ' }), el('p', { text: 'the real content' })]);
  assert.equal(slideTitle(s, 0, slideBody(s)), 'the real content',
    'a blank <h2> left over from a template must not name the slide the empty string');
});

// ── astral characters ──────────────────────────────────────────────────────
// The heading path is NOT cut — only the body fallback is — so an emoji
// heading is safe however long it runs. The body fallback slices by UTF-16
// code unit, which can land between the halves of a surrogate pair.

test('a heading is never truncated, however long, so an emoji title survives whole', () => {
  const heading = `${'🌍'.repeat(40)} the whole world`;
  const s = section([el('h2', { text: heading })]);
  assert.equal(slideTitle(s, 0, ''), heading,
    'only the body fallback has a length limit; a heading is the author\'s own words');
});

// Was a bug: slideTitle slices the body with String#slice(0, 60), which cuts by
// UTF-16 code unit: a body whose 60th unit is the high half of a surrogate pair
// yields a title ending in a lone surrogate, which renders as U+FFFD in the
// finder and in a comment's remembered title
test('a title cut out of the body never ends in half an emoji', () => {
  // 'x' then 30 emoji: the pair straddles index 59/60, so the cut splits it.
  const body = `x${'😀'.repeat(30)}`;
  const title = slideTitle(section(), 0, body);
  const last = title.charCodeAt(title.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff),
    'a lone high surrogate is not a character — the finder row shows a replacement glyph');
});

// ── slideBody ──────────────────────────────────────────────────────────────

test('the body is every top-level child\'s text, joined and flattened', () => {
  const s = section([el('h2', { text: 'Title' }), el('p', { text: 'first' }), el('p', { text: 'second' })]);
  assert.equal(slideBody(s), 'Title first second',
    'the heading counts as body text too — searching for it must find the slide');
});

test('notes, scripts and styles are not body text', () => {
  const s = section([
    el('p', { text: 'on screen' }),
    el('aside', { text: 'remember the discount' }),
    el('script', { text: 'const spec = 1;' }),
    el('style', { text: '.x { color: red }' }),
  ]);
  assert.equal(slideBody(s), 'on screen',
    'a comment is about what the audience saw, so rewriting your own notes must not re-fingerprint the slide');
});

test('the text of a nested child counts, however deep', () => {
  const s = section([
    el('div', { children: [el('ul', { children: [el('li', { text: 'one' }), el('li', { text: 'two' })] })] }),
  ]);
  assert.equal(slideBody(s), 'onetwo',
    'only TOP-LEVEL children are filtered; below that it is one run of text');
});

test('an aside is only skipped as a top-level child, not inside one', () => {
  const s = section([el('div', { children: [el('aside', { text: 'nested note' })] })]);
  assert.equal(slideBody(s), 'nested note',
    'pinned as it behaves: speaker notes are a section-level child by construction');
});

test('a slide with nothing in it has an empty body rather than whitespace', () => {
  assert.equal(slideBody(section()), '');
  assert.equal(slideBody(section([el('p', { text: '  \n ' })])), '',
    'an empty string is what sends slideTitle on to the slide number');
});
