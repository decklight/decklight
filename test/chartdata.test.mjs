// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Data tab's pure half (src/core/chartdata.js, SPEC CHARTS and
// PRESENTING_EDITING): a chart's JSON read as a grid and edited as TEXT, so
// the author's key order, spacing, number spelling and unknown keys survive
// every edit that does not touch them; and the chart found and rewritten in
// its element's source, its other attributes and its build kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonTree, chartGrid, cellNumber, setCell, setLabel, setSeriesName, addRow, removeRow, moveRow,
  addSeries, removeSeries, setType, setTitle, findChart, rewriteChart, jsonString,
  ASPECTS, aspectOf, setAspect, legendOf, setLegend,
  setPoint, addPoint, removePoint, addScatterSeries, setAxisTitle,
  setBandCell, addBand, removeBand, setMarker, setMarkerLabel,
  setDashFrom, setNow, setNowLabel, setThreshold, addBandSeries,
} from '../src/core/chartdata.js';
import { parseChart } from '../src/core/charts.js';

// the SPEC's own example, with a key the grid has never heard of, a number
// spelled the author's way, and the layout a person would type
const SRC = `
  { "labels": ["v1", "v2", "v3"],
    "series": [ { "name": "p50", "data": [120, 80.50, 45] },
                { "name": "p99", "data": [340, 260, 190], "concept": "agent" } ],
    "legend": true, "x-note": { "from": "grafana", "ids": [1, 2] } }
  `;
const BAR = { type: 'bar', title: null };
const values = (json, i) => JSON.parse(json).series[i].data;

test('parseJsonTree: the offsets of every value, and JSON.parse\'s refusals', () => {
  const t = parseJsonTree(SRC);
  assert.equal(t.kind, 'object');
  assert.deepEqual(t.members.map((m) => m.name), ['labels', 'series', 'legend', 'x-note']);
  const n = t.members[1].value.items[0].members[1].value.items[1];
  assert.equal(SRC.slice(n.start, n.end), '80.50');
  for (const bad of ['{', '{"a": 1,}', '[01]', '{"a" 1}', '"\u0001"', '{} x', "{'a': 1}"]) {
    assert.throws(() => parseJsonTree(bad), Error, bad);
  }
});

test('chartGrid: one row per label, a column per series, the cells as typed', () => {
  const g = chartGrid(SRC, BAR);
  assert.equal(g.ok, true);
  assert.equal(g.type, 'bar');
  assert.deepEqual(g.labels, ['v1', 'v2', 'v3']);
  assert.deepEqual(g.series.map((s) => s.name), ['p50', 'p99']);
  assert.deepEqual(g.series[0].cells, ['120', '80.50', '45']);
});

test('chartGrid: gaps, short series, unnamed series, numeric labels', () => {
  const g = chartGrid('{"labels":[2024,2025,2026],"series":[{"data":[1,null]}]}', { type: 'line' });
  assert.deepEqual(g.labels, ['2024', '2025', '2026']);
  assert.deepEqual(g.series[0].cells, ['1', '', '']);
  assert.equal(g.series[0].name, 'series 1');
  assert.equal(g.series[0].named, false);
});

test('chartGrid: the type is the attribute, else the JSON; a pie with "donut": true is a donut', () => {
  assert.equal(chartGrid('{"type":"area","labels":["a"],"series":[{"data":[1]}]}', { type: '' }).type, 'area');
  assert.equal(chartGrid('{"type":"area","labels":["a"],"series":[{"data":[1]}]}', { type: 'bar' }).typeFrom, 'attr');
  assert.equal(chartGrid('{"donut":true,"labels":["a"],"series":[{"data":[1]}]}', { type: 'pie' }).type, 'donut');
});

