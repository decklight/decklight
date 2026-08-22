// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Review comments — SPEC REVIEW.
//
// A reviewer's remarks on a deck, anchored to slides, stored in
// `<deck>.review.jsonl` beside it (cli/review-store.mjs) and carried by git.
//
// This file is the browser half, and it is two things that do not know about
// each other: a pure anchor resolver (below, unit-tested with no DOM) and the
// overlay that shows what it resolved.
//
// NOT "annotations". That word is taken in this codebase, and taken by the
// deliberate opposite: ink (src/core/annotate.js) is cleared on every slide
// change and never persisted, because it belongs to the moment somebody is
// talking. A review comment belongs to a different actor at a different time —
// somebody reading the deck before the talk, writing to its author — so it
// persists, and the two must not be confused in the vocabulary either.

// ── anchoring ─────────────────────────────────────────────────────────────
//
// A slide has NO stable identity. `locateSlide` (tools/deck-html.mjs) is
// `parts[2 * n]` over a string split on `<section`, and `data-slide-index` is
// written by the engine from array position at every load. So a comment stored
// as `{ slide: 12 }` re-attaches to whatever is twelfth after somebody inserts
// a slide at 3 — silently, and pointing at prose that never said the thing the
// comment is about.
//
// A comment therefore records three facts, and resolution walks them in
// descending order of confidence, REPORTING which one answered. That last part
// is the point: the same three-valued honesty the ingredients label uses, where
// "unchecked is its own answer and never a pass".

/**
 * A slide's content fingerprint.
 *
 * Over the slide's TEXT, not its markup, so re-indenting the file or changing a
 * class does not orphan every comment on it. Notes are already excluded by the
 * caller's `slideBody` — a comment is about what the audience sees, and an
 * author rewriting their own speaker notes has not changed the slide the
 * reviewer was looking at.
 *
 * WHITESPACE IS REMOVED, not collapsed, and that is the load-bearing bit. The
 * browser reads a slide through the DOM (`textContent` of each child, joined)
 * and a tool reads it out of the FILE (tags stripped), and the two disagree
 * about spacing in ways that are invisible and endless: `<p>a</p><p>b</p>` is
 * "a b" to one and "ab" to the other, `<ul><li>x</li><li>y</li></ul>` is the
 * reverse, and source indentation between tags shows up in one and not the
 * other. Every one of those would silently orphan a comment. Dropping
 * whitespace entirely makes the question not arise — the cost is that "the cat"
 * and "thecat" hash alike, which is not a thing anchoring cares about.
 *
 * FNV-1a, 32-bit, hex. Not a security boundary — nobody is attacking a comment
 * anchor — so the cheapest stable hash that fits in a JSON line and can be
 * computed identically in Node and a browser with no dependency.
 */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '').replace(/\s+/g, '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Where a comment belongs in the deck as it is NOW.
 *
 * `slides` is `[{ slide, title, fp }]` for the current deck — one entry per
 * section, in order.
 *
 * Returns `{ verdict, slide, movedFrom }`:
 *
 *   exact      the fingerprint matches — this is the slide, wherever it now
 *              sits. `movedFrom` is set when the index changed.
 *   stale      the content changed, but exactly one slide still carries the
 *              title. Probably right, and worth saying it may not be.
 *   unanchored the comment recorded no fingerprint (hand-written, or written by
 *              an older version) and its index is still in range. Shown, with
 *              the warning that it is a guess.
 *   orphaned   the slide is gone. Listed at the end rather than dropped — a
 *              comment about a slide somebody deleted is often the most
 *              interesting one in the file.
 *
 * A title match is required to be UNIQUE. Two slides called "Agenda" is an
 * ordinary deck, and picking the first would be a coin flip presented as an
 * answer.
 *
 * THE POSITIONAL FALLBACK IS NOT A FALLBACK FOR A KNOWN SLIDE. A comment that
 * recorded a fingerprint and whose fingerprint is nowhere in the deck is a
 * comment whose slide is gone — falling back to "whatever is twelfth now" puts
 * somebody's objection under a slide that never said the thing, which is worse
 * than admitting the slide is missing. So the index is consulted only when
 * there was nothing better to consult: no fingerprint was ever recorded.
 */
export function resolveAnchor(comment, slides) {
  const list = Array.isArray(slides) ? slides : [];
  const was = Number(comment?.slide);

  if (comment?.fp) {
    const hit = list.find((s) => s.fp === comment.fp);
    if (hit) {
      return { verdict: 'exact', slide: hit.slide, movedFrom: hit.slide === was ? null : was };
    }
  }

  const title = String(comment?.title ?? '').trim();
  if (title) {
    const named = list.filter((s) => String(s.title ?? '').trim() === title);
    if (named.length === 1) {
      return { verdict: 'stale', slide: named[0].slide, movedFrom: named[0].slide === was ? null : was };
    }
  }

  if (!comment?.fp && Number.isInteger(was) && was >= 1 && was <= list.length) {
    return { verdict: 'unanchored', slide: was, movedFrom: null };
  }
  return { verdict: 'orphaned', slide: null, movedFrom: null };
}

/** What a reader is told about each verdict, in one place so it reads alike. */
export const VERDICT_NOTE = {
  exact: null,
  stale: 'this slide changed since the comment was written',
  unanchored: 'could not find the slide this was written on — showing it where it used to be',
  orphaned: 'the slide this was written on is gone',
};

/**
 * The deck as the anchor resolver wants it: one entry per slide.
 *
 * `title` and `body` come from the finder's own helpers, so the title a comment
 * remembers is the same string the finder shows for that slide and the two can
 * never disagree about what a slide is called.
 */
export function indexSlides(sections, { titleOf, bodyOf }) {
  return sections.map((section, i) => {
    const body = bodyOf(section);
    return { slide: i + 1, title: titleOf(section, i, body), fp: fingerprint(body) };
  });
}
