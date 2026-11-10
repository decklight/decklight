// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A diagram's shapes moved, resized, added and duplicated in write mode
// (SPEC SVG_DIAGRAMS, PRESENTING_EDITING): the file gets one attribute where
// it stands, or one node's markup on its own line at its neighbours'
// indentation, and every other byte of the diagram stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  setElementGeometry, addDiagramShape, duplicateDiagramNode, withTranslate, translateOf, shiftPathData, shiftPoints,
  formatCoord, createHistory,
} from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { resizeBox, followLabel, keepGrain, setTranslate, localStep, leadingTranslate } from '../src/core/shapes.js';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 800 300">
      <defs><marker id="arr" markerWidth="6"><polygon points="0 0, 6 2, 0 4"/></marker></defs>
      <g>
        <rect x="60" y="110" width="180" height="70" rx="10" style="fill: var(--d-fill-3)" data-concept="agent" id="a-box"/>
        <text x="150" y="145" text-anchor="middle" font-size="18" style="fill: var(--d-text)">Producer</text>
      </g>
      <line x1="240" y1="145" x2="320" y2="145" style="stroke: var(--d-stroke)" marker-end="url(#arr)" />
      <circle cx='500' cy='145' r='30'/>
      <ellipse cx="660" cy="145" rx="80" ry="45" style="fill: var(--d-fill-4)"/>
      <g transform="translate(5, 6) rotate(3)"><path d="M10 10 L 20 20 h5 z"/></g>
      <path d="M100 250 L 200 250" transform="rotate(2)"/>
    </svg>
  </section>
