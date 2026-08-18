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

/**
 * The sha of the commit `gitAutocommit` last made, or null.
 *
 * Kept beside the commit rather than returned in its place because every
 * existing caller treats the return value as a boolean — "did anything land" —
 * and widening that to an object would put a truthiness question in front of
 * the safety net. `--commit-messages` is the only caller that needs the sha,
 * and it reads it immediately.
 */
export let lastCommitSha = null;

export function gitAutocommit(deckPath, cwd, message = `decklight: autosave ${basename(deckPath)}`) {
  lastCommitSha = null;
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
    try { lastCommitSha = git(['rev-parse', 'HEAD'], cwd); } catch { lastCommitSha = null; }
    return true;
  } catch (e) {
    console.error(`  git autocommit failed: ${oneline(e)}`);
    return false;
  }
}

// ── the remote half ────────────────────────────────────────────────────────
//
// Everything above is LOCAL: does a repo exist, is the tree dirty, commit it.
// That was the whole vocabulary, and it is why decklight could commit
// diligently for a week and never once mention that none of it existed anywhere
// but this laptop.
//
// Two rules govern this section, and both are learned rather than assumed:
//
// NEVER A HANG. `GIT_TERMINAL_PROMPT=0` is what cloneMarketplace already uses,
// and it is HALF the answer: it stops git's own prompts and the https askpass,
// while an `ssh://` remote will still sit forever on a host-key or passphrase
// question nobody is there to type. `ssh -oBatchMode=yes` is the other half.
// Blanking the askpass variables stops a GUI credential window opening behind a
// headless probe, without disabling real credential HELPERS (osxkeychain,
// libsecret), which is what makes a private remote work at all.
//
// NEVER A FETCH YOU DID NOT ASK FOR. cli/marketplace.mjs already decided this
// for catalogs — "nothing ever pulls into it, which is what keeps decklight out
// of the credential-helper trap a background `git pull` walks into" — and the
// same holds here. Everything the author loop reads (`unpushed`, `@{u}`) is a
// LOCAL read of remote-tracking refs and needs no network at all. `behind` is
// therefore as fresh as your last fetch, and saying so is better than fetching
// behind someone's back.

/** The env every remote-touching git call runs under. See the note above. */
export function noPromptEnv(env = process.env) {
  const { GIT_ASKPASS, SSH_ASKPASS, ...rest } = env;
  return {
    ...rest,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: rest.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes -oConnectTimeout=5',
    GCM_INTERACTIVE: 'Never',
  };
}

/**
 * `git rev-list --left-right --count @{u}...HEAD` → `{ ahead, behind }`.
 *
 * THE LEFT COUNT IS `behind`. With `A...B` the left side is what is reachable
 * from A and not B; A is the upstream, so the left number is what the upstream
 * has and you do not. Getting this backwards is the classic bug in this command
 * — it type-checks, it looks right, and it reports your unpushed work as the
 * other side's — so the parse is its own function with its own test.
 */
