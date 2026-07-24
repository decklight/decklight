#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight report-bug` (issue #73). Nothing changes in the
// browser, so the shots are the CLI transcript surface itself: this script
// runs the REAL command (the printed environment block + issue URL), then a
// real `decklight skills claude` and the head of the installed
// decklight-report-bug SKILL.md — the consent-before-screenshot and
// approve-before-filing instructions — and renders both captures as
// terminal windows screenshotted with tools/shot.mjs.
//
//   node shots/report-bug-transcript.mjs
//     → .shots/report-bug.png  (the command's output)
//     → .shots/report-bug-skill.png  (the installed skill's gates)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-report-bug-shot-'));
const scrub = (s) => s
  .replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~/talk')
  .replace(/^decklight \d+\.\d+\.\d+\n/, ''); // the stderr banner, kept out of the paste surface

// --- run the real commands, keep the real output ------------------------------

const run = (args) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  return scrub(r.stdout);
};
const reportOut = run(['report-bug']);
const skillsOut = run(['skills', 'claude', '--dir', '.']);
const skillMd = fs.readFileSync(
  path.join(dir, '.claude', 'skills', 'decklight-report-bug', 'SKILL.md'), 'utf8',
).trimEnd();
fs.rmSync(dir, { recursive: true, force: true });

// --- render each transcript as a terminal window and shoot it -----------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(## Environment)$/gm, '<span class="head">$1</span>')
  .replace(/^(- [a-z-]+:)/gm, '<span class="key">$1</span>')
  .replace(/(https:\/\/\S+)/g, '<a class="url">$1</a>')
  .replace(/^(Nothing was collected or sent.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(installed the Decklight skills.*)$/gm, '<span class="ok">$1</span>')
  .replace(/(\*\*[^*]+\*\*)/g, '<span class="strong">$1</span>');
const block = (cmd, out) => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}\n${paint(out)}</div>`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1100px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 16px 22px 22px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .head { color: #f0abfc; font-weight: 700; }
  .key { color: #86efac; }
  .ok { color: #86efac; }
  .strong { color: #fbbf24; }
  .url { color: #93c5fd; text-decoration: underline; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">${title}</span></div>
  <div class="body">${body}</div>
</div>
</body></html>
`;

const shoot = (name, title, body, height) => {
  const html = path.join(root, '.shots', `${name}.html`);
  fs.mkdirSync(path.dirname(html), { recursive: true });
  fs.writeFileSync(html, page(title, body));
  execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), html,
    '-o', path.join(root, '.shots', `${name}.png`), '--size', `1280x${height}`, '--wait', '800'],
    { stdio: 'inherit' });
  fs.rmSync(html, { force: true });
};

shoot('report-bug',
  'decklight report-bug — the mechanical facts, gathered; nothing sent',
  block('npx decklight report-bug', reportOut), 800);
shoot('report-bug-skill',
  'decklight skills claude — the decklight-report-bug agent skill (consent + approval gates)',
  block('npx decklight skills claude', skillsOut)
  + '\n' + block('cat .claude/skills/decklight-report-bug/SKILL.md', skillMd), 1620);
