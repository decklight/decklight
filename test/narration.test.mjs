// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The voice-over hint's one decision: whether to show at all.
//
// The pill itself is three lines of DOM — the interesting part is the list of
// places it must NOT appear, because each one is a way of being wrong rather
// than merely redundant. That list is a pure function, so it is checked here;
// that the real pill mounts, reads right, and starts the voice when clicked is
// checked against a live deck in test/narration-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesSegments } from '../tools/deck-html.mjs';
import { pauseRuns, stripPauses, PAUSE_MARK, canonMarks, markTags, notesMarks, spoken } from '../tools/sentences.mjs';
import { BEAT_PAUSE_DEFAULT } from '../tools/narration-manifest.mjs';

import {
  hintApplies, pauseSeconds, pauseFor, sentencePauseFor, SENTENCE_PAUSE_S, BEAT_PAUSE_S, SLIDE_PAUSE_S, segmentFileIndex, narrationTracks, recordPlan, floatToPcm16,
  proposeTrack, parseVoiceQuery, voiceMatches,
  splitSentences, fmtTime, stitchWav, silencePcm, micWhy, notesSegsOf, notesPlain, stepPlan,
} from '../src/core/narration.js';

/** A deck that should show the hint — each case below spoils exactly one thing. */
const showing = { hasTracks: true };

test('a deck with a recorded track offers its voice', () => {
  assert.equal(hintApplies(showing), true);
});

test('a deck with no recorded track says nothing — there is nothing to press V for', () => {
  assert.equal(hintApplies({ ...showing, hasTracks: false }), false);
  assert.equal(hintApplies({}), false, 'and an empty context is not a deck with a voice');
});

test('the hint never appears where it would be wrong', () => {
  // print: the pill would be inked onto a page nobody can click
  assert.equal(hintApplies({ ...showing, printMode: true }), false, 'print');
  // embedded: the theme picker and slide finder boot real decks in iframes —
  // a hint in a 200px preview is chrome on top of chrome
  assert.equal(hintApplies({ ...showing, embedded: true }), false, 'embedded preview');
  // ?voiceover already starts the voice on the first gesture; telling the
  // viewer to press V is telling them to do what is about to happen anyway
  assert.equal(hintApplies({ ...showing, voiceover: true }), false, '?voiceover');
  // captions own the bottom-center corner, and a captions viewer has already
  // worked out that the deck talks
  assert.equal(hintApplies({ ...showing, captionsOn: true }), false, 'captions up');
  // and never over a voice that is already speaking
  assert.equal(hintApplies({ ...showing, narrating: true }), false, 'already narrating');
  // a render: every frame of a `decklight video` is a fresh load that has
  // never used the voice, and the pill was burned into all of them (#548)
  assert.equal(hintApplies({ ...showing, capture: true }), false, '?capture');
  // a URL that lands past the first build of the first slide is a talk in
  // progress, not a first view — onboarding's rule, and a video frame's shape
  assert.equal(hintApplies({ ...showing, openedMidTalk: true }), false, 'opened mid-talk');
});

test('once the voice has been used on a deck, the hint is done there', () => {
  assert.equal(hintApplies({ ...showing, used: true }), false);
});

// --- data-narration-pause: the finite sibling of data-narration="hold" --------

test('a slide asks for a beat in seconds, decimals included', () => {
  assert.equal(pauseSeconds('2'), 2);
  assert.equal(pauseSeconds('0.5'), 0.5);
});

test('anything that is not a positive number reads as no beat, silently', () => {
  // A timing hint is not worth breaking a deck over: a typo leaves the slide
  // behaving exactly as it did before the attribute existed.
  for (const raw of [undefined, null, '', '0', '-1', 'abc', 'NaN', {}]) {
    assert.equal(pauseSeconds(raw), 0, `${JSON.stringify(raw)} is not a beat`);
  }
});

// ── the tool↔runtime segment contract ─────────────────────────────────────
//
// Two functions split the same ⟨CLICK⟩ notes, differently, on purpose:
// `notesSegs` in the runtime keeps every part (segment k must line up with
// build step k) while `notesSegments` in tools/ drops the empties (it is naming
// files). So for `⟨CLICK⟩ A ⟨CLICK⟩ B` the runtime sees three segments and the
// disk holds two files.
//
// Nothing about that is visible when it goes wrong. The audio plays, the deck
// advances, and the wrong beat is spoken over the wrong build. These pin the
// mapping between them, and the last one runs the ACTUAL file-namer against the
// ACTUAL runtime mapper so the two cannot drift apart later.

test('segmentFileIndex numbers the segments that became files, 1-based', () => {
  assert.deepEqual(segmentFileIndex(['A', 'B']), [1, 2]);
  assert.deepEqual(segmentFileIndex(['A', 'B', 'C', 'D']), [1, 2, 3, 4]);
});

