// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The runtime's HTML escape — the same function as tools/escape.mjs, kept
// separate only because src/ bundles into a zero-dependency artifact and
// cannot reach into tools/. Anything that builds markup from deck data or
// from a bridge's response goes through this: a voice name arriving from a
// TTS bridge was rendered as markup once already (#245), and a chart's series
// name is author text landing in an attribute.
//
// It escapes `& < > "` — correct in element content AND in a double-quoted
// attribute, so there is no second function to choose wrong between. See
// tools/escape.mjs for the full reasoning; test/deck-html.test.mjs pins the
// two implementations to the same output.

/** Escape `s` for HTML text or a double-quoted attribute value. */
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