</div></body></html>`;

const edit = (edits) => setElementGeometry(DECK, 1, 1, edits);
/** The one line of the deck that holds `needle`. */
const line = (html, needle) => html.split('\n').find((l) => l.includes(needle));
/** Nothing outside the lines holding these needles changed. */
const onlyLines = (next, ...needles) => {
  const a = DECK.split('\n'); const b = next.split('\n');
  assert.equal(a.length, b.length, 'no line came or went');
  a.forEach((l, i) => { if (!needles.some((n) => l.includes(n))) assert.equal(b[i], l, `line ${i} changed`); });
};

// ── geometry ────────────────────────────────────────────────────────────────

test('a move writes x/y on a rect and its label, in place, the rest of each tag byte for byte', () => {
  const next = edit([{ path: [1, 0], tag: 'rect', attr: 'x', value: 80 }, { path: [1, 0], tag: 'rect', attr: 'y', value: 130.25 },
    { path: [1, 1], tag: 'text', attr: 'x', value: 170 }, { path: [1, 1], tag: 'text', attr: 'y', value: '165' }]);
  assert.equal(line(next, '<rect'), '        <rect x="80" y="130.3" width="180" height="70" rx="10" style="fill: var(--d-fill-3)" data-concept="agent" id="a-box"/>');
  assert.equal(line(next, 'Producer'), '        <text x="170" y="165" text-anchor="middle" font-size="18" style="fill: var(--d-text)">Producer</text>');
  onlyLines(next, '<rect', 'Producer');
});

test('each attribute a shape uses: cx/cy and r on a circle (its quotes kept), the ends of a line, an ellipse\'s radii', () => {
  const next = edit([{ path: [3], tag: 'circle', attr: 'cx', value: 510 }, { path: [3], tag: 'circle', attr: 'r', value: 41 },
    { path: [2], tag: 'line', attr: 'x2', value: 330 }, { path: [2], tag: 'line', attr: 'y1', value: -5 },
    { path: [4], tag: 'ellipse', attr: 'rx', value: 90 }, { path: [4], tag: 'ellipse', attr: 'ry', value: 50.04 }]);
  assert.equal(line(next, '<circle'), "      <circle cx='510' cy='145' r='41'/>");
  assert.equal(line(next, '<line'), '      <line x1="240" y1="-5" x2="330" y2="145" style="stroke: var(--d-stroke)" marker-end="url(#arr)" />', 'the space before /> stays');
  assert.equal(line(next, '<ellipse'), '      <ellipse cx="660" cy="145" rx="90" ry="50" style="fill: var(--d-fill-4)"/>');
  onlyLines(next, '<circle', '<line', '<ellipse');
});

test('a translate is merged into the leading one, never clobbering what follows; one is put in front of a transform without; (0 0) takes it off', () => {
  let next = edit([{ path: [1], tag: 'g', attr: 'transform', value: 'translate(20 30)' }]);
  assert.equal(line(next, '      <g'), '      <g transform="translate(20 30)">', 'a group without a transform gets one');
  next = edit([{ path: [5], tag: 'g', attr: 'transform', value: 'translate(15 16)' }]);
  assert.match(next, /<g transform="translate\(15, 16\) rotate\(3\)">/, 'the comma and the rotate stay');
  next = edit([{ path: [6], tag: 'path', attr: 'transform', value: 'translate(-4.26, 3)' }]);
  assert.match(next, /<path d="M100 250 L 200 250" transform="translate\(-4\.3 3\) rotate\(2\)"\/>/, 'put in front of the rotate it had');
  next = edit([{ path: [5], tag: 'g', attr: 'transform', value: 'translate(0 0)' }]);
  assert.match(next, /<g transform="rotate\(3\)">/);
  const twice = setElementGeometry(edit([{ path: [1], tag: 'g', attr: 'transform', value: 'translate(20 30)' }]), 1, 1, [{ path: [1], tag: 'g', attr: 'transform', value: 'translate(0)' }]);
  assert.equal(line(twice, '      <g'), '      <g>', 'no transform left at all: the attribute goes');
});

test('the pure translate arithmetic: read, replace, prepend, drop', () => {
  assert.deepEqual(translateOf('translate(5, 6) rotate(3)'), { x: 5, y: 6 });
  assert.deepEqual(translateOf('translate(7)'), { x: 7, y: 0 });
  assert.deepEqual(translateOf('rotate(3) translate(5 6)'), { x: 0, y: 0 }, 'only a LEADING translate is the node\'s move');
  assert.equal(withTranslate('scale(2)', 1, 2), 'translate(1 2) scale(2)');
  assert.equal(withTranslate('translate(1,2)', 0, 0), '');
  assert.equal(formatCoord(-0.04), '0');
  assert.equal(formatCoord(12.349), '12.3');
});

test('what a geometry edit refuses: another attribute, a value that is not a number, a negative size, a node outside a diagram', () => {
  assert.throws(() => edit([{ path: [1, 0], tag: 'rect', attr: 'fill', value: 3 }]), /not an attribute this server moves/);
  assert.throws(() => edit([{ path: [1, 0], tag: 'rect', attr: 'x', value: '10px' }]), /not a coordinate/);
  assert.throws(() => edit([{ path: [1, 0], tag: 'rect', attr: 'x', value: '1" onload="x' }]), /not a coordinate/);
  assert.throws(() => edit([{ path: [1, 0], tag: 'rect', attr: 'width', value: -3 }]), /cannot be negative/);
  assert.throws(() => edit([{ path: [1, 0], tag: 'rect', attr: 'x', value: 1e9 }]), /not a coordinate/);
  assert.throws(() => edit([{ path: [1], tag: 'g', attr: 'transform', value: 'rotate(4)' }]), /translate\(x y\)/);
  assert.throws(() => edit([]), /bad edits/);
  assert.throws(() => setElementGeometry(DECK, 1, 0, [{ path: [], tag: 'h2', attr: 'x', value: 1 }]), /not a node of a diagram/);
  assert.throws(() => edit([{ path: [], tag: 'svg', attr: 'width', value: 1 }]), /not a node of a diagram/, 'the svg itself is the diagram, not a node of it');
});

test('a stale path is a 409, not a guess: another tag there, or nothing there', () => {
  for (const e of [{ path: [1, 0], tag: 'text', attr: 'x', value: 1 }, { path: [1, 9], tag: 'rect', attr: 'x', value: 1 }]) {
    assert.throws(() => edit([e]), (err) => err.code === 'STALE' && /reload/.test(err.message));
  }
});

// ── add ─────────────────────────────────────────────────────────────────────

test('a new box is written the way the nearest box is: its look, not its place, its id or its concept, at its neighbours\' indentation', () => {
  const out = addDiagramShape(DECK, 1, 1, { path: [], tag: 'svg', kind: 'box', at: { x: 400, y: 250 } });
  assert.deepEqual(out.added.path, [7]);
  assert.equal(out.added.html, '<g>\n        <rect x="310" y="215" width="180" height="70" rx="10" style="fill: var(--d-fill-3)"/>\n'
    + '        <text x="400" y="250" text-anchor="middle" font-size="18" style="fill: var(--d-text)">Box</text>\n      </g>');
  assert.ok(out.html.includes(`<path d="M100 250 L 200 250" transform="rotate(2)"/>\n      ${out.added.html}\n    </svg>`), 'last in the svg, on its own line');
  assert.equal(out.html.replace(`\n      ${out.added.html}`, ''), DECK, 'nothing else moved');
  assert.equal(out.defs, null);
});

test('a box in a diagram that has none is theme tokens only, centred on the viewBox without a place', () => {
  const bare = DECK.replace(/<g>\n {8}<rect[^]*?<\/g>\n {6}/, '');
  const out = addDiagramShape(bare, 1, 1, { path: [], kind: 'box' });
  const [rect, text] = out.added.html.split('\n').slice(1, 3).map((s) => s.trim());
  assert.equal(rect, '<rect x="320" y="118" width="160" height="64" rx="10" style="fill: var(--d-fill-1); stroke: var(--d-stroke)" stroke-width="2"/>');
  assert.match(text, /^<text x="400" y="150" text-anchor="middle" dominant-baseline="central" [^>]*>Box<\/text>$/);
  assert.doesNotMatch(out.added.html, /#[0-9a-f]{3,8}\b/i, 'no literal colour');
});

test('an ellipse and a label, each from the nearest of its kind', () => {
  const e = addDiagramShape(DECK, 1, 1, { path: [], kind: 'ellipse', at: { x: 100, y: 50 } });
  assert.equal(e.added.html, '<ellipse cx="100" cy="50" rx="80" ry="45" style="fill: var(--d-fill-4)"/>');
  const l = addDiagramShape(DECK, 1, 1, { path: [], kind: 'label', at: { x: 100, y: 50 } });
  assert.equal(l.added.html, '<text x="100" y="50" text-anchor="middle" font-size="18" style="fill: var(--d-text)">Label</text>');
});

test('a line ends in the arrowhead the diagram defines, or adds the shipped one to its <defs>, or makes the <defs>', () => {
  const reuse = addDiagramShape(DECK.replace(/<line[^\n]*\n {6}/, ''), 1, 1, { path: [], kind: 'line', at: { x: 400, y: 40 } });
  assert.match(reuse.added.html, /marker-end="url\(#arr\)"/);
  assert.equal(reuse.defs, null);
  const noMarker = DECK.replace(/<marker[^]*?<\/marker>/, '').replace(/<line[^\n]*\n {6}/, '');
  const into = addDiagramShape(noMarker, 1, 1, { path: [], kind: 'line' });
  assert.match(into.html, /<defs><marker id="dl-arrow" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" style="fill: var\(--d-stroke\)"\/><\/marker><\/defs>/);
  assert.deepEqual([into.defs.path, into.defs.created], [[0, 0], false]);
  assert.match(into.added.html, /^<line x1="340" y1="150" x2="460" y2="150" stroke-width="2" style="stroke: var\(--d-stroke\)" marker-end="url\(#dl-arrow\)"\/>$/);
  const noDefs = noMarker.replace(/<defs><\/defs>\n {6}/, '');
  const made = addDiagramShape(noDefs, 1, 1, { path: [], kind: 'line' });
  assert.deepEqual([made.defs.path, made.defs.created], [[0], true]);
  assert.ok(made.html.includes('<svg viewBox="0 0 800 300">\n      <defs><marker id="dl-arrow"'), 'the new <defs> is the svg\'s first child, on its own line');
  assert.deepEqual(made.added.path, [6]);
});

test('an svg written on one line gets its new shape on that line; a non-svg, an unknown kind and a stale path are refused', () => {
  const one = '<div class="decklight"><section><svg viewBox="0 0 100 50"><rect x="1" y="1" width="10" height="10"/></svg></section></div>';
  const out = addDiagramShape(one, 1, 0, { path: [], kind: 'ellipse', at: { x: 50, y: 25 } });
  assert.equal(out.html, '<div class="decklight"><section><svg viewBox="0 0 100 50"><rect x="1" y="1" width="10" height="10"/><ellipse cx="50" cy="25" rx="9" ry="5" style="fill: var(--d-fill-2); stroke: var(--d-stroke)" stroke-width="2"/></svg></section></div>');
  assert.throws(() => addDiagramShape(DECK, 1, 1, { path: [1], tag: 'g', kind: 'box' }), /added to a diagram's <svg>/);
  assert.throws(() => addDiagramShape(DECK, 1, 1, { path: [], kind: 'star' }), /not a shape/);
  assert.throws(() => addDiagramShape(DECK, 1, 1, { path: [], kind: 'box', at: { x: 'a', y: 1 } }), /bad position/);
  assert.throws(() => addDiagramShape(DECK, 1, 0, { path: [], tag: 'svg', kind: 'box' }), (e) => e.code === 'STALE');
});

// ── duplicate ───────────────────────────────────────────────────────────────

test('a duplicate is the file\'s node, its ids off, moved a step (a fiftieth of the viewBox), right after it at its indentation', () => {
  const out = duplicateDiagramNode(DECK, 1, 1, { path: [1], tag: 'g' });
  assert.deepEqual(out.added.path, [2]);
  assert.equal(out.added.html, '<g transform="translate(16 16)">\n        <rect x="60" y="110" width="180" height="70" rx="10" style="fill: var(--d-fill-3)" data-concept="agent"/>\n'
    + '        <text x="150" y="145" text-anchor="middle" font-size="18" style="fill: var(--d-text)">Producer</text>\n      </g>');
  assert.ok(out.html.includes(`</g>\n      ${out.added.html}\n      <line`));
  const c = duplicateDiagramNode(DECK, 1, 1, { path: [3], tag: 'circle', by: { dx: 5, dy: -5 } });
  assert.equal(c.added.html, "<circle cx='505' cy='140' r='30'/>");
  const l = duplicateDiagramNode(DECK, 1, 1, { path: [2], tag: 'line' });
  assert.match(l.added.html, /x1="256" y1="161" x2="336" y2="161"/);
});

test('a build step owns its transform: its copy moves what it holds instead (children, points, a path\'s coordinates)', () => {
  const built = DECK.replace('<svg viewBox="0 0 800 300">', '<svg viewBox="0 0 800 300" data-build="draw">').replace('<g transform="translate(5, 6) rotate(3)">', '<g>');
  const g = duplicateDiagramNode(built, 1, 1, { path: [1], tag: 'g' });
  assert.match(g.added.html, /^<g>\n {8}<rect x="76" y="126" /, 'no transform on a step: the rect moved');
  assert.match(g.added.html, /<text x="166" y="161" /);
  const p = duplicateDiagramNode(built, 1, 1, { path: [6], tag: 'path' });
  assert.match(p.added.html, /^<path d="M116 266 L 216 266" transform="rotate\(2\)"\/>$/);
  const inner = duplicateDiagramNode(built, 1, 1, { path: [5], tag: 'g' });
  assert.match(inner.added.html, /<path d="M10 10 L 20 20 h5 z" transform="translate\(16 16\)"\/>/, 'a step group\'s path moves by its own translate');
});

test('duplicate refuses what is not a node of a diagram, and a stale path', () => {
  assert.throws(() => duplicateDiagramNode(DECK, 1, 1, { path: [], tag: 'svg' }), /bad path/);
  assert.throws(() => duplicateDiagramNode(DECK, 1, 1, { path: [0], tag: 'defs' }), /not a node of a diagram/);
  assert.throws(() => duplicateDiagramNode(DECK, 1, 1, { path: [3], tag: 'rect' }), (e) => e.code === 'STALE');
});

test('path data and points shift where absolute, keeping their own spacing', () => {
  assert.equal(shiftPathData('M10 10 L 20 20 h5 a 5 5 0 0 1 10 10 z', 1, 2), 'M11 12 L 21 22 h5 a 5 5 0 0 1 10 10 z');
  assert.equal(shiftPathData('m10,10 l5,5', 1, 2), 'm11,12 l5,5', 'the first moveto is from the origin even when relative');
  assert.equal(shiftPathData('M0 0 A 5 5 0 0 1 10 10', 1, 1), 'M1 1 A 5 5 0 0 1 11 11', 'an arc\'s radii and flags are not positions');
  assert.equal(shiftPathData('L 1 1', 1, 1), null);
  assert.equal(shiftPoints('0 0, 6 2, 0 4', 1, 1), '1,1 7,3 1,5');
  assert.equal(shiftPoints('0 0 1', 1, 1), null);
});

// ── the routes ──────────────────────────────────────────────────────────────

function harness(t, html = DECK, deps = {}) {
  const dir = tmp('diagram-shapes', t);
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

test('POST /deck/edit/element/geometry: a drag is ONE undo entry, quiet for the page that dragged, every other page told; stale is a 409', async (t) => {
  const quiet = []; const sent = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (h) => quiet.push(h), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/element/geometry', { slide: 1, index: 1, quiet: true, from: 'page-a',
    edits: [{ path: [1], tag: 'g', attr: 'transform', value: 'translate(10 20)' }, { path: [3], tag: 'circle', attr: 'cx', value: 1 }] });
  assert.deepEqual([r.code, r.body.ok, r.body.changed, r.body.undo], [200, true, true, 1]);
  assert.match(readDeck(), /<g transform="translate\(10 20\)">/);
  assert.match(readDeck(), /<circle cx='1'/);
  assert.equal(quiet.length, 1);
  assert.deepEqual(sent, [['content', { slide: 1, index: 1, from: 'page-a' }]]);
  const stale = await call(routes, 'POST /deck/edit/element/geometry', { slide: 1, index: 1, edits: [{ path: [3], tag: 'rect', attr: 'x', value: 1 }] });
  assert.equal(stale.code, 409);
  assert.equal(history.counts().undo, 1, 'a refusal records nothing');
});

test('POST /deck/edit/element/shape answers with the markup it wrote, for add and for duplicate', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const add = await call(routes, 'POST /deck/edit/element/shape', { slide: 1, index: 1, path: [], tag: 'svg', op: 'add', kind: 'label', at: { x: 10, y: 20 } });
  assert.deepEqual([add.code, add.body.changed, add.body.added.path], [200, true, [7]]);
  assert.ok(readDeck().includes(add.body.added.html));
  const dup = await call(routes, 'POST /deck/edit/element/shape', { slide: 1, index: 1, path: [3], tag: 'circle', op: 'duplicate' });
  assert.deepEqual(dup.body.added.path, [4]);
  assert.equal(history.counts().undo, 2, 'one undo entry each');
  const stale = await call(routes, 'POST /deck/edit/element/shape', { slide: 1, index: 1, path: [3], tag: 'rect', op: 'duplicate' });
  assert.equal(stale.code, 409);
  await assert.rejects(() => call(routes, 'POST /deck/edit/element/shape', { slide: 1, index: 1, path: [], op: 'explode' }), /bad payload/);
});

// ── the page's arithmetic (src/core/shapes.js) ─────────────────────────────

test('a handle drags its edges and leaves the opposite ones; ⇧ on a corner keeps the proportions; nothing goes below the minimum', () => {
  const box = { x: 10, y: 10, w: 100, h: 50 };
  assert.deepEqual(resizeBox(box, 1, 1, { x: 150, y: 80 }), { x: 10, y: 10, w: 140, h: 70 });
  assert.deepEqual(resizeBox(box, -1, 0, { x: 0, y: 999 }), { x: 0, y: 10, w: 110, h: 50 }, 'an edge handle moves one edge only');
  assert.deepEqual(resizeBox(box, 1, 1, { x: 210, y: 70 }, { aspect: true }), { x: 10, y: 10, w: 120, h: 60 });
  assert.deepEqual(resizeBox(box, 1, 0, { x: -50, y: 0 }), { x: 10, y: 10, w: 4, h: 50 });
});

test('a label centred on a box stays centred; one written from an edge keeps its distance to it', () => {
  const was = { x: 0, y: 0, w: 100, h: 60 }; const now = { x: 0, y: 0, w: 200, h: 100 };
  assert.deepEqual(followLabel({ x: 50, y: 30, anchor: 'middle' }, was, now), { x: 100, y: 50 });
  assert.deepEqual(followLabel({ x: 10, y: 8, anchor: 'start' }, was, { x: 20, y: 0, w: 80, h: 60 }), { x: 30, y: 8 });
  assert.deepEqual(followLabel({ x: 95, y: 55, anchor: 'end' }, was, now), { x: 195, y: 95 });
});

test('the page writes in the grain a coordinate had, and its translate the way the server merges one', () => {
  assert.equal(keepGrain(10, 12.6), 13);
  assert.equal(keepGrain(10.5, 12.66), 12.7);
  assert.equal(keepGrain(0, -0.2), 0);
  assert.equal(setTranslate('translate(1, 2) rotate(3)', 4, 5), 'translate(4, 5) rotate(3)');
  assert.equal(setTranslate(null, 0, 0), '');
  assert.deepEqual(leadingTranslate('translate(4)'), { x: 4, y: 0 });
  assert.deepEqual(localStep({ a: 0.5, b: 0, c: 0, d: 0.5 }, 10, 20), { x: 5, y: 10 });
});
