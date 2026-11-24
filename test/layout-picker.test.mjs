// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The layout picker's model (SPEC PRESENTING_EDITING): which cells it shows,
// in what order, where focus starts, and what choosing one writes. The page
// half (drawing the variants, the preview on the stage) is driven in a real
// browser; this is the half that decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentChoice, pickerCells, builtinsShownAtOpen, pickerItems, initialFocus, writeFor, cellLabel } from '../src/core/layout-picker.js';

const RING = ['auto', 'centered', 'top', 'split', 'split-flip'];
const ACME = { name: 'acme', title: 'Acme Brand', templates: [{ id: 'section-divider', title: 'Section divider' }, { id: 'statement' }] };
const sec = (attrs = {}) => ({ getAttribute: (k) => attrs[k] ?? null });

test('currentChoice: a slide template, or the built-in layout (auto when it says none)', () => {
  assert.deepEqual(currentChoice(sec()), { template: '', layout: 'auto' });
  assert.deepEqual(currentChoice(sec({ 'data-layout': 'split' })), { template: '', layout: 'split' });
  assert.deepEqual(currentChoice(sec({ 'data-template': 'acme/statement' })), { template: 'acme/statement', layout: 'auto' });
});

test('a deck without a design system: the built-in layouts only, shown, focus on the current one', () => {
  const current = { template: '', layout: 'top' };
  const cells = pickerCells({ ring: RING, systems: [], current });
  assert.deepEqual(cells.templates, []);
  assert.equal(builtinsShownAtOpen({ systems: [], current: { template: '', layout: 'auto' } }), true);
  const items = pickerItems(cells, { hasSystems: false, shown: true });
  assert.deepEqual(items.map((c) => c.key), RING.map((n) => `l:${n}`), 'no More layouts toggle');
  assert.equal(items[initialFocus(items)].name, 'top');
});

test('a design-system deck: the templates first, the built-in layouts behind More layouts', () => {
  const current = { template: '', layout: 'auto' };
  const cells = pickerCells({ ring: RING, systems: [ACME], current });
  assert.equal(builtinsShownAtOpen({ systems: [ACME], current }), false, 'a plain auto slide opens on the brand');
  const items = pickerItems(cells, { hasSystems: true, shown: false });
  assert.deepEqual(items.map((c) => c.key), ['t:acme/section-divider', 't:acme/statement', 'more']);
  assert.equal(items[initialFocus(items)].ref, 'acme/section-divider', 'the current (auto) is out of sight: the first template');
  assert.equal(items[0].name, 'Section divider', 'a template\'s own title when it has one');
  assert.equal(items[1].name, 'statement', 'else its id');
  const open = pickerItems(cells, { hasSystems: true, shown: true });
  assert.deepEqual(open.slice(3).map((c) => c.name), RING, 'More layouts puts them after the toggle');
});

test('the current choice is always in sight: a slide on a built-in layout opens with them shown', () => {
  assert.equal(builtinsShownAtOpen({ systems: [ACME], current: { template: '', layout: 'split' } }), true);
  assert.equal(builtinsShownAtOpen({ systems: [ACME], current: { template: 'acme/statement', layout: 'auto' } }), false);
  const cells = pickerCells({ ring: RING, systems: [ACME], current: { template: 'acme/statement', layout: 'auto' } });
  const items = pickerItems(cells, { hasSystems: true, shown: false });
  assert.equal(items[initialFocus(items)].ref, 'acme/statement', 'a templated slide focuses its template');
});

test('writeFor: what choosing a cell writes', () => {
  const plain = { template: '', layout: 'auto' };
  const templated = { template: 'acme/statement', layout: 'auto' };
  const cellsP = pickerCells({ ring: RING, systems: [ACME], current: plain });
  const cellsT = pickerCells({ ring: RING, systems: [ACME], current: templated });
  const split = (cells) => cells.builtins.find((c) => c.name === 'split');
  assert.deepEqual(writeFor(split(cellsP), plain), { kind: 'layout', name: 'split' }, 'a plain slide: the quiet layout write');
  assert.equal(writeFor(cellsP.builtins.find((c) => c.name === 'auto'), plain), null, 'the current one writes nothing');
  assert.deepEqual(writeFor(cellsP.templates[0], plain), { kind: 'template', body: { template: 'acme/section-divider' } }, 'into a template');
  assert.deepEqual(writeFor(cellsT.templates[0], templated), { kind: 'template', body: { template: 'acme/section-divider' } }, 'to another');
  assert.equal(writeFor(cellsT.templates[1], templated), null);
  const leave = writeFor(split(cellsT), templated);
  assert.deepEqual(leave, { kind: 'leave', body: { template: null, layout: 'split' }, confirm: true }, 'leaving a template asks first, then is one write');
  assert.equal(split(cellsT).leaves, true);
  assert.equal(writeFor({ kind: 'more' }, plain), null, 'the toggle writes nothing');
});

test('cellLabel: what a screen reader hears', () => {
  const cells = pickerCells({ ring: RING, systems: [ACME], current: { template: 'acme/statement', layout: 'auto' } });
  assert.equal(cellLabel(cells.templates[1]), 'Acme Brand template statement, current');
  assert.equal(cellLabel(cells.builtins[3]), 'layout split, leaves the template');
  assert.equal(cellLabel({ kind: 'more', shown: false }), 'More layouts');
});
