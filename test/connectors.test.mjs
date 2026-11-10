// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Connectors, wires that stay attached (SPEC SVG_DIAGRAMS): the routing the
// runtime does at load (src/core/connectors.js, pure but for getBBox, so read
// here over a few plain objects standing in for elements), the server's
// connector writes and their closed shapes (cli/edit.mjs), and the finding
// `decklight check` gives a wire that names no node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseTransform, multiply, invert, applyTo, boxThrough, edgeToward, routeStraight, routeElbow, routeCurve,
  geometryFor, endsOf, tagForRoute, wireGeometry, routeConnectors, connectorsOf, nodeNamed, nodeBox, IDENTITY,
} from '../src/core/connectors.js';
import {
  editConnector, setElementGeometry, removeNestedElement, duplicateDiagramNode, pathDataValue, pointsValue, slugNode, createHistory,
} from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { staticFindings } from '../cli/check.mjs';
import { tmp } from './helpers.mjs';

// ── a few elements, as connectors.js reads them ─────────────────────────────

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = tag; this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.text = null;
    for (const k of kids) { if (typeof k === 'string') this.text = k; else { k.parentElement = this; this.children.push(k); } }
  }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  hasAttribute(n) { return n in this.attrs; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  get textContent() { return this.text ?? this.children.map((c) => c.textContent).join(''); }
}
const h = (tag, attrs, ...kids) => new El(tag, attrs, kids);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≈ ${b}`);

// ── matrices and boxes ──────────────────────────────────────────────────────

test('a transform attribute is one matrix: translate, scale, rotate about a point, in the order written', () => {
  const m = parseTransform('translate(10, 20) scale(2)');
  assert.deepEqual(applyTo(m, { x: 1, y: 1 }), { x: 12, y: 22 });
  const r = parseTransform('rotate(90 50 50)');
  const p = applyTo(r, { x: 100, y: 50 });
  near(p.x, 50); near(p.y, 100);
  const back = applyTo(multiply(invert(m), m), { x: 7, y: -3 });
  near(back.x, 7); near(back.y, -3);
  assert.deepEqual(parseTransform(''), IDENTITY);
  assert.deepEqual(parseTransform('translate(nope)'), IDENTITY, 'what it cannot read it leaves out');
});

test('a box through a matrix: the box around its corners, round only while nothing turns it', () => {
  assert.deepEqual(boxThrough(parseTransform('translate(5 5) scale(2)'), { x: 0, y: 0, w: 10, h: 4, round: true }), { x: 5, y: 5, w: 20, h: 8, round: true });
  const turned = boxThrough(parseTransform('rotate(90)'), { x: 0, y: 0, w: 10, h: 4, round: true });
  near(turned.w, 4); near(turned.h, 10);
  assert.equal(turned.round, false);
});

// ── edges and routes ────────────────────────────────────────────────────────

test('straight: a box is left at its edge, an ellipse at its boundary, along the line between the centres', () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(edgeToward(box, { x: 200, y: 25 }), { x: 100, y: 25 });
  assert.deepEqual(edgeToward(box, { x: 150, y: 75 }), { x: 100, y: 50 }, 'on the diagonal it is the corner');
  const oval = { x: -50, y: -25, w: 100, h: 50, round: true };
  const p = edgeToward(oval, { x: 100, y: 100 });
  near((p.x / 50) ** 2 + (p.y / 25) ** 2, 1, 'on the ellipse');
  near(p.x, p.y, 'along the 45° line');
  assert.deepEqual(edgeToward({ x: 3, y: 4, w: 0, h: 0 }, { x: 99, y: 99 }), { x: 3, y: 4 }, 'a free end is its own point');
  const [a, b] = routeStraight(box, { x: 300, y: 0, w: 100, h: 50 });
  assert.deepEqual([a, b], [{ x: 100, y: 25 }, { x: 300, y: 25 }]);
});

test('elbow: three segments between boxes apart on one axis, two between boxes apart on both, straight when they overlap', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(routeElbow(a, { x: 200, y: 100, w: 100, h: 50 }), [{ x: 100, y: 25 }, { x: 250, y: 25 }, { x: 250, y: 100 }], 'apart on both: out of the side, square into the top');
  assert.deepEqual(routeElbow(a, { x: 200, y: 30, w: 100, h: 50 }), [{ x: 100, y: 25 }, { x: 150, y: 25 }, { x: 150, y: 55 }, { x: 200, y: 55 }], 'side by side: out, across halfway, in');
  assert.deepEqual(routeElbow(a, { x: 30, y: 200, w: 100, h: 50 }), [{ x: 50, y: 50 }, { x: 50, y: 125 }, { x: 80, y: 125 }, { x: 80, y: 200 }], 'one above the other: down, across, down');
  assert.deepEqual(routeElbow(a, { x: 200, y: 0, w: 100, h: 50 }), [{ x: 100, y: 25 }, { x: 200, y: 25 }], 'lined up: the bends go');
  assert.deepEqual(routeElbow(a, { x: 50, y: 20, w: 100, h: 50 }), routeStraight(a, { x: 50, y: 20, w: 100, h: 50 }));
});

test('curve: one cubic between the sides an elbow would use, leaving and arriving square', () => {
  const c = routeCurve({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 100, w: 100, h: 50 });
  assert.deepEqual(c, { from: { x: 100, y: 25 }, c1: { x: 200, y: 25 }, c2: { x: 200, y: 125 }, to: { x: 300, y: 125 } });
  const down = routeCurve({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 300, w: 100, h: 50 });
  assert.deepEqual([down.from, down.to], [{ x: 50, y: 50 }, { x: 50, y: 300 }]);
  assert.equal(down.c1.x, 50, 'it leaves the bottom going down');
});

test('a route is written in the wire\'s own attributes: a line\'s ends, a polyline\'s points, a path\'s data', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 }; const b = { x: 200, y: 100, w: 100, h: 50 };
  assert.deepEqual(geometryFor('line', 'elbow', a, b), { x1: '100', y1: '50', x2: '200', y2: '100' }, 'a line can only be straight');
  assert.deepEqual(geometryFor('polyline', 'elbow', a, b), { points: '100,25 250,25 250,100' });
  assert.deepEqual(geometryFor('path', 'elbow', a, b), { d: 'M 100 25 L 250 25 L 250 100' });
  assert.equal(geometryFor('path', 'curve', a, b).d, 'M 100 25 C 150 25 150 125 200 125');
  assert.equal(tagForRoute('line', 'elbow'), 'path');
  assert.equal(tagForRoute('polyline', 'curve'), 'path');
  assert.equal(tagForRoute('polyline', 'elbow'), 'polyline');
});

test('a wire\'s ends are read from its geometry: relative path commands and H/V followed', () => {
  assert.deepEqual(endsOf('path', (a) => ({ d: 'm10 20 l5 5 h10 v-3' })[a]), { start: { x: 10, y: 20 }, end: { x: 25, y: 22 } });
  assert.deepEqual(endsOf('path', (a) => ({ d: 'M 1 2 C 3 4 5 6 7 8' })[a]), { start: { x: 1, y: 2 }, end: { x: 7, y: 8 } });
  assert.deepEqual(endsOf('polyline', (a) => ({ points: '1,2 3,4 5,6' })[a]), { start: { x: 1, y: 2 }, end: { x: 5, y: 6 } });
  assert.equal(endsOf('path', (a) => ({ d: 'M 1 2 Z 4' })[a]), null);
});

// ── over a diagram ──────────────────────────────────────────────────────────

/** A diagram: a box group, an ellipse inside a translated group, a scaled group holding the wires. */
function diagram() {
  const box = h('g', { 'data-node': 'api' }, h('rect', { x: 0, y: 0, width: 100, height: 50 }), h('text', { x: 50, y: 25, 'font-size': 40 }, 'A very long label that is wider than its box'));
  const oval = h('ellipse', { 'data-node': 'db', cx: 0, cy: 25, rx: 50, ry: 25 });
  const moved = h('g', { transform: 'translate(300 0)' }, oval);
  const wire = h('line', { 'data-from': 'api', 'data-to': 'db', x1: 0, y1: 0, x2: 1, y2: 1 });
  const elbow = h('path', { 'data-from': 'api', 'data-to': 'db', 'data-route': 'elbow', d: 'M 0 0 L 1 1' });
  const scaled = h('g', { transform: 'scale(2)' }, h('line', { 'data-from': 'api', 'data-to': 'db', x1: 0, y1: 0, x2: 0, y2: 0 }));
  const lost = h('line', { 'data-from': 'api', 'data-to': 'nowhere', x1: 1, y1: 2, x2: 3, y2: 4 });
  const half = h('line', { 'data-from': 'api', x1: 9, y1: 9, x2: 50, y2: 200 });
  const marker = h('defs', {}, h('marker', {}, h('rect', { 'data-node': 'db', x: 999, y: 999, width: 1, height: 1 })));
  const svg = h('svg', { viewBox: '0 0 800 300' }, marker, box, moved, wire, elbow, scaled, lost, half);
  return { svg, box, oval, wire, elbow, scaled: scaled.children[0], lost, half };
}

test('a group\'s box is its shapes\' union, its label left out; a node in a translated group is read through it', () => {
  const { svg, box, oval } = diagram();
  assert.deepEqual(nodeBox(box, IDENTITY, svg), { x: 0, y: 0, w: 100, h: 50, round: false }, 'the rect, not the long label');
  assert.deepEqual(nodeBox(oval, IDENTITY, svg), { x: 250, y: 0, w: 100, h: 50, round: true });
  assert.equal(nodeNamed(svg, 'db'), oval, 'a marker\'s content is never a node');
});

test('routing a diagram: each connector edge to edge, in its own space (a scaled group), its route kept; a missing node leaves the file\'s wire', () => {
  const { svg, wire, elbow, scaled, lost } = diagram();
  const changed = routeConnectors(svg);
  assert.deepEqual([wire.attrs.x1, wire.attrs.y1, wire.attrs.x2, wire.attrs.y2], ['100', '25', '250', '25']);
  assert.equal(elbow.attrs.d, 'M 100 25 L 250 25', 'lined up, the elbow is one segment');
  assert.deepEqual([scaled.attrs.x1, scaled.attrs.x2], ['50', '125'], 'in the scaled group\'s units, half the svg\'s');
  assert.deepEqual([lost.attrs.x1, lost.attrs.y2], [1, 4], 'a node it names is missing: left as the file has it');
  assert.ok(changed.includes(wire) && !changed.includes(lost));
  assert.deepEqual(routeConnectors(svg), [], 'routing again changes nothing');
});

test('a half-attached wire routes its named end toward the free one, which stays where the file has it', () => {
  const { svg, half } = diagram();
  routeConnectors(svg);
  assert.deepEqual([half.attrs.x2, half.attrs.y2], [50, 200], 'the free end stays');
  assert.deepEqual([half.attrs.x1, half.attrs.y1], ['50', '50'], 'the named end leaves the box\'s bottom edge toward it');
});

test('a drag stands in for an end: a point, or another node; a route asked for a tag the wire is to be', () => {
  const { svg, wire, box, oval } = diagram();
  assert.deepEqual(wireGeometry(wire, { to: { x: 50, y: 300 } }), { x1: '50', y1: '50', x2: '50', y2: '300' });
  assert.deepEqual(wireGeometry(wire, { from: oval, to: box }), { x1: '250', y1: '25', x2: '100', y2: '25' }, 'the other way round: off the ellipse\'s boundary');
  assert.equal(wireGeometry(wire, { route: 'elbow', tag: 'path' }).d, 'M 100 25 L 250 25');
  assert.deepEqual(connectorsOf(svg, box).length, 5, 'every wire with an end on the api box');
});

// ── the server: path data and points, closed shapes ─────────────────────────

test('path data is absolute M, L, H, V, C, Q and Z with numbers, written back in one spelling; anything else is refused', () => {
  assert.equal(pathDataValue('M10,20L30 40 50 60'), 'M 10 20 L 30 40 L 50 60');
  assert.equal(pathDataValue(' M 1.26 2 C 3 4 5 6 7 8 Z'), 'M 1.3 2 C 3 4 5 6 7 8 Z');
  assert.equal(pathDataValue('M0 0 H 10 V -5 Q 1 2 3 4'), 'M 0 0 H 10 V -5 Q 1 2 3 4');
  for (const bad of ['m 0 0 l 1 1', 'L 1 1', 'M 1', 'M 0 0 A 1 1 0 0 1 2 2', 'M 0 0 L 1e3 2', 'M 0 0 "/><script>', 'M 0 0 Z 1', 'M 0 0 L 9999999 1', '']) {
    assert.throws(() => pathDataValue(bad), undefined, bad);
  }
  assert.equal(pointsValue('1 2, 3.04 4'), '1,2 3,4');
  for (const bad of ['1 2', '1 2 3', '1 2 x 4', '1 2 3 4"']) assert.throws(() => pointsValue(bad), undefined, bad);
});

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 800 300">
      <g>
        <rect x="60" y="110" width="180" height="70" style="fill: var(--d-fill-3)"/>
        <text x="150" y="145" text-anchor="middle">Producer API</text>
      </g>
      <rect x="560" y="110" width="160" height="70" data-node="queue"/>
      <line x1="240" y1="145" x2="320" y2="145" stroke-width="2" style="stroke: var(--d-stroke)"/>
      <path d="M 1 1 L 2 2" data-from="queue" style="stroke: var(--d-stroke)"/>
    </svg>
  </section>
</div></body></html>`;
const line = (html, needle) => html.split('\n').find((l) => l.includes(needle));

