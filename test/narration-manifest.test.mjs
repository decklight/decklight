// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A narration track's manifest, shared by `decklight voiceover`, the deck's
// own recorder (#535) and `decklight video`'s freshness check (#536): one
// definition of the per-slide hash, one extraction of the notes it covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipKey } from '../tools/tts-cache.mjs';
import { createEngine } from '../tools/tts-engines.mjs';
import { manifestKey, manifestHash, legacyHash, entryMatches, staleSlides, slideTexts, priorSlideTexts, recorderManifest, markerPauses, BEAT_PAUSE_DEFAULT } from '../tools/narration-manifest.mjs';

const DECK = `<div class="decklight">
<section><h1>One</h1><aside class="notes"><p>Hello there.</p><p>⟨CLICK⟩</p><p>Second beat.</p></aside></section>
<section><h2>Two</h2></section>
<section data-hidden><h2>Hidden</h2><aside class="notes">never voiced</aside></section>
<section><h2>Four</h2><aside class="notes">Last words.</aside></section>
</div>`;

test('slideTexts reads each slide the way voiceover voices it — markers out, hidden and empty slides blank', () => {
  assert.deepEqual(slideTexts(DECK), ['Hello there. Second beat.', '', '', 'Last words.']);
});

test('manifestKey is clipKey with the engine object spelled out — piper, gemini, chirp, ElevenLabs agree', () => {
  const text = 'One sentence to key.';
  // piper's constructor probes for the binary; its key traits are what clipKey reads
  const piper = { name: 'piper', model: 'en_US-ryan-high', voiceIsFixed: true, stylable: false, synth: {} };
  assert.equal(manifestKey({ engine: 'piper', model: 'en_US-ryan-high', voice: 'ignored', style: 'warm' }, text),
    clipKey(piper, { voice: 'ignored', style: 'warm', text }), 'piper: the model is the voice, and no style');
  const gemini = createEngine({ engine: 'gemini', project: 'proj-123456', model: 'gemini-2.5-flash-tts' });
  assert.equal(manifestKey({ engine: 'gemini', model: 'gemini-2.5-flash-tts', voice: 'Kore', style: 'warm' }, text),
    clipKey(gemini, { voice: 'Kore', style: 'warm', text }), 'gemini: voice, model and the style it reads');
  const chirp = createEngine({ engine: 'chirp', project: 'proj-123456' });
  assert.equal(manifestKey({ engine: 'chirp', model: 'chirp3-hd', voice: 'Kore', style: 'warm' }, text),
    clipKey(chirp, { voice: 'Kore', style: 'warm', text }), 'chirp: no style channel');
  const eleven = createEngine({ engine: 'elevenlabs', model: 'eleven_v3', env: { ELEVENLABS_API_KEY: 'x' } });
  assert.equal(manifestKey({ engine: 'elevenlabs', model: 'eleven_v3', voice: 'Rachel', style: '[warm]' }, text),
    clipKey(eleven, { voice: 'Rachel', style: '[warm]', text }), 'eleven_v3 takes a style, other models do not');
  assert.notEqual(manifestHash({ engine: 'gemini', model: 'm', voice: 'Kore', style: 's' }, text),
    manifestHash({ engine: 'gemini', model: 'm', voice: 'Kore', style: 's' }, text + ' more'), 'the text moves the hash');
  assert.equal(manifestHash({ engine: 'piper', model: 'm', voice: 'v', style: 's' }, text).length, 16);
});

test('entryMatches: the current hash, the pre-model legacy hash for a header that predates it, and no hash at all', () => {
  const header = { engine: 'gemini', model: 'gemini-2.5-pro-tts', voice: 'Kore', style: 'warm' };
  const text = 'Notes as voiced.';
  assert.equal(entryMatches(header, { file: 'slide-01.m4a', hash: manifestHash(header, text) }, text), true);
  assert.equal(entryMatches(header, { file: 'slide-01.m4a', hash: manifestHash(header, text) }, text + ' edited'), false);
  const old = { engine: 'gemini', voice: 'Kore', style: 'warm' };   // no model: written before the field existed
  assert.equal(entryMatches(old, { hash: legacyHash(old, text) }, text), true, 'the migration voiceover honours');
  assert.equal(entryMatches(header, { hash: legacyHash(header, text) }, text), false, 'but not once the header carries a model');
  assert.equal(entryMatches(header, { file: 'slide-01.wav' }, 'anything'), true, 'a hand-recorded take carries no hash to disagree');
});

