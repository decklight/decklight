// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The git plumbing decklight reaches for when it keeps the durable record —
// repo creation, the autosave commit, "am I in a repo?". It was hand-rolled in
// edit, dev and init, and the identity-missing regex had already drifted apart
// between them (init learned `auto-detect`, edit never did). One home now.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

/** Run git in `cwd`, return trimmed stdout; throws on failure (stderr on e.stderr). */
export const git = (args, cwd, exec = execFileSync) =>
  exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Is `dir` inside a git work tree? (exec injectable for tests) */
export function inGitRepo(dir, exec = execFileSync) {
  try { return git(['rev-parse', '--is-inside-work-tree'], dir, exec) === 'true'; } catch { return false; }
}

/**
 * A git error that means "no identity configured" — the one failure decklight
 * handles rather than surfaces, because the commit is the player's, not a
 * human's. The superset of what edit and init each used to test for.
 */
export const isIdentityError = (e) =>
  /user\.(name|email)|tell me who you are|auto-detect/i.test(String(e.stderr || e));

/** A git error squeezed onto one line, for a note that never becomes an exit. */
export const oneline = (e) => String(e.stderr || e.message || e).replace(/\s+/g, ' ').trim().slice(0, 160);

// The starter .gitignore a decklight-created repository begins with: generated
// artifacts (screenshot evidence, OS junk, narration audio) stay out of the
// autocommit loop and out of a hasty `git add -A`. Three entries, one comment —
// a starter the player owns from the first commit, not an ignore database.
export const STARTER_GITIGNORE = `.shots/
.DS_Store

# narration audio is bulky — but cloud-generated narration costs money to regenerate; delete this line to version yours
voiceover/
`;

/**
 * Create a git repository in `dir` — the one shared seam for every place
 * decklight creates a repo (`edit`/`dev` with --git today, init's offer per
 * #50). Runs `git init`, then writes the starter .gitignore — after init and
 * before any initial commit the caller makes, so a `git add -A` opening
 * commit picks it up. The repo-creation moment is the only time decklight
 * touches ignore rules: an existing .gitignore is never appended to or
 * merged, and a repository decklight didn't create never gets one. Returns
 * true when the starter file was written. Throws when `git init` fails.
 */
export function createRepo(dir) {
  git(['init'], dir);
  const ignorePath = resolve(dir, '.gitignore');
  if (existsSync(ignorePath)) return false;
  writeFileSync(ignorePath, STARTER_GITIGNORE);
  return true;
}

/** Commit the deck if it changed. Returns true when a commit was made. */
export function gitAutocommit(deckPath, cwd, message = `decklight: autosave ${basename(deckPath)}`) {
  try {
    if (!git(['status', '--porcelain', '--', deckPath], cwd)) return false;
    git(['add', '--', deckPath], cwd);
    try {
      git(['commit', '-m', message, '--', deckPath], cwd);
    } catch (e) {
      // a fresh machine has no git identity — commit anyway rather than
      // silently dropping the safety net, without touching global config
      if (!isIdentityError(e)) throw e;
      git(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost',
        'commit', '-m', message, '--', deckPath], cwd);
    }
    return true;
  } catch (e) {
    console.error(`  git autocommit failed: ${oneline(e)}`);
    return false;
  }
}
