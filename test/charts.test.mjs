// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Charts — SPEC §3.1. Pure-function tests: parsing/validation, tick math,
// bar/line/pie geometry, and the assembled SVG markup (chartSvg is a pure
// string transform, so the full render is assertable without a browser).
// DOM application (initCharts, build handoff) is covered by test/render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChart, niceTicks, barRects, linePath, areaPath, pieArcs, chartSvg,
} from '../src/core/charts.js';

const BAR_JSON = JSON.stringify({
  labels: ['W1', 'W2', 'W3'],
  series: [
    { name: 'humans', data: [4, 7, 6] },
    { name: 'agents', data: [2, 3, 5], concept: 'agent' },
  ],
});

// ---------- parseChart -----------------------------------------------------

test('parseChart: normalizes a bar declaration, attrs win over JSON', () => {
  const spec = parseChart(BAR_JSON, { type: 'bar', title: 'Deploys' });
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title, 'Deploys');
  assert.deepEqual(spec.labels, ['W1', 'W2', 'W3']);
  assert.equal(spec.series.length, 2);
  assert.equal(spec.series[1].concept, 'agent');
  assert.equal(spec.width, 640);
  assert.equal(spec.height, 360);
});

test('parseChart: fence form carries type/title/aspect in the JSON', () => {
  const spec = parseChart(JSON.stringify({
    type: 'donut', title: 'Share', aspect: '4:3',
    labels: ['a', 'b'], series: [{ data: [3, 1] }],
  }));
  assert.equal(spec.type, 'pie');
  assert.equal(spec.donut, true);
  assert.equal(spec.title, 'Share');
  assert.equal(spec.height, 480); // 640 × 3/4
  assert.equal(spec.series[0].name, 'series 1'); // default name
});

test('parseChart: data is padded/trimmed to the label count, gaps kept', () => {
  const spec = parseChart(JSON.stringify({
    labels: ['a', 'b', 'c'],
    series: [{ data: [1, 'x'] }],
  }), { type: 'line' });
  assert.deepEqual(spec.series[0].data, [1, null, null]);
});

test('parseChart: every rejection names the problem', () => {
  const cases = [
    [() => parseChart('{ nope }', { type: 'bar' }), /invalid JSON/],
    [() => parseChart(null, { type: 'bar' }), /no data/],
    [() => parseChart('{"labels":["a"],"series":[{"data":[1]}]}', { type: 'scatter' }), /unknown type "scatter"/],
    [() => parseChart('{"series":[{"data":[1]}]}', { type: 'bar' }), /"labels"/],
    [() => parseChart('{"labels":["a"],"series":[]}', { type: 'bar' }), /"series"/],
    [() => parseChart('{"labels":["a"],"series":[{"data":5}]}', { type: 'bar' }), /series 1/],
    [() => parseChart('{"labels":["a"],"series":[{"data":[1]},{"data":[2]}]}', { type: 'pie' }), /exactly one series/],
    [() => parseChart('{"labels":["a"],"series":[{"data":[0]}]}', { type: 'pie' }), /positive value/],
    [() => parseChart(BAR_JSON, { type: 'bar', aspect: 'wide' }), /bad aspect/],
  ];
  for (const [fn, re] of cases) assert.throws(fn, re);
});

// ---------- niceTicks ------------------------------------------------------

test('niceTicks: nice bounds and steps', () => {
  assert.deepEqual(niceTicks(0, 97).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 1).ticks, [0, 0.25, 0.5, 0.75, 1]);
  const neg = niceTicks(-30, 80);
  assert.ok(neg.min <= -30 && neg.max >= 80);
  assert.ok(neg.ticks.includes(0), 'zero is on the tick grid');
});

test('niceTicks: degenerate ranges still produce a usable scale', () => {
  const flat = niceTicks(5, 5);
  assert.ok(flat.max > flat.min && flat.ticks.length >= 2);
  const zero = niceTicks(0, 0);
  assert.ok(zero.max > 0);
  const inverted = niceTicks(10, 0);
  assert.equal(inverted.min, 0);
  assert.ok(inverted.max >= 10);
  assert.throws(() => niceTicks(0, NaN), /non-finite/);
});

// ---------- barRects -------------------------------------------------------

test('barRects: grouped layout, bars rise from the zero baseline', () => {
  const plot = { x: 0, y: 0, w: 300, h: 100 };
  const r = barRects(
    [{ data: [50, 100, null] }, { data: [25, 0, 75] }],
    3, plot, { min: 0, max: 100 });
  // band 100, group 72, bar width 36 (34 after the 2px gap)
  assert.equal(r[0][0].x, 15); // (100-72)/2 + 1
  assert.equal(r[1][0].x, 51); // second series shifted one bar width
  assert.equal(r[0][0].w, 34);
  assert.equal(r[0][0].y, 50);
  assert.equal(r[0][0].h, 50); // value 50 of 100 = half the plot height
  assert.equal(r[0][2], null); // gap stays a gap
  assert.equal(r[1][1].h, 0);  // zero value: zero-height bar at the baseline
  // second category sits one band to the right
  assert.equal(r[0][1].x, 115);
});

test('barRects: negative values hang below the zero line', () => {
  const plot = { x: 0, y: 0, w: 100, h: 100 };
  const r = barRects([{ data: [-25] }], 1, plot, { min: -50, max: 50 });
  assert.equal(r[0][0].y, 50);  // top of the bar is the zero line
  assert.equal(r[0][0].h, 25);  // extends downward
});

// ---------- linePath / areaPath -------------------------------------------

test('linePath: pen lifts over gaps', () => {
  const d = linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 30, y: 8 }]);
  assert.equal(d, 'M0 0L10 5M30 8');
  assert.equal(linePath([null, null]), '');
});

