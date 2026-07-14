#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Screenshot a deck — the evidence a reviewer actually looks at.
//
//   node tools/shot.mjs <deck.html> -o shot.png
//                       [--size 1280x720] [--wait 1500] [--theme eclipse]
//                       [--slide N] [--drive <file.mjs>] [--keys "g,ArrowRight"]
//
// --drive runs a snippet INSIDE the page after Decklight.init, so a feature can
// be exercised before the shutter: the deck is on `window.__deck`, and `press(k)`
// dispatches a key exactly as a presenter would. That is the difference between
// a screenshot of a deck and a screenshot of the THING THE TICKET ASKED FOR.
//
//   // shots/solo.mjs
//   press('/'); for (const c of 'solo') press(c); await sleep(100); press('Enter');
//
// Headless Chrome renders it; no puppeteer, no node_modules, nothing to install
// that CI does not already have.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const page = args.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
if (!page || args.includes('--help')) {
  console.error('usage: shot.mjs <deck.html> -o shot.png [--size 1280x720] [--wait 1500]'
    + ' [--theme name] [--slide N] [--drive file.mjs] [--keys "a,b"]');
  process.exit(page ? 0 : 1);
}

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  `${process.env.HOME}/.nix-profile/bin/chromium`,
];
const CHROME = process.env.CHROME || process.env.DECKLIGHT_CHROME
  || CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('shot: no Chrome found — install one, or point $CHROME at it');
  process.exit(1);
}

const out = resolve(opt('-o', 'shot.png'));
const size = opt('--size', '1280x720');
const wait = Number(opt('--wait', 1500));
const theme = opt('--theme');
const slide = opt('--slide');
const keys = (opt('--keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const drive = opt('--drive');

// The driver runs in the page, so the shot can show a FEATURE and not just a
// title card. Injected by writing a sibling copy of the deck — a sibling so that
// every relative href in it (dist/, themes/, voices/) still resolves.
const src = resolve(page);
const driver = drive ? readFileSync(resolve(drive), 'utf8') : '';
const boot = `
<script type="module">
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (k, opts = {}) => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  window.__deck = window.Decklight?.instances?.[0] ?? window.__decklight ?? null;
  ${keys.length ? `for (const k of ${JSON.stringify(keys)}) { press(k); await sleep(120); }` : ''}
  ${driver}
</script>`;

const tmp = src.replace(/\.html?$/i, `.__shot-${process.pid}.html`);
let html = readFileSync(src, 'utf8');
if (theme) html = html.replace(/(<\/head>)/i, `<link rel="stylesheet" href="themes/${theme}.css">$1`);
html = html.replace(/(<\/body>)/i, `${boot}$1`);
writeFileSync(tmp, html);

mkdirSync(dirname(out), { recursive: true });
try {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${size.replace('x', ',')}`,
    `--virtual-time-budget=${wait}`,
    `--screenshot=${out}`,
    `file://${tmp}${slide ? `#/${slide}/0` : ''}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
} finally {
  rmSync(tmp, { force: true });
}

if (!existsSync(out)) {
  console.error('shot: chrome produced no image');
  process.exit(1);
}
console.log(`${out} (${(Buffer.byteLength(readFileSync(out)) / 1024).toFixed(0)} KB)`);
