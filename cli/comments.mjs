#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight comments — what reviewers said about a deck. SPEC REVIEW.
//
//   decklight comments <deck.html> [--unresolved] [--all] [--import <file>]
//
// The author's side of `decklight review`. Reads `<deck>.review.jsonl`, resolves
// every comment against the deck AS IT IS NOW, and prints it grouped by slide.
//
// Resolution is the whole job. A comment records the slide it was written on,
// that slide's title, and a fingerprint of its text — because a slide has no
// stable identity, and a comment stored as "slide 12" re-attaches to whatever is
// twelfth after somebody inserts one. So each comment is reported with HOW it
// was found, and a comment whose slide is gone is listed rather than dropped:
// somebody objected to a slide and it is not there any more is often the most
// interesting line in the file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { argReader, isMain } from '../tools/args.mjs';
import { sectionBodies, sectionInner, slideText, slideHeading } from '../tools/deck-html.mjs';
import { fingerprint, resolveAnchor, VERDICT_NOTE, foldReview } from '../tools/review-anchor.mjs';
import { reviewPathFor, parseReview, serializeRecord, mergeById } from './review-store.mjs';
import { findDeck } from './history.mjs';
import { gitAvailable, inGitRepo, gitAutocommit, oneline, git } from './git.mjs';
import { deckAt } from './restore.mjs';

const HELP = `usage: decklight comments <deck.html> [--unresolved] [--all] [--import <file>]
  what reviewers said, resolved against the deck as it is now

  --unresolved   only the ones nobody has closed off
  --all          include resolved ones (default: they are counted, not printed)
  --import FILE  merge a reviewer's file into this deck's own, skipping anything
                 already there, and commit it — the return path for a reviewer
                 who was sent the deck and has no clone
  --at ID        show what the slide SAID when comment ID was written, beside
                 what it says now — the point of recording which commit a
                 comment was made against

  comments live in <deck>.review.jsonl beside the deck; reviewers write them
  with: decklight review <deck.html>
`;

/**
 * The deck as the resolver wants it, read from the FILE.
 *
 * The browser builds the same list from the DOM (src/core/review.js). They agree
 * because `fingerprint` removes whitespace, so the two readers' different ideas
 * about spacing between elements cannot matter.
 */
export function indexDeckFile(html) {
  return sectionBodies(html).map((body, i) => {
    const inner = sectionInner(body);
    return { slide: i + 1, title: slideHeading(inner, i), fp: fingerprint(slideText(inner)) };
  });
}

/**
 * How far the DECK has moved since a comment was written.
 *
 * The anchor verdict answers a different question — whether the SLIDE is still
 * the slide. Both matter and neither implies the other: a comment can be
 * `exact` (that slide is untouched) against a deck that is forty commits older
 * than the one in front of you, and knowing which version somebody was reading
 * is what lets you go and look.
 *
 * `null` when the question cannot be asked — no repository, or a comment
 * written without one. Never `0`: "nobody knows" and "no commits since" are
 * different answers and only one of them is reassuring.
 */
export function commitsSince(deckCommit, cwd, run = git) {
  if (!deckCommit) return null;
  try {
    const n = run(['rev-list', '--count', `${deckCommit}..HEAD`], cwd);
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch { return null; }   // the commit is not in this clone — see reviewedElsewhere
}

/**
 * Is this commit one this repository has ever heard of?
 *
 * A comment can arrive by `--import` from somebody whose clone had commits
 * yours does not, and reporting "0 commits since" for a hash you cannot resolve
 * would be a confident lie.
 */
export function knowsCommit(deckCommit, cwd, run = git) {
  if (!deckCommit) return false;
  try { run(['cat-file', '-e', `${deckCommit}^{commit}`], cwd); return true; } catch { return false; }
}

/** One slide's text out of a whole deck, by number. */
export function slideTextOf(html, n) {
  const body = sectionBodies(html)[(n ?? 0) - 1];
  return body === undefined ? '' : slideText(sectionInner(body));
}

/** `2h ago`, `3d ago` — the same shape `git log --format=%ar` gives elsewhere. */
export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso ?? '');
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 2) return 'an hour ago';
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Comments, resolved and grouped for printing.
 *
 * Orphans go last, deliberately: they are the ones with no slide to sit under,
 * and burying them among the numbered groups is how they get missed.
 */
export function groupComments(comments, slides) {
  const anchored = comments.map((c) => ({ ...c, anchor: resolveAnchor(c, slides) }));
  const groups = new Map();
  const orphans = [];
  for (const c of anchored) {
    if (c.anchor.verdict === 'orphaned') { orphans.push(c); continue; }
    if (!groups.has(c.anchor.slide)) groups.set(c.anchor.slide, []);
    groups.get(c.anchor.slide).push(c);
  }
  return {
    groups: [...groups.entries()].sort((a, b) => a[0] - b[0])
      .map(([slide, items]) => ({ slide, title: slides[slide - 1]?.title ?? '', items })),
    orphans,
  };
}