test('the geometry route writes a path\'s d and a polyline\'s points, and refuses them on a tag that has none', () => {
  const next = setElementGeometry(DECK, 1, 1, [{ path: [3], tag: 'path', attr: 'd', value: 'M 5 5 L 9 9' }]);
  assert.equal(line(next, '<path'), '      <path d="M 5 5 L 9 9" data-from="queue" style="stroke: var(--d-stroke)"/>');
  assert.throws(() => setElementGeometry(DECK, 1, 1, [{ path: [2], tag: 'line', attr: 'd', value: 'M 5 5 L 9 9' }]), /has no d/);
  assert.throws(() => setElementGeometry(DECK, 1, 1, [{ path: [3], tag: 'path', attr: 'd', value: 'M 5 5 A 1 1 0 0 0 9 9' }]));
});

test('add: both nodes named from their words (slugged, unique), one line written like the diagram\'s, the shipped arrowhead defined', () => {
  const out = editConnector(DECK, 1, 1, { op: 'add', path: [], tag: 'svg', nodes: { from: { path: [0], tag: 'g' }, to: { path: [1], tag: 'rect', label: 'ignored: it has a name' } },
    geometry: { x1: 240, y1: 145, x2: 560, y2: 145.04 } });
  assert.deepEqual(out.named, { from: 'producer-api', to: 'queue' });
  assert.match(out.html, /<g data-node="producer-api">/);
  assert.equal(out.added.html, '<line x1="240" y1="145" x2="560" y2="145" stroke-width="2" style="stroke: var(--d-stroke)" data-from="producer-api" data-to="queue" marker-end="url(#dl-arrow)"/>', 'like the diagram\'s line, its look and its order');
  assert.deepEqual(out.added.path, [5], 'last, after the <defs> made first');
  assert.deepEqual(out.defs.map((d) => [d.path, d.created]), [[[0], true]]);
  assert.match(out.html, /<svg viewBox="0 0 800 300">\n {6}<defs><marker id="dl-arrow"[^\n]*<\/defs>\n {6}<g data-node/);
  assert.match(out.html, /<path d="M 1 1 L 2 2"[^\n]*\/>\n {6}<line x1="240"[^\n]*data-from="producer-api"[^\n]*\/>\n {4}<\/svg>/, 'on a line of its own, at its siblings\' indentation');
  // a second one, the other way: the names are kept, the marker the diagram has now is reused
  const two = editConnector(out.html, 1, 1, { op: 'add', path: [], tag: 'svg', nodes: { from: { path: [2], tag: 'rect' }, to: { path: [1], tag: 'g' } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } });
  assert.deepEqual(two.named, { from: 'queue', to: 'producer-api' });
  assert.ok(two.defs.length === 0 && two.added.html.includes('marker-end="url(#dl-arrow)"') && /data-from="queue" data-to="producer-api"/.test(two.added.html));
  // a node with the words another's name came from takes the next name
  const twin = DECK.replace('<rect x="560" y="110" width="160" height="70" data-node="queue"/>', '<g><rect x="560" y="110" width="160" height="70"/><text>Producer API</text></g>');
  const named = editConnector(twin, 1, 1, { op: 'add', path: [], nodes: { from: { path: [0] }, to: { path: [1] } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } });
  assert.deepEqual(named.named, { from: 'producer-api', to: 'producer-api-2' });
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'add', path: [], nodes: { from: { path: [1] }, to: { path: [1] } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } }), /two different/);
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'add', path: [], nodes: { from: { path: [0] }, to: { path: [1] } }, geometry: { d: 'M 1 1 L 2 2' } }), /written with x1/);
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'add', path: [], nodes: { from: { path: [3] }, to: { path: [1] } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } }), /not another connector/);
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'add', path: [], nodes: { from: { path: [0], tag: 'rect' }, to: { path: [1] } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } }), (e) => e.code === 'STALE');
});

