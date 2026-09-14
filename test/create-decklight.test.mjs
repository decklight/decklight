// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The `npm create decklight` shim (create-decklight/): the directory npm's
// convention hands us becomes init's --dir and its title, and everything else
// passes through. Pure, so the bin itself — which spawns npx — is one line
// nothing here needs to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initArgs, npxCommand, titleFromDir } from '../create-decklight/lib.mjs';

test('the directory names the title: kebab, snake and nested paths all read as words', () => {
  assert.equal(titleFromDir('my-talk'), 'My Talk');
  assert.equal(titleFromDir('q3_review'), 'Q3 Review');
  assert.equal(titleFromDir('talks/2026/kubecon-keynote/'), 'Kubecon Keynote', 'the last segment, trailing slash or not');
  assert.equal(titleFromDir('iOS-deck'), 'iOS Deck', 'a word that already has a capital is left alone');
  assert.equal(titleFromDir(''), 'My Deck', 'init’s own default when there is nothing to go on');
});

test('the first positional is the directory; flags pass through in order', () => {
  assert.deepEqual(initArgs(['my-talk']), ['init', '--dir', 'my-talk', 'My Talk']);
  assert.deepEqual(initArgs(['my-talk', '--no-git', '--themes', 'fjord']),
    ['init', '--dir', 'my-talk', 'My Talk', '--no-git', '--themes', 'fjord']);
  assert.deepEqual(initArgs(['--no-git', 'my-talk']), ['init', '--dir', 'my-talk', 'My Talk', '--no-git'],
    'a flag before the directory does not become the directory');
});

test('no directory means a plain init, which asks its own questions', () => {
  assert.deepEqual(initArgs([]), ['init']);
  assert.deepEqual(initArgs(['--no-skill']), ['init', '--no-skill']);
});

test('npm’s `--` separator is dropped, not handed to init as an argument', () => {
  assert.deepEqual(initArgs(['my-talk', '--', '--no-git']), ['init', '--dir', 'my-talk', 'My Talk', '--no-git']);
});

test('on Windows npx is a .cmd shim and needs a shell; elsewhere it does not', () => {
  assert.deepEqual(npxCommand('win32'), { cmd: 'npx.cmd', shell: true });
  assert.deepEqual(npxCommand('linux'), { cmd: 'npx', shell: false });
});