test('chartGrid: every shape a grid cannot show says so, never a broken grid', () => {
  const no = (json, attrs = BAR) => { const g = chartGrid(json, attrs); assert.equal(g.ok, false, json); assert.ok(g.reason, json); return g.reason; };
  assert.match(no('{"series":[{"points":[[1,"2"]]}]}', { type: 'scatter' }), /point 1 of series 1 is not two numbers/, 'a scatter is a grid of pairs, but only of numbers');
  assert.match(no('{"series":[{"data":[1]}]}', { type: 'scatter' }), /no "points" list/);
  assert.match(no('{ "labels": [', BAR), /does not parse/);
  assert.match(no('{"labels":["a"],"series":[{"data":[1]}]}', { type: 'radar' }), /not a kind/);
  assert.match(no('{"series":[{"data":[1]}]}'), /labels/);
  assert.match(no('{"labels":["a"]}'), /series/);
  assert.match(no('{"labels":["a"],"series":[{"values":[1]}]}'), /data/);
  assert.match(no('{"labels":["a"],"series":[{"data":[1, 2]}]}'), /more values/);
  assert.match(no('{"labels":["a"],"series":[{"data":[{"v":1}]}]}'), /not a number/);
  assert.match(no('[1, 2]'), /not an object/);
});

test('cellNumber: JSON numbers kept as typed, plain decimals respelled, anything else refused', () => {
  assert.deepEqual(['1.50', '-0', '1e3', '42'].map((t) => cellNumber(t).raw), ['1.50', '-0', '1e3', '42']);
  assert.deepEqual(['+3', '.5', '007', '3.', ' 12 '].map((t) => cellNumber(t).raw), ['3', '0.5', '7', '3', '12']);
  assert.equal(cellNumber('').raw, 'null');
  for (const bad of ['12a', '1,5', '0x10', 'Infinity', 'NaN', '1e999', '--1', '١٢']) assert.equal(cellNumber(bad).ok, false, bad);
});

test('setCell: only the one number changes; every other byte is the author\'s', () => {
  const out = setCell(SRC, 2, 1, '200');
  assert.equal(out, SRC.replace('190', '200'));
  assert.equal(setCell(SRC, 0, 0, '120.0'), SRC.replace('[120, 80.50', '[120.0, 80.50'));
  assert.equal(setCell(SRC, 1, 0, ''), SRC.replace('80.50', 'null'));
});

test('setCell: an invalid number is refused, and nothing is written', () => {
  assert.throws(() => setCell(SRC, 0, 0, '12a'), /not a number/);
  assert.throws(() => setCell(SRC, 9, 0, '1'), /no such cell/);
});

test('setCell: past the end of a short series, the gaps are filled in', () => {
  const out = setCell('{"labels":["a","b","c"],"series":[{"data":[1]}]}', 2, 0, '5');
  assert.equal(out, '{"labels":["a","b","c"],"series":[{"data":[1,null,5]}]}');
});

test('round trip: an edit and its reverse give back the exact text, unknown keys included', () => {
  let t = setCell(SRC, 1, 0, '99');
  t = setLabel(t, 0, 'release 1');
  t = setSeriesName(t, 1, 'tail');
  assert.notEqual(t, SRC);
  t = setCell(t, 1, 0, '80.50');
  t = setLabel(t, 0, 'v1');
  t = setSeriesName(t, 1, 'p99');
  assert.equal(t, SRC);
  // and what the chart draws parses
  assert.equal(parseChart(setCell(SRC, 0, 0, '7'), BAR).series[0].data[0], 7);
});

test('setLabel / setSeriesName: strings as JSON that cannot end the <script>', () => {
  const t = setLabel(SRC, 0, 'a "quoted" </script> <!-- x');
  assert.equal(JSON.parse(t).labels[0], 'a "quoted" </script> <!-- x');
  assert.doesNotMatch(t, /<\/script/i);
  assert.doesNotMatch(t, /<!--/);
  assert.equal(jsonString('é'), '"é"');
});

test('setSeriesName: a series with no name gets one, first, spaced like its neighbours', () => {
  assert.equal(setSeriesName('{"labels":["a"],"series":[{ "data": [1] }]}', 0, 'n'), '{"labels":["a"],"series":[{ "name": "n", "data": [1] }]}');
});

test('addRow: a label and a 0 in every series, at the end or below a row, in the array\'s own spacing', () => {
  const end = addRow(SRC);
  assert.deepEqual(JSON.parse(end).labels, ['v1', 'v2', 'v3', 'label 4']);
  assert.deepEqual(values(end, 0), [120, 80.5, 45, 0]);
  assert.match(end, /\[120, 80\.50, 45, 0\]/);
  assert.match(end, /"concept": "agent"/);
  const mid = addRow(SRC, 1, 'v1.5');
  assert.deepEqual(JSON.parse(mid).labels, ['v1', 'v1.5', 'v2', 'v3']);
  assert.deepEqual(values(mid, 1), [340, 0, 260, 190]);
});