test('reconnect attaches a hand-drawn line; detach lets an end go and keeps where it is', () => {
  const on = editConnector(DECK, 1, 1, { op: 'reconnect', wire: { path: [2], tag: 'line' }, end: 'to', node: { path: [1], tag: 'rect' }, geometry: { x1: 240, y1: 145, x2: 560, y2: 145 } });
  assert.equal(on.wire.html, '<line x1="240" y1="145" x2="560" y2="145" stroke-width="2" style="stroke: var(--d-stroke)" data-to="queue"/>');
  assert.deepEqual(on.named, { to: 'queue' });
  const off = editConnector(DECK, 1, 1, { op: 'detach', wire: { path: [3], tag: 'path' }, end: 'from', geometry: { d: 'M 3 3 L 2 2' } });
  assert.equal(off.wire.html, '<path d="M 3 3 L 2 2" style="stroke: var(--d-stroke)"/>');
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'reconnect', wire: { path: [3], tag: 'path' }, end: 'to', node: { path: [1], tag: 'rect' }, geometry: { d: 'M 1 1 L 2 2' } }), /one node/);
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'detach', wire: { path: [1], tag: 'rect' }, end: 'to', geometry: {} }), /not a wire/);
});

test('route: a line that bends becomes an unfilled path; straight takes data-route off; arrows; reverse swaps the ends', () => {
  const bent = editConnector(DECK, 1, 1, { op: 'route', wire: { path: [2], tag: 'line' }, route: 'elbow', geometry: { d: 'M 240 145 L 280 145 L 280 160' } });
  assert.equal(bent.wire.html, '<path stroke-width="2" style="stroke: var(--d-stroke)" fill="none" data-route="elbow" d="M 240 145 L 280 145 L 280 160"/>');
  const straight = editConnector(bent.html, 1, 1, { op: 'route', wire: { path: [2], tag: 'path' }, route: 'straight', geometry: { d: 'M 240 145 L 320 145' } });
  assert.ok(!straight.wire.html.includes('data-route') && straight.wire.html.startsWith('<path'), 'a path stays a path');
  assert.throws(() => editConnector(DECK, 1, 1, { op: 'route', wire: { path: [2], tag: 'line' }, route: 'curve', geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } }), /written with d/);
  // both ends: the end head the svg defines, a start head oriented to point away
  const both = editConnector(DECK, 1, 1, { op: 'arrows', wire: { path: [2], tag: 'line' }, arrows: 'both' });
  assert.match(both.wire.html, /marker-end="url\(#dl-arrow\)" marker-start="url\(#dl-arrow-start\)"/);
  assert.deepEqual(both.wire.path, [3], 'the <defs> made first moved it along');
  assert.deepEqual(both.defs.map((d) => d.path), [[0], [0, 1]]);
  assert.match(both.html, /<marker id="dl-arrow-start"[^>]*orient="auto-start-reverse"/);
  const none = editConnector(both.html, 1, 1, { op: 'arrows', wire: { path: [3], tag: 'line' }, arrows: 'none' });
  assert.ok(!/marker-/.test(none.wire.html) && none.defs.length === 0);
  const rev = editConnector(DECK, 1, 1, { op: 'reverse', wire: { path: [3], tag: 'path' }, geometry: { d: 'M 2 2 L 1 1' } });
  assert.equal(rev.wire.html, '<path d="M 2 2 L 1 1" style="stroke: var(--d-stroke)" data-to="queue"/>');
});

