// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What a rendered video can be asked to be — its container, its quality and
// where its subtitles go. ONE list, read by three places: the deck's export card
// (the labels), the author server (what a request may say) and `decklight
// video` (what its flags accept). Written separately, those drift, and a card
// offering a format the command refuses is a row that fails four minutes in.
//
// It lives in tools/ because that is the side the package ships: src/ reaches
// the runtime only as the bundle in dist/, so the CLI may not import from it
// (test/cli.test.mjs), while the runtime importing from here is bundled like
// src/core/review.js's tools/review-anchor.mjs. No imports and no DOM.

export const VIDEO_FORMATS = [
  { value: 'mp4', label: 'MP4 — H.264, plays everywhere' },
  { value: 'mov', label: 'MOV — H.264, for QuickTime and Final Cut' },
  { value: 'webm', label: 'WebM — VP9, smaller, for the web' },
];

export const VIDEO_QUALITIES = [
  { value: 'draft', label: 'Draft — quick and small, to check the timing' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High — slower to render, sharper, larger' },
];

export const VIDEO_SUBTITLES = [
  { value: 'none', label: 'None' },
  { value: 'embed', label: 'In the video — a track the player can turn on' },
  { value: 'file', label: 'Beside the video — .srt (.vtt for WebM)' },
];

/** The values alone, as a flag's error message lists them. */
export const valuesOf = (list) => list.map((o) => o.value);
