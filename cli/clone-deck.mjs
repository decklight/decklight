// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight author <git url>` — open a deck straight from its repository.
//
// The URL is the one people actually paste: the repository, or a GitHub link
// to the deck file itself. It is cloned IN FULL (history is what `H` shows and
// what makes a restore possible — a snapshot would open a deck with no past),
// the deck inside it is found or named, and from there it is `decklight
// author <local path>` exactly as before, in a directory that is already a
// repository — so autocommit, history and the upstream check all work from
// the first keystroke, and nothing here ever pushes.
//
// Only an explicit URL counts. `owner/repo` shorthand is not accepted: a
// mistyped `slides/q3.html` reads exactly like one, and the honest answer to a
// path that does not exist is "no such deck", not a clone attempt.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { refProblem } from './marketplace.mjs';
import { oneline } from './git.mjs';

const GIT_URL = /^(git@|ssh:\/\/|git:\/\/|file:\/\/|https?:\/\/)/;

/**
 * A git URL as author reads it, or null for anything that is a path.
 *
 * A GitHub link to a FILE (`/blob/<branch>/<path>`) names the repository, the
 * branch and the deck in one go; `/tree/<branch>` names the branch. A
 * `#path` fragment on any URL names the deck inside. `--branch` on the command
 * line outranks what the link said.
 */
export function parseDeckSource(spec, { branch = null } = {}) {
  if (typeof spec !== 'string' || !GIT_URL.test(spec)) return null;
  let url = spec;
  let deck = null;
  let ref = null;
  const hash = url.indexOf('#');
  if (hash >= 0) { deck = url.slice(hash + 1) || null; url = url.slice(0, hash); }
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(blob|tree)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(url);
  if (gh) {
    const [, owner, repo, kind, atRef, path] = gh;
    url = `https://github.com/${owner}/${repo}.git`;
    if (atRef) ref = atRef;
    if (kind === 'blob' && path) deck = deck ?? path;
  }
  if (branch) ref = branch;
  const bad = ref && refProblem(ref);
  if (bad) throw new Error(`--branch ${ref} ${bad}`);
  const name = basename(url.replace(/\/+$/, '')).replace(/\.git$/, '') || 'deck';
  return { url, ref, deck, name };
}

/** Two spellings of one remote: with or without `.git`, with or without a trailing slash. */
const sameRemote = (a, b) => a.replace(/\.git$/, '').replace(/\/+$/, '') === b.replace(/\.git$/, '').replace(/\/+$/, '');

/**
 * Clone `source` into `into` (default: `./<repo name>`), or open it if it is
 * already there. Returns { dir, reused, ref }.
 *
 * A directory that already exists is opened only when it is a clone of THIS
 * remote — anything else is refused rather than written into: "talk" being
 * taken by an unrelated folder is a fact to report, not a reason to pick
 * `talk-2` on somebody's behalf. Opening an existing clone does no network
 * write and no pull: `present`'s upstream check is what says if it is behind.
 */
export function cloneDeck(source, { into = null, cwd = process.cwd(), exec = execFileSync, env = process.env } = {}) {
  const dir = resolve(cwd, into ?? source.name);
  const git = (args, opts = {}) => String(exec('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    // never a password prompt: an unreachable private repo is an answer, not a hang
    env: { ...env, GIT_TERMINAL_PROMPT: '0' }, ...opts,
  })).trim();
  if (existsSync(dir)) {
    let origin = null;
    try { origin = git(['remote', 'get-url', 'origin'], { cwd: dir }); } catch { /* not a repo, or no origin */ }
    if (!origin || !sameRemote(origin, source.url)) {
      throw new Error(`${dir} already exists and is not a clone of ${source.url}${origin ? ` (its origin is ${origin})` : ''} — pass --into <dir>`);
    }
    return { dir, reused: true, ref: null };
  }
  try {
    git(['clone', '--quiet', ...(source.ref ? ['--branch', source.ref] : []), source.url, dir]);
  } catch (e) {
    throw new Error(`git clone ${source.url}${source.ref ? ` --branch ${source.ref}` : ''} failed — ${oneline(e)}`);
  }
  // A clone that checked out NOTHING: the remote's HEAD names a branch that
  // does not exist there — a repository whose default branch was renamed, or
  // a bare repo initialised on one name and pushed on another. Left in place
  // it would read as "no decklight deck", and a retry would find it "already
  // cloned"; so it is removed, and the branches that DO exist are named.
  try { git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: dir }); } catch {
    let branches = [];
    try { branches = git(['branch', '-r', '--format=%(refname:short)'], { cwd: dir }).split('\n').map((b) => b.replace(/^origin\//, '')).filter((b) => b && b !== 'HEAD'); } catch { /* none to name */ }
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${source.url} checked out nothing — its default branch is missing there. Pass --branch`
      + (branches.length ? `: ${branches.join(', ')}` : ' <name>'));
  }
  return { dir, reused: false, ref: source.ref };
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'voiceover', 'voices']);

/**
 * The deck inside a clone: the one named, else the ONE file that boots
 * decklight. Two candidates are a question for the person, not a guess —
 * the error names them so the answer is a `#path` away.
 */
export function findDeck(dir, named = null, { depth = 3 } = {}) {
  if (named) {
    if (/^[/\\]|^[a-zA-Z]:|(^|[/\\])\.\.([/\\]|$)/.test(named)) throw new Error(`the deck must be named relative to the repository, not ${named}`);
    const p = resolve(dir, named);
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`no ${named} in ${dir}`);
    return p;
  }
  const found = [];
  const walk = (d, level) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (level < depth && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), level + 1); continue; }
      if (!/\.html?$/i.test(e.name)) continue;
      let text = '';
      try { text = readFileSync(join(d, e.name), 'utf8'); } catch { continue; }
      if (/Decklight\.init\s*\(/.test(text)) found.push(join(d, e.name));
    }
  };
  walk(dir, 0);
  if (found.length === 1) return found[0];
  const rel = (p) => p.slice(dir.length + 1).split('\\').join('/');
  if (!found.length) throw new Error(`no decklight deck in ${dir} — nothing there calls Decklight.init`);
  throw new Error(`${found.length} decks in ${dir} — name one: append #<path> to the URL\n  ${found.map(rel).join('\n  ')}`);
}
