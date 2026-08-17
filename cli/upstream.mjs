// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `present`'s upstream check — SPEC PRESENTING (`PRESENT#UPSTREAM`).
 *
 * A deck cloned before a talk goes stale silently: `present` reads the file
 * once and serves those bytes, so a fix the author pushed an hour ago is
 * invisible. This asks the upstream, and — with `--upstream-pull` — lets the
 * deck fast-forward to it.
 *
 * ## What makes this safe, in one place
 *
 * The feature is UNREACHABLE for the deck the rest of `present` is written
 * against. A deck you were emailed is a single file with no repository, no
 * remote and no upstream, so `resolveUpstream` returns `no-repo` and nothing —
 * not the routes, not the timer — is ever registered.
 *
 * The gate that matters most is `untracked`, and it is not obvious: anyone
 * whose $HOME is a git repository (yadm, chezmoi, a dotfiles clone) has every
 * deck in ~/Downloads "inside a clone". Requiring the deck to be a file that
 * repository actually VERSIONS is the honest reading of "the deck lives in a
 * git clone" — without it, presenting a downloaded deck would offer to
 * fast-forward somebody's home directory.
 *
 * ## Never a hang, never a false pass
 *
 * Every git call is async (`execFile`): a synchronous child would block the
 * event loop of the server serving the talk, and a 15-second fetch would be a
 * 15-second black slide. Every one runs with prompts disabled — the env from
 * cli/git.mjs, which covers ssh as well as https — and a timeout, so an
 * unreachable remote is an answer rather than a stall.
 *
 * And a fetch that FAILED is never reported as up to date. The comparison
 * against a stale remote-tracking ref is simply not made; the state is the
 * failure, `checkedAt` stays null, and "unchecked" is its own answer — the same
 * rule signature verification already follows (SPEC PRESENTING: when it cannot
 * be done here, that is said as its own state and never as a pass).
 */

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, parse, resolve } from 'node:path';
import { classifyRemoteError, noPromptEnv, oneline, parseAheadBehind } from './git.mjs';

/** Every answer this can give. Frozen so a typo is a crash, not a silent miss. */
export const UPSTREAM_STATES = Object.freeze([
  'no-repo', 'untracked', 'detached', 'no-upstream',
  'up-to-date', 'behind', 'ahead', 'diverged',
  'offline', 'no-credential', 'timeout', 'error', 'disabled',
]);

/** git, asynchronously, with prompts off and a bound. Never throws. */
export function runGit(args, { cwd, timeoutMs = 8000, exec = execFile } = {}) {
  return new Promise((done) => {
    exec('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: noPromptEnv() },
      (err, stdout, stderr) => done({
        ok: !err, stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim(), err,
      }));
  });
}

/**
 * The `-c` overrides every invocation carries.
 *
 * `core.hooksPath` points at a directory that does not exist and is never
 * created: decklight is not the presenter typing `git pull`, and it must not
 * run arbitrary local scripts in the middle of a talk. The rest keep a
 * background maintenance task, a filesystem monitor or a submodule walk from
 * starting behind a slide.
 */
export const SAFE_CONFIG = Object.freeze([
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
  '-c', 'credential.interactive=false',
]);

/** Why a git failure happened, as one of this module's states. */
export function classifyFailure({ err, stderr }) {
  if (err?.killed || err?.signal) return 'timeout';
  const kind = classifyRemoteError({ stderr, message: err?.message });
  if (kind === 'denied') return 'no-credential';
  if (kind === 'offline') return 'offline';
  return 'error';
}

/**
 * Is the check even a question here? Resolved once, before anything is served.
 *
 * Returns `{ state, repoRoot, branch, upstream }`. Anything but `ok` means the
 * feature is absent — no routes, no timer, no line in the label.
 */
