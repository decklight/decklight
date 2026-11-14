// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Groups in a diagram (SPEC SVG_DIAGRAMS, groups): Group wraps sibling shapes
// in one `<g data-group>` where the frontmost stood, Ungroup puts them back
// with the group's move given to each, and "Make it a group" marks a `<g>`
// the author wrote. A duplicate and a remove of a group are the shape
// route's and the remove route's, as for any node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { groupDiagramNodes, duplicateDiagramNode, removeNestedElement, setSlideBuildOrder, setElementBuildAttrs, createHistory, GROUP_OPS } from '../cli/edit.mjs';
import { buildSteps, buildClicks, parseTree } from '../cli/check.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Three boxes</h2>
    <svg viewBox="0 0 600 200">
      <defs><marker id="m"/></defs>
      <g class="a" data-node="api"><rect x="10" y="10" width="80" height="40"/><text x="50" y="30">API</text></g>
      <rect class="x" x="120" y="10" width="40" height="40"/>
      <g class="b"><rect x="200" y="10" width="80" height="40"/><text x="240" y="30">DB</text></g>
      <rect class="c" x="400" y="10" width="80" height="40"/>
      <line class="w" data-from="api" data-to="out" x1="90" y1="30" x2="300" y2="150"/>
      <circle class="o" data-node="out" cx="300" cy="170" r="20"/>
    </svg>
  </section>
