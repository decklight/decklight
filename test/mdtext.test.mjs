// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The agent panel shows what the agent said in the markdown it said it in
// (mdtext.js): **bold** bold, never with its asterisks, and never as markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineNodes, markdownNodes } from '../src/core/mdtext.js';

/** Just enough of a document to build nodes, and a serialiser to read them back. */
const doc = {
  createTextNode: (text) => ({ text }),
  createElement: (tag) => ({
    tag, kids: [], className: '', style: {},
    append(...n) { this.kids.push(...n); },
    set textContent(t) { this.kids = [{ text: t }]; },
  }),
};
const show = (nodes) => nodes.map((n) => (n.tag
  ? `<${n.tag}${n.className ? `.${n.className}` : ''}${n.href ? ` ${n.href}` : ''}>${show(n.kids)}</${n.tag}>`
  : n.text)).join('');
const inline = (t) => show(inlineNodes(t, doc));
const block = (t) => show(markdownNodes(t, doc));

test('bold, italic, code and strike are elements, their markers gone', () => {
  assert.equal(inline('made **slide 4** a split'), 'made <strong>slide 4</strong> a split');
  assert.equal(inline('__bold__ and *it* and _it_'), '<strong>bold</strong> and <em>it</em> and <em>it</em>');
  assert.equal(inline('set `data-layout` to ~~top~~ split'), 'set <code>data-layout</code> to <s>top</s> split');
  assert.equal(inline('**the `notes` aside**'), '<strong>the <code>notes</code> aside</strong>');
});

test('what only looks like a marker stays text', () => {
  assert.equal(inline('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(inline('snake_case_name'), 'snake_case_name');
  assert.equal(inline('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inline('an ** empty pair **'), 'an ** empty pair **');
});

test('markup in the answer is text, and only http(s) links are links', () => {
  // the deck the agent read may be someone else's: nothing becomes markup
  const nodes = inlineNodes('<img src=x onerror=alert(1)>', doc);
  assert.deepEqual(nodes, [{ text: '<img src=x onerror=alert(1)>' }]);
  assert.equal(inline('[docs](https://example.com/a)'), '<a https://example.com/a>docs</a>');
  assert.equal(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('headings, lists, fences and gaps are one block per line', () => {
  const out = block('## Done\n\n- moved **title**\n1. second\n```\na **b**\n```');
  assert.equal(out, '<div.md-h>Done</div><div.md-gap></div>'
    + '<div.md-li><span.md-mark>•</span>moved <strong>title</strong></div>'
    + '<div.md-li><span.md-mark>1.</span>second</div>'
    + '<pre.md-pre>a **b**</pre>');
});
