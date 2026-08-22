// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review-comment store and the anchor resolver (SPEC REVIEW) — the two
// pieces that are silently wrong when they are wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewPathFor, parseReview, serializeRecord, foldReview, mergeById, newId,
} from '../cli/review-store.mjs';
import { fingerprint, resolveAnchor, VERDICT_NOTE, indexSlides } from '../src/core/review.js';
import { sectionBodies, sectionInner, slideText, slideHeading } from '../tools/deck-html.mjs';

// ── the store ─────────────────────────────────────────────────────────────

test('the sidecar sits beside the deck, under the deck\'s own name', () => {
  assert.equal(reviewPathFor('talk.html'), 'talk.review.jsonl');
  assert.equal(reviewPathFor('/a/b/talk.htm'), '/a/b/talk.review.jsonl');
  // a name that is not a deck keeps its whole self rather than losing a suffix
  assert.equal(reviewPathFor('talk'), 'talk.review.jsonl');
});

test('a malformed line is skipped and counted, never fatal', () => {
  // This file arrives over email and through `merge=union`, so a half-written
  // line WILL happen. Refusing the whole file for one of them is how a reviewer
  // loses forty comments to a truncated forty-first.
  const { records, skipped } = parseReview([
    '{"id":"a1","slide":1,"body":"first"}',
    '{"id":"a2","slide":2,"body":"trunc',      // cut off mid-write
    '',                                          // blank lines are not errors
    'not json at all',
    '[1,2,3]',                                   // an array is not a record
    '{"note":"no id, no re"}',                   // cannot be replied to or resolved
    '{"id":"a3","slide":3,"body":"last"}',
  ].join('\n'));
  assert.deepEqual(records.map((r) => r.id), ['a1', 'a3']);
  assert.equal(skipped, 4, 'counted rather than swallowed, so a reader can say so');
});

test('a record serialises with body LAST — the diff is read by a human', () => {
  // A reviewer's push shows up in a pull request as added lines. Putting the
  // prose last is what makes the eye land on it instead of the bookkeeping.
  assert.equal(
    serializeRecord({ id: 'k3f9', slide: 12, body: 'This contradicts slide 4.' }),
    '{"id":"k3f9","slide":12,"body":"This contradicts slide 4."}');
  // a record with no body (a resolve) serialises without an empty one
  assert.equal(serializeRecord({ op: 'resolve', re: 'k3f9' }), '{"op":"resolve","re":"k3f9"}');
});

test('state is folded from the log, never stored', () => {
  // Which is why resolve is its own line: two people resolving the same comment
  // is two harmless lines instead of a conflict.
  const { records } = parseReview([
    '{"id":"a1","slide":1,"body":"the question"}',
    '{"id":"a2","re":"a1","body":"a reply"}',
    '{"id":"a3","slide":2,"body":"unrelated"}',
    '{"op":"resolve","re":"a1","at":"2026-08-23T09:00:00Z","by":"Gilles"}',
  ].join('\n'));
  const folded = foldReview(records);
  assert.equal(folded.length, 2, 'a reply is not a top-level comment');
  const [a1, a3] = folded;
  assert.equal(a1.replies.length, 1);
  assert.equal(a1.replies[0].body, 'a reply');
  assert.deepEqual(a1.resolved, { at: '2026-08-23T09:00:00Z', by: 'Gilles' });
  assert.equal(a3.resolved, null, 'unresolved is null, not false — nobody has said');
});

test('a resolve that arrives BEFORE its comment still lands', () => {
  // merge=union concatenates; it does not reorder. So the file can genuinely
  // hold a resolve above the comment it refers to.
  const { records } = parseReview([
    '{"op":"resolve","re":"a1","by":"Ana"}',
    '{"id":"a1","slide":1,"body":"the question"}',
  ].join('\n'));
  assert.equal(foldReview(records)[0].resolved.by, 'Ana');
});

test('a duplicate id is the same comment arriving twice, not two comments', () => {
  // An import, or a union merge that saw both sides. First wins; it is the
  // same text either way.
  const { records } = parseReview([
    '{"id":"a1","slide":1,"body":"once"}',
    '{"id":"a1","slide":1,"body":"once"}',
  ].join('\n'));
  assert.equal(foldReview(records).length, 1);
});

test('a reply or resolve pointing at nothing is dropped, not crashed on', () => {
  // Half a thread can arrive on its own — someone forwards part of a file.
  const { records } = parseReview([
    '{"id":"r1","re":"gone","body":"a reply to a comment I was not sent"}',
    '{"op":"resolve","re":"also-gone"}',
    '{"id":"a1","slide":1,"body":"here"}',
  ].join('\n'));
  assert.deepEqual(foldReview(records).map((c) => c.id), ['a1']);
});

test('importing the same file twice is a no-op', () => {
  // The person doing it has no way to know whether they already did.
  const mine = parseReview('{"id":"a1","slide":1,"body":"mine"}').records;
  const theirs = parseReview([
    '{"id":"a1","slide":1,"body":"mine"}',
    '{"id":"b2","slide":3,"body":"theirs"}',
  ].join('\n')).records;

  const once = mergeById(mine, theirs);
  assert.equal(once.added, 1);
  assert.deepEqual(once.records.map((r) => r.id), ['a1', 'b2']);
  // …and again
  const twice = mergeById(once.records, theirs);
  assert.equal(twice.added, 0);
  assert.equal(twice.records.length, 2);
});

