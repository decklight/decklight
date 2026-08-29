#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight review — leave comments on somebody's deck. SPEC REVIEW.
//
//   decklight review <deck.html> [--port 8790] [--no-open] [--no-git]
//
// WHY THIS IS ITS OWN COMMAND, AND ITS OWN SERVER.
//
// SPEC PRESENTING refuses, three separate times, to let a server that is not
// the authoring server acquire a write capability: "a server that can move a
// deck that did not ask is an editing server with the writes left out, and that
// capability is not created here", and "a shared path with a boolean in it is
// how a presenting server quietly acquires an editing capability later".
//
// So reviewing is not a flag on `present` (which writes nothing, by
// construction — it registers no /edit/* route to have refused) and not a flag
// on `author` (which would hand a reviewer the power to rewrite the deck they
// were asked to read). It is a third command with a third route namespace, and
// the capability it adds is stated by what it registers rather than by what it
// checks:
//
//   GET  /review/ping        who am I looking at
//   GET  /review/comments    what has been said
//   POST /review/comments    say one thing
//
// There is no /edit/*, and the deck file is opened for READING only. The one
// path this process will ever write is `<deck>.review.jsonl`. That is not a
// promise in a comment — test/review-server.test.mjs asserts every /edit/* route
// 405s and that the deck is byte-identical afterwards.
//
// Git is the backend but never the transport for the SERVER: with a repository,
// each comment is committed (the sidecar alone, staged by itself); with none,
// the file is just a file, which is the thing you send back. This server never
// pushes — pushing is `review submit` (cli/review-submit.mjs), a one-shot the
// reviewer types (or confirms in the overlay), and POST /review/submit below is
// that same code behind the same explicit gesture.

import { createServer } from 'node:http';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { staticFiles, allowEditRequest, listenTakingOverIfNeeded } from './serve.mjs';
import { inGitRepo, gitAutocommit, gitAvailable, commitSubject, oneline } from './git.mjs';
import { reviewPathFor, parseReview, serializeRecord, newId } from './review-store.mjs';
import { openUrl } from './init.mjs';
import { exitWhenOrphaned } from './supervise.mjs';

const USAGE = `usage: decklight review <deck.html> [--port 8790] [--no-open] [--no-git]
  open somebody's deck and leave comments on it, anchored to slides

  ⇧M in the deck leaves a comment (M reads them all, or / → "Leave a comment…"); the
  comment is attached to the slide you are looking at, and remembers enough
  about it to find that slide again after the deck has moved on

  --port N    port to serve on (taken? moves to the next free one)     [8790]
  --no-open   don't launch a browser — print the URL and wait
  --no-git    write the file and never commit it (each comment still records
              WHICH COMMIT the deck was on — that is provenance, not bookkeeping)

  comments land in <deck>.review.jsonl beside the deck: one line each,
  append-only, so two reviewers never conflict and a push reads as a diff.
  In a repository each one is committed; without one it is a file to send back
  (the author reads it with: decklight comments <deck.html> --import <file>)

  this server writes that file and nothing else — it has no /edit/* routes and
  never opens the deck for writing

  when you are done, send them:   decklight review submit <deck.html>
`;

/**
 * Who is speaking, from git's own answer — the only identity decklight has.
 *
 * `publish.mjs` reads it exactly this way, degrading to '' rather than failing,
 * and a comment with no name is still a comment worth keeping: an unsigned
 * remark from a machine with no git identity beats refusing to take it.
 */
