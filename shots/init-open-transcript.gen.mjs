#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Demo evidence for `decklight init --open` (#92, the #52 half) — a CLI
// feature, so the screenshot surface is the transcript. This script runs the
// real CLI twice and renders both transcripts into one terminal-styled HTML
// for shot.mjs:
//
//   1. with a logging stand-in `xdg-open` first on PATH, so the spawn call is
//      CAPTURED (launcher + the file:// URL it was handed) instead of a
//      browser appearing on a headless runner;
//   2. with an empty PATH — no launcher anywhere — showing the graceful skip
//      line and the exit code staying 0.
//
// It also leaves the scaffolded deck at .shots/init-open-demo/deck.html so a
// second shot can show what the launched browser displays:
//
//   node shots/init-open-transcript.gen.mjs
//   node tools/shot.mjs .shots/init-open-transcript.html -o .shots/init-open-transcript.png --wait 800
//   node tools/shot.mjs .shots/init-open-demo/deck.html -o .shots/init-open-deck.png --drive shots/init-open.mjs --wait 15000

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');
const shots = path.join(root, '.shots');
const demo = path.join(shots, 'init-open-demo');
fs.rmSync(demo, { recursive: true, force: true });
fs.mkdirSync(demo, { recursive: true });

// a PATH whose only xdg-open logs its argument instead of opening anything
const bin = path.join(demo, 'bin');
fs.mkdirSync(bin);
const log = path.join(bin, 'xdg-open.log');
fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > "${log}"\n`, { mode: 0o755 });

const run = (args, PATH) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', cwd: demo, env: { ...process.env, PATH } });

const ok = run(['init', 'Hello Decklight', '--open'], `${bin}:${process.env.PATH}`);
const spawned = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '(launcher never ran!)';

const skip = run(['init', 'Hello Decklight', '--open', '--dir', 'headless', '--no-skill'], path.join(demo, 'empty'));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const block = (cmd, r, extra = '') => `<div class="run">
<p class="cmd">$ ${esc(cmd)}</p>
<pre>${esc(r.stdout.trimEnd()).replace(/^(--open: .*)$/m, '<span class="dim">$1</span>')}</pre>
${extra}<p class="exit">exit code: ${r.status}</p>
</div>`;

fs.writeFileSync(path.join(shots, 'init-open-transcript.html'), `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin:0; padding:48px; background:#101418; color:#d8dee6; font:17px/1.65 ui-monospace,'SF Mono',Menlo,monospace; }
  h1 { font-size:20px; color:#8fd0ff; margin:0 0 28px; font-weight:600; }
  .run { background:#181e25; border:1px solid #2a333d; border-radius:10px; padding:18px 24px; margin-bottom:26px; }
  .cmd { color:#7ee08a; margin:0 0 6px; } pre { margin:0; white-space:pre-wrap; }
  .dim { opacity:.55; } .exit { color:#8b98a5; margin:8px 0 0; font-size:14px; }
  .note { color:#e0b464; } .caption { color:#8b98a5; font-size:14px; margin:-18px 0 26px 2px; }
</style>
<h1>decklight init --open — #92 (the #52 half)</h1>
${block('decklight init "Hello Decklight" --open', ok,
    `<p class="note">↳ launcher invoked: xdg-open ${esc(spawned)}</p>`)}
<p class="caption">the spawn call, logged by a stand-in xdg-open first on PATH — detached, stdio ignored, init exits promptly</p>
${block('PATH= decklight init "Hello Decklight" --open --dir headless --no-skill', skip)}
<p class="caption">headless box with no launcher anywhere on PATH: one skip line, exit 0 — the deck was created, which is the product</p>
`);

console.log(`spawned: xdg-open ${spawned}`);
console.log(`skip line: ${(skip.stdout.match(/^--open: .*$/m) || ['(missing!)'])[0]} (exit ${skip.status})`);
console.log(`deck: ${path.join(demo, 'deck.html')}`);
console.log(`transcript: ${path.join(shots, 'init-open-transcript.html')}`);
