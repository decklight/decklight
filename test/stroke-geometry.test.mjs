// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A stroke measured from its own attributes (src/core/stroke-geometry.js,
// BUILD_ENTRANCES draw): what answers when a browser refuses
// getTotalLength() / getPointAtLength() on a shape of a hidden slide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointAlong, shapeLength } from '../src/core/stroke-geometry.js';

/** A shape as the module reads it: a tag and its attributes, nothing resolved. */
const shape = (tagName, attrs) => ({ tagName, getAttribute: (k) => (k in attrs ? String(attrs[k]) : null) });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('a line, a polyline and a polygon are as long as their segments', () => {
  near(shapeLength(shape('line', { x1: 20, y1: 32, x2: 767, y2: 32 })), 747);
  near(shapeLength(shape('polyline', { points: '0,0 30,40 30,100' })), 110);
  near(shapeLength(shape('polygon', { points: '0 0 30 0 30 40' })), 120, 1e-9);
  near(shapeLength(shape('line', {})), 0);
});

test('a circle, an ellipse and a rect are as long as their outlines', () => {
  near(shapeLength(shape('circle', { r: 10 })), 20 * Math.PI);
  near(shapeLength(shape('ellipse', { rx: 10, ry: 10 })), 20 * Math.PI, 1e-9);
  near(shapeLength(shape('ellipse', { rx: 20, ry: 10 })), 96.8845, 1e-3);   // the exact perimeter, to 4 places
  near(shapeLength(shape('rect', { width: 200, height: 60 })), 520);
  // rounded: four quarter-circles of r 10 make one circle
  near(shapeLength(shape('rect', { width: 100, height: 50, rx: 10 })), 2 * 80 + 2 * 30 + 20 * Math.PI, 1e-9);
  near(shapeLength(shape('rect', { width: 0, height: 50 })), 0);
  near(shapeLength(shape('text', {})), 0);
});

test('the point along a line or polyline walks its segments, and stops at the end', () => {
  assert.deepEqual(pointAlong(shape('line', { x1: 0, y1: 0, x2: 100, y2: 0 }), 25), { x: 25, y: 0 });
  const bend = shape('polyline', { points: '0 0 30 40 30 100' });
  const p = pointAlong(bend, 50 + 10);
  near(p.x, 30); near(p.y, 50);
  assert.deepEqual(pointAlong(bend, 1e9), { x: 30, y: 100 });
  assert.deepEqual(pointAlong(bend, -5), { x: 0, y: 0 });
  const closed = pointAlong(shape('polygon', { points: '0 0 30 0 30 40' }), 110);
  near(closed.x, 30 - 30 * (40 / 50)); near(closed.y, 40 - 40 * (40 / 50));
  assert.equal(pointAlong(shape('rect', { width: 10, height: 10 }), 5), null, 'a rect carries no head: not a segment shape');
});
