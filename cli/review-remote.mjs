// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What reviews are waiting — SPEC REVIEW.
//
// `review submit` pushes a reviewer's comments to `review/<who>-<date>`. This is
// the other end: the one reader that finds those branches and says how many
// comments are on each. Three surfaces share it — `decklight author` at startup,
// `M` in the deck, and `decklight comments --incoming` — and they share it so
// that none of them can drift into a different answer.
//
// THE FETCH DOCTRINE, AND WHY THIS IS ALLOWED TO CROSS IT.
//
// cli/git.mjs states NEVER A FETCH YOU DID NOT ASK FOR, and cli/edit.mjs asserts
// that opening the history touches no network. That rule is about the PRESENTER:
// nothing may reach for a remote in the middle of a talk. An author opening
// their own editor is a different person in a different moment, and "somebody
// reviewed your deck" is only useful if it arrives without being asked for.
//
// The crossing is kept narrow, and the shape is `update-check.mjs`'s:
//   - once, at startup, never on a timer, never from a request handler
//   - detached and never awaited, so nothing waits on a remote that is down
//   - off by three switches, each of which reports the REASON it was skipped
//   - never reachable from the SIGINT path (cli/edit.mjs:604 says why)
//
// AND THE REFSPEC DOCTRINE. `cli/upstream.mjs` states that no name, path or
// refspec derived from anything ever becomes a git argument. The GLOB halves
// of the refspec below are frozen constants in this source file; the remote's
// NAME is the one interpolation, the same user-typed `--remote` flag `publish`
// already passes to git, and it is gated by `remoteNameProblem` before it can
// reach an argument. What varies on the wire — which branches came back, what
// is in them — is filtered to the `refs/heads/review/` namespace before any of
// it is read back, so nothing a reviewer chose can begin with a `-` by the
// time it is an argument.

import { basename, dirname, resolve } from 'node:path';

import { runGit, classifyFailure } from './upstream.mjs';
import { parseReview } from './review-store.mjs';
import { foldReview } from '../tools/review-anchor.mjs';

/** Every review branch a remote has. A literal, not built from anything. */
const REVIEW_GLOB = 'refs/heads/review/*';
/** …and where they land locally: exactly where a plain `git fetch <remote>` would put them. */
const refspecFor = (remote) => `+refs/heads/review/*:refs/remotes/${remote}/review/*`;

/** Refuse a remote name git could misread, rather than repairing it. */
export function remoteNameProblem(remote) {
  const r = String(remote ?? '');
  if (!r) return 'is empty';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r)) return 'is not a remote name';
  return null;
}

/**
 * Why the check did not run, or `false` if it should.
 *
 * A reason string rather than a boolean, `upstreamSuppressed`'s shape: the
 * caller prints "not checked — CI" instead of nothing, because a silent skip
 * and "no reviews waiting" look identical to the reader and mean opposite
 * things. UNCHECKED IS ITS OWN ANSWER AND NEVER A PASS.
 */
export function reviewCheckSuppressed({ args = [], env = process.env } = {}) {
  if (args.includes('--no-review-check')) return '--no-review-check';
  if (env.DECKLIGHT_NO_REVIEW_CHECK) return 'DECKLIGHT_NO_REVIEW_CHECK is set';
  if (env.CI) return 'CI';
  return false;
}