export function commentsMain(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const { opt } = argReader(argv);
  if (argv.includes('--help') || argv.includes('-h')) { out.write(HELP); return 0; }

  const cwd = process.cwd();
  let deckArg = argv.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deckArg) {
    const { decks } = findDeck(cwd);
    if (decks.length === 1) [deckArg] = decks;
    else if (!decks.length) {
      err.write('decklight comments: name the deck — no decklight deck found in this directory\n');
      return 1;
    } else {
      err.write(`decklight comments: name the deck — this directory has ${decks.length}`
        + ` (${decks.slice(0, 4).join(', ')}${decks.length > 4 ? ', …' : ''})\n`);
      return 1;
    }
  }
  const deckPath = resolve(cwd, deckArg);
  const name = basename(deckPath);
  if (!existsSync(deckPath)) { err.write(`decklight comments: no such file: ${deckArg}\n`); return 1; }

  const storePath = reviewPathFor(deckPath);
  const storeName = basename(storePath);
  const deckDir = dirname(deckPath);
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

  // ── --import: the no-repo reviewer's return path ────────────────────────
  const importArg = opt('--import');
  if (importArg !== undefined) {
    const from = resolve(cwd, importArg);
    if (!existsSync(from)) { err.write(`decklight comments: no such file: ${importArg}\n`); return 1; }
    const incoming = parseReview(read(from));
    if (!incoming.records.length) {
      err.write(`decklight comments: ${basename(from)} has no comments in it`
        + `${incoming.skipped ? ` (${incoming.skipped} unreadable line(s))` : ''}\n`);
      return 1;
    }
    const mine = parseReview(read(storePath)).records;
    const { records, added } = mergeById(mine, incoming.records);
    if (!added) {
      out.write(`${basename(from)} — nothing new; all ${incoming.records.length} already here\n`);
      return 0;
    }
    writeFileSync(storePath, records.map(serializeRecord).join('\n') + '\n');
    out.write(`${basename(from)} → ${storeName}: ${added} new`
      + `${incoming.records.length - added ? `, ${incoming.records.length - added} already here` : ''}\n`);
    if (gitAvailable(deckDir) && inGitRepo(deckDir)) {
      const ok = gitAutocommit(storePath, deckDir, `review: import ${added} comment(s) on ${name}`);
      out.write(ok ? '  committed\n' : '  not committed — nothing changed on disk\n');
    }
    out.write(`  read them with:  decklight comments ${relative(cwd, deckPath) || name}\n`);
    return 0;
  }

  // ── --at: what were they actually looking at ────────────────────────────
  //
  // Every comment records the commit the deck was on when it was written, and
  // this is what that field is FOR. An anchor verdict can say "this slide
  // changed since" without being able to say HOW, and "how" is usually the
  // whole question — a reviewer objecting to a sentence that is no longer
  // there has either been answered already or been misread.
  const atArg = opt('--at');
  if (atArg !== undefined) {
    if (!existsSync(storePath)) { err.write(`decklight comments: ${name} has no comments\n`); return 1; }
    const { records } = parseReview(read(storePath));
    const c = foldReview(records).find((x) => x.id === atArg);
    if (!c) { err.write(`decklight comments: no comment [${atArg}] on ${name}\n`); return 1; }
    if (!c.deck) {
      err.write(`decklight comments: [${atArg}] records no commit`
        + ' — it was written outside a repository, so there is no earlier version to show\n');
      return 1;
    }
    if (!(gitAvailable(deckDir) && inGitRepo(deckDir)) || !knowsCommit(c.deck, deckDir)) {
      err.write(`decklight comments: this clone does not have ${c.deck}`
        + ' — the comment came from somewhere with commits this repository has not seen\n');
      return 1;
    }
    let thenHtml;
    try { thenHtml = deckAt(deckPath, c.deck, deckDir); }
    catch (e) { err.write(`decklight comments: could not read ${name} at ${c.deck}: ${oneline(e)}\n`); return 1; }

    const thenSlides = indexDeckFile(thenHtml);
    const nowSlides = indexDeckFile(read(deckPath));
    // the slide as it was is found by the comment's own index — at THAT commit
    // the number was still true, which is exactly why it was recorded
    const wasAt = thenSlides[(c.slide ?? 0) - 1];
    const anchor = resolveAnchor(c, nowSlides);
    const nowAt = anchor.slide ? nowSlides[anchor.slide - 1] : null;

    out.write(`[${c.id}] ${c.by ? c.by.replace(/\s*<[^>]*>$/, '') : 'someone'}`
      + `${c.at ? ` · ${ago(c.at)}` : ''} · against ${c.deck}\n`);
    for (const line of String(c.body ?? '').split('\n')) out.write(`  ${line}\n`);
    out.write('\n');
    out.write(`  then · slide ${c.slide} · ${wasAt?.title ?? '(gone even then)'}\n`);
    out.write(`    ${slideTextOf(thenHtml, c.slide) || '(nothing)'}\n\n`);
    if (!nowAt) {
      out.write(`  now  · ${VERDICT_NOTE.orphaned}\n`);
    } else {
      out.write(`  now  · slide ${anchor.slide} · ${nowAt.title}`
        + `${anchor.movedFrom ? ` (moved from ${anchor.movedFrom})` : ''}`
        + `${anchor.verdict === 'exact' ? ' — unchanged' : ''}\n`);
      out.write(`    ${slideTextOf(read(deckPath), anchor.slide) || '(nothing)'}\n`);
    }
    return 0;
  }

  // ── the listing ─────────────────────────────────────────────────────────
  if (!existsSync(storePath)) {
    // Not an error: no comments is the state every deck starts in, and the
    // useful answer is how somebody would leave one.
    out.write(`${name} — no comments yet\n`);
    out.write(`  a reviewer leaves them with:  decklight review ${relative(cwd, deckPath) || name}\n`);
    return 0;
  }
  const { records, skipped } = parseReview(read(storePath));
  const slides = indexDeckFile(read(deckPath));
  const all = foldReview(records);
  const wantAll = argv.includes('--all');
  const onlyOpen = argv.includes('--unresolved');
  const resolvedCount = all.filter((c) => c.resolved).length;
  const shown = all.filter((c) => (onlyOpen || !wantAll ? !c.resolved : true));

  if (!all.length) {
    out.write(`${name} — ${storeName} exists but holds no comments\n`);
    return 0;
  }

  const { groups, orphans } = groupComments(shown, slides);
  const openCount = all.length - resolvedCount;
  out.write(`${name} — ${openCount} open comment${openCount === 1 ? '' : 's'}`
    + `${resolvedCount ? `, ${resolvedCount} resolved` : ''}`
    + ` across ${slides.length} slide${slides.length === 1 ? '' : 's'}\n`);
  if (skipped) out.write(`  (${skipped} line(s) in ${storeName} could not be read and were skipped)\n`);
  out.write('\n');

  const inRepo = gitAvailable(deckDir) && inGitRepo(deckDir);
  /**
   * Which version this was written against, and how far the deck has moved.
   *
   * Silent when there is nothing to say — no commit recorded, or the deck has
   * not moved — because a line that appears on every comment is a line nobody
   * reads by the third one.
   */
  const against = (c) => {
    if (!c.deck) return '';
    if (!inRepo || !knowsCommit(c.deck, deckDir)) return ` · against ${c.deck}`;
    const n = commitsSince(c.deck, deckDir);
    if (n === null) return ` · against ${c.deck}`;
    return n === 0 ? ` · against ${c.deck} (still current)`
      : ` · against ${c.deck}, ${n} commit${n === 1 ? '' : 's'} ago`;
  };

  const printOne = (c, indent = '    ') => {
    const who = c.by ? c.by.replace(/\s*<[^>]*>$/, '') : 'someone';
    out.write(`${indent}${who}${c.at ? ` · ${ago(c.at)}` : ''}${against(c)}`
      + `${c.resolved ? '  ✓ resolved' : ''}  [${c.id}]\n`);
    for (const line of String(c.body ?? '').split('\n')) out.write(`${indent}  ${line}\n`);
    for (const r of c.replies ?? []) {
      const rw = r.by ? r.by.replace(/\s*<[^>]*>$/, '') : 'someone';
      out.write(`${indent}  ↳ ${rw}${r.at ? ` · ${ago(r.at)}` : ''}\n`);
      for (const line of String(r.body ?? '').split('\n')) out.write(`${indent}    ${line}\n`);
    }
    out.write('\n');
  };

  for (const g of groups) {
    // The verdict rides on the GROUP heading when every comment in it agrees,
    // which is the usual case and keeps the noise off the prose.
    const notes = new Set(g.items.map((c) => c.anchor.verdict).filter((v) => VERDICT_NOTE[v]));
    const moved = g.items.find((c) => c.anchor.movedFrom);
    out.write(`  slide ${g.slide} · ${g.title}`
      + `${moved ? `   (was slide ${moved.anchor.movedFrom} when this was written)` : ''}\n`);
    for (const v of notes) out.write(`    ⚠ ${VERDICT_NOTE[v]}\n`);
    for (const c of g.items) printOne(c);
  }
  if (orphans.length) {
    out.write(`  ${orphans.length} comment${orphans.length === 1 ? '' : 's'} on slides that are gone\n`);
    out.write(`    ⚠ ${VERDICT_NOTE.orphaned}\n`);
    for (const c of orphans) {
      out.write(`    (was slide ${c.slide}${c.title ? ` · ${c.title}` : ''})\n`);
      printOne(c, '    ');
    }
  }
  if (!groups.length && !orphans.length) {
    out.write(`  nothing open — all ${all.length} resolved (--all to see them)\n`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  try { process.exitCode = commentsMain(); }
  catch (e) { process.stderr.write(`decklight comments: ${oneline(e)}\n`); process.exitCode = 1; }
}
