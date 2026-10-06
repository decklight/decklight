// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review routes — SPEC REVIEW — as one thing every server that opens a
// deck registers, whichever way it was opened:
//
//   GET  /deck/review/comments    what has been said
//   POST /deck/review/comments    append one record: a comment, a reply (`re`),
//                            a resolve or a re-anchor (`op`)
//   POST /deck/review/submit      push what was said to a branch of its own
//
// What a page needs to know before it comments (`review` on /deck/ping: the
// mode, whether comments commit, who is writing, the store) comes from
// `ping()` here too. The edit server adds the owner's routes beside these
// (/deck/review/incoming, /deck/review/at, /deck/review/done: a fetch, a look into git
// history, a mark in git config), registered by it alone, the way the
// read-only server alone registers /deck/upstream.
//
// A review is
// something you can do in either mode of the one server: read-only, where the
// sidecar is the only file the process will ever write, and write mode, where
// it is one file among the deck's own. What is written is the same either way:
// an append to `<deck>.review.jsonl`, never a rewrite, which is what lets two
// reviewers' files merge and keeps the deck byte for byte as it was.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitAutocommit, commitSubject, oneline } from './git.mjs';
import { reviewPathFor, parseReview, serializeRecord, newId } from './review-store.mjs';

/** The reviewer, as git knows them: "Name <email>", either half, or ''. */
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

/** The most a comment's request body may be: prose, not an upload. */
export const REVIEW_BODY_MAX = 1e5;

/**
 * The routes for one deck.
 *
 * `inRepo` says whether the deck sits in a git repository (which commit of it
 * a comment is about is recorded only then); `gitOn` whether each comment is
 * committed by itself as it lands (read-only mode does, write mode leaves the
 * sidecar to the deck's own commits); `mode` is what the ping says the server
 * is ('read-only' | 'write'); `out` is the terminal; `onSubmitted` is told
 * when a submit went through, for the exit line.
 */
