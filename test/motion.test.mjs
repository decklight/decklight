// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Motion — SPEC MOTION, SLIDE_TRANSITIONS, AUTO_ANIMATE, ELEMENT_ANIMATIONS.
//
// The largest area of the spec that had no test file of its own. Most of it is
// measurement and paint, which only a real engine can testify to (render.mjs,
// cross-engine.mjs) — but underneath sit four small decisions, and both bugs
// this feature has had were in them rather than in the animation:
//
//   a duration read out of CSS without its unit — `parseFloat('350ms') * 1000`
//   is 350 SECONDS. Auto-animate hit it and fixed it in place; slide
//   transitions kept it, so every section held its `entering`/`leaving`
//   classes for five minutes and fifty seconds instead of clearing at 410ms.
//
//   a FLIP transform derived from two rectangles, where a zero-sized
//   destination makes the scale Infinity and the element vanishes.
//
// Neither was reachable by a test until the decision was lifted out of the
// function that used it, which is the whole reason src/core/motion.js exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_PROPS, cssDurationMs, flipCss, flipTransform, transitionClasses, transitionName,
  transitionProps,
} from '../src/core/motion.js';

// ── durations: the unit is not optional to read ────────────────────────────

test('a duration is read with its unit, in both spellings', () => {
  assert.equal(cssDurationMs('350ms', 999), 350);
  assert.equal(cssDurationMs('0.35s', 999), 350);
  assert.equal(cssDurationMs('1s', 999), 1000);
  assert.equal(cssDurationMs('1ms', 999), 1, 'ms is checked before s, or every ms is read as seconds');
  assert.equal(cssDurationMs('500ms', 999), 500);
});

test('the shipped defaults come back as themselves', () => {
  // src/decklight.css declares both in ms. This is the assertion that would
  // have caught the transition bug on the day it was written: 350ms is 350ms.
  assert.equal(cssDurationMs('350ms', 350), 350, '--transition-duration');
  assert.equal(cssDurationMs('500ms', 500), 500, '--auto-animate-duration');
});

test('a bare number is milliseconds — what the old code meant by one', () => {
  // Not a guess: the previous implementation passed an unsuffixed value
  // straight through as ms, so any deck relying on it already means ms.
  assert.equal(cssDurationMs('400', 999), 400);
  assert.equal(cssDurationMs(' 400 ', 999), 400, 'whitespace is getComputedStyle being itself');
});

test('anything unreadable is the caller\'s fallback, never NaN and never zero', () => {
  // A transition of 0ms is a transition nobody sees; NaN in a setTimeout is
  // worse — it fires immediately and takes the classes off mid-animation.
  for (const bad of ['', '   ', 'inherit', 'initial', 'fast', null, undefined, '-200ms', '0s', '0']) {
    assert.equal(cssDurationMs(bad, 350), 350, JSON.stringify(bad));
  }
});

// ── the transition itself ──────────────────────────────────────────────────

test('a slide\'s own data-transition beats the deck\'s, and there is always one', () => {
  assert.equal(transitionName('slide', 'fade'), 'slide');
  assert.equal(transitionName(null, 'scale'), 'scale', 'the deck-wide setting when the slide says nothing');
  assert.equal(transitionName('', 'scale'), 'scale', 'an empty attribute is not a choice');
  assert.equal(transitionName(null, undefined), 'fade', 'and a deck that configured nothing still transitions');
});

test('"none" adds no classes at all, rather than classes and a timer to remove them', () => {
  assert.equal(transitionClasses('none', 'fwd'), null);
});

test('a transition names both sides, and the direction it is going', () => {
  const fwd = transitionClasses('slide', 'fwd');
  assert.deepEqual(fwd.entering, ['entering', 'tr-slide', 'dir-fwd']);
  assert.deepEqual(fwd.leaving, ['leaving', 'tr-slide', 'dir-fwd', 'active-out']);

  // Backwards is a different animation, not the same one reversed — dl-in-left
  // and dl-in-right are separate keyframes in decklight.css.
  const back = transitionClasses('slide', 'back');
  assert.ok(back.entering.includes('dir-back'));
  assert.ok(back.leaving.includes('dir-back'));
});

