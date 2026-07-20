#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// CLI transcript evidence for #53: a repository decklight creates starts with
// the starter .gitignore, and a .gitignore the player already owns is never
// touched. Nothing about this ticket shows in a browser, so the shot IS the
// terminal: every line in the PNGs is the real output of the real commands,
// run in throwaway directories, typeset into HTML and screenshotted by the
// same headless Chrome the rest of the evidence tooling drives.
//
//   node shots/gitignore-starter-cli.mjs
//     → .shots/gitignore-starter.png            fresh dir: repo created,
//                                               .gitignore committed, artifacts
//                                               invisible to git add -A
//     → .shots/gitignore-existing-untouched.png pre-existing .gitignore stays
//                                               byte-identical

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\s+$/, '');

// start `decklight edit --git`, capture its startup lines, Ctrl-C it
async function editStartup(dir) {
  const child = spawn(process.execPath, [CLI, 'edit', 'deck.html', '--port', '0', '--git'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const scan = setInterval(() => { if (/http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearInterval(scan); resolve(); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error('edit server never came up:\n' + out)); }, 10000);
  });
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('exit', resolve));
  return out.replace(/\s+$/, '') + '\n^C';
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

// ── shot 1: a fresh directory — the created repo gets the starter file ─────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-demo-'));
  const blocks = [];
  blocks.push({ cmd: 'decklight init "Demo Deck" --no-skill', output: run(process.execPath, [CLI, 'init', 'Demo Deck', '--no-skill'], dir) });
  blocks.push({ cmd: 'decklight edit deck.html --git', output: await editStartup(dir) });
  blocks.push({ cmd: 'cat .gitignore', output: readFileSync(path.join(dir, '.gitignore'), 'utf8').replace(/\s+$/, '') });
  mkdirSync(path.join(dir, '.shots')); mkdirSync(path.join(dir, 'voiceover'));
  writeFileSync(path.join(dir, '.shots', 'evidence.png'), 'png');
  writeFileSync(path.join(dir, 'voiceover', 'slide-01.m4a'), 'audio');
  writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  blocks.push({ cmd: 'touch .shots/evidence.png voiceover/slide-01.m4a .DS_Store', output: '' });
  run('git', ['add', '-A'], dir);
  run('git', ['-c', 'user.name=player', '-c', 'user.email=player@example.com', 'commit', '-q', '-m', 'first commit'], dir);
  blocks.push({ cmd: 'git add -A && git commit -m "first commit" && git ls-files', output: run('git', ['ls-files'], dir) });
  renderShot('fresh directory — the repo decklight creates starts with the starter .gitignore, artifacts never enter history',
    blocks, '.shots/gitignore-starter.png', 1180, 560);
  rmSync(dir, { recursive: true, force: true });
}

// ── shot 2: a .gitignore the player already owns is never touched ──────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-demo-'));
  const theirs = '# mine — decklight must not touch this\nnode_modules/\n';
  writeFileSync(path.join(dir, '.gitignore'), theirs);
  writeFileSync(path.join(dir, 'deck.html'), '<!doctype html><div class="decklight"><section><h2>Demo</h2></section></div>');
  const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const before = sha(readFileSync(path.join(dir, '.gitignore')));
  const blocks = [];
  blocks.push({ cmd: 'sha256sum .gitignore   # before', output: before + '…  .gitignore' });
  blocks.push({ cmd: 'decklight edit deck.html --git', output: await editStartup(dir) });
  const after = sha(readFileSync(path.join(dir, '.gitignore')));
  blocks.push({ cmd: 'sha256sum .gitignore   # after — byte-identical', output: after + '…  .gitignore' });
  blocks.push({ cmd: 'cat .gitignore', output: readFileSync(path.join(dir, '.gitignore'), 'utf8').replace(/\s+$/, '') });
  if (before !== after) { console.error('EVIDENCE INVALID: the existing .gitignore changed'); process.exit(1); }
  renderShot('pre-existing .gitignore — repo creation leaves it byte-identical (no appending, no merging)',
    blocks, '.shots/gitignore-existing-untouched.png', 1180, 440);
  rmSync(dir, { recursive: true, force: true });
}
