#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight history <deck.html>` — what decklight committed, and where it
 * stands against the remote.
 *
 * WHY THIS IS NOT `decklight restore`. `restore` already prints this list, and
 * for a while that was the argument against a second command. But its listing
 * is a MEANS: the footer says `Restore one with: …`, and it exits 1 when there
 * is nothing to restore, because it is an action that could not be performed.
 * This is a READOUT. It answers "where does this deck stand", nobody types
 * "restore" to ask that, and it must not fail just because the answer is
 * "nowhere yet" — a readout that exits non-zero on an empty history breaks
 * `decklight history && …` and reads as a malfunction.
 *
 * What it adds over that listing is the half `restore` has no business knowing:
 * which commits exist nowhere but this machine, and what to type about it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { deckHistory, formatEntry } from './restore.mjs';
import {
  gitAvailable, inGitRepo, oneline, pushHint, remoteLine, remoteState, unpushed,
} from './git.mjs';
import { argReader, isMain } from '../tools/args.mjs';

const HELP = `decklight history [deck.html] — the commits behind a deck, and what is unpushed

  -n <count>   how many to show (default 20)
  --all        every commit
  --help, -h   this

  A readout, never a write. To go back to one of these:  decklight restore <deck> <hash>
`;

/** Marks each entry with whether it exists anywhere but here. Pure. */
export function markPushState(entries, localHashes) {
  const set = localHashes ? new Set(localHashes) : null;
  return entries.map((e) => ({ ...e, pushed: set ? !set.has(e.full) : null }));
}

/**
 * The single deck in `dir`, or null when the answer is not single.
 *
 * Nothing else in the CLI infers a deck, so the inference is deliberately
 * narrow: a `.html` file that carries decklight's own runtime marker. A folder
 * with three decks gets a refusal that names them rather than a guess.
 */
export function findDeck(dir, read = readFileSync, list = readdirSync) {
  let names;
  try { names = list(dir).filter((f) => /\.html?$/i.test(f)); } catch { return { decks: [] }; }
  const decks = names.filter((f) => {
    try { return /data-decklight-runtime|Decklight\s*\.\s*init/.test(read(join(dir, f), 'utf8')); }
    catch { return false; }
  });
  return { decks };
}

export function historyMain(argv = process.argv.slice(2)) {
  const { opt } = argReader(argv);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }

  const cwd = process.cwd();
  let deckArg = argv.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deckArg) {
    const { decks } = findDeck(cwd);
    if (decks.length === 1) [deckArg] = decks;
    else if (!decks.length) {
      console.error('decklight history: name the deck — no decklight deck found in this directory');
      return 1;
    } else {
      console.error(`decklight history: name the deck — this directory has ${decks.length}`
        + ` (${decks.slice(0, 4).join(', ')}${decks.length > 4 ? ', …' : ''})`);
      return 1;
    }
  }

  const deckPath = resolve(cwd, deckArg);
  const name = basename(deckPath);
  if (!existsSync(deckPath)) { console.error(`decklight history: no such file: ${deckArg}`); return 1; }

  const root = dirname(deckPath);
  // git missing and "not a repository" are different answers, and inGitRepo
  // swallows the first into the second.
  if (!gitAvailable(root)) {
    console.error('decklight history: git is not installed — decklight\'s durable record needs it');
    return 1;
  }
  if (!inGitRepo(root)) {
    console.error(`decklight history: ${name} is not in a git repository — there is no history yet`
      + ' (decklight init --git, or git init)');
    return 1;
  }

  // The state comes first because it answers the question that would otherwise
  // look like a failure: in a repository with no commits at all, `git log`
  // exits non-zero ("does not have any commits yet"), and reporting that as a
  // read error would turn the ordinary first minute of a deck's life into an
  // error message.
  const state = remoteState(root);
  if (state.state === 'unborn') {
    console.log(`${name} — nothing committed yet`);
    console.log('  the repository exists; the first commit does not');
    return 0;
  }

  let entries;
  try { entries = deckHistory(deckPath, root); }
  catch (e) { console.error(`decklight history: could not read the history: ${oneline(e)}`); return 1; }
  const marked = markPushState(entries, ['no-remote', 'ambiguous-remote'].includes(state.state)
    ? null : unpushed(root));

  // Not an error: a deck git has never seen is a true and useful answer, and it
  // is the state every new deck starts in.
  if (!marked.length) {
    console.log(`${name} — git has no record of this file yet`);
    console.log(`  ${remoteLine(state)}`);
    return 0;
  }

  const all = argv.includes('--all');
  const limit = all ? marked.length : Math.max(1, Number(opt('-n', 20)) || 20);
  const shown = marked.slice(0, limit);
  const pad = Math.max(...shown.map((e) => e.when.length));

  console.log(`${name} — ${marked.length} commit${marked.length === 1 ? '' : 's'}, newest first\n`);
  for (const e of shown) {
    // The ↑ trails the row rather than leading it, so the hashes still line up
    // and an all-pushed deck reads clean rather than column-padded.
    console.log(`  ${formatEntry(e, pad)}${e.pushed === false ? '  ↑' : ''}`);
  }
  if (marked.length > shown.length) console.log(`  … ${marked.length - shown.length} more (--all)`);

  console.log(`\n  ${remoteLine(state)}`);
  const hint = pushHint(state);
  if (hint) console.log(`  ${hint.text.replace(/^↑\d+ unpushed — /, 'push them with:  ')}`);
  console.log(`  restore one with:  decklight restore ${relative(cwd, deckPath) || name}`
    + ` ${shown[Math.min(1, shown.length - 1)].hash}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(historyMain());
