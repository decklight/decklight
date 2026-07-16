// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMath, restoreMath, findMathSpans } from '../src/math/math.js';
import { renderMarkdownSlide } from '../src/md/markdown.js';

// ---- extractMath: pull math out before marked can mangle it ---------------

test('extractMath pulls display and inline spans into placeholders', () => {
  const { text, spans } = extractMath('before $$E = mc^2$$ mid \\(\\alpha\\) after');
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0], { tex: 'E = mc^2', display: true });
  assert.deepEqual(spans[1], { tex: '\\alpha', display: false });
  assert.doesNotMatch(text, /mc\^2|\\alpha/);
  assert.match(text, /^before 0 mid 1 after$/);
});

test('extractMath: display math spanning lines is one span', () => {
  const { text, spans } = extractMath('p\n\n$$\n\\sum_{i=1}^n i\n$$\n\nq');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].tex, '\n\\sum_{i=1}^n i\n');
  assert.equal(text, 'p\n\n0\n\nq');
});

test('extractMath: fenced code blocks are immune', () => {
  const md = 'text\n\n```sh\necho $$ and \\(x\\)\n$$not math$$\n```\n\n$$real$$';
  const { text, spans } = extractMath(md);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].tex, 'real');
  assert.match(text, /echo \$\$ and \\\(x\\\)\n\$\$not math\$\$/);
});

test('extractMath: ~~~ fences and longer closing runs count too', () => {
  const { spans } = extractMath('~~~\n$$x$$\n~~~~\n');
  assert.equal(spans.length, 0);
});

test('extractMath: inline code spans are immune', () => {
  const { text, spans } = extractMath('use `$$PID$$` then $$x$$');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].tex, 'x');
  assert.match(text, /`\$\$PID\$\$`/);
});

test('extractMath: \\$ stays for marked to unescape, never opens math', () => {
  const { text, spans } = extractMath('pay \\$5 and \\$10, not math');
  assert.equal(spans.length, 0);
  assert.equal(text, 'pay \\$5 and \\$10, not math');
});

test('extractMath: single-$ is deliberately not a delimiter', () => {
  const { text, spans } = extractMath('between $5 and $10 of $x$');
  assert.equal(spans.length, 0);
  assert.equal(text, 'between $5 and $10 of $x$');
});

test('extractMath: unterminated $$ is left as text', () => {
  const { text, spans } = extractMath('a lone $$ marker');
  assert.equal(spans.length, 0);
  assert.equal(text, 'a lone $$ marker');
});

// ---- restoreMath: placeholders → MathML ------------------------------------

test('restoreMath renders spans to MathML at their placeholder', () => {
  const { text, spans } = extractMath('$$E = mc^2$$ and \\(\\alpha\\)');
  const html = restoreMath(`<p>${text}</p>`, spans);
  assert.match(html, /<math display="block"[^>]*><mrow><mi>E<\/mi>/);
  assert.match(html, /<math><mi>α<\/mi><\/math>/);
  assert.doesNotMatch(html, /[]/);
});

test('restoreMath: a TeX parse error renders visibly instead of throwing', () => {
  const html = restoreMath('<p>0</p>', [{ tex: '\\frac{', display: false }]);
  assert.match(html, /temml-error/);
});

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

// ---- the markdown pipeline end to end --------------------------------------

test('renderMarkdownSlide with math: TeX underscores never become emphasis', () => {
  const { html } = renderMarkdownSlide('## T\n\n\\(a_i\\) and \\(b_j\\) in one line', { math: true });
  assert.doesNotMatch(html, /<em>/);
  assert.equal((html.match(/<math/g) || []).length, 2);
});

test('renderMarkdownSlide with math: display block renders in its paragraph', () => {
  const { html } = renderMarkdownSlide('$$E = mc^2$$', { math: true });
  assert.match(html, /<p><math display="block"/);
});

test('renderMarkdownSlide with math: fenced code keeps its dollars as text', () => {
  const { html } = renderMarkdownSlide('```sh\necho $$x$$\n```\n\n$$y$$', { math: true });
  assert.match(html, /echo \$\$x\$\$/);
  assert.equal((html.match(/<math/g) || []).length, 1);
});

test('renderMarkdownSlide without math: dollars pass through untouched', () => {
  const { html } = renderMarkdownSlide('$$E = mc^2$$');
  assert.doesNotMatch(html, /<math/);
  assert.match(html, /\$\$E = mc\^2\$\$/);
});