test('a node removed takes its connectors in the same write; one that is duplicated gets names of its own', () => {
  const joined = editConnector(DECK, 1, 1, { op: 'add', path: [], nodes: { from: { path: [0], tag: 'g' }, to: { path: [1], tag: 'rect' } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } }).html;
  // defs [0], g [1], rect [2], line [3], path [4], new line [5]
  const gone = removeNestedElement(joined, 1, 1, { path: [2], tag: 'rect' });
  assert.ok(!/data-node="queue"/.test(gone) && !/data-from="queue"/.test(gone) && !/data-to="queue"/.test(gone), 'the queue and both wires naming it went');
  assert.match(gone, /<line x1="240"/, 'a wire naming nothing stays');
  assert.ok(!/\n\s*\n/.test(gone.slice(gone.indexOf('<svg'), gone.indexOf('</svg>'))), 'no blank line left behind');
  const dup = duplicateDiagramNode(joined, 1, 1, { path: [1], tag: 'g' });
  assert.match(dup.added.html, /^<g data-node="producer-api-2"/);
  const pair = `<!doctype html><html><body><div class="decklight"><section><svg viewBox="0 0 100 100"><g><rect data-node="a" x="0" y="0" width="5" height="5"/><rect data-node="b" x="20" y="0" width="5" height="5"/><line data-from="a" data-to="b" x1="5" y1="2" x2="20" y2="2"/><line data-from="a" data-to="c" x1="5" y1="2" x2="20" y2="2"/></g><rect data-node="c" x="50" y="50" width="5" height="5"/></svg></section></div></body></html>`;
  const copy = duplicateDiagramNode(pair, 1, 0, { path: [0], tag: 'g' }).added.html;
  assert.match(copy, /data-node="a-2"[^>]*\/><rect data-node="b-2"[^>]*\/><line data-from="a-2" data-to="b-2"/, 'the copy\'s connector joins the copies');
  assert.match(copy, /<line data-from="a-2" x1/, 'an end on a node outside the copy is let go');
});

