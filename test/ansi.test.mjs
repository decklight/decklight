// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnsiScreen, xterm256ToRgb, spansToHtml } from '../src/terminal/ansi.mjs';

function textOf(screen) {
  return screen.lines.map(spans => spans.map(s => s.text).join('')).join('\n');
}

test('plain text and newlines', () => {
  const s = new AnsiScreen();
  s.write('hello\r\nworld');
  assert.equal(textOf(s), 'hello\nworld');
});

test('SGR 16-color + bold parse into span styles', () => {
  const s = new AnsiScreen();
  s.write('\x1b[31mred\x1b[0m \x1b[1;32mboldgreen\x1b[0m');
  const spans = s.lines[0];
  assert.equal(spans[0].text, 'red');
  assert.deepEqual(spans[0].style.fg, { type: 'ansi', idx: 1 });
  const bg = spans.find(x => x.text === 'boldgreen');
  assert.equal(bg.style.bold, true);
  assert.deepEqual(bg.style.fg, { type: 'ansi', idx: 2 });
});

test('bright colors (90-97) map to indices 8-15', () => {
  const s = new AnsiScreen();
  s.write('\x1b[91mbright\x1b[0m');
  assert.deepEqual(s.lines[0][0].style.fg, { type: 'ansi', idx: 9 });
});

test('256-color and truecolor', () => {
  const s = new AnsiScreen();
  s.write('\x1b[38;5;208mo\x1b[0m\x1b[38;2;255;105;180mp\x1b[0m');
  const [a, b] = s.lines[0];
  assert.deepEqual(a.style.fg, { type: '256', idx: 208 });
  assert.deepEqual(b.style.fg, { type: 'rgb', r: 255, g: 105, b: 180 });
  // html serialization: 256 -> computed rgb inline, truecolor -> rgb inline
  const html = spansToHtml(s.lines[0]);
  const [r, g, bl] = xterm256ToRgb(208);
  assert.ok(html.includes(`rgb(${r},${g},${bl})`));
  assert.ok(html.includes('rgb(255,105,180)'));
});

test('carriage-return overwrite (progress bars)', () => {
  const s = new AnsiScreen();
  s.write('progress [##    ] 30%\rprogress [######] 99%\rdone.\x1b[K');
  assert.equal(textOf(s), 'done.');
});

test('EL variants', () => {
  const s = new AnsiScreen();
  s.write('abcdef\r\x1b[C\x1b[C\x1b[K'); // move to col 2, erase to end
  assert.equal(textOf(s), 'ab');
  const s2 = new AnsiScreen();
  s2.write('abcdef\r\x1b[2K');
  assert.equal(textOf(s2), '');
});

test('backspace and cursor-forward', () => {
  const s = new AnsiScreen();
  s.write('abX\bc'); // backspace over X, write c
  assert.equal(textOf(s), 'abc');
  const s2 = new AnsiScreen();
  s2.write('a\x1b[3Cb'); // a, skip 3, b — padding spaces
  assert.equal(textOf(s2), 'a   b');
});

test('tab advances to 8-column stops', () => {
  const s = new AnsiScreen();
  s.write('ab\tc');
  assert.equal(textOf(s), 'ab      c');
});

test('escape sequences never leak — unknown CSI, OSC, charset', () => {
  const s = new AnsiScreen();
  s.write('\x1b]0;window title\x07clean \x1b[2Jmid \x1b[?25l\x1b(Bend');
  assert.equal(textOf(s), 'clean mid end');
  assert.ok(!textOf(s).includes('\x1b'));
});

test('chunk-split escape sequences are buffered', () => {
  const s = new AnsiScreen();
  s.write('\x1b[3');
  s.write('1mred\x1b');
  s.write('[0m!');
  assert.equal(textOf(s), 'red!');
  assert.deepEqual(s.lines[0][0].style.fg, { type: 'ansi', idx: 1 });
});

test('inverse swaps fg/bg at serialization', () => {
  const s = new AnsiScreen();
  s.write('\x1b[7minv\x1b[0m');
  const html = spansToHtml(s.lines[0]);
  assert.ok(html.includes('ansi-inv-fg') && html.includes('ansi-inv-bg'));
  const s2 = new AnsiScreen();
  s2.write('\x1b[7;31;44mx\x1b[0m'); // red on blue, inverted -> blue fg, red bg
  const html2 = spansToHtml(s2.lines[0]);
  assert.ok(html2.includes('ansi-fg-4') && html2.includes('ansi-bg-1'));
});

test('html escaping of content', () => {
  const s = new AnsiScreen();
  s.write('<script>&');
  assert.equal(s.toHtml(), '&lt;script&gt;&amp;');
});

test('style state resets and partial resets', () => {
  const s = new AnsiScreen();
  s.write('\x1b[1;4;31mA\x1b[22mB\x1b[24mC\x1b[0mD');
  const [a, b, c, d] = s.lines[0];
  assert.ok(a.style.bold && a.style.underline);
  assert.ok(!b.style.bold && b.style.underline);
  assert.ok(!c.style.underline && c.style.fg);
  assert.ok(!d.style.fg && !d.style.bold);
});
