#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #234: a crafted .decklight that inflates to gigabytes no
// longer OOMs `present` on double-click — it is refused by name, before any
// trust decision. Nothing changes in the browser, so the shot is the CLI
// transcript surface: two hostile containers are built for real (a lying
// entry that inflates past its declaration, and a directory that honestly
// declares more than the archive cap), `decklight present` runs against each,
// and the refusals are rendered as a terminal window and screenshotted.
//
//   node shots/zip-bomb-refused.mjs        → .shots/zip-bomb-refused.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const { zipSync } = await import(path.join(root, 'cli', 'zip.mjs'));
const { MANIFEST, OPEN, CLOSE } = await import(path.join(root, 'cli', 'deckfile.mjs'));

// --- craft the hostile containers, exactly as an attacker would ---------------

/** Rewrite what the central directory declares an entry inflates to. */
function declareSize(container, name, size) {
  const buf = Buffer.from(container);
  let e = buf.length - 22;
  while (buf.readUInt32LE(e) !== 0x06054b50) e -= 1;
  let p = buf.readUInt32LE(e + 16);
  while (p < e) {
    const nameLen = buf.readUInt16LE(p + 28);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      buf.writeUInt32LE(size, p + 24);
      return buf;
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`no ${name} in the central directory`);
}

function container(entries) {
  const body = Buffer.from('<!doctype html><html><body>a deck someone sent you</body></html>', 'utf8');
  const zip = zipSync([{ name: MANIFEST, data: JSON.stringify({ decklight: 1, signature: 'talk.html.sig' }) },
    ...entries], { prefix: body.length + OPEN.length, comment: CLOSE });
  return Buffer.concat([body, Buffer.from(OPEN, 'utf8'), zip]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-zip-bomb-shot-'));

// 64 MiB of one byte deflates to ~64 KiB; the directory then claims 64 bytes.
// Before the cap, present inflated the lot — and a deeper stream OOMs it.
const bomb = path.join(dir, 'bomb.decklight');
fs.writeFileSync(bomb, declareSize(container([{ name: 'boom.bin', data: 'A'.repeat(64 * 1024 * 1024) }]), 'boom.bin', 64));

// The honest-about-it variant: tiny entries whose directory declares 3 GiB
// EACH — refused from the directory sums, before a single byte inflates.
const declared = path.join(dir, 'declared.decklight');
let d = container([{ name: 'big1.bin', data: 'A'.repeat(64) }, { name: 'big2.bin', data: 'B'.repeat(64) }]);
for (const n of ['big1.bin', 'big2.bin']) d = declareSize(d, n, 3 * 1024 * 1024 * 1024);
fs.writeFileSync(declared, d);

// --- run present against them, keep the real output ---------------------------

const kb = (f) => {
  const n = fs.statSync(f).size;
  return n < 1024 ? `${n} bytes` : `${Math.round(n / 1024)} KiB`;
};
const runs = [];
const run = (label, file) => {
  const r = spawnSync('node', [CLI, 'present', file], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 1) { process.stderr.write(`expected present to refuse ${file}\n`); process.exit(1); }
  runs.push({ label, out: (r.stderr + r.stdout).replaceAll(dir, '~') });
};

run(`decklight present bomb.decklight          # ${kb(bomb)} on disk — an entry lies, and inflates without limit`, bomb);
run(`decklight present declared.decklight      # ${kb(declared)} on disk — the directory declares 6 GiB outright`, declared);
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(.*(?:inflates past|declares \d+ bytes inflated).*)$/gm, '<span class="err">$1</span>');
const block = ({ label, out }) =>
  `<div class="run"><span class="prompt">~ $</span> ${esc(label)}\n${paint(out)}<span class="hint">exit status 1 — refused before any signature check, nothing inflated, nothing rendered</span></div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>zip bomb refused</title><style>
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
  .err { color: #f87171; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">issue #234 — a crafted .decklight that inflates to gigabytes is refused, not presented</span></div>
  <div class="body">${runs.map(block).join('\n')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'zip-bomb-refused.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'zip-bomb-refused.png'), '--size', '1280x760', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
