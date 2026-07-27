#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #75 — `decklight init` asks where the agent skill should
// go: the project (today's install, the default) or each detected agent's
// global config home. The question only exists on a terminal, so the shot is
// the CLI transcript surface itself (the #38 approach): run the REAL command
// under a pty (util-linux script(1)) twice — once answering `g`, which
// delegates to the `decklight skills --global` machinery and writes nothing
// skill-shaped into the project; once pressing Enter, which keeps today's
// project install byte-for-byte — then render both captured transcripts as
// terminal windows and screenshot them with tools/shot.mjs.
//
// The runs see a fabricated $PATH carrying fake `claude` and `codex` binaries
// and a throwaway $HOME, so detection is deterministic and no real config
// home is touched: the prompt names ~/.claude and ~/.codex, and `g` installs
// into both.
//
//   node shots/init-skill-scope-transcript.mjs   → .shots/init-skill-scope.png

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skillscope-home-'));
// a PATH with exactly two detectable agents on it (and nothing else — node
// runs by its absolute path, script(1) finds its shell via $SHELL)
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skillscope-bin-'));
for (const agent of ['claude', 'codex']) {
  fs.writeFileSync(path.join(bin, agent), '#!/bin/sh\n', { mode: 0o755 });
}
const env = { ...process.env, HOME: home, PATH: bin, SHELL: '/bin/sh' };
delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
delete env.XDG_CONFIG_HOME; delete env.BOB_HOME;

/** Run init under a pty, answering each prompt as it appears on screen. */
function run(title, dir, skillAnswer) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/script',
      // --no-edit: this transcript is about the skill-scope question, and init
      // now hands off to the dev server unless told not to
      ['-qec', `"${process.execPath}" "${CLI}" init "${title}" --no-edit`, '/dev/null'],
      { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const done = {};
    const answer = (key, re, reply) => {
      if (done[key] || !re.test(out)) return;
      done[key] = true;
      // type the answer only once the prompt is on screen, like a human would
      setTimeout(() => child.stdin.write(reply), 150);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      answer('skill', /where should the skill go\? \[P\/g\]/, skillAnswer);
      answer('git', /create a git repository .*\[Y\/n\]/, 'n\n');
    });
    child.stderr.on('data', (c) => { out += c; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      code === 0 ? resolve(out) : reject(new Error(`init exited ${code}\n${out}`));
    });
    child.on('error', reject);
  });
}

// --- run 1: `g` — the global install, nothing skill-shaped in the project -----

const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skillscope-g-'));
const globalRun = await run('Workshop Deck', globalDir, 'g\n');
for (const [file, why] of [
  [path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md'), 'the global Claude skill'],
  [path.join(home, '.codex', 'AGENTS.md'), 'the global Codex AGENTS.md'],
]) {
  if (!fs.existsSync(file)) throw new Error(`g did not install ${why}: ${file}`);
}
for (const leak of ['.claude', 'AGENTS.md']) {
  if (fs.existsSync(path.join(globalDir, leak))) {
    throw new Error(`g leaked ${leak} into the project directory`);
  }
}

// --- run 2: Enter — today's project install, unchanged ------------------------

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skillscope-p-'));
const projectRun = await run('Workshop Deck', projectDir, '\n');
if (!fs.existsSync(path.join(projectDir, '.claude', 'skills', 'decklight', 'SKILL.md'))) {
  throw new Error('Enter did not keep the project install');
}

// --- render both transcripts as terminal windows and shoot them ---------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// the handful of sequences init actually emits: SGR colors, OSC 8 links,
// readline's cursor jockeying (dropped), \r line discipline (normalized)
function ansiToHtml(raw) {
  let s = raw.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = esc(s);
  s = s.replace(/\x1b\]8;;([^\x1b]*)\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g,
    (_, url, text) => `<a class="url" href="${url}">${text}</a>`);
  const SGR = { 1: 'b', 2: 'dim', 33: 'yellow', 35: 'magenta', 36: 'cyan', 90: 'dim' };
  let open = 0;
  s = s.replace(/\x1b\[([\d;]*)m/g, (_, codes) => {
    let html = '';
    for (const c of (codes || '0').split(';')) {
      if (c === '' || c === '0') { html += '</span>'.repeat(open); open = 0; }
      else if (SGR[c]) { html += `<span class="${SGR[c]}">`; open++; }
    }
    return html;
  });
  s += '</span>'.repeat(open);
  return s.replace(/\x1b\[[\d;]*[A-LN-Za-ln-z]/g, '').replace(/\x1b./g, '');
}

const term = (title, body) => `
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">${esc(title)}</span></div>
  <div class="body">${body}</div>
</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight init — skill scope</title><style>
  body { margin: 0; display: grid; place-content: center; gap: 26px; padding: 30px 0;
         min-height: 100vh; box-sizing: border-box;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1080px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 16px 22px 20px; color: #cdd6e4; white-space: pre-wrap; }
  .prompt { color: #86efac; font-weight: 700; }
  .dim { color: #6b7787; }
  .cyan { color: #67e8f9; }
  .magenta { color: #f0abfc; }
  .yellow { color: #fbbf24; }
  .b { font-weight: 700; }
  .url { color: #93c5fd; text-decoration: underline; }
</style></head><body>
${term('decklight init — answering g: the skill installs into ~/.claude and ~/.codex, the project stays clean',
    `<span class="prompt">~/workshop $</span> decklight init "Workshop Deck"\n${ansiToHtml(globalRun)}`)}
${term('the same question, Enter: today’s project install, unchanged',
    `<span class="prompt">~/workshop $</span> decklight init "Workshop Deck"\n${ansiToHtml(projectRun)}`)}
</body></html>
`;

const page = path.join(root, '.shots', 'init-skill-scope-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'init-skill-scope.png'), '--size', '1280x1180', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
for (const d of [home, bin, globalDir, projectDir]) fs.rmSync(d, { recursive: true, force: true });
