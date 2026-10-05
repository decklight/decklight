// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The colour picker's pure half (src/core/colorpicker.js): the RGB/HSB maths
// behind the Custom tab and the palette the Theme tab shows. The card itself
// is driven in a browser — test/engine.html, mode `colors`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsbToRgb, rgbToHsb, rgbToHex, hexToRgb, themePalette, PALETTE, systemPalette, tokenOf, fallbackValue } from '../src/core/colorpicker.js';

test('HSB and RGB agree on the corners and round-trip everywhere between', () => {
  assert.deepEqual(hsbToRgb(0, 100, 100), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsbToRgb(120, 100, 100), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hsbToRgb(240, 100, 50), { r: 0, g: 0, b: 128 });
  assert.deepEqual(hsbToRgb(360, 100, 100), hsbToRgb(0, 100, 100), 'the wheel closes');
  assert.deepEqual(hsbToRgb(200, 0, 50), { r: 128, g: 128, b: 128 }, 'no saturation is a grey, whatever the hue');
  assert.deepEqual(rgbToHsb({ r: 255, g: 179, b: 25 }), { h: 40, s: 90, v: 100 });
  assert.deepEqual(rgbToHsb({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });
  // whole-unit HSB is coarser than 8-bit RGB: a round trip lands within a step or two, never further
  for (const c of [{ r: 94, g: 230, b: 192 }, { r: 13, g: 27, b: 61 }, { r: 250, g: 250, b: 249 }, { r: 1, g: 2, b: 3 }]) {
    const { h, s, v } = rgbToHsb(c);
    const back = hsbToRgb(h, s, v);
    for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(back[k] - c[k]) <= 3, `${JSON.stringify(c)} → ${JSON.stringify(back)}`);
  }
});

test('hex is read the way people paste it and written one way', () => {
  assert.deepEqual(hexToRgb('#ffb319'), { r: 255, g: 179, b: 25 });
  assert.deepEqual(hexToRgb('FFB319'), { r: 255, g: 179, b: 25 }, 'no #, capitals');
  assert.deepEqual(hexToRgb(' #fa0 '), { r: 255, g: 170, b: 0 }, 'shorthand, stray spaces');
  for (const bad of ['', '#ffb31', 'red', '#ggg', '#ffb319ff', null]) assert.equal(hexToRgb(bad), null, String(bad));
  assert.equal(rgbToHex({ r: 255, g: 179, b: 25 }), '#ffb319');
  assert.equal(rgbToHex({ r: 300, g: -4, b: 7.6 }), '#ff0008', 'clamped and rounded');
});

test('a design system\'s palette: a group per design system and palette group, its own names, undefined tokens dropped', () => {
  const page = { '--acme-blue': ' #0056F9 ', '--acme-coral': '#ff6f61', '--acme-ink': '#14213d', '--solo-red': '#c00' };
  const read = (t) => page[t];
  const acme = { name: 'acme', title: 'Acme Brand', palette: [
    { group: 'Brand', label: 'Acme blue', token: '--acme-blue' },
    { group: 'Brand', label: 'Acme coral', token: '--acme-coral' },
    { group: 'Surfaces', label: 'Deep ink', token: '--acme-ink' },
    { group: 'Surfaces', label: 'Not on this page', token: '--acme-gone' },
    { group: 'Brand', label: 'Not a token', token: 'red; x' },
  ] };
  const solo = { name: 'solo', title: 'Solo', palette: [{ group: 'Only', label: 'Red', token: '--solo-red' }] };
  const groups = systemPalette([acme, solo], read);
  assert.deepEqual(groups.map((g) => [g.group, g.items.map((i) => `${i.label}=${i.value}`)]), [
    ['Acme Brand · Brand', ['Acme blue=#0056f9', 'Acme coral=#ff6f61']],
    ['Acme Brand · Surfaces', ['Deep ink=#14213d']],
    ['Solo', ['Red=#c00']],
  ], 'in the order the deck uses them; one group is headed by the title alone');
  assert.ok(groups.every((g) => g.fallback), 'every design-system pick carries a fallback');
  assert.deepEqual(systemPalette([{ name: 'x', title: 'X', palette: [{ group: 'G', label: 'L', token: '--gone' }] }], read), [], 'no empty group');
  assert.deepEqual(systemPalette([], read), [], 'no design system, nothing new');
  assert.deepEqual(systemPalette(undefined, read), []);
});

test('a design-system pick writes the token with what it is now as the fallback — and is recognised by the token', () => {
  assert.equal(fallbackValue('--acme-blue', { r: 0, g: 86, b: 249 }), 'var(--acme-blue, #0056f9)');
  assert.equal(fallbackValue('--acme-blue', null), 'var(--acme-blue)', 'no colour to fall back to, no fallback');
  assert.equal(tokenOf('var(--acme-blue, #0056f9)'), '--acme-blue');
  assert.equal(tokenOf('var(--acme-blue,#123)'), '--acme-blue', 'a stale fallback still marks its token');
  assert.equal(tokenOf(' var(--accent) '), '--accent');
  assert.equal(tokenOf('#0056f9'), null);
  assert.equal(tokenOf('var(--a, var(--b))'), null);
  // what the picker writes is what the edit server accepts
  const STYLE_VALUE = /^(?:var\(--[a-z][a-z0-9-]{0,40}(?:,\s?#[0-9a-f]{3,8})?\)|#[0-9a-f]{3,8})$/i;
  assert.match(fallbackValue('--acme-blue', { r: 255, g: 111, b: 97 }), STYLE_VALUE);
});

test('the palette names the primary, and a secondary only where the theme has one', () => {
  const theme = { '--accent': '#5EE6C0', '--link': '#8ecbff', '--fg': '#eef', '--d-fill-1': '#123', '--d-fill-2': '#234' };
  const groups = themePalette((t) => theme[t]);
  const flat = groups.flatMap((g) => g.items);
  assert.deepEqual(flat.slice(0, 2).map((i) => [i.label, i.token]), [['Primary', '--accent'], ['Secondary', '--link']]);
  assert.deepEqual(flat.map((i) => i.token), ['--accent', '--link', '--fg', '--d-fill-1', '--d-fill-2'], 'tokens the theme does not define are left out');
  assert.deepEqual(groups.map((g) => g.group), ['Theme', 'Diagram fills'], 'and so is a group with nothing in it');

  // links in the accent colour: one colour, one name
  const mono = themePalette((t) => ({ '--accent': '#5ee6c0', '--link': ' #5EE6C0 ' })[t]);
  assert.deepEqual(mono.flatMap((g) => g.items).map((i) => i.label), ['Primary']);

  // every row is a token this project's themes declare (SPEC THEMING) — a label with no token behind it is a dead swatch
  for (const it of PALETTE.flatMap((g) => g.items)) assert.match(it.token, /^--(accent|accent-contrast|link|heading-color|fg|muted|bg|bg-accent|block-bg|d-(fill-[1-6]|accent|text|muted|stroke))$/);
});