test('addRow / addSeries: a multi-line chart stays multi-line', () => {
  const ml = '{\n  "labels": [\n    "a",\n    "b"\n  ],\n  "series": [\n    {\n      "name": "one",\n      "data": [1, 2]\n    }\n  ]\n}';
  const t = addSeries(addRow(ml));
  assert.equal(t, '{\n  "labels": [\n    "a",\n    "b",\n    "label 3"\n  ],\n  "series": [\n    {\n      "name": "one",\n      "data": [1, 2, 0]\n    },\n    {\n      "name": "series 2",\n      "data": [0, 0, 0]\n    }\n  ]\n}');
});

test('removeRow: the label and its value in every series; the last row stays', () => {
  const t = removeRow(SRC, 1);
  assert.deepEqual(JSON.parse(t).labels, ['v1', 'v3']);
  assert.match(t, /\[120, 45\]/);
  assert.deepEqual(values(removeRow(SRC, 2), 1), [340, 260]);
  assert.throws(() => removeRow('{"labels":["a"],"series":[{"data":[1]}]}', 0), /at least one row/);
});

test('moveRow: a row trades places, its spelling going with it', () => {
  const t = moveRow(SRC, 0, 1);
  assert.deepEqual(JSON.parse(t).labels, ['v2', 'v1', 'v3']);
  assert.match(t, /\[80\.50, 120, 45\]/);
  assert.equal(moveRow(t, 1, -1), SRC);
  assert.throws(() => moveRow(SRC, 0, -1), /no row/);
  // a short series: the value it has moves, a gap takes its place
  assert.equal(moveRow('{"labels":["a","b"],"series":[{"data":[1]}]}', 0, 1), '{"labels":["b","a"],"series":[{"data":[null,1]}]}');
});

test('addSeries / removeSeries: one line when the last series is on one; the last series stays', () => {
  const t = addSeries(SRC);
  const j = JSON.parse(t);
  assert.deepEqual(j.series.map((s) => s.name), ['p50', 'p99', 'series 3']);
  assert.deepEqual(j.series[2], { name: 'series 3', data: [0, 0, 0] });   // the concept is p99's own
  assert.match(t, /\{ "name": "series 3", "data": \[0, 0, 0\] \}/);
  assert.equal(removeSeries(t, 2), SRC);
  assert.throws(() => removeSeries('{"labels":["a"],"series":[{"data":[1]}]}', 0), /at least one series/);
});

test('setType: the attribute when the chart says it there, the JSON otherwise; donut flag taken off; a pie takes one series', () => {
  assert.deepEqual(setType(SRC, BAR, 'line'), { json: SRC, attr: 'line' });
  const inJson = '{ "type": "bar", "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.deepEqual(setType(inJson, { type: '' }, 'area'), { json: '{ "type": "area", "labels": ["a"], "series": [{ "data": [1] }] }', attr: null });
  const flagged = '{ "labels": ["a"], "donut": true, "series": [{ "data": [1] }] }';
  assert.deepEqual(setType(flagged, { type: 'pie' }, 'bar'), { json: '{ "labels": ["a"], "series": [{ "data": [1] }] }', attr: 'bar' });
  assert.throws(() => setType(SRC, BAR, 'pie'), /one series/);
  assert.throws(() => setType(SRC, BAR, 'scatter'), /cannot/);
});

test('setTitle: data-title when there is one (or none anywhere), the JSON\'s "title" when it says it; empty removes it', () => {
  assert.deepEqual(setTitle(SRC, BAR, 'Latency'), { json: SRC, attr: 'Latency' });
  assert.deepEqual(setTitle(SRC, { type: 'bar', title: 'Old' }, ''), { json: SRC, attr: null });
  const inJson = '{ "title": "Old", "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.deepEqual(setTitle(inJson, { type: 'bar' }, 'New'), { json: '{ "title": "New", "labels": ["a"], "series": [{ "data": [1] }] }', attr: undefined });
  assert.equal(setTitle(inJson, { type: 'bar' }, '').json, '{ "labels": ["a"], "series": [{ "data": [1] }] }');
});

