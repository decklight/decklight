#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for `decklight marketplace` (issue #181). Nothing changes in the
// browser — the whole feature is CLI + files under ~/.decklight/ — so the
// shot is the CLI transcript surface, exercised exactly as the ticket's demo
// script says: a FRESH config home (DECKLIGHT_HOME → a temp dir), `list`
// showing the first-party marketplace registered-not-fetched, an `add` of a
// local repo with a deliberate manifest typo (refused naming line and
// field), the fixed `add`, and a final `list` with both catalogs and
// qualified entry@marketplace names. Every command runs for real; the
// captured output is rendered as a terminal window and screenshotted with
// tools/shot.mjs.
//
//   node shots/marketplace-transcript.mjs        → .shots/marketplace.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixtures: a fresh config home, and a local marketplace repo --------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-marketplace-shot-'));
const home = path.join(dir, 'home');
const repo = path.join(dir, 'nord-market');
fs.mkdirSync(path.join(repo, '.decklight'), { recursive: true });

const broken = `{
  "name": "nord-market",
  "entries": [
    { "name": "nord-deep", "type": "theme", "source": "./themes/nord-deep.css", "description": "deep blues" },
    { "name": "frost", "source": "./themes/frost.css" }
  ]
}
`;
fs.writeFileSync(path.join(repo, '.decklight', 'marketplace.json'), broken);

// --- run the real commands, keep the real output ------------------------------

const runs = [];
const run = (label, ...args) => {
  const r = spawnSync('node', [CLI, 'marketplace', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home },
  });
  runs.push({
    label,
    out: (r.stderr + r.stdout).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~'),
  });
  return r.status;
};

run('decklight marketplace list                       # fresh machine, offline', 'list');
if (run('decklight marketplace add ./nord-market           # a deliberate typo: frost has no type', 'add', './nord-market') !== 1) {
  process.stderr.write('expected the broken manifest to be refused\n'); process.exit(1);
}
fs.writeFileSync(path.join(repo, '.decklight', 'marketplace.json'),
  broken.replace('"name": "frost", ', '"name": "frost", "type": "theme", '));
if (run('decklight marketplace add ./nord-market           # fixed', 'add', './nord-market') !== 0) {
  process.stderr.write('expected the fixed manifest to register\n'); process.exit(1);
}
run('decklight marketplace list', 'list');
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(registered .*|refreshed .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(decklight marketplace add: .*)$/gm, '<span class="err">$1</span>')
  .replace(/^(  line \d+: .*)$/gm, '<span class="err">$1</span>')
  .replace(/(— registered, not fetched .*)$/gm, '<span class="hint">$1</span>')
  .replace(/^(  \S+@\S+ .*)$/gm, '<span class="entry">$1</span>');
const block = ({ label, out }) =>
  `<div class="run"><span class="prompt">~ $</span> ${esc(label)}\n${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight marketplace</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1120px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .err { color: #f87171; }
  .hint { color: #fbbf24; }
  .entry { color: #93c5fd; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight marketplace — registered, not fetched (fresh DECKLIGHT_HOME, no network touched)</span></div>
  <div class="body">${runs.map(block).join('\n')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'marketplace-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'marketplace.png'), '--size', '1280x900', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
