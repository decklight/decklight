// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The routes that talk to GIT on the author's behalf: the commit window (what
// is uncommitted, a commit on the author's word, a subject or a whole split
// written by an agent, a tag, a push, "not now"), and the deck's durable
// history (the versions, what each changed, an old one shown or restored)
// (SPEC PRESENTING).
//
// They came out of cli/edit.mjs as the one group of that server that is about
// the REPOSITORY rather than the deck's text. They are also the group that
// needs the most of editMain, and the deps object says so honestly: the
// session's commit bookkeeping (how dirty the work is, the nag latch, a
// .gitattributes waiting for a commit to carry it) stays in editMain, because
// the timer, the agent's own commits and the exit commit read and write it
// too, and these routes reach it only through the functions, getters and
// setters handed in below. What is theirs alone (the push latch, the cache of
// what a version changed) lives here.
//
// The import back to edit.mjs, for the error page a failed preview draws, is a
// deliberate STATIC cycle, for the reason cli/edit-slides.mjs gives: edit.mjs
// ends in a top-level `await`, so a dynamic import from inside editMain would
// wait on an evaluation that is waiting on it. Nothing here reads that binding
// until a request arrives.

import { basename } from 'node:path';

import { previewError } from './edit.mjs';
import { git, gitAutocommit, commitSubject, oneline, remoteLine, remoteState, unpushed } from './git.mjs';
import { commitPlan, headTags, planWorking, pushBlocked, pushBranch, slideDiff, tagHead, unitSummary } from './commit-split.mjs';
import { describeWorking } from './commit-message.mjs';
import { deckHistory, decorateHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';
import { linkRuntime } from './runtime-link.mjs';
import { linkReferences } from './deck-refs.mjs';

/**
 * Put the git routes into `routes`, the table cli/edit.mjs dispatches on, and
 * hand it back.
 *
 * `ctx` is the whole of what these handlers may touch:
 *
 * - the deck: `readDeck()`, `history` (a restore is one undo entry, and every
 *   commit answer carries the counts), `broadcast` (a push tells every page),
 *   `deckPath`, `deckRel` (the deck as the repository names it) and `root`
 *   (the repository);
 * - the session's settings: `gitOn()` and `agentPref()`, getters because both
 *   are `let`s of editMain's (the preferred agent changes when the author
 *   picks another), `subjectsOff` (`--no-commit-messages`, fixed at start) and
 *   `describer()`, whether an agent can write a subject at all;
 * - the commit bookkeeping editMain owns: `commitState()`, `measureDirty()`
 *   and `resetEpisode()`; `alsoNow()`, `alsoRels()` and `attrRel()`, the files
 *   that ride with the deck; `pendingAttr()` and `clearPendingAttr()`, the
 *   .gitattributes a commit has yet to carry; and `dismissNag()`, the window's
 *   "not now".
 */
export function registerGitRoutes(routes, {
  readDeck, history, broadcast = () => {}, deckPath, deckRel, root,
  gitOn, agentPref, subjectsOff, describer,
  commitState, measureDirty, resetEpisode, alsoNow, alsoRels, attrRel, pendingAttr, clearPendingAttr, dismissNag,
}) {
  // ── committing on the author's word (SPEC PRESENTING) ─────────────────
  // What is uncommitted, right now. The overlay opens on this rather than
  // on whatever the last SSE event said, because K can be pressed at any
  // moment and a stale count is a lie about what you are agreeing to.
  function commitStatusRoute({ json }) {
    if (gitOn()) measureDirty();     // the answer must be about NOW, not the last tick
    return json(200, { ok: true, ...commitState(), deck: deckRel, ...(gitOn() ? whereItStands() : {}) });
  }

  // What the window's tag and push rows read: the tags on HEAD, and where the
  // branch stands against its remote — a LOCAL read (remoteState never
  // fetches), so "1 commit not pushed" is as of the last push or pull.
  function whereItStands() {
    const s = remoteState(root);
    return {
      tags: headTags(root),
      push: {
        state: s.state, remote: s.remote, branch: s.branch, upstream: s.upstream,
        ahead: s.state === 'ok' ? s.ahead : s.unpushed, behind: s.behind, blocked: pushBlocked(s),
      },
    };
  }

  // The commit the author asked for. The subject is THEIRS — typed, or an
  // agent's sentence they looked at and kept — so it goes through
  // `commitSubject` like every other message that reaches a command line
  // (one line, capped, never a leading `-`) and nothing else rewrites it:
  // `describeCommit`'s amend is for messages decklight authored, and this
  // one has an author.
  function commitRoute({ body, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    let msg = '';
    try { msg = String(JSON.parse(body || '{}').message ?? '').trim(); } catch { /* below */ }
    if (!msg) return json(400, { ok: false, error: 'a commit needs a message' });
    const subject = commitSubject(msg, `decklight: autosave ${basename(deckPath)}`);
    // gitAutocommit reports false for "nothing to commit", which is not an
    // error: it is the answer to pressing K twice.
    const made = gitAutocommit(deckPath, root, subject, alsoNow());
    if (!made) return json(200, { ok: true, committed: false, ...commitState() });
    clearPendingAttr();
    resetEpisode();
    console.log(`  git: committed ${deckRel} — "${subject}"`);
    return json(200, {
      ok: true, committed: true, subject, ...history.counts(), ...commitState(),
    });
  }

  // A subject for work that is not committed yet — the overlay's "write one
  // for me", asked only when that is pressed (or as the window opens, with
  // --commit-messages). Refused when the session turned subjects off, or
  // there is no agent to ask.
  async function commitSubjectRoute({ json }) {
    if (subjectsOff) {
      return json(403, { ok: false, error: 'commit subjects are off in this session — it was started with --no-commit-messages' });
    }
    // A change that is only review records (a resolve, a comment of your
    // own) gets its subject from the records, with no agent in the loop, so
    // it is asked for first; the deck's own diff is what needs an agent.
    const subject = await describeWorking({
      cwd: root, deckPath, deckRel, agent: agentPref(),
      template: `decklight: autosave ${basename(deckPath)}`,
      also: alsoRels(),
    });
    if (subject) return json(200, { ok: true, subject });
    if (!describer()) {
      return json(409, { ok: false, error: 'no agent is installed on this machine to write one — decklight doctor lists the ones it can use' });
    }
    return json(200, { ok: true, subject: null });
  }

  // "write it for me": the uncommitted work cut into the commits an agent
  // proposes (cli/commit-split.mjs). The plan carries `base`, the fingerprint
  // of the work it was made on, which the split route checks before it
  // commits anything. Asked only on the click, like the one-line subject.
  async function commitPlanRoute({ json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    if (subjectsOff) {
      return json(403, { ok: false, error: 'commit subjects are off in this session — it was started with --no-commit-messages' });
    }
    const { work, commits } = await planWorking({
      cwd: root, deckPath, deckRel, also: alsoRels(), agent: agentPref(),
    });
    if (!work) return json(409, { ok: false, code: 'FIRST', error: 'the first commit is one commit — write its message' });
    if (!commits) return json(200, { ok: true, base: work.base, units: [], commits: [] });
    if (!describer() && work.units.some((u) => u.file === deckRel)) {
      return json(409, { ok: false, error: 'no agent is installed on this machine to write one — decklight doctor lists the ones it can use' });
    }
    return json(200, { ok: true, base: work.base, units: work.units.map(unitSummary), commits });
  }

  // The proposed commits, as the author left them: each subject theirs now,
  // so each goes through commitSubject like any message. All the ticked ones
  // land or none does (commitPlan moves the branch once); an unticked one
  // (`skip`) stays uncommitted, and `left` hands it back re-cut against the
  // new HEAD so the window can offer it again.
  function commitSplitRoute({ body, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    let req = {};
    try { req = JSON.parse(body || '{}'); } catch { return json(400, { ok: false, error: 'bad request' }); }
    const commits = Array.isArray(req.commits) ? req.commits : [];
    const taking = commits.filter((c) => !c?.skip);
    if (!taking.length) return json(400, { ok: false, code: 'EMPTY', error: 'no commit is ticked' });
    if (taking.some((c) => !String(c?.message ?? '').trim())) {
      return json(400, { ok: false, error: 'every commit needs a message' });
    }
    const made = commitPlan({
      cwd: root, deckRel, also: alsoRels(), base: String(req.base ?? ''), commits,
      template: `decklight: autosave ${basename(deckPath)}`,
    });
    if (!made.ok) return json(made.code === 'STALE' ? 409 : 500, { ok: false, code: made.code, error: made.error });
    // the .gitattributes rides the sidecar's commit: still pending if that was left out
    if (!pendingAttr() || made.files.includes(attrRel())) clearPendingAttr();
    resetEpisode();
    measureDirty();   // what was left out is uncommitted work, starting now
    for (const s of made.subjects) console.log(`  git: committed ${deckRel} — "${s}"`);
    return json(200, {
      ok: true, committed: true, count: made.subjects.length, subjects: made.subjects, subject: made.subjects.at(-1),
      left: made.left,
      ...history.counts(), ...commitState(), ...whereItStands(),
    });
  }

  // An annotated tag on HEAD, named by the author.
  function commitTagRoute({ body, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    let name = '';
    try { name = String(JSON.parse(body || '{}').name ?? ''); } catch { /* below */ }
    const made = tagHead(root, name);
    if (!made.ok) return json(made.code === 'GIT' ? 500 : 409, { ok: false, code: made.code, error: made.error });
    console.log(`  git: tagged ${made.sha.slice(0, 7)} ${made.tag}`);
    return json(200, { ok: true, tag: made.tag, ...whereItStands() });
  }

  // The push, on the author's click and only then: the branch and the
  // annotated tags on it. One at a time; a minute at most; no prompt can
  // hang it (pushBranch). The SSE `commit` event tells every page the
  // count went to zero.
  let pushing = false;
  async function commitPushRoute({ body, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    if (pushing) return json(409, { ok: false, code: 'BUSY', error: 'a push is already on its way' });
    // tags go with the branch unless the page says not to (Settings… → Push
    // tags): an absent or unreadable body is the default, which sends them
    let tags = true;
    try { tags = JSON.parse(body || '{}').tags !== false; } catch { /* the default */ }
    pushing = true;
    try {
      const done = await pushBranch(root, { state: remoteState(root), tags });
      if (!done.ok) return json(done.code === 'BLOCKED' ? 409 : 502, { ok: false, code: done.code, error: done.error });
      console.log(`  git: pushed ${done.branch} to ${done.remote}${tags ? '' : ' (tags kept here)'}`);
      broadcast('commit', commitState());
      // `pushedTags`, not `tags`: whereItStands() already answers `tags`, the
      // names on HEAD, and the window paints both
      return json(200, { ok: true, pushed: true, remote: done.remote, branch: done.branch, pushedTags: tags, ...whereItStands() });
    } finally { pushing = false; }
  }

  function commitDismissRoute({ json }) {
    // Not the same as committing: the work stays uncommitted and the
    // snapshot keeps running. It only means "stop asking about THIS one".
    dismissNag();
    return json(200, { ok: true, ...commitState() });
  }

  // ── the deck's durable history (#129): what the R overlay reads ────
  // Loopback-only like every other /deck/edit/* path: this serves arbitrary
  // historical revisions of the deck, which is nobody else's business.
  function historyRoute({ json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session — there is no history' });
    try {
      // One round trip serves the whole overlay: the commits, which of them
      // exist nowhere but this machine, and where the branch stands. All of
      // it is a LOCAL read — `unpushed` and `@{u}` read remote-tracking
      // refs, so opening the history never touches the network (SPEC
      // PRESENTING).
      // `slides` is what that version WAS, `add`/`del` what it CHANGED —
      // the two questions a hash and a subject cannot answer, and the ones
      // that tell "tightened the wording" apart from "cut four slides"
      // before you restore it rather than after.
      const entries = decorateHistory(deckHistory(deckPath, root), deckPath, root);
      const remote = remoteState(root);
      // `pushed` is null for "not a question worth answering here", and the
      // two cases are different: git could not tell us, or there is no
      // remote at all — in which case EVERY commit is unpushed and marking
      // all of them is a wall of arrows saying what the footer says once.
      const local = ['no-remote', 'ambiguous-remote'].includes(remote.state) ? null : unpushed(root);
      const set = local ? new Set(local) : null;
      for (const e of entries) e.pushed = set ? !set.has(e.full) : null;
      // The LINE is computed here, not in the player: cli/git.mjs is Node
      // (it spawns git), the runtime has zero dependencies and cannot
      // import it, and duplicating the wording in the browser is how the
      // four places that talk about unpushed work start disagreeing.
      return json(200, { ok: true, entries, remote: { ...remote, line: remoteLine(remote) } });
    } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
  }

  /**
   * A page this server writes ITSELF — an old version of the deck, a template
   * preview — goes out the way `staticFiles` sends every other page: a deck
   * that is data (#520) gets the runtime, its stylesheet, its theme and the
   * themes it marks referenced. Without it the frame drew the deck's bare
   * markup, dark text on the panel's dark ground — a black rectangle. The
   * `<base>` comes first, so those references resolve from the root, where
   * `staticFiles` answers them, not from under /deck/edit/.
   */
  const asServed = (html) => linkReferences(linkRuntime(withBaseHref(html)));

  /**
   * Which slides a version changed, added and removed against the one before
   * it, in reading order: what the History overlay's "changes" view walks
   * (PRESENTING). `parent` is the version a removed slide is shown from; the
   * deck's first version has none, and everything in it was added. A hash is
   * all this takes, because a ref is handed to `git show` and an option-shaped
   * one would be read as an option.
   */
  const historyChanges = new Map();   // full hash → answer; a commit never changes
  function historyChangesRoute({ url, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session' });
    const ref = url.searchParams.get('ref') ?? '';
    if (!/^[0-9a-f]{4,64}$/i.test(ref)) return json(400, { ok: false, error: 'a version is named by its hash' });
    try {
      const full = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
      if (historyChanges.has(full)) return json(200, historyChanges.get(full));
      const after = deckAt(deckPath, full, root);
      let parent = null, before = '';
      try {
        parent = git(['rev-parse', '--short', `${full}^`], root);
        before = deckAt(deckPath, parent, root);
      } catch { /* the first commit, or one the deck was not in yet */ }
      const answer = { ok: true, ref: full.slice(0, 7), parent, ...slideDiff(before, after) };
      historyChanges.set(full, answer);
      return json(200, answer);
    } catch { return json(404, { ok: false, error: 'no such revision of this deck' }); }
  }

  function deckAtRoute({ res, url, json, CORS }) {
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session' });
    try {
      // <base href="/"> because this is served from /deck/edit/, not the root:
      // without it every relative ../dist and ./casts path in the deck
      // would resolve one directory too deep and the preview would be bare.
      const html = asServed(deckAt(deckPath, url.searchParams.get('ref') || '', root));
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      // Two different failures, and answering both with the same 404 is how
      // #508 hid for a release: a deck over Node's stdout cap threw ENOBUFS
      // here, was reported as a missing revision, and the preview iframe drew
      // a bare 404 body as a black rectangle. A ref git does not know is the
      // only 404; anything else is this server's problem and says so — in the
      // terminal, and in the frame, which is where somebody is looking.
      // git's own two ways of saying "not here": `invalid object name 'x'` for a
      // ref it cannot resolve, `path 'x' does not exist in 'HEAD'` for a deck that
      // was not in that commit. Everything else — ENOBUFS above all (#508) — is a
      // failure of this server, not a missing revision, and must not wear a 404.
      const missing = /invalid object name|unknown revision|does not exist in|exists on disk, but not in/i
        .test(String(e.stderr || e.message || e));
      const why = missing ? 'no such revision of this deck' : oneline(e);
      if (!missing) console.log(`  history: previewing ${basename(deckPath)} failed — ${why}`);
      res.writeHead(missing ? 404 : 500, { ...CORS, 'content-type': 'text/html; charset=utf-8' });
      return res.end(previewError(why));
    }
  }

  function restoreRoute({ body, json }) {
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session' });
    const { ref } = JSON.parse(body || '{}');
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('bad payload');
    const before = readDeck();
    let result;
    try { result = restoreDeck(deckPath, ref.trim(), root); }
    catch (e) { return json(400, { ok: false, error: oneline(e) }); }
    // Z takes a restore back like any other edit — the git-level move and
    // the keystroke-level stack stay in step rather than disagreeing.
    if (result.changed) history.record(before);
    console.log(`  restored ${basename(deckPath)} to ${result.short}`);
    return json(200, { ok: true, ...result, ...history.counts() });
  }

  routes.set('GET /deck/edit/commit', commitStatusRoute);
  routes.set('POST /deck/edit/commit', commitRoute);
  routes.set('POST /deck/edit/commit/subject', commitSubjectRoute);
  routes.set('POST /deck/edit/commit/dismiss', commitDismissRoute);
  routes.set('POST /deck/edit/commit/plan', commitPlanRoute);
  routes.set('POST /deck/edit/commit/split', commitSplitRoute);
  routes.set('POST /deck/edit/commit/tag', commitTagRoute);
  routes.set('POST /deck/edit/commit/push', commitPushRoute);
  routes.set('GET /deck/edit/history', historyRoute);
  routes.set('GET /deck/edit/history/at', deckAtRoute);
  routes.set('GET /deck/edit/history/changes', historyChangesRoute);
  routes.set('POST /deck/edit/restore', restoreRoute);
  return routes;
}
