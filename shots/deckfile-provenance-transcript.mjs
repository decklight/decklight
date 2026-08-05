#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #236 (container provenance is outside the signature and
// the digest). Nothing changes in the browser, so the shot is the CLI
// transcript surface itself, the publish-transcript.mjs pattern: this script
// REPACKS a real deck into a .decklight whose manifest claims a trusted
// repo's name — the attack the ticket describes, which neither the signature
// nor the digest covers — then runs the real commands and screenshots their
// output. `unzip -p` shows the claim riding inside the file; `present
// --check` shows the container line no longer printing it beside the
// signature line.
//
//   node shots/deckfile-provenance-transcript.mjs   → .shots/deckfile-provenance.png

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const { OPEN, CLOSE, MANIFEST } = await import(path.join(root, 'cli/deckfile.mjs'));
const { zipSync } = await import(path.join(root, 'cli/zip.mjs'));

// --- fixture: a signed payload, repacked with someone else's provenance ------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-provenance-shot-'));
const DECK = fs.readFileSync(path.join(root, 'demo/intro.html'), 'utf8');
const SIG = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', messageSignature: { signature: 'zz' } };
// The tamperer's manifest: the payload digest is honest (it has to be — the
// reader checks it), the origin is borrowed. pack() would never write this,
// which is the point: this is the shape a repacker produces by hand.
const manifest = {
  decklight: 1,
  payload: { name: 'talk.html', bytes: Buffer.byteLength(DECK), sha256: createHash('sha256').update(DECK).digest('hex') },
  runtime: '0.3.0',
  origin: { repo: 'github.com/trusted/repo', commit: 'decafbad00c0ffee' },
  extensions: [],
  signature: 'talk.html.sig',
};
const body = Buffer.from(DECK, 'utf8');
const open = Buffer.from(OPEN, 'utf8');
const zip = zipSync([
  { name: 'talk.html.sig', data: `${JSON.stringify(SIG, null, 2)}\n` },
  { name: MANIFEST, data: `${JSON.stringify(manifest, null, 2)}\n` },
], { prefix: body.length + open.length, comment: CLOSE });
fs.writeFileSync(path.join(dir, 'talk.decklight'), Buffer.concat([body, open, zip]));

// --- run the real commands, keep the real output ------------------------------

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  return (r.stderr + r.stdout).trimEnd();
};
const claim = run('unzip', ['-p', 'talk.decklight', 'manifest.json']);
const check = run('node', [CLI, 'present', 'talk.decklight', '--check']);
fs.rmSync(dir, { recursive: true, force: true });
if (!claim.includes('trusted/repo')) throw new Error('fixture lost its point: the claim is not in the file');
if (check.includes('trusted/repo')) throw new Error('the borrowed provenance printed — the fix this shot evidences is gone');

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintClaim = (s) => esc(s)
  .replace(/^(\s*"origin".*|\s*"repo".*|\s*"commit".*)$/gm, '<span class="bad">$1</span>');
const paintCheck = (s) => esc(s)
  .replace(/^(container — says:.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(signature — .*)$/gm, '<span class="hint">$1</span>');
const block = (cmd, out) => `<div class="run"><span class="prompt">~/inbox $</span> ${esc(cmd)}\n${out}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present — provenance is a claim</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1060px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #f87171; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">a repacked .decklight claims a trusted repo — the manifest carries it, the terminal no longer prints it (#236)</span></div>
  <div class="body">${block('unzip -p talk.decklight manifest.json   # the claim rides inside the file', paintClaim(claim))}
${block('decklight present talk.decklight --check', paintCheck(check))}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'deckfile-provenance-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'deckfile-provenance.png'), '--size', '1280x860', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
