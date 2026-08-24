// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review anchor — SPEC REVIEW.
//
// SHARED BY THE BROWSER AND THE CLI, which is the whole reason it lives here.
// `src/core/review.js` shows comments in the deck and `cli/comments.mjs` prints
// them in a terminal, and the two must agree exactly about which slide a
// comment belongs to — a disagreement is invisible and costs somebody their
// review.
//
// It cannot live in `src/`: that directory is the browser runtime and is NOT in
// the published package (`files` ships cli/, tools/, dist/, themes/, docs/), so
// a CLI reaching into it works in a checkout and fails on every install. The
// soak caught exactly that, which is what the soak is for.
//
// THIS FILE IMPORTS NOTHING, and must not start. `src/core/review.js` imports
// it and esbuild inlines it into the browser bundle, so a single `node:`
// require here would break a runtime whose whole claim is zero dependencies.
// test/review.test.mjs asserts the file has no imports at all rather than
// trusting this paragraph.

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

/**
 * Fold the records into what a reader wants: comments, each with its replies and
 * whether it has been resolved.
 *
 * The fold is the whole reason `op:"resolve"` is a separate line — state is
 * DERIVED from the log rather than stored, so two people resolving the same
 * comment is two harmless lines rather than a conflict, and a resolve that
 * arrives before the comment it refers to (which `merge=union` can do, since it
 * does not reorder) still lands once both are present.
 */
export function foldReview(records) {
  const byId = new Map();
  const replies = [];
  const resolves = [];
  for (const r of records) {
    if (r.op === 'resolve') { resolves.push(r); continue; }
    if (r.re) { replies.push(r); continue; }
    // A duplicate id is the same comment arriving twice (an import, a union
    // merge that saw both sides). First one wins; it is the same text.
    if (!byId.has(r.id)) byId.set(r.id, { ...r, replies: [], resolved: null });
  }
  for (const r of replies) byId.get(r.re)?.replies.push(r);
  for (const r of resolves) {
    const c = byId.get(r.re);
    // Last resolve wins, but only over another resolve — a comment resolved and
    // then resolved again by somebody else is still resolved.
    if (c) c.resolved = { at: r.at ?? null, by: r.by ?? null };
  }
  return [...byId.values()];
}
