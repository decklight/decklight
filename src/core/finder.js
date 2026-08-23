// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Go somewhere" — the index the slide finder searches, and how a query ranks
// against it.
//
// Only the answer, not the panel: the overlay, its live preview iframe and the
// postMessage handshake stay in engine.js with the rest of the chrome. What
// moved is everything that can be wrong without anything being on screen —
// which slide a title comes from, what counts as a match, and what order the
// results are in. That part had no test at all, because reaching it meant
// booting a deck and typing into it.
//
// ONE QUESTION, ONE ANSWER. The index carries the deck's own slides AND the
// other modules of a playlist, because "go somewhere" should not be two
// different searches depending on whether the destination happens to live in
// this file. In-file `data-module` chapters need nothing special: they are
// ordinary slides and are already indexed as such.

/**
 * A slide's title: its first heading, else its opening words, else its number.
 *
 * Exported because review comments remember it (SPEC REVIEW): a comment records
 * the title of the slide it was written on, and resolves against it when the
 * fingerprint no longer matches. Sharing THIS function is what stops the finder
 * and the comment list disagreeing about what a slide is called.
 */
export function slideTitle(section, i, body) {
  const heading = section.querySelector('h1, h2, h3');
  const fromHeading = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
  return fromHeading || body.slice(0, 60) || `slide ${i + 1}`;
}

/**
 * A slide's searchable text — its content, minus notes and the machinery.
 *
 * Exported for the same reason as `slideTitle`, and it carries one decision
 * review depends on: notes are excluded, so an author rewriting their own
 * speaker notes does not change a slide's fingerprint and orphan every comment
 * on it. A comment is about what the audience sees.
 */
export function slideBody(section) {
  const content = [...section.children].filter((el) => !el.matches('aside, script, style'));
  return content.map((el) => el.textContent).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the finder's index.
 *
 * `modules` is a playlist's module list (empty for a deck that is not part of
 * one) and `skipModule` is this deck's own position in it — listing the module
 * you are already inside is an invitation to reload the page you are
 * presenting from.
 */
export function buildIndex({ sections, modules = [], skipModule = -1 }) {
  const slides = sections.map((section, i) => {
    const body = slideBody(section);
    return { slide: i + 1, title: slideTitle(section, i, body), haystack: body.toLowerCase() };
  });
  const others = modules
    .map((m, i) => ({ module: i, title: m.title, href: m.href, haystack: (m.title || '').toLowerCase() }))
    .filter((m) => m.module !== skipModule);
  return [...slides, ...others];
}

/**
 * Rank `index` against `query`.
 *
 * Word-AND, not substring: "chart theme" finds the slide that mentions both,
 * in either order, which is how someone half-remembers a slide. A hit in the
 * TITLE outranks every body-only hit — the deck's own headings are the names
 * the presenter thinks in, and a body match on a common word would otherwise
 * bury the slide actually called that.
 *
 * An empty query matches everything, in deck order: opening the finder shows
 * the deck rather than an empty box.
 */
export function rankMatches(index, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const titleHits = [], bodyHits = [];
  for (const entry of index) {
    const title = entry.title.toLowerCase();
    if (words.every((w) => title.includes(w))) titleHits.push(entry);
    else if (words.every((w) => entry.haystack.includes(w))) bodyHits.push(entry);
  }
  return [...titleHits, ...bodyHits];
}
