#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for the present served-root scoping (PRESENT_SERVER, #226). Nothing
// changes on a slide, so the shot is the CLI surface itself: this script lays
// out a directory the way the attack found it — a deck in an inbox with `.env`
// and `id_rsa` beside it, and a served-by-the-old-code secret in the cwd above —
// starts a REAL `decklight present inbox/deck.html` from that cwd, then curls
// what a hostile deck's own script would fetch. The deck lands; the dotfile and
// the key are refused; the file in the cwd is not in the served tree at all,
// because the root travelled with the deck instead of the shell.
//
//   node shots/present-scope-transcript.mjs    → .shots/present-scope.png

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixture: the directory the ticket's attack assumed ------------------------

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-scope-shot-'));
fs.writeFileSync(path.join(cwd, 'passwords.png'), 'a secret the OLD code served');
const inbox = path.join(cwd, 'inbox');
fs.mkdirSync(inbox);
fs.writeFileSync(path.join(inbox, 'deck.html'), `<!doctype html>
<html><body><div class="decklight"><section><h2>A deck someone sent me</h2></section></div></body></html>
`);
fs.writeFileSync(path.join(inbox, '.env'), 'AWS_SECRET_ACCESS_KEY=hunter2\n');
fs.writeFileSync(path.join(inbox, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');

// --- run the real command, keep the real output --------------------------------

const dev = spawn('node', [CLI, 'present', 'inbox/deck.html'], {
  cwd, stdio: ['ignore', 'pipe', 'pipe'],
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
await new Promise((r) => setTimeout(r, 300));

const sh = (cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' }).stdout.trimEnd();
const curl = (p) => spawnSync('curl', ['-si', '--max-time', '5', `http://127.0.0.1:${port}${p}`], { encoding: 'utf8' })
  .stdout.split('\n').filter((l) => /^(HTTP\/|forbidden|not found|AWS_|-----)/.test(l)).join('\n').trim();

const listing = sh('ls', ['-A', '.', 'inbox']);
const deckOk = curl('/deck.html');
const envRefused = curl('/.env');
const keyRefused = curl('/id_rsa');
const cwdUnreachable = curl('/passwords.png');

dev.kill('SIGINT');
await new Promise((r) => dev.on('exit', r));
fs.rmSync(cwd, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it -------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintDev = (s) => esc(s)
  .replace(/^(deck ⁠?\s*)/gm, '<span class="tag">deck </span>')
  .replace(/^(.*serving .*deck's own directory.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(.*dotfiles and non-deck file types refused.*)$/gm, '<span class="ok">$1</span>');
const paintCurl = (s) => esc(s)
  .replace(/^(HTTP\/1\.1 (?:403|404).*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(HTTP\/1\.1 200.*)$/gm, '<span class="ok">$1</span>');
const block = (cmd, body) => `<div class="run"><span class="prompt">~/work $</span> ${esc(cmd)}\n${body}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present — the served root is the deck's, not the cwd</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1120px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .tag { color: #22d3ee; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; font-weight: 700; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight present — the served root is the deck's own directory; dotfiles and non-deck types refused (#226)</span></div>
  <div class="body">${block('ls -A . inbox', esc(listing))}
${block('decklight present inbox/deck.html', paintDev(out.trimEnd()))}
${block('curl http://127.0.0.1:PORT/deck.html         # the deck itself'.replace('PORT', port), paintCurl(deckOk))}
${block('curl http://127.0.0.1:PORT/.env              # the ticket’s exfiltration read'.replace('PORT', port), paintCurl(envRefused))}
${block('curl http://127.0.0.1:PORT/id_rsa            # not a type a deck can use'.replace('PORT', port), paintCurl(keyRefused))}
${block('curl http://127.0.0.1:PORT/passwords.png     # in the cwd — no longer in the served tree at all'.replace('PORT', port), paintCurl(cwdUnreachable))}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'present-scope-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'present-scope.png'), '--size', '1280x900', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
