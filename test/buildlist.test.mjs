// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, firstWords, beatsLine } from '../src/core/buildlist.js';

test('firstWords: markup and spaces out, cut with … past the count', () => {
  assert.equal(firstWords('  Start <strong>from</strong>\n the   audience  '), 'Start from the audience');
  assert.equal(firstWords('one two three four five six seven'), 'one two three four five six…');
  assert.equal(firstWords('a&nbsp;b'), 'a b');
  assert.equal(firstWords(''), '');
});

test('buildRows: one row a click, in play order, each with its beat', () => {
  const steps = [
    { label: 'Start from the audience', effect: 'fade-up', owner: null },
    { label: 'One idea per slide', effect: 'fade-up', owner: null },
    { label: 'picture', effect: 'fade', owner: null },
    { label: 'lines 3-5', effect: 'lines', owner: 'code' },
  ];
  // the picture arrives with the second point; the code lines are their own click
  const r = buildRows({
    steps, groups: [[0], [1, 2], [3]], start: ['Title', 'intro line'],
    notes: 'Hello all. [click] The audience first. [click]\n\nOne idea. [click]',
  });
  assert.deepEqual(r.start, ['Title', 'intro line']);
  assert.equal(r.clicks, 3);
  assert.deepEqual(r.rows.map((x) => x.click), [1, 2, 3]);
  assert.deepEqual(r.rows[1].items.map((i) => i.label), ['One idea per slide', 'picture']);
  assert.equal(r.rows[0].beat, 'The audience first.');
  assert.equal(r.rows[1].beat, 'One idea.');
  assert.equal(r.rows[2].beat, null, 'the last [click] has nothing after it: no beat');
  assert.equal(r.beats, 3);
  assert.deepEqual(r.extra, []);
  assert.equal(beatsLine(r), 'notes: 3 beats · 3 clicks');
});

test('buildRows: beats past the last click are listed after it; notes with no [click] pair with none', () => {
  const steps = [{ label: 'a' }, { label: 'b' }];
  const more = buildRows({ steps, groups: [[0], [1]], notes: 'open [click] one [click] two [click] three [click] four' });
  assert.deepEqual(more.rows.map((x) => x.beat), ['one', 'two']);
  assert.deepEqual(more.extra, [{ beat: 3, text: 'three' }, { beat: 4, text: 'four' }]);
  const unsplit = buildRows({ steps, groups: [[0], [1]], notes: 'one long script' });
  assert.deepEqual(unsplit.rows.map((x) => x.beat), [null, null]);
  assert.equal(unsplit.beats, 0);
  assert.equal(beatsLine({ beats: 1, clicks: 1 }), 'notes: 1 beat · 1 click');
  const none = buildRows({});
  assert.deepEqual([none.rows, none.extra, none.clicks], [[], [], 0]);
});

import { moveClick, mergeClick, splitClick, orderGroups } from '../src/core/buildlist.js';

test('moveClick, mergeClick, splitClick: the clicks rearranged, nothing lost', () => {
  const g = [[0], [1], [2, 3], [4]];
  assert.deepEqual(moveClick(g, 3, 0), [[4], [0], [1], [2, 3]], 'the last first');
  assert.deepEqual(moveClick(g, 0, 4), [[1], [2, 3], [4], [0]], 'the first last');
  assert.deepEqual(moveClick(g, 1, 2), g, 'to where it is: no change');
  assert.deepEqual(mergeClick(g, 3, 1), [[0], [1, 4], [2, 3]], 'arrives with click 2');
  assert.deepEqual(splitClick(g, 2), [[0], [1], [2], [3], [4]], 'each on its own click, in place');
  assert.deepEqual(splitClick(g, 0), g);
  assert.notEqual(moveClick(g, 1, 2), g, 'a copy, never the same lists');
});

test('orderGroups: one entry a node, a node of several steps named where its first plays', () => {
  const a = { id: 'a' }; const code = { id: 'code' }; const b = { id: 'b' };
  const steps = [{ node: a }, { node: code, count: 3 }, { node: code, count: 3 }, { node: code, count: 3 }, { node: b }];
  assert.deepEqual(orderGroups([[4], [0, 1], [2], [3]], steps), [[{ node: b, count: 1 }], [{ node: a, count: 1 }, { node: code, count: 3 }]]);
  assert.deepEqual(orderGroups([[0], [1], [2], [3], [4]], steps).map((g) => g.map((n) => n.node.id)), [['a'], ['code'], ['b']]);
});

import { evenStops, stagesOf } from '../src/core/buildlist.js';

test('evenStops and stagesOf: a stroke in n even stages, and back', () => {
  assert.equal(evenStops(3), '0.333 0.667 1');
  assert.equal(evenStops(4), '0.25 0.5 0.75 1');
  assert.equal(evenStops(1), null);
  assert.equal(evenStops('2'), '0.5 1');
  assert.equal(stagesOf('0.333 0.667 1'), 3);
  assert.equal(stagesOf('347 542 767'), 3);
  assert.equal(stagesOf(null), 1);
});

import { placeUnordered } from '../src/core/buildlist.js';

test('placeUnordered: a point added after the order was written plays right after the point before it, every other step where it was', () => {
  // the order: c (2) first, then a (0), then b (1); d (3) added after b, e (4) added first of the list
  const groups = [[3], [4], [2], [0], [1]];
  const steps = [
    { ordered: true, after: null }, { ordered: true, after: 0 }, { ordered: true, after: 1 },
    { ordered: false, after: 1 }, { ordered: false, after: null, before: 0 },
  ];
  assert.deepEqual(placeUnordered(groups, steps), [[2], [4], [0], [1], [3]]);
  // two new points in a row: in the order they are written
  assert.deepEqual(placeUnordered([[0], [1], [2]], [{ ordered: true }, { ordered: false, after: 0 }, { ordered: false, after: 1 }]), [[0], [1], [2]]);
  // a tie the author made is kept
  assert.deepEqual(placeUnordered([[0, 1], [2]], [{ ordered: true }, { ordered: true }, { ordered: false, after: 1 }]), [[0, 1], [2]]);
  // nothing to place, or no order at all: null
  assert.equal(placeUnordered([[0], [1]], [{ ordered: true }, { ordered: true }]), null);
  assert.equal(placeUnordered([[0], [1]], [{ ordered: false }, { ordered: false }]), null);
});

import { stopsWith } from '../src/core/buildlist.js';

test('stopsWith: a stop placed on the stroke joins its stops, in order, the last 1', () => {
  assert.equal(stopsWith([], 300, 0.4), '0.4 1', 'a stroke with none: the stop and the whole');
  assert.equal(stopsWith([150, 300], 300, 0.25), '0.25 0.5 1', 'lengths read as fractions, the new one in its place');
  assert.equal(stopsWith([150, 300], 300, 0.51), null, 'within 2% of one there: nothing new');
  assert.equal(stopsWith([100], 300, 0.6667), '0.333 0.667 1', 'a list that stopped short still ends whole');
  assert.equal(stopsWith([], 300, 1), null);
  assert.equal(stopsWith([], 0, 0.5), null);
});