export async function resolveUpstream(deckPath, { run = runGit, home = homedir() } = {}) {
  // REALPATH FIRST. `git rev-parse --show-toplevel` answers with symlinks
  // resolved, and on macOS /tmp and /var are symlinks — so comparing it against
  // an unresolved deck path makes `relative()` produce a ../../.. escape, the
  // tracked check fails, and the feature silently never activates for anyone
  // whose deck lives under a symlinked path. It fails CLOSED, which is why it
  // would have gone unnoticed rather than gone wrong.
  let full;
  try { full = realpathSync(resolve(deckPath)); } catch { full = resolve(deckPath); }
  const cwd = dirname(full);
  const no = (state) => ({ state, repoRoot: null, branch: null, upstream: null });

  const top = await run(['rev-parse', '--show-toplevel'], { cwd });
  if (!top.ok || !top.stdout) return no('no-repo');
  // resolve() because git answers in FORWARD SLASHES on every platform,
  // including Windows — so `C:/Users/x` has to become `C:\Users\x` before it
  // can be compared with a path Node produced, or the tracked check below
  // compares two spellings of the same directory and refuses every deck.
  const repoRoot = resolve(top.stdout);

  // A repository whose root is $HOME or a filesystem root is somebody's whole
  // machine, not a deck's home. Belt and braces behind the tracked check below.
  if (repoRoot === resolve(home) || repoRoot === parse(repoRoot).root) return no('untracked');

  // THE GATE THAT MATTERS: the deck must be a file this repository versions.
  // Without it, every deck in ~/Downloads is "inside a clone" for anyone whose
  // home directory is one.
  // Asked from the DECK'S OWN DIRECTORY, by basename — git resolves it against
  // the repository itself. Computing the relative path here instead means
  // comparing two absolute paths, and two absolute paths for the same file
  // disagree more often than they look: git answers in forward slashes on every
  // platform, macOS resolves /tmp and /var through symlinks, and a Windows temp
  // directory is an 8.3 short name (RUNNER~1) that realpath may or may not
  // expand. Every one of those made this refuse a deck it should have accepted.
  const tracked = await run(['ls-files', '--error-unmatch', '--', basename(full)], { cwd });
  if (!tracked.ok) return no('untracked');

  const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot });
  if (!branch.ok || !branch.stdout) return { ...no('detached'), repoRoot };

  const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: repoRoot });
  if (!up.ok || !up.stdout) return { ...no('no-upstream'), repoRoot, branch: branch.stdout };

  return { state: 'ok', repoRoot, branch: branch.stdout, upstream: up.stdout };
}

/**
 * One check cycle: fetch, then compare. Returns the status the routes serve.
 *
 * The fetch carries no refspec and no remote name — `git fetch` with no
 * arguments fetches whatever the current branch tracks, and `@{upstream}` is a
 * constant git resolves itself. NOTHING derived from anything reaches a git
 * argument, which is a property worth stating because it is the one that makes
 * the route safe by construction rather than by validation.
 */
