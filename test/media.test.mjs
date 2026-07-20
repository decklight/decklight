// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Background media (SPEC §1): parseBackground attribute semantics, and the
// bundler's data-URI inlining of background images/posters (videos stay
// external). The DOM side (.slide-bg injection, play/pause on slide change,
// print poster) is covered by test/render.mjs against demo/smoke.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBackground } from '../src/core/media.js';

test('parseBackground: no background attributes → null', () => {
  assert.equal(parseBackground({}), null);
  assert.equal(parseBackground({ 'data-background-dim': '0.5' }), null);
});

test('parseBackground: image defaults — cover, center, no dim', () => {
  assert.deepEqual(parseBackground({ 'data-background-image': 'hero.jpg' }), {
    image: 'hero.jpg', video: null, poster: null,
    size: 'cover', position: 'center', dim: 0,
  });
});

test('parseBackground: size honors contain, anything else falls back to cover', () => {
  const at = (size) => parseBackground({ 'data-background-image': 'a.png', 'data-background-size': size }).size;
  assert.equal(at('contain'), 'contain');
  assert.equal(at('cover'), 'cover');
  assert.equal(at('stretch'), 'cover');
});

test('parseBackground: position passes through', () => {
  const bg = parseBackground({ 'data-background-image': 'a.png', 'data-background-position': 'top left' });
  assert.equal(bg.position, 'top left');
});

test('parseBackground: dim parses and clamps to [0, 1]', () => {
  const at = (dim) => parseBackground({ 'data-background-image': 'a.png', 'data-background-dim': dim }).dim;
  assert.equal(at('0.5'), 0.5);
  assert.equal(at('2'), 1);
  assert.equal(at('-1'), 0);
  assert.equal(at('soon'), 0);
});

test('parseBackground: video with poster', () => {
  const bg = parseBackground({
    'data-background-video': 'clip.mp4',
    'data-background-poster': 'poster.jpg',
  });
  assert.equal(bg.video, 'clip.mp4');
  assert.equal(bg.poster, 'poster.jpg');
  assert.equal(bg.image, null);
  assert.equal(bg.size, 'cover');
});

// --- bundler -----------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

test('bundle inlines background image/poster as data URIs; video stays external', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-media-'));
  fs.mkdirSync(path.join(dir, 'themes'));
  fs.writeFileSync(path.join(dir, 'themes', 'plain.css'), '.decklight { --bg: #111; }');
  fs.writeFileSync(path.join(dir, 'bg.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'poster.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, 'deck.html'), `<!doctype html>
<html><head><link rel="stylesheet" href="themes/plain.css"></head><body>
<div class="decklight">
  <section data-background-image="bg.svg"><h2>image</h2></section>
  <section data-background-video="clip.mp4" data-background-poster="poster.png"><h2>video</h2></section>
</div>
</body></html>`);

  const out = execFileSync('node', [CLI, 'bundle', path.join(dir, 'deck.html')], { encoding: 'utf8' });
  const bundled = fs.readFileSync(path.join(dir, 'deck-standalone.html'), 'utf8');
  assert.match(bundled, /data-background-image="data:image\/svg\+xml;base64,/);
  assert.match(bundled, /data-background-poster="data:image\/png;base64,/);
  // the video reference is untouched, and the CLI says so
  assert.match(bundled, /data-background-video="clip\.mp4"/);
  assert.match(out, /background video: 1 file\(s\) stay external/);
  fs.rmSync(dir, { recursive: true, force: true });
});
