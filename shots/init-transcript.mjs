#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #50 — init's git offer, colored epilogue, and dev
// handoff. Nothing changes in the browser, so the shot is the CLI transcript
// surface itself (the #38 approach): run a REAL `decklight init` twice —
// once under a pty (via util-linux `script`), answering Y to the git
// question and Y to "start editing now?", Ctrl-C once the handed-off edit
// server is up; once piped, proving the same run is plain text — then render
// both captured transcripts as terminal windows and screenshot them with
// tools/shot.mjs.
//
//   node shots/init-transcript.mjs        → .shots/init.png

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-shot-'));
const env = { // a git identity, so the initial commit succeeds on a bare CI box
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com',
};

// --- run 1: a real pty, both questions answered Y ------------------------------

const ttyRun = await new Promise((resolve, reject) => {
  const work = path.join(dir, 'talk');
  fs.mkdirSync(work);
  const child = spawn('script',
    ['-qec', `node ${CLI} init "My Talk"`, '/dev/null'],
    { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let interrupted = false;
  const answer = (re, reply) => {
    if (!re.test(out)) return false;
    child.stdin.write(reply);
    return true;
  };
  child.stdout.on('data', (chunk) => {
    out += chunk;
    // pace the answers on the real prompts — type-ahead would be discarded
    if (!answer.git && (answer.git = answer(/create a git repository .*\[Y\/n\]/, 'y\n'))) return;
    if (!answer.edit && (answer.edit = answer(/start editing now\? \[Y\/n\]/, 'y\n'))) return;
    if (!interrupted && /decklight edit on http:\/\//.test(out)) {
      interrupted = true; // the handoff is up — that's the evidence; stop it
      setTimeout(() => child.stdin.write('\x03'), 300);
    }
  });
  child.stderr.on('data', (c) => { out += c; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('exit', () => { clearTimeout(kill); resolve(out); });
  child.on('error', reject);
});
if (!/decklight edit on http:\/\//.test(ttyRun)) {
  process.stderr.write(`pty run never reached the edit server:\n${ttyRun}`);
  process.exit(1);
}

// --- run 2: the same command piped — must be plain text ------------------------

const piped = spawnSync('node', [CLI, 'init', 'My Talk', '--dir', 'talk-piped'],
  { cwd: dir, encoding: 'utf8', env });
if (piped.status !== 0) { process.stderr.write(piped.stderr); process.exit(1); }
if (/\x1b/.test(piped.stdout)) {
  process.stderr.write('piped output contains escape codes — the gate is broken\n');
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });

// --- render both transcripts as terminal windows and shoot them ----------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// the handful of sequences init/dev actually emit: SGR colors, OSC 8 links,
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
<html lang="en"><head><meta charset="utf-8"><title>decklight init</title><style>
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
  .url { color: #93c5fd; text-decoration: underline; }
</style></head><body>
${term('decklight init — in a pty: git offered, accent epilogue, clickable file:// link, dev handoff',
    `<span class="prompt">~/talk $</span> decklight init "My Talk"\n${ansiToHtml(ttyRun)}`)}
${term('the same run piped through cat — plain text, zero escape codes',
    `<span class="prompt">~ $</span> decklight init "My Talk" --dir talk-piped | cat\n${esc(piped.stdout)}`)}
</body></html>
`;

const page = path.join(root, '.shots', 'init-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'init.png'), '--size', '1280x1200', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
