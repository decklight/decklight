// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A token along a wire (SPEC BUILD_ENTRANCES, travel, #1180): the parts a
// file reader and the edit server own. How the page draws and moves it is
// test/travel-render.mjs's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGroups, orderItem } from '../tools/build-groups.mjs';
import { editConnector, setElementBuildAttrs, TRAVEL_MS, ARRIVALS } from '../cli/edit.mjs';
import { staticFindings, buildClicks, emptyBuildClick, parseTree } from '../cli/check.mjs';
import { arrivalOf, travelMsOf, ARRIVALS as RUNTIME_ARRIVALS, TRAVEL_MS as RUNTIME_TRAVEL_MS } from '../src/core/travel.js';

// ── data-build-with: a step that arrives with the one before it ────────────

test('data-build-with: the step arrives on the click of the step before it', () => {
  const items = [orderItem(null, 0), orderItem(null, 1), orderItem(null, 2, true), orderItem(null, 3)];
  assert.deepEqual(computeGroups(items), [[0], [1, 2], [3]]);
});

test('data-build-with: a run of them all join the first; an explicit key of its own wins', () => {
  assert.deepEqual(computeGroups([orderItem(null, 0), orderItem(null, 1, true), orderItem(null, 2, true)]), [[0, 1, 2]]);
  // its own key: it plays there, the bare attribute is not read
  assert.deepEqual(computeGroups([orderItem(null, 0), orderItem('9', 1, true), orderItem(null, 2)]), [[0], [2], [1]]);
  // the first step of a slide has nothing before it: a click of its own
  assert.deepEqual(computeGroups([orderItem(null, 0, true), orderItem(null, 1)]), [[0], [1]]);
});

test('data-build-with: joins a step that plays on an explicit key, wherever that key plays', () => {
  const items = [orderItem('5', 0), orderItem(null, 1, true), orderItem(null, 2)];
  // auto 2 plays before key 5; the joined step goes with key 5
  assert.deepEqual(computeGroups(items), [[2], [0, 1]]);
});

// ── the runtime's reading of a step ────────────────────────────────────────

const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs });

test('a token arrives fade unless it says stay or pulse; its pace is clamped to what the server writes', () => {
  assert.deepEqual(RUNTIME_ARRIVALS, ARRIVALS);
  assert.deepEqual({ ...RUNTIME_TRAVEL_MS }, { ...TRAVEL_MS });
  assert.equal(arrivalOf(el({})), 'fade');
  assert.equal(arrivalOf(el({ 'data-arrive': 'pulse' })), 'pulse');
  assert.equal(arrivalOf(el({ 'data-arrive': 'zoom' })), 'fade');
  assert.equal(travelMsOf(el({})), null);
  assert.equal(travelMsOf(el({ 'data-travel-ms': '900' })), 900);
  assert.equal(travelMsOf(el({ 'data-travel-ms': '5' })), TRAVEL_MS.min);
  assert.equal(travelMsOf(el({ 'data-travel-ms': 'soon' })), null);
});

// ── decklight check ─────────────────────────────────────────────────────────

const deck = (svg, notes = '') => `<!doctype html><html><body><div class="decklight">
<section><h2>Flow</h2>
<svg viewBox="0 0 400 100" data-static-ok>
  <rect data-node="orders" x="10" y="30" width="80" height="40"/>
  <rect data-node="agent" x="300" y="30" width="80" height="40"/>
  <line data-from="orders" data-to="agent" data-wire="orders-agent" x1="90" y1="50" x2="300" y2="50"/>
  ${svg}
</svg>${notes ? `<aside class="notes">${notes}</aside>` : ''}</section>
<section><h2>Other</h2><svg data-static-ok><line data-wire="elsewhere" x1="0" y1="0" x2="1" y2="1"/></svg></section>
</div></body></html>`;
const findings = (html, rule) => staticFindings(html, { exists: () => true }).filter((f) => f.rule === rule);
const svgOf = (steps) => `<svg viewBox="0 0 400 100"><line data-wire="w" x1="0" y1="0" x2="1" y2="1"/>${steps}</svg>`;