export function reviewerIdentity(cwd, exec = execFileSync) {
  const cfg = (key) => {
    try { return exec('git', ['config', key], { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
  };
  const name = cfg('user.name');
  const email = cfg('user.email');
  if (name && email) return `${name} <${email}>`;
  return name || email || '';
}

/**
 * The record a posted comment becomes.
 *
 * Pure, so the shape is testable without a server: the browser sends what it
 * knows about the slide (its number, title and fingerprint) and the server adds
 * what only it knows (who, when, and which commit of the deck was on screen).
 *
 * `body` is the reviewer's own prose and is stored verbatim — it is data here,
 * never an argument to anything. The one place it could reach a command line is
 * a commit subject, and that goes through `commitSubject`.
 */
export function reviewRecord(input, { by, at, deck, id }) {
  const rec = { id, at, ...(by ? { by } : {}), ...(deck ? { deck } : {}) };
  if (input.re) rec.re = String(input.re);
  else {
    rec.slide = Number(input.slide);
    if (input.title) rec.title = String(input.title).slice(0, 200);
    if (input.fp) rec.fp = String(input.fp).slice(0, 32);
  }
  rec.body = String(input.body);
  return rec;
}

/** What a posted comment must carry to be worth storing, or the reason it is not. */
export function commentProblem(input) {
  if (!input || typeof input !== 'object') return 'not a comment';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) return 'a comment needs something in it';
  if (body.length > 4000) return 'that comment is longer than 4000 characters';
  if (input.re !== undefined && (typeof input.re !== 'string' || !/^[a-z0-9]{1,12}$/.test(input.re))) {
    return 'bad reply target';
  }
  if (input.re === undefined) {
    const n = Number(input.slide);
    if (!Number.isInteger(n) || n < 1 || n > 9999) return 'a comment belongs to a slide';
  }
  return null;
}

const SUBMIT_USAGE = `usage: decklight review submit <deck.html> [--pr] [--remote origin] [--dry-run]
  push the comments you left to a branch of their own, for the author to read

  the branch is review/<you>-<today>, and a second submit the same day lands on
  the branch already there — a morning of reviewing is one branch, one PR

  --pr             also open a pull request (needs gh, signed in)
  --remote NAME    which remote to push to                          [origin]
  --dry-run        build the commit and stop before pushing anything

  this pushes ONE FILE: the comments. Your branch, your working tree and your
  index are never touched, and none of your own commits come along.
`;

/**
 * `decklight review submit <deck>`.
 *
 * Thin on purpose — everything that could be got wrong lives in
 * cli/review-submit.mjs, where it is testable without a process.
 */
async function submitSubcommand(args, { out = process.stdout } = {}) {
  const { opt } = argReader(args);
  // The deck is the positional that LOOKS like a deck — `--remote upstream
  // talk.html` must not read "upstream" as the deck. comments.mjs's rule.
  const deckArg = args.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deckArg || args.includes('--help') || args.includes('-h')) {
    out.write(SUBMIT_USAGE);
    return deckArg ? 0 : 1;
  }
  const { submitReview } = await import('./review-submit.mjs');
  try {
    submitReview(resolve(process.cwd(), deckArg), {
      remote: opt('--remote', 'origin'),
      pr: args.includes('--pr'),
      dryRun: args.includes('--dry-run'),
      out,
    });
    return 0;
  } catch (e) {
    // CommandError already carries the command name and a way forward.
    process.stderr.write(`${e?.message ?? e}\n`);
    return 1;
  }
}

export async function reviewMain(args, { open = openUrl, out = process.stdout, onListen = null } = {}) {
  // `review submit <deck>` is a one-shot: it pushes what is already written and
  // exits. It is dispatched here rather than as a command of its own because it
  // is the second half of `review` — the same store, the same reviewer, and a
  // person who typed one will look for the other in the same place.
  if (args[0] === 'submit') return submitSubcommand(args.slice(1), { out });

  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    out.write(USAGE);
    return 0;
  }
  const { opt } = argReader(args);
  const deckArg = firstPositional(args, ['--port']);
  const root = process.cwd();
  const deckPath = resolve(root, deckArg);
  if (!existsSync(deckPath)) { process.stderr.write(`decklight review: no such deck: ${deckArg}\n`); return 1; }
  if (!deckPath.startsWith(root + '/') && dirname(deckPath) !== root) {
    process.stderr.write('decklight review: the deck must live under the current directory\n');
    return 1;
  }

  const deckDir = dirname(deckPath);
  const name = basename(deckPath);
  const storePath = reviewPathFor(deckPath);
  const storeName = basename(storePath);

  // Git is the backend, not a requirement: a reviewer who was sent a file has
  // no repository and must still be able to say something.
  const noGit = args.includes('--no-git');
  const inRepo = gitAvailable(deckDir) && inGitRepo(deckDir);
  const gitOn = !noGit && inRepo;
  // Whether THIS session pushed. Read by the Ctrl-C line below: a reviewer who
  // wrote comments and never submitted should hear so on the way out.
  let submitted = false;
  const by = inRepo ? reviewerIdentity(deckDir) : '';
  /**
   * WHICH VERSION OF THE DECK this comment is about.
   *
   * Gated on being in a repository, NOT on `--no-git`. Those are two different
   * questions: `--no-git` says "do not commit for me", and this says "which
   * bytes was the reviewer looking at" — provenance, not bookkeeping. Suppressing
   * it with the commit is how a comment loses the one fact that lets anybody
   * check what the slide said at the time.
   *
   * `--short`, because it is read by people and lives in a line somebody scans.
   */
  const deckHead = () => {
    if (!inRepo) return null;
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: deckDir, encoding: 'utf8' }).trim(); }
    catch { return null; }
  };

  const files = staticFiles(deckDir, { knownTypesOnly: true });
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    // The same origin gate the edit server uses, for the same reason: binding
    // loopback is the wrong boundary when the dangerous caller is another tab
    // in the reviewer's own browser.
    if (!allowEditRequest(req)) { res.writeHead(403); res.end('this server answers this machine only'); return; }
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/review/ping') {
      return json(res, 200, { ok: true, name, review: true, git: gitOn, by: by || null, store: storeName });
    }

    if (req.method === 'GET' && url.pathname === '/review/comments') {
      const text = existsSync(storePath) ? readFileSync(storePath, 'utf8') : '';
      const { records, skipped } = parseReview(text);
      // `skipped` travels rather than being swallowed: a reader showing fewer
      // comments than the file holds should be able to say so.
      return json(res, 200, { ok: true, records, skipped });
    }

    if (req.method === 'POST' && url.pathname === '/review/comments') {
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 1e5) throw new Error('too large'); }
      } catch { return json(res, 413, { ok: false, error: 'that comment is too large' }); }
      let input;
      try { input = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad payload' }); }
      const bad = commentProblem(input);
      if (bad) return json(res, 400, { ok: false, error: bad });

      const rec = reviewRecord(input, {
        by, at: new Date().toISOString(), deck: deckHead(), id: newId(),
      });
      try {
        // Append, never rewrite — that is what makes `merge=union` work and a
        // second reviewer harmless.
        appendFileSync(storePath, `${serializeRecord(rec)}\n`);
      } catch (e) { return json(res, 500, { ok: false, error: oneline(e) }); }

      let committed = false;
      if (gitOn) {
        // The reviewer's own prose reaching a command line, so it goes through
        // the sanitizer every other untrusted subject does: one line, capped,
        // never leading `-`.
        const subject = commitSubject(`review: ${rec.body}`, `review: a comment on ${name}`);
        committed = gitAutocommit(storePath, deckDir, subject);
      }
      out.write(`  comment on slide ${rec.slide ?? '—'} → ${storeName}${committed ? ' (committed)' : ''}\n`);
      return json(res, 200, { ok: true, id: rec.id, committed });
    }

    if (req.method === 'POST' && url.pathname === '/review/submit') {
      // The browser NEVER runs git: it asks, and this server — the only thing
      // in the room holding a capability — does the pushing, with the same
      // code the typed `review submit` runs. Dynamically imported like the
      // subcommand, so review-submit's static import of reviewerIdentity from
      // this file never becomes a cycle.
      try {
        const { submitReview } = await import('./review-submit.mjs');
        const lines = [];
        const r = submitReview(deckPath, { out: { write: (t) => lines.push(t) } });
        out.write(lines.join(''));   // the terminal is a log of what happened
        submitted = true;
        return json(res, 200, { ok: true, branch: r.branch, comments: r.comments, resubmit: r.resubmit });
      } catch (e) {
        // A refusal (no remote, nothing to send) arrives with its way forward
        // in the message — the browser toasts it verbatim.
        return json(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    }

    if (files(req, res, url)) return;
    // Everything else — including every /edit/* path — lands here. There is no
    // route to have refused, which is the point.
    res.writeHead(405);
    res.end();
  });

  const actual = await listenTakingOverIfNeeded(server, Number(opt('--port', 8790)), '127.0.0.1');
  const deckUrl = `/${relative(deckDir, deckPath)}`;
  const url = `http://127.0.0.1:${actual}${deckUrl}?review`;
  if (onListen) onListen({ port: actual, deckUrl, server });

  out.write(`decklight review on ${url}\n`);
  out.write('  M opens the composer · the comment attaches to the slide you are on · Esc closes\n');
  const existing = existsSync(storePath) ? parseReview(readFileSync(storePath, 'utf8')).records.length : 0;
  out.write(`  comments go to ${storeName}`
    + `${existing ? ` (${existing} already there)` : ''}`
    // --no-git inside a clone means "don't auto-commit", not "there is no
    // repository" — saying the wrong one steers the reviewer away from
    // `review submit`, which works fine there.
    + `${gitOn ? ', committed as you go'
      : inRepo ? ', not committed (--no-git)'
        : ', not committed — this is not a git repository'}\n`);
  if (!gitOn && !noGit) {
    out.write(`  send ${storeName} back when you are done; the author reads it with:\n`);
    out.write(`      decklight comments ${name} --import ${storeName}\n`);
  }
  // Where the comments go next. Said at startup rather than only on Ctrl-C: a
  // reviewer who closes the terminal never sees an exit line, and a review that
  // stays on their laptop is a review that did not happen.
  // `deckArg`, not basename: this line exists to be PASTED, and for a deck in
  // a subdirectory `review submit deck.html` resolves against cwd and fails.
  // The path the reviewer just typed is, by construction, one that works here.
  out.write(`  when you are done, send them:  decklight review submit ${deckArg}`
    + `${inRepo ? '' : `   (no repository here — send ${storeName} back instead)`}\n`);
  out.write('  Ctrl-C when you are done.\n');
  if (!args.includes('--no-open')) await open(url, { out, what: url });

  // The exit line. Local prints only — cli/edit.mjs:604's rule: a SIGINT
  // handler that touched the network would hang the very keystroke that asks
  // to leave.
  process.on('SIGINT', () => {
    if (!submitted && inRepo && existsSync(storePath)) {
      const { records } = parseReview(readFileSync(storePath, 'utf8'));
      const open_ = records.filter((r) => !r.op && !r.re).length;
      if (open_) {
        out.write(`\n${open_} comment${open_ === 1 ? '' : 's'} not submitted — send them with:  decklight review submit ${deckArg}\n`);
      }
    }
    process.exit(0);
  });
  return 0;
}

if (isMain(import.meta.url)) {
  exitWhenOrphaned();
  reviewMain(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; });
}