test('an import APPENDS — the file stays a log', () => {
  // So the diff of an import reads like any other reviewer's push.
  const mine = parseReview('{"id":"a1","body":"first"}').records;
  const theirs = parseReview('{"id":"b2","body":"second"}').records;
  assert.deepEqual(mergeById(mine, theirs).records.map((r) => r.id), ['a1', 'b2']);
});

test('two distinct resolves of one comment both survive the merge', () => {
  // They are different records — different people, different times — and
  // collapsing them by `re` would lose who said what.
  const a = parseReview('{"op":"resolve","re":"x","by":"Ana","at":"t1"}').records;
  const b = parseReview('{"op":"resolve","re":"x","by":"Gilles","at":"t2"}').records;
  assert.equal(mergeById(a, b).added, 1);
  // …but the same one twice is still once
  assert.equal(mergeById(a, a).added, 0);
});

test('an id is short enough to type and stable under an injected source', () => {
  // It lands in a `re:` field somebody may type in a terminal, and in a diff
  // somebody reads — so not a UUID.
  assert.equal(newId(() => 0.5).length, 6);
  assert.equal(newId(() => 0.5), newId(() => 0.5));
  assert.notEqual(newId(() => 0.5), newId(() => 0.25));
  assert.match(newId(() => 0.999999), /^[0-9a-z]{6}$/);
  // the extremes do not produce something unusable
  assert.equal(newId(() => 0).length, 6);
});

// ── anchoring: the part that is silently wrong when it is wrong ───────────
//
// A slide has no stable identity — `locateSlide` is `parts[2 * n]` over a split
// on `<section`, and `data-slide-index` is written from array position at every
// load. A comment stored as `{slide: 12}` re-attaches to whatever is twelfth
// after somebody inserts a slide at 3.

/** A deck, as the resolver wants it. */
const deck = (...titles) => titles.map((t, i) => ({ slide: i + 1, title: t, fp: fingerprint(t) }));

test('the fingerprint is over TEXT, so reformatting does not orphan a comment', () => {
  assert.equal(fingerprint('Why this matters'), fingerprint('  Why   this\n matters  '));
  assert.notEqual(fingerprint('Why this matters'), fingerprint('Why this mattered'));
  // stable across runs and 8 hex chars — it lives in a JSON line
  assert.match(fingerprint('anything'), /^[0-9a-f]{8}$/);
  assert.equal(fingerprint(''), fingerprint('   '));
  assert.equal(fingerprint(null), fingerprint(undefined));
});

test('an unchanged slide is found wherever it now sits, and says it moved', () => {
  // The case the whole design exists for: somebody inserted two slides above
  // the one being discussed.
  const before = deck('Intro', 'Why this matters');
  const after = deck('Intro', 'New A', 'New B', 'Why this matters');
  const c = { slide: 2, title: 'Why this matters', fp: before[1].fp };
  assert.deepEqual(resolveAnchor(c, after), { verdict: 'exact', slide: 4, movedFrom: 2 });
  // …and when it has not moved, it does not claim to have
  assert.deepEqual(resolveAnchor(c, before), { verdict: 'exact', slide: 2, movedFrom: null });
});

test('an edited slide is found by title, and reported as stale', () => {
  // Probably right, and worth saying it may not be — the reviewer was looking
  // at different words.
  const c = { slide: 2, title: 'Why this matters', fp: fingerprint('the old body') };
  const now = [{ slide: 2, title: 'Why this matters', fp: fingerprint('the new body') }];
  assert.deepEqual(resolveAnchor(c, now), { verdict: 'stale', slide: 2, movedFrom: null });
  assert.match(VERDICT_NOTE.stale, /changed since/);
});

test('a title shared by two slides is not a match — that is a coin flip', () => {
  // "Agenda" twice is an ordinary deck. Picking the first and presenting it as
  // an answer is worse than admitting the guess.
  const c = { slide: 5, title: 'Agenda', fp: 'deadbeef' };
  const now = deck('Agenda', 'Middle', 'Agenda', 'End', 'Fifth');
  assert.equal(resolveAnchor(c, now).verdict, 'orphaned');
});

test('a KNOWN slide that is nowhere in the deck is orphaned, not re-pinned', () => {
  // The bug this closes, found by reading real output: a comment on a deleted
  // slide fell through to "whatever is third now" and was printed under an
  // unrelated heading, grouped with somebody else's remark about it. A comment
  // that recorded a fingerprint and cannot find it has lost its slide — saying
  // so beats putting an objection under prose that never said the thing.
  const c = { slide: 3, title: 'Cut me', fp: fingerprint('doomed') };
  assert.equal(resolveAnchor(c, deck('A', 'B', 'C')).verdict, 'orphaned');
});