test('an empty segment takes no file, and does not consume a number', () => {
  // The whole bug in one assertion: a ⟨CLICK⟩ at the start of a note is
  // punctuation, so "A" is file 1 — not file 2, and not skipped.
  assert.deepEqual(segmentFileIndex(['', 'A', 'B']), [null, 1, 2]);
  assert.deepEqual(segmentFileIndex(['A', '', 'B']), [1, null, 2]);
  assert.deepEqual(segmentFileIndex(['', 'A', '', 'B', '']), [null, 1, null, 2, null]);
});

test('below two real segments there are no files at all', () => {
  // `notesSegments`'s own `parts.length > 1 ? parts : null`. null is the signal
  // to play the whole-slide recording, which is what the tool wrote.
  for (const segs of [['A'], ['', 'A'], ['', ''], [], null, undefined]) {
    assert.equal(segmentFileIndex(segs), null, JSON.stringify(segs));
  }
});

test('whitespace-only is empty, and the count survives normalisation', () => {
  assert.deepEqual(segmentFileIndex(['A', '   ', 'B']), [1, null, 2]);
  assert.deepEqual(segmentFileIndex([' A ', '\n B \n']), [1, 2]);
});

test('the runtime predicts the filenames the tool actually writes', () => {
  // The contract, executed rather than asserted from memory: `notesSegments` is
  // the function tools/voiceover.mjs names files with, and `segmentFileIndex`
  // is what the player resolves them by. Feed both the same notes — the tool
  // the HTML it reads from the file, the runtime the text a browser would give
  // it — and the file numbers must agree.
  const cases = [
    '<p>One.</p><p>⟨CLICK⟩</p><p>Two.</p>',
    '<p>⟨CLICK⟩</p><p>One.</p><p>⟨CLICK⟩</p><p>Two.</p>',
    '<p>One.</p><p>⟨CLICK⟩</p><p>⟨CLICK⟩</p><p>Two.</p>',
    '<p>One.</p><p>⟨CLICK⟩</p><p>Two.</p><p>⟨CLICK⟩</p><p>Three.</p>',
    '<p>Only one.</p>',
  ];
  for (const html of cases) {
    const files = notesSegments(html);                       // what the tool writes
    const text = html.replace(/<[^>]+>/g, '');               // what textContent gives
    const idx = segmentFileIndex(text.split('⟨CLICK⟩'));     // what the player resolves
    if (files === null) {
      assert.equal(idx, null, `${html}: the tool wrote no segment files but the player expects some`);
      continue;
    }
    const highest = Math.max(...idx.filter((n) => n !== null));
    assert.equal(highest, files.length,
      `${html}: the tool wrote ${files.length} files, the player would ask for ${highest}`);
    // and each numbered segment must carry the text the file was named for
    const spoken = idx.map((n, k) => (n === null ? null : text.split('⟨CLICK⟩')[k]
      .replace(/\s+/g, ' ').trim())).filter(Boolean);
    assert.deepEqual(spoken, files, `${html}: segment text does not match the file's text`);
  }
});

// ── recordPlan — what ⇧R actually captures, beat by beat ──────────────────

test('the recording plan is one beat per ⟨CLICK⟩ segment, filmed at its own build', () => {
  // Per SEGMENT, not per step: the files are per segment, and recording per
  // step would write two files for a three-beat slide and leave the third
  // missing — the whole track silently short by one on every such slide.
  assert.deepEqual(recordPlan(['One.', 'Two.', 'Three.'], 2), [
    { seg: 0, step: 0, file: 1, text: 'One.' },
    { seg: 1, step: 1, file: 2, text: 'Two.' },
    { seg: 2, step: 2, file: 3, text: 'Three.' },
  ]);
});

test('a beat past the slide\'s builds is still recorded — filmed on the last step', () => {
  // #350's shape: three beats, one build. There is nothing left to reveal, so
  // the surplus is read against the fully built slide — which is exactly where
  // playback chains it.
  assert.deepEqual(recordPlan(['One.', 'Two.', 'Three.'], 1).map((b) => [b.step, b.file]),
    [[0, 1], [1, 2], [1, 3]]);
});

test('an empty segment is a silent beat: nothing to read, and no file', () => {
  // `⟨CLICK⟩ A ⟨CLICK⟩ B` — the runtime sees three segments, the disk holds
  // two files, and the first has no words in it to read aloud.
  assert.deepEqual(recordPlan(['', 'A.', 'B.'], 2), [
    { seg: 1, step: 1, file: 1, text: 'A.' },
    { seg: 2, step: 2, file: 2, text: 'B.' },
  ]);
});

test('a slide the tool would not segment is ONE take, and says so with a null file', () => {
  // Below two beats there are no slide-NN-KK files anywhere in this toolchain
  // — voiceover.mjs gives up at the same threshold — so the recorder writes
  // slide-NN.wav and nothing else. `file: null` is that instruction.
  assert.deepEqual(recordPlan(['Only this.'], 0), [{ seg: 0, step: 0, file: null, text: 'Only this.' }]);
  // …including a slide with BUILDS but no ⟨CLICK⟩: one take, filmed at arrival,
  // which is where its whole-slide file plays back
  assert.deepEqual(recordPlan(['Only this.'], 4), [{ seg: 0, step: 0, file: null, text: 'Only this.' }]);
  // and the empty forms record nothing at all
  assert.deepEqual(recordPlan([], 0), []);
  assert.deepEqual(recordPlan(['', '  '], 1), []);
  assert.deepEqual(recordPlan(undefined, 0), []);
});