</div></body></html>`;

const svgOf = (html) => /<svg[\s\S]*?<\/svg>/.exec(html)[0];
const group = (paths, html = DECK) => groupDiagramNodes(html, 1, 1, { op: 'group', paths: paths.map(([p, tag]) => ({ path: [p], tag })) });

test('Group wraps siblings in one <g data-group> where the frontmost stood, their order and lines kept', () => {
  assert.deepEqual(GROUP_OPS, ['group', 'ungroup', 'mark']);
  const g = group([[3, 'g'], [1, 'g'], [4, 'rect']]);
  assert.deepEqual(g.path, [2], 'at the frontmost one\'s place, less the two that went into it');
  assert.equal(g.markup, `<g data-group>
        <g class="a" data-node="api"><rect x="10" y="10" width="80" height="40"/><text x="50" y="30">API</text></g>
        <g class="b"><rect x="200" y="10" width="80" height="40"/><text x="240" y="30">DB</text></g>
        <rect class="c" x="400" y="10" width="80" height="40"/>
      </g>`);
  const svg = svgOf(g.html);
  assert.match(svg, /<defs><marker id="m"\/><\/defs>\n {6}<rect class="x"[^\n]*\/>\n {6}<g data-group>\n {8}<g class="a"/, 'the one between them is behind the group now');
  assert.match(svg, /<\/g>\n {6}<line class="w"/);
  assert.doesNotMatch(svg, /\n\s*\n/, 'no blank line left where a member was');
});

test('Group on one line: the members stay on it', () => {
  const html = DECK.replace(/<svg viewBox="0 0 600 200">[\s\S]*?<\/svg>/, '<svg viewBox="0 0 600 200"><rect class="p" x="1" y="1" width="9" height="9"/><rect class="q" x="20" y="1" width="9" height="9"/></svg>');
  const g = groupDiagramNodes(html, 1, 1, { op: 'group', paths: [{ path: [0], tag: 'rect' }, { path: [1], tag: 'rect' }] });
  assert.match(g.html, /<svg viewBox="0 0 600 200"><g data-group><rect class="p"[^>]*\/><rect class="q"[^>]*\/><\/g><\/svg>/);
  assert.deepEqual(g.path, [0]);
});

test('Group refuses one shape, shapes under different parents, a build, and what is not a diagram\'s', () => {
  assert.throws(() => group([[1, 'g']]), (e) => e.code === 'REFUSED' && /two shapes or more/.test(e.message));
  assert.throws(() => groupDiagramNodes(DECK, 1, 1, { op: 'group', paths: [{ path: [1, 0], tag: 'rect' }, { path: [4], tag: 'rect' }] }), (e) => e.code === 'REFUSED' && /share a parent/.test(e.message));
  assert.throws(() => group([[1, 'g'], [1, 'g']]), /the same shape twice/);
  assert.throws(() => group([[1, 'g'], [2, 'circle']]), (e) => e.code === 'STALE');
  const built = DECK.replace('<svg viewBox="0 0 600 200">', '<svg viewBox="0 0 600 200" data-build="draw">');
  assert.throws(() => group([[1, 'g'], [3, 'g']], built), (e) => e.code === 'REFUSED' && /clicks were not sent/.test(e.message), 'in a diagram that builds, only with the order frozen');
  assert.throws(() => groupDiagramNodes(DECK, 1, 0, { op: 'group', paths: [{ path: [0] }, { path: [1] }] }), /bad path|no element/);
  assert.throws(() => groupDiagramNodes(DECK, 1, 1, { op: 'wrap', paths: [] }), /group, ungroup or mark/);
});

test('Ungroup puts the members back where the group stood, its move given to each in its own coordinates', () => {
  const g = group([[3, 'g'], [1, 'g'], [4, 'rect']]);
  const moved = g.html.replace('<g data-group>', '<g data-group transform="translate(5 -2)">');
  const u = groupDiagramNodes(moved, 1, 1, { op: 'ungroup', path: [2], tag: 'g' });
  const svg = svgOf(u.html);
  assert.doesNotMatch(svg, /data-group/);
  assert.match(svg, /<rect class="x"[^\n]*\/>\n {6}<g class="a" data-node="api"><rect x="15" y="8" width="80" height="40"\/><text x="55" y="28">API<\/text><\/g>\n {6}<g class="b"><rect x="205" y="8"/);
  assert.match(svg, /<rect class="c" x="405" y="8" width="80" height="40"\/>\n {6}<line class="w"/);
  assert.deepEqual(u.members.map((m) => m.path), [[2], [3], [4]]);
  assert.deepEqual(u.members.map((m) => m.tag), ['g', 'g', 'rect']);
  // group then ungroup with no move: the file is as it was, but for the shape that went behind
  const back = groupDiagramNodes(g.html, 1, 1, { op: 'ungroup', path: [2], tag: 'g' }).html;
  assert.equal(svgOf(back), svgOf(DECK).replace(/(\n {6}<g class="a"[^\n]*)(\n {6}<rect class="x"[^\n]*)/, '$2$1'));
});

test('Ungroup: a rotated member takes the move in front of its own transform; a path by its own numbers', () => {
  const html = DECK.replace(/<svg viewBox="0 0 600 200">[\s\S]*?<\/svg>/, `<svg viewBox="0 0 600 200">
      <g data-group transform="translate(10,20)">
        <text x="5" y="5" transform="rotate(30 5 5)">tilt</text>
        <path d="M 0 0 L 10 10 Z"/>
      </g>
    </svg>`);
  const u = groupDiagramNodes(html, 1, 1, { op: 'ungroup', path: [0], tag: 'g' });
  assert.match(u.html, /<text x="5" y="5" transform="translate\(10 20\) rotate\(30 5 5\)">tilt<\/text>\n {6}<path d="M 10 20 L 20 30 Z"\/>\n {4}<\/svg>/);
});

test('Ungroup refuses another transform, paint of its own, and a diagram that builds', () => {
  const g = group([[1, 'g'], [3, 'g']]).html;
  const at = { op: 'ungroup', path: [2], tag: 'g' };
  assert.throws(() => groupDiagramNodes(g.replace('<g data-group>', '<g data-group transform="rotate(10)">'), 1, 1, at), (e) => e.code === 'REFUSED' && /rotate\(10\)/.test(e.message));
  assert.throws(() => groupDiagramNodes(g.replace('<g data-group>', '<g data-group fill="red">'), 1, 1, at), (e) => e.code === 'REFUSED' && /fill="red"/.test(e.message));
  assert.throws(() => groupDiagramNodes(g.replace('<svg viewBox="0 0 600 200">', '<svg viewBox="0 0 600 200" data-build>'), 1, 1, at), (e) => e.code === 'REFUSED' && /clicks were not sent/.test(e.message));
  assert.throws(() => groupDiagramNodes(g.replace('<g data-group>', '<g data-group data-animate="pulse">'), 1, 1, at), (e) => e.code === 'REFUSED' && /data-animate/.test(e.message));
  assert.throws(() => groupDiagramNodes(DECK, 1, 1, { op: 'ungroup', path: [2], tag: 'rect' }), /for a group in a diagram/);
});

test('Ungroup: a wire joined to the group is joined to the member nearest where it meets it, named when it is not', () => {
  const g = group([[1, 'g'], [3, 'g']]);
  // the group given a name, and the wire joined to it at its right-hand box (DB)
  const named = g.html.replace('<g data-group>', '<g data-group data-node="pair">').replace('data-from="api" data-to="out" x1="90" y1="30"', 'data-from="pair" data-to="out" x1="285" y1="30"');
  const u = groupDiagramNodes(named, 1, 1, { op: 'ungroup', path: [2], tag: 'g' });
  assert.deepEqual(u.wires, [{ from: 'db', to: 'out' }]);
  assert.match(u.html, /<g class="b" data-node="db">/);
  assert.match(u.html, /<line class="w" data-from="db" data-to="out"/);
  assert.doesNotMatch(u.html, /pair/);
  assert.equal(u.members[1].html.startsWith('<g class="b" data-node="db">'), true, 'the member as the file has it now');
});

test('Make it a group: a <g> the author wrote marked, once', () => {
  const m = groupDiagramNodes(DECK, 1, 1, { op: 'mark', path: [3], tag: 'g' });
  assert.match(m.html, /<g class="b" data-group>/);
  assert.equal(m.markup.startsWith('<g class="b" data-group>'), true);
  assert.throws(() => groupDiagramNodes(m.html, 1, 1, { op: 'mark', path: [3], tag: 'g' }), (e) => e.code === 'REFUSED' && /already/.test(e.message));
  assert.throws(() => groupDiagramNodes(DECK, 1, 1, { op: 'mark', path: [2], tag: 'rect' }), /for a group in a diagram/);
});

test('a group duplicated is one node, its names its own; removed, it takes its members\' wires and their labels', () => {
  const g = group([[1, 'g'], [3, 'g']]).html;
  const d = duplicateDiagramNode(g, 1, 1, { path: [2], tag: 'g' });
  assert.match(d.added.html, /^<g data-group transform="translate\(12 12\)">/);
  assert.match(d.added.html, /data-node="api-2"/, 'a copy is never a second view of the first');
  const labelled = g.replace('<line class="w"', '<line class="w" data-wire="call"').replace('</svg>', '  <text data-on-wire="call" x="1" y="1">calls</text>\n    </svg>');
  const r = removeNestedElement(labelled, 1, 1, { path: [2], tag: 'g' });
  assert.doesNotMatch(r, /data-group|class="w"|calls/);
  assert.match(r, /<circle class="o"/);
});

// ── in a diagram that builds (BUILD_SEMANTICS) ──────────────────────────────

const BUILT = DECK.replace('<svg viewBox="0 0 600 200">', '<svg viewBox="0 0 600 200" data-build="draw">');
/** Each drawn child of the svg its own click, as the Builds tab sends them. */
const CLICKS = [1, 2, 3, 4, 5, 6].map((p) => [{ index: 1, path: [p] }]);
const freeze = (html) => setSlideBuildOrder(html, 1, CLICKS, { freeze: true }).html;
const keyOf = (html, cls) => new RegExp(`class="${cls}"[^>]*data-build-order="(\\d+)"`).exec(html)?.[1] ?? null;
const clicks = (html) => [buildSteps(parseTree(html)), buildClicks(parseTree(html))];

test('Group in a diagram that builds: the order frozen, the group builds its members one by one, every click kept', () => {
  assert.deepEqual(clicks(BUILT), [6, 6]);
  const g = groupDiagramNodes(freeze(BUILT), 1, 1, { op: 'group', paths: [{ path: [1], tag: 'g' }, { path: [3], tag: 'g' }, { path: [4], tag: 'rect' }], frozen: true });
  assert.match(g.markup, /^<g data-group data-build="draw">/, 'the svg\'s effect, so each member is a step');
  assert.deepEqual(['a', 'x', 'b', 'c'].map((c) => keyOf(g.html, c)), ['1', '2', '3', '4'], 'each keeps the key it played on');
  assert.deepEqual(clicks(g.html), [6, 6], 'six steps, six clicks, as before');
  // a bare data-build on the svg: a bare one on the group
  const bare = groupDiagramNodes(freeze(DECK.replace('<svg viewBox="0 0 600 200">', '<svg viewBox="0 0 600 200" data-build>')), 1, 1, { op: 'group', paths: [{ path: [1], tag: 'g' }, { path: [3], tag: 'g' }], frozen: true });
  assert.match(bare.markup, /^<g data-group data-build>/);
  // shapes there from the start make a group there from the start
  const stay = BUILT.replace('<rect class="x"', '<rect class="x" data-build-stay').replace('<rect class="c"', '<rect class="c" data-build-stay');
  assert.match(groupDiagramNodes(stay, 1, 1, { op: 'group', paths: [{ path: [2], tag: 'rect' }, { path: [4], tag: 'rect' }], frozen: true }).markup, /^<g data-group data-build-stay>/);
  // a diagram that does not build: no build on the group
  assert.match(group([[1, 'g'], [3, 'g']]).markup, /^<g data-group>/);
});

test('"all at once" makes the group one step, on its first member\'s click; Ungroup then gives each member that key', () => {
  const g = groupDiagramNodes(freeze(BUILT), 1, 1, { op: 'group', paths: [{ path: [3], tag: 'g' }, { path: [4], tag: 'rect' }], frozen: true });
  const once = setElementBuildAttrs(g.html, 1, 1, { path: [3], tag: 'g', self: true });
  assert.match(once, /<g data-group data-build="draw" data-build-self data-build-order="3">/);
  assert.deepEqual(clicks(once), [5, 5], 'the two arrive on one click');
  const u = groupDiagramNodes(once, 1, 1, { op: 'ungroup', path: [3], tag: 'g', frozen: true });
  assert.deepEqual(['b', 'c'].map((c) => keyOf(u.html, c)), ['3', '3'], 'still together, where the group arrived');
  assert.deepEqual(clicks(u.html), [6, 5]);
  assert.doesNotMatch(u.html, /data-group|data-build-self/);
});

test('Ungroup in a diagram that builds: members that were steps keep their keys; a group\'s own effect goes to each', () => {
  const g = groupDiagramNodes(freeze(BUILT), 1, 1, { op: 'group', paths: [{ path: [1], tag: 'g' }, { path: [3], tag: 'g' }], frozen: true });
  const u = groupDiagramNodes(g.html, 1, 1, { op: 'ungroup', path: [2], tag: 'g', frozen: true });
  assert.deepEqual(['a', 'x', 'b', 'c'].map((c) => keyOf(u.html, c)), ['1', '2', '3', '4']);
  assert.deepEqual(clicks(u.html), [6, 6]);
  assert.doesNotMatch(u.html, /<g class="a"[^>]*data-build=/, 'the svg\'s own effect is not written on each');
  const faded = g.html.replace('<g data-group data-build="draw">', '<g data-group data-build="fade">');
  assert.match(groupDiagramNodes(faded, 1, 1, { op: 'ungroup', path: [2], tag: 'g', frozen: true }).html, /<g class="a" data-node="api" data-build-order="1" data-build="fade">/);
});

function harness(t) {
  const dir = tmp('diagram-groups', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
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
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, quiet: () => {}, broadcast: () => {} });
  return { routes, history, readDeck };
}
async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('POST /deck/edit/element/group: group and ungroup, each one undo; a refusal is a 409 and writes nothing', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const key = 'POST /deck/edit/element/group';
  const one = await call(routes, key, { slide: 1, index: 1, op: 'group', paths: [{ path: [1], tag: 'g' }] });
  assert.equal(one.code, 409);
  assert.equal(history.counts().undo, 0);
  const g = await call(routes, key, { slide: 1, index: 1, op: 'group', paths: [{ path: [1], tag: 'g' }, { path: [3], tag: 'g' }], quiet: true, from: 'p' });
  assert.equal(g.code, 200);
  assert.deepEqual(g.body.path, [2]);
  assert.match(g.body.markup, /^<g data-group>/);
  assert.equal(g.body.html, undefined, 'the deck is not sent back');
  assert.equal(history.counts().undo, 1);
  const u = await call(routes, key, { slide: 1, index: 1, op: 'ungroup', path: [2], tag: 'g' });
  assert.equal(u.code, 200);
  assert.equal(u.body.members.length, 2);
  assert.doesNotMatch(readDeck(), /data-group/);
  assert.equal(history.counts().undo, 2);
  assert.equal((await call(routes, key, { slide: 1, index: 1, op: 'group', path: [1] })).code, 400);
  assert.equal((await call(routes, key, { slide: 1, index: 1, op: 'ungroup', path: [2], tag: 'g' })).code, 409, 'the page saw a group the file no longer has');
});
