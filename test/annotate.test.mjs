// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The pure parts of the ink annotator (SPEC §8): pointer→design coordinate
// mapping (what keeps strokes glued to their slide through a resize) and the
// laser-trail pruning that drives the ~300 ms afterglow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDesignCoords, pruneTrail } from '../src/core/annotate.js';

test('toDesignCoords: the stage origin maps to 0,0', () => {
  assert.deepEqual(toDesignCoords(100, 50, { left: 100, top: 50 }, 0.75), { x: 0, y: 0 });
});

test('toDesignCoords: divides the stage-relative offset by the scale', () => {
  // stage at (100, 50), scale 0.5 — a pointer 320 screen px in is 640 design px in
  assert.deepEqual(toDesignCoords(420, 210, { left: 100, top: 50 }, 0.5), { x: 640, y: 320 });
});

test('toDesignCoords: one slide position, any window scale — same stored coords', () => {
  // the resize invariant: the design point (320, 180) at two different scales
  const at = (s) => toDesignCoords(100 + 320 * s, 50 + 180 * s, { left: 100, top: 50 }, s);
  assert.deepEqual(at(0.5), at(1.25));
  assert.deepEqual(at(0.5), { x: 320, y: 180 });
});

test('toDesignCoords: a missing or zero scale is treated as 1', () => {
  assert.deepEqual(toDesignCoords(30, 20, { left: 10, top: 10 }, undefined), { x: 20, y: 10 });
  assert.deepEqual(toDesignCoords(30, 20, { left: 10, top: 10 }, 0), { x: 20, y: 10 });
});

test('pruneTrail: drops points at or past the ttl, keeps younger ones', () => {
  const pts = [{ t: 0 }, { t: 150 }, { t: 290 }];
  assert.deepEqual(pruneTrail(pts, 300), [{ t: 150 }, { t: 290 }]);
});

test('pruneTrail: everything expires eventually', () => {
  assert.deepEqual(pruneTrail([{ t: 0 }, { t: 100 }], 1000), []);
});

test('pruneTrail: custom ttl', () => {
  assert.deepEqual(pruneTrail([{ t: 0 }, { t: 80 }], 100, 50), [{ t: 80 }]);
});

test('pruneTrail: empty in, empty out — and never mutates its input', () => {
  assert.deepEqual(pruneTrail([], 500), []);
  const pts = [{ t: 0 }, { t: 400 }];
  pruneTrail(pts, 500);
  assert.equal(pts.length, 2);
});
