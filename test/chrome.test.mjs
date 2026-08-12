// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/chrome.mjs — where a browser is found, on an operating system the test
// is not running on. The whole module is one branch per platform, so it is pure
// over injected `exists`/`platform`/`env` (the tools/local-voice.mjs pattern):
// a branch nothing can reach is a branch nobody can check, which is exactly how
// Windows came to have no entries at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, findChrome, chromeArgs } from '../tools/chrome.mjs';

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };

test('Windows has candidates at all — it had none, so nothing there could render', () => {
  // With an empty list, findChrome returned null on every Windows machine that
  // had not set $CHROME, and `decklight pdf`/`video`/shot.mjs refused to run.
  const win = candidates('win32', WIN_ENV);
  assert.ok(win.length >= 3, `expected real Windows paths, got ${JSON.stringify(win)}`);
  assert.ok(win.every((p) => p.endsWith('chrome.exe')), 'every Windows candidate is an executable');
});

test('a per-user install is looked for first', () => {
  // What Chrome's own installer does without admin rights, and the one location
  // no fixed path can guess.
  assert.match(candidates('win32', WIN_ENV)[0], /^C:\\Users\\x\\AppData\\Local\\Google\\Chrome/);
});

test('no LOCALAPPDATA is dropped, not turned into a path rooted at a backslash', () => {
  const win = candidates('win32', {});
  assert.ok(!win.some((p) => p.startsWith('\\')), `a rootless path survived: ${JSON.stringify(win)}`);
  assert.ok(win.length >= 2, 'the machine-wide locations are still there');
});

test('the first installed candidate wins, in order', () => {
  const both = (p) => p.includes('Program Files\\Google') || p.includes('AppData');
  assert.match(findChrome({ exists: both, platform: 'win32', env: WIN_ENV }), /AppData/,
    'the per-user install outranks the machine-wide one');
  assert.match(findChrome({ exists: (p) => p.includes('Program Files\\Google'), platform: 'win32', env: WIN_ENV }),
    /Program Files\\Google/);
});

test('$CHROME wins on every platform, installed or not', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(findChrome({ exists: () => true, platform, env: { CHROME: '/somewhere/else' } }), '/somewhere/else');
    assert.equal(findChrome({ exists: () => true, platform, env: { DECKLIGHT_CHROME: '/other' } }), '/other');
  }
});

test('nothing installed is null, never a guess — report-bug prints that fact', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(findChrome({ exists: () => false, platform, env: {} }), null);
  }
});

test('macOS and Linux keep the paths they had', () => {
  const mac = candidates('darwin', { HOME: '/Users/x' });
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(mac.includes('/usr/bin/google-chrome') && mac.includes('/snap/bin/chromium'));
  assert.ok(mac.includes('/Users/x/.nix-profile/bin/chromium'), 'the nix profile follows $HOME');
});

test('--no-sandbox is CI-only, on any platform', () => {
  // AppArmor's userns restriction on GitHub's Ubuntu runners; a developer's
  // machine should never be handed a weakened sandbox by default.
  const was = process.env.CI;
  try {
    delete process.env.CI;
    assert.ok(!chromeArgs().includes('--no-sandbox'));
    process.env.CI = '1';
    assert.ok(chromeArgs().includes('--no-sandbox'));
  } finally {
    if (was === undefined) delete process.env.CI; else process.env.CI = was;
  }
});