test('areaPath: closes onto the baseline', () => {
  const d = areaPath([{ x: 10, y: 20 }, { x: 30, y: 5 }], 100);
  assert.equal(d, 'M10 100L10 20L30 5L30 100Z');
  assert.equal(areaPath([], 100), '');
});

// ---------- pieArcs --------------------------------------------------------

test('pieArcs: fractions sum to 1, slices start at 12 o\'clock', () => {
  const arcs = pieArcs([1, 1, 3], 100, 100, 50);
  assert.equal(arcs.length, 3);
  assert.ok(Math.abs(arcs.reduce((a, s) => a + s.frac, 0) - 1) < 1e-9);
  // first slice starts straight up: its path begins at the center then the top
  assert.match(arcs[0].d, /^M100 100L100 50A/);
  // >50% slice needs the large-arc flag
  assert.match(arcs[2].d, /A50 50 0 1 1/);
});

test('pieArcs: donut, full-circle, and zero-value slices', () => {
  const donut = pieArcs([3, 1], 0, 0, 50, 25)[0];
  assert.equal((donut.d.match(/A/g) || []).length, 2); // outer + inner arc
  const full = pieArcs([5], 0, 0, 50)[0];
  assert.equal(full.frac, 1);
  assert.equal((full.d.match(/A/g) || []).length, 2); // two half-circle arcs
  const withZero = pieArcs([2, 0, 2], 0, 0, 50);
  assert.equal(withZero[1].d, ''); // index kept, path empty
  assert.throws(() => pieArcs([0, 0], 0, 0, 50), /positive/);
});

// ---------- chartSvg -------------------------------------------------------

const count = (s, re) => (s.match(re) || []).length;

test('chartSvg: bar — one <g> per series, colors are diagram tokens only', () => {
  const svg = chartSvg(parseChart(BAR_JSON, { type: 'bar', title: 'Deploys' }));
  assert.equal(count(svg, /<g class="chart-series"/g), 2);
  assert.ok(svg.includes('var(--d-fill-1)'), 'series 1 → --d-fill-1');
  assert.ok(svg.includes('var(--d-fill-2)'), 'series 2 → --d-fill-2');
  assert.ok(svg.includes('stroke="var(--d-stroke)"'), 'axes → --d-stroke');
  assert.ok(svg.includes('stroke="var(--d-muted)"'), 'grid → --d-muted');
  assert.ok(svg.includes('fill="var(--d-text)"'), 'labels → --d-text');
  assert.ok(!/#[0-9a-f]{3,6}/i.test(svg), 'no hardcoded colors anywhere');
  assert.ok(svg.includes('data-concept="agent"'), 'concept lands on the series <g>');
  assert.ok(svg.includes('data-build-stay'), 'chrome group is exempt from builds');
  assert.ok(svg.includes('viewBox="0 0 640 360"'));
  assert.ok(svg.includes('aria-label="Deploys — bar chart"'));
  assert.ok(svg.includes('class="chart-legend"'), 'multi-series bar gets a legend');
});

test('chartSvg: line/area — cased strokes for the draw machinery, fades for the rest', () => {
  const line = chartSvg(parseChart(BAR_JSON, { type: 'line' }));
  assert.equal(count(line, /<path class="chart-line" [^>]*fill="none" stroke="var\(--d-fill-\d\)"/g), 2);
  // every line rides on a --d-stroke casing (panel fills are near-canvas in
  // most themes), nested one level down so concept pinning never repaints it
  assert.equal(count(line, /<g class="chart-casing"><path [^>]*stroke="var\(--d-stroke\)"/g), 2);
  assert.equal(count(line, /chart-dot draw-fade/g), 6, 'dots fade in around the draw');
  const area = chartSvg(parseChart(BAR_JSON, { type: 'area' }));
  assert.equal(count(area, /chart-area draw-fade/g), 2);
  assert.ok(area.includes('fill-opacity="0.35"'));
});

test('chartSvg: bars and slices carry the diagram box ink', () => {
  const bar = chartSvg(parseChart(BAR_JSON, { type: 'bar' }));
  assert.equal(count(bar, /<rect class="chart-bar draw-fade" [^>]*stroke="var\(--d-stroke\)"/g), 6);
  const pie = chartSvg(parseChart(JSON.stringify({
    labels: ['a', 'b'], series: [{ data: [3, 1] }],
  }), { type: 'pie' }));
  assert.equal(count(pie, /<path class="chart-slice draw-fade" [^>]*stroke="var\(--d-stroke\)"/g), 2);
});

test('chartSvg: pie — slices cycle the fill slots, value labels on slices', () => {
  const svg = chartSvg(parseChart(JSON.stringify({
    labels: ['alpha', 'beta', 'gamma'],
    series: [{ data: [5, 3, 2] }],
  }), { type: 'pie' }));
  assert.equal(count(svg, /<g class="chart-series"/g), 1);
  assert.equal(count(svg, /chart-slice/g), 3);
  assert.ok(svg.includes('var(--d-fill-3)'), 'third slice → third fill slot');
  assert.ok(svg.includes('>50%<'), 'value labels are percentages');
  assert.ok(svg.includes('>alpha<'), 'name labels outside the slices');
  assert.ok(!svg.includes('chart-legend'), 'pie labels itself — no legend');
});

test('chartSvg: user strings are escaped', () => {
  const svg = chartSvg(parseChart(JSON.stringify({
    labels: ['<b>&'], series: [{ data: [1], name: '"quoted"' }],
  }), { type: 'bar', title: '<script>' }));
  assert.ok(!svg.includes('<b>'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;b&gt;&amp;'));
  assert.ok(svg.includes('&quot;quoted&quot;'));
});
