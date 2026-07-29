#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// CLI transcript evidence for #175: `decklight author` runs the whole
// authoring loop, `decklight dev` still runs it as a permanent hidden alias
// (same output, no deprecation nag), `decklight edit` refuses out loud
// naming the replacement, and GET /edit/ping answers exactly as before.
// Every line is the real output of the real commands, run in a throwaway
// directory, typeset into HTML and screenshotted by headless Chrome — the
// gitignore-starter-cli.mjs approach, because nothing here shows in a browser.
//
//   node shots/author-rename-cli.mjs   → .shots/author-rename.png

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

// start the loop via `cmd` (author, or its alias dev), capture the startup
// lines, optionally hit /edit/ping while it is up, then Ctrl-C it
async function loopStartup(dir, cmd, { ping = false } = {}) {
  const child = spawn(process.execPath,
    [CLI, cmd, 'deck.html', '--port', '0', '--no-git', '--no-tts', '--no-lipsync'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const scan = setInterval(() => { if (/decklight author on http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearInterval(scan); resolve(); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error(`the loop never came up via ${cmd}:\n` + out)); }, 10000);
  });
  let pingBlock = null;
  if (ping) {
    const [, port] = out.match(/decklight author on http:\/\/127\.0\.0\.1:(\d+)/);
    const body = await (await fetch(`http://127.0.0.1:${port}/edit/ping`)).text();
    pingBlock = { cmd: `curl -s localhost:${port}/edit/ping`, output: body.trim() };
  }
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('exit', resolve));
  return { startup: out.replace(/\s+$/, '') + '\n^C', pingBlock };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderShot(title, blocks, out, width, height) {
  const body = blocks.map(({ cmd, output }) =>
    `<div class="b"><div class="c"><span class="p">$</span> ${esc(cmd)}</div>`
    + (output ? `<pre>${esc(output)}</pre>` : '') + '</div>').join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0d1117; font: 15px/1.45 ui-monospace, "SF Mono", Menlo, monospace; color: #c9d1d9; }
    .win { padding: 18px 22px; }
    .t { color: #8b949e; margin-bottom: 12px; } .t::before { content: "● ● ●  "; color: #30363d; letter-spacing: 2px; }
    .b { margin-bottom: 10px; } .c { color: #e6edf3; font-weight: 600; } .p { color: #3fb950; }
    pre { margin: 2px 0 0 0; color: #9ea7b3; white-space: pre-wrap; }
  </style><div class="win"><div class="t">${esc(title)}</div>${body}</div>`;
  const tmp = path.join(tmpdir(), `decklight-transcript-${process.pid}.html`);
  writeFileSync(tmp, html);
  try {
    execFileSync(chromeBin('transcript-shot'), chromeArgs(
      '--hide-scrollbars', `--window-size=${width},${height}`,
      `--screenshot=${path.resolve(out)}`, `file://${tmp}`,
    ), { stdio: ['ignore', 'ignore', 'ignore'] });
  } finally { rmSync(tmp, { force: true }); }
  console.log(out);
}

mkdirSync(path.resolve(here, '../.shots'), { recursive: true });

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-author-shot-'));
writeFileSync(path.join(dir, 'deck.html'),
  '<!doctype html><html><body><div class="decklight"><section><h2>My Talk</h2></section></div></body></html>\n');

const blocks = [];

// 1 — the renamed command runs the whole loop, and /edit/ping is unchanged
const author = await loopStartup(dir, 'author', { ping: true });
blocks.push({ cmd: 'decklight author deck.html --no-git --no-tts --no-lipsync', output: author.startup });
blocks.push(author.pingBlock);

// 2 — the hidden alias: same loop, no deprecation nag
const alias = await loopStartup(dir, 'dev');
if (/deprecat/i.test(alias.startup)) { console.error('EVIDENCE INVALID: the alias nags'); process.exit(1); }
blocks.push({ cmd: 'decklight dev deck.html --no-git --no-tts --no-lipsync   # hidden alias, works forever', output: alias.startup });

// 3 — `edit` refuses out loud, naming the replacement, exit 1
const edit = spawnSync(process.execPath, [CLI, 'edit', 'deck.html'], { cwd: dir, encoding: 'utf8' });
if (edit.status !== 1 || !/decklight author/.test(edit.stderr)) {
  console.error('EVIDENCE INVALID: edit did not refuse out loud'); process.exit(1);
}
blocks.push({ cmd: 'decklight edit deck.html; echo "exit $?"', output: (edit.stderr + edit.stdout).replace(/\s+$/, '') + `\nexit ${edit.status}` });

renderShot('decklight author — the rename: author runs the loop, dev stays as a hidden alias, edit refuses out loud, /edit/ping is untouched',
  blocks, '.shots/author-rename.png', 1240, 720);
rmSync(dir, { recursive: true, force: true });