const EL = `<div class="chart" data-chart="bar" data-title="Lat &amp; ency" data-build="draw" style="max-width:62%">
  <script type="application/json">${SRC}</script>
</div>`;

test('findChart: the chart, its attributes decoded, its JSON\'s place', () => {
  const c = findChart(EL, 0);
  assert.equal(c.type, 'bar');
  assert.equal(c.title, 'Lat & ency');
  assert.equal(EL.slice(c.json.start, c.json.end), SRC);
  assert.equal(findChart(EL, 1), null);
  assert.equal(findChart('<p>no chart</p>', 0), null);
});

test('findChart: charts nested in a block, counted in document order; a JSON-looking tag inside a script is no tag', () => {
  const two = `<div class="cols">
    <!-- <div data-chart="bar"> a comment is not a chart -->
    <div data-chart='pie' data-title=Tokens><script type="application/json">{"labels":["<b>"],"series":[{"data":[1]}]}</script></div>
    <div><p>between</p></div>
    <div data-chart="line"><p>no json here</p></div>
  </div>`;
  const a = findChart(two, 0);
  assert.equal(a.type, 'pie');
  assert.equal(a.title, 'Tokens');
  assert.equal(two.slice(a.json.start, a.json.end), '{"labels":["<b>"],"series":[{"data":[1]}]}');
  const b = findChart(two, 1);
  assert.equal(b.type, 'line');
  assert.equal(b.json, null);   // the next chart's script is not its own
});

test('rewriteChart: only the JSON and the attributes asked for change; data-build, style and the rest stay', () => {
  const json = setCell(SRC, 0, 0, '1');
  const out = rewriteChart(EL, 0, { json, attrs: { 'data-chart': 'line', 'data-title': 'New "t"' } });
  assert.equal(out, EL.replace('data-chart="bar"', 'data-chart="line"').replace('Lat &amp; ency', 'New &quot;t&quot;').replace('[120, 80.50', '[1, 80.50'));
  // nothing changed: the same bytes
  assert.equal(rewriteChart(EL, 0, { json: SRC, attrs: { 'data-chart': 'bar', 'data-title': 'Lat & ency' } }), EL);
  // a title removed, then one added beside data-chart
  const bare = rewriteChart(EL, 0, { attrs: { 'data-title': null } });
  assert.equal(bare, EL.replace(' data-title="Lat &amp; ency"', ''));
  assert.equal(rewriteChart(bare, 0, { attrs: { 'data-title': 'T' } }), EL.replace('Lat &amp; ency', 'T'));
  // single-quoted and bare values keep (or gain) their quoting
  assert.equal(rewriteChart(`<div data-chart='pie'><script type="application/json">{}</script></div>`, 0, { attrs: { 'data-chart': 'donut' } }),
    `<div data-chart='donut'><script type="application/json">{}</script></div>`);
  assert.equal(rewriteChart('<div data-chart=pie></div>', 0, { attrs: { 'data-chart': 'bar' } }), '<div data-chart="bar"></div>');
  assert.throws(() => rewriteChart(EL, 3, { json }), /not in the file/);
});

test('a chart’s shape is read where it is written, the attribute first, and named as the Data tab names it', () => {
  const j = '{ "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.deepEqual(aspectOf(j, {}), { aspect: '16:9', from: null, written: null });
  assert.deepEqual(aspectOf(j, { aspect: '4x3' }), { aspect: '4:3', from: 'attr', written: '4x3' });
  assert.deepEqual(aspectOf('{ "aspect": "2:2", "labels": [] }', {}), { aspect: '1:1', from: 'json', written: '2:2' });
  assert.deepEqual(aspectOf(j, { aspect: '5:2' }), { aspect: null, from: 'attr', written: '5:2' }, 'a shape of its own is said as written');
  assert.deepEqual(ASPECTS.map(([, n]) => n), ['wide', 'standard', 'square', 'tall']);
});