export async function checkUpstream(ctx, { run = runGit, now = () => Date.now() } = {}) {
  const { repoRoot, branch, upstream } = ctx;
  const base = { branch, upstream, behind: 0, ahead: 0, dirty: false, commits: [], checkedAt: null };

  const fetched = await run([...SAFE_CONFIG, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules'],
    { cwd: repoRoot, timeoutMs: 15000 });
  if (!fetched.ok) {
    // The comparison against a STALE ref is deliberately not made: "I could not
    // ask" must never come out as "up to date".
    const state = classifyFailure(fetched);
    return { ...base, state, message: FAILURE_MESSAGE[state](upstream, oneline(fetched.stderr || fetched.err)) };
  }

  const counts = parseAheadBehind(
    (await run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd: repoRoot })).stdout,
  );
  if (!counts) return { ...base, state: 'error', message: 'could not count against ' + upstream };

  const dirty = Boolean((await run(['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot })).stdout);
  const log = await run(['log', '--format=%h\x01%s', '-n', '5', 'HEAD..@{upstream}'], { cwd: repoRoot });
  const commits = log.ok && log.stdout
    ? log.stdout.split('\n').map((l) => { const [hash, subject] = l.split('\x01'); return { hash, subject }; })
    : [];

  const state = counts.behind && counts.ahead ? 'diverged'
    : counts.behind ? 'behind'
    : counts.ahead ? 'ahead'
    : 'up-to-date';
  return { ...base, ...counts, dirty, commits, state, checkedAt: now(), message: describe(state, { ...counts, upstream, dirty }) };
}

const FAILURE_MESSAGE = {
  offline: (up) => `could not reach ${up.split('/')[0]} — unchecked, NOT up to date`,
  'no-credential': (up) => `${up.split('/')[0]} refused an anonymous fetch — unchecked, NOT up to date`,
  timeout: (up) => `${up.split('/')[0]} did not answer in 15s — unchecked, not up to date`,
  error: (up, why) => `git said: ${why}`,
};

/** The sentence for a state that was actually determined. */
export function describe(state, { behind = 0, ahead = 0, upstream = '', dirty = false } = {}) {
  const s = {
    'up-to-date': `up to date with ${upstream}`,
    behind: `${behind} commit${behind === 1 ? '' : 's'} behind ${upstream}`,
    ahead: `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${upstream} — nothing to pull`,
    diverged: `diverged from ${upstream} (${ahead} ahead, ${behind} behind) — a fast-forward is not possible`,
  }[state] ?? state;
  return dirty && state === 'behind' ? `${s} · uncommitted changes here` : s;
}

/**
 * May this status be pulled? Pure, and re-asked against a FRESH check
 * immediately before the merge rather than trusted from the cached one.
 */
export function canPull(status, { offered = false } = {}) {
  if (!offered) return { ok: false, state: 'not-offered', message: 'the update control is off' };
  if (!status) return { ok: false, state: 'error', message: 'nothing has been checked yet' };
  if (status.state === 'up-to-date') return { ok: false, state: 'up-to-date', message: 'already up to date' };
  if (status.state === 'ahead') return { ok: false, state: 'ahead', message: 'nothing to pull' };
  if (status.state === 'diverged') {
    return { ok: false, state: 'diverged', message: 'diverged — a fast-forward is not possible' };
  }
  if (status.state !== 'behind') {
    return { ok: false, state: status.state, message: status.message ?? 'not in a state that can be pulled' };
  }
  // A checkout over uncommitted work is how somebody loses an edit they made in
  // the ten minutes before a talk.
  if (status.dirty) {
    return { ok: false, state: 'dirty', message: 'uncommitted changes here — commit or stash them first' };
  }
  return { ok: true, state: 'behind' };
}

/**
 * Why this run is not checking at all, as a reason string, or false.
 *
 * The `suppressed()` shape from cli/update-check.mjs, so a test reads like the
 * rule. Deliberately NOT suppressed on a non-TTY: the answer here reaches a
 * route as well as a terminal, and gating on a TTY would make the feature
 * untestable and invisible to the deck.
 */
export function upstreamSuppressed({ args = [], env = process.env } = {}) {
  if (args.includes('--no-upstream')) return '--no-upstream';
  if (args.includes('--check')) return '--check';
  if (env.DECKLIGHT_NO_UPSTREAM_CHECK) return 'DECKLIGHT_NO_UPSTREAM_CHECK is set';
  if (env.CI) return 'CI';
  return false;
}

/**
 * How often to look, or 0 for "only when asked".
 *
 * `0` turns off the TIMER, not the feature: the manual check and the update
 * control stay, which is what somebody who does not want background network
 * during a talk actually wants. `--no-upstream` is how you turn it all off, and
 * the two being different is the point.
 *
 * A typo falls back to the default rather than disabling anything —
 * resolveGitMode's rule: a mistyped flag must not silently cost you the thing
 * you were configuring.
 */
export function resolveInterval(args = []) {
  const i = args.indexOf('--upstream-every');
  if (i < 0) return 10 * 60_000;
  const raw = Number(args[i + 1]);
  if (raw === 0) return 0;
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 10;
  return Math.max(60_000, minutes * 60_000);
}
