// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// An edit that pulls a recording away from the deck that plays it — the
// warning that would have caught a "rewrite the voiceover" agent silently
// dropping the narration config on a deck with a recorded track.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordingImpact, hasImpact, impactWarning, slidesFromFiles } from '../tools/recording-impact.mjs';
import { configuredTrackDirs } from '../cli/edit.mjs';

// a deck factory: config + per-slide notes, the two halves an edit can part
const deck = (config, ...notes) =>
  `<script>Decklight.init(${config})</script>`
  + notes.map((n) => `<section><h2>x</h2><aside class="notes">${n}</aside></section>`).join('');

const CFG_ME = "{ narration: { files: [{ label: 'Mine', dir: 'voices/me', ext: 'wav', segments: true }] } }";

// most decks record a whole-slide file per slide; this stands in for the disk
const twoSlides = (dir) => (dir === 'voices/me' ? [1, 2] : []);

test('configuredTrackDirs reads the dirs a deck actually plays, and skips cloud', () => {
  assert.deepEqual(configuredTrackDirs(deck(CFG_ME, 'a', 'b')), ['voices/me']);
  assert.deepEqual(configuredTrackDirs(deck("{ narration: { files: 'voiceover' } }", 'a')), ['voiceover']);
  assert.deepEqual(configuredTrackDirs(deck(
    "{ narration: { files: [{ label: 'A', dir: 'voices/a' }, { label: 'Cloud', manifest: 'x.json' }, { label: 'B', dir: 'voices/b' }] } }", 'a')),
    ['voices/a', 'voices/b'], 'a manifest entry has no local dir');
  assert.deepEqual(configuredTrackDirs(deck('{}', 'a')), [], 'no narration → no dirs');
  assert.deepEqual(configuredTrackDirs(deck('cfg', 'a')), [], 'config built elsewhere → nothing to read');
});

test('slidesFromFiles reads the slide numbers off recorded filenames', () => {
  assert.deepEqual(slidesFromFiles(['slide-01.wav', 'slide-02-01.wav', 'slide-02-02.wav', 'slide-02.wav']),
    [1, 2], 'a slide and its beats are the same slide');
  assert.deepEqual(slidesFromFiles(['slide-07.m4a', 'notes.txt', 'slide-10.wav']), [7, 10]);
  assert.deepEqual(slidesFromFiles([]), []);
  assert.deepEqual(slidesFromFiles(['manifest.json', 'random.wav']), []);
});

test('dropping the config orphans the whole track — the bug this exists for', () => {
  const before = deck(CFG_ME, 'a', 'b');
  const after = deck('{}', 'a', 'b');   // the agent rewrote init and dropped narration
  const impact = recordingImpact(before, after, { dirsOf: configuredTrackDirs, recordedSlides: twoSlides });
  assert.deepEqual(impact.orphaned, [{ dir: 'voices/me', slides: 2 }]);
  assert.deepEqual(impact.stale, []);
  assert.deepEqual(impact.reshaped, []);
  assert.match(impactWarning(impact), /voices\/me \(2 recorded slides\) is no longer played/);
  assert.match(impactWarning(impact), /Z takes the edit back; the audio is still on disk/);
});

test('rewriting a recorded slide’s notes stales that slide, and only that slide', () => {
  const before = deck(CFG_ME, 'the original notes', 'slide two');
  const after = deck(CFG_ME, 'completely different words', 'slide two');
  const impact = recordingImpact(before, after, { dirsOf: configuredTrackDirs, recordedSlides: twoSlides });
  assert.deepEqual(impact.orphaned, []);
  assert.deepEqual(impact.stale, [{ dir: 'voices/me', slides: [1] }]);
  assert.match(impactWarning(impact), /the recording no longer matches the notes on slide 1\b/);
});

test('inserting a slide reshapes the track — every recording after it shifts', () => {
  const before = deck(CFG_ME, 'a', 'b');
  const after = deck(CFG_ME, 'a', 'a new slide', 'b');   // slide 2's audio now lands on the new slide
  const impact = recordingImpact(before, after, { dirsOf: configuredTrackDirs, recordedSlides: twoSlides });
  assert.deepEqual(impact.reshaped, [{ dir: 'voices/me', before: 2, after: 3 }]);
  assert.deepEqual(impact.stale, [], 'a count change is reported as a reshape, not per-slide noise');
  assert.match(impactWarning(impact), /no longer line up — the deck went from 2 slides to 3/);
});

test('an edit that leaves the recordings alone says nothing', () => {
  // notes on an UNrecorded slide change; the config is untouched
  const before = deck(CFG_ME, 'a', 'b');
  const after = deck(CFG_ME, 'a', 'b changed');   // slide 2 IS recorded here, so this WOULD warn…
  const onlySlideOne = () => [1];                  // …but if only slide 1 has audio, slide 2's edit is free
  const impact = recordingImpact(before, after, { dirsOf: configuredTrackDirs, recordedSlides: onlySlideOne });
  assert.equal(hasImpact(impact), false);
  assert.equal(impactWarning(impact), null);

  // and a track with nothing on disk is never a warning, however the deck moves
  const empty = recordingImpact(before, deck('{}'), { dirsOf: configuredTrackDirs, recordedSlides: () => [] });
  assert.equal(hasImpact(empty), false);
});
