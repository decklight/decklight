#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Screenshot a deck — the evidence a reviewer actually looks at.
//
//   node tools/shot.mjs <deck.html> -o shot.png
//                       [--size 1280x720] [--wait 1500] [--theme eclipse]
//                       [--slide N] [--drive <file.mjs>] [--keys "g,ArrowRight"]
//                       [--query "print=handout"]
//
// --drive runs a snippet INSIDE the page after Decklight.init, so a feature can
// be exercised before the shutter: the deck is on `window.__deck`, and `press(k)`
// dispatches a key exactly as a presenter would. That is the difference between
// a screenshot of a deck and a screenshot of the THING THE TICKET ASKED FOR.
//
//   // shots/solo.mjs
//   press('/'); for (const c of 'solo') press(c); await sleep(100); press('Enter');
//
// The deck is served over http://127.0.0.1 under the `present` CSP — NOT opened
// over file:// with --allow-file-access-from-files (#229). That flag let a
// deck's own JS read any local file it could name (.git/config, tokens, keys)
// and exfiltrate it, and shot runs on decks you have not vetted — a repro deck
// off an issue, or one you screenshot before presenting it. An http origin
// cannot touch file://, and the read is confined to the served directory.
//
// Headless Chrome renders it; no puppeteer, no node_modules, nothing to install
// that CI does not already have.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { chromeBin, chromeArgs } from './chrome.mjs';
import { argReader, isMain } from './args.mjs';
import { injectBeforeBodyEnd } from './deck-html.mjs';
import { serveForRender } from '../cli/present.mjs';

const run = promisify(execFile);

const USAGE = 'usage: shot.mjs <deck.html> -o shot.png [--size 1280x720] [--wait 1500]'
  + ' [--theme name] [--slide N] [--drive file.mjs] [--keys "a,b"] [--query "print=handout"]';

// The default renderer: one async headless Chrome. Async is not incidental —
// the deck is served by an in-process server (serveForRender), and a SYNC child
// (execFileSync) would block the event loop so that server never answers.
// Injectable so a test can capture the argv without launching a browser.
async function chromeShot(bin, chromeArgv) {
  await run(bin, chromeArgv, { maxBuffer: 32 * 1024 * 1024 });
}

export async function shotMain(argv, { render = chromeShot } = {}) {
  const { opt } = argReader(argv);
  const page = argv.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!page || argv.includes('--help')) {
    console.error(USAGE);
    process.exit(page ? 0 : 1);
  }

  const out = resolve(opt('-o', 'shot.png'));
  const size = opt('--size', '1280x720');
  const wait = Number(opt('--wait', 1500));
  const theme = opt('--theme');
  const slide = opt('--slide');
  const keys = (opt('--keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const drive = opt('--drive');
  const query = opt('--query'); // deck URL query string, e.g. "print=handout"

  // The served root is the directory you run from — the deck must sit inside it,
  // so a source deck's `../dist/decklight.js` and `themes/…` still resolve as
  // relative URLs off the loopback origin. This is exactly `present`'s rule and
  // for the same reason: exposure is chosen by where you run the command, and a
  // read cannot escape the served tree. `cd` to a directory containing the deck.
  const root = process.cwd();
  const src = resolve(page);
  if (!existsSync(src)) { console.error(`shot: no such deck: ${src}`); process.exit(1); }
  if (src !== root && !src.startsWith(root + sep)) {
    console.error(`shot: the deck must live under the current directory (${root}) — cd there first`);
    process.exit(1);
  }

  // The driver runs in the page, so the shot can show a FEATURE and not just a
  // title card. Injected into the deck's response in memory (no temp file): the
  // deck is served at its own path, so every relative href in it still resolves.
  const driver = drive ? readFileSync(resolve(drive), 'utf8') : '';
  const boot = `
<script type="module">
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (k, opts = {}) => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  window.__deck = window.Decklight?.instances?.[0] ?? window.__decklight
    ?? document.querySelector('.decklight')?.__decklight ?? null;
  ${keys.length ? `for (const k of ${JSON.stringify(keys)}) { press(k); await sleep(120); }` : ''}
  ${driver}
</script>`;

  // Only the deck itself gets the theme link and the driver; every other html
  // asset under the root is served untouched.
  const inject = (text, file) => {
    if (file !== src) return text;
    let h = theme ? text.replace(/(<\/head>)/i, `<link rel="stylesheet" href="themes/${theme}.css">$1`) : text;
    return injectBeforeBodyEnd(h, boot) ?? h + boot;
  };

  mkdirSync(dirname(out), { recursive: true });
  const server = await serveForRender(root, { html: inject });
  try {
    const deckPath = '/' + relative(root, src).split(sep).join('/');
    const url = `${server.origin}${deckPath}${query ? `?${query}` : ''}${slide ? `#/${slide}/0` : ''}`;
    await render(chromeBin('shot'), chromeArgs(
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${size.replace('x', ',')}`,
      `--virtual-time-budget=${wait}`,
      `--screenshot=${out}`,
      url,
    ), { out, size, wait, url });
  } finally {
    await server.close();
  }

  if (!existsSync(out)) {
    console.error('shot: chrome produced no image');
    process.exit(1);
  }
  console.log(`${out} (${(Buffer.byteLength(readFileSync(out)) / 1024).toFixed(0)} KB)`);
}

if (isMain(import.meta.url)) await shotMain(process.argv.slice(2));
