#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for #239: every response `decklight present` writes carries the
// Content-Security-Policy header — the error pages and control channels
// included, not only the deck — and `POST /remote/pos` answers the deck alone.
// Nothing changes in the browser, so the shot is the CLI surface itself: this
// script starts a REAL `decklight present deck.html --remote`, curls a 404 and
// the control-channel ping over loopback to show the header riding on both,
// then posts a fabricated position FROM THE LAN ADDRESS with the per-run token
// in hand — refused — and the same post over loopback, which is the deck's own
// path and still lands. The captured transcript renders as a terminal window
// for tools/shot.mjs.
//
//   node shots/present-csp-transcript.mjs    → .shots/present-csp.png

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
if (!lan) { console.error('no LAN interface — cannot demo the pos seam'); process.exit(1); }

// --- fixture: a deck in a plain directory --------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-csp-shot-'));
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
const [, token] = await until(/\/remote\?t=([A-Za-z0-9_-]+)/);
await new Promise((r) => setTimeout(r, 300));

const curl = (...args) => spawnSync('curl', ['-si', '--max-time', '5', ...args], { encoding: 'utf8' }).stdout
  .split('\n').filter((l) => /^(HTTP\/|content-security-policy|forbidden|not found|\{)/i.test(l)).join('\n').trim();

// The header seam: the 404 page and the control-channel JSON carry the policy.
const notFound = curl(`http://127.0.0.1:${port}/missing.html`);
const ping = curl(`http://127.0.0.1:${port}/present/ping`);
// The pos seam: token or no token, position reports are the deck's to make.
const forged = curl('-X', 'POST', '-d', '{"i":99,"n":99}', `http://${lan}:${port}/remote/pos?t=${token}`);
const real = curl('-X', 'POST', '-d', '{"i":2,"n":9}', `http://127.0.0.1:${port}/remote/pos`);

dev.kill('SIGINT');
await new Promise((r) => dev.on('exit', r));
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it -------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintCurl = (s) => esc(s)
  .replace(/^(HTTP\/1\.1 403.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(HTTP\/1\.1 [24]0\d.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(content-security-policy:)(.*)$/gm, '<span class="hint">$1</span><span class="csp">$2</span>');
const block = (cmd, body) => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}\n${body}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present — CSP on every response</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1120px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; word-break: break-all; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; font-weight: 700; }
  .hint { color: #fbbf24; }
  .csp { color: #93c5fd; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight present — the CSP rides on EVERY response, and /remote/pos answers the deck alone (#239)</span></div>
  <div class="body">${block('curl -si http://127.0.0.1:' + port + '/missing.html               # a 404 error page', paintCurl(notFound))}
${block('curl -si http://127.0.0.1:' + port + '/present/ping              # the control channel', paintCurl(ping))}
${block(`curl -si -X POST -d '{"i":99,"n":99}' http://${lan}:${port}/remote/pos?t=…   # fabricated, from the LAN, token in hand`, paintCurl(forged))}
${block(`curl -si -X POST -d '{"i":2,"n":9}' http://127.0.0.1:${port}/remote/pos      # the deck's own report, over loopback`, paintCurl(real))}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'present-csp-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'present-csp.png'), '--size', '1280x900', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
