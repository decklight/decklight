#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight publish — turn a deck into a shareable URL in one command.
 *
 *   decklight publish <deck.html> [--branch gh-pages] [--remote origin]
 *                                 [--no-bundle] [--path <subdir>]
 *
 * Bundles the deck (via `decklight bundle`) to index.html + .nojekyll and
 * pushes them to a gh-pages branch on the remote, then prints the GitHub
 * Pages URL derived from the remote.
 *
 * The commit is built entirely with git plumbing — hash-object → mktree →
 * commit-tree → push <sha>:refs/heads/<branch> — so the author's working
 * tree, index, and checked-out branch are never touched. The first publish
 * creates the branch as an orphan; later publishes parent on the previous
 * gh-pages commit (history, not force-push). --path publishes under a
 * subdirectory, preserving whatever else the branch already carries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFail } from './util.mjs';
import { isMain } from '../tools/args.mjs';

const fail = makeFail('publish');

/**
 * The GitHub Pages URL a remote publishes to, or null when the remote is
 * not GitHub (the caller then prints the pushed ref instead).
 *
 *   git@github.com:owner/repo.git      → https://owner.github.io/repo/
 *   https://github.com/owner/repo(.git) → https://owner.github.io/repo/
 *   …/owner/owner.github.io           → https://owner.github.io/
 */
export function pagesUrl(remoteUrl) {
  const m = (remoteUrl || '').trim().match(
    /^(?:https?:\/\/(?:[^/@]+@)?|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2];
  if (repo.toLowerCase() === `${owner}.github.io`) return `https://${owner}.github.io/`;
  return `https://${owner}.github.io/${repo}/`;
}

// ---------------------------------------------------------------- arguments

export async function publishMain(argv = process.argv.slice(2)) {

if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`decklight publish — bundle a deck and push it to GitHub Pages

Usage:
  decklight publish <deck.html> [--branch gh-pages] [--remote origin]
                                [--no-bundle] [--path <subdir>]

Options:
  --branch <name>   branch to publish to (default: gh-pages)
  --remote <name>   git remote to push to (default: origin)
  --no-bundle       push the deck file as-is (skip single-file bundling)
  --path <subdir>   publish under a subdirectory of the site (other content
                    on the branch is preserved)

The commit is built with git plumbing, so your working tree, index, and
current branch are untouched. The first publish creates the branch as an
orphan; later publishes append to its history.
`);
  process.exit(0);
}

let deck = null, branch = 'gh-pages', remote = 'origin', bundle = true, subdir = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--branch') branch = argv[++i];
  else if (a === '--remote') remote = argv[++i];
  else if (a === '--no-bundle') bundle = false;
  else if (a === '--path') subdir = argv[++i];
  else if (!a.startsWith('-') && !deck) deck = a;
  else fail(`unknown argument: ${a}`);
}
if (!deck) fail('no deck given');
if (!branch || !/^[\w][\w./-]*$/.test(branch)) fail(`not a usable branch name: "${branch}"`);
const parts = (subdir || '').split('/').filter(Boolean);
if (parts.some((p) => p === '.' || p === '..')) fail(`--path must stay inside the site: "${subdir}"`);
const deckPath = path.resolve(deck);
if (!fs.existsSync(deckPath)) fail(`deck not found: ${deckPath}`);

