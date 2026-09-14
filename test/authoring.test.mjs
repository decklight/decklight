// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The decidable half of mouse editing in author mode (src/core/authoring.js,
// SPEC PRESENTING): which element a double-click may edit, the path that finds
// the same node in the element's SOURCE, and what a dropped file becomes. The
// gestures themselves — contenteditable, drag and drop — need a browser and
// are the engine harness's business; everything a wrong answer here would
// corrupt (the file) is decided by these functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITABLE, NOT_EDITABLE, altFromName, childPath, editableTarget, imageFiles, nodeAtPath,
} from '../src/core/authoring.js';

/** A duck-typed element tree: tag, children, and the two traversal methods used. */
function el(tag, children = [], attrs = {}) {
  const node = { tag, children: [], parentElement: null, attrs, innerHTML: attrs.html ?? '' };
  for (const c of children) { c.parentElement = node; node.children.push(c); }
  node.matches = (sel) => sel.split(',').map((s) => s.trim()).some((s) => selectorHits(node, s));
  node.closest = (sel) => { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; };
  node.contains = (other) => { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; };
  node.hasAttribute = (k) => k in attrs;
  return node;
}
// the few selector shapes EDITABLE / NOT_EDITABLE use: a tag, `.class`, `[attr]`, `tag[attr]`
function selectorHits(node, sel) {
  const m = /^([a-z0-9]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(sel);
  if (!m) return false;
  const [, tag, cls, attr] = m;
  if (tag && node.tag !== tag) return false;
  if (cls && !(node.attrs.class ?? '').split(/\s+/).includes(cls)) return false;
  if (attr && !(attr in node.attrs)) return false;
  return true;
}

test('the path from a top-level element to a node counts element children only, and walks the source the same way', () => {
  const li2 = el('li');
  const ul = el('ul', [el('li'), li2, el('li')]);
  const top = el('div', [el('h3'), ul]);
  assert.deepEqual(childPath(top, li2), [1, 1], 'second child of the top, second child of that');
  assert.deepEqual(childPath(top, top), [], 'the top itself is the empty path');
  // the same path applied to a separately built "source" tree finds the same seat
  const srcLi = el('li');
  const source = el('div', [el('h3'), el('ul', [el('li'), srcLi, el('li')])]);
  assert.equal(nodeAtPath(source, [1, 1]), srcLi);
  assert.equal(nodeAtPath(source, [1, 7]), null, 'a path the source cannot follow is a refusal, not a guess');
});

test('a node that is not under the top has no path', () => {
  const top = el('div', [el('p')]);
  const stray = el('p');
  assert.equal(childPath(top, stray), null);
});

test('a double-click edits headings, paragraphs and list items, but not generated or structured content', () => {
  const section = el('section');
  const put = (node) => { section.children.push(node); node.parentElement = section; return node; };
  const h2 = put(el('h2'));
  assert.equal(editableTarget(h2, section), h2);
  const li = el('li');
  put(el('ul', [li]));
  assert.equal(editableTarget(li, section), li, 'a bullet is text');
  const codeLine = el('span');
  put(el('pre', [el('code', [codeLine])]));
  assert.equal(editableTarget(codeLine, section), null, 'code is highlighted by the runtime, not spelled out in the source');
  const svgText = el('p');
  put(el('svg', [svgText]));
  assert.equal(editableTarget(svgText, section), null, 'diagrams are not edited a word at a time');
  const chartCell = el('td');
  put(el('table', [el('tr', [chartCell])], { 'data-chart': '' }));
  assert.equal(editableTarget(chartCell, section), null, 'a chart’s table is data the runtime replaces');
  const note = el('p');
  put(el('aside', [note], { class: 'notes' }));
  assert.equal(editableTarget(note, section), null, 'notes have their own editor');
  const other = el('section', [el('p')]);
  assert.equal(editableTarget(other.children[0], section), null, 'an element of another slide is not this slide’s');
  assert.ok(EDITABLE.includes('h1') && NOT_EDITABLE.includes('aside'), 'the selectors say what the tests assumed');
});

test('a dropped file’s alt text is its name, made readable', () => {
  assert.equal(altFromName('team-photo_2026.png'), 'team photo 2026');
  assert.equal(altFromName('Q3.Revenue.svg'), 'Q3.Revenue', 'only the extension comes off');
  assert.equal(altFromName(''), '');
});

test('only image files are uploaded; a stray PDF in the same drop is left alone', () => {
  const files = [{ type: 'image/png', name: 'a.png' }, { type: 'application/pdf', name: 'b.pdf' },
    { type: 'image/svg+xml', name: 'c.svg' }, { type: 'image/tiff', name: 'd.tif' }];
  assert.deepEqual(imageFiles(files).map((f) => f.name), ['a.png', 'c.svg'],
    'the server accepts exactly these types; asking it about the others would only earn a 415');
  assert.deepEqual(imageFiles(null), []);
});
