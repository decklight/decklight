// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Resizing on the slide (PRESENTING_EDITING): a diagram and a framed web page
// sized by their width the way a picture is, a block's `max-width` written as
// one closed shape, and the one drag rule the corner and side handles share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setElementPicture, setElementStyles } from '../cli/edit.mjs';
import { dragWidth } from '../src/core/resize-handles.js';

const DECK = `<div class="decklight">
  <section>
    <h2>A</h2>
    <svg viewBox="0 0 200 100" width="400" height="200" style="width: 50%"><rect x="1" y="1" width="9" height="9"/></svg>
    <iframe src="https://example.invalid/" title="a page"></iframe>
    <p>Words</p>
  </section>
</div>`;

test('a diagram and a framed web page take a width the way a picture does, and nothing else of a picture\'s', () => {
  const svg = setElementPicture(DECK, 1, 1, { tag: 'svg', width: 320 });
  assert.match(svg, /<svg viewBox="0 0 200 100" width="320"><rect/, 'the width set in place, the height and an inline size gone, the viewBox kept');
  assert.match(setElementPicture(svg, 1, 1, { tag: 'svg', width: null }), /<svg viewBox="0 0 200 100"><rect/, 'null is its own size');
  assert.match(setElementPicture(DECK, 1, 2, { tag: 'iframe', width: 640 }), /<iframe src="https:\/\/example\.invalid\/" title="a page" width="640"><\/iframe>/);
  assert.throws(() => setElementPicture(DECK, 1, 1, { tag: 'svg', alt: 'x' }), /takes a width, nothing else/);
  assert.throws(() => setElementPicture(DECK, 1, 3, { tag: 'p', width: 300 }), /not a picture: <p>/);
});

test('a block\'s max-width is whole px from 40 to 4096, in its own style, and null takes it off', () => {
  const out = setElementStyles(DECK, 1, 3, [{ path: [], tag: 'p', prop: 'max-width', value: '480px' }]);
  assert.match(out, /<p style="max-width: 480px">Words<\/p>/);
  assert.match(setElementStyles(out, 1, 3, [{ path: [], tag: 'p', prop: 'max-width', value: null }]), /<p>Words<\/p>/);
  for (const ok of ['40px', '999px', '4096px']) assert.doesNotThrow(() => setElementStyles(DECK, 1, 3, [{ path: [], tag: 'p', prop: 'max-width', value: ok }]), ok);
  for (const bad of ['39px', '4097px', '50%', '30em', '480', '480.5px', 'none', '1px; color: red']) {
    assert.throws(() => setElementStyles(DECK, 1, 3, [{ path: [], tag: 'p', prop: 'max-width', value: bad }]), /not a block width/, bad);
  }
});

test('a drag means the axis that moved most, clamped; a side handle has only its own axis', () => {
  const base = { w0: 300, perX: 2, perY: 1, min: 16, max: 1000 };
  assert.equal(dragWidth({ ...base, dx: 40, dy: 0, east: true }), 320, 'east, 40px at 2px a unit');
  assert.equal(dragWidth({ ...base, dx: 40, dy: 0, east: false }), 280, 'the west handle moving east narrows');
  assert.equal(dragWidth({ ...base, dx: 0, dy: 50, east: true, south: true }), 350, 'down a south corner is wider by the height');
  assert.equal(dragWidth({ ...base, dx: 5000, dy: 0, east: true }), 1000, 'never past the most it may be');
  assert.equal(dragWidth({ ...base, dx: -5000, dy: 0, east: true }), 16);
  assert.equal(dragWidth({ w0: 300, perX: 2, perY: null, dx: 10, dy: 400, east: true, min: 40, max: 900 }), 305, 'a side has no vertical axis');
});