test('a node is named from its words, slugged: accents gone, a letter first, short', () => {
  assert.equal(slugNode('Rate Limiter!'), 'rate-limiter');
  assert.equal(slugNode('Café crème'), 'cafe-creme');
  assert.equal(slugNode('2nd stage'), 'n-2nd-stage');
  assert.equal(slugNode('   '), 'node');
  assert.ok(slugNode('x'.repeat(80)).length <= 32);
});

// ── the route ───────────────────────────────────────────────────────────────

function harness(t, html = DECK, deps = {}) {
  const dir = tmp('connectors', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileSync(deck, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, ...deps });
  return { routes, history, readDeck };
}
async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('POST /deck/edit/element/connector: ONE undo entry, the markup it wrote handed back, quiet for the page; stale is a 409, a bad op a 400', async (t) => {
  const quiet = []; const sent = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (x) => quiet.push(x), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/element/connector', { slide: 1, index: 1, op: 'add', path: [], tag: 'svg', quiet: true, from: 'page-a',
    nodes: { from: { path: [0], tag: 'g' }, to: { path: [1], tag: 'rect' } }, geometry: { x1: 1, y1: 1, x2: 2, y2: 2 } });
  assert.deepEqual([r.code, r.body.ok, r.body.changed, r.body.undo], [200, true, true, 1]);
  assert.ok(readDeck().includes(r.body.added.html) && r.body.named.from === 'producer-api' && r.body.defs.length === 1);
  const stale = await call(routes, 'POST /deck/edit/element/connector', { slide: 1, index: 1, op: 'arrows', wire: { path: [3], tag: 'rect' }, arrows: 'none' });
  assert.equal(stale.code, 409);
  assert.equal(history.counts().undo, 1, 'a refusal records nothing');
  await assert.rejects(() => call(routes, 'POST /deck/edit/element/connector', { slide: 1, index: 1, op: 'explode' }), /bad payload/);
  await assert.rejects(() => call(routes, 'POST /deck/edit/element/connector', { slide: 1, index: 1, op: 'route', wire: { path: [4], tag: 'path' }, route: 'zigzag' }), /straight, elbow or curve/);
});

