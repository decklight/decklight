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
// Git is the backend but never the transport: with a repository, each comment is
// committed (the sidecar alone, staged by itself); with none, the file is just a
// file, which is the thing you send back. decklight never pushes.

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

  M in the deck opens the composer (or / → "Leave a review comment…"); the
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

export async function reviewMain(args, { open = openUrl, out = process.stdout, onListen = null } = {}) {
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
    + `${gitOn ? ', committed as you go' : ', not committed — this is not a git repository'}\n`);
  if (!gitOn && !noGit) {
    out.write(`  send ${storeName} back when you are done; the author reads it with:\n`);
    out.write(`      decklight comments ${name} --import ${storeName}\n`);
  }
  out.write('  Ctrl-C when you are done.\n');
  if (!args.includes('--no-open')) await open(url, { out, what: url });
  return 0;
}

if (isMain(import.meta.url)) {
  exitWhenOrphaned();
  reviewMain(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; });
}
