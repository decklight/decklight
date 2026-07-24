// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// cli/qr.mjs — the zero-dependency QR encoder the phone remote (#39) renders
// its pairing code with. The matrix fixtures under test/fixtures/qr-*.txt are
// precomputed and locked: at generation time every one was decoded back to its
// source text by jsQR and matched module-for-module against the `qrcode` npm
// package (independent encoder) — neither is a dependency of this repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQR, qrSvg } from '../cli/qr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const fixture = (name) =>
  fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').trimEnd().split('\n');

const render = (matrix) => matrix.map((row) => row.map((d) => (d ? '#' : '.')).join(''));

const version = (matrix) => (matrix.length - 17) / 4;

test('matches the precomputed v1 matrix for "decklight"', () => {
  const m = encodeQR('decklight');
  assert.equal(version(m), 1);
  assert.deepEqual(render(m), fixture('qr-decklight.txt'));
});

test('matches the precomputed v3 matrix for a remote-control URL', () => {
  const m = encodeQR('http://192.168.1.23:8123/remote?t=k3XR9v');
  assert.equal(version(m), 3);
  assert.deepEqual(render(m), fixture('qr-remote-url.txt'));
});

test('matches the precomputed v10 matrix (16-bit count, version info, uneven blocks)', () => {
  const m = encodeQR('x'.repeat(231));
  assert.equal(version(m), 10);
  assert.deepEqual(render(m), fixture('qr-v10.txt'));
});

test('picks the smallest fitting version at each capacity boundary', () => {
  // byte-mode capacities at EC level L
  for (const [bytes, v] of [[17, 1], [18, 2], [32, 2], [33, 3], [53, 3], [54, 4], [230, 9], [231, 10], [271, 10]]) {
    assert.equal(version(encodeQR('x'.repeat(bytes))), v, `${bytes} bytes should be v${v}`);
  }
});

test('capacity is counted in UTF-8 bytes, not characters', () => {
  // 6 characters, but 3 bytes each — past v1's 17-byte capacity
  assert.equal(version(encodeQR('✓'.repeat(6))), 2);
});

test('throws a clear error when the text cannot fit v10 at level L', () => {
  assert.throws(() => encodeQR('x'.repeat(272)), /272 bytes.*version 10.*271/s);
});

test('throws on any EC level other than L', () => {
  assert.throws(() => encodeQR('hi', { ecLevel: 'M' }), /only implements level L/);
});

test('matrix is square with the three finder patterns and a timing pattern', () => {
  const m = encodeQR('hello');
  const size = m.length;
  for (const row of m) assert.equal(row.length, size);
  // finder centers dark, ring cells light, in all three corners
  for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    assert.equal(m[r][c], true);
    assert.equal(m[r - 2][c], false);
  }
  // timing row alternates between the separators
  for (let i = 8; i < size - 8; i++) assert.equal(m[6][i], i % 2 === 0);
});

test('qrSvg renders a self-contained SVG sized by viewBox, quiet zone included', () => {
  const svg = qrSvg('http://192.168.1.23:8123/remote?t=k3XR9v');
  const m = encodeQR('http://192.168.1.23:8123/remote?t=k3XR9v');
  const side = m.length + 8; // 4 quiet-zone modules per edge, the spec minimum
  assert.match(svg, new RegExp(`^<svg xmlns="http://www\\.w3\\.org/2000/svg" viewBox="0 0 ${side} ${side}"`));
  // no external references of any kind
  assert.doesNotMatch(svg, /url\(|href|<image|@import/);
  // background rect plus one 1×1 path cell per dark module
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  const cells = (svg.match(/h1v1h-1z/g) ?? []).length;
  const dark = m.flat().filter(Boolean).length;
  assert.equal(cells, dark);
});

test('qrSvg honors quiet zone and color options', () => {
  const svg = qrSvg('hi', { quiet: 2, dark: '#123', light: '#fed' });
  assert.match(svg, /viewBox="0 0 25 25"/); // v1 is 21 + 2×2
  assert.match(svg, /fill="#fed"/);
  assert.match(svg, /fill="#123"/);
  // first dark module (finder corner) starts at the quiet-zone offset
  assert.match(svg, /d="M2 2h1v1h-1z/);
});
