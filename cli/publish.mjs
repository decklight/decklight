#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight publish — turn a deck into a shareable URL in one command.
 *
 *   decklight publish <deck.html> [--branch gh-pages] [--remote origin]
 *                                 [--no-bundle] [--no-sign] [--path <subdir>]
 *                                 [--target gh-pages|netlify|vercel]
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
 *
 * --target picks where the bundled page goes (MARKETPLACE.md ENGINES).
 * gh-pages (the default) is the git-plumbing path above and needs no
 * credential. netlify and vercel need a token, read from that provider's own
 * CLI env var (NETLIFY_AUTH_TOKEN, VERCEL_TOKEN, …) — never a terminal
 * prompt, never written to disk (tools/publish-targets.mjs explains why).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFail, runMain } from './util.mjs';
import { isMain } from '../tools/args.mjs';
import { putBlob } from './git-tree.mjs';
import { TARGETS, schemaFor, envVarsFor, envAnswers, deploy } from '../tools/publish-targets.mjs';
import { checkAnswers } from './wizard.mjs';

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

/**
 * `client` is the sigstore client seam (cli/sign.mjs owns the concept): pass one
 * to drive signing without an OIDC identity, `null` to assert the
 * not-installed path. Omitted, the real client is found the usual way.
 *
 * `fetchImpl` is the same seam for a token-based target's HTTP call
 * (tools/publish-targets.mjs) — tests exercise Netlify/Vercel deploys against a
 * script, never a live account.
 */
export async function publishMain(argv = process.argv.slice(2), { client, fetchImpl } = {}) {

if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`decklight publish — bundle a deck and push it to GitHub Pages (or another target)

Usage:
  decklight publish <deck.html> [--branch gh-pages] [--remote origin]
                                [--no-bundle] [--no-sign] [--deck] [--path <subdir>]
                                [--target gh-pages|netlify|vercel]

Options:
  --branch <name>   branch to publish to (default: gh-pages; gh-pages target only)
  --remote <name>   git remote to push to (default: origin; gh-pages target only)
  --no-bundle       push the deck file as-is (skip single-file bundling)
  --no-sign         publish without a Sigstore signature
  --deck            also publish index.decklight — the signed container, which
                    is the file a visitor downloads and forwards
  --path <subdir>   publish under a subdirectory of the site (other content
                    on the branch is preserved)
  --target <name>   gh-pages (default, no credential) | netlify | vercel
                    netlify needs NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID
                    vercel needs VERCEL_TOKEN + VERCEL_PROJECT (+ VERCEL_TEAM_ID)

Publishing SIGNS by default: Sigstore keyless mints a short-lived certificate
against an OIDC identity — the ambient token in CI (GitHub Actions
needs permissions: id-token: write), or SIGSTORE_ID_TOKEN — and the detached
signature is pushed as index.html.sig beside the page. There are no keys to
manage; that is what keyless means. A publish is already a network action, so
signing adds no failure mode it did not already have. If signing fails nothing
is pushed, and --no-sign is the deliberate way past it.

The commit is built with git plumbing, so your working tree, index, and
current branch are untouched. The first publish creates the branch as an
orphan; later publishes append to its history.
`);
  return 0;
}

let deck = null, branch = 'gh-pages', remote = 'origin', bundle = true, subdir = '', sign = true, deckFile = false,
  target = 'gh-pages', branchGiven = false, remoteGiven = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--branch') { branch = argv[++i]; branchGiven = true; }
  else if (a === '--remote') { remote = argv[++i]; remoteGiven = true; }
  else if (a === '--no-bundle') bundle = false;
  else if (a === '--no-sign') sign = false;
  else if (a === '--deck') deckFile = true;
  else if (a === '--path') subdir = argv[++i];
  else if (a === '--target') target = argv[++i];
  else if (!a.startsWith('-') && !deck) deck = a;
  else fail(`unknown argument: ${a}`);
}
if (!deck) fail('no deck given');
// Checked here rather than at pack time: an argument that cannot work should
// be refused before the command starts doing things.
if (deckFile && !sign) fail('--deck packs the SIGNED deck — it cannot be combined with --no-sign');
if (target !== 'gh-pages' && !TARGETS.includes(target)) {
  fail(`"${target}" is not a publish target this decklight knows — try: gh-pages, ${TARGETS.join(', ')}`);
}
if (target !== 'gh-pages' && (branchGiven || remoteGiven)) {
  fail(`--branch/--remote are gh-pages options — "${target}" is not git, there is nothing for them to name`);
}
if (target === 'gh-pages' && (!branch || !/^[\w][\w./-]*$/.test(branch))) fail(`not a usable branch name: "${branch}"`);
const parts = (subdir || '').split('/').filter(Boolean);
if (parts.some((p) => p === '.' || p === '..')) fail(`--path must stay inside the site: "${subdir}"`);
const deckPath = path.resolve(deck);
if (!fs.existsSync(deckPath)) fail(`deck not found: ${deckPath}`);

