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
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve, relative, sep } from 'node:path';

import { argReader, firstPositional, isMain, parsePort, badPort } from '../tools/args.mjs';
import { deckFromUrl } from './clone-deck.mjs';
import { runMain } from './util.mjs';
import { staticFiles, allowEditRequest, listenTakingOverIfNeeded } from './serve.mjs';
import { inGitRepo, gitAvailable } from './git.mjs';
import { reviewPathFor, parseReview } from './review-store.mjs';
import { createReviewRoutes, REVIEW_BODY_MAX } from './review-routes.mjs';
export { reviewerIdentity, reviewRecord, commentProblem } from './review-routes.mjs';
import { openUrl } from './open-browser.mjs';
import { exitWhenOrphaned } from './supervise.mjs';

const USAGE = `usage: decklight review <deck.html|repository url> [--port 8790] [--no-open] [--no-git]
                       [--branch <ref>] [--into <dir>]
  open somebody's deck and leave comments on it, anchored to slides

  a repository URL (https://github.com/them/talk, git@…, …/talk.git; #path picks
  a deck inside) is cloned to ./<repo> — or the clone already there, whichever
  command made it, is opened — and your comments go back to it as a branch
  with: decklight review submit <deck.html>

  ⇧M in the deck leaves a comment (M reads them all, or / → "Leave a comment…"); the
  comment is attached to the slide you are looking at, and remembers enough
  about it to find that slide again after the deck has moved on

  --port N    port to serve on (taken? moves to the next free one)     [8790]
  --no-open   don't launch a browser — print the URL and wait
  --branch R  the branch or tag to clone (a repository URL)
  --into D    where to clone it (default: ./<repo name>)
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
  const deckArg = firstPositional(args, ['--port', '--branch', '--into']);
  // A repository URL: the deck somebody asked you to read, cloned — or the
  // clone already here — which is also what `review submit` wants, since the
  // review goes back as a branch pushed to that clone's origin.
  let fromUrl = null;
  try { fromUrl = deckFromUrl(deckArg, { branch: opt('--branch'), into: opt('--into') }); }
  catch (e) { process.stderr.write(`decklight review: ${e.message}\n`); return 1; }
  const root = fromUrl ? fromUrl.dir : process.cwd();
  const deckPath = fromUrl ? fromUrl.deckPath : resolve(root, deckArg);
  if (!existsSync(deckPath)) { process.stderr.write(`decklight review: no such deck: ${deckArg}\n`); return 1; }
  if (!deckPath.startsWith(root + sep) && dirname(deckPath) !== root) {
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
  const review = createReviewRoutes(deckPath, { inRepo, gitOn, mode: 'read-only', out, onSubmitted: () => { submitted = true; } });
  const by = review.by;
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
  const files = staticFiles(deckDir, { knownTypesOnly: true });

  const server = createServer(async (req, res) => {
    // The same origin gate the edit server uses, for the same reason: binding
    // loopback is the wrong boundary when the dangerous caller is another tab
    // in the reviewer's own browser.
    if (!allowEditRequest(req)) { res.writeHead(403); res.end('this server answers this machine only'); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (review.matches(req, url)) {
      let body = '';
      if (req.method === 'POST') {
        try {
          for await (const chunk of req) { body += chunk; if (body.length > REVIEW_BODY_MAX) throw new Error('too large'); }
        } catch { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'that comment is too large' })); return; }
      }
      await review.handle(req, res, url, body);
      return;
    }
    if (files(req, res, url)) return;
    // Everything else — including every /edit/* path — lands here. There is no
    // route to have refused, which is the point.
    res.writeHead(405);
    res.end();
  });

  const port = parsePort(opt('--port', 8790));
  if (port === null) { process.stderr.write(`decklight review: ${badPort('--port', opt('--port'))}\n`); return 1; }
  const actual = await listenTakingOverIfNeeded(server, port, '127.0.0.1');
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
  process.exitCode = await runMain('review', () => reviewMain(process.argv.slice(2)));
}
