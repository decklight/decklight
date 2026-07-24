#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #76 — the first-run TTS setup. Nothing changes in the
// browser (the page already names `decklight tts` when the bridge is missing),
// so the shot is the CLI transcript surface itself (the #38/#92 approach):
//
//   1. a REAL `decklight tts` under a pty (util-linux script(1)) on a staged
//      fresh machine — temp $HOME, nothing configured, the stub piper from
//      test/helpers.mjs on PATH so the test synthesis runs without the 120 MB
//      model — answering Enter to the engine question, Ctrl-C once the bridge
//      is up;
//   2. `decklight dev talk.html` in the same HOME right after: the saved
//      config starts the voice with no questions asked;
//   3. the same first-run command piped — proving non-TTY invocations keep
//      today's error, never a prompt.
//
//   node shots/tts-setup-transcript.mjs   → .shots/tts-setup.png

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakePiper } from '../test/helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- the staged fresh machine ---------------------------------------------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-tts-shot-'));
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
writeFakePiper(bin);
const models = path.join(home, '.local', 'share', 'piper');
fs.mkdirSync(models, { recursive: true });
fs.writeFileSync(path.join(models, 'en_US-ryan-high.onnx'), '');
const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
delete env.XDG_CONFIG_HOME;
delete env.GOOGLE_CLOUD_PROJECT;

const pty = (cmd, cwd, drive) => new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/script', ['-qec', cmd, '/dev/null'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const done = {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    for (const [key, re, reply] of drive) {
      if (done[key] || !re.test(out)) continue;
      done[key] = true;
      setTimeout(() => child.stdin.write(reply), 150);
    }
  });
  child.stderr.on('data', (c) => { out += c; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 40_000);
  child.on('close', () => { clearTimeout(kill); resolve(out); });
  child.on('error', reject);
});

// --- run 3 FIRST (nothing configured yet): piped keeps today's error --------

const piped = spawnSync('node', [CLI, 'tts'], { cwd: home, encoding: 'utf8', env });
if (piped.status !== 1 || !/needs a GCP project/.test(piped.stderr)) {
  throw new Error(`piped run should keep today's error:\n${piped.stdout}${piped.stderr}`);
}

// --- run 1: first run on a TTY — the guided setup -----------------------------

const firstRun = await pty(`node "${CLI}" tts`, home, [
  ['engine', /engine \[1\]/, '\n'],                       // Enter takes the piper default
  ['int', /decklight tts bridge on http/, '\x03'],
]);
if (!/decklight tts bridge on http/.test(firstRun)) {
  throw new Error(`first run never reached the bridge:\n${firstRun}`);
}

// --- run 2: dev right after — voice up, no questions ---------------------------

fs.writeFileSync(path.join(home, 'talk.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head><body>
<div class="decklight"><section><h2>My Talk</h2></section></div>
<script src="decklight/dist/decklight.js"></script><script>Decklight.init({})</script>
</body></html>
`);
spawnSync('git', ['init', '-q'], { cwd: home, env }); // no git question — the voice is the point
const devRun = await pty(`node "${CLI}" dev talk.html`, home, [
  ['int', /decklight tts bridge on http/, '\x03'],
]);
if (/set up live narration now\?/.test(devRun)) {
  throw new Error(`dev asked again despite the saved config:\n${devRun}`);
}
fs.rmSync(home, { recursive: true, force: true });

// --- render the transcripts as terminal windows and shoot them -----------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// the handful of sequences tts/dev actually emit: SGR colors, readline's
// cursor jockeying (dropped), \r line discipline (normalized)
function ansiToHtml(raw) {
  let s = raw.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = esc(s);
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
<html lang="en"><head><meta charset="utf-8"><title>decklight tts — first-run setup</title><style>
  body { margin: 0; display: grid; place-items: center; gap: 26px; padding: 30px 0;
         min-height: 100vh; box-sizing: border-box;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1080px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
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
</style></head><body>
${term('decklight tts — first run on a fresh machine: guided setup, one audible test synthesis, bridge up',
    `<span class="prompt">~ $</span> decklight tts\n${ansiToHtml(firstRun)}`)}
${term('decklight dev right after — the saved config starts the voice with no questions asked',
    `<span class="prompt">~ $</span> decklight dev talk.html\n${ansiToHtml(devRun)}`)}
${term('the same first-run command piped — non-TTY never prompts, today’s error verbatim',
    `<span class="prompt">~ $</span> decklight tts | cat\n${esc(piped.stderr)}`)}
</body></html>
`;

const page = path.join(root, '.shots', 'tts-setup-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'tts-setup.png'), '--size', '1280x1400', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