/** `review/ana-2026-08-24` → who and when, for a line a human reads. */
export function describeBranch(branch) {
  const tail = String(branch).replace(/^review\//, '');
  const m = /^(.*)-(\d{4}-\d{2}-\d{2})$/.exec(tail);
  return m ? { who: m[1], when: m[2] } : { who: tail, when: null };
}

/**
 * The reviews waiting on `remote` for this deck.
 *
 * Two network calls no matter how many reviews there are — one `ls-remote` to
 * see whether any exist at all, one `fetch` to bring them in — and then every
 * count is a local read. A per-branch fetch would be the obvious shape and
 * would put a talk's worth of round trips behind an editor's startup.
 *
 * Returns `{ state, reviews, reason }`. `state` is one of:
 *   `ok`          — the list is authoritative, and may be empty
 *   `none`        — the remote has no review branches
 *   `no-repo` / `untracked` / `no-remote` — the feature does not apply here
 *   `offline` / `no-credential` / `timeout` / `error` — COULD NOT ASK
 *
 * The last group is the reason this returns a state rather than an array: a
 * failed check must never render as "no reviews waiting".
 */
export async function reviewsWaiting(deckPath, { remote = 'origin', run = runGit } = {}) {
  const full = resolve(deckPath);
  const cwd = dirname(full);
  const no = (state, reason = null) => ({ state, reviews: [], reason });
  const badRemote = remoteNameProblem(remote);
  if (badRemote) return no('error', `the remote name ${JSON.stringify(remote)} ${badRemote}`);

  const top = await run(['rev-parse', '--show-toplevel'], { cwd });
  if (!top.ok || !top.stdout) return no('no-repo');
  // The deck must be a file this repository versions — resolveUpstream's gate,
  // for its reasons: without it every deck in ~/Downloads is "in a clone" for
  // anyone whose home directory happens to be one. Asked by basename from the
  // deck's own directory so no two spellings of one path are ever compared.
  const tracked = await run(['ls-files', '--error-unmatch', '--', basename(full)], { cwd });
  if (!tracked.ok) return no('untracked');

  const url = await run(['remote', 'get-url', remote], { cwd });
  if (!url.ok || !url.stdout) return no('no-remote');

  const listed = await run(['ls-remote', '--heads', remote, REVIEW_GLOB], { cwd });
  if (!listed.ok) return no(classifyFailure(listed), listed.stderr || null);
  const branches = listed.stdout.split('\n').filter(Boolean)
    .map((l) => l.split('\t')[1])
    .filter((r) => typeof r === 'string' && r.startsWith('refs/heads/review/'))
    .map((r) => r.slice('refs/heads/'.length));
  if (!branches.length) return { state: 'none', reviews: [], reason: null };

  const fetched = await run(['fetch', '--quiet', remote, refspecFor(remote)], { cwd });
  if (!fetched.ok) return no(classifyFailure(fetched), fetched.stderr || null);

  // Which file to read out of each branch. `--show-prefix` rather than a
  // relative path computed here: git answers in forward slashes, and macOS
  // resolves /tmp and /var through symlinks, so comparing two absolute paths
  // for one file disagrees more often than it looks.
  const prefix = await run(['rev-parse', '--show-prefix'], { cwd });
  const storeName = basename(full).replace(/\.html?$/i, '') + '.review.jsonl';
  const inRepo = `${prefix.ok ? prefix.stdout : ''}${storeName}`;

  const reviews = [];
  for (const branch of branches) {
    // `<ref>:<path>` is one argument and both halves are DATA here — the ref
    // came from the remote, so it goes after `--`… except `git show` takes no
    // `--` before a `rev:path`. What protects this instead is that the ref was
    // filtered to `refs/heads/review/` above and can therefore never begin with
    // a `-`, which is the only way an argument turns into an option.
    const ref = `refs/remotes/${remote}/${branch}`;
    const blob = await run(['show', `${ref}:${inRepo}`], { cwd });
    // A review branch with no sidecar for THIS deck is a review of another deck
    // in the same repository. Skipped, not reported: an author opening one deck
    // does not want to hear about comments on a different one.
    if (!blob.ok) continue;
    const { records, skipped } = parseReview(blob.stdout);
    // The same fold `decklight comments` renders with. A raw line count calls
    // a resolved comment "waiting" and counts a union-merge duplicate twice —
    // and then this line disagrees with the very command it points at.
    const folded = foldReview(records);
    const open = folded.filter((c) => !c.resolved);
    // Nothing OPEN means nothing waiting: a branch of resolves is history, not
    // a review the author still owes attention.
    if (!open.length) continue;
    const stamp = await run(['log', '-1', '--format=%aI', ref], { cwd });
    reviews.push({
      branch,
      ...describeBranch(branch),
      comments: open.length,
      // Raw, unlike `comments`: a reply here may answer a comment living in
      // ANOTHER branch (each reviewer clones from main), and the fold — scoped
      // to this one sidecar — would drop it as parentless.
      replies: records.filter((r) => r.re && !r.op).length,
      unreadable: skipped,
      at: stamp.ok ? stamp.stdout : null,
    });
  }
  // Newest first: an author wants the review that just arrived, not the one from
  // three weeks ago they already read. The commit date is the real recency; the
  // branch's own date breaks ties, which is not a rare case — two reviewers
  // finishing within the same second of each other tie on `%aI` exactly, and
  // without the tiebreak the order falls through to whatever ls-remote listed,
  // which is alphabetical by reviewer and means nothing at all.
  const key = (r) => [String(r.at ?? ''), String(r.when ?? '')];
  reviews.sort((a, b) => {
    const [aAt, aWhen] = key(a); const [bAt, bWhen] = key(b);
    return bAt.localeCompare(aAt) || bWhen.localeCompare(aWhen);
  });
  return { state: reviews.length ? 'ok' : 'none', reviews, reason: null };
}

/**
 * One line for a terminal, or `null` when there is nothing worth saying.
 *
 * `null` for the states where the feature simply does not apply (no repo, no
 * remote, an untracked deck) — an author who has never used this should not be
 * told about a thing that is not happening. Every FAILURE, though, gets a line:
 * that is the distinction the state machine exists to make.
 */
export function reviewLine(result, { deck = '' } = {}) {
  const { state, reviews } = result ?? {};
  if (state === 'ok') {
    const n = reviews.length;
    const total = reviews.reduce((sum, r) => sum + r.comments, 0);
    const who = reviews.slice(0, 3).map((r) => r.who).join(', ');
    return `reviews: ${total} comment${total === 1 ? '' : 's'} waiting`
      + ` from ${who}${n > 3 ? ` +${n - 3} more` : ''}`
      + `${deck ? ` — decklight comments ${deck} --incoming` : ''}`;
  }
  if (state === 'none' || state === 'no-repo' || state === 'untracked' || state === 'no-remote') return null;
  const how = {
    offline: 'no network',
    'no-credential': 'the remote asked for credentials',
    timeout: 'the remote did not answer',
  }[state] ?? 'git could not read the remote';
  // NOT "no reviews": this is the sentence that keeps a failed check from
  // reading like an all-clear.
  return `reviews: not checked — ${how}`;
}
