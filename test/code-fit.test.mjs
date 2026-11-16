// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// data-fit's search (SPEC CODE_AND_MATH, #958): the largest scale that fits,
// capped at the block's own size. The measuring half needs a browser and lives
// in test/fit-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { largestFitting, fitScale, FIT_MIN, FILL_MAX } from '../src/code/fit.js';

test('code that fits at its own size stays there, in one measurement', () => {
  const tried = [];
  assert.equal(largestFitting((s) => { tried.push(s); return true; }), 1);
  assert.deepEqual(tried, [1]);
});

test('a fit never grows past the block\'s own size', () => {
  // room for twice the code is still the code at its own size
  assert.equal(largestFitting((s) => s <= 2), 1);
});

test('too big: the largest scale that fits, within a hair', () => {
  const s = largestFitting((x) => x <= 0.65);
  assert.ok(s <= 0.65, `${s} overflows`);
  assert.ok(0.65 - s < 0.005, `${s} leaves room on the table`);
});

test('nothing fits: the floor, for the guardrail to flag', () => {
  assert.equal(largestFitting(() => false), FIT_MIN);
});

test('the floor is a fit when that is exactly what fits', () => {
  assert.ok(largestFitting((x) => x <= FIT_MIN + 0.001) >= FIT_MIN);
});

// data-fit="fill" (#1185): grows short code up to the cap, still shrinks long code

test('fill: short code grows to the cap when the room allows it', () => {
  assert.equal(fitScale(() => true, { fill: true }), FILL_MAX);
  assert.equal(fitScale(() => true, { fill: true, cap: 1.5 }), 1.5);
});

test('fill: short code grows until the room runs out, within a hair', () => {
  const s = fitScale((x) => x <= 1.42, { fill: true });
  assert.ok(s <= 1.42 && 1.42 - s < 0.01, `${s}`);
  assert.ok(s > 1);
});

test('fill: long code shrinks exactly as a plain fit does', () => {
  const room = (x) => x <= 0.65;
  assert.equal(fitScale(room, { fill: true }), fitScale(room));
  assert.ok(fitScale(room, { fill: true }) < 1);
});

test('fill: a cap below the code\'s own size never shrinks code that fits', () => {
  assert.equal(fitScale(() => true, { fill: true, cap: 0.8 }), 1);
});

test('a plain fit is unchanged: never past 1', () => {
  assert.equal(fitScale(() => true), 1);
  assert.equal(fitScale(() => false), FIT_MIN);
});
