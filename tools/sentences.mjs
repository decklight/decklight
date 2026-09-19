// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where speech breaks into sentences — one rule for the live voice and captions
// (src/core/narration.js, which re-exports it) and for a rendered video's
// subtitles (tools/video.mjs), so the two break in the same places.
//
// In tools/ because the package ships tools/ and not src/: the CLI may not
// import from the runtime, and the runtime bundles what it imports from here.

/** Where the live voice breathes: sentence ends, with closing quotes kept on the sentence. */
export function splitSentences(text) {
  return ((text ?? '').match(/[^.!?…]+[.!?…]+[”’"')\]]*|[^.!?…]+$/g) ?? [])
    .map((s) => s.trim()).filter(Boolean);
}

/**
 * The let-it-sink-in marker (#560): `⟨PAUSE⟩` anywhere in a slide's notes
 * holds twice the beat pause at that spot. Like ⟨CLICK⟩ it is punctuation for
 * the voice, never words — and unlike ⟨CLICK⟩ it cuts no beat, so it lives
 * INSIDE one, where only a recording can hold it. One definition here, read
 * by the live voice, the deck's recorder, the synthesis core and a video's
 * subtitles alike, so all four hold it in the same place.
 */
export const PAUSE_MARK = '⟨PAUSE⟩';

/** The text with every ⟨PAUSE⟩ gone — what is spoken, captioned, subtitled. */
export const stripPauses = (text) => String(text ?? '').replaceAll(PAUSE_MARK, ' ');

/**
 * A text cut at its ⟨PAUSE⟩ markers: `runs` are the stretches of words, each
 * with the number of markers that FOLLOW it, and `lead` counts the markers
 * before any word at all.
 *
 * Every marker belongs to the words before it — between two sentences,
 * attached to one, or standing on its own line — except the ones before the
 * first word, which hold before it. That difference is what keeps
 * `A. ⟨PAUSE⟩ ⟨CLICK⟩ B.` (hold, then reveal) apart from
 * `A. ⟨CLICK⟩ ⟨PAUSE⟩ B.` (reveal, then hold). A marker mid-sentence cuts the
 * sentence there: the author put the silence exactly where they wanted it.
 */
export function pauseRuns(text) {
  const parts = String(text ?? '').split(PAUSE_MARK);
  const runs = [];
  let lead = 0;
  parts.forEach((part, j) => {
    const words = part.replace(/\s+/g, ' ').trim();
    if (words) runs.push({ text: words, pause: 0 });
    if (j === parts.length - 1) return;
    if (runs.length) runs[runs.length - 1].pause++;
    else lead++;
  });
  return { lead, runs };
}
