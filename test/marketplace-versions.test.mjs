// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Marketplace entries carry a semver `version`, and what you installed is
// compared against it (#616): validated in the manifest, recorded by every
// kind's `add`, shown by `marketplace list`, reported by `marketplace update`
// with the command that takes it — and never written into a deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './helpers.mjs';
import {
  validateManifest, semverCompare, SEMVER_RE, recordInstall, loadLedger, forgetInstall, reinstallHint,
} from '../cli/marketplace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const AURORA = readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8');

const manifest = (entries) => JSON.stringify({ name: 'acme', entries }, null, 2);

test('an entry may carry a semver version; a non-semver one is refused with the field named, and none is fine', () => {
  const ok = validateManifest(manifest([
    { name: 'nord', type: 'theme', source: 'themes/nord.css', version: '1.1.0' },
    { name: 'pitch', type: 'template', source: 'pitch.html', version: '2.0.0-rc.1+build.5' },
    { name: 'old', type: 'template', source: 'old.html' },
  ]));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  for (const bad of ['v1.1', '1.1', '01.0.0', '1.0', 1.1]) {
    const v = validateManifest(manifest([{ name: 'nord', type: 'theme', source: 'themes/nord.css', version: bad }]));
    assert.equal(v.ok, false, `${JSON.stringify(bad)} is not semver`);
    assert.equal(v.errors[0].field, 'entries[0].version');
    assert.match(v.errors[0].msg, /a semver version, major\.minor\.patch \(e\.g\. "1\.1\.0"\), no leading v/);
  }
});

test('semver precedence: numbers numerically, a prerelease before its release, build metadata ignored', () => {
  assert.equal(semverCompare('1.10.0', '1.9.0'), 1);
  assert.equal(semverCompare('1.0.0', '1.0.0+build.7'), 0);
  assert.equal(semverCompare('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(semverCompare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(semverCompare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(semverCompare('1.0.0-beta', '1.0.0-alpha.9'), 1);
  assert.equal(semverCompare('v1.0.0', '1.0.0'), null);
  assert.ok(SEMVER_RE.test('0.0.1') && !SEMVER_RE.test('1.2.3.4'));
});

test('the ledger records an install per kind and marketplace, overwrites on a re-add, and forgets on remove', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dl-ledger-'));
  t.after(() => rmTemp(home));
  recordInstall({ type: 'template', name: 'pitch', marketplace: 'acme', version: '1.0.0', commit: 'abc' }, home, 0);
  recordInstall({ type: 'template', name: 'pitch', marketplace: 'acme', version: '1.1.0', commit: 'def' }, home, 1000);
  const { installs } = loadLedger(home);
  assert.deepEqual(installs['template:pitch@acme'], {
    type: 'template', name: 'pitch', marketplace: 'acme', version: '1.1.0', commit: 'def', at: '1970-01-01T00:00:01.000Z',
  });
  assert.equal(forgetInstall({ type: 'template', name: 'pitch' }, home), 1);
  assert.deepEqual(loadLedger(home).installs, {});
  assert.equal(reinstallHint('theme', 'nord@acme'), 'decklight theme add nord@acme <deck>');
  assert.equal(reinstallHint('template', 'pitch@acme'), 'decklight template add pitch@acme');
});

test('the demo: install, the catalog bumps, update names what is newer and how to take it — and no deck is touched', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-versions-'));
  t.after(() => rmTemp(dir));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'acme');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'));
  writeFileSync(path.join(repo, 'themes', 'nord.css'), AURORA);
  writeFileSync(path.join(repo, 'pitch.html'), '<!doctype html><title>pitch</title>');
  const write = (nordVersion) => writeFileSync(path.join(repo, '.decklight', 'marketplace.json'), manifest([
    { name: 'nord', type: 'theme', source: 'themes/nord.css', version: nordVersion },
    { name: 'pitch', type: 'template', source: 'pitch.html', version: '2.0.0' },
  ]));
  write('1.0.0');
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, '<!doctype html><html><head><title>T</title>\n'
    + '<script type="application/json" data-decklight-config>{"decklight":"0.9.0","theme":"aurora"}</script>\n'
    + '</head><body><div class="decklight"><section><h1>One</h1></section></div></body></html>\n');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home } });

  assert.equal(cli('marketplace', 'add', repo).status, 0);
  const added = cli('theme', 'add', 'nord@acme', deckPath);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /marked nord@acme 1\.0\.0 in /);
  const tpl = cli('template', 'add', 'pitch@acme');
  assert.match(tpl.stdout, /installed pitch 2\.0\.0 from pitch@acme/);
  const deckAfterAdd = readFileSync(deckPath, 'utf8');
  assert.doesNotMatch(deckAfterAdd, /1\.0\.0/, 'the deck holds a mark, never a version');
  assert.deepEqual(Object.fromEntries(Object.entries(loadLedger(home).installs).map(([k, r]) => [k, r.version])),
    { 'theme:nord@acme': '1.0.0', 'template:pitch@acme': '2.0.0' });
  assert.match(cli('marketplace', 'list').stdout, /^ {4}nord@acme {2}1\.0\.0 installed$/m);

  // the catalog bumps nord
  write('1.1.0');
  const up = cli('marketplace', 'update', 'acme');
  assert.equal(up.status, 0, up.stderr);
  assert.match(up.stdout, /newer than what you installed:\n {4}nord@acme {2}1\.0\.0 → 1\.1\.0 {2}— {2}decklight theme add nord@acme <deck>/);
  assert.doesNotMatch(up.stdout, /pitch@acme {2}2\.0\.0 →/, 'what is current is not reported');
  assert.match(cli('marketplace', 'list').stdout, /^ {4}nord@acme {2}1\.0\.0 → 1\.1\.0$/m);
  assert.equal(readFileSync(deckPath, 'utf8'), deckAfterAdd, 'update never rewrites a deck');

  // taking it: the kind's own add, again
  const again = cli('theme', 'add', 'nord@acme', deckPath);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already marked in .* — recorded 1\.1\.0 as the version you have/);
  assert.equal(readFileSync(deckPath, 'utf8'), deckAfterAdd, 'still not the deck: the mark was already there');
  assert.equal(loadLedger(home).installs['theme:nord@acme'].version, '1.1.0');
  assert.doesNotMatch(cli('marketplace', 'update', 'acme').stdout, /newer than what you installed/);
  assert.match(cli('marketplace', 'list').stdout, /^ {4}nord@acme {2}1\.1\.0 installed$/m);

  // removing an installed unit forgets it
  assert.equal(cli('template', 'remove', 'pitch').status, 0);
  assert.equal(loadLedger(home).installs['template:pitch@acme'], undefined);
});
