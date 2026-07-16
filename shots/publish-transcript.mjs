#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight publish` (issue #38). Nothing changes in the
// browser, so the shot is the CLI transcript surface itself: this script
// runs a REAL publish (twice) against a local `git init --bare` origin —
// the remote URL is set to GitHub and rerouted to the bare repo with
// url.<dir>.insteadOf, so the derived Pages URL prints while the push
// stays on disk — then renders the captured output as a terminal window
// and screenshots it with tools/shot.mjs.
//
//   node shots/publish-transcript.mjs        → .shots/publish.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixture: a deck in a repo whose origin "is" GitHub -----------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-publish-shot-'));
const bare = path.join(dir, 'origin.git');
execFileSync('git', ['init', '--quiet', '--bare', bare]);
const work = path.join(dir, 'work');
fs.mkdirSync(path.join(work, 'dist'), { recursive: true });
fs.mkdirSync(path.join(work, 'themes'));
for (const f of ['dist/decklight.css', 'dist/decklight.js', 'themes/aurora.css']) {
  fs.copyFileSync(path.join(root, f), path.join(work, f));
}
fs.writeFileSync(path.join(work, 'deck.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My Talk</title>
  <link rel="stylesheet" href="dist/decklight.css">
  <link rel="stylesheet" href="themes/aurora.css">
</head>
<body>
  <div class="decklight">
    <section><h2>My Talk</h2><p>now a URL</p></section>
  </div>
  <script src="dist/decklight.js"></script>
  <script>Decklight.init({});</script>
</body>
</html>
`);
const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' });
git('init', '--quiet');
git('config', 'user.name', 'Ada Lovelace');
git('config', 'user.email', 'ada@example.com');
git('remote', 'add', 'origin', 'git@github.com:ada/decklight-demo.git');
git('config', `url.${bare}.insteadOf`, 'git@github.com:ada/decklight-demo.git');
git('add', 'deck.html');
git('commit', '--quiet', '-m', 'deck');

// --- run the real command, keep the real output -------------------------------

const runs = [];
for (let n = 0; n < 2; n++) {
  const r = spawnSync('node', [CLI, 'publish', 'deck.html'], { cwd: work, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  runs.push((r.stderr + r.stdout).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~'));
}
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(bundled .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(pushed .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(https:\/\/\S+)$/gm, '<a class="url">$1</a>')
  .replace(/^(first publish: .*)$/gm, '<span class="hint">$1</span>');
const block = (cmd, out) => `<div class="run"><span class="prompt">~/talk $</span> ${esc(cmd)}\n${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight publish</title><style>
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
  .url { color: #93c5fd; text-decoration: underline; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight publish — deck to shareable URL (origin: a local git init --bare fixture)</span></div>
  <div class="body">${block('decklight publish deck.html', runs[0])}
${block('decklight publish deck.html   # again — appends, never force-pushes', runs[1])}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'publish-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'publish.png'), '--size', '1280x800', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
