// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A recorded narration track can be a DIRECTORY of per-slide files, or a
// MANIFEST that names them one by one.
//
// The manifest exists for exactly one reason: a presigned URL carries its
// signature in the query string, and a query string cannot be a directory
// prefix. `dir` has always been able to serve a PUBLIC bucket — the runtime
// just does `new Audio('<dir>/slide-01.m4a')` and media elements load
// cross-origin without asking — but it can never serve a private one, because
// there is nowhere to put the signature.
//
// Signatures also run out (GCS caps V4 at seven days), which is why the
// arithmetic of "still good?" lives here next to "which URL": the deck has to
// treat a lapsed track the way it treats every other unplayable voice — stop,
// and say what to run. All pure, so the whole of it is testable without a
// bucket, a clock, or a browser.

/** The directory part of a manifest's own URL, trailing slash included. */
export function manifestBase(url) {
  const path = String(url ?? '').replace(/[?#].*$/, '');
  return path.slice(0, path.lastIndexOf('/') + 1);
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/**
 * The URL slide `n` (1-based, like `state.slide`) plays from — or null when
 * the track has nothing for it.
 *
 * A slide with no notes never got a file, and the pre-render tool writes a
 * null in its place; that is a quiet slide, not a broken one. An entry's `url`
 * is used **verbatim**: the query string IS the signature, so re-resolving or
 * re-encoding it would invalidate the very thing it is there to carry.
 */
export function manifestSlideUrl(manifest, manifestUrl, n) {
  const entry = manifest?.slides?.[n - 1];
  if (!entry) return null;
  if (entry.url) return entry.url;
  if (!entry.file) return null;
  // no url means an ordinary file beside the manifest — which is how an
  // unsigned manifest.json in a public bucket works as a track for free
  return ABSOLUTE.test(entry.file) ? entry.file : manifestBase(manifestUrl) + entry.file;
}

/**
 * Where segment k of slide n plays from, or null — and null is an ANSWER.
 *
 * `k` is the 1-BASED FILE NUMBER (`segmentFileIndex`'s output), matching the
 * `slide-NN-KK` names tools/voiceover.mjs writes and the order of the
 * manifest's `segments` array. Past the end of that array the answer is null,
 * and the caller must treat the whole slide as unsegmented rather than error:
 * the manifest is the authority on what was actually recorded, and notes that
 * gained a ⟨CLICK⟩ since then ask for a beat nobody ever spoke.
 *
 * Same verbatim-`url` rule as manifestSlideUrl, for the same reason — a
 * presigned URL's query string IS the signature. And the caller has one more
 * duty this function cannot carry for it: on a SIGNED manifest (one with an
 * `expires`), segments without their own `url` were never uploaded by
 * tools/publish-voices.mjs, so they must be ignored wholesale — resolving them
 * against the bucket would 403 every beat.
 */
export function manifestSegmentUrl(manifest, manifestUrl, n, k) {
  const seg = manifest?.slides?.[n - 1]?.segments?.[k - 1];
  if (!seg) return null;
  if (seg.url) return seg.url;
  if (!seg.file) return null;
  return ABSOLUTE.test(seg.file) ? seg.file : manifestBase(manifestUrl) + seg.file;
}

/**
 * Where the signatures stand: `at` (a Date, or null when the manifest carries
 * no expiry at all — an unsigned manifest never lapses), `msLeft`, `expired`.
 */
export function expiryState(manifest, now = Date.now()) {
  const raw = manifest?.expires;
  if (!raw) return { at: null, msLeft: Infinity, expired: false };
  const at = new Date(raw);
  // an unparseable date is not an expired one: refusing to play a track over a
  // field we failed to read would be worse than ignoring the field
  if (Number.isNaN(at.getTime())) return { at: null, msLeft: Infinity, expired: false };
  const msLeft = at.getTime() - now;
  return { at, msLeft, expired: msLeft <= 0 };
}

/** "6d 4h left", "3h 20m left", "8m left" — a deadline, not a stopwatch. */
export function timeLeft(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h left`;
  if (h) return `${h}h ${m % 60}m left`;
  return `${Math.max(1, m)}m left`;
}

/** The instant, short enough to read in a message: `2026-07-24 09:00Z`. */
export const stampOf = (date) => date.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/**
 * The command that puts a lapsed track back.
 *
 * The publish tool records what it was invoked with, so the deck can name the
 * literal line to re-run rather than a shape to fill in. A hand-written
 * manifest has no such memory, and gets the shape.
 */
export function resignCommand(manifest) {
  const src = manifest?.source ?? '<voice-dir>';
  const bucket = manifest?.bucket ?? 'gs://<bucket>/<prefix>';
  const dur = manifest?.signDuration ?? '7d';
  return `node tools/publish-voices.mjs ${src} --bucket ${bucket} --sign ${dur}`;
}

/** How a track names itself in the picker — `voices/x/` or `☁ manifest`. */
export function trackKey(track) {
  return track?.manifest ?? track?.dir ?? null;
}
