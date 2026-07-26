#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight restore — a deck's durable history, and the way back to any of it.
 *
 *   decklight restore <deck.html>          list the commits that touched it
 *   decklight restore <deck.html> <ref>    put the deck back to that commit
 *
 * This is the git-level sibling of the in-memory Z/⇧Z stack (SPEC §8): it
 * survives a restart and spans whole agent sessions, so it is what you reach
 * for to undo a run rather than a keystroke.
 *
 * Restoring is NON-DESTRUCTIVE. Commit N's content is written as a NEW commit
 * on top; history is never rewritten and `git reset --hard` is never run. So
 * overshooting costs nothing — restore forward again and the round trip is
 * two more commits, not a lost afternoon. And because a restore only ever
 * ADDS, the deck you were on a moment ago is itself still in the list.
 *
 * Only the deck file is touched, matching the autocommit's single-file
 * staging: a restore is not a checkout of somebody's whole tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, basename } from 'node:path';
import { isMain } from '../tools/args.mjs';
import { git, inGitRepo, isIdentityError, oneline } from './git.mjs';

// A control character, written as an escape so no editor can silently strip
// it: a commit subject may contain any printable character, so a printable
// separator would corrupt the row the first time someone used it in a message.
const SEP = '\x01';

/**
 * The commits that touched this deck, newest first: `{ hash, when, subject }`.
 * `run` is the git invoker, injected so this is testable without a repo.
 * Returns [] for a file git has never seen.
 */
export function deckHistory(deckPath, cwd, run = git) {
  const rel = relative(cwd, deckPath) || basename(deckPath);
  const out = run(['log', `--format=%h${SEP}%ar${SEP}%s`, '--', rel], cwd);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, when, subject] = line.split(SEP);
    return { hash, when, subject };
  });
}

/** One list row, aligned enough to scan: `a1b2c3d · 2 hours ago · subject`. */
export function formatEntry({ hash, when, subject }, pad = 14) {
  return `${hash}  ${String(when).padEnd(pad)}  ${subject}`;
}

/**
 * Read the deck's content AT `ref` without going through git()'s trim — a
 * deck's trailing newline is content, and a restore that quietly reformats
 * the file is not a restore.
 */
function showAt(ref, rel, cwd, exec = execFileSync) {
  return exec('git', ['show', `${ref}:./${rel}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The deck exactly as it was at `ref` — what the restore overlay previews
 * before you commit to going back (#129). Throws on an unknown ref.
 */
export function deckAt(deckPath, ref, cwd, exec = execFileSync) {
  const rel = relative(cwd, deckPath) || basename(deckPath);
  return showAt(ref, rel, cwd, exec);
}

/**
 * Give a previewed deck a root `<base>`, because it is served from `/edit/`
 * rather than the root and every relative `../dist` and `./casts` path in it
 * would otherwise resolve one directory too deep — a preview with no runtime.
 *
 * `<head>` is optional in HTML, so a deck can perfectly well not have one:
 * fall through to `<html>`, then to the front of the document, rather than
 * silently doing nothing. An author's own `<base>` is left alone.
 */
export function withBaseHref(html, href = '/') {
  const tag = `<base href="${href}">`;
  if (/<base\b/i.test(html)) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => m + tag);
  if (/<html(\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${tag}</head>`);
  return tag + html;
}

/** Commit just the deck, falling back to a decklight identity like autocommit. */
function commitDeck(rel, cwd, message, run = git) {
  run(['add', '--', rel], cwd);
  try {
    run(['commit', '-m', message, '--', rel], cwd);
  } catch (e) {
    if (!isIdentityError(e)) throw e;
    run(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost',
      'commit', '-m', message, '--', rel], cwd);
  }
}

/**
 * Put `deckPath` back to `ref`, as a new commit on top.
 *
 * Uncommitted work is never silently discarded: if the deck has unsaved
 * changes they are committed first, so the state you were in is itself
 * recoverable from the list afterwards. Content is read BEFORE anything is
 * written, so an unknown ref cannot leave a half-restored file.
 */
export function restoreDeck(deckPath, ref, cwd, { run = git, exec = execFileSync } = {}) {
  const rel = relative(cwd, deckPath) || basename(deckPath);
  const content = showAt(ref, rel, cwd, exec); // throws on an unknown ref — before any write
  const short = run(['rev-parse', '--short', ref], cwd);

  const dirty = !!run(['status', '--porcelain', '--', rel], cwd);
  if (dirty) commitDeck(rel, cwd, `decklight: save before restoring ${short}`, run);

  writeFileSync(deckPath, content);
  const changed = !!run(['status', '--porcelain', '--', rel], cwd);
  if (changed) commitDeck(rel, cwd, `decklight: restore ${short}`, run);
  return { short, savedFirst: dirty, changed };
}

const HELP = `decklight restore — a deck's history, and the way back to any of it

Usage:
  decklight restore <deck.html>            list the commits that touched the deck
  decklight restore <deck.html> <ref>      restore the deck to that commit

Restoring writes that version as a NEW commit on top — history is never
rewritten, so overshooting is free: restore forward again. Only the deck file
is touched, and uncommitted changes are committed first rather than lost.`;

export async function restoreMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  const [deckArg, ref] = argv.filter((a) => !a.startsWith('-'));
  if (!deckArg) { console.error('decklight restore: name the deck to restore\n\n' + HELP); return 1; }

  const deckPath = resolve(deckArg);
  if (!existsSync(deckPath)) { console.error(`decklight restore: no such file: ${deckArg}`); return 1; }
  const cwd = dirname(deckPath);
  if (!inGitRepo(cwd)) {
    console.error(`decklight restore: ${basename(deckPath)} is not in a git repository — there is no history to restore`);
    return 1;
  }

  let entries;
  try { entries = deckHistory(deckPath, cwd); }
  catch (e) { console.error(`decklight restore: could not read the history: ${oneline(e)}`); return 1; }
  if (!entries.length) {
    console.error(`decklight restore: git has no record of ${basename(deckPath)} — commit it once and this becomes useful`);
    return 1;
  }

  if (!ref) {
    const pad = Math.max(...entries.map((e) => e.when.length));
    console.log(`${basename(deckPath)} — ${entries.length} commit${entries.length === 1 ? '' : 's'}, newest first:\n`);
    for (const e of entries) console.log('  ' + formatEntry(e, pad));
    console.log(`\nRestore one with:  decklight restore ${deckArg} ${entries[Math.min(1, entries.length - 1)].hash}`);
    return 0;
  }

  let result;
  try { result = restoreDeck(deckPath, ref, cwd); }
  catch (e) { console.error(`decklight restore: cannot restore ${ref}: ${oneline(e)}`); return 1; }

  if (result.savedFirst) console.log(`  uncommitted changes committed first — they are in the list too`);
  if (!result.changed) { console.log(`${basename(deckPath)} was already at ${result.short} — nothing to do`); return 0; }
  console.log(`${basename(deckPath)} restored to ${result.short} — as a new commit, so you can restore forward again`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await restoreMain());