// Every git call runs in the deck's directory — the deck's repo is the one
// being published, wherever the command was launched from. Only gh-pages
// touches git at all; a token-based target has no working tree to respect.
const cwd = path.dirname(deckPath);
const git = (args, input) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim();
  } catch (e) {
    fail(`git ${args[0]} failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
};

let remoteUrl;
if (target === 'gh-pages') {
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' }); }
  catch { fail(`${cwd} is not inside a git repository`); }
  try { remoteUrl = execFileSync('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8' }).trim(); }
  catch { fail(`no remote "${remote}" in this repository (git remote add ${remote} …)`); }
  // get-url applies url.*.insteadOf; the Pages URL derives from the remote as
  // CONFIGURED — insteadOf is a transport rewrite, not a different site.
  try {
    remoteUrl = execFileSync('git', ['config', '--get', `remote.${remote}.url`],
      { cwd, encoding: 'utf8' }).trim() || remoteUrl;
  } catch { /* unset (e.g. pushurl-only remotes) — keep get-url's answer */ }
}

// A token-based target needs its answers before any network call is made —
// the same refusal-before-action rule signing already follows below.
let targetAnswers = null;
if (target !== 'gh-pages') {
  const schema = schemaFor(target);
  targetAnswers = envAnswers(target, process.env);
  const checked = checkAnswers(schema, targetAnswers);
  if (!checked.ok) {
    const vars = envVarsFor(target);
    fail(`${target} needs: ${checked.errors.join('; ')}\n`
      + `  set it in the environment: ${Object.entries(vars).map(([f, v]) => `${v} (${f})`).join(', ')}`);
  }
}

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

// Signing is the DEFAULT here and opt-in on `bundle`, which looks inconsistent
// until you notice what publish already is: a network action. Sigstore keyless
// needs Fulcio and Rekor, so signing adds no failure mode a publish did not
// already have — while `bundle` is offline-clean and would gain one
// (INTEGRITY). It runs before any object is written, so a signing failure
// leaves the repository and the remote exactly as they were.
let signature = null;
if (sign) {
  const { signBytes, verifyBytes, formatSignature } = await import('./sign.mjs');
  try {
    signature = await signBytes(fs.readFileSync(sitePage), { client });
  } catch (e) {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    // Never silently unsigned: say what broke and name the deliberate way out,
    // so the unsigned publish is a decision someone made rather than one that
    // happened to them.
    fail(`${e.message}\n  publish signs by default — pass --no-sign to publish without a signature`);
  }
  process.stdout.write(`${formatSignature(await verifyBytes(fs.readFileSync(sitePage), signature, { client }))}\n`);
}

// The container is opt-in on both commands until it proves itself (INTEGRITY),
// and it needs the signature it wraps — so --deck without one is refused here
// rather than quietly producing an unsigned archive under an attesting name.
let deckBytes = null;
if (deckFile) {
  const { packContainer, originOf, runtimeVersionOf } = await import('./deckfile.mjs');
  const payload = fs.readFileSync(sitePage);
  const { bytes } = packContainer({
    payload, signature, name: 'index.html',
    runtime: runtimeVersionOf(payload.toString('utf8')), origin: originOf(deckPath),
  });
  deckBytes = bytes;
}

if (target !== 'gh-pages') {
  // No git object database involved: a token-based target has no working
  // tree, no history, and nothing else on the site to preserve or diff
  // against — the files below are simply what gets sent, in full, every time.
  const pageBytes = fs.readFileSync(sitePage);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  const files = [{ path: [...parts, 'index.html'].join('/'), data: pageBytes }];
  if (signature) files.push({ path: [...parts, 'index.html.sig'].join('/'), data: `${JSON.stringify(signature, null, 2)}\n` });
  if (deckBytes) files.push({ path: [...parts, 'index.decklight'].join('/'), data: deckBytes });

  let result;
  try { result = await deploy(target, targetAnswers, files, { fetchImpl }); }
  catch (e) { fail(`${target}: ${e.message}`); }
  process.stdout.write(`deployed to ${target}${result.id ? ` (${result.id})` : ''}\n`);
  process.stdout.write(result.url ? `${result.url}\n` : `${target} did not report a URL\n`);
  return { target, ...result };
}

// Objects land in the repo's database; nothing references them until the
// push, and neither the working tree nor the index ever hears about it.
const pageBlob = git(['hash-object', '-w', '--', sitePage]);
const nojekyllBlob = git(['hash-object', '-w', '--stdin'], '');
const sigBlob = signature ? git(['hash-object', '-w', '--stdin'], `${JSON.stringify(signature, null, 2)}\n`) : null;
const deckBlob = deckBytes
  // -w --stdin takes bytes on stdin; a Buffer keeps them exact.
  ? execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: deckBytes, encoding: 'utf8' }).trim()
  : null;
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });

// A second publish parents on the branch as the REMOTE has it — fetched
// fresh, so two machines publishing the same deck append to one history.
let parent = null;
if (git(['ls-remote', remote, `refs/heads/${branch}`])) {
  git(['fetch', '--quiet', remote, `refs/heads/${branch}`]);
  parent = git(['rev-parse', 'FETCH_HEAD']);
}

// The tree builders live in cli/git-tree.mjs now — `review submit` needs the
// same ones, and neither git's `name/` sort order nor the `--full-tree` scoping
// bug is a thing to keep two copies of.
const put = (treeish, parts_, blob) => putBlob(git, treeish, parts_, blob);

let tree = put(parent, ['.nojekyll'], nojekyllBlob);
tree = put(tree, [...parts, 'index.html'], pageBlob);
// Beside the page it covers, under the name a verifier will look for.
if (sigBlob) tree = put(tree, [...parts, 'index.html.sig'], sigBlob);
if (deckBlob) tree = put(tree, [...parts, 'index.decklight'], deckBlob);

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

if (isMain(import.meta.url)) process.exitCode = await runMain('publish', publishMain);