test('setAspect writes the shape where the chart says it, and wide takes it off', () => {
  const j = '{ "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.deepEqual(setAspect(j, {}, '1:1'), { json: j, attr: '1:1' }, 'said nowhere: the attribute');
  assert.deepEqual(setAspect(j, { aspect: '1:1' }, '16:9'), { json: j, attr: null }, 'wide is no attribute');
  assert.deepEqual(setAspect(j, {}, '16:9'), { json: j, attr: undefined }, 'already wide: nothing');
  const inJson = '{ "aspect": "4:3", "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.equal(setAspect(inJson, {}, '3:4').json, '{ "aspect": "3:4", "labels": ["a"], "series": [{ "data": [1] }] }');
  assert.equal(setAspect(inJson, {}, '16:9').json, '{ "labels": ["a"], "series": [{ "data": [1] }] }');
  assert.deepEqual(setAspect(inJson, { aspect: '1:1' }, '16:9'), { json: inJson, attr: '16:9' }, 'over a JSON shape, wide stays written');
  assert.throws(() => setAspect(j, {}, '2:1'), /wide, standard, square, tall/);
});

test('the legend is auto, on or off, written as the JSON’s "legend"', () => {
  const j = '{ "labels": ["a"], "series": [{ "data": [1] }] }';
  assert.equal(legendOf(j), 'auto');
  const off = setLegend(j, 'off');
  assert.equal(off, '{ "labels": ["a"], "series": [{ "data": [1] }], "legend": false }');
  assert.equal(legendOf(off), 'off');
  assert.equal(legendOf(setLegend(off, 'on')), 'on');
  assert.equal(setLegend(off, 'auto'), j);
  assert.throws(() => setLegend(j, 'maybe'), /auto, on or off/);
});

test('findChart reads data-aspect, and rewriteChart writes it beside data-chart', () => {
  const html = '<div class="chart" data-chart="bar"><script type="application/json">{}</script></div>';
  assert.equal(findChart(html).aspect, null);
  const out = rewriteChart(html, 0, { attrs: { 'data-aspect': '1:1' } });
  assert.equal(out, '<div class="chart" data-chart="bar" data-aspect="1:1"><script type="application/json">{}</script></div>');
  assert.equal(findChart(out).aspect, '1:1');
});

test('a scatter opens as x / y pairs per series, with its axis titles', () => {
  const j = '{ "x": "load", "series": [ { "name": "a", "points": [[1, 2.50], [3, 4]] }, { "points": [[5, 6]] } ] }';
  const g = chartGrid(j, { type: 'scatter' });
  assert.equal(g.ok, true);
  assert.equal(g.type, 'scatter');
  assert.equal(g.x, 'load');
  assert.equal(g.y, '');
  assert.deepEqual(g.series.map((s) => [s.name, s.named, s.points]), [['a', true, [['1', '2.50'], ['3', '4']]], ['series 2', false, [['5', '6']]]]);
});

test('a scatter’s pairs are edited as text: a number where it stood, a point added like its neighbour, one removed', () => {
  const j = '{ "series": [ { "name": "a", "points": [[1, 2], [3, 4]] } ] }';
  assert.equal(setPoint(j, 0, 1, 1, '40'), '{ "series": [ { "name": "a", "points": [[1, 2], [3, 40]] } ] }');
  assert.throws(() => setPoint(j, 0, 0, 0, ''), /needs both its x and its y/);
  assert.throws(() => setPoint(j, 0, 0, 0, '1a'), /not a number/);
  assert.equal(addPoint(j, 0, 0), '{ "series": [ { "name": "a", "points": [[1, 2], [1, 2], [3, 4]] } ] }');
  assert.equal(addPoint(j, 0), '{ "series": [ { "name": "a", "points": [[1, 2], [3, 4], [3, 4]] } ] }');
  assert.equal(removePoint(j, 0, 0), '{ "series": [ { "name": "a", "points": [[3, 4]] } ] }');
  assert.throws(() => removePoint(removePoint(j, 0, 0), 0, 0), /at least one point/);
  assert.equal(addScatterSeries(j), '{ "series": [ { "name": "a", "points": [[1, 2], [3, 4]] }, { "name": "series 2", "points": [[0, 0]] } ] }');
  assert.equal(setSeriesName(j, 0, 'b'), '{ "series": [ { "name": "b", "points": [[1, 2], [3, 4]] } ] }', 'naming a series needs no labels');
  assert.equal(setAxisTitle(j, 'y', 'ms'), '{ "series": [ { "name": "a", "points": [[1, 2], [3, 4]] } ], "y": "ms" }');
  assert.equal(setAxisTitle(setAxisTitle(j, 'y', 'ms'), 'y', ''), j);
});

