// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where a write-mode edit lands in the deck file (cli/edit-address.mjs,
// PRESENTING_EDITING): a slide's element by its raw index, a node below it by
// a path of element children and the tag the page saw, one attribute set
// where it stands, one node taken out with its line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPath, locateElement, nodeAt, openElement, attrOf, withAttr, withStyle, withStyleProp, withoutNodes,
} from '../cli/edit-address.mjs';

const DECK = `<div class="decklight">
  <section>
    <h2>Title</h2>
    <svg viewBox="0 0 100 50">
      <g data-node="a">
        <rect x="1" y="2" width="10" height="10"/>
        <text x="6" y="7">A &amp; B</text>
      </g>
      <line x1="0" y1="0" x2="5" y2="5"/>
    </svg>
    <p>Words</p>
  </section>
</div>`;

test('an element is its raw index on the slide; a missing one is said with the count', () => {
  const { parts, idx, r } = locateElement(DECK, 1, 1);
  assert.match(parts[idx].slice(r.start, r.end), /^<svg viewBox/);
  assert.throws(() => locateElement(DECK, 1, 5), /no element at index 5 \(has 3\)/);
});

test('a node is a path of element children: its tag, the chain down to it, the svg it is in', () => {
  const { el } = openElement(DECK, 1, 1);
  const at = nodeAt(el, [0, 1], { slide: 1, index: 1, tag: 'text' });
  assert.equal(at.found, 'text');
  assert.equal(el.slice(at.start, at.end), '<text x="6" y="7">A &amp; B</text>');
  assert.deepEqual(at.chain.map((c) => c.tag), ['svg', 'g']);
  assert.equal(at.parent.tag, 'g');
  assert.equal(at.inSvg, true);
  assert.equal(el.slice(at.svg.start, at.svg.end), el, 'the element itself is the svg');
  assert.equal(nodeAt(el, [], { slide: 1, index: 1 }).inSvg, false, 'the svg is not inside one');
});

test('a path the file does not have, or another tag than the page saw, is stale; a malformed path is a bad request', () => {
  const { el } = openElement(DECK, 1, 1);
  const missing = (() => { try { nodeAt(el, [0, 7], { slide: 1, index: 1 }); } catch (e) { return e; } })();
  assert.equal(missing.code, 'STALE');
  assert.match(missing.message, /no element at 0\.7/);
  const other = (() => { try { nodeAt(el, [1], { slide: 1, index: 1, tag: 'circle' }); } catch (e) { return e; } })();
  assert.equal(other.code, 'STALE');
  assert.match(other.message, /found <circle> at 1, the file has <line>/);
  for (const bad of [null, [-1], [1.5], Array(17).fill(0)]) assert.throws(() => checkPath(bad), /bad path/);
  assert.throws(() => checkPath([], { nested: true }), /bad path/, 'a nested edit never addresses the element itself');
  assert.deepEqual(checkPath([]), []);
});

test('an opened element is edited in place and put back: every other byte of the deck kept', () => {
  const e = openElement(DECK, 1, 1);
  e.edit([0, 0], 'rect', (attrs) => withAttr(attrs, 'x', 20));
  const out = e.html();
  assert.equal(out, DECK.replace('<rect x="1"', '<rect x="20"'));
  assert.equal(e.lead(e.at([0, 0])), '        ', 'what stands before a node on its own line is its indentation');
  assert.equal(e.lead(e.at([])), '    ', 'read in the slide when the node is the element itself');
});

test('one attribute: set where it stands, its quote kept, added last before a self-close, taken off with its space', () => {
  assert.equal(withAttr('<rect x="1" y=\'2\'', 'y', 7), '<rect x="1" y=\'7\'');
  assert.equal(withAttr('<rect x="1" ', 'fill', 'none'), '<rect x="1" fill="none" ');
  assert.equal(withAttr('<rect x="1" data-a="b"', 'data-a', null), '<rect x="1"');
  assert.equal(withAttr('<rect x="1"', 'data-a', null), '<rect x="1"', 'taking off what is not there changes nothing');
  assert.equal(withAttr('<rect\n  X="1"', 'x', 2), '<rect\n  X="2"', 'its spelling and the space before it stay');
});

