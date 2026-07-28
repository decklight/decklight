// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMathSpans } from '../src/math/math.js';

// ---- findMathSpans: the DOM text-node scanner (HTML slides) ---------------

test('findMathSpans splits text around display and inline math', () => {
  assert.deepEqual(findMathSpans('a $$x$$ b \\(y\\) c'), [
    { type: 'text', value: 'a ' },
    { type: 'math', tex: 'x', display: true },
    { type: 'text', value: ' b ' },
    { type: 'math', tex: 'y', display: false },
    { type: 'text', value: ' c' },
  ]);
});

test('findMathSpans: \\$ unescapes to a literal dollar', () => {
  assert.deepEqual(findMathSpans('pay \\$5 now'), [{ type: 'text', value: 'pay $5 now' }]);
});

test('findMathSpans: escaped dollars never pair into a $$ opener', () => {
  assert.deepEqual(findMathSpans('\\$\\$not math\\$\\$'), [
    { type: 'text', value: '$$not math$$' },
  ]);
});

test('findMathSpans: single-$ prose is untouched', () => {
  assert.deepEqual(findMathSpans('$5 to $10'), [{ type: 'text', value: '$5 to $10' }]);
});

test('findMathSpans: unterminated delimiters stay text', () => {
  assert.deepEqual(findMathSpans('a $$ b \\( c'), [{ type: 'text', value: 'a $$ b \\( c' }]);
});

test('findMathSpans: escaped backslash does not open \\(', () => {
  assert.deepEqual(findMathSpans('a \\\\(paren) b'), [{ type: 'text', value: 'a \\\\(paren) b' }]);
});