test('staleSlides names the slides voiced from other notes, within the range asked, and counts the hashless ones', () => {
  const header = { engine: 'piper', model: 'en_US-ryan-high', voice: 'en_US-ryan-high', style: '' };
  const texts = ['a', '', 'c', 'd'];
  const m = { ...header, slides: [
    { file: 'slide-01.m4a', hash: manifestHash(header, 'a') },
    null,
    { file: 'slide-03.m4a', hash: manifestHash(header, 'old c') },
    { file: 'slide-04.wav' },
  ] };
  assert.deepEqual(staleSlides(m, texts), { stale: [3], hashless: 1 });
  assert.deepEqual(staleSlides(m, texts, { from: 1, to: 2 }), { stale: [], hashless: 0 }, 'a ranged render checks only its range');
  assert.deepEqual(staleSlides(m, texts, { from: 3, to: 4 }), { stale: [3], hashless: 1 });
});

test('recorderManifest: the recorded slides hashed from the deck, beats named, the range’s silent slides null, the rest kept', () => {
  const header = { engine: 'mock', model: 'm1', voice: 'Alnilam', style: 'warm' };
  const texts = slideTexts(DECK);
  const first = recorderManifest({ prev: null, header, texts, range: { from: 1, to: 4 }, recorded: { 1: { segments: [1, 2] }, 4: { segments: [] } } });
  assert.equal(first.engine, 'mock');
  assert.equal(first.voice, 'Alnilam');
  assert.deepEqual(first.slides[0], { file: 'slide-01.wav', hash: manifestHash(header, texts[0]), segments: [{ file: 'slide-01-01.wav' }, { file: 'slide-01-02.wav' }] });
  assert.equal(first.slides[1], null, 'no notes, no file');
  assert.equal(first.slides[2], null, 'hidden');
  assert.deepEqual(first.slides[3], { file: 'slide-04.wav', hash: manifestHash(header, 'Last words.') });
  // a ranged re-record of slide 4 alone keeps slide 1's entry as it was
  const again = recorderManifest({ prev: first, header, texts, range: { from: 4, to: 4 }, recorded: { 4: { segments: [] } } });
  assert.deepEqual(again.slides[0], first.slides[0]);
  assert.equal(again.slides.length, 4);
  // …and a partial take (aborted after slide 1) is a valid manifest of one slide
  const partial = recorderManifest({ prev: null, header, texts, range: { from: 1, to: 4 }, recorded: { 1: { segments: [] } } });
  assert.deepEqual(partial.slides.map((s) => !!s), [true, false, false, false]);
});


// ── ⟨PAUSE⟩ is part of the take (#560) ─────────────────────────────────────

test('a ⟨PAUSE⟩ stays in the hashed text: a recording bakes it, so adding or moving one stales the slide', () => {
  const header = { engine: 'piper', model: 'en_US-ryan-high', voice: 'en_US-ryan-high', style: '' };
  const deck = (notes) => `<section><h1>A</h1><aside class="notes">${notes}</aside></section>`;
  const before = slideTexts(deck('<p>Look at this.</p><p>Now the rest.</p>'));
  assert.deepEqual(before, ['Look at this. Now the rest.'], 'no marker: the text every existing track was hashed over');
  const track = { ...header, slides: [{ file: 'slide-01.wav', hash: manifestHash(header, before[0]) }] };

  const added = slideTexts(deck('<p>Look at this.</p><p>⟨PAUSE⟩</p><p>Now the rest.</p>'));
  assert.deepEqual(added, ['Look at this. ⟨PAUSE⟩ Now the rest.']);
  assert.deepEqual(staleSlides(track, added).stale, [1], 'a take without the hold is not the deck\'s take');

  const moved = slideTexts(deck('<p>Look at ⟨PAUSE⟩ this.</p><p>Now the rest.</p>'));
  const fresh = { ...header, slides: [{ file: 'slide-01.wav', hash: manifestHash(header, added[0]) }] };
  assert.deepEqual(staleSlides(fresh, moved).stale, [1], 'the hold moved, so the audio did');
  assert.deepEqual(staleSlides(fresh, added).stale, [], 'and a take made with it is fresh');
});