test('a bare attribute: true writes the name alone, in place or last, and attrOf reads it as present', () => {
  assert.equal(withAttr('<li class="a"', 'data-build-stay', true), '<li class="a" data-build-stay');
  assert.equal(withAttr('<img src="a.png" ', 'controls', true), '<img src="a.png" controls ', 'added before a self-close, the tail kept');
  assert.equal(withAttr('<li data-build-stay="" class="a"', 'data-build-stay', true), '<li data-build-stay class="a"', 'a value it had is dropped where it stands');
  assert.equal(withAttr("<li\n  Data-Build-Stay='x'", 'data-build-stay', true), '<li\n  Data-Build-Stay', 'its spelling and the space before it stay');
  const bare = withAttr('<li', 'data-build-stay', true);
  assert.equal(withAttr(bare, 'data-build-stay', true), bare, 'writing it twice changes nothing');
  assert.equal(attrOf(bare, 'data-build-stay'), '', 'present, with no value');
  assert.equal(withAttr(bare, 'data-build-stay', null), '<li', 'null takes it off');
  assert.equal(withAttr(bare, 'data-build-stay', 'x'), '<li data-build-stay="x"', 'a value given later is written with a quote');
  assert.equal(withAttr('<li', 'data-x', 'true'), '<li data-x="true"', 'the string "true" is still a value');
});

test('ONE escaping rule: alt text keeps & < > " as text, a name or a number is written as it is, and attrOf reads back what was set', () => {
  const alt = 'Tom & Jerry say "<hi>"';
  const head = withAttr('<img src="a.png"', 'alt', alt);
  assert.equal(head, '<img src="a.png" alt="Tom &amp; Jerry say &quot;&lt;hi&gt;&quot;"');
  assert.equal(attrOf(head, 'alt'), alt);
  assert.equal(withAttr('<g', 'data-node', 'box-2'), '<g data-node="box-2"');
  assert.equal(withAttr('<rect', 'width', 12.5), '<rect width="12.5"');
  const single = withAttr("<img alt='x'", 'alt', "it's");
  assert.equal(single, "<img alt='it&#39;s'", 'a quote that would close the attribute is escaped too');
  assert.equal(attrOf(single, 'alt'), "it's");
  assert.equal(attrOf('<img src="a&amp;b.png"', 'src'), 'a&b.png');
  assert.equal(attrOf('<img', 'src'), null);
});

test('one style declaration: replaced in order, added, and a style left empty goes', () => {
  assert.equal(withStyleProp('fill: red; stroke: blue', 'fill', 'green'), 'stroke: blue; fill: green');
  assert.equal(withStyle('<rect style="fill: red"', 'stroke', 'var(--d-stroke)'), '<rect style="fill: red; stroke: var(--d-stroke)"');
  assert.equal(withStyle('<rect x="1" style="fill: red"', 'fill', null), '<rect x="1"');
  assert.equal(withStyle('<rect x="1"', 'fill', null), '<rect x="1"');
});

test('a node out: with its line when it stood alone on one, inline otherwise', () => {
  const text = '<g>\n  <rect/>\n  <line/><circle/>\n</g>';
  const rect = [text.indexOf('<rect'), text.indexOf('<rect') + 7];
  const circle = [text.indexOf('<circle'), text.indexOf('<circle') + 9];
  assert.equal(withoutNodes(text, [rect]), '<g>\n  <line/><circle/>\n</g>');
  assert.equal(withoutNodes(text, [circle, rect]), '<g>\n  <line/>\n</g>', 'several at once, in any order');
});