test('the plan reads the same whitespace the file numbering does', () => {
  // recordPlan and segmentFileIndex must normalise identically or the beat
  // being read aloud and the file it is written as come apart.
  const segs = ['  One.  ', '\n', ' Two. '];
  assert.deepEqual(recordPlan(segs, 1).map((b) => b.file), [1, 2]);
  assert.deepEqual(recordPlan(segs, 1).map((b) => b.text), ['One.', 'Two.']);
  assert.deepEqual(segmentFileIndex(segs), [1, null, 2]);
});

// ── proposeTrack — a track is a folder, named after the voice ─────────────

test('the voice names the folder, because that is what tells takes apart', () => {
  // A deck carries as many tracks as you have voices — four cloned ones, the
  // system voice, two takes of your own — and N is the switcher. A single
  // `voiceover` default meant recording a second voice erased the first, with
  // nothing said.
  assert.deepEqual(proposeTrack({ engine: 'elevenlabs', voice: 'Rachel' }, []),
    { dir: 'voices/rachel', label: 'Rachel · elevenlabs' });
  // punctuation and case are not folder names
  assert.equal(proposeTrack({ engine: 'say', voice: 'Daniel (Enhanced)' }, []).dir,
    'voices/daniel-enhanced');
  // your own voice has no voice NAME to borrow
  assert.deepEqual(proposeTrack({ mine: true }, []), { dir: 'voices/me', label: 'My voice' });
  // and a bridge that told us nothing still proposes something sayable
  assert.equal(proposeTrack({}, []).dir, 'voices/take');
});

test('a folder already holding audio is never silently written over', () => {
  // The next free suffix, not a refusal and not a clobber — and the label says
  // which take it is, because two rows reading "Rachel · elevenlabs" in the
  // picker are worse than none.
  assert.deepEqual(proposeTrack({ engine: 'elevenlabs', voice: 'Rachel' }, ['voices/rachel']),
    { dir: 'voices/rachel-2', label: 'Rachel · elevenlabs, take 2' });
  assert.equal(proposeTrack({ mine: true }, ['voices/me', 'voices/me-2']).dir, 'voices/me-3');
  // …and a folder that exists but is not in the way is not counted
  assert.equal(proposeTrack({ mine: true }, ['voices/rachel']).dir, 'voices/me');
});

// ── floatToPcm16 — the mic's samples in the format everything else reads ──

test('mic samples become 16-bit little-endian PCM, and a hot input does not wrap', () => {
  const pcm = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]));
  assert.equal(pcm.length, 10);
  const v = new DataView(pcm.buffer);
  const at = (i) => v.getInt16(i * 2, true);
  assert.equal(at(0), 0);
  assert.equal(at(1), 16384);
  assert.equal(at(2), -16384);
  // full scale, both signs — and NOT 32768, which is what a bare `s * 32768`
  // writes and an Int16 reads back as -32768: the loudest moment of a take
  // inverting into a click exactly where it is most audible
  assert.equal(at(3), 32767);
  assert.equal(at(4), -32768);
});

test('an overshooting sample is clamped, not wrapped', () => {
  // Web Audio nominally hands out -1..1 and genuinely does not: a hot mic or a
  // gain stage overshoots, and every sample past the rail must saturate.
  const v = new DataView(floatToPcm16(new Float32Array([2, -2, 1.0001, -1.0001])).buffer);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(i * 2, true)),
    [32767, -32768, 32767, -32768]);
});

// ── narrationTracks — the `ext` that never arrived ────────────────────────

test('the string form keeps ext and segments, not just the directory', () => {
  // `narration: { files: 'voiceover', ext: 'wav' }` is the line the ⇧V done
  // card prints and SPEC documents. It produced `{label, dir}` — no `ext` — so
  // the player went looking for slide-01.m4a and reported a missing file for a
  // recording that was sitting right there.
  assert.deepEqual(narrationTracks({ files: 'voiceover', ext: 'wav' }),
    [{ label: 'Narration', dir: 'voiceover', ext: 'wav' }]);
  assert.deepEqual(narrationTracks({ files: 'v', ext: 'wav', segments: true }),
    [{ label: 'Narration', dir: 'v', ext: 'wav', segments: true }]);
});

test('a plain string is still one plain track — no keys invented', () => {
  // A track object that carried `ext: undefined` would look like it had opted
  // in to something the deck never mentioned.
  assert.deepEqual(narrationTracks({ files: 'voiceover' }), [{ label: 'Narration', dir: 'voiceover' }]);
  assert.equal('ext' in narrationTracks({ files: 'voiceover' })[0], false);
});

test('the array form is passed through exactly as authored', () => {
  const authored = [{ label: 'Me', dir: 'mine', ext: 'wav' }, { label: 'TTS', dir: 'tts' }];
  assert.equal(narrationTracks({ files: authored }), authored);
});

