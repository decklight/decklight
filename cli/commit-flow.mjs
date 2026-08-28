// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Committing on YOUR word, with a snapshot underneath so the word can wait.
 *
 * The cadence used to commit the deck every `--commit-every` seconds. It cost
 * nothing to write and it produced the thing everyone actually saw: a column of
 * `decklight: autosave talk.html`, one every five minutes, in which no commit
 * marks anything and `git log` answers no question. The commits were a backup
 * wearing a history's clothes.
 *
 * So the two jobs are separated, because they were never the same job:
 *
 *   the BACKUP is a snapshot, and it is silent. Every tick, the deck's current
 *   bytes are written to `refs/decklight/wip` — a real commit object, parented
 *   on HEAD, reachable by name and by nothing else. It is not on your branch,
 *   it does not move your branch, `git log` never shows it, and a push never
 *   carries it. A crash costs you `git show decklight/wip:<deck>`, not an
 *   afternoon.
 *
 *   the HISTORY is a commit, and it is yours. decklight asks — once per stretch
 *   of uncommitted work — and the commit happens when you answer, with a
 *   message about what changed.
 *
 * ONE NAG PER EPISODE is the load-bearing rule, and it is the one the push
 * toast (src/core/devmode.js) learned first: "a limit expressed as a count
 * cannot become a limit expressed as every few minutes by accident, which is
 * what happens to interval-based nudges and why people turn them off". The
 * trigger here is time OR size, whichever comes first, but it fires once and
 * then stays quiet until a commit resets the episode. An unanswered nag is an
 * answer.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { git } from './git.mjs';
import { putBlob } from './git-tree.mjs';

/** The ref the snapshot lives on — outside every branch, on purpose. */
export const WIP_REF = 'refs/decklight/wip';

/** How long uncommitted work may sit before the nag, and how much may change. */
export const NAG_AFTER_MS = 10 * 60 * 1000;
export const NAG_AFTER_LINES = 40;

/**
 * How much of the deck differs from HEAD, and whether anything does.
 *
 * `--numstat` over the deck alone, because the deck is the only thing decklight
 * commits and the only thing it is entitled to describe. A repository holding
 * somebody's whole project reports its own state through git; this reports the
 * deck's.
 *
 * A deck with no HEAD to compare against (the very first commit has not
 * happened) counts as dirty with unknown size: there is something to commit,
 * and no numstat can say how much.
 */
export function deckDirty(cwd, deckRel, { run = git } = {}) {
  let out;
  try { out = run(['diff', '--numstat', 'HEAD', '--', deckRel], cwd); }
  catch { return { dirty: true, lines: 0, firstCommit: true }; }
  const line = (out ?? '').split('\n').find(Boolean);
  if (!line) {
    // Nothing against HEAD — but an untracked deck has no diff either, and it
    // is the most uncommitted a file can be.
    let tracked = true;
    try { run(['ls-files', '--error-unmatch', '--', deckRel], cwd); }
    catch { tracked = false; }
    return tracked ? { dirty: false, lines: 0 } : { dirty: true, lines: 0, untracked: true };
  }
  const [add, del] = line.split('\t');
  return { dirty: true, lines: (Number(add) || 0) + (Number(del) || 0) };
}

/**
 * Write the deck's current bytes to the snapshot ref. Returns the sha, or null.
 *
 * Deck-only, and that is the whole reason this is plumbing rather than
 * `git stash create`: stash snapshots every tracked change in the working
 * tree, and decklight commits one file. Someone editing a deck inside a larger
 * repository must not have their unrelated work swept into decklight's ref.
 *
 * Nothing here touches the index, the working tree, or any branch: a blob, a
 * tree built from HEAD's with one path replaced, a commit parented on HEAD, and
 * a ref update. It is invisible until somebody asks for it by name.
 *
 * NEVER FATAL. This is the safety net, so it fails the way a safety net should
 * — quietly, leaving everything else working. A repository mid-rebase, a
 * detached HEAD, a missing object: the editing session carries on.
 */
export function snapshotWip(cwd, deckPath, deckRel, { exec = execFileSync, read = readFileSync } = {}) {
  // git-tree's helpers take `(args, input)` — `mktree` FEEDS ITS ENTRIES ON
  // STDIN, so an adapter that drops the second argument writes an empty tree
  // and reports success. The snapshot then holds a commit with nothing in it,
  // which is the one failure this whole file exists to prevent.
  const g = (args, input) => exec('git', args, { cwd, encoding: 'utf8', input }).trim();
  try {
    const head = g(['rev-parse', 'HEAD']);
    const blob = g(['hash-object', '-w', '--stdin'], read(deckPath));
    const tree = putBlob(g, `${head}^{tree}`, deckRel.split(/[/\\]/).filter(Boolean), blob);
    const sha = g(['commit-tree', tree, '-p', head, '-m',
      `decklight: wip snapshot of ${deckRel}`]);
    g(['update-ref', WIP_REF, sha]);
    return sha;
  } catch { return null; }
}

/**
 * Should we nag right now?
 *
 * Pure, so the whole rule is testable without a clock or a repository — the
 * planServices idiom. `nagged` is the episode latch: once true, nothing here
 * says yes again until a commit clears it.
 */
export function planNag({
  dirty = false, lines = 0, sinceMs = 0, nagged = false, dismissed = false,
  afterMs = NAG_AFTER_MS, afterLines = NAG_AFTER_LINES,
} = {}) {
  if (!dirty || nagged || dismissed) return false;
  return sinceMs >= afterMs || lines >= afterLines;
}

/** What the chip says — the count and the age, so the ask is proportionate. */
export function nagText({ lines = 0, sinceMs = 0 } = {}) {
  const mins = Math.floor(sinceMs / 60000);
  const age = mins >= 60 ? `${Math.floor(mins / 60)}h` : mins >= 1 ? `${mins}m` : 'just now';
  const size = lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'changes';
  return `${size} uncommitted${mins >= 1 ? ` · ${age}` : ''}`;
}

/** The line author prints when the snapshot is what stands behind the nag. */
export function wipLine(deckRel) {
  return `  git: committing ${deckRel} when you say so — a silent snapshot rides on`
    + ` ${WIP_REF.replace('refs/', '')} in between (git show decklight/wip:${deckRel})`;
}
