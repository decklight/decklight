// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where a filmed face shows on a slide, and from which beat (FACE_LAYOUT):
// the `data-face` attribute on a <section>. ONE reader, for the two places
// that place the face: the deck's character overlay (src/core/character.js,
// which bundles this the way src/core/review.js bundles review-anchor.mjs)
// and `decklight video`, which composes it into the frames. Written twice,
// a slide would be full screen in the deck and in the corner of its video.
//
//   data-face="full"                  your face fills the screen, the slide steps aside
//   data-face="full 1.4"              …zoomed in 1.4×, on the face
//   data-face="hide"                  no face on this slide; the voice still plays
//   data-face="hide 3:full 1.5 4:corner"
//                                     hidden for beats 1-2, full screen at 1.5× from
//                                     beat 3, the medallion again from beat 4
//
// A beat is a [click] beat of the slide's notes, counted the way the recorder
// counts them ("beat 3 of 4") and numbered like its files (slide-NN-03.wav).
// A value holds until the next one. No attribute, or one that says nothing
// this understands, is the corner: the medallion, as the deck has always
// shown it.
//
// No imports and no DOM.

export const FACE_KINDS = ['corner', 'hide', 'full'];
export const FACE_ZOOM_MAX = 4;

/** `corner`, the default, at no zoom. */
export const FACE_CORNER = Object.freeze({ kind: 'corner', zoom: 1 });

/**
 * `data-face` → its rules, earliest beat first: `[{ from, kind, zoom }]`, and
 * the tokens it could not read (for a check that wants to say so).
 */
export function parseFaceLayout(attr) {
  const rules = [];
  const bad = [];
  let from = 1;
  for (const raw of String(attr ?? '').trim().split(/\s+/).filter(Boolean)) {
    const tok = raw.toLowerCase();
    const at = /^(\d+):(.*)$/.exec(tok);
    const word = at ? at[2] : tok;
    if (at) from = Math.max(1, Number(at[1]));
    // a zoom belongs to the `full` before it: `full 1.4`, `full 1.4x`, `full ×1.4`
    const zoom = /^[x×]?(\d+(?:\.\d+)?)[x×]?$/.exec(word);
    if (zoom && !at) {
      const last = rules[rules.length - 1];
      if (last?.kind === 'full') { last.zoom = Math.min(FACE_ZOOM_MAX, Math.max(1, Number(zoom[1]))); continue; }
      bad.push(raw);
      continue;
    }
    if (!FACE_KINDS.includes(word)) { bad.push(raw); continue; }
    const rule = { from, kind: word, zoom: 1 };
    // a later rule for the same beat replaces the earlier one
    const same = rules.findIndex((r) => r.from === from);
    if (same >= 0) rules[same] = rule; else rules.push(rule);
  }
  rules.sort((a, b) => a.from - b.from);
  return { rules, bad };
}

/** How the face shows on `beat` (1-based) of a slide whose section says `attr`. */
export function faceLayout(attr, beat = 1) {
  const { rules } = parseFaceLayout(attr);
  let at = FACE_CORNER;
  for (const r of rules) if (r.from <= (beat ?? 1)) at = { kind: r.kind, zoom: r.zoom };
  return at;
}