// Every git call runs in the deck's directory — the deck's repo is the one
// being published, wherever the command was launched from.
const cwd = path.dirname(deckPath);
const git = (args, input) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim();
  } catch (e) {
    fail(`git ${args[0]} failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
};

try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' }); }
catch { fail(`${cwd} is not inside a git repository`); }
let remoteUrl;
try { remoteUrl = execFileSync('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8' }).trim(); }
catch { fail(`no remote "${remote}" in this repository (git remote add ${remote} …)`); }
// get-url applies url.*.insteadOf; the Pages URL derives from the remote as
// CONFIGURED — insteadOf is a transport rewrite, not a different site.
try {
  remoteUrl = execFileSync('git', ['config', '--get', `remote.${remote}.url`],
    { cwd, encoding: 'utf8' }).trim() || remoteUrl;
} catch { /* unset (e.g. pushurl-only remotes) — keep get-url's answer */ }

// --------------------------------------------------------------------- bundle

let sitePage = deckPath;
let tmpDir = null;
if (bundle) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-publish-'));
  sitePage = path.join(tmpDir, 'index.html');
  const { bundleMain } = await import('./bundle.mjs');
  await bundleMain([deckPath, '-o', sitePage]);
}

// --------------------------------------------------------------- plumbing

// Objects land in the repo's database; nothing references them until the
// push, and neither the working tree nor the index ever hears about it.
const pageBlob = git(['hash-object', '-w', '--', sitePage]);
const nojekyllBlob = git(['hash-object', '-w', '--stdin'], '');
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

// A second publish parents on the branch as the REMOTE has it — fetched
// fresh, so two machines publishing the same deck append to one history.
let parent = null;
if (git(['ls-remote', remote, `refs/heads/${branch}`])) {
  git(['fetch', '--quiet', remote, `refs/heads/${branch}`]);
  parent = git(['rev-parse', 'FETCH_HEAD']);
}

const lsTree = (sha) => git(['ls-tree', sha]).split('\n').filter(Boolean).map((l) => {
  const [meta, name] = l.split('\t');
  const [mode, type, entrySha] = meta.split(/\s+/);
  return { mode, type, sha: entrySha, name };
});
const mktree = (entries) => {
  // git's tree order: byte-wise, with tree names comparing as "name/"
  const key = (e) => (e.type === 'tree' ? `${e.name}/` : e.name);
  entries.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return git(['mktree'], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\n`).join(''));
};
// Return a copy of the tree at `treeish` with the blob placed at pathParts,
// building intermediate trees and keeping every sibling entry.
const putBlob = (treeish, pathParts, blobSha) => {
  const entries = treeish ? lsTree(treeish) : [];
  const name = pathParts[0];
  const kept = entries.filter((e) => e.name !== name);
  if (pathParts.length === 1) {
    kept.push({ mode: '100644', type: 'blob', sha: blobSha, name });
  } else {
    const sub = entries.find((e) => e.name === name && e.type === 'tree');
    kept.push({ mode: '040000', type: 'tree', sha: putBlob(sub?.sha, pathParts.slice(1), blobSha), name });
  }
  return mktree(kept);
};

let tree = putBlob(parent, ['.nojekyll'], nojekyllBlob);
tree = putBlob(tree, [...parts, 'index.html'], pageBlob);

const config = (key) => {
  try { return execFileSync('git', ['config', key], { cwd, encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const name = config('user.name'), email = config('user.email');
let message = `publish: ${path.basename(deckPath)} → ${branch}`
  + (parts.length ? ` (${parts.join('/')}/)` : '');
if (name && email) message += `\n\nSigned-off-by: ${name} <${email}>`;
const env = name && email ? process.env : {
  ...process.env,
  GIT_AUTHOR_NAME: 'decklight', GIT_AUTHOR_EMAIL: 'decklight@localhost',
  GIT_COMMITTER_NAME: 'decklight', GIT_COMMITTER_EMAIL: 'decklight@localhost',
};
let commit;
try {
  commit = execFileSync('git',
    ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
    { cwd, encoding: 'utf8', env }).trim();
} catch (e) {
  fail(`git commit-tree failed: ${(e.stderr || e.message || '').toString().trim()}`);
}

git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);

// ------------------------------------------------------------------ report

const short = commit.slice(0, 7);
process.stdout.write(parent
  ? `pushed ${short} → ${remote} refs/heads/${branch} (parent ${parent.slice(0, 7)})\n`
  : `pushed ${short} → ${remote} refs/heads/${branch} (first publish — new orphan branch)\n`);

const base = pagesUrl(remoteUrl);
const url = base ? base + (parts.length ? parts.join('/') + '/' : '') : null;
if (url) {
  process.stdout.write(`${url}\n`);
} else {
  process.stdout.write(`remote is not GitHub (${remoteUrl}) — pushed refs/heads/${branch}\n`);
}
if (!parent) {
  process.stdout.write(`first publish: enable Pages in the repo Settings → Pages → `
    + `Deploy from a branch → ${branch} / (root)\n`);
}

return { commit, parent, tree, branch, remote, url };
}

if (isMain(import.meta.url)) publishMain().catch((e) => fail(e.message));