test('no narration configured is no tracks, never a throw', () => {
  for (const cfg of [undefined, null, {}, { files: null }, { files: '' }]) {
    assert.deepEqual(narrationTracks(cfg), [], JSON.stringify(cfg));
  }
});

test('the breath between sentences: a default, overridable per deck and per slide — to zero', () => {
  assert.equal(SENTENCE_PAUSE_S, 0.25);
  assert.equal(sentencePauseFor(undefined, undefined), 0.25, 'nothing said → the default');
  assert.equal(sentencePauseFor(undefined, 0.5), 0.5, 'the deck config overrides');
  assert.equal(sentencePauseFor(undefined, 0), 0, '…and may switch it off');
  assert.equal(sentencePauseFor('1', 0.5), 1, 'the slide attribute outranks the deck');
  assert.equal(sentencePauseFor('0', 0.5), 0, 'an explicit "0" on the slide is zero, not absent');
  // a typo falls through to the next tier, never to silence: a mistyped
  // config costs the default breath, not the feature
  assert.equal(sentencePauseFor('lots', 0.5), 0.5);
  assert.equal(sentencePauseFor('', 'fast'), 0.25);
  assert.equal(sentencePauseFor('-1', -3), 0.25);
});

test('every pause resolves the same way: slide attribute › deck config › built-in default', () => {
  // the slide and beat holds default to nothing…
  assert.equal(pauseFor(undefined, undefined, 0), 0);
  // …a deck-wide `narration: { slidePause, beatPause }` gives every slide one…
  assert.equal(pauseFor(undefined, 1, 0), 1);
  assert.equal(pauseFor(undefined, 0.5, 0), 0.5);
  // …and a slide's own attribute outranks the deck — including to switch it OFF
  assert.equal(pauseFor('2', 1, 0), 2);
  assert.equal(pauseFor('0', 1, 0), 0, 'an explicit "0" on the slide is zero');
  // a typo at either tier falls through, never to silence
  assert.equal(pauseFor('soon', 1, 0), 1);
  assert.equal(pauseFor('', 'long', 0), 0);
  assert.equal(pauseFor('-2', -1, 0), 0);
  // the sentence pause is the same function with a non-zero default
  assert.equal(sentencePauseFor(undefined, undefined), SENTENCE_PAUSE_S);
});

test('the built-in rhythm: 0.25s between sentences, 0.5s between builds, 1s before the slide turns', () => {
  assert.equal(SENTENCE_PAUSE_S, 0.25);
  assert.equal(BEAT_PAUSE_S, 0.5);
  assert.equal(SLIDE_PAUSE_S, 1);
  // opt-OUT, not opt-in: a slide or a deck can still say zero
  assert.equal(pauseFor('0', undefined, SLIDE_PAUSE_S), 0);
  assert.equal(pauseFor(undefined, 0, BEAT_PAUSE_S), 0);
});

// ── the voice picker's filter ───────────────────────────────────────────────
// A say roster is ~184 names on a real Mac, most of them folded behind two
// shelves. The filter is how you find one; these are the queries somebody
// actually types.

// [name, locale] exactly as the bridge sends them (tools/tts-engines.mjs puts
// the locale in the flavor slot).
const ROSTER = [
  ['Amélie', 'fr_CA'], ['Thomas', 'fr_FR'], ['Aurelie', 'fr_FR'],
  ['Fred', 'en_US'], ['Frederik', 'da_DK'], ['Karen', 'en_AU'],
  ['Daniel', 'en_GB'], ['Ting-Ting', 'zh_CN'], ['Xander', 'nl_NL'],
];
const hits = (q) => ROSTER.filter(([n, l]) => voiceMatches(n, l, q)).map(([n]) => n);

test('a bare term matches the name OR the language, because both get typed', () => {
  // The whole point of the union: `fr` is what somebody hunting a French voice
  // types, and it must not come back with only Fred.
  assert.deepEqual(hits('fr'), ['Amélie', 'Thomas', 'Aurelie', 'Fred', 'Frederik']);
  assert.deepEqual(hits('kar'), ['Karen']);
  assert.deepEqual(hits('en'), ['Fred', 'Karen', 'Daniel'], 'Xander has no "en" in it, nor does nl_NL');
});

test('lang: drops the name half, and anchors', () => {
  assert.deepEqual(hits('lang:fr'), ['Amélie', 'Thomas', 'Aurelie'], 'Fred survived a language filter');
  assert.deepEqual(hits('lang:en'), ['Fred', 'Karen', 'Daniel']);
  assert.deepEqual(hits('lang:fr_ca'), ['Amélie'], 'a full locale should still work');
  // ANCHORED at the front, which is what stops a region answering for a
  // language: `us` is in en_US, but nobody means "the US language".
  assert.deepEqual(hits('lang:us'), [], 'a region matched as if it were a language');
  assert.deepEqual(hits('lang:cn'), [], 'zh_CN answered to its region');
  // A short prefix is still a legitimate prefix — nl_NL is a Dutch voice
  assert.deepEqual(hits('lang:n'), ['Xander']);
});

