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

import {
  hintApplies, pauseSeconds, pauseFor, sentencePauseFor, SENTENCE_PAUSE_S, BEAT_PAUSE_S, SLIDE_PAUSE_S, segmentFileIndex, narrationTracks, recordPlan, floatToPcm16,
  proposeTrack,
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