// ---------- a series' band and markers (CHARTS, #1189) -----------------------

const FC = `{ "labels": ["Mon", "Tue", "Wed"],
  "now": "Tue",
  "series": [ { "name": "load", "data": [1, 2, 3], "dashFrom": 1, "markers": [{ "at": "Wed", "label": "spike" }] },
              { "name": "normal", "type": "band", "band": { "low": [0, 1, 2], "high": [2, 3, 4] } } ] }`;
const LINE = { type: 'line', title: null };

test('chartGrid: on a line chart a series shows its band as low / high and its markers as ticks', () => {
  const g = chartGrid(FC, LINE);
  assert.equal(g.ok, true);
  assert.deepEqual(g.series[0].marks, [null, null, 'spike']);
  assert.equal(g.series[0].band, null);
  assert.equal(g.series[1].kind, 'band');
  assert.deepEqual(g.series[1].band, { low: ['0', '1', '2'], high: ['2', '3', '4'] });
  assert.equal(g.series[1].marks, null, 'a band series has no point to mark');
  // a bar chart draws neither: the grid shows neither
  assert.equal(chartGrid('{"labels":["a"],"series":[{"data":[1],"markers":[{"at":"a"}]}]}', BAR).series[0].marks, null);
  const no = (json) => chartGrid(json, LINE).reason;
  assert.match(no(FC.replace('"low": [0, 1, 2]', '"low": 3')), /band that is not a "low" and a "high" list/);
  assert.match(no(FC.replace('"at": "Wed"', '"at": "Sun"')), /marker at no label/);
  assert.match(no(FC.replace('"high": [2, 3, 4]', '"high": [2, 3, 4, 5]')), /band of series 2 has more values/);
});

test('setBandCell / addBand / removeBand: the band edited as text, added as a copy of the values', () => {
  let j = addBand(FC, 0);
  assert.match(j, /"data": \[1, 2, 3\], "band": \{ "low": \[1, 2, 3\], "high": \[1, 2, 3\] \}, "dashFrom"/);
  j = setBandCell(j, 1, 0, 'high', '9');
  assert.deepEqual(JSON.parse(j).series[0].band.high, [1, 9, 3]);
  assert.equal(setBandCell(j, 0, 1, 'low', ''), j.replace('"low": [0, 1, 2]', '"low": [null, 1, 2]'));
  assert.throws(() => setBandCell(j, 0, 0, 'low', 'x'), /not a number/);
  assert.equal(removeBand(j, 0), FC);
  assert.throws(() => setType(FC, LINE, 'bar'), /a band series needs a line or area chart/);
  assert.equal(setType(FC, LINE, 'area').attr, 'area');
  assert.throws(() => removeBand(j, 1), /a band series is its band/);
  assert.equal(parseChart(j, LINE).series[0].band.high[1], 9);
});

test('setMarker / setMarkerLabel: a tick is a marker at the row, named by its label; its words beside it', () => {
  let j = setMarker(FC, 0, 0, true);
  assert.match(j, /\[\{ "at": "Wed", "label": "spike" \}, \{ "at": "Mon" \}\]/);
  assert.equal(setMarker(j, 0, 0, true), j, 'one marker a row');
  j = setMarkerLabel(j, 0, 0, 'start');
  assert.match(j, /\{ "at": "Mon", "label": "start" \}/);
  assert.equal(setMarkerLabel(j, 0, 0, ''), setMarker(FC, 0, 0, true), 'no words takes the words off');
  assert.equal(setMarker(setMarker(j, 0, 0, false), 2, 0, false), FC.replace(', "markers": [{ "at": "Wed", "label": "spike" }]', ''), 'the last one takes the key');
  assert.match(setMarkerLabel(FC, 1, 0, 'new'), /\{ "at": "Tue", "label": "new" \}/, 'words on an unticked row tick it');
  assert.deepEqual(chartGrid(j, LINE).series[0].marks, ['start', null, 'spike']);
});