test('accents and case are not something anybody types', () => {
  assert.deepEqual(hits('amelie'), ['Amélie']);
  assert.deepEqual(hits('AMÉLIE'), ['Amélie']);
  assert.deepEqual(hits('ting'), ['Ting-Ting']);
  // `-` and `_` are the same separator, so fr-CA finds fr_CA
  assert.deepEqual(hits('lang:fr-ca'), ['Amélie']);
});

test('terms are ANDed, so a language and a name compose', () => {
  assert.deepEqual(hits('lang:fr am'), ['Amélie']);
  assert.deepEqual(hits('lang:fr zzz'), []);
  assert.deepEqual(hits('  lang:en   dan  '), ['Daniel'], 'stray whitespace changed the answer');
});

test('an empty filter keeps the whole roster, and so does a half-typed lang:', () => {
  assert.equal(hits('').length, ROSTER.length);
  assert.equal(hits('   ').length, ROSTER.length);
  // Mid-type: `lang:` alone must not empty the list under somebody's hands
  assert.equal(hits('lang:').length, ROSTER.length);
  assert.deepEqual(parseVoiceQuery('lang:'), []);
});

test('parseVoiceQuery says which kind of term each one is', () => {
  assert.deepEqual(parseVoiceQuery('fr'), [{ any: 'fr' }]);
  assert.deepEqual(parseVoiceQuery('lang:FR'), [{ lang: 'fr' }]);
  assert.deepEqual(parseVoiceQuery('lang:fr kar'), [{ lang: 'fr' }, { any: 'kar' }]);
});


// ── the pure core, lifted out of the closure so this file can reach it ───────

test('a sentence ends at . ! ? or …, and a closing quote stays on its sentence', () => {
  assert.deepEqual(splitSentences('One. Two! Three? Four…'), ['One.', 'Two!', 'Three?', 'Four…']);
  // the quote belongs to the sentence it closes, not to the next one's start
  assert.deepEqual(splitSentences('She said "go." Then left.'), ['She said "go."', 'Then left.']);
  assert.deepEqual(splitSentences('(Aside.) Back.'), ['(Aside.)', 'Back.']);
});

test('a trailing fragment with no terminator is still a sentence — the last words are spoken', () => {
  assert.deepEqual(splitSentences('First. and then some'), ['First.', 'and then some']);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(undefined), []);
  assert.deepEqual(splitSentences(null), []);
});

test('fmtTime reads as a person says it', () => {
  assert.equal(fmtTime(0), '0s');
  assert.equal(fmtTime(59_400), '59s');
  assert.equal(fmtTime(60_000), '1m00s');
  assert.equal(fmtTime(65_000), '1m05s');
  assert.equal(fmtTime(3_661_000), '61m01s');
});

