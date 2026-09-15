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
