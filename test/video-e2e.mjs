// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight video, end to end: a real headless Chrome and a real ffmpeg render
// a 2-slide fixture to an mp4, and ffprobe vouches for the result. Runnable
// manually — `node test/video-e2e.mjs` — and deliberately NOT part of
// `npm test` (the *.test.mjs glob) or `npm run verify`: it needs ffmpeg, which
// a contributor's machine may not have, and skipping inside the blessed suites
// would let "green" mean "not actually run". When ffmpeg (or a Chrome) is
// missing it says so and exits 0.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffprobeArgs } from '../tools/video.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const have = (bin) => {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; }
  catch (e) { return e?.code !== 'ENOENT'; }
};
if (!have('ffmpeg') || !have('ffprobe')) {
  console.log('video-e2e: SKIP — ffmpeg/ffprobe not installed (apt install ffmpeg / brew install ffmpeg)');
  process.exit(0);
}
// chromeBin() exits the process when no browser exists, so probe it out-of-process
const { spawnSync } = await import('node:child_process');
const probe = spawnSync(process.execPath,
  ['-e', `import('${join(root, 'tools', 'chrome.mjs').replaceAll('\\', '/')}').then(m => m.chromeBin('probe'))`]);
if (probe.status !== 0) {
  console.log('video-e2e: SKIP — no Chrome found (install one, or point $CHROME at it)');
  process.exit(0);
}
if (!existsSync(join(root, 'dist', 'decklight.js'))) {
  console.log('video-e2e: SKIP — dist/ not built (run npm install or npm run build)');
  process.exit(0);
}

// A 2-slide fixture: slide 2 opts into a per-slide hold via data-video-hold —
// with --hold 1 both slides hold 1s, so the whole video comes out ≈ 2s.
const dir = mkdtempSync(join(tmpdir(), 'decklight-video-e2e-'));
const deck = join(dir, 'deck.html');
writeFileSync(deck, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${root}/dist/decklight.css">
<style>.decklight { --bg:#14161d; --fg:#e8eaf2; --muted:#8b90a3; --heading-color:#fff; }</style>
</head><body>
<div class="decklight">
  <section><h2>Slide one</h2><ul data-build><li>built</li><li>fully</li></ul></section>
  <section data-video-hold="1"><h2>Slide two</h2><p>the end</p></section>
</div>
<script src="${root}/dist/decklight.js"></script>
<script>Decklight.init({ transition: 'none' });</script>
</body></html>`);

const out = join(dir, 'deck.mp4');
try {
  const log = execFileSync(process.execPath,
    [join(root, 'cli', 'decklight.mjs'), 'video', deck, '-o', out, '--hold', '1', '--fps', '10'],
    { encoding: 'utf8' });
  console.log(log.trim());

  assert.ok(existsSync(out), 'the mp4 exists');
  assert.ok(statSync(out).size > 1000, 'and is not an empty shell');

  const duration = Number(execFileSync('ffprobe', ffprobeArgs(out), { encoding: 'utf8' }).trim());
  assert.ok(Math.abs(duration - 2) < 0.5, `2 slides × 1s hold ≈ 2s, got ${duration}s`);

  // one video stream, one CONTINUOUS audio stream — silent slides still carry audio
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(streams.some((s) => s.includes('h264,video')), `has an h264 video stream (${streams})`);
  assert.ok(streams.some((s) => s.includes('aac,audio')), `has an aac audio stream (${streams})`);

  console.log(`video-e2e: OK — ${out} is ${duration.toFixed(2)}s of playable mp4`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