// ── entities decode as the browser reads them ─────────────────────────────

test('a deck-recorded slide stamped over the old, undecoded reading stays fresh; a synthesized one is stale', () => {
  const header = { engine: 'piper', model: 'en_US-ryan-high', voice: 'en_US-ryan-high', style: '' };
  const html = '<section><h1>A</h1><aside class="notes"><p>One &mdash; two.</p><p>&#10216;CLICK&#10217;</p><p>Three.</p></aside></section>'
    + '<section><h1>B</h1><aside class="notes"><p>Plain.</p></aside></section>';
  const texts = slideTexts(html);
  const prior = priorSlideTexts(html);
  assert.deepEqual(texts, ['One — two. Three.', 'Plain.'], 'decoded, the marker a marker');
  assert.deepEqual(prior, ['One &mdash; two. &#10216;CLICK&#10217; Three.', 'Plain.'], 'what the file used to read');
  const slides = prior.map((t, i) => ({ file: `slide-0${i + 1}.wav`, hash: manifestHash(header, t) }));

  // the deck's recorder voiced the browser's reading all along: only its stamp is old
  const deckTrack = { ...header, recorder: 'deck', slides };
  assert.deepEqual(staleSlides(deckTrack, texts, null, prior).stale, []);
  assert.deepEqual(staleSlides(deckTrack, texts).stale, [1], 'without the old reading it would be flagged');
  // the synthesis core SPOKE the entity's name — flagging it is the fix
  assert.deepEqual(staleSlides({ ...header, slides }, texts, null, prior).stale, [1]);
});

test('a deck written only in the canonical markers hashes as it did; a [pause] that used to be spoken now holds', () => {
  const deck = (notes) => `<section><h1>A</h1><aside class="notes">${notes}</aside></section>`;
  assert.deepEqual(slideTexts(deck('<p>One. ⟨PAUSE⟩ Two.</p><p>⟨CLICK⟩</p><p>Three.</p>')), ['One. ⟨PAUSE⟩ Two. Three.']);
  assert.deepEqual(slideTexts(deck('<p>One. [pause] Two.</p><p>[click]</p><p>Three.</p>')), ['One. ⟨PAUSE⟩ Two. Three.'],
    'the same take: the spelling is not the audio');
});

test('markerPauses: two beat pauses — the slide\'s attribute, else the deck\'s narration.beatPause, else the default', () => {
  const cfg = (c) => `<script type="application/json" data-decklight-config>${JSON.stringify(c)}</script>`;
  const deck = (...sections) => sections.map((a) => `<section${a}><h1>x</h1></section>`).join('\n');
  assert.deepEqual(markerPauses(deck('', '')), [2 * BEAT_PAUSE_DEFAULT, 2 * BEAT_PAUSE_DEFAULT]);
  assert.deepEqual(markerPauses(deck(' data-narration-beat-pause="0.2"', ' data-narration-beat-pause="0"')), [0.4, 0],
    '"0" on a slide is no hold, as it is no beat pause');
  assert.deepEqual(markerPauses(deck('', ' data-narration-beat-pause="soon"') + cfg({ narration: { beatPause: 0.75 } })), [1.5, 1.5],
    'a typo falls through to the deck\'s value, never to silence');
  assert.deepEqual(markerPauses(deck('') + cfg({ narration: { beatPause: -1 } })), [2 * BEAT_PAUSE_DEFAULT]);
  // the attribute in a slide's CONTENT is not the slide's
  assert.deepEqual(markerPauses('<section><div data-narration-beat-pause="3"></div></section>'), [2 * BEAT_PAUSE_DEFAULT]);
});
