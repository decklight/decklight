// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Manifest tracks: which URL a slide plays, and whether the signatures on it
// are still good. Both are arithmetic, and both are the kind of arithmetic
// that fails quietly — a slide that plays the wrong file, or a deck that
// stalls without saying the signatures ran out — so they are pinned here
// rather than inferred from a bucket nobody can reach from CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  manifestBase, manifestSlideUrl, expiryState, timeLeft, stampOf, resignCommand, trackKey,
} from '../src/core/voicetrack.js';

const MANIFEST_URL = 'voices/algenib/manifest.signed.json';

test('a signed URL is played exactly as it was minted', () => {
  // the query string IS the signature: re-resolving or re-encoding any part of
  // it invalidates the one thing it is carrying
  const signed = 'https://storage.googleapis.com/b/showcase/algenib/slide-01.m4a'
    + '?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc%2Fdef';
  const m = { slides: [{ file: 'slide-01.m4a', hash: 'h', url: signed }] };
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 1), signed);
});

test('a slide with no url resolves its file beside the manifest', () => {
  // which is how an UNSIGNED manifest.json in a public bucket works as a track
  // for free — no signing, no expiry, nothing to re-run
  const m = { slides: [{ file: 'slide-01.m4a' }, { file: 'slide-02.m4a' }] };
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 2), 'voices/algenib/slide-02.m4a');
  assert.equal(manifestSlideUrl(m, 'https://cdn.example/v/manifest.json', 1),
    'https://cdn.example/v/slide-01.m4a');
  assert.equal(manifestBase('voices/algenib/manifest.json?v=2'), 'voices/algenib/');
  assert.equal(manifestBase('manifest.json'), '', 'a manifest at the root has no directory');
});

test('an absolute file is left alone, however the manifest is addressed', () => {
  const m = { slides: [{ file: 'https://cdn.example/a.m4a' }, { file: '//cdn.example/b.m4a' }] };
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 1), 'https://cdn.example/a.m4a');
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 2), '//cdn.example/b.m4a');
});

test('a slide the track has nothing for is silence, not a failure', () => {
  // the pre-render tool writes a null for a slide with no notes — the showcase
  // is 30 slides and 20 clips, and none of the other ten is broken
  const m = { slides: [{ file: 'slide-01.m4a' }, null, { hash: 'h' }] };
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 2), null, 'an explicit null');
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 3), null, 'an entry with no file and no url');
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 9), null, 'past the end of the track');
  assert.equal(manifestSlideUrl(null, MANIFEST_URL, 1), null, 'no manifest at all');
});

test('slides are 1-based, like state.slide', () => {
  const m = { slides: [{ file: 'slide-01.m4a' }, { file: 'slide-02.m4a' }] };
  assert.equal(manifestSlideUrl(m, MANIFEST_URL, 1), 'voices/algenib/slide-01.m4a');
});

test('expiry is read from the manifest, and an absent one never lapses', () => {
  const now = Date.parse('2026-07-20T09:00:00Z');
  const soon = expiryState({ expires: '2026-07-24T09:00:00Z' }, now);
  assert.equal(soon.expired, false);
  assert.equal(soon.msLeft, 4 * 86400 * 1000);

  assert.equal(expiryState({ expires: '2026-07-19T09:00:00Z' }, now).expired, true);
  // exactly at the boundary the signature is already no good
  assert.equal(expiryState({ expires: '2026-07-20T09:00:00Z' }, now).expired, true);

  // a public-bucket manifest carries no expiry and must play forever
  assert.deepEqual(expiryState({}, now), { at: null, msLeft: Infinity, expired: false });
});

test('an unreadable expires field is ignored, not treated as expired', () => {
  // refusing to play a track over a field we failed to parse would be a worse
  // failure than the one it is guarding against
  const s = expiryState({ expires: 'next tuesday' }, Date.now());
  assert.equal(s.expired, false);
  assert.equal(s.at, null);
});

test('the countdown is coarse — a deadline, not a stopwatch', () => {
  assert.equal(timeLeft(6.2 * 86400e3), '6d 4h left');
  assert.equal(timeLeft(3.34 * 3600e3), '3h 20m left');
  assert.equal(timeLeft(8 * 60e3), '8m left');
  assert.equal(timeLeft(20e3), '1m left', 'under a minute still reads as time left, not as zero');
  assert.equal(timeLeft(0), 'expired');
  assert.equal(timeLeft(Infinity), '', 'a track with no expiry says nothing about time');
});

test('the stamp is short enough to sit inside a message', () => {
  assert.equal(stampOf(new Date('2026-07-24T09:00:00Z')), '2026-07-24 09:00Z');
});

test('a lapsed track names the literal command that fixes it', () => {
  // the publish tool records what it was invoked with, so this is the line to
  // re-run and not a shape to fill in
  assert.equal(
    resignCommand({ source: 'voices/algenib', bucket: 'gs://dl-voices/showcase', signDuration: '7d' }),
    'node tools/publish-voices.mjs voices/algenib --bucket gs://dl-voices/showcase --sign 7d',
  );
  // a hand-written manifest has no such memory, and gets the shape
  assert.match(resignCommand({}), /<voice-dir> --bucket gs:\/\/<bucket>\/<prefix> --sign 7d$/);
});

test('a track is keyed by whichever of manifest or dir it has', () => {
  assert.equal(trackKey({ manifest: 'v/m.json' }), 'v/m.json');
  assert.equal(trackKey({ dir: 'voices/algenib' }), 'voices/algenib');
  assert.equal(trackKey({ live: true }), null);
});
