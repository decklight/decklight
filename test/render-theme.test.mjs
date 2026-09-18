// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What a render is told about its theme (#547): the query parameters video,
// pptx and pdf put on the deck URL, and the values they refuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderThemeParams } from '../tools/render-theme.mjs';
import { printUrl } from '../cli/pdf.mjs';

test('a theme by name rides ?theme=, a generated one ?gen=, neither rides nothing', () => {
  assert.deepEqual(renderThemeParams({ theme: 'eclipse' }), ['theme=eclipse']);
  const gen = Buffer.from(JSON.stringify({ name: 'mine', tokens: { '--bg': '#123456' } })).toString('base64url');
  assert.deepEqual(renderThemeParams({ gen }), [`gen=${gen}`]);
  assert.deepEqual(renderThemeParams({}), []);
  assert.deepEqual(renderThemeParams(), []);
});

test('anything else is refused before a render starts', () => {
  assert.throws(() => renderThemeParams({ theme: '../eclipse' }), /theme name/);
  assert.throws(() => renderThemeParams({ theme: 'x'.repeat(65) }), /theme name/);
  assert.throws(() => renderThemeParams({ gen: 'has spaces' }), /base64url/);
  assert.throws(() => renderThemeParams({ gen: 'a'.repeat(16385) }), /16 KB/);
  assert.throws(() => renderThemeParams({ theme: 'eclipse', gen: 'abc' }), /not both/);
});

test('pdf prints with either, after its own ?print', () => {
  assert.equal(printUrl('http://127.0.0.1:1/d.html', { theme: 'eclipse' }), 'http://127.0.0.1:1/d.html?print&theme=eclipse');
  assert.equal(printUrl('http://127.0.0.1:1/d.html', { gen: 'abc_-', variant: 'notes' }), 'http://127.0.0.1:1/d.html?print=notes&gen=abc_-');
  assert.equal(printUrl('http://127.0.0.1:1/d.html'), 'http://127.0.0.1:1/d.html?print');
});
