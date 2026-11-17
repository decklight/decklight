// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A figure's count (SPEC DECK_ANATOMY, src/core/figure.js): the number inside
// a value read as written, and every value on the way to it written the same
// way, its prefix, suffix, decimals and separators kept. What the browser does
// with it (the clamp, the count on arrival, print and the overview) is
// test/figure-render.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFigure, formatFigure, countFrom, figureChars } from '../src/core/figure.js';

const at = (text, v) => formatFigure(parseFigure(text), v);

test('a value is read as written: what comes before and after the number, its decimals and its separators', () => {
  assert.deepEqual(parseFigure('94%'), { before: '', after: '%', value: 94, decimals: 0, point: null, group: null, sign: '' });
  assert.deepEqual(parseFigure('$1.2M'), { before: '$', after: 'M', value: 1.2, decimals: 1, point: '.', group: null, sign: '' });
  assert.deepEqual(parseFigure('3×'), { before: '', after: '×', value: 3, decimals: 0, point: null, group: null, sign: '' });
  assert.deepEqual(parseFigure('1,500'), { before: '', after: '', value: 1500, decimals: 0, point: null, group: ',', sign: '' });
  assert.equal(parseFigure('12,500,000').value, 12500000);
  assert.equal(parseFigure('1,5').value, 1.5, 'a comma not followed by three digits is a decimal comma');
  assert.equal(parseFigure('1,5').point, ',');
  const eu = parseFigure('1.500,25 €');
  assert.deepEqual([eu.value, eu.point, eu.group, eu.decimals, eu.after], [1500.25, ',', '.', 2, ' €'], 'with both, the last is the decimal point');
  assert.deepEqual([parseFigure('1 500').value, parseFigure('1 500').group], [1500, ' ']);
  assert.deepEqual([parseFigure('-12.5%').value, parseFigure('−3').sign], [-12.5, '−']);
  assert.equal(parseFigure('+40%').before, '+', 'a plus sign is the prefix');
  assert.equal(parseFigure('no number'), null);
});

test('a value on its way is written as the value is: decimals, separators, prefix and suffix kept', () => {
  assert.equal(at('94%', 0), '0%');
  assert.equal(at('94%', 47.4), '47%');
  assert.equal(at('$1.2M', 0), '$0.0M');
  assert.equal(at('$1.2M', 0.6), '$0.6M');
  assert.equal(at('3×', 1.5), '2×');
  assert.equal(at('1,500', 750), '750');
  assert.equal(at('1,500', 1234.4), '1,234');
  assert.equal(at('12,500,000', 1500000), '1,500,000');
  assert.equal(at('1.500,25 €', 1234.5), '1.234,50 €');
  assert.equal(at('-12.5%', -6.25), '-6.3%');
  assert.equal(at('−3', -1), '−1', 'the sign as written');
  assert.equal(at('-3', -0.2), '0', 'nothing below the shown decimals is negative');
  // the end of a count is the value exactly as it was written
  for (const v of ['94%', '$1.2M', '3×', '1,500', '12,500,000', '1.500,25 €', '-12.5%']) assert.equal(at(v, parseFigure(v).value), v);
});

test('a count starts from data-count-from, a plain number, else 0', () => {
  assert.equal(countFrom(null), 0);
  assert.equal(countFrom(''), 0);
  assert.equal(countFrom('50'), 50);
  assert.equal(countFrom('1.5'), 1.5);
  assert.equal(countFrom('-3'), -3);
  assert.equal(countFrom('1,000'), 1000);
  assert.equal(countFrom('fifty'), 0);
});

test('a value is as long as what a reader sees, for the clamp to its column', () => {
  assert.equal(figureChars('94%'), 3);
  assert.equal(figureChars('  $1.2M \n'), 5);
  assert.equal(figureChars('3×'), 2);
  assert.equal(figureChars(''), 1, 'never zero: the clamp divides by it');
});
