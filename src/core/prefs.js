// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A deck's memory of itself — the theme, the voice, the clock — behind the one
 * fact every caller had to remember on its own: localStorage THROWS.
 *
 * Not "returns null". Throws — on file:// in some browsers, in private mode,
 * in a sandboxed iframe, on a quota that filled. So every preference read and
 * write in src/core was a one-line try/catch with an "ignore" comment:
 * sixteen of them across seven files, and ten of narration.js's empty catch
 * blocks were this. Sixteen copies of one rule is sixteen places for it to be
 * copied wrong, and sixteen branches no test walked.
 *
 * Now it is one rule, and storage being unavailable is ONE branch with ONE
 * test. Storage is advisory here, never load-bearing: a deck that cannot
 * remember what theme it was must still play, so a read that cannot happen
 * is the fallback and a write that cannot happen is false — and neither is
 * ever an exception.
 */

/** The stored string, or `fallback` when there is none — or no storage at all. */
export function readPref(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

/** The stored JSON, parsed, or `fallback` for absent, malformed, or no storage. */
export function readJson(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const parsed = JSON.parse(v);
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

/** Store a string; null or undefined forgets the key. True if it stuck. */
export function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
    return true;
  } catch { return false; }
}

/** Store a value as JSON. True if it stuck. */
export function writeJson(key, value) {
  return writePref(key, JSON.stringify(value));
}
