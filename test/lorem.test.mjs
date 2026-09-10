// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Somebody else's slide with somebody else's words taken out (UNITS#REST).
// A template slide is taken for its shape; its words belong to the talk it was
// written for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loremize, loremRun, seeded } from '../tools/lorem.mjs';

const words = (s) => (s.match(/\S+/g) ?? []).length;

test('the words change and the count does not — a layout is only honest at its own length', () => {
  const src = '<h2>What is handled, what is yours</h2>';
  const out = loremize(src, seeded('t:1'));
  assert.notEqual(out, src);
  assert.equal(words(out), words(src));
  assert.match(out, /^<h2>.*<\/h2>$/, 'the markup is not touched');
});

test('markup, attributes and structure survive verbatim', () => {
  const src = '<section data-layout="split" class="cf-grid">'
    + '<ul><li><b>Automatic.</b> We run it</li></ul></section>';
  const out = loremize(src, seeded('t:1'));
  assert.match(out, /^<section data-layout="split" class="cf-grid"><ul><li><b>/);
  assert.match(out, /<\/b> \w+ \w+ \w+<\/li><\/ul><\/section>$/);
});

test('a code sample is structure, not prose', () => {
  const src = '<pre data-lines="1-2"><code>SELECT * FROM orders</code></pre><p>Ship it</p>';
  const out = loremize(src, seeded('t:1'));
  assert.match(out, /<code>SELECT \* FROM orders<\/code>/,
    'loremising a code block produces a slide that teaches nothing and no longer parses');
  assert.doesNotMatch(out, /<p>Ship it<\/p>/, 'but the prose beside it still goes');
});

test('a build beat in the notes is the clock, not a sentence', () => {
  const src = '<aside class="notes"><p>Say it.</p><p>\u27E8CLICK\u27E9</p><p>Then this.</p></aside>';
  const out = loremize(src, seeded('t:1'));
  assert.match(out, /<p>\u27E8CLICK\u27E9<\/p>/, 'replacing it would silently unpace every build');
  assert.doesNotMatch(out, /Say it/);
});

test('numbers, entities and punctuation are left doing their job', () => {
  const out = loremRun('We run it &mdash; 99.9% uptime, 24/7 \u2192 always', seeded('t:1'));
  for (const kept of ['&mdash;', '99.9%', '24/7', '\u2192']) {
    assert.ok(out.includes(kept), `${kept} should survive`);
  }
});

test('a placeholder keeps the shape of the word it replaces', () => {
  const out = loremRun('Automatic. SHOUTING lower', seeded('t:7'));
  const [a, b, c] = out.match(/\S+/g);
  assert.match(a, /^[A-Z][a-z]+\.$/, 'capitalised, and its full stop kept');
  assert.equal(b, b.toUpperCase(), 'an all-caps word stays all-caps');
  assert.equal(c, c.toLowerCase());
});

test('whitespace and indentation are preserved, so the diff stays readable', () => {
  const src = '<p>\n      one two three\n    </p>';
  const out = loremize(src, seeded('t:1'));
  assert.match(out, /^<p>\n {6}\S+ \S+ \S+\n {4}<\/p>$/);
});

test('the same slide loremises the same way twice — the preview IS what lands', () => {
  const src = '<h2>One claim, stated plainly</h2>';
  assert.equal(loremize(src, seeded('deck:8')), loremize(src, seeded('deck:8')));
  assert.notEqual(loremize(src, seeded('deck:8')), loremize(src, seeded('deck:9')));
});