test('the leaving side carries active-out and the entering side does not', () => {
  // `active-out` is what keeps the outgoing slide laid out while it animates
  // away. On the incoming slide it would mean the opposite of what it says.
  const { entering, leaving } = transitionClasses('fade', 'fwd');
  assert.ok(leaving.includes('active-out'));
  assert.ok(!entering.includes('active-out'));
});

// ── auto-animate: the FLIP, and what it must not do ────────────────────────

test('the animated property list is derived, so a new property cannot be forgotten', () => {
  const props = transitionProps();
  assert.equal(props[0], 'transform', 'the move itself comes first');
  for (const p of VISUAL_PROPS) {
    const kebab = p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    assert.ok(props.includes(kebab), `${p} is not in the transition list as ${kebab}`);
  }
  assert.deepEqual(transitionProps(['fontSize', 'borderRadius']),
    ['transform', 'font-size', 'border-radius'], 'camelCase becomes the CSS spelling');
});

const rect = (left, top, width, height) => ({ rect: { left, top, width, height } });

test('the FLIP puts an element back where it came from', () => {
  const from = rect(100, 50, 200, 100);
  const to = rect(300, 250, 400, 200);
  assert.deepEqual(flipTransform(from, to, { x: 1, y: 1 }),
    { dx: -200, dy: -200, sx: 0.5, sy: 0.5 });
});

test('the offset is divided by the stage scale, or the move overshoots', () => {
  // A stage at 0.5 means every screen pixel is two element pixels. Skipping the
  // division moves an element twice as far as it should go, which on a resized
  // window is every element.
  const from = rect(100, 100, 10, 10);
  const to = rect(50, 50, 10, 10);
  assert.deepEqual(flipTransform(from, to, { x: 0.5, y: 0.5 }),
    { dx: 100, dy: 100, sx: 1, sy: 1 });
  // SVG children get their factor from the CTM, which is not square when the
  // viewBox is not — so x and y are applied separately and never averaged.
  assert.deepEqual(flipTransform(from, to, { x: 2, y: 4 }),
    { dx: 25, dy: 12.5, sx: 1, sy: 1 });
});

test('a zero-sized destination scales by 1 — a singular matrix is not a move', () => {
  // Infinity or NaN in a scale() makes the element disappear rather than
  // animate. A destination can be 0×0 for a beat: an image without dimensions,
  // a font still loading.
  const flip = flipTransform(rect(0, 0, 100, 40), rect(0, 0, 0, 0), { x: 1, y: 1 });
  assert.deepEqual(flip, { dx: 0, dy: 0, sx: 1, sy: 1 });
  assert.ok(Number.isFinite(flip.sx) && Number.isFinite(flip.sy));
});

test('a factor of zero does not divide by zero', () => {
  // getScreenCTM can report 0 on an element that is not rendered yet.
  const flip = flipTransform(rect(10, 10, 10, 10), rect(0, 0, 10, 10), { x: 0, y: 0 });
  assert.deepEqual(flip, { dx: 10, dy: 10, sx: 1, sy: 1 });
});

test('text that changes size re-typesets rather than being stretched', () => {
  // The difference between auto-animate and a bitmap zoom: a heading going from
  // 24px to 48px animates its font-size, so the glyphs stay glyphs. Scaling it
  // would blur the strokes and lie about the letter spacing.
  const from = rect(0, 0, 100, 24);
  const to = rect(0, 0, 200, 48);
  assert.deepEqual(flipTransform(from, to, { x: 1, y: 1 }, true),
    { dx: 0, dy: 0, sx: 1, sy: 1 });
  assert.deepEqual(flipTransform(from, to, { x: 1, y: 1 }, false),
    { dx: 0, dy: 0, sx: 0.5, sy: 0.5 }, 'anything else does scale');
});

test('an element that did not move gets no transform at all', () => {
  // Setting `transform: translate(0px, 0px) scale(1, 1)` creates a containing
  // block and a stacking context for nothing, which is how a `position: fixed`
  // child inside an auto-animated slide stops being fixed.
  assert.equal(flipCss({ dx: 0, dy: 0, sx: 1, sy: 1 }), '');
  assert.equal(flipCss({ dx: 0, dy: 0, sx: 1, sy: 0.5 }), 'translate(0px, 0px) scale(1, 0.5)');
  assert.equal(flipCss({ dx: -8, dy: 4, sx: 1, sy: 1 }), 'translate(-8px, 4px) scale(1, 1)');
});
