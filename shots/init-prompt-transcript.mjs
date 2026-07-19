#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #51 — `decklight init` asks for the deck title when run
// bare in a TTY. The prompt only exists on a terminal, so the shot is the CLI
// transcript surface itself (the #38 approach): run the REAL command under a
// pty (util-linux script(1)), wait for the prompt, answer it with a title
// containing an ampersand, then render the captured transcript as a terminal
// window and screenshot it with tools/shot.mjs. A second shot opens the deck
// the run scaffolded and shows the title slide — the ampersand rendered as an
// ampersand, proof the prompt's answer is HTML-escaped where it lands.
//
//   node shots/init-prompt-transcript.mjs
//     → .shots/init-prompt.png            the prompt, asked and answered
//     → .shots/init-title-ampersand.png   the scaffolded deck's title slide

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const TITLE = 'Ship & Tell';

// --- run the real command under a pty, answer the real prompt -----------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-shot-'));
const transcript = await new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/script',
    ['-qec', `node "${CLI}" init`, '/dev/null'],
    { cwd: dir, encoding: 'utf8' });
  let out = '';
  let answered = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    // type the answer only once the prompt is on screen, like a human would
    if (!answered && /deck title \[My Deck\]: /.test(out)) {
      answered = true;
      setTimeout(() => child.stdin.write(`${TITLE}\n`), 150);
    }
  });
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`init exited ${code}\n${out}`))));
  child.on('error', reject);
});

const deck = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
if (!deck.includes('<title>Ship &amp; Tell</title>')) {
  throw new Error('scaffolded deck does not carry the escaped title');
}

// --- render the transcript as a terminal window and shoot it ------------------

const clean = transcript
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // readline cursor/erase sequences
  .replace(/\r/g, '')
  .trim();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(deck title \[My Deck\]: )(.*)$/m, '<span class="ask">$1</span><span class="answer">$2</span>')
  .replace(/^(created .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(wrote .*|created AGENTS\.md|refreshed .*|appended .*)$/gm, '<span class="ok">$1</span>');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight init — title prompt</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1060px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 17px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ask { color: #fbbf24; }
  .answer { color: #f9fafb; font-weight: 700; }
  .ok { color: #86efac; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight init — run bare in a TTY, it asks one question</span></div>
  <div class="body"><span class="prompt">~/talk $</span> decklight init
${paint(clean)}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'init-prompt-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'init-prompt.png'), '--size', '1280x800', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });

// --- and the deck it scaffolded: the ampersand survives to the title slide ----

// the starter deck inlines every shipped theme, whose webfont @imports eat
// Chrome's virtual-time budget before paint — give it a generous one
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), path.join(dir, 'deck.html'),
  '-o', path.join(root, '.shots', 'init-title-ampersand.png'), '--wait', '15000'],
  { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true, force: true });