test('stitchWav writes a 44-byte RIFF header every player agrees on', async () => {
  const rate = 24000;
  const a = new Uint8Array([1, 2, 3, 4]), b = new Uint8Array([5, 6]);
  const blob = stitchWav([a, b], rate);
  assert.equal(blob.type, 'audio/wav');
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.equal(buf.length, 44 + 6);
  const h = new DataView(buf.buffer);
  const tag = (o) => String.fromCharCode(...buf.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(h.getUint32(4, true), 36 + 6, 'RIFF size = 36 + data');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(h.getUint32(16, true), 16, 'fmt chunk length');
  assert.equal(h.getUint16(20, true), 1, 'PCM');
  assert.equal(h.getUint16(22, true), 1, 'mono');
  assert.equal(h.getUint32(24, true), rate);
  assert.equal(h.getUint32(28, true), rate * 2, 'byte rate = rate × 2 (16-bit mono)');
  assert.equal(h.getUint16(32, true), 2, 'block align');
  assert.equal(h.getUint16(34, true), 16, 'bits per sample');
  assert.equal(tag(36), 'data');
  assert.equal(h.getUint32(40, true), 6, 'data length');
  assert.deepEqual([...buf.slice(44)], [1, 2, 3, 4, 5, 6], 'chunks follow the header in order');
});

test('silencePcm is exactly `seconds` of 16-bit mono at `rate`, and it is silent', () => {
  const s = silencePcm(24000, 0.5);
  assert.equal(s.length, 2 * 12000);
  assert.ok(s.every((x) => x === 0));
  assert.equal(silencePcm(24000, 0).length, 0);
});

test('micWhy names the fix for each way a microphone refuses, and escapes the rest', () => {
  const panel = /V → Record this deck…/;
  assert.match(micWhy({ name: 'NotAllowedError' }), /blocked/);
  assert.match(micWhy({ name: 'NotAllowedError' }), panel);
  assert.match(micWhy({ name: 'SecurityError' }), /blocked/);
  assert.match(micWhy({ name: 'NotFoundError' }), /no microphone was found/);
  assert.match(micWhy({ name: 'OverconstrainedError' }), /no microphone was found/);
  assert.match(micWhy({ name: 'NotReadableError' }), /busy/);
  // an unknown error is quoted, and quoted SAFELY — this string lands in innerHTML
  const odd = micWhy({ name: 'WeirdError', message: '<img src=x onerror=alert(1)>' });
  assert.match(odd, /could not be opened/);
  assert.doesNotMatch(odd, /<img/, 'an error message reached the card as markup');
  assert.match(odd, /&lt;img/);
});

// ── notesSegsOf — the same notes, split once ──────────────────────────────
//
// Segmenting a slide's notes is a DOM read, a split and a whitespace pass per
// segment, and it is asked for on every slide change, on every build step, and
// once per sentence by the lookahead worker — for a list that is the same list
// it was the last time. The memo is validated by the notes' own text, so
// nothing has to remember to invalidate it.

// A stand-in `aside.notes`: what notesSegsOf reads — its markup, to validate
// the memo, and its child nodes, to walk. Text only; element children are
// built by hand where a test needs one.
const asideOf = (text) => ({
  set text(t) { this.innerHTML = t; this.childNodes = [{ nodeType: 3, data: t }]; },
  innerHTML: text, childNodes: [{ nodeType: 3, data: text }],
});
const el = (localName, ...childNodes) => ({ nodeType: 1, localName, childNodes });
const txt = (data) => ({ nodeType: 3, data });

test('the same notes are segmented once and handed back as the same list', () => {
  const aside = asideOf('One. ⟨CLICK⟩ Two.');
  const first = notesSegsOf(aside);
  assert.deepEqual(first, ['One.', 'Two.']);
  assert.equal(notesSegsOf(aside), first, 'notes that had not changed were split a second time');
});

test('notes rewritten under a live deck re-segment, with nobody telling the cache', () => {
  // The author server re-renders a slide in place, so the aside a running deck
  // holds can be handed new words at any moment. The markup IS the validity
  // check, which is exactly why the editor needs to know nothing about this.
  const aside = asideOf('One.');
  assert.deepEqual(notesSegsOf(aside), ['One.']);
  aside.text = 'One. ⟨CLICK⟩ Two.';
  const after = notesSegsOf(aside);
  assert.deepEqual(after, ['One.', 'Two.'], 'the deck would go on speaking the old notes');
  assert.equal(notesSegsOf(aside), after, 'and the new ones are memoized in their turn');
});

test('every part of the split is kept, and a slide with no notes is still one segment', () => {
  // Segment k narrates build step k, so an empty ⟨CLICK⟩ part is a silent
  // beat, not a nothing to drop — the difference from notesSegments in tools/.
  assert.deepEqual(notesSegsOf(asideOf(' ⟨CLICK⟩ A ⟨CLICK⟩ B ')), ['', 'A', 'B']);
  assert.deepEqual(notesSegsOf(asideOf('A\n\n  B')), ['A B'], 'whitespace collapses');
  assert.deepEqual(notesSegsOf(null), [''], 'a slide with no aside still has a step 0');
  assert.deepEqual(notesSegsOf(undefined), ['']);
});

// ── every spelling of a marker is the marker ──────────────────────────────

test('canonMarks: every spelling of pause, click and slow — any case, either bracket — is the canonical marker', () => {
  for (const w of ['[pause]', '[Pause]', '[PAUSE]', '<pause>', '<Pause>', '<PAUSE>', '&lt;pause&gt;', '⟨pause⟩', '[ pause ]', '<pause/>']) {
    assert.equal(canonMarks(`A. ${w} B.`), 'A. ⟨PAUSE⟩ B.', w);
  }
  for (const w of ['[click]', '[Click]', '[CLICK]', '<click>', '<Click>', '<CLICK>', '&lt;CLICK&gt;']) {
    assert.equal(canonMarks(`A. ${w} B.`), 'A. ⟨CLICK⟩ B.', w);
  }
  assert.equal(canonMarks('[slow]A[/slow] <SLOW>B</Slow> &lt;slow&gt;C&lt;/slow&gt;'), '⟨SLOW⟩A⟨/SLOW⟩ ⟨SLOW⟩B⟨/SLOW⟩ ⟨SLOW⟩C⟨/SLOW⟩');
  assert.equal(canonMarks('A [/pause] [/click] B'), 'A   B', 'a pause or a click has nothing to close');
});

test('canonMarks leaves everything else in brackets alone, and the canonical forms as they are', () => {
  const prose = 'See [1], the [ ] box, [data-mouth], <script>, [pauses] and [click here].';
  assert.equal(canonMarks(prose), prose);
  assert.equal(canonMarks('[pause>'), '[pause>', 'the brackets must pair');
  const canonical = 'One. ⟨PAUSE⟩ Two. ⟨CLICK⟩ Three.';
  assert.equal(canonMarks(canonical), canonical, 'a deck using only these reads — and hashes — as before');
});

test('markTags: marker elements in markup, as the parser sees them', () => {
  assert.equal(markTags('<p>One. <pause> Two. <click>Three.</click></p>'), '<p>One. ⟨PAUSE⟩ Two. ⟨CLICK⟩Three.</p>');
  assert.equal(markTags('<p>A <PAUSE></PAUSE> B <Click class="x">C</p>'), '<p>A ⟨PAUSE⟩ B ⟨CLICK⟩C</p>', 'any case, attributes and all');
  assert.equal(markTags('<p>A <slow>b c</slow> d.</p>'), '<p>A ⟨SLOW⟩b c⟨/SLOW⟩ d.</p>');
  assert.equal(markTags('<p>A <slow>b. C.</p><p>D.</p>'), '<p>A ⟨SLOW⟩b. C.⟨/SLOW⟩</p><p>D.</p>',
    'an unclosed <slow> ends where the parser ends it: its paragraph');
  assert.equal(markTags('<p>A <slow>b<p>C.'), '<p>A ⟨SLOW⟩b⟨/SLOW⟩<p>C.', 'a new paragraph closes the old one');
  assert.equal(markTags('A <slow>b'), 'A ⟨SLOW⟩b⟨/SLOW⟩', 'or the end of the notes');
  assert.equal(markTags('A </slow> <slow>b <slow>c</slow> d'), 'A  ⟨SLOW⟩b c⟨/SLOW⟩ d', 'a stray close and a nested opener are nothing');
  assert.equal(notesMarks('<p>A [pause] <click>B</p>'), '<p>A ⟨PAUSE⟩ ⟨CLICK⟩B</p>');
});

test('spoken: what is left of a text once the markers are gone', () => {
  assert.equal(spoken(' A ⟨PAUSE⟩ ⟨SLOW⟩b⟨/SLOW⟩  c '), 'A b c');
  assert.equal(spoken('⟨PAUSE⟩ ⟨SLOW⟩ ⟨/SLOW⟩'), '');
});

test('a person\'s spelling of a marker cuts, holds and slows like the canonical one', () => {
  assert.deepEqual(notesSegsOf(asideOf('One. [click] Two. [CLICK] Three. <Click> Four.')), ['One.', 'Two.', 'Three.', 'Four.']);
  assert.deepEqual(notesSegsOf(asideOf('Look. [pause] Now [Slow]slowly[/SLOW].')), ['Look. ⟨PAUSE⟩ Now ⟨SLOW⟩slowly⟨/SLOW⟩.'],
    'the editor reads these segments back: a ⟨SLOW⟩ it did not see would be deleted by the next save');
});

test('notesPlain reads a marker ELEMENT as its marker — textContent sees nothing there', () => {
  // `<p>One. <click>Two.</click></p>` as the parser builds it: an unclosed
  // <click> wraps the words after it, which stay words
  const aside = el('aside', el('p', txt('One. '), el('click', txt('Two. '), el('pause'), txt(' Three '), el('slow', txt('slowly')), txt('.'))));
  assert.equal(notesPlain(aside), 'One. ⟨CLICK⟩Two. ⟨PAUSE⟩ Three ⟨SLOW⟩slowly⟨/SLOW⟩.');
  assert.deepEqual(notesSegsOf(Object.assign(aside, { innerHTML: 'x' })), ['One.', 'Two. ⟨PAUSE⟩ Three ⟨SLOW⟩slowly⟨/SLOW⟩.']);
  assert.equal(notesPlain(el('aside', { nodeType: 8, data: 'a comment' }, txt('Said.'))), 'Said.', 'comments are not text, as in textContent');
});

test('a segment of nothing but markers has no take: it is not a file, and the recorder skips it', () => {
  assert.deepEqual(segmentFileIndex(['One.', '⟨SLOW⟩ ⟨/SLOW⟩', 'Two.']), [1, null, 2]);
});

// ── the live clip key carries the sentence (#537) ─────────────────────────
import { liveClipKey, textHash } from '../src/core/narration.js';

test('liveClipKey: the text decides the hit — an edited sentence misses, its neighbours and a re-spaced copy still hit', () => {
  const k = (text) => liveClipKey(3, 1, 0, text, 'Kore', 'warm');
  assert.equal(k('Hello there.'), k('Hello   there.'), 'whitespace is normalized, like the on-disk cache');
  assert.notEqual(k('Hello there.'), k('Hello here.'), 'a changed sentence is a different key');
  assert.notEqual(k('Hello there.'), liveClipKey(3, 1, 0, 'Hello there.', 'Puck', 'warm'), 'and so is a changed voice');
  assert.match(k('Hello there.'), /^3\|s1\|n0\|Kore\|warm\|t[0-9a-f]{8}$/, 'the position stays readable in a log');
  assert.equal(textHash(''), textHash(null), 'no text hashes the same way whatever it is called');
});


// ── ⟨PAUSE⟩: a let-it-sink-in hold inside a beat (#560) ─────────────────────

test('⟨PAUSE⟩ belongs to the words before it — between sentences, attached, or on its own', () => {
  const between = { lead: 0, runs: [{ text: 'One.', pause: 1 }, { text: 'Two.', pause: 0 }] };
  assert.deepEqual(pauseRuns('One. ⟨PAUSE⟩ Two.'), between);
  assert.deepEqual(pauseRuns('One.⟨PAUSE⟩ Two.'), between);   // attached to the end of a sentence
  assert.deepEqual(pauseRuns('One. ⟨PAUSE⟩Two.'), between);   // or to the start of the next
  assert.deepEqual(pauseRuns('One.\n\n⟨PAUSE⟩\n\nTwo.'), between);   // or a paragraph of its own
});

test('⟨PAUSE⟩ repeated holds that many times; one before any word holds first; one mid-sentence cuts it', () => {
  assert.deepEqual(pauseRuns('One. ⟨PAUSE⟩ ⟨PAUSE⟩ Two.').runs[0].pause, 2);
  assert.deepEqual(pauseRuns('⟨PAUSE⟩ One.'), { lead: 1, runs: [{ text: 'One.', pause: 0 }] });
  assert.deepEqual(pauseRuns('One. ⟨PAUSE⟩'), { lead: 0, runs: [{ text: 'One.', pause: 1 }] });
  assert.deepEqual(pauseRuns('It was ⟨PAUSE⟩ enormous.').runs.map((r) => r.text), ['It was', 'enormous.']);
  assert.deepEqual(pauseRuns('⟨PAUSE⟩'), { lead: 1, runs: [] });
  assert.deepEqual(pauseRuns('No marker at all.'), { lead: 0, runs: [{ text: 'No marker at all.', pause: 0 }] });
});

test('⟨PAUSE⟩ is never a word: stripped, it leaves only the text around it', () => {
  assert.equal(stripPauses(`Wait. ${PAUSE_MARK} Now.`).replace(/\s+/g, ' '), 'Wait. Now.');
  assert.equal(stripPauses(null), '');
});

test('a step says its sentences and counts its holds — no sentence ever contains the marker', () => {
  const p = stepPlan(['Hello there. ⟨PAUSE⟩ It is big.⟨PAUSE⟩⟨PAUSE⟩', '⟨PAUSE⟩ Next one.']);
  assert.deepEqual(p.sentences, ['Hello there.', 'It is big.', 'Next one.']);
  assert.ok(p.sentences.every((s) => !s.includes('⟨')));
  assert.deepEqual(p.after, [1, 2, 0]);
  // leading the second segment: held AFTER that build lands, before its words
  assert.deepEqual(p.before, [0, 0, 1]);
  assert.deepEqual([...p.segStarts], [0, 2]);
  assert.deepEqual(p.segRuns, [{ seg: 0, from: 0, count: 2 }, { seg: 1, from: 2, count: 1 }]);
  assert.equal(p.bare, 0);
});

test('a hold before or after the ⟨CLICK⟩ lands on its own side of the build', () => {
  // A. ⟨PAUSE⟩ ⟨CLICK⟩ B. — hold, then reveal: the pause ends beat 0
  assert.deepEqual(stepPlan(['A. ⟨PAUSE⟩ ']).after, [1]);
  // A. ⟨CLICK⟩ ⟨PAUSE⟩ B. — reveal, then hold: the pause opens beat 1
  assert.deepEqual(stepPlan([' ⟨PAUSE⟩ B.']).before, [1]);
});

test('a beat of nothing but ⟨PAUSE⟩ is a bare hold — or, folded behind words, holds after them', () => {
  assert.deepEqual(stepPlan(['⟨PAUSE⟩']), { sentences: [], segStarts: new Set(), segRuns: [], before: [], after: [], bare: 1 });
  // the last step folds every remaining segment: the lone marker follows "A."
  const folded = stepPlan(['A.', '⟨PAUSE⟩']);
  assert.deepEqual(folded.after, [1]);
  assert.equal(folded.bare, 0);
});

test('a notes text with no marker plans exactly as it did before markers existed', () => {
  const p = stepPlan(['One. Two.', '', 'Three.']);
  assert.deepEqual(p.sentences, ['One.', 'Two.', 'Three.']);
  assert.deepEqual([...p.before, ...p.after], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...p.segStarts], [0, 2]);
});

test('a beat of nothing but ⟨PAUSE⟩ has no take — no file number, no recording, on either side', () => {
  const notes = 'A. ⟨CLICK⟩ ⟨PAUSE⟩ ⟨CLICK⟩ B.';
  const segs = notes.split('⟨CLICK⟩');
  assert.deepEqual(segmentFileIndex(segs), [1, null, 2]);
  assert.deepEqual(notesSegments(notes, { pauses: true }), ['A.', 'B.']);
  assert.deepEqual(recordPlan(segs, 2).map((b) => b.file), [1, 2]);
  // a reader is shown the marker — it is their cue to hold
  assert.equal(recordPlan(['A. ⟨PAUSE⟩ B.', 'C.'], 1)[0].text, 'A. ⟨PAUSE⟩ B.');
});

test('the CLI\'s beat pause is the runtime\'s — a hold that drifted would pace a render off the deck', () => {
  assert.equal(BEAT_PAUSE_DEFAULT, BEAT_PAUSE_S);
});