test('row edits keep the band in step and every reference on the row it named', () => {
  const j = addBand(FC, 0);
  // a renamed label carries the references that name it by that label
  const renamed = setLabel(j, 1, 'Tuesday');
  assert.equal(JSON.parse(renamed).now, 'Tuesday');
  assert.equal(JSON.parse(setLabel(j, 2, 'Weds')).series[0].markers[0].at, 'Weds');
  // a move swaps the band's values too, and renumbers a position
  const moved = JSON.parse(moveRow(j, 0, 1));
  assert.deepEqual(moved.series[1].band.low, [1, 0, 2]);
  assert.equal(moved.series[0].dashFrom, 0, 'Tue, by its position, moved to 0');
  assert.equal(moved.now, 'Tue');
  // an added row is a gap in a band, never a pinch to 0
  const added = JSON.parse(addRow(j, 0));
  assert.deepEqual(added.series[1].band.high, [null, 2, 3, 4]);
  assert.deepEqual(added.series[0].band.low, [null, 1, 2, 3]);
  assert.equal(added.series[0].dashFrom, 2);
  // a removed row takes its marker, and a dashFrom or now there comes off
  const gone = JSON.parse(removeRow(j, 2));
  assert.equal(gone.series[0].markers, undefined);
  assert.deepEqual(gone.series[1].band.low, [0, 1]);
  const goneTue = JSON.parse(removeRow(j, 1));
  assert.equal(goneTue.now, undefined);
  assert.equal(goneTue.series[0].dashFrom, undefined);
  assert.equal(parseChart(removeRow(j, 1), LINE).notes.length, 0, 'nothing left naming no label');
});

test('a grid cell cleared is a gap the chart skips, and reopens empty (#1125)', () => {
  const cleared = setCell(SRC, 1, 0, '');
  assert.equal(parseChart(cleared, { type: 'line' }).series[0].data[1], null);
  assert.equal(chartGrid(cleared, BAR).series[0].cells[1], '');
  assert.match(cleared, /\[120, null, 45\]/);
});

// ---------- dashFrom, now, threshold and a band series from the grid (CHARTS, #1189) ----------

test('chartGrid: a line series shows where it turns dashed; a chart with axes its now and threshold', () => {
  const g = chartGrid(FC, LINE);
  assert.deepEqual(g.series[0].dash, { row: 1, written: '1' });
  assert.equal(g.series[1].dash, null, 'a band series has no line to dash');
  assert.deepEqual(g.now, { row: 1, written: 'Tue', words: '' });
  assert.equal(g.threshold, null);
  const t = chartGrid(FC.replace('"now": "Tue"', '"now": { "at": "Wed", "label": "today" }, "threshold": { "y": 0.80, "label": "alert" }'), LINE);
  assert.deepEqual(t.now, { row: 2, written: 'Wed', words: 'today' });
  assert.deepEqual(t.threshold, { y: '0.80', words: 'alert' });
  assert.equal(chartGrid(FC.replace('"now": "Tue"', '"now": "Sun"'), LINE).now.row, -1, 'a now naming no label is said as written');
  assert.equal(chartGrid('{"labels":["a"],"series":[{"data":[1]}],"now":"a"}', { type: 'pie' }).now, undefined, 'a pie has no axes');
  assert.equal(chartGrid('{"labels":["a"],"series":[{"data":[1]}],"now":"a"}', BAR).now.row, 0, 'a bar chart draws a now');
});

test('setDashFrom: a line turns dashed from a row, named by its label; solid takes the key off', () => {
  const plain = FC.replace(', "dashFrom": 1', '');
  const j = setDashFrom(plain, 0, 2);
  assert.match(j, /"data": \[1, 2, 3\], "dashFrom": "Wed", "markers"/);
  assert.equal(setDashFrom(j, 0, null), plain);
  assert.equal(setDashFrom(FC, 0, 1), FC, 'a position already naming the row stays as written');
  assert.match(setDashFrom(FC, 0, 0), /"dashFrom": "Mon"/);
  assert.throws(() => setDashFrom(FC, 1, 0), /a band series has no line to dash/);
  assert.equal(parseChart(j, LINE).series[0].dashFrom, 2);
  // after the band, when it has one
  assert.match(setDashFrom(addBand(plain, 0), 0, 1), /"high": \[1, 2, 3\] \}, "dashFrom": "Tue"/);
});

