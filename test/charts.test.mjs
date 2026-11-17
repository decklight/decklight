// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Charts — SPEC CHARTS. Pure-function tests: parsing/validation, tick math,
// bar/line/pie geometry, and the assembled SVG markup (chartSvg is a pure
// string transform, so the full render is assertable without a browser).
// DOM application (initCharts, build handoff) is covered by test/render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChart, niceTicks, barRects, linePath, areaPath, bandPath, splitAt, pieArcs, chartSvg,
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
    // "scatter" was the example here until the runtime learned to draw one
    [() => parseChart('{"labels":["a"],"series":[{"data":[1]}]}', { type: 'radar' }), /unknown type "radar"/],
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

test('parseChart: a scatter takes [x, y] pairs, and says so when it does not', () => {
  const spec = parseChart(JSON.stringify({
    type: 'scatter', x: 'Load (rps)', y: 'p99 (ms)',
    series: [{ name: 'v1', points: [[10, 120], [50, 180], ['x', 3], [90, 340]] }],
  }));
  assert.equal(spec.type, 'scatter');
  assert.deepEqual(spec.labels, [], 'a scatter has no categories — x is a measurement');
  assert.deepEqual(spec.series[0].points, [[10, 120], [50, 180], [90, 340]], 'an unusable pair is dropped, not drawn at 0');
  assert.deepEqual(spec.series[0].data, [120, 180, 340], 'the y values stay readable as `data`');
  assert.equal(spec.xTitle, 'Load (rps)');
  assert.equal(spec.yTitle, 'p99 (ms)');

  // and the refusals name the problem, like every other one
  assert.throws(() => parseChart(JSON.stringify({ type: 'scatter', series: [{ data: [1, 2] }] })),
    /"points" must be an array of \[x, y\] pairs/);
  assert.throws(() => parseChart(JSON.stringify({ type: 'scatter', series: [{ points: [['a', 'b']] }] })),
    /no usable \[x, y\] pairs/);
  // labels are required for everything else, and pointless here
  assert.throws(() => parseChart(JSON.stringify({ type: 'bar', series: [{ data: [1] }] })), /"labels" must be/);
});

