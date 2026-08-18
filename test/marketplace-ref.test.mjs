// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `--branch <ref>` — a marketplace at a branch or a TAG (SPEC MARKETPLACE_REGISTRY).
//
// decklight never assumed `main` or `master`: with no flag, `git clone` follows
// the remote's HEAD, so a repo whose default is `trunk` always worked. What was
// missing was any way to ask for a NON-default ref — and the one people
// actually want is a tag, because that is how you pin a catalog to a version
// that is known to work.
//
// The interesting assertions here are the refusals. This value is the argument
// to `--branch` on a real command line, so a ref starting with `-` is an
// option; and a ref that is remembered but not re-used would turn a pin into
// decoration the first time anybody refreshed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REF_RE, fetchManifest, refProblem } from '../cli/marketplace.mjs';

// ── what may reach the command line ──────────────────────────────────────

test('ordinary branches and tags are accepted', () => {
  for (const ref of ['main', 'master', 'trunk', 'next', 'v1.0.0', 'v2.1.0-rc.1',
    'release/2026', 'feature/my-thing', 'a', 'beef', 'add']) {
    assert.equal(refProblem(ref), null, ref);
  }
});

test('a ref that would be read as an OPTION is refused', () => {
  // The one that matters: `--branch --upload-pack=…` is a remote-code-execution
  // shape in every git wrapper that ever forgot to check it.
  for (const ref of ['-x', '--upload-pack=evil', '--config', '-']) {
    assert.ok(refProblem(ref), `${ref} was accepted`);
  }
});

test('refspec punctuation and git\'s own reserved shapes are refused', () => {
  // `..` and `~^:?*[` mean something to a refspec; `.lock` is how git names its
  // lockfiles; a leading dot or slash is not a ref at all.
  for (const ref of ['a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b]', 'x.lock',
    '.hidden', '/leading', 'trailing/', 'has space', 'back\\slash']) {
    assert.ok(refProblem(ref), `${ref} was accepted`);
  }
});

test('empty and missing are refused, and say which', () => {
  for (const ref of ['', null, undefined]) assert.equal(refProblem(ref), 'is empty', JSON.stringify(ref));
});

test('a commit sha gets its own message, because it LOOKS like it should work', () => {
  // `git clone --branch <sha>` fails: --branch takes a ref and a bare object
  // name is not one. Relaying git's error would leave somebody guessing at a
  // typo they did not make.
  for (const sha of ['34a7854', 'deadbeefcafe', 'a'.repeat(40)]) {
    assert.match(refProblem(sha), /looks like a commit/, sha);
  }
  // ...but a short hex word that is a plausible branch name is NOT a commit
  for (const ref of ['beef', 'add', 'face', 'v1.0.0']) {
    assert.equal(refProblem(ref), null, ref);
  }
});

test('the pattern itself refuses a leading dash, dot or slash', () => {
  assert.equal(REF_RE.test('-x'), false);
  assert.equal(REF_RE.test('.x'), false);
  assert.equal(REF_RE.test('/x'), false);
  assert.equal(REF_RE.test('x'), true);
});

// ── against a real repository with a branch and a tag ────────────────────

const marketplace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-mkt-'));
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const manifest = (entries) => {
    fs.mkdirSync(path.join(dir, '.decklight'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.decklight', 'marketplace.json'),
      JSON.stringify({ name: 'acme', owner: 'ACME', entries }, null, 2));
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  manifest([{ name: 'one', type: 'theme', source: 'a.css', description: 'on main' }]);
  fs.writeFileSync(path.join(dir, 'a.css'), 'x');
  g(['add', '-A']); g(['commit', '-qm', 'main']);
  g(['tag', 'v1.0.0']);
  g(['checkout', '-qb', 'next']);
  manifest([
    { name: 'one', type: 'theme', source: 'a.css', description: 'on next' },
    { name: 'two', type: 'theme', source: 'a.css', description: 'only on next' },
  ]);
  g(['add', '-A']); g(['commit', '-qm', 'next']);
  g(['checkout', '-q', 'main']);
  return { dir, url: `file://${dir}`, g };
};

const staging = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-stage-'));
const entriesOf = (raw) => JSON.parse(raw).entries.map((e) => e.name);

test('no ref follows the remote\'s default branch, whatever it is called', async () => {
  const m = marketplace();
  // renamed on purpose: nothing in decklight may key off the NAME `main`
  m.g(['branch', '-m', 'main', 'trunk']);
  m.g(['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  const got = await fetchManifest({ kind: 'git', url: m.url, spec: m.url }, { stagingIn: staging() });
  assert.deepEqual(entriesOf(got.raw), ['one']);
  fs.rmSync(m.dir, { recursive: true, force: true });
});

test('a branch is cloned instead of the default', async () => {
  const m = marketplace();
  const got = await fetchManifest({ kind: 'git', url: m.url, spec: m.url },
    { ref: 'next', stagingIn: staging() });
  assert.deepEqual(entriesOf(got.raw), ['one', 'two']);
  fs.rmSync(m.dir, { recursive: true, force: true });
});

test('a TAG is cloned too — the point of the feature', async () => {
  // `--branch` takes a tag; it lands detached, which costs nothing because the
  // .git directory is deleted either way. A tag is what pins a catalog to a
  // version known to work.
  const m = marketplace();
  const got = await fetchManifest({ kind: 'git', url: m.url, spec: m.url },
    { ref: 'v1.0.0', stagingIn: staging() });
  assert.deepEqual(entriesOf(got.raw), ['one']);
  assert.ok(got.commit, 'a tagged clone still records the commit it resolved to');
  fs.rmSync(m.dir, { recursive: true, force: true });
});

test('a ref that does not exist names itself, and mentions tags', async () => {
  // git's own wording is "Remote branch X not found in upstream origin" — which
  // tells someone who asked for a TAG that their tag is not a branch, and that
  // is not what they got wrong.
  const m = marketplace();
  const err = await fetchManifest({ kind: 'git', url: m.url, spec: m.url },
    { ref: 'no-such-thing', stagingIn: staging() }).catch((e) => e);
  assert.match(err.message, /no branch or tag "no-such-thing"/);
  assert.match(err.message, /a tag works here too/);
  fs.rmSync(m.dir, { recursive: true, force: true });
});

test('a ref on a LOCAL directory is refused rather than ignored', async () => {
  // A directory has no refs to choose between — it is read in place. Accepting
  // the flag and quietly doing nothing would look exactly like success.
  const m = marketplace();
  const err = await fetchManifest({ kind: 'local', root: m.dir, spec: m.dir },
    { ref: 'next', stagingIn: staging() }).catch((e) => e);
  assert.match(err.message, /local directory/);
  assert.match(err.message, /--branch needs a repository/);
  fs.rmSync(m.dir, { recursive: true, force: true });
});

test('a failed clone leaves no staging directory behind', async () => {
  // Same invariant the unpinned path already had: a refusal must not litter.
  const m = marketplace();
  const stage = staging();
  await fetchManifest({ kind: 'git', url: m.url, spec: m.url },
    { ref: 'nope', stagingIn: stage }).catch(() => null);
  assert.deepEqual(fs.readdirSync(stage), [], 'a staging directory survived a refused clone');
  fs.rmSync(m.dir, { recursive: true, force: true });
});