test('setNow / setNowLabel: the now rule at a row, its words turning it into { at, label } and back', () => {
  const none = FC.replace('\n  "now": "Tue",', '');
  const j = setNow(none, 2);
  assert.match(j, /"labels": \["Mon", "Tue", "Wed"\],\n  "now": "Wed",/, "after labels, on a line of its own as its neighbours are");
  assert.equal(setNow(j, null), none);
  assert.equal(setNow(FC, 1), FC);
  const worded = setNowLabel(FC, 'today');
  assert.match(worded, /"now": \{ "at": "Tue", "label": "today" \}/);
  assert.equal(setNowLabel(worded, ''), FC, 'no words: back to the label alone');
  assert.match(setNow(worded, 0), /"now": \{ "at": "Mon", "label": "today" \}/, 'moving it keeps its words');
  assert.deepEqual(parseChart(setNow(worded, 0), LINE).now, { at: 0, label: 'today' });
  assert.throws(() => setNowLabel(none, 'x'), /no now/);
  // the references follow a row edit, the object form too
  assert.equal(JSON.parse(setLabel(worded, 1, 'Tuesday')).now.at, 'Tuesday');
  assert.equal(JSON.parse(removeRow(worded, 1)).now, undefined);
});

test('setThreshold: a y and its words; empty y takes it off; its own keys stay', () => {
  const j = setThreshold(FC, '0.8', 'alert');
  assert.match(j, /"now": "Tue",\n  "threshold": \{ "y": 0.8, "label": "alert" \},\n  "series"/, 'after now, on its own line like its neighbours');
  assert.equal(setThreshold(j, '', 'alert'), FC);
  assert.match(setThreshold(j, '2', ''), /"threshold": \{ "y": 2 \}/);
  assert.match(setThreshold(setThreshold(j, '2', ''), '2', 'cap'), /"threshold": \{ "y": 2, "label": "cap" \}/);
  assert.throws(() => setThreshold(j, '2x', ''), /not a number/);
  const own = FC.replace('"now": "Tue",', '"now": "Tue", "threshold": { "label": "old", "y": 1, "x-note": 1 },');
  assert.match(setThreshold(own, '3', 'new'), /\{ "label": "new", "y": 3, "x-note": 1 \}/);
  assert.deepEqual(parseChart(j, LINE).threshold, { y: 0.8, label: 'alert' });
});

test('addBandSeries: a range at the end, a copy of the series it is made from, written as its neighbours', () => {
  const j = addBandSeries(FC, 0);
  assert.deepEqual(JSON.parse(j).series[2], { name: 'range', type: 'band', band: { low: [1, 2, 3], high: [1, 2, 3] } });
  assert.match(j, /\{ "name": "range", "type": "band", "band": \{ "low": \[1, 2, 3\], "high": \[1, 2, 3\] \} \}/);
  assert.equal(JSON.parse(addBandSeries(j, 0)).series[3].name, 'range 4', 'a second takes a name of its own');
  assert.deepEqual(JSON.parse(addBandSeries(FC, 1)).series[2].band, { low: [0, 1, 2], high: [2, 3, 4] }, 'from a band series: its band');
  assert.deepEqual(JSON.parse(addBandSeries(SRC, null)).series[2], { name: 'range', type: 'band', band: { low: [0, 0, 0], high: [0, 0, 0] } });
  assert.equal(chartGrid(j, LINE).series[2].kind, 'band');
  assert.equal(parseChart(j, LINE).series[2].kind, 'band');
  assert.equal(removeSeries(j, 2), FC);
  // multi-line series stay multi-line
  const ml = '{ "labels": ["a", "b"],\n  "series": [\n    {\n      "name": "x",\n      "data": [1, 2]\n    }\n  ] }';
  assert.match(addBandSeries(ml, 0), /\{\n      "name": "range",\n      "type": "band",\n      "band": \{ "low": \[1, 2\], "high": \[1, 2\] \}\n    \}/);
});