test('chartSvg: scatter — a dot per pair, on two numeric axes', () => {
  const svg = chartSvg(parseChart(JSON.stringify({
    type: 'scatter', title: 'Latency against load', x: 'Load', y: 'ms',
    series: [
      { name: 'v1', points: [[10, 120], [90, 340]] },
      { name: 'v2', points: [[10, 90], [50, 110], [90, 160]] },
    ],
  })));
  assert.equal((svg.match(/<circle/g) || []).length, 5, 'a dot per pair, across both series');
  assert.equal((svg.match(/class="chart-series"/g) || []).length, 2);
  // the x axis carries numbers, not category names — two ticks that are not 1, 2, 3…
  assert.match(svg, /class="chart-cat"[^>]*>0</);
  assert.match(svg, /class="chart-axis-title"[^>]*>Load</);
  assert.match(svg, /transform="rotate\(-90 /, 'the y title reads up the axis');
  // the same palette contract as every other chart: tokens, never literals
  assert.match(svg, /fill="var\(--d-fill-1\)"/);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(svg), 'no hardcoded colors');
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

// ---------- a gap is a gap (#1125) ------------------------------------------

test('parseChart: only a number (or a string a cell reads as one) is a value; the rest are gaps, never zeros (#1125)', () => {
  const line = parseChart(JSON.stringify({ type: 'line', labels: ['a', 'b', 'c'], series: [{ name: 's', data: [1, null, 3] }] }));
  assert.deepEqual(line.series[0].data, [1, null, 3]);
  const bar = parseChart(JSON.stringify({ type: 'bar', labels: ['a', 'b', 'c', 'd', 'e', 'f'], series: [{ data: ['', true, [], 'x', '2.5', {}] }] }));
  assert.deepEqual(bar.series[0].data, [null, null, null, null, 2.5, null]);
  assert.throws(() => parseChart(JSON.stringify({ type: 'bar', labels: ['a'], series: [{ data: [1] }], aspect: '4:0' })), /bad aspect "4:0" — use "w:h", e.g. "4:3"/);
  // a pie with a gap skips the slice, and still needs a positive value
  const pie = chartSvg(parseChart(JSON.stringify({ type: 'pie', labels: ['a', 'b', 'c'], series: [{ data: [2, null, 1] }] })));
  assert.equal((pie.match(/class="chart-slice/g) || []).length, 2);
  assert.ok(!/>b</.test(pie), 'the gap has no name label');
  assert.throws(() => parseChart(JSON.stringify({ type: 'pie', labels: ['a'], series: [{ data: [null] }] })), /at least one positive/);
});

test('chartSvg: a line and an area break at a gap, and the axis is set by the numbers there (#1125)', () => {
  const json = { labels: ['a', 'b', 'c', 'd'], series: [{ data: [10, null, 30, 40] }] };
  const line = chartSvg(parseChart(JSON.stringify(json), { type: 'line' }));
  const d = /<path class="chart-line" d="([^"]+)"/.exec(line)[1];
  assert.equal((d.match(/M/g) || []).length, 2, 'two pieces');
  assert.equal((line.match(/chart-dot/g) || []).length, 3, 'no point drawn at the gap');
  assert.ok(!/class="chart-tick"[^>]*>-/.test(line));
  assert.equal(areaPath([{ x: 0, y: 1 }, null, { x: 2, y: 3 }, { x: 3, y: 4 }], 9), 'M0 9L0 1L0 9ZM2 9L2 3L3 4L3 9Z', 'an area per run, never a bridge');
  const bars = chartSvg(parseChart(JSON.stringify(json), { type: 'bar' }));
  assert.equal((bars.match(/class="chart-bar/g) || []).length, 3, 'the slot stays empty');
});

// ---------- forecasts, ranges and rules (#1189) -----------------------------

const FORECAST = {
  type: 'line', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], now: 'Mar',
  threshold: { y: 90, label: 'capacity' },
  series: [{ name: 'load', data: [40, 50, 60, 70, 80], dashFrom: 'Mar',
    band: { low: [null, null, 60, 62, 64], high: [null, null, 60, 78, 96] },
    markers: [{ at: 4, label: 'peak' }] }],
};

test('parseChart: dashFrom, band, markers, threshold and now, each reference a label or a position', () => {
  const spec = parseChart(JSON.stringify(FORECAST));
  const s = spec.series[0];
  assert.equal(s.dashFrom, 2);
  assert.deepEqual(s.band.high, [null, null, 60, 78, 96]);
  assert.deepEqual(s.markers, [{ at: 4, label: 'peak' }]);
  assert.deepEqual(spec.threshold, { y: 90, label: 'capacity' });
  assert.deepEqual(spec.now, { at: 2, label: 'now' });
  assert.deepEqual(spec.notes, []);
  // a label wins over a position: the years say "now": 2025
  const years = parseChart(JSON.stringify({ type: 'line', labels: [2024, 2025, 2026], now: 2025, series: [{ data: [1, 2, 3], dashFrom: 1 }] }));
  assert.equal(years.now.at, 1);
  assert.equal(years.series[0].dashFrom, 1, 'no label "1": the position');
  assert.deepEqual(parseChart(JSON.stringify({ ...FORECAST, now: { at: 'Feb', label: 'today' } })).now, { at: 1, label: 'today' });
});

test('parseChart: a band series is only its range, and needs one', () => {
  const spec = parseChart(JSON.stringify({ type: 'area', labels: ['a', 'b'], series: [
    { name: 'normal', type: 'band', band: { low: [1, 2], high: [3, 4] } }, { name: 'spend', data: [2, 9] }] }));
  assert.equal(spec.series[0].kind, 'band');
  assert.deepEqual(spec.series[0].data, [null, null]);
  assert.throws(() => parseChart(JSON.stringify({ type: 'line', labels: ['a'], series: [{ type: 'band' }] })), /is a band: it needs "band"/);
  assert.throws(() => parseChart(JSON.stringify({ type: 'bar', labels: ['a'], series: [{ type: 'band', band: { low: [1], high: [2] } }] })), /a band needs a line or area chart/);
});

test('parseChart: what it refuses, and what it draws without and only notes', () => {
  const bad = (patch, re) => assert.throws(() => parseChart(JSON.stringify({ ...FORECAST, ...patch })), re);
  const one = (s) => ({ series: [{ ...FORECAST.series[0], ...s }] });
  bad(one({ band: { low: [1] } }), /"band" must be \{ "low": \[…\], "high": \[…\] \}/);
  bad(one({ type: 'area' }), /"type" is "band"/);
  bad(one({ markers: { at: 1 } }), /"markers" must be a list/);
  bad(one({ markers: [{ label: 'x' }] }), /marker 1 must be/);
  bad(one({ dashFrom: true }), /"dashFrom" is a label or a position/);
  bad({ threshold: { label: 'no y' } }, /"threshold" must be/);
  bad({ now: [1] }, /"now" is a label or a position/);
  const notes = (patch, type) => parseChart(JSON.stringify({ ...FORECAST, ...patch, ...(type ? { type } : {}) })).notes;
  assert.match(notes(one({ dashFrom: 'June' })).join(), /"dashFrom": "June" names no label/);
  assert.match(notes({ now: 9 }).join(), /"now": 9 names no label/);
  assert.match(notes(one({ band: { low: [1, 2], high: [3, 4, 5, 6, 7, 8] } })).join(), /"low" has 2 values for 5 labels — the rest is a gap.*"high" has 6 values for 5 labels — the extra values are not drawn/);
  assert.match(notes(one({ band: { low: [5, 5, 5, 5, 5], high: [6, 6, 4, 6, 6] } })).join(), /low is above its high at "Mar"/);
  assert.match(notes(one({ markers: [{ at: 'Jun' }, { at: 'Jan' }], data: [null, 1, 2, 3, 4] })).join('|'), /marker 1 is at "Jun", which names no label.*\|.*marker 2 is at "Jan", where the series has no value/);
  assert.match(notes({}, 'bar').join(), /a bar chart draws no band/);
  assert.match(notes({ type: 'pie', series: [{ data: [1, 2, 3, 4, 5] }] }).join(), /"threshold": a pie chart has no value axis.*"now": a pie chart has no category axis/);
});

test('chartSvg: a forecast is solid to now, dashed after, its band under it, its marker ringed, its rules in the chrome', () => {
  const svg = chartSvg(parseChart(JSON.stringify(FORECAST)));
  const series = svg.slice(svg.indexOf('<g class="chart-series"'));
  const chrome = svg.slice(0, svg.indexOf('<g class="chart-series"'));
  // two cores, the second dashed, sharing the point they meet at (Mar)
  const cores = [...series.matchAll(/<path class="chart-line( chart-dashed)?" d="([^"]+)"[^>]*\/>/g)];
  assert.equal(cores.length, 2);
  assert.ok(!cores[0][1] && cores[1][1], 'solid first, then dashed');
  assert.ok(!/stroke-dasharray/.test(cores[0][0]) && /stroke-dasharray="9 7"/.test(cores[1][0]));
  assert.equal(cores[0][2].split('L').at(-1), cores[1][2].slice(1).split('L')[0], 'they meet at Mar');
  assert.equal((series.match(/<g class="chart-casing">(?:<path [^>]*\/>){2}<\/g>/g) || []).length, 1, 'each part on its casing');
  assert.match(series, /<g class="chart-casing">[^]*?stroke-dasharray="9 7"[^]*?<\/g>/, 'the casing dashes with its core');
  // the band, under the line, in the series' fill slot, its edges a group down
  assert.ok(series.indexOf('chart-band') < series.indexOf('chart-casing'), 'the band is under the line');
  assert.match(series, /<path class="chart-band draw-fade" d="M[^"]+Z" fill="var\(--d-fill-1\)" fill-opacity="0\.45"\/>/);
  assert.match(series, /<g class="chart-band-edge">(<path [^>]*stroke="var\(--d-stroke\)"[^>]*\/>){2}<\/g>/);
  // the marker: larger, ringed, its words, all fading in with the series
  assert.match(series, /<circle class="chart-marker draw-fade"[^>]*r="6\.5"/);
  assert.match(series, /<g class="chart-marker-ring"><circle class="draw-fade"/);
  assert.match(series, /class="chart-marker-label draw-fade"[^>]*>peak</);
  // the rules stand for the whole build: in the chrome, not a series; their
  // words in a layer over the series, on a halo of the slide's ground
  assert.match(chrome, /<line class="chart-threshold"[^>]*stroke="var\(--d-stroke\)"/);
  assert.match(chrome, /<line class="chart-now"/);
  const over = svg.slice(svg.lastIndexOf('<g class="chart-over" data-build-stay>'));
  assert.ok(svg.lastIndexOf('chart-series') < svg.indexOf('chart-over'), 'over the series');
  assert.match(over, /class="chart-rule-label"[^>]*stroke="var\(--bg\)"[^>]*paint-order="stroke">capacity</);
  assert.match(over, /class="chart-rule-label"[^>]*>now</);
  // the axis reaches the band's top (96) and the threshold
  assert.match(chrome, /class="chart-tick"[^>]*>100</);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(svg), 'no hardcoded colors');
});

test('chartSvg: a band series draws only its area, and a marker beside it carries its words', () => {
  const svg = chartSvg(parseChart(JSON.stringify({ type: 'line', labels: ['a', 'b', 'c'], series: [
    { name: 'normal', type: 'band', band: { low: [1, 2, null], high: [3, 4, 5] } },
    { name: 'spend', data: [2, 3, 9], markers: [{ at: 'c', label: 'is_anomaly = true' }] }] })));
  const band = svg.slice(svg.indexOf('data-series="1"'), svg.indexOf('data-series="2"'));
  assert.match(band, /chart-band draw-fade/);
  assert.ok(!/chart-line|chart-dot|chart-casing/.test(band), 'only the area');
  assert.match(band, /fill-opacity="0\.6"/);
  assert.equal((band.match(/Z/g) || []).length, 1, 'the run before the gap only');
  assert.match(svg, /class="chart-legend"[^>]*>normal</);
  assert.match(svg, /class="chart-marker-label draw-fade"[^>]*>is_anomaly = true</);
});

test('bandPath and splitAt: runs between gaps, the dashed part sharing the point it starts at', () => {
  const p = (x, y) => ({ x, y });
  assert.equal(bandPath([p(0, 1), p(1, 1), null, p(3, 1)], [p(0, 5), p(1, 5), p(2, 5), p(3, 5)]), 'M0 1L1 1L1 5L0 5Z');
  const { solid, dashed } = splitAt([p(0, 0), p(1, 1), p(2, 2)], 1);
  assert.deepEqual(solid, [p(0, 0), p(1, 1)]);
  assert.deepEqual(dashed, [null, p(1, 1), p(2, 2)]);
  assert.deepEqual(splitAt([p(0, 0)], null).dashed, []);
});
