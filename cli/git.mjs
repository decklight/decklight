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
// ── when to commit (#71) ───────────────────────────────────────────────────
// A timer is the wrong boundary for agent-authored edits: the commits land on
// a five-minute clock that lines up with nothing the agent did, and every one
// of them says `autosave`. After a long session you get a wall of identical
// messages and no way to see what changed when. `agent` mode commits per
// completed agent edit instead, with the agent's own summary as the subject.

export const GIT_MODES = ['timer', 'agent', 'off'];

/**
 * Which commit policy is in force. `--no-git` still means off; the default is
 * `agent`, which is a SUPERSET of `timer` — the cadence still runs underneath
 * (see shouldCommit), so defaulting to it adds real commit messages for agent
 * edits without taking the periodic safety net away from anyone. Anything
 * unrecognised falls back to the default rather than failing: a typo should
 * not cost you the safety net.
 */
export function resolveGitMode(args = [], fallback = 'agent') {
  if (args.includes('--no-git')) return 'off';
  const i = args.indexOf('--git-mode');
  const v = i >= 0 ? args[i + 1] : null;
  return GIT_MODES.includes(v) ? v : fallback;
}

/**
 * Should this moment produce a commit? Pure, so the whole decision table is
 * testable without a repository or an agent (the planServices idiom).
 *
 * `ev.kind` is 'timer' (the cadence fired), 'agent' (a job finished — with
 * `ok` and `changed`), or 'bookend' (start/stop of a session).
 */
export function shouldCommit(mode, ev = {}) {
  if (mode === 'off') return false;
  // The cadence runs in agent mode too — it is the backstop for everything an
  // agent job cannot see: your own edits, and any agent driven from outside the
  // A flow. Suppressing it there would mean a crashed session loses hand edits
  // entirely, which is the one thing autocommit exists to prevent. It is only
  // held back WHILE a job is in flight, so no commit ever captures a
  // half-finished agent run. (Two commits cannot race: gitAutocommit no-ops on
  // a clean tree.)
  if (ev.kind === 'timer') return !ev.agentBusy;
  // a failed or cancelled job leaves the tree alone; an edit that changed
  // nothing is not worth a commit that says it did
  if (ev.kind === 'agent') return mode === 'agent' && ev.ok === true && ev.changed === true;
  return true; // bookends: a session's first and last commit, in any live mode
}

/**
 * A commit subject from text an AGENT wrote — untrusted, and heading for a
 * command line. Collapse it to one line (a subject is one line by definition),
 * cap it, and refuse to let it start with `-` so it can never be read as an
 * option by anything downstream. Empty or unusable falls back.
 */
export function commitSubject(raw, fallback) {
  const one = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return fallback;
  const capped = one.length > 72 ? one.slice(0, 71) + '…' : one;
  return /^-/.test(capped) ? `agent: ${capped}` : capped;
}

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
