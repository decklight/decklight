// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The speaker view's state object (SPEC PRESENTING). The popup itself is a
// document.write'n window — not something node can open — but the state it
// renders from is a pure function of the instance, so that much is testable
// here. Covers the ⟨CLICK⟩ segmentation and the phone-remote QR (#39), which
// must be offered only when a remote is actually running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakerState, notesSegments } from '../src/core/speaker.js';

// A deck stripped to what speakerState reads. `_sections: []` keeps it free of
// the DOM: the optional chain on the missing section yields no notes aside,
// which is exactly the "slide without notes" case.
const fakeDeck = (over = {}) => ({
  state: { slide: 1, step: 0, totalSlides: 3 },
  _records: [{ groups: [] }, { groups: [] }, { groups: [] }],
  _sections: [],
  _stepLabels: () => [],
  ...over,
});

test('notesSegments splits on the CLICK marker', () => {
  assert.deepEqual(notesSegments(''), ['']);
  assert.deepEqual(notesSegments('<p>one</p>'), ['<p>one</p>']);
  const two = notesSegments('<p>one</p>⟨CLICK⟩<p>two</p>');
  assert.equal(two.length, 2);
  assert.match(two[1], /two/);
});

test('notesSegments cuts where narration cuts, on every spelling, and shows a hold as a cue', () => {
  assert.equal(notesSegments('<p>one</p>[click]<p>two</p><click></click><p>three</p>&lt;CLICK&gt;<p>four</p>').length, 4);
  const [seg] = notesSegments('<p>Look. [pause] Now <slow>slowly</slow>.</p>');
  assert.match(seg, /Look\. <span class="cue">PAUSE<\/span> Now <span class="cue tag">slow<\/span>slowly\./,
    'an old <slow> is the [slow] tag, shown like any other');
});

test('an audio tag shows as a cue — direction to read, not words to say — and [1] stays prose', () => {
  const [seg] = notesSegments('<p>[whispers] Here it is. See [1]. [long pause]</p>');
  assert.match(seg, /<span class="cue tag">whispers<\/span> Here it is\. See \[1\]\./);
  assert.equal(seg.match(/<span class="cue">PAUSE<\/span>/g)?.length, 2, '[long pause] is two holds');
});

test('the QR is offered only when a remote is actually running', () => {
  // no dev server, or a dev server started without --remote
  assert.equal(speakerState(fakeDeck(), 'deck.html').qr, null);
  assert.equal(speakerState(fakeDeck({ __remoteQr: null }), 'deck.html').qr, null);

  const url = 'http://192.168.1.4:8788/deck/remote/qr.svg';
  assert.equal(speakerState(fakeDeck({ __remoteQr: url }), 'deck.html').qr, url);
});

test('state carries the position the popup renders from', () => {
  const st = speakerState(fakeDeck(), 'deck.html');
  assert.equal(st.slide, 1);
  assert.equal(st.totalSlides, 3);
  assert.equal(st.url, 'deck.html');
  // nothing to step through on this slide → the next hash is the next slide
  assert.equal(st.nextHash, '/2/0');
});

test('the last slide points its next-hash at itself, not past the deck', () => {
  const st = speakerState(fakeDeck({ state: { slide: 3, step: 0, totalSlides: 3 } }), 'd');
  assert.equal(st.nextHash, '/3/0');
});

test('the transcript is read in the speaker view, not in a card over the slides', async () => {
  // Notes had four places to be read; the transcript card over the deck was
  // the one a presenter cannot use while presenting (ROADMAP section 3). The
  // popup's script view is built from source text, so these are source checks;
  // the view itself is driven in a real browser.
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(`../src/core/${f}`, import.meta.url), 'utf8');
  const speaker = src('speaker.js');
  assert.match(speaker, /<button id="script"/, 'the speaker view has a script button');
  assert.match(speaker, /window\.__decklightSpeakerScript = /, 'the deck can turn the script view on');
  assert.match(speaker, /transcript: \(\) => instance\.transcript\?\.data\?\.\(\)/, 'the bridge carries the transcript');
  assert.match(speaker, /goto: \(n\) => instance\.goto\(n, 0/, 'and a slide to go to from it');
  assert.doesNotMatch(src('hud.js'), /decklight-transcript/, 'the card over the slides is gone');
  assert.match(src('engine.js'), /label: 'Download the transcript \(\.md\)'/, 'export needs no second window');
});
