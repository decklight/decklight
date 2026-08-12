// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One place that knows how to start a headless Chrome. Four files were each
// carrying their own copy of this list, and each one was a chance to get it
// wrong — the character harness still had only the macOS path, so it could never
// have run in CI at all.

import { existsSync } from 'node:fs';

/**
 * Where a browser installs itself, per platform.
 *
 * Windows was simply missing, which is not a small omission: with nothing here
 * to find, `findChrome` returned null on every Windows machine that had not set
 * $CHROME, so `decklight pdf`, `decklight video` and tools/shot.mjs all refused
 * to run on the platform — on decks they render perfectly everywhere else.
 *
 * `%LOCALAPPDATA%` first among the Windows paths because a per-user install
 * (what Chrome's own installer does without admin rights) is both the common
 * case and the one no fixed path can guess. Edge is deliberately NOT listed
 * even though it is Chromium and would probably work: "probably" is not
 * something to hard-code into every render path, and `$CHROME` already lets
 * anyone point at it deliberately.
 */
export const candidates = (platform = process.platform, env = process.env) => (platform === 'win32'
  ? [
    `${env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${env.LOCALAPPDATA ?? ''}\\Chromium\\Application\\chrome.exe`,
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ].filter((p) => !p.startsWith('\\'))
  : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    `${env.HOME}/.nix-profile/bin/chromium`,
  ]);

/**
 * Where Chrome is, or null — the non-fatal half. `$CHROME` wins, else the first
 * one installed. `decklight report-bug` needs to REPORT that a machine has no
 * Chrome, which it cannot do if merely asking exits the process.
 *
 * Pure over injected `exists`/`platform`/`env`, the way tools/local-voice.mjs
 * is: the whole point is branching on an operating system the tests are not
 * running on, and a branch nothing can reach is a branch nobody can check.
 */
export function findChrome({ exists = existsSync, platform = process.platform, env = process.env } = {}) {
  return env.CHROME || env.DECKLIGHT_CHROME
    || candidates(platform, env).find((p) => exists(p)) || null;
}

export function chromeBin(who = 'chrome', opts = {}) {
  const bin = findChrome(opts);
  if (!bin) {
    console.error(`${who}: no Chrome found — install one, or point $CHROME at it`);
    process.exit(1);
  }
  return bin;
}

/**
 * Flags every headless run needs.
 *
 * --no-sandbox ONLY under CI: GitHub's Ubuntu runners restrict unprivileged user
 * namespaces (AppArmor), so Chrome's zygote cannot start there and dies with
 * "No usable sandbox!". The container is ephemeral and the pages are our own test
 * files, so dropping it there is fine — but a developer's machine keeps its
 * sandbox, because that is where a real browser would open a real page.
 */
export const chromeArgs = (...extra) => [
  '--headless', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox'] : []),
  ...extra,
];
