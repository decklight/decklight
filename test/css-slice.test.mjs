// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The CSS a borrowed slide needs, cut out of the deck it came from
// (UNITS#REST). A template's design is half markup and half stylesheet, and
// taking only the markup lands a slide that is structurally right and looks
// like nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRules, selectorTargets, markupTargets, styleTargets, sliceFor, danglingVars } from '../tools/css-slice.mjs';
import { mergeHeadStyle } from '../tools/deck-html.mjs';

test('a selector names the classes and ids it actually targets', () => {
  assert.deepEqual([...selectorTargets('.a .b > i#x').classes], ['a', 'b']);
  assert.deepEqual([...selectorTargets('.a .b > i#x').ids], ['x']);
  assert.deepEqual([...selectorTargets('[data-x=".ghost"]').classes], [],
    'an attribute VALUE is not a selector');
  assert.deepEqual([...selectorTargets('p, li').classes], []);
});

test('splitting survives braces in strings, comments and nested at-rules', () => {
  const rules = splitRules(`
    /* a { comment } */
    .a { content: "}"; }
    @media (min-width: 40em) { .b { color: red } }
    @import url(x.css);
  `);
  assert.deepEqual(rules.map((r) => r.kind), ['rule', 'group', 'statement']);
  assert.equal(rules[0].selector, '.a');
  assert.equal(rules[1].inner.length, 1);
  assert.equal(rules[1].inner[0].selector, '.b');
});

test('the rules a slide uses come across; the ones it does not, stay', () => {
  const css = '.breaks { gap: 12px } .breaks li { padding: 1px } .promises { display: flex }';
  const { css: out, carried } = sliceFor(css, '<ul class="breaks"><li>x</li></ul>');
  assert.deepEqual(carried, ['.breaks']);
  assert.match(out, /\.breaks \{ gap: 12px \}/);
  assert.match(out, /\.breaks li \{ padding: 1px \}/);
  assert.doesNotMatch(out, /promises/, 'a rule for a slide nobody took is not this slide’s rule');
});

test('a rule that names no class or id is never carried', () => {
  const { css, carried } = sliceFor('p { margin: 0 } .k { margin: 1px }', '<p class="k">x</p>');
  assert.deepEqual(carried, ['.k']);
  assert.doesNotMatch(css, /^p \{/m,
    "somebody else's bare `p` rule would restyle every paragraph in the receiving deck");
});

test('a rule is re-wrapped in the condition it was written under', () => {
  const { css } = sliceFor('@media print { .k { color: black } }', '<div class="k"></div>');
  assert.match(css, /@media print \{[\s\S]*\.k \{ color: black \}[\s\S]*\}/,
    'a rule lifted out of its @media is a rule that now applies always');
});

test('the keyframes a carried rule animates come with it', () => {
  const css = '@keyframes fade { from { opacity: 0 } } @keyframes unused { from { opacity: 0 } } .k { animation: fade .3s }';
  const out = sliceFor(css, '<div class="k"></div>').css;
  assert.match(out, /@keyframes fade/);
  assert.doesNotMatch(out, /unused/);
});

test('a class the receiving deck already styles is refused, not resolved', () => {
  const css = '.breaks { gap: 12px } .fine { gap: 2px }';
  const { css: out, carried, clashed } = sliceFor(css, '<ul class="breaks fine"></ul>', {
    // what the RECEIVING deck's own stylesheet already gives rules to
    defined: styleTargets('.breaks { gap: 99px }'),
  });
  assert.deepEqual(clashed, ['.breaks'], 'named once, however many rules used it');
  assert.deepEqual(carried, ['.fine']);
  assert.doesNotMatch(out, /gap: 12px/,
    'carrying it would restyle slides the author never touched');
});

test('a custom property that stayed behind is named, not silently missing', () => {
  const source = ':root { --card-bg: #123 } .k { background: var(--card-bg); color: var(--fg) }';
  const { css } = sliceFor(source, '<div class="k"></div>');
  assert.deepEqual(danglingVars(css, source), ['--card-bg'],
    'declared on :root, which names no class and so cannot travel');
  assert.deepEqual(danglingVars(css, source, new Set(['--card-bg'])), [],
    'a property the receiving deck already defines is not missing');
});

test('carried rules land in one marked block, and a second insert merges into it', () => {
  const deck = '<html><head><title>t</title></head><body><div class="decklight"></div></body></html>';
  const once = mergeHeadStyle(deck, 'demo-pitch', '.breaks { gap: 12px }');
  assert.match(once, /<style data-from-template="demo-pitch">/);
  const twice = mergeHeadStyle(once, 'demo-pitch', '.breaks { gap: 12px }\n.promises { display: flex }');
  assert.equal(twice.match(/<style data-from-template/g).length, 1, 'one block, not a stack of them');
  assert.equal(twice.match(/\.breaks \{ gap: 12px \}/g).length, 1, 'a shared class is not written twice');
  assert.match(twice, /\.promises \{ display: flex \}/);
});

test('a deck with no head still gets the rules somewhere they apply', () => {
  const out = mergeHeadStyle('<div class="decklight"><section></section></div>', 'x', '.k { gap: 0 }');
  assert.match(out, /<style data-from-template="x">[\s\S]*<section/,
    'before the first slide is the next best place a stylesheet can sit');
});

test('the two readers are not interchangeable', () => {
  // feeding a stylesheet to the markup reader finds nothing at all, quietly —
  // which is exactly the bug the route test caught
  assert.deepEqual([...markupTargets('.breaks { gap: 1px }').classes], []);
  assert.deepEqual([...styleTargets('.breaks { gap: 1px }').classes], ['breaks']);
  assert.deepEqual([...markupTargets('<div class="breaks">').classes], ['breaks']);
  assert.deepEqual([...styleTargets('<div class="breaks">').classes], []);
});
