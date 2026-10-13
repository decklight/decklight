// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Fill roles as diagram slots (SPEC DESIGN_SYSTEM_ROLES, SVG_DIAGRAMS, #820):
// a design system whose contract maps a role to --d-fill-N makes that role
// slot N on its deck — nesting, concepts and Paste style read it as the slot,
// and what the engine paints for the slot is the role. Nesting itself needs
// layout, so the engine harness's `rolefills` mode covers it in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillRolesOf, setFillRoles, asSlotFill, slotPaint, conceptFill } from '../src/core/svg.js';
import { describeClip } from '../src/core/style-clip.js';
import { brandSnapper } from '../src/core/colorpicker.js';
import { packageVerdict, designSystemMeta } from '../cli/design-system-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');
const meta = () => ({ name: 'acme', ...designSystemMeta(packageVerdict(ROLES)) });

test('the fill roles are read off the contract: each diagram fill it maps, to the role token', () => {
  assert.deepEqual(fillRolesOf([meta()]), { '--d-fill-1': '--acme-color-surface-panel', '--d-fill-1-in': '--acme-color-surface-panel-in' },
    'the contract also maps --accent and --fg: those are no slot');
  assert.deepEqual(fillRolesOf([{ name: 'plain', palette: [] }]), {}, 'no contract, no fill roles');
  const other = { roles: [{ id: 'x', token: '--other-color-x' }], contract: { '--d-fill-1': 'x', '--d-fill-2': 'x' } };
  assert.deepEqual(fillRolesOf([meta(), other]), { '--d-fill-1': '--acme-color-surface-panel', '--d-fill-1-in': '--acme-color-surface-panel-in', '--d-fill-2': '--other-color-x' },
    'the first design system to map a fill keeps it');
});

test('a fill role reads as its slot, bare, with its hex or with the token behind it; anything else is left as written', (t) => {
  t.after(() => setFillRoles({}));
  setFillRoles(fillRolesOf([meta()]));
  assert.equal(asSlotFill('var(--acme-color-surface-panel)'), 'var(--d-fill-1)');
  assert.equal(asSlotFill(' var(--acme-color-surface-panel, #d0e6ff) '), 'var(--d-fill-1)');
  assert.equal(asSlotFill('var(--acme-color-surface-panel-in, var(--d-fill-1-in))'), 'var(--d-fill-1-in)');
  assert.equal(asSlotFill('var(--acme-color-surface-card)'), 'var(--acme-color-surface-card)', 'a role no fill maps to is not a slot');
  assert.equal(asSlotFill('var(--d-fill-2)'), 'var(--d-fill-2)');
  assert.equal(asSlotFill('var(--d-fill-in)'), 'var(--d-fill-in)', "my container's tone is a directive, not a colour");
  assert.equal(slotPaint('--d-fill-1-in'), 'var(--acme-color-surface-panel-in, var(--d-fill-1-in))', 'the nested tone is painted as its role');
  assert.equal(slotPaint('--d-fill-1-in2'), 'var(--d-fill-1-in2)', 'a tone no role is mapped to is the token, as before');
  assert.equal(slotPaint('--d-fill-3'), 'var(--d-fill-3)');
});

test('a concept pinned to a slot a role is mapped to is painted the role; without fill roles it is exactly as before', (t) => {
  t.after(() => setFillRoles({}));
  assert.equal(conceptFill('agent', { agent: 1 }), 'var(--d-fill-1)');
  setFillRoles(fillRolesOf([meta()]));
  assert.equal(conceptFill('agent', { agent: 1 }), 'var(--acme-color-surface-panel, var(--d-fill-1))');
  assert.equal(conceptFill('agent', { agent: 3 }), 'var(--d-fill-3)', 'a slot no role is mapped to is the token');
  assert.equal(conceptFill('agent', { agent: '#ff0000' }), '#ff0000', 'a custom colour is the custom colour');
  setFillRoles({});
  assert.equal(conceptFill('agent', { agent: 1 }), 'var(--d-fill-1)');
});

test('Paste style says a role-filled box is the slot it stands for', (t) => {
  t.after(() => setFillRoles({}));
  const clip = { what: 'rect', fill: { token: 'var(--acme-color-surface-panel, #d0e6ff)' } };
  assert.equal(describeClip(clip), 'box · acme-color-surface-panel');
  setFillRoles(fillRolesOf([meta()]));
  assert.equal(describeClip(clip), 'box · fill 1');
  assert.equal(describeClip({ what: 'rect', fill: { token: 'var(--d-fill-4)' } }), 'box · fill 4');
});

test('on a roles deck, Paste style puts a copied slot on the role the contract maps it to, not merely the nearest', (t) => {
  // the colour probe is a canvas: a 1×1 one that knows hex is all the snapper needs here
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => Object.assign(globalThis, saved));
  const ctx = {
    canvas: {}, _c: [0, 0, 0, 0], clearRect() {}, fillRect() {},
    set fillStyle(v) { const m = /^#([0-9a-f]{6})$/i.exec(String(v)); if (m) this._c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(255); },
    getImageData() { return { data: this._c }; },
  };
  globalThis.document = { createElement: () => ({ getContext: () => ctx }), querySelector: () => ({}), documentElement: {} };
  // what the page shows for --d-fill-1 on acme-light is nearer the Card role than the Panel one: the contract still wins
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => ({ '--d-fill-2': '#dce6f2' }[n] ?? '') });
  const snap = brandSnapper([meta()], 'acme-light');
  assert.ok(snap?.roles);
  const panel = meta().themes.find((x) => x.name === 'acme-light').roles['surface-panel'];
  assert.deepEqual(snap('var(--d-fill-1)'), { ref: 'Panel', value: `var(--acme-color-surface-panel, ${panel})`, role: true });
  assert.deepEqual(snap('var(--d-fill-1-in)'), { ref: 'Panel, nested', value: `var(--acme-color-surface-panel-in, ${meta().themes.find((x) => x.name === 'acme-light').roles['surface-panel-in']})`, role: true });
  assert.equal(snap('var(--d-fill-2)').ref, 'Card', 'a slot the contract does not map snaps to the nearest role, as before');
});
