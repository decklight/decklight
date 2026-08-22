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
import { fingerprint, resolveAnchor, VERDICT_NOTE } from '../src/core/review.js';
import { reviewPathFor, parseReview, serializeRecord, foldReview, mergeById } from './review-store.mjs';
import { findDeck } from './history.mjs';
import { gitAvailable, inGitRepo, gitAutocommit, oneline } from './git.mjs';

const HELP = `usage: decklight comments <deck.html> [--unresolved] [--all] [--import <file>]
  what reviewers said, resolved against the deck as it is now

  --unresolved   only the ones nobody has closed off
  --all          include resolved ones (default: they are counted, not printed)
  --import FILE  merge a reviewer's file into this deck's own, skipping anything
                 already there, and commit it — the return path for a reviewer
                 who was sent the deck and has no clone

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

  const printOne = (c, indent = '    ') => {
    const who = c.by ? c.by.replace(/\s*<[^>]*>$/, '') : 'someone';
    out.write(`${indent}${who}${c.at ? ` · ${ago(c.at)}` : ''}`
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
