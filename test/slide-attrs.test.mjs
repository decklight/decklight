// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A slide's own settings, written on its <section> tag (setSlideAttrs, the
// inspector's Slide tab, PRESENTING_EDITING): each in its place, its quote
// kept, every other byte of the deck untouched, and anything the vocabulary
// does not list refused before a byte is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSlideAttrs, SLIDE_ATTR_NAMES } from '../cli/edit.mjs';
import { ATTRIBUTES } from '../tools/vocabulary.mjs';
import { ATTRIBUTE_DOCS } from '../cli/vocabulary-docs.mjs';
import { SLIDE_FIELDS, TRANSITIONS, parseClock, clockText, writeFor, fieldValue } from '../src/core/slide-settings.js';

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section class='intro' data-transition='fade'>
      <h2>One</h2>
    </section>
    <section
      data-layout="centered"
      data-pin="120">
      <h2>Two</h2>
    </section>
  </div>
</body></html>
`;

const tagOf = (html, n) => html.match(/<section\b[^>]*>/g)[n - 1];

test('a value is written where the attribute stands, its quote kept, or added last', () => {
  const out = setSlideAttrs(DECK, 1, { 'data-transition': 'flip', 'data-module': 'Words' });
  assert.equal(tagOf(out, 1), `<section class='intro' data-transition='flip' data-module="Words">`);
  assert.equal(out.replace(tagOf(out, 1), ''), DECK.replace(tagOf(DECK, 1), ''), 'every other byte of the deck is the same');
});

test('a tag over several lines keeps its lines; null takes one off with the space before it', () => {
  const out = setSlideAttrs(DECK, 2, { 'data-pin': 'none' });
  assert.equal(tagOf(out, 2), '<section\n      data-layout="centered"\n      data-pin="none">');
  assert.equal(tagOf(setSlideAttrs(DECK, 2, { 'data-pin': null }), 2), '<section\n      data-layout="centered">');
  assert.equal(setSlideAttrs(DECK, 2, { 'data-module': null }), DECK, 'taking off what is not there changes nothing');
});

test('true writes it bare, in place of a value it had', () => {
  assert.equal(tagOf(setSlideAttrs(DECK, 2, { 'data-pin': true }), 2), '<section\n      data-layout="centered"\n      data-pin>');
  const morph = setSlideAttrs(DECK, 1, { 'data-auto-animate': true });
  assert.equal(tagOf(morph, 1), `<section class='intro' data-transition='fade' data-auto-animate>`);
  assert.equal(setSlideAttrs(morph, 1, { 'data-auto-animate': true }), morph, 'the same again changes nothing');
});

test('a chapter name is text, escaped the one way every attribute is', () => {
  const out = setSlideAttrs(DECK, 1, { 'data-module': 'Q&A: "the end"' });
  assert.match(tagOf(out, 1), / data-module="Q&amp;A: &quot;the end&quot;">$/);
  for (const bad of ['', ' padded ', 'two\nlines', 'x'.repeat(121)]) {
    assert.throws(() => setSlideAttrs(DECK, 1, { 'data-module': bad }), /not a value data-module takes/, JSON.stringify(bad));
  }
});

test('each value is the one shape its attribute takes', () => {
  const ok = {
    'data-transition': ['none', 'fade', 'slide', 'scale', 'flip'],
    'data-timing': ['1', '90', '3600'],
    'data-pin': [true, 'none', '120', '99.5'],
    'data-background-size': ['cover', 'contain'],
    'data-background-position': ['center', 'top left', '50% 20%'],
    'data-background-dim': ['0', '0.4', '1'],
    'data-background-video': ['media/loop.mp4'],
    'data-narration-pause': ['0.5', '2'],
    'data-video-hold': ['12'],
  };
  for (const [name, values] of Object.entries(ok)) for (const v of values) assert.doesNotThrow(() => setSlideAttrs(DECK, 1, { [name]: v }), `${name}=${v}`);
  const bad = {
    'data-transition': ['spin', true, 3],
    'data-timing': ['0', '-1', '1.5', 'soon', true],
    'data-pin': ['top', '-4'],
    'data-background-size': ['50%'],
    'data-background-position': ['center; color: red', 'middle'],
    'data-background-dim': ['1.5', '-0.1', '40%'],
    'data-background-video': ['https://x.invalid/a.mp4', '/abs.mp4', '../up.mp4'],
    'data-auto-animate': ['yes', ''],
    'data-narration-pause': ['61'],
  };
  for (const [name, values] of Object.entries(bad)) {
    for (const v of values) assert.throws(() => setSlideAttrs(DECK, 1, { [name]: v }), /not a value/, `${name}=${JSON.stringify(v)}`);
  }
});

test('a name it does not write is refused, and a refusal writes nothing at all', () => {
  for (const name of ['data-layout', 'data-template', 'data-hidden', 'data-background-image', 'data-face', 'class', 'onclick', '__proto__']) {
    assert.throws(() => setSlideAttrs(DECK, 1, { [name]: 'x' }), /not a slide attribute this server writes/, name);
  }
  assert.throws(() => setSlideAttrs(DECK, 1, { 'data-transition': 'flip', 'data-timing': 'soon' }), /not a value/,
    'one bad value in a set refuses the whole set');
  assert.throws(() => setSlideAttrs(DECK, 1, {}), /bad set/);
  assert.throws(() => setSlideAttrs(DECK, 3, { 'data-transition': 'flip' }), /no slide 3/);
});

test('every name it writes is a slide attribute the vocabulary lists', () => {
  const listed = new Set(ATTRIBUTES.map((a) => a.name));
  for (const name of SLIDE_ATTR_NAMES) {
    assert.ok(listed.has(name), `${name} is not in ATTRIBUTES`);
    assert.match(ATTRIBUTE_DOCS[name]?.on ?? '', /\bsection\b/, `${name} is not documented as a slide's`);
  }
});

