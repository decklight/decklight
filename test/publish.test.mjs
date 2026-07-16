// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight publish`: the Pages URL derivation (pure), and the plumbing
// against a real bare origin — branch created as an orphan, second publish
// parents the first, and the author's checkout is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pagesUrl } from '../cli/publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

// --- pagesUrl ---------------------------------------------------------------

test('pagesUrl derives the site from every GitHub remote spelling', () => {
  assert.equal(pagesUrl('git@github.com:owner/repo.git'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('git@github.com:owner/repo'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('https://github.com/owner/repo.git'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('https://github.com/owner/repo'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('https://github.com/owner/repo/'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('ssh://git@github.com/owner/repo.git'), 'https://owner.github.io/repo/');
  assert.equal(pagesUrl('https://token@github.com/owner/repo.git'), 'https://owner.github.io/repo/');
});

test('pagesUrl treats owner.github.io repos as the user site root', () => {
  assert.equal(pagesUrl('git@github.com:owner/owner.github.io.git'), 'https://owner.github.io/');
  assert.equal(pagesUrl('https://github.com/Owner/Owner.github.io'), 'https://owner.github.io/');
});

test('pagesUrl answers null for anything that is not GitHub', () => {
  assert.equal(pagesUrl('https://gitlab.com/owner/repo.git'), null);
  assert.equal(pagesUrl('git@bitbucket.org:owner/repo.git'), null);
  assert.equal(pagesUrl('/tmp/origin.git'), null);
  assert.equal(pagesUrl('../elsewhere.git'), null);
  assert.equal(pagesUrl(''), null);
});

// --- integration fixture ------------------------------------------------------

const gitIn = (dir) => (...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A working repo with a real deck (runtime + theme copied from this repo,
 *  so the bundler has something to inline) and a bare origin next to it. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-publish-'));
  const bare = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(work, 'themes'));
  for (const f of ['dist/decklight.css', 'dist/decklight.js', 'themes/aurora.css']) {
    fs.copyFileSync(path.resolve(here, '..', f), path.join(work, f));
  }
  const deck = path.join(work, 'deck.html');
  fs.writeFileSync(deck, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Publish Me</title>
  <link rel="stylesheet" href="dist/decklight.css">
  <link rel="stylesheet" href="themes/aurora.css">
</head>
<body>
  <div class="decklight">
    <section><h2>Shareable</h2><p>one command to a URL</p></section>
  </div>
  <script src="dist/decklight.js"></script>
  <script>Decklight.init({});</script>
</body>
</html>
`);
  const git = gitIn(work);
  git('init', '--quiet');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'test@example.com');
  git('remote', 'add', 'origin', bare);
  git('add', 'deck.html');
  git('commit', '--quiet', '-m', 'deck');
  return { dir, bare, work, deck, git, bareGit: gitIn(bare) };
}

const snapshot = (git) => ({
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  status: git('status', '--porcelain'),
  index: git('write-tree'),
});

test('publish bundles to index.html + .nojekyll on an orphan gh-pages, then appends history', async () => {
  const { dir, work, deck, git, bareGit } = fixture();
  const before = snapshot(git);

  const { publishMain } = await import('../cli/publish.mjs');
  const r1 = await publishMain([deck]);

  // the branch exists on the bare origin, orphan, with the bundled site
  assert.equal(bareGit('rev-parse', 'refs/heads/gh-pages'), r1.commit);
  assert.equal(r1.parent, null, 'first publish is an orphan');
  assert.equal(bareGit('rev-list', '--count', 'gh-pages'), '1');
  const site = bareGit('show', 'gh-pages:index.html');
  assert.match(site, /<title>Publish Me<\/title>/);
  assert.doesNotMatch(site, /<script\b[^>]*\bsrc=/, 'runtime is inlined — the site is one file');
  assert.match(site, /<style data-theme="aurora">/);
  bareGit('cat-file', '-e', 'gh-pages:.nojekyll'); // throws if the blob is missing
  assert.match(bareGit('log', '-1', '--format=%B', 'gh-pages'),
    /Signed-off-by: Test Author <test@example\.com>/);
  assert.equal(r1.url, null, 'a filesystem origin has no Pages URL');

  // the author's checkout is untouched
  assert.deepEqual(snapshot(git), before, 'working tree, index, and branch unchanged');

  // second publish: same branch, new commit whose parent is the first
  const r2 = await publishMain([deck]);
  assert.equal(bareGit('rev-parse', 'refs/heads/gh-pages'), r2.commit);
  assert.equal(r2.parent, r1.commit, 'second publish parents the first — history, not force-push');
  assert.equal(bareGit('rev-parse', 'gh-pages^'), r1.commit);
  assert.deepEqual(snapshot(git), before);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish --no-bundle pushes the file as-is; --path nests it and keeps siblings', async () => {
  const { dir, deck, bareGit } = fixture();
  const { publishMain } = await import('../cli/publish.mjs');

  await publishMain([deck, '--no-bundle']);
  assert.equal(bareGit('show', 'gh-pages:index.html'), fs.readFileSync(deck, 'utf8').trim(),
    '--no-bundle publishes the deck byte-for-byte');

  await publishMain([deck, '--no-bundle', '--path', 'talks/demo']);
  assert.equal(bareGit('show', 'gh-pages:talks/demo/index.html'),
    fs.readFileSync(deck, 'utf8').trim());
  // the root index.html from the first publish survives the nested one
  assert.match(bareGit('show', 'gh-pages:index.html'), /<title>Publish Me<\/title>/);
  bareGit('cat-file', '-e', 'gh-pages:.nojekyll');
  assert.equal(bareGit('rev-list', '--count', 'gh-pages'), '2');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish honors --branch and --remote', async () => {
  const { dir, work, deck, git, bareGit } = fixture();
  const other = path.join(dir, 'other.git');
  execFileSync('git', ['init', '--quiet', '--bare', other]);
  git('remote', 'add', 'site', other);

  const { publishMain } = await import('../cli/publish.mjs');
  const r = await publishMain([deck, '--no-bundle', '--remote', 'site', '--branch', 'pages/v2']);
  assert.equal(r.branch, 'pages/v2');
  assert.equal(gitIn(other)('rev-parse', 'refs/heads/pages/v2'), r.commit);
  assert.throws(() => bareGit('rev-parse', 'refs/heads/gh-pages'), /./,
    'origin untouched when another remote is named');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the printed URL comes from the remote URL — GitHub remotes get a Pages link', async () => {
  const { dir, deck, git, bareGit } = fixture();
  // Point origin at GitHub for URL derivation, but reroute the actual
  // network traffic (ls-remote/fetch/push) back to the local bare repo.
  const bare = path.join(dir, 'origin.git');
  git('remote', 'set-url', 'origin', 'git@github.com:acme/rocket.git');
  git('config', `url.${bare}.insteadOf`, 'git@github.com:acme/rocket.git');

  const { publishMain } = await import('../cli/publish.mjs');
  const r1 = await publishMain([deck, '--no-bundle']);
  assert.equal(r1.url, 'https://acme.github.io/rocket/');
  assert.equal(bareGit('rev-list', '--count', 'gh-pages'), '1');

  const r2 = await publishMain([deck, '--no-bundle', '--path', 'talks']);
  assert.equal(r2.url, 'https://acme.github.io/rocket/talks/');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('first publish points at the Pages setting; the second does not repeat it', () => {
  const { dir, deck } = fixture();
  const run = () => spawnSync('node', [CLI, 'publish', deck, '--no-bundle'], { encoding: 'utf8' });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /first publish — new orphan branch/);
  assert.match(first.stdout, /Settings → Pages/);
  assert.match(first.stdout, /pushed [0-9a-f]{7} → origin refs\/heads\/gh-pages/);
  assert.match(first.stdout, /remote is not GitHub/, 'a filesystem remote prints the pushed ref');

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /\(parent [0-9a-f]{7}\)/);
  assert.doesNotMatch(second.stdout, /Settings → Pages/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('publish is routed and documented by the dispatcher, and fails usefully', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  publish /m, 'publish is listed in the global help');
  const sub = execFileSync('node', [CLI, 'help', 'publish'], { encoding: 'utf8' });
  assert.match(sub, /decklight publish <deck\.html>/);
  for (const flag of ['--branch', '--remote', '--no-bundle', '--path']) {
    assert.match(sub, new RegExp(flag.replace(/-/g, '\\-')), `help documents ${flag}`);
  }

  const bare = spawnSync('node', [CLI, 'publish'], { encoding: 'utf8' });
  assert.equal(bare.status, 0, 'no args prints help');
  assert.match(bare.stdout, /Usage:/);

  const missing = spawnSync('node', [CLI, 'publish', 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /deck not found/);
  assert.doesNotMatch(missing.stderr, /at .*\.mjs:\d+/, 'no stack trace');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-norepo-'));
  fs.writeFileSync(path.join(dir, 'deck.html'), '<html></html>');
  const norepo = spawnSync('node', [CLI, 'publish', path.join(dir, 'deck.html'), '--no-bundle'],
    { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
  assert.equal(norepo.status, 1);
  assert.match(norepo.stderr, /not inside a git repository|no remote "origin"/);

  const escape = spawnSync('node', [CLI, 'publish', 'deck.html', '--path', '../evil'], { encoding: 'utf8' });
  assert.equal(escape.status, 1);
  assert.match(escape.stderr, /--path must stay inside the site/);
  fs.rmSync(dir, { recursive: true, force: true });
});