test('a comment with no fingerprint may still fall back to its index', () => {
  // Hand-written, or written before fingerprints existed. There was nothing
  // better to consult, so the index is not a worse answer than nothing.
  const c = { slide: 2, title: 'Gone' };
  assert.deepEqual(resolveAnchor(c, deck('A', 'B', 'C')), { verdict: 'unanchored', slide: 2, movedFrom: null });
  assert.match(VERDICT_NOTE.unanchored, /could not find/);
});

test('a comment on a deleted slide is orphaned, never dropped', () => {
  // Often the most interesting comment in the file — somebody objected to a
  // slide and it is not there any more.
  const c = { slide: 9, title: 'Cut me', fp: 'deadbeef' };
  assert.deepEqual(resolveAnchor(c, deck('A', 'B')), { verdict: 'orphaned', slide: null, movedFrom: null });
  assert.match(VERDICT_NOTE.orphaned, /is gone/);
});

test('a comment from a deck with no fingerprint still resolves', () => {
  // Hand-written, or written by an older version. Title first, then index.
  assert.equal(resolveAnchor({ slide: 2, title: 'B' }, deck('A', 'B', 'C')).verdict, 'stale');
  assert.equal(resolveAnchor({ slide: 2 }, deck('A', 'B', 'C')).verdict, 'unanchored');
  // and a comment naming nothing at all in an empty deck is orphaned, not a throw
  assert.equal(resolveAnchor({}, []).verdict, 'orphaned');
  assert.equal(resolveAnchor(null, null).verdict, 'orphaned');
});

test('indexSlides pairs each slide with the title the finder would show', () => {
  // Sharing the finder's own helpers is what stops the two disagreeing about
  // what a slide is called.
  const sections = [{ t: 'One', b: 'first body' }, { t: 'Two', b: 'second body' }];
  const idx = indexSlides(sections, { titleOf: (s) => s.t, bodyOf: (s) => s.b });
  assert.deepEqual(idx, [
    { slide: 1, title: 'One', fp: fingerprint('first body') },
    { slide: 2, title: 'Two', fp: fingerprint('second body') },
  ]);
});

// ── the seam: the browser reads the DOM, a tool reads the FILE ────────────
//
// These two extract a slide's text by completely different means and must land
// on the same fingerprint, or a comment written in the browser cannot be found
// by `decklight comments` — silently, and only for some slides. This is the
// cheapest thing that fails when either side drifts.

test('the file reader extracts exactly the slide, and nothing around it', () => {
  // Pinned literally rather than against a hand-rolled DOM emulator. A regex
  // that pretends to be a browser proves only that two regexes agree; the REAL
  // browser/file agreement is asserted in test/review-render.mjs, where there
  // is an actual DOM to disagree with. (SPEC: "a feature is verified against a
  // real render, not only unit-tested".)
  const deckHtml = `<div class="decklight">
    <section><h1>One</h1><p>the first slide</p></section>
    <section class="x" data-layout="split">
      <h2>Two</h2>
      <ul data-build><li>alpha</li><li>beta</li></ul>
      <aside class="notes"><p>notes the audience never sees</p></aside>
    </section>
    <section><h2>Three</h2><p>a &amp; b</p><script>ignored()</script></section>
  </div>`;
  const text = sectionBodies(deckHtml).map((b) => slideText(sectionInner(b)));
  assert.deepEqual(text, [
    'One the first slide',
    'Two alpha beta',                 // the notes aside is not the slide
    'Three a & b',                    // entities back, the script gone
  ]);
  // the open tag's attributes are outside the slide, and would otherwise hash
  // as content — `class="x" data-layout="split"` is not something anybody said
  assert.notEqual(slideText(sectionBodies(deckHtml)[1]), text[1]);
});

test('rewriting the speaker notes does not orphan a comment on the slide', () => {
  // A comment is about what the audience sees. An author polishing their own
  // notes has not changed the slide the reviewer was looking at.
  const withNotes = (n) => `<section><h2>Two</h2><p>the body</p>`
    + `<aside class="notes"><p>${n}</p></aside></section>`;
  assert.equal(
    fingerprint(slideText(withNotes('what I planned to say'))),
    fingerprint(slideText(withNotes('a completely different plan'))));
  // …but changing the slide itself does
  assert.notEqual(
    fingerprint(slideText('<section><p>the body</p></section>')),
    fingerprint(slideText('<section><p>a different body</p></section>')));
});

test('the file reader names a slide the way the finder would', () => {
  const inner = (body) => sectionInner(body);
  assert.equal(slideHeading(inner('><h1>One</h1><p>x</p>'), 0), 'One');
  assert.equal(slideHeading(inner('><h2>Two &amp; a half</h2>'), 1), 'Two & a half');
  // no heading: its opening words, then its number — the finder's own ladder
  assert.equal(slideHeading(inner('><p>just some prose here</p>'), 2), 'just some prose here');
  assert.equal(slideHeading(inner('>'), 4), 'slide 5');
  // the open tag's attributes are not part of the slide's name
  assert.equal(slideHeading(inner(' class="x" data-layout="split"><h2>Named</h2>'), 0), 'Named');
});