// ── the Slide tab's side: src/ cannot import cli/, so this holds them together

test('every field of the Slide tab writes an attribute the server writes, or goes through its own route', () => {
  for (const f of SLIDE_FIELDS) {
    if (f.route === 'hidden') { assert.equal(f.attr, 'data-hidden'); continue; }
    assert.ok(SLIDE_ATTR_NAMES.includes(f.attr), `${f.attr} is not in the server's allow-list`);
  }
  const vocab = ATTRIBUTES.find((a) => a.name === 'data-transition').values;
  assert.deepEqual(TRANSITIONS, vocab, 'the transitions offered are the ones the vocabulary lists');
});

test('a planned time is typed as m:ss or seconds, and stored in whole seconds', () => {
  assert.equal(parseClock('1:30'), 90);
  assert.equal(parseClock(' 0:45 '), 45);
  assert.equal(parseClock('90'), 90);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('0:00'), null, 'no time is no time');
  for (const bad of ['soon', '1:5', '1:60', '-3', '1.5', '1:30:00']) assert.ok(Number.isNaN(parseClock(bad)), bad);
  assert.equal(clockText(90), '1:30');
  assert.equal(clockText(605), '10:05');
});

test('what a field\'s input writes: the value, null for empty or the deck\'s, nothing when unchanged, words when wrong', () => {
  const by = Object.fromEntries(SLIDE_FIELDS.map((f) => [f.key, f]));
  assert.deepEqual(writeFor(by.transition, 'flip', ''), { set: { 'data-transition': 'flip' } });
  assert.deepEqual(writeFor(by.transition, '', 'flip'), { set: { 'data-transition': null } });
  assert.equal(writeFor(by.transition, 'flip', 'flip'), null);
  assert.match(writeFor(by.transition, 'spin', '').error, /not a transition/);
  assert.deepEqual(writeFor(by.timing, '2:00', '1:30'), { set: { 'data-timing': '120' } });
  assert.deepEqual(writeFor(by.timing, '', '1:30'), { set: { 'data-timing': null } });
  assert.equal(writeFor(by.timing, '90', '1:30'), null, 'the same time typed another way changes nothing');
  assert.match(writeFor(by.timing, 'soon', '').error, /m:ss/);
  assert.deepEqual(writeFor(by.chapter, '  Words ', ''), { set: { 'data-module': 'Words' } });
  assert.deepEqual(writeFor(by.chapter, '', 'Words'), { set: { 'data-module': null } });
  assert.match(writeFor(by.chapter, 'x'.repeat(121), '').error, /120/);
  assert.deepEqual(writeFor(by.hidden, true, false), { set: { 'data-hidden': true } });
  assert.equal(writeFor(by.hidden, true, true), null);
});

test('what a field reads off a slide', () => {
  const sec = (attrs) => ({ getAttribute: (n) => (Object.hasOwn(attrs, n) ? attrs[n] : null) });
  const by = Object.fromEntries(SLIDE_FIELDS.map((f) => [f.key, f]));
  assert.equal(fieldValue(sec({ 'data-timing': '75' }), by.timing), '1:15');
  assert.equal(fieldValue(sec({}), by.timing), '');
  assert.equal(fieldValue(sec({ 'data-transition': 'zoom' }), by.transition), '', 'a value the vocabulary does not list reads as the deck\'s');
  assert.equal(fieldValue(sec({ 'data-hidden': '' }), by.hidden), true);
  assert.equal(fieldValue(sec({ 'data-module': 'Words' }), by.chapter), 'Words');
});
