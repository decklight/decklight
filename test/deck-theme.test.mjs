// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck's theme, written the way the deck carries it (SPEC PRESENTING):
// the configuration block for a deck that is data, the active embedded theme
// for a bundle, the stylesheet link for a source deck — and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setDeckTheme, withConfigTheme, configTheme } from '../cli/runtime-link.mjs';

const data = (cfg) => `<!doctype html><html><head><title>T</title>
<script type="application/json" data-decklight-config>${cfg}</script>
</head><body><div class="decklight"><section><h2>One</h2></section></div></body></html>`;

test('a deck that is data: the block\'s theme is swapped in place, or added after the version', () => {
  const swapped = setDeckTheme(data('{ "decklight": "0.9.0", "theme": "aurora", "transition": "fade" }'), 'paper');
  assert.match(swapped, /\{ "decklight": "0.9.0", "theme": "paper", "transition": "fade" \}/, 'the value, and nothing else');
  assert.equal(configTheme(swapped), 'paper');
  const added = setDeckTheme(data('{ "decklight": "0.9.0" }'), 'paper');
  assert.match(added, /\{ "decklight": "0.9.0", "theme": "paper" \}/);
  const bare = withConfigTheme(data('{}'), 'ember');
  assert.match(bare, /\{ "theme": "ember" \}/);
});

test('a bundle: the chosen embedded theme is the active one, the rest are media="not all"', () => {
  const html = '<html><head>\n<style data-theme="aurora">a{}</style>\n<style data-theme="paper" media="not all">b{}</style>\n</head><body><div class="decklight"></div></body></html>';
  const out = setDeckTheme(html, 'paper');
  assert.match(out, /<style data-theme="aurora" media="not all">a\{\}/);
  assert.match(out, /<style data-theme="paper">b\{\}/);
  assert.equal(setDeckTheme(html, 'ember'), null, 'a theme the bundle does not embed cannot be chosen');
});

test('a source deck: the themes/<name>.css link is renamed', () => {
  const html = '<html><head><link rel="stylesheet" href="../themes/aurora.css"></head><body><div class="decklight"></div></body></html>';
  assert.match(setDeckTheme(html, 'paper'), /href="\.\.\/themes\/paper\.css"/);
});

test('a deck that carries its theme in none of those ways, or a bad name, is refused with null', () => {
  assert.equal(setDeckTheme('<html><body><div class="decklight"></div></body></html>', 'paper'), null);
  assert.equal(setDeckTheme(data('{ "theme": "aurora" }'), 'not a name'), null);
});
