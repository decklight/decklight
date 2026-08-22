// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review-comment store — SPEC REVIEW.
//
// A reviewer's comments on a deck live in `<deck>.review.jsonl` beside it: one
// JSON object per line, APPEND-ONLY, never rewritten.
//
// Append-only is not tidiness, it is the merge strategy. `.gitattributes`
// declares `*.review.jsonl merge=union`, so two reviewers commenting on the same
// deck at the same time produce two sets of added lines and no conflict. That
// only holds while every operation is a NEW LINE: resolving a comment and
// replying to one are records of their own (`op:"resolve"`, `re:"<id>"`), never
// edits to the line they refer to. A store that mutated a line would conflict on
// exactly the deck that two people were reviewing, which is every deck worth
// reviewing.
//
// It is also why the format is JSONL rather than JSON: an appended line is a
// diff of one line, so a reviewer's push reads in a pull request with no tooling
// at all. `body` is written last for the same reason — the eye lands on the
// prose, not the bookkeeping.
//
// Nothing here touches git or the filesystem. The store is the shape; who reads
// and writes it is cli/review.mjs (the reviewer) and cli/comments.mjs (the
// author).

/** The sidecar that belongs to a deck: `talk.html` → `talk.review.jsonl`. */
export const reviewPathFor = (deckPath) => String(deckPath).replace(/\.html?$/i, '') + '.review.jsonl';

/**
 * Parse the store. A malformed line is SKIPPED, never fatal.
 *
 * This file is hand-mergeable text that arrives over email and through
 * `merge=union`, so a half-written line is a thing that will happen. Refusing to
 * read the whole file because of one is how a reviewer loses forty comments to a
 * truncated forty-first — and the one line nobody can parse is also the one line
 * nobody can act on, so dropping it costs nothing that was recoverable.
 *
 * Returns `{ records, skipped }` — `skipped` counted rather than swallowed, so a
 * caller can say so out loud instead of quietly showing fewer comments than the
 * file contains.
 */
export function parseReview(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    // An object with no id and no `re` is not a record of anything — it cannot
    // be replied to, resolved, or pointed at a slide.
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || (!rec.id && !rec.re)) { skipped++; continue; }
    records.push(rec);
  }
  return { records, skipped };
}

/** One record as the line it will be appended as — `body` last, on purpose. */
export function serializeRecord(rec) {
  const { body, ...rest } = rec;
  return JSON.stringify(body === undefined ? rest : { ...rest, body });
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

/**
 * Merge an incoming store into an existing one, by id.
 *
 * The no-repo reviewer's return path: they were sent a deck, they commented, and
 * they send back a file. Every record carries an id, so merging is a set union
 * and importing the same file twice is a no-op — which matters, because the
 * person doing it has no way to know whether they already did.
 *
 * Order is preserved and incoming records go on the END, so the file stays an
 * append-only log and the diff of an import reads like any other reviewer's
 * push.
 */
export function mergeById(existing, incoming) {
  const key = (r) => (r.op === 'resolve' ? `resolve:${r.re}:${r.at ?? ''}:${r.by ?? ''}` : r.id);
  const seen = new Set(existing.map(key));
  const added = [];
  for (const r of incoming) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(r);
  }
  return { records: [...existing, ...added], added: added.length };
}

/**
 * A short, collision-resistant id for a new comment.
 *
 * Not a UUID: this appears in `re:` fields a human may type in a terminal, and
 * in a diff a human reads. Four bytes of the caller's randomness, base36 — the
 * store dedupes by id anyway, so a collision costs one dropped comment rather
 * than corruption, and at four bytes it will not happen.
 *
 * `rand` is injected so a test is not a coin flip.
 */
export function newId(rand = () => Math.random()) {
  return Math.floor(rand() * 0xffffffff).toString(36).padStart(6, '0').slice(-6);
}
