// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One place that knows how to start a headless Chrome. Four files were each
// carrying their own copy of this list, and each one was a chance to get it
// wrong — the character harness still had only the macOS path, so it could never
// have run in CI at all.

import { existsSync } from 'node:fs';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  `${process.env.HOME}/.nix-profile/bin/chromium`,
];

/** The browser to drive: $CHROME wins, else the first one installed. */
export function chromeBin(who = 'chrome') {
  const bin = process.env.CHROME || process.env.DECKLIGHT_CHROME
    || CANDIDATES.find((p) => existsSync(p));
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