export function parseAheadBehind(out) {
  const parts = String(out ?? '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [behind, ahead] = parts.map(Number);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead) || behind < 0 || ahead < 0) return null;
  return { ahead, behind };
}

/**
 * Which remote to speak of when a command has to name one.
 *
 * Pure, because "several remotes and none called origin" is a real repository
 * and guessing there would put someone's work on the wrong host.
 */
export function preferredRemote(names = []) {
  if (!names.length) return { name: null, state: 'none' };
  if (names.includes('origin')) return { name: 'origin', state: 'ok' };
  if (names.length === 1) return { name: names[0], state: 'ok' };
  return { name: null, state: 'ambiguous' };
}

/**
 * Why a remote operation failed, as a word.
 *
 * The distinction that matters is `denied` versus `offline`: one means "your
 * credentials do not open this", the other "nothing was reachable", and telling
 * someone to check their network when the answer is a missing key wastes the
 * ten minutes before a talk. `offline` also covers the timeout, because a
 * remote that did not answer inside the bound is indistinguishable from one
 * that is not there — and both are answers rather than hangs.
 */
export function classifyRemoteError(e) {
  const text = String(e?.stderr || e?.message || e || '');
  if (e?.signal || /\bETIMEDOUT\b|timed out/i.test(text)) return 'offline';
  if (/could not resolve host|could not resolve hostname|network is unreachable|connection refused|connection timed out|failed to connect|unable to access/i.test(text)) return 'offline';
  if (/authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|access denied|\b403\b/i.test(text)) return 'denied';
  if (/repository not found|does not appear to be a git repository|\b404\b/i.test(text)) return 'gone';
  return 'unknown';
}

/**
 * Is this string safe to hand to `git remote add` as a URL?
 *
 * The leading-dash refusal is the point: `git remote add origin
 * --upload-pack=…` is an argument, not a URL, and `git remote add` offers no
 * `--` terminator to hide behind. Same reasoning as commitSubject's dash rule.
 */
export function looksLikeGitUrl(s) {
  const v = String(s ?? '').trim();
  if (!v || v.startsWith('-')) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(v)) return true;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(v)) return true;   // scp form: git@host:owner/repo
  return v.startsWith('/');                              // a local path is a remote too
}

// ── the probes, and the one object that answers "where does this stand?" ────

/** Is git installed at all? `inGitRepo` swallows ENOENT, so it cannot tell you. */
export function gitAvailable(cwd = process.cwd(), exec = execFileSync) {
  try { git(['--version'], cwd, exec); return true; } catch { return false; }
}

