// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/site-voices.mjs: the pure half of the site's voice-track round trip.
// The commands that reach gh and Vertex are not run here; what is checked is
// what they decide on: which files travel, when nothing has changed, how a
// track is voiced, and which slides a track no longer speaks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { checkTracks, configuredDirs, contentDigest, loadConfig, packList, refreshArgv, voiceDir } from '../tools/site-voices.mjs';
import { manifestHash, slideTexts } from '../tools/narration-manifest.mjs';
import { tmp } from './helpers.mjs';

const CFG = {
  release: 'site-voices', asset: 'voices.tar.gz', engine: 'gemini',
  style: 'Read warmly.',
  voices: [{ label: 'Algenib', voice: 'Algenib', dir: 'voices/algenib' }, { label: 'Aoede', voice: 'Aoede', dir: 'voices/aoede' }],
};
const DECK = `<!doctype html><html><body><div class="decklight">
<section><h2>One</h2><aside class="notes">The first slide.</aside></section>
<section><h2>Two</h2></section>
<section><h2>Three</h2><aside class="notes">The third, with a [click] beat.</aside></section>
</div></body></html>`;

/** A track as voiceover.mjs leaves it: a manifest with one hashed entry per slide with notes. */
function track(root, voice, texts, { drop = [], corrupt = [] } = {}) {
  const dir = voiceDir(root, voice);
  mkdirSync(dir, { recursive: true });
  const header = { engine: CFG.engine, voice: voice.voice, style: CFG.style };
  const slides = texts.map((t, i) => {
    const n = i + 1;
    if (!t || drop.includes(n)) return null;
    const hash = corrupt.includes(n) ? 'ffffffffffffffff' : manifestHash(header, t);
    writeFileSync(path.join(dir, `slide-${String(n).padStart(2, '0')}.m4a`), Buffer.from([n]));
    return { file: `slide-${String(n).padStart(2, '0')}.m4a`, hash };
  });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...header, slides }));
  return dir;
}

test('the config must name the release, the asset, the engine and at least one voice; a style is optional', (t) => {
  const dir = tmp('site-voices-cfg', t);
  const file = path.join(dir, 'voices.json');
  writeFileSync(file, JSON.stringify(CFG));
  assert.equal(loadConfig(file).release, 'site-voices');
  writeFileSync(file, JSON.stringify({ ...CFG, style: undefined }));
  assert.equal(loadConfig(file).style, undefined, 'ElevenLabs takes no style prompt');
  writeFileSync(file, JSON.stringify({ ...CFG, engine: undefined }));
  assert.throws(() => loadConfig(file), /no "engine"/);
  writeFileSync(file, JSON.stringify({ ...CFG, voices: [] }));
  assert.throws(() => loadConfig(file), /"voices" is empty/);
});

test('a track is voiced by voiceover.mjs with the engine and the voice every time, and the style only when the config has one', () => {
  const argv = refreshArgv('demo/showcase.html', CFG, CFG.voices[1], '/tmp/x/aoede');
  assert.match(argv[0], /voiceover\.mjs$/);
  assert.deepEqual(argv.slice(1), ['demo/showcase.html', '--engine', 'gemini', '--voice', 'Aoede', '--style', 'Read warmly.', '-o', '/tmp/x/aoede']);
  const eleven = { ...CFG, engine: 'elevenlabs', style: undefined, voices: [{ label: 'Chris', voice: 'Chris', dir: 'voices/chris' }] };
  assert.deepEqual(refreshArgv('demo/showcase.html', eleven, eleven.voices[0], '/tmp/x/chris').slice(1),
    ['demo/showcase.html', '--engine', 'elevenlabs', '--voice', 'Chris', '-o', '/tmp/x/chris']);
});

test('what travels: audio, manifests and scripts, per voice folder; never temp files or the digest', (t) => {
  const root = tmp('site-voices-pack', t);
  const texts = slideTexts(DECK);
  track(root, CFG.voices[0], texts);
  const dir = voiceDir(root, CFG.voices[0]);
  writeFileSync(path.join(dir, 'slide-01.txt'), 'The first slide.');
  writeFileSync(path.join(dir, 'slide-01.tmp.wav'), 'x');
  writeFileSync(path.join(root, '.pulled'), 'abc');
  writeFileSync(path.join(root, 'stray.m4a'), 'x');   // not under a voice folder
  assert.deepEqual(packList(root), ['algenib/manifest.json', 'algenib/slide-01.m4a', 'algenib/slide-01.txt', 'algenib/slide-03.m4a']);
  // a voice that left the config leaves the asset
  track(root, { voice: 'Old', dir: 'voices/old' }, texts);
  assert.ok(packList(root).some((f) => f.startsWith('old/')));
  assert.ok(!packList(root, configuredDirs(CFG)).some((f) => f.startsWith('old/')));
  assert.deepEqual(configuredDirs(CFG), ['algenib', 'aoede']);
});

test('the digest moves with a byte and not with anything else, so an unchanged pull is never re-uploaded', (t) => {
  const root = tmp('site-voices-digest', t);
  const texts = slideTexts(DECK);
  track(root, CFG.voices[0], texts);
  const before = contentDigest(root);
  writeFileSync(path.join(root, '.pulled'), before);
  assert.equal(contentDigest(root), before, 'the digest file itself is not in the digest');
  writeFileSync(path.join(root, 'algenib', 'slide-01.tmp.wav'), 'x');
  assert.equal(contentDigest(root), before, 'a temp file is not in the digest');
  writeFileSync(path.join(root, 'algenib', 'slide-03.m4a'), Buffer.from([9]));
  assert.notEqual(contentDigest(root), before);
  assert.equal(contentDigest(path.join(root, 'nowhere')), contentDigest(path.join(root, 'elsewhere')), 'no files, one digest');
});

test('check: a fresh track passes; a moved note is stale; a dropped clip is missing; no track is absent', (t) => {
  const root = tmp('site-voices-check', t);
  const texts = slideTexts(DECK);
  track(root, CFG.voices[0], texts);
  const [fresh, absent] = checkTracks(DECK, root, CFG);
  assert.deepEqual(fresh, { voice: 'Algenib', absent: false, stale: [], missing: [] });
  assert.deepEqual(absent, { voice: 'Aoede', absent: true, stale: [], missing: [1, 3] });

  rmSync(voiceDir(root, CFG.voices[0]), { recursive: true });
  track(root, CFG.voices[0], texts, { corrupt: [1], drop: [3] });
  const [r] = checkTracks(DECK, root, CFG);
  assert.deepEqual(r, { voice: 'Algenib', absent: false, stale: [1], missing: [3] });
});
