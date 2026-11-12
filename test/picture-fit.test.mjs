// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Picture ▸ Fit, Position and Corners (PRESENTING_EDITING): a frame of one of
// four shapes that the picture fills, nine places it is shown from, three
// roundings, each a closed shape written in the picture's own style.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setElementStyles } from '../cli/edit.mjs';
import { placeOf } from '../src/core/pictures.js';

const DECK = '<div class="decklight"><section><h2>A</h2><img src="a.png" width="400" alt="x"></section></div>';
const write = (prop, value) => setElementStyles(DECK, 1, 1, [{ path: [], tag: 'img', prop, value }]);

test('a frame filled, where it shows the picture and its corners: one style, the attributes kept', () => {
  const out = setElementStyles(DECK, 1, 1, [
    { path: [], tag: 'img', prop: 'aspect-ratio', value: '16 / 9' },
    { path: [], tag: 'img', prop: 'object-fit', value: 'cover' },
    { path: [], tag: 'img', prop: 'object-position', value: 'top left' },
    { path: [], tag: 'img', prop: 'border-radius', value: '50%' },
  ]);
  assert.equal(out, DECK.replace('alt="x">', 'alt="x" style="aspect-ratio: 16 / 9; object-fit: cover; object-position: top left; border-radius: 50%">'));
  const whole = setElementStyles(out, 1, 1, ['aspect-ratio', 'object-fit', 'object-position', 'border-radius'].map((prop) => ({ path: [], tag: 'img', prop, value: null })));
  assert.equal(whole, DECK, 'the whole picture again: the style gone with its last declaration');
});

test('each is the one shape it takes', () => {
  for (const [prop, ok] of [['aspect-ratio', ['16 / 9', '4 / 3', '3 / 2', '1 / 1']], ['object-fit', ['cover', 'contain']],
    ['object-position', ['top left', 'top', 'top right', 'left', 'right', 'bottom left', 'bottom', 'bottom right', 'center']], ['border-radius', ['8px', '16px', '50%']]]) {
    for (const v of ok) assert.doesNotThrow(() => write(prop, v), `${prop}: ${v}`);
  }
  for (const [prop, v] of [['aspect-ratio', '2 / 1'], ['aspect-ratio', '16/9'], ['object-fit', 'fill'], ['object-position', 'middle'],
    ['object-position', '10% 20%'], ['border-radius', '3px'], ['border-radius', '50% 0']]) {
    assert.throws(() => write(prop, v), /not a picture fit this server writes/, `${prop}: ${v}`);
  }
});

test('a position read back the way a browser spells it is the menu\'s name for it', () => {
  assert.equal(placeOf('left top'), 'top left');
  assert.equal(placeOf('center top'), 'top');
  assert.equal(placeOf('right center'), 'right');
  assert.equal(placeOf('50% 50%'), '');
  assert.equal(placeOf(''), '');
  assert.equal(placeOf('right bottom'), 'bottom right');
});
