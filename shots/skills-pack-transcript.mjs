#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight skills claude --pack` (issue #80). The feature's
// whole surface is the terminal, so the shot is the CLI transcript itself
// (the #38 approach): run a REAL pack in a tmp dir, list the archive with a
// real `unzip -l`, then render both captured outputs as a terminal window
// and screenshot it with tools/shot.mjs.
//
//   node shots/skills-pack-transcript.mjs   → .shots/skills-pack.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- run the real command, keep the real output -------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-pack-shot-'));
const pack = spawnSync('node', [CLI, 'skills', 'claude', '--pack'], { cwd: dir, encoding: 'utf8' });
if (pack.status !== 0) { process.stderr.write(pack.stderr); process.exit(1); }
const list = spawnSync('unzip', ['-l', 'decklight-skill.zip'], { cwd: dir, encoding: 'utf8' });
if (list.status !== 0) { process.stderr.write(list.stderr); process.exit(1); }
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(packed .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(two routes .*)$/gm, '<span class="hint">$1</span>')
  .replace(/(decklight\/(?:SKILL|reference)\.md)/g, '<span class="cyan">$1</span>');
const block = (cmd, out) => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}\n${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight skills --pack</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1060px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 17px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .cyan { color: #67e8f9; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight skills claude --pack — the account-level skill artifact for Claude Code on the web</span></div>
  <div class="body">${block('npx decklight skills claude --pack', pack.stderr + pack.stdout)}
${block('unzip -l decklight-skill.zip', list.stdout)}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'skills-pack-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'skills-pack.png'), '--size', '1280x900', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
