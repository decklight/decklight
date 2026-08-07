#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for COMPARISON_SLIDES' split-conflict lint reaching the check the
// skill actually tells authoring agents to run (#86): `decklight pdf` names
// the slide that mixes data-layout="split" with its own column flexbox, the
// same way it names overflowing slides. The transcript is a REAL run over a
// deck carrying the ticket's exact mixed state — nothing here is mocked.
//
//   node shots/split-conflict-pdf-transcript.mjs    → .shots/split-conflict-pdf.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixture: one clean slide, then the ticket's mixed one --------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-split-shot-'));
fs.writeFileSync(path.join(dir, 'talk.html'), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}">
<link rel="stylesheet" href="${path.join(root, 'themes/aurora.css')}"></head>
<body><div class="decklight">
<section><h1>~34 tools, compared</h1></section>
<section data-layout="split">
  <h2>git</h2>
  <p>Distributed version control.</p>
  <div style="display:flex; gap:28px">
    <div><h3>Pros</h3><ul><li>fast</li><li>offline</li></ul></div>
    <div><h3>Cons</h3><ul><li>sharp edges</li><li>submodules</li></ul></div>
  </div>
  <p><strong>Alternatives:</strong> Mercurial; Jujutsu</p>
</section>
</div>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>Decklight.init();</script>
</body></html>
`);

const run = spawnSync(process.execPath, [CLI, 'pdf', 'talk.html', '-o', 'talk.pdf'],
  { cwd: dir, encoding: 'utf8' });
const transcript = (run.stderr + run.stdout).trimEnd().replaceAll(dir + path.sep, '');
fs.rmSync(dir, { recursive: true, force: true });

if (!/mixes data-layout="split"/.test(transcript)) {
  console.error('pdf did not name the mixed slide — nothing to screenshot\n' + transcript);
  process.exit(1);
}

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const painted = esc(transcript)
  .replace(/^(pdf: ⚠ slide \d+ mixes .*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(two layout systems fight.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(pdf: ⚠ slide \d+ overflows.*)$/gm, '<span class="hint">$1</span>')
  .replace(/^(.*\.pdf · .*)$/gm, '<span class="ok">$1</span>');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight pdf names the split conflict</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1150px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 16px 22px 22px; color: #cdd6e4; white-space: pre-wrap; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; font-weight: 700; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">the render check the skill prescribes now names the split trap's cause, not only its symptom</span></div>
  <div class="body"><span class="prompt">~/talk $</span> decklight pdf talk.html -o talk.pdf
${painted}</div>
</div>
</body></html>
`;

// the shot server refuses dot-directories (PRESENTING), so the page cannot be
// served out of .shots/ — it renders from a throwaway plain-named dir instead
const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-split-page-'));
const page = path.join(pageDir, 'split-conflict-pdf-transcript.html');
fs.writeFileSync(page, html);
fs.mkdirSync(path.join(root, '.shots'), { recursive: true });
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'split-conflict-pdf.png'), '--size', '1280x560', '--wait', '800'],
  { stdio: 'inherit', cwd: pageDir });
fs.rmSync(pageDir, { recursive: true, force: true });
