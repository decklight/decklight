// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Deck settings… written by the edit server (PRESENTING_EDITING): each key
// spliced in place into the way the deck carries its configuration (the
// block, or a bundle's init literal), a default taking the key off, the
// narration pauses nested, the page's <title>, and a deck whose configuration
// is code or elsewhere refused with one sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setDeckConfig, setDeckTitle, deckTitle, deckSettings, deckConfigSource, DECK_SETTINGS } from '../cli/runtime-link.mjs';
import { CONFIG_KEYS } from '../tools/vocabulary.mjs';

const data = (inner, title = '<title>Talk</title>') => `<!doctype html>
<html><head>
  ${title}
<script type="application/json" data-decklight-config>
${inner}
</script>
</head><body><div class="decklight"><section><h2>One</h2></section></div></body></html>`;
const inner = (html) => /data-decklight-config>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
const BLOCK = '{\n  "decklight": "0.10.0",\n  "theme": "aurora"\n}';

test('a setting is added after the other keys, replaced where it stands, and its default takes it off', () => {
  const html = data(BLOCK);
  const one = setDeckConfig(html, { slideNumber: 'n/N' });
  assert.equal(inner(one), '{\n  "decklight": "0.10.0",\n  "theme": "aurora",\n  "slideNumber": "n/N"\n}');
  assert.equal(one.replace(inner(one), ''), html.replace(inner(html), ''), 'nothing outside the block moves');
  const two = setDeckConfig(one, { slideNumber: 'n', controls: false });
  assert.equal(inner(two), '{\n  "decklight": "0.10.0",\n  "theme": "aurora",\n  "slideNumber": "n",\n  "controls": false\n}');
  const back = setDeckConfig(two, { slideNumber: false, controls: true });
  assert.equal(inner(back), BLOCK, 'back to the defaults: the file says nothing about them');
  assert.equal(setDeckConfig(back, { transition: 'fade' }), back, 'a default never written is no change');
  assert.equal(inner(setDeckConfig(html, { transition: null })), BLOCK);
});

test('the narration pauses nest under one key, which goes with its last pause', () => {
  const a = setDeckConfig(data(BLOCK), { 'narration.slidePause': 2 });
  assert.deepEqual(JSON.parse(inner(a)).narration, { slidePause: 2 });
  const b = setDeckConfig(a, { 'narration.beatPause': 0.75, 'narration.slidePause': 1.5 });
  assert.deepEqual(JSON.parse(inner(b)).narration, { slidePause: 1.5, beatPause: 0.75 });
  const c = setDeckConfig(b, { 'narration.slidePause': 1 });
  assert.deepEqual(JSON.parse(inner(c)).narration, { beatPause: 0.75 }, 'the default is off, the rest stays');
  const d = setDeckConfig(c, { 'narration.beatPause': null });
  assert.equal(inner(d), BLOCK, 'the last pause takes the narration key with it');
  // what else the author keeps under narration stays
  const own = data('{\n  "theme": "aurora",\n  "narration": { "voice": "ada", "beatPause": 1 }\n}');
  assert.deepEqual(JSON.parse(inner(setDeckConfig(own, { 'narration.beatPause': null }))).narration, { voice: 'ada' });
});

test('a logo is one object: pictures beside the deck, a height, a corner', () => {
  const logo = { onLight: 'brand/logo.svg', onDark: 'brand/logo-dark.svg', height: 28, position: 'top-right' };
  const out = setDeckConfig(data(BLOCK), { logo });
  assert.deepEqual(JSON.parse(inner(out)).logo, logo);
  assert.equal(inner(setDeckConfig(out, { logo: null })), BLOCK);
  for (const bad of [{}, { onLight: 'https://x.invalid/a.svg' }, { onLight: '../a.svg' }, { onLight: '#mark' }, { src: 'a.svg', height: 2 },
    { src: 'a.svg', position: 'middle' }, { src: 'a.svg', script: 'x' }, { onDark: '<svg onload=x>' }]) {
    assert.throws(() => setDeckConfig(data(BLOCK), { logo: bad }), /not a value logo takes/, JSON.stringify(bad));
  }
});