/** Every remote's name, or `[]` — a repository with none is normal, not an error. */
export function remoteNames(cwd, run = git) {
  try { return run(['remote'], cwd).split('\n').map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
}

/** A remote's URL, for display only. Nothing branches on it. */
export function remoteUrl(name, cwd, run = git) {
  try { return run(['remote', 'get-url', name], cwd) || null; } catch { return null; }
}

/**
 * What HEAD is: a branch, a detached commit, or nothing committed yet.
 *
 * The order is the correctness. An unborn HEAD (`git init`, nothing committed)
 * has a symbolic-ref but no commit, so asking about the commit first is what
 * distinguishes it from a detached one.
 */
export function headState(cwd, run = git) {
  try { run(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd); }
  catch { return { state: 'unborn', branch: null }; }
  try {
    const branch = run(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
    return branch ? { state: 'ok', branch } : { state: 'detached', branch: null };
  } catch { return { state: 'detached', branch: null }; }
}

/** The branch's upstream (`origin/main`), or null when it tracks nothing. */
export function upstreamOf(cwd, run = git) {
  try { return run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd) || null; }
  catch { return null; }
}

/** `{ ahead, behind }` against the upstream, or null. A LOCAL read — no fetch. */
export function aheadBehind(cwd, run = git) {
  try { return parseAheadBehind(run(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd)); }
  catch { return null; }
}

/**
 * Commits that exist on no remote at all — the number the UI should show.
 *
 * Deliberately not `ahead`. This needs NO upstream, so a freshly added remote
 * with nothing pushed still gets a truthful count where `@{u}` would simply
 * fail; with no remotes at all it degrades to "every commit", which is exactly
 * right ("none of this exists anywhere else"); and it is per-commit, so an
 * overlay can mark the rows rather than print a number.
 */
export function unpushed(cwd, run = git) {
  try { return run(['rev-list', 'HEAD', '--not', '--remotes'], cwd).split('\n').filter(Boolean); }
  catch { return null; }
}

/**
 * Where this repository stands, as one object. Never throws, never networks.
 *
 * Resolution is ordered and short-circuits, because each state makes the next
 * question meaningless: you cannot be behind a remote you do not have, and you
 * cannot be ahead of an upstream when HEAD is not on a branch.
 */
export function remoteState(cwd, { run = git, exec = execFileSync } = {}) {
  const nothing = { remote: null, url: null, branch: null, upstream: null, ahead: null, behind: null, unpushed: null, why: null };
  if (!gitAvailable(cwd, exec)) return { ...nothing, state: 'no-git' };
  if (!inGitRepo(cwd, exec)) return { ...nothing, state: 'no-repo' };

  const head = headState(cwd, run);
  if (head.state === 'unborn') return { ...nothing, state: 'unborn' };

  const local = unpushed(cwd, run);
  const base = { ...nothing, branch: head.branch, unpushed: local ? local.length : null };
  if (head.state === 'detached') return { ...base, state: 'detached' };

  const picked = preferredRemote(remoteNames(cwd, run));
  if (picked.state === 'none') return { ...base, state: 'no-remote' };
  if (picked.state === 'ambiguous') return { ...base, state: 'ambiguous-remote' };

  const withRemote = { ...base, remote: picked.name, url: remoteUrl(picked.name, cwd, run) };
  const upstream = upstreamOf(cwd, run);
  if (!upstream) return { ...withRemote, state: 'no-upstream' };

  const counts = aheadBehind(cwd, run);
  if (!counts) return { ...withRemote, upstream, state: 'unreadable', why: 'could not count against the upstream' };
  return { ...withRemote, upstream, ...counts, state: 'ok' };
}

// ── the words ──────────────────────────────────────────────────────────────
//
// Four places tell you about unpushed work — a toast while authoring, a line
// when author mode exits, the history overlay's footer, and `decklight
// history` — and they must not disagree. So none of them writes a sentence:
// they all call one of the three functions below. A wording change is then a
// diff in one file with a test beside it, rather than four strings that were
// the same in March.

/** The push command that would actually work here, given what is set up. */
const pushCommand = (s) => (s.state === 'no-upstream'
  ? `git push -u ${s.remote} ${s.branch}`
  : 'git push');

/**
 * Is there something to nudge about, and how much? `null` for "say nothing".
 *
 * The `ahead === 0` row returning null is the do-not-nag guarantee, and it is
 * stated here rather than at each call site so it cannot be forgotten at one of
 * them. A repository with NO remote also returns null: telling someone to push
 * when there is nowhere to push is noise, and that nudge belongs to `init`.
 */
export function pushHint(s) {
  if (!s || ['no-git', 'no-repo', 'unborn', 'unreadable'].includes(s.state)) return null;
  if (s.state === 'detached') return { kind: 'detached', n: 0, text: 'detached HEAD — there is no branch to push' };
  if (s.state === 'no-remote' || s.state === 'ambiguous-remote') return null;
  const n = s.state === 'ok' ? s.ahead : s.unpushed;
  if (!n) return null;
  return { kind: s.state === 'ok' ? 'unpushed' : 'no-upstream', n, text: `↑${n} unpushed — ${pushCommand(s)}` };
}

/**
 * The line author mode prints on its way out, or null for a clean exit.
 *
 * This one DOES speak up when there is no remote, unlike `pushHint` — the end
 * of a session is the moment when "this only exists here" is worth knowing, and
 * it is said once rather than every few minutes.
 */
export function exitPushLine(s) {
  if (!s) return null;
  if (s.state === 'no-remote' || s.state === 'ambiguous-remote') {
    return s.unpushed
      ? `  this deck's history is only on this machine — back it up: git remote add origin <url>`
      : null;
  }
  const hint = pushHint(s);
  if (!hint || !hint.n) return null;
  return `  ↑${hint.n} commit${hint.n === 1 ? '' : 's'} only on this machine — ${pushCommand(s)}`;
}

/** The one-line readout `decklight history` and the overlay footer both show. */
export function remoteLine(s) {
  if (!s) return '';
  switch (s.state) {
    case 'no-git': return 'git is not installed';
    case 'no-repo': return 'not in a git repository';
    case 'unborn': return 'nothing committed yet';
    case 'detached': return `detached HEAD · ${s.unpushed ?? 0} commits here`;
    case 'no-remote': return `${s.branch} · no remote — this history is only on this machine`;
    case 'ambiguous-remote': return `${s.branch} · several remotes, none named origin — push by name`;
    case 'no-upstream': return s.unpushed
      ? `${s.branch} → no upstream (${s.remote} exists) · ↑${s.unpushed} never pushed`
      : `${s.branch} → no upstream — ${s.remote} exists but this branch tracks nothing`;
    case 'unreadable': return `${s.branch} → ${s.upstream} · could not be counted`;
    default: {
      const bits = [`${s.branch} → ${s.upstream}`];
      if (s.ahead) bits.push(`↑${s.ahead} unpushed`);
      if (s.behind) bits.push(`↓${s.behind} behind`);
      if (!s.ahead && !s.behind) bits.push('all pushed');
      return bits.join(' · ');
    }
  }
}

// ── what else rides along ──────────────────────────────────────────────────
//
// A fast-forward updates the WHOLE working tree. If the deck shares a
// repository with anything else, "update the deck" quietly means "update the
// source tree, the CI config and the scripts too" — and the person clicking is
// thinking about a slide.
//
// The measure is deliberately what a given change WOULD touch rather than what
// the repository contains, because that is the number worth interrupting for:
// a repo that holds only a deck stays silent, and one that holds a product says
// so with the file names.

/**
 * Split a list of paths into the deck's own and everything else.
 *
 * Pure, and the definition of "the deck's own" is the interesting part: the
 * deck file plus anything under the directory it lives in. Themes, images and
 * narration travel WITH a deck and are not a surprise; `src/server.js` is.
 * Paths arrive relative to the repository root, which is how git reports them.
 */
export function splitDeckPaths(paths = [], deckRelPath = '') {
  const deck = String(deckRelPath).replace(/^\.\//, '');
  const dir = deck.includes('/') ? `${deck.slice(0, deck.lastIndexOf('/'))}/` : '';
  const own = [];
  const foreign = [];
  for (const p of paths) {
    const rel = String(p).replace(/^\.\//, '');
    if (!rel) continue;
    (rel === deck || (dir && rel.startsWith(dir)) ? own : foreign).push(rel);
  }
  return { own, foreign };
}

/**
 * What pulling `range` would change, and how much of it is not the deck.
 *
 * `range` is `HEAD..@{u}` for a pull; the same shape answers "what would be
 * pushed" for a range the other way round. Unreadable is `null` — a warning
 * nobody can compute must not become a warning nobody can dismiss.
 */
export function foreignChanges(cwd, deckRelPath, range = 'HEAD..@{u}', run = git) {
  let paths;
  try { paths = run(['diff', '--name-only', range], cwd).split('\n').filter(Boolean); }
  catch { return null; }
  const { own, foreign } = splitDeckPaths(paths, deckRelPath);
  return { total: paths.length, own, foreign };
}

/**
 * The warning itself, or null when there is nothing surprising to say.
 *
 * Names three files and counts the rest: a wall of paths is skimmed, and three
 * is enough to recognise what kind of repository this is. The recommendation is
 * the last line because it is the fix, not the finding.
 */
export function foreignWarning(changes, { verb = 'pull', scope = 'the whole working tree' } = {}) {
  if (!changes || !changes.foreign.length) return null;
  const { total, foreign } = changes;
  const shown = foreign.slice(0, 3).join(' · ');
  const more = foreign.length > 3 ? ` · … ${foreign.length - 3} more` : '';
  return [
    `this ${verb} would change ${total} file${total === 1 ? '' : 's'}, `
      + `${foreign.length} of them not the deck:`,
    `  ${shown}${more}`,
    `a ${verb} updates ${scope} — if that is not what you want here, keep the deck`
      + ' in a repository of its own',
  ];
}
