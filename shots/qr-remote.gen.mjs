#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Demo evidence for cli/qr.mjs (#114) — a CLI building block with no deck
// surface, so the screenshot surface is the artifact itself: the self-contained
// SVG that qrSvg() returns for the phone-remote URL (#39), embedded verbatim
// in a page beside the string it encodes. Scan the shot with a phone to verify
// it end-to-end.
//
//   node shots/qr-remote.gen.mjs
//   node tools/shot.mjs .shots/qr-remote.html -o .shots/qr-remote.png --wait 800

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQR, qrSvg } from '../cli/qr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, '.shots');
fs.mkdirSync(shots, { recursive: true });

const url = 'http://192.168.1.23:8123/remote?t=k3XR9v';
const svg = qrSvg(url);
const version = (encodeQR(url).length - 17) / 4;

fs.writeFileSync(path.join(shots, 'qr-remote.html'), `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin:0; height:100vh; display:grid; place-items:center; background:#101418;
         color:#d8dee6; font:17px/1.65 ui-monospace,'SF Mono',Menlo,monospace; }
  .card { text-align:center; }
  .qr { width:360px; height:360px; margin:0 auto; }
  h1 { font-size:20px; color:#8fd0ff; margin:0 0 20px; font-weight:600; }
  .url { color:#7ee08a; margin:18px 0 4px; }
  .caption { color:#8b98a5; font-size:14px; }
</style>
<div class="card">
  <h1>qrSvg() — the phone-remote pairing code (#114)</h1>
  <div class="qr">${svg}</div>
  <p class="url">${url}</p>
  <p class="caption">byte mode · EC level L · version ${version} · one self-contained SVG string, zero dependencies</p>
</div>
`);

console.log(`encoded: ${url} → v${version}, ${svg.length} chars of SVG`);
console.log(`page: ${path.join(shots, 'qr-remote.html')}`);