export function createReviewRoutes(deckPath, { inRepo = false, gitOn = false, mode = 'read-only', out = process.stdout, onSubmitted = () => {} } = {}) {
  const deckDir = dirname(deckPath);
  const name = basename(deckPath);
  const storePath = reviewPathFor(deckPath);
  const storeName = basename(storePath);
  const by = inRepo ? reviewerIdentity(deckDir) : '';
  // WHICH VERSION OF THE DECK a comment is about: provenance, not bookkeeping,
  // so it is gated on being in a repository and not on committing.
  const deckHead = () => {
    if (!inRepo) return null;
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: deckDir, encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** The `review` block of /deck/ping: what a page needs to know before it comments. */
  const ping = () => ({ mode, git: gitOn, by: by || null, store: storeName });
  const list = () => {
    const text = existsSync(storePath) ? readFileSync(storePath, 'utf8') : '';
    const { records, skipped } = parseReview(text);
    // `skipped` travels rather than being swallowed: a reader showing fewer
    // comments than the file holds should be able to say so.
    return { ok: true, records, skipped };
  };
  /** Append one record, commit it when this mode commits; `{ ok, id?, committed }` or `{ ok: false, error, code }`. */
  const append = (rec, subject) => {
    try {
      // Append, never rewrite — that is what makes `merge=union` work and a
      // second reviewer harmless.
      appendFileSync(storePath, `${serializeRecord(rec)}\n`);
    } catch (e) { return { ok: false, code: 500, error: oneline(e) }; }
    // The reviewer's own prose reaching a command line, so it goes through
    // the sanitizer every other untrusted subject does: one line, capped,
    // never leading `-`.
    const committed = gitOn ? gitAutocommit(storePath, deckDir, subject) : false;
    return { ok: true, ...(rec.id ? { id: rec.id } : {}), committed };
  };
  /**
   * Store one record: a NEW comment (no `op`, no `re`), a reply (`re`, with a
   * body), a resolve (`op: 'resolve', re`) or a re-anchor (`op: 'anchor', re,
   * slide`: a comment moved to the slide somebody is looking at, the
   * reconciliation for a slide deleted or rewritten past what fingerprint and
   * title can find). All four are appends: this file is never rewritten.
   */
  const post = (body) => {
    let input;
    try { input = JSON.parse(body || '{}'); } catch { return { ok: false, code: 400, error: 'bad payload' }; }
    const { op, re, body: text, slide, title, fp } = input;
    if (op === undefined && re === undefined) {
      const bad = commentProblem(input);
      if (bad) return { ok: false, code: 400, error: bad };
      const rec = reviewRecord(input, { by, at: new Date().toISOString(), deck: deckHead(), id: newId() });
      const r = append(rec, commitSubject(`review: ${rec.body}`, `review: a comment on ${name}`));
      if (r.ok) out.write(`  comment on slide ${rec.slide} → ${storeName}${r.committed ? ' (committed)' : ''}\n`);
      return r;
    }
    if (typeof re !== 'string' || !/^[a-z0-9]{1,12}$/.test(re)) return { ok: false, code: 400, error: 'bad comment id' };
    if (op === 'anchor') {
      const n = Number(slide);
      if (!Number.isInteger(n) || n < 1 || n > 9999) return { ok: false, code: 400, error: 'an anchor needs a slide' };
      if (title !== undefined && (typeof title !== 'string' || title.length > 500)) return { ok: false, code: 400, error: 'bad title' };
      if (fp !== undefined && (typeof fp !== 'string' || !/^[0-9a-f]{1,16}$/.test(fp))) return { ok: false, code: 400, error: 'bad fingerprint' };
    } else if (op !== 'resolve' && !(typeof text === 'string' && text.trim() && text.length <= 4000)) {
      return { ok: false, code: 400, error: 'a reply needs something in it' };
    }
    const at = new Date().toISOString();
    // A reply is a new statement about the deck and carries which version it
    // was made against, exactly as a comment does. A resolve or an anchor does
    // not: it is about the comment, not about the slide.
    const head = deckHead();
    const rec = op === 'anchor'
      ? { op: 'anchor', re, slide: Number(slide), ...(title !== undefined ? { title } : {}), ...(fp !== undefined ? { fp } : {}), at, ...(by ? { by } : {}) }
      : op === 'resolve'
        ? { op: 'resolve', re, at, ...(by ? { by } : {}) }
        : { id: newId(), at, ...(by ? { by } : {}), ...(head ? { deck: head } : {}), re, body: text };
    const r = append(rec, op === 'anchor'
      ? commitSubject(`review: move ${re} to slide ${rec.slide}`, 'review: re-anchor a comment')
      : op === 'resolve'
        ? commitSubject(`review: resolve ${re}`, 'review: resolve a comment')
        : commitSubject(`review: reply to ${re}`, 'review: a reply'));
    if (r.ok) out.write(`  review: ${op === 'anchor' ? `moved ${re} to slide ${rec.slide}` : op === 'resolve' ? `resolved ${re}` : `replied to ${re}`}${r.committed ? ' (committed)' : ''}\n`);
    return r;
  };
  const submit = async () => {
    // The browser NEVER runs git: it asks, and this server — the only thing
    // in the room holding a capability — does the pushing, with the same
    // code the typed `comments submit` runs.
    try {
      const { submitReview } = await import('./review-submit.mjs');
      const lines = [];
      const r = submitReview(deckPath, { out: { write: (t) => lines.push(t) } });
      out.write(lines.join(''));   // the terminal is a log of what happened
      onSubmitted();
      return { ok: true, branch: r.branch, comments: r.comments, resubmit: r.resubmit };
    } catch (e) {
      // A refusal (no remote, nothing to send) arrives with its way forward
      // in the message — the browser toasts it verbatim.
      return { ok: false, code: 500, error: String(e?.message ?? e) };
    }
  };

  /** Is `url` one of these routes? The caller reads the body (REVIEW_BODY_MAX) before `handle`. */
  const matches = (req, url) => url.pathname === '/deck/review/comments' || url.pathname === '/deck/review/submit';
  /** Answer the request; true when it was one of these routes. `body` is the POST text. */
  async function handle(req, res, url, body = '') {
    if (!matches(req, url)) return false;
    if (req.method === 'GET' && url.pathname === '/deck/review/comments') { json(res, 200, list()); return true; }
    if (req.method === 'POST' && url.pathname === '/deck/review/comments') {
      const r = post(body);
      json(res, r.ok ? 200 : r.code, r.ok ? r : { ok: false, error: r.error });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/deck/review/submit') {
      const r = await submit();
      json(res, r.ok ? 200 : r.code, r.ok ? r : { ok: false, error: r.error });
      return true;
    }
    return false;
  }

  return { handle, matches, ping, list, post, submit, storePath, storeName, by, name };
}
