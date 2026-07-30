#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight present --remote` (PRESENT#REMOTE). Nothing changes
// in the browser, so the shot is the CLI surface itself: this script starts a
// REAL `decklight present deck.html --remote`, waits for it to print the LAN URL
// with the per-run token, then curls the server FROM ITS LAN ADDRESS — the deck
// itself comes back 403 while the same request over loopback lands — and renders
// the captured transcript as a terminal window for tools/shot.mjs.
//
// It used to shoot `author --remote`, which is where the remote lived until the
// clicker stopped costing an editing server on the LAN. There is no `/edit/*` to
// refuse here: the seam is that `--remote` widens the LISTENER and nothing else.
//
//   node shots/present-remote-transcript.mjs    → .shots/present-remote.png

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lanAddress } from '../cli/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const lan = lanAddress();
if (!lan) { console.error('no LAN interface — cannot demo the remote seam'); process.exit(1); }

// --- fixture: a deck in a plain directory --------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-remote-shot-'));
fs.writeFileSync(path.join(dir, 'deck.html'), `<!doctype html>
<html><body><div class="decklight"><section><h2>My Talk</h2></section></div></body></html>
`);

// --- run the real command, keep the real output --------------------------------

const dev = spawn('node', [CLI, 'present', 'deck.html', '--remote'], {
  cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
dev.stdout.on('data', (c) => { out += c; });
dev.stderr.on('data', (c) => { out += c; });

const until = async (re, ms = 10000) => {
  const t0 = Date.now();
  while (!re.test(out)) {
    if (Date.now() - t0 > ms) { dev.kill(); console.error('timed out waiting for:', re, '\n' + out); process.exit(1); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return out.match(re);
};

const [, port] = await until(/http:\/\/127\.0\.0\.1:(\d+)/);
await until(/\/remote\?t=([A-Za-z0-9_-]+)/);
await new Promise((r) => setTimeout(r, 300));

const curl = (...args) => spawnSync('curl', ['-si', '--max-time', '5', ...args], { encoding: 'utf8' }).stdout
  .split('\n').filter((l) => /^(HTTP\/|forbidden|\{)/.test(l)).join('\n').trim();

// The seam: off this machine only /remote/* answers. The deck is not /remote/*.
const lanRefused = curl(`http://${lan}:${port}/deck.html`);
const loopbackOk = curl(`http://127.0.0.1:${port}/present/ping`);

dev.kill('SIGINT');
await new Promise((r) => dev.on('exit', r));
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it -------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintDev = (s) => esc(s)
  .replace(/^(deck ⁠?\s*)/gm, '<span class="tag">deck </span>')
  .replace(/(http:\/\/[\d.]+:\d+\/remote\?t=[\w-]+)/g, '<a class="url">$1</a>')
  .replace(/^(<span class="tag">deck <\/span>\s+remote:.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(.*ONLY \/remote\/\* answers.*)$/gm, '<span class="hint">$1</span>')
  .replace(/^(<span class="tag">deck <\/span>\s+off this machine.*)$/gm, '<span class="hint">$1</span>');
const paintCurl = (s) => esc(s)
  .replace(/^(HTTP\/1\.1 403.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(HTTP\/1\.1 200.*)$/gm, '<span class="ok">$1</span>');
const block = (cmd, body) => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}\n${body}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present --remote</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1120px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .tag { color: #22d3ee; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; font-weight: 700; }
  .url { color: #93c5fd; text-decoration: underline; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight present --remote — LAN listener + per-run token; only /remote/* answers off this machine</span></div>
  <div class="body">${block('decklight present deck.html --remote', paintDev(out.trimEnd()))}
${block(`curl http://${lan}:${port}/deck.html                   # the deck itself, from the LAN`, paintCurl(lanRefused))}
${block(`curl http://127.0.0.1:${port}/present/ping             # the same server, over loopback`, paintCurl(loopbackOk))}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'present-remote-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'present-remote.png'), '--size', '1280x860', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
