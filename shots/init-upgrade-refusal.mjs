#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #54 (init suggests upgrade, not --force, on a decklight
// deck). Nothing changes in the browser, so the shot is the CLI transcript
// surface itself: this script runs REAL `decklight init` commands in a temp
// dir — scaffold, re-run into the collision (the upgrade suggestion with both
// versions), then the same collision against a NON-decklight deck.html (the
// unchanged plain --force message) — and renders the captured output as a
// terminal window screenshotted with tools/shot.mjs.
//
//   node shots/init-upgrade-refusal.mjs        → .shots/init-upgrade-refusal.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const run = (cwd, args) => {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return { out: r.stderr + r.stdout, status: r.status };
};

// --- scenario 1: scaffold, then collide with the deck init just wrote --------

const talk = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-shot-'));
const scaffold = run(talk, ['init', 'My Talk', '--no-skill']);
if (scaffold.status !== 0) { process.stderr.write(scaffold.out); process.exit(1); }
const collide = run(talk, ['init', 'My Talk', '--no-skill']);
if (collide.status !== 1) { process.stderr.write('expected the refusal to exit 1\n'); process.exit(1); }

// --- scenario 2: the same collision against a deck.html that is NOT a deck ---

const page = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-shot-'));
fs.writeFileSync(path.join(page, 'deck.html'), '<!doctype html><html><body><h1>Not a deck</h1></body></html>\n');
const plain = run(page, ['init', '--no-skill']);
if (plain.status !== 1) { process.stderr.write('expected the refusal to exit 1\n'); process.exit(1); }

fs.rmSync(talk, { recursive: true, force: true });
fs.rmSync(page, { recursive: true, force: true });

// --- render the transcripts as a terminal window and shoot it ----------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(created .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(  run `decklight upgrade .*)$/gm, '<span class="lead">$1</span>')
  .replace(/(deck has runtime [\d.]+, installed is [\d.]+)/g, '<span class="ver">$1</span>')
  .replace(/^(decklight init: .*)$/gm, '<span class="err">$1</span>');
const block = (cwd, cmd, out) => `<div class="run"><span class="prompt">${esc(cwd)} $</span> ${esc(cmd)}\n${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight init collisions</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1100px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .err { color: #fda4af; }
  .lead { color: #86efac; font-weight: 700; }
  .ver { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight init — a collision with a decklight deck suggests upgrade; anything else keeps --force</span></div>
  <div class="body">${block('~/talk', 'decklight init "My Talk" --no-skill', scaffold.out)}
${block('~/talk', 'decklight init "My Talk" --no-skill   # deck.html IS a decklight deck', collide.out)}
${block('~/page', 'decklight init --no-skill             # deck.html is NOT a decklight deck', plain.out)}</div>
</div>
</body></html>
`;

const pageFile = path.join(root, '.shots', 'init-upgrade-refusal.html');
fs.mkdirSync(path.dirname(pageFile), { recursive: true });
fs.writeFileSync(pageFile, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), pageFile,
  '-o', path.join(root, '.shots', 'init-upgrade-refusal.png'), '--size', '1280x800', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(pageFile, { force: true });
