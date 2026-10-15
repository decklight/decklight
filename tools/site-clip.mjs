// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The narration clip on decklight.io: one showcase slide, narrated by the
// site's own voice track with captions on, its builds stepping with the voice.
// It is a RECORDING of the live deck, not a `decklight video` render: a render
// is one still per build step, so the strokes drawing in and the caption bar
// following the voice would never be in it.
//
//   node tools/site-voices.mjs pull       the voice track → site/voices/ (once)
//   node tools/site-clip.mjs              re-record site/img/narration.{webm,mp4,jpg}
//
// It bundles the showcase the way the site deploy does, with the voice track's
// per-beat clips switched on (segments), serves it on 127.0.0.1, plays the
// slide in Chrome (Playwright) and keeps the stretch from the first build to
// the last one plus a short hold, muted, as VP9 WebM, an H.264 MP4 for older
// Safari, and a poster frame. Re-run it when the slide or its notes change.
// Needs Playwright, Chrome and ffmpeg; never runs in CI.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const SLIDE = Number(opt('--slide', 7));
const OUT = path.resolve(ROOT, opt('--out', 'site/img/narration'));
const HOLD_MS = Number(opt('--hold', 2500));
const LIMIT_MS = 90_000;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/voices.json'), 'utf8'));
const voices = path.join(ROOT, cfg.dir);
if (!fs.existsSync(path.join(voices, path.basename(cfg.voices[0].dir), 'manifest.json'))) {
  console.error(`no voice track in ${cfg.dir}/ — run: node tools/site-voices.mjs pull`);
  process.exit(1);
}

// ── the showcase, bundled with its voice, as the deploy does ─────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-site-clip-'));
const site = path.join(work, 'site');
fs.mkdirSync(site);
fs.cpSync(voices, path.join(site, 'voices'), { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, 'cli/decklight.mjs'), 'bundle', path.join(ROOT, cfg.deck),
  '--themes', 'all', '-o', path.join(site, 'showcase.html')], { stdio: 'ignore' });
{
  // segments: the per-beat clips drive the builds, one beat per [click]
  const files = cfg.voices.map((v) => `{ label: ${JSON.stringify(v.label)}, dir: ${JSON.stringify(v.dir)}, segments: true }`).join(', ');
  const p = path.join(site, 'showcase.html');
  const html = fs.readFileSync(p, 'utf8');
  const out = html.replace('Decklight.init({', `Decklight.init({\n    narration: { files: [${files}] },`);
  if (out === html) throw new Error('init config anchor not found in the bundled showcase');
  fs.writeFileSync(p, out);
}

const TYPES = { '.html': 'text/html', '.m4a': 'audio/mp4', '.json': 'application/json', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(site, rel);
  if (!file.startsWith(site) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── play the slide and record it ─────────────────────────────────────────────
const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const videoDir = path.join(work, 'video');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
const recordingFrom = Date.now();
const page = await ctx.newPage();
// ?embedded hides the controls and saves nothing; &captions shows the caption bar
await page.goto(`${base}/showcase.html?embedded&captions&voiceover#/${SLIDE}/0`, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  // the engine dispatches on the deck's root, and the event does not bubble
  window.__steps = [];
  document.querySelector('.decklight').addEventListener('decklight:build',
    (e) => window.__steps.push({ at: Date.now(), index: e.detail.index, total: e.detail.total }));
});
await page.waitForTimeout(500);
await page.keyboard.press('Shift'); // the gesture ?voiceover waits for, without moving the deck
const deadline = Date.now() + LIMIT_MS;
let steps = [];
while (Date.now() < deadline) {
  steps = await page.evaluate(() => window.__steps);
  if (steps.length && steps.at(-1).index >= steps.at(-1).total) break;
  await page.waitForTimeout(250);
}
if (!steps.length) throw new Error(`slide ${SLIDE} never stepped: is the voice track playing?`);
await page.waitForTimeout(HOLD_MS);
const video = await page.video().path();
await ctx.close();
await browser.close();
server.close();

// ── cut from just before the first build to the hold after the last ──────────
const from = Math.max(0, (steps[0].at - recordingFrom) / 1000 - 0.8);
const to = (steps.at(-1).at - recordingFrom + HOLD_MS) / 1000;
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const cut = ['-ss', from.toFixed(2), '-to', to.toFixed(2), '-i', video, '-vf', 'scale=960:-2', '-an'];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
ff(...cut, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', `${OUT}.webm`);
ff(...cut, '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${OUT}.mp4`);
ff('-sseof', '-0.3', '-i', `${OUT}.mp4`, '-frames:v', '1', '-q:v', '4', `${OUT}.jpg`);
fs.rmSync(work, { recursive: true, force: true });

const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
console.log(`slide ${SLIDE}: ${steps.length} builds, ${(to - from).toFixed(1)}s`
  + ` → ${path.relative(ROOT, OUT)}.webm (${kb(`${OUT}.webm`)}), .mp4 (${kb(`${OUT}.mp4`)}), .jpg (${kb(`${OUT}.jpg`)})`);
