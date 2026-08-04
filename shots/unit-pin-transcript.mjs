#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for UNIT_PINNING (issue #224). Nothing changes in the browser —
// the whole feature is the install seam refusing what a moving ref serves —
// so the shot is the CLI transcript surface, exercised exactly as the attack
// the ticket describes: a marketplace with a PINNED transform entry
// registers; `extension check` admits the module and prints the digest the
// entry pins; `transform add` installs it against that pin. Then the
// marketplace repo "moves on" — the module file is edited after admission,
// which is what every install from HEAD would previously have swallowed —
// and the same `transform add` now refuses, naming both digests. Finally an
// entry that never carried a pin is refused before anything is fetched.
// Every command runs for real; the captured output is rendered as a terminal
// window and screenshotted with tools/shot.mjs.
//
//   node shots/unit-pin-transcript.mjs        → .shots/unit-pin.png

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixtures: a fresh config home, and a marketplace with two transforms ----

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-unit-pin-shot-'));
const home = path.join(dir, 'home');
const repo = path.join(dir, 'grammar-market');
fs.mkdirSync(path.join(repo, '.decklight'), { recursive: true });

const GRAMMAR = 'export default async function transform(html) {\n'
  + '  return html.replace(/\\bteh\\b/g, "the");\n'
  + '}\n';
const sha256 = createHash('sha256').update(GRAMMAR).digest('hex');

fs.writeFileSync(path.join(repo, 'grammar.mjs'), GRAMMAR);
fs.writeFileSync(path.join(repo, 'sneaky.mjs'),
  'export default async function transform(html) { return html; }\n');
fs.writeFileSync(path.join(repo, '.decklight', 'marketplace.json'), JSON.stringify({
  name: 'grammar-market',
  entries: [
    { name: 'grammar-check', type: 'transform', source: './grammar.mjs', apiVersion: 1, sha256 },
    { name: 'sneaky-extra', type: 'transform', source: './sneaky.mjs', apiVersion: 1 },
  ],
}, null, 2));

// --- run the real commands, keep the real output ------------------------------

const runs = [];
const run = (expect, label, ...args) => {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home },
  });
  if (r.status !== expect) {
    process.stderr.write(`expected exit ${expect} from ${args.join(' ')}, got ${r.status}:\n${r.stderr}${r.stdout}`);
    process.exit(1);
  }
  runs.push({
    label,
    out: (r.stderr + r.stdout).replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~'),
  });
};

run(0, 'decklight marketplace add ~/grammar-market', 'marketplace', 'add', repo);
run(0, 'decklight extension check grammar-market/grammar.mjs   # admission emits the pin',
  'extension', 'check', path.join(repo, 'grammar.mjs'));
run(0, 'decklight transform add grammar-check              # fetched bytes match the pin',
  'transform', 'add', 'grammar-check');

// The attack the pin exists for: the repo moves on AFTER admission, so HEAD
// now serves bytes nobody screened — the cached catalog still pins what was.
fs.writeFileSync(path.join(repo, 'grammar.mjs'),
  'export default async function transform(html) {\n'
  + '  // ...anything at all: this runs unsandboxed in the installer\'s node\n'
  + '  return html;\n'
  + '}\n');

run(1, 'decklight transform add grammar-check              # the repo changed after admission',
  'transform', 'add', 'grammar-check');
run(1, 'decklight transform add sneaky-extra               # an entry that never carried a pin',
  'transform', 'add', 'sneaky-extra');

fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(registered .*|installed .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(✔ .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^( {2}sha256: .*)$/gm, '<span class="pin">$1</span>')
  .replace(/^(decklight transform add: .*)$/gm, '<span class="err">$1</span>')
  .replace(/^( {2}(?:pinned|fetched) {1,2}sha256 .*)$/gm, '<span class="err">$1</span>')
  .replace(/^( {2}the file changed .*|.*nothing was installed.*)$/gm, '<span class="hint">$1</span>');
const block = ({ label, out }) =>
  `<div class="run"><span class="prompt">~ $</span> ${esc(label)}\n${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight transform add — pinned</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1150px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .err { color: #f87171; }
  .hint { color: #fbbf24; }
  .pin { color: #93c5fd; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">decklight transform add — code-carrying units install pinned, or not at all (SPEC UNIT_PINNING)</span></div>
  <div class="body">${runs.map(block).join('\n')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'unit-pin-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'unit-pin.png'), '--size', '1280x960', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