test('only the keys Deck settings offers, each in its shape', () => {
  for (const key of ['theme', 'width', 'height', 'hash', 'bleed', 'concepts', 'narration', '__proto__']) {
    assert.throws(() => setDeckConfig(data(BLOCK), { [key]: 1 }), /not a deck setting this server writes/, key);
  }
  for (const [key, v] of [['transition', 'spin'], ['slideNumber', true], ['slideNumber', 'N'], ['controls', 'yes'], ['pinTitles', -1], ['narration.slidePause', 61], ['narration.beatPause', '1']]) {
    assert.throws(() => setDeckConfig(data(BLOCK), { [key]: v }), /not a value/, `${key}=${JSON.stringify(v)}`);
  }
  assert.throws(() => setDeckConfig(data(BLOCK), {}), /bad set/);
  for (const key of Object.keys(DECK_SETTINGS)) assert.ok(CONFIG_KEYS.some((k) => k === key.split('.')[0] || k?.name === key.split('.')[0]), `${key} is in CONFIG_KEYS`);
});

test('a bundle\'s Decklight.init of plain data is rewritten in place; code or elsewhere is refused, with why', () => {
  const bundle = (arg) => `<!doctype html><html><head><title>B</title></head><body><div class="decklight"><section><h2>A</h2></section></div>
<script>
  Decklight.init(${arg});
</script></body></html>`;
  const out = setDeckConfig(bundle("{ theme: 'paper', transition: 'slide' }"), { transition: 'flip', slideNumber: 'n' });
  assert.match(out, /Decklight\.init\(\{ theme: 'paper', "transition": "flip", "slideNumber": "n" \}\);/);
  const code = bundle('{ theme: pick(), transition: "slide" }');
  assert.equal(setDeckConfig(code, { transition: 'flip' }), null);
  assert.match(deckConfigSource(code).why, /code, not plain data/);
  const elsewhere = '<!doctype html><html><head><title>E</title><script src="boot.js"></script></head><body><div class="decklight"></div></body></html>';
  assert.equal(setDeckConfig(elsewhere, { transition: 'flip' }), null);
  assert.match(deckConfigSource(elsewhere).why, /separate script/);
  const broken = data('{ "theme": ');
  assert.match(deckConfigSource(broken).why, /cannot be read/);
});

test('the page title: set in place, escaped, added to <head> when there is none', () => {
  const html = data(BLOCK);
  assert.equal(deckTitle(html), 'Talk');
  const out = setDeckTitle(html, 'Q&A <live>');
  assert.match(out, /<title>Q&amp;A &lt;live&gt;<\/title>/);
  assert.equal(deckTitle(out), 'Q&A <live>');
  assert.equal(out.replace(/<title>[^<]*<\/title>/, ''), html.replace(/<title>[^<]*<\/title>/, ''), 'nothing else moves');
  const none = setDeckTitle(data(BLOCK, ''), 'Fresh');
  assert.match(none, /<head>\n[ \t]*<title>Fresh<\/title>/, "on its own line, first in the head");
  assert.throws(() => setDeckTitle(html, 'two\nlines'), /one line/);
});

test('what the card reads: each value as the file says, the default where it says nothing, and whether it can write', () => {
  const s = deckSettings(setDeckConfig(data(BLOCK), { slideNumber: 'n', 'narration.beatPause': 0.75 }));
  assert.equal(s.title, 'Talk');
  assert.equal(s.editable, true);
  assert.equal(s.values.slideNumber, 'n');
  assert.equal(s.values.transition, 'fade');
  assert.equal(s.values.controls, true);
  assert.equal(s.values['narration.beatPause'], 0.75);
  assert.equal(s.values['narration.slidePause'], 1);
  assert.equal(s.values.logo, null);
  const ro = deckSettings('<html><head><title>E</title><script src="boot.js"></script></head><body></body></html>');
  assert.equal(ro.editable, false);
  assert.match(ro.why, /separate script/);
});
