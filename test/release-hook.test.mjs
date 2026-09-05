// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The release hook firing on release pushes, and ONLY on release pushes
// (.claude/hooks/pre-release-docs.sh).
//
// It guards something irreversible — `git push origin v*.*.*` runs release.yml
// and npm publishes, and an npm version cannot be taken back. So it has two
// failure modes and they are not symmetric. Missing a real release tag is the
// dangerous one. Firing on ordinary work is the corrosive one: a warning about
// something permanent, printed on a routine branch push, is a warning people
// learn to wave through — and then it is not there on the day it matters.
//
// It shipped with the second. The trigger grepped the WHOLE command string for
// a version-shaped word, so a branch push whose commit message contained the
// example `marketplace add acme/themes --branch v2.1.0` read as a release. Both
// halves matched; nothing connected them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { have } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, '.claude', 'hooks', 'pre-release-docs.sh');

// bash and jq are the hook's own dependencies, not decklight's — the runtime
// has none and the CLI is Node-only. Where they are missing (Windows CI) the
// hook cannot run at all, so neither can this.
const runnable = process.platform !== 'win32' && have('bash') && have('jq');

/** Did the hook treat `cmd` as a release push? */
function fires(cmd) {
  const r = spawnSync('bash', [hook], {
    cwd: root,
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
  });
  return r.stdout.trim().length > 0;
}

const QUIET = [
  ['a plain branch push', 'git push -u origin feat/x'],
  ['a bare push', 'git push'],
  ['pushing main', 'git push origin main'],
  ['a version inside commit -m', "git commit -m 'notes for v0.5.0' && git push origin feat/x"],
  ['a branch NAMED like a version', 'git push origin feat/v1.2.3-experiment'],
  ['a branch under a release/ prefix', 'git push origin release/v0.6.0'],
  ['a version in a PR title', 'gh pr create --title "cut v9.9.9"; git push origin feat/x'],
  ['a version in a trailing comment', 'git push origin feat/x # ready for v0.6.0'],
  ['deleting a branch', 'git push origin :old-branch'],
  ['the words in a string, with no push', 'echo "git push --tags" > notes.txt'],
  ['creating a tag without pushing it', 'git tag -a v0.6.0 -m "0.6.0"'],
  // the exact command that misfired, heredoc and all
  ['a heredoc commit message naming a version',
    ['git add -A && git commit -sq -F - <<\'MSG\'',
      'marketplace: --branch <ref>, and it takes a tag',
      '',
      '    decklight marketplace add acme/themes --branch v2.1.0',
      'MSG',
      'git push -qu origin feat/marketplace-branch'].join('\n')],
];

const FIRES = [
  ['an existing tag by name', 'git push origin v0.5.0'],
  ['--tags', 'git push --tags'],
  ['--follow-tags', 'git push --follow-tags origin main'],
  ['--mirror, which carries tags', 'git push --mirror origin'],
  ['an explicit refs/tags path', 'git push origin refs/tags/v9.9.9'],
  ['git\'s explicit `tag <name>` form', 'git push origin tag v0.5.0'],
  ['a src:dst refspec into refs/tags', 'git push origin HEAD:refs/tags/v9.9.9'],
  ['a tag push later in a chain', 'npm test && git push origin v0.5.0'],
  // the release itself: at hook time NEITHER half has run, so the tag does not
  // exist yet and asking git about it would answer no
  ['tag and push in one command', 'git tag -a v0.6.0 -m "0.6.0" && git push origin v0.6.0'],
  ['a branch and a new tag together', 'git push origin main v0.6.0'],
];

test('ordinary work does not trip the release warning', { skip: !runnable && 'needs bash + jq' }, () => {
  for (const [why, cmd] of QUIET) {
    assert.equal(fires(cmd), false, `fired on ${why}: ${JSON.stringify(cmd)}`);
  }
});

test('every way of pushing a tag is caught', { skip: !runnable && 'needs bash + jq' }, () => {
  for (const [why, cmd] of FIRES) {
    assert.equal(fires(cmd), true, `stayed quiet on ${why}: ${JSON.stringify(cmd)}`);
  }
});

test('the hook is executable and its trigger reads refs, not the whole line',
  { skip: !runnable && 'needs bash + jq' }, () => {
    const src = execFileSync('cat', [hook], { encoding: 'utf8' });
    // The specific regression: a bare version-shaped grep over `$cmd`.
    assert.doesNotMatch(src, /grep -Eq '\(\^\|\[\[:space:\]\]\)v\[0-9\]/,
      'the trigger greps the whole command for a version again');
    assert.match(src, /refs\/tags/, 'the trigger no longer mentions refs/tags');
  });