test('check: a data-along-wire naming no wire of its svg is a travel-wire warning; a named one is not', () => {
  assert.deepEqual(findings(deck('<g data-build="travel" data-along-wire="orders-agent"></g>'), 'travel-wire'), []);
  const lost = findings(deck('<g data-build="travel" data-along-wire="elsewhere"></g>'), 'travel-wire');
  assert.equal(lost.length, 1, 'elsewhere is a wire of another svg, not this one');
  assert.equal(lost[0].level, 'warn');
  assert.equal(lost[0].slide, 1);
  assert.match(lost[0].message, /data-along-wire="elsewhere"/);
  assert.match(lost[0].message, /orders-agent/, 'it names the wires the svg has');
});

test('check: travel steps count against the [click] beats, data-build-with on the click before, never a click of nothing', () => {
  const two = deck('<g data-build="travel" data-along-wire="orders-agent"></g><g data-build="travel" data-along-wire="orders-agent" data-build-with></g><g data-build="travel" data-along-wire="orders-agent"></g>',
    'Here. [click] One. [click] Two.');
  const steps = svgOf('<g data-build="travel" data-along-wire="w"></g><g data-build="travel" data-along-wire="w" data-build-with></g><g data-build="travel" data-along-wire="w"></g>');
  assert.equal(buildClicks(parseTree(steps)), 2);
  assert.equal(emptyBuildClick(parseTree(steps), steps), false, 'an empty <g> that sends a token is a click that shows something');
  const empty = svgOf('<g data-build></g>');
  assert.equal(emptyBuildClick(parseTree(empty), empty), true, 'an empty <g> that builds still is');
  assert.deepEqual(findings(two, 'clicks-vs-builds'), []);
  const short = deck('<g data-build="travel" data-along-wire="orders-agent"></g><g data-build="travel" data-along-wire="orders-agent"></g>', 'Here. [click] One.');
  assert.equal(findings(short, 'clicks-vs-builds').length, 1);
});

// ── the edit server ─────────────────────────────────────────────────────────

test('Send a token along it: the wire named, a travel step naming it appended to its svg', () => {
  const html = deck('').replace(' data-wire="orders-agent"', '');
  const out = editConnector(html, 1, 1, { op: 'token', wire: { path: [2], tag: 'line' } });
  assert.equal(out.named.wire, 'orders-agent');
  assert.match(out.wire.html, /data-wire="orders-agent"/);
  assert.equal(out.added.html, '<g data-build="travel" data-along-wire="orders-agent"></g>');
  assert.deepEqual(out.added.path, [3]);
  assert.ok(out.html.includes(out.added.html));
  // a wire already named keeps its name, and a second token is a second step
  const again = editConnector(out.html, 1, 1, { op: 'token', wire: { path: [2], tag: 'line' } });
  assert.equal(again.named.wire, 'orders-agent');
  assert.equal((again.html.match(/data-build="travel"/g) ?? []).length, 2);
  assert.throws(() => editConnector(html, 1, 1, { op: 'token', wire: { path: [0], tag: 'rect' } }), /not a wire/);
});

test('a token\'s pace, arrival and repeat are written where they stand; fade and the default pace are no attribute', () => {
  const html = deck('<g data-build="travel" data-along-wire="orders-agent"></g>');
  const set = setElementBuildAttrs(html, 1, 1, { path: [3], tag: 'g', travelMs: 600, arrive: 'pulse', repeat: true });
  assert.match(set, /<g data-build="travel" data-along-wire="orders-agent" data-travel-ms="600" data-arrive="pulse" data-travel-repeat><\/g>/);
  const back = setElementBuildAttrs(set, 1, 1, { path: [3], tag: 'g', travelMs: null, arrive: 'fade', repeat: false });
  assert.match(back, /<g data-build="travel" data-along-wire="orders-agent"><\/g>/);
  assert.throws(() => setElementBuildAttrs(html, 1, 1, { path: [3], tag: 'g', arrive: 'zoom' }), /arrives fade, stay, pulse/);
  assert.throws(() => setElementBuildAttrs(html, 1, 1, { path: [3], tag: 'g', travelMs: 50 }), /100 to 20000 ms/);
  assert.throws(() => setElementBuildAttrs(html, 1, 1, { path: [3], tag: 'g', repeat: 'yes' }), /true or false/);
});