// ── decklight check ─────────────────────────────────────────────────────────

test('decklight check: a data-from or data-to naming no node in its svg is a warning; a named one is not', () => {
  const deck = (wire) => `<!doctype html><html><body><div class="decklight"><section><h2>T</h2><svg viewBox="0 0 10 10" data-static-ok><rect data-node="a" width="1" height="1"/>${wire}</svg></section>
  <section><h2>U</h2><svg data-static-ok><rect data-node="b" width="1" height="1"/></svg></section></div></body></html>`;
  const found = (wire) => staticFindings(deck(wire), { exists: () => true }).filter((f) => f.rule === 'connector-node');
  assert.deepEqual(found('<line data-from="a" x1="0" y1="0" x2="1" y2="1"/>'), []);
  const lost = found('<line data-from="a" data-to="b" x1="0" y1="0" x2="1" y2="1"/>');
  assert.equal(lost.length, 1, 'b is a node of another svg, not this one');
  assert.equal(lost[0].level, 'warn');
  assert.equal(lost[0].slide, 1);
  assert.match(lost[0].message, /data-to="b"/);
});

// ── alignment guides (src/core/shapes.js) ───────────────────────────────────

test('guides: the nearest line within reach snaps, on each axis; the guides span both boxes; nothing near, nothing moves', async () => {
  const { alignGuides } = await import('../src/core/shapes.js');
  const others = [{ x: 100, y: 0, w: 50, h: 40 }, { x: 0, y: 200, w: 300, h: 10 }];
  const a = alignGuides({ x: 103, y: 60, w: 30, h: 20 }, others, { within: 4 });
  assert.deepEqual([a.dx, a.dy], [-3, 0], 'its left edge onto the other\'s left edge');
  assert.deepEqual(a.lines, [{ axis: 'x', at: 100, from: 0, to: 80 }]);
  const mid = alignGuides({ x: 111, y: 60, w: 30, h: 20 }, others, { within: 4 });
  assert.equal(mid.dx, -1, 'middle to middle: 126 onto 125 is nearer than any edge');
  const two = alignGuides({ x: 10, y: 178, w: 20, h: 20 }, others, { within: 4 });
  assert.deepEqual([two.dx, two.dy], [0, 2], 'its bottom onto the bar\'s top');
  assert.deepEqual(two.lines, [{ axis: 'y', at: 200, from: 0, to: 300 }]);
  const none = alignGuides({ x: 400, y: 400, w: 10, h: 10 }, others, { within: 4 });
  assert.deepEqual(none, { dx: 0, dy: 0, lines: [] });
  const edge = alignGuides({ x: 0, y: 60, w: 98, h: 20 }, others, { within: 4, xs: [1], ys: [] });
  assert.deepEqual([edge.dx, edge.dy, edge.lines.length], [2, 0, 1], 'a resize moves one edge: only that edge snaps');
});
