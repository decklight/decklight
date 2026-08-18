// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The voice-over hint's one decision: whether to show at all.
//
// The pill itself is three lines of DOM — the interesting part is the list of
// places it must NOT appear, because each one is a way of being wrong rather
// than merely redundant. That list is a pure function, so it is checked here;
// that the real pill mounts, reads right, and starts the voice when clicked is
// checked against a live deck in test/narration-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hintApplies, pauseSeconds } from '../src/core/narration.js';

/** A deck that should show the hint — each case below spoils exactly one thing. */
const showing = { hasTracks: true };

test('a deck with a recorded track offers its voice', () => {
  assert.equal(hintApplies(showing), true);
});

test('a deck with no recorded track says nothing — there is nothing to press V for', () => {
  assert.equal(hintApplies({ ...showing, hasTracks: false }), false);
  assert.equal(hintApplies({}), false, 'and an empty context is not a deck with a voice');
});

test('the hint never appears where it would be wrong', () => {
  // print: the pill would be inked onto a page nobody can click
  assert.equal(hintApplies({ ...showing, printMode: true }), false, 'print');
  // embedded: the theme picker and slide finder boot real decks in iframes —
  // a hint in a 200px preview is chrome on top of chrome
  assert.equal(hintApplies({ ...showing, embedded: true }), false, 'embedded preview');
  // ?voiceover already starts the voice on the first gesture; telling the
  // viewer to press V is telling them to do what is about to happen anyway
  assert.equal(hintApplies({ ...showing, voiceover: true }), false, '?voiceover');
  // captions own the bottom-center corner, and a captions viewer has already
  // worked out that the deck talks
  assert.equal(hintApplies({ ...showing, captionsOn: true }), false, 'captions up');
  // and never over a voice that is already speaking
  assert.equal(hintApplies({ ...showing, narrating: true }), false, 'already narrating');
});

test('once the voice has been used on a deck, the hint is done there', () => {
  assert.equal(hintApplies({ ...showing, used: true }), false);
});

// --- data-narration-pause: the finite sibling of data-narration="hold" --------

test('a slide asks for a beat in seconds, decimals included', () => {
  assert.equal(pauseSeconds('2'), 2);
  assert.equal(pauseSeconds('0.5'), 0.5);
});

test('anything that is not a positive number reads as no beat, silently', () => {
  // A timing hint is not worth breaking a deck over: a typo leaves the slide
  // behaving exactly as it did before the attribute existed.
  for (const raw of [undefined, null, '', '0', '-1', 'abc', 'NaN', {}]) {
    assert.equal(pauseSeconds(raw), 0, `${JSON.stringify(raw)} is not a beat`);
  }
});
