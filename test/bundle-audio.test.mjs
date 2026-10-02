// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A bundle carries the narration's recorded audio only when asked (`--audio`):
// a talk's voice is tens of MB, so by default it stays beside the deck and the
// bundle names the folder to send with it. Asked, every file a track would play
// goes in as a data-decklight-audio block, keyed by the URL the runtime builds
// for it, which is what the runtime looks up before playing that URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { have, tmp as scratch } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli/decklight.mjs');

const bytes = (s) => Buffer.from(s);

/** A deck-as-data with a folder track (JSON config) and a local manifest track. */
function deck(t, config) {
  const dir = scratch('bundle-audio', t);
  mkdirSync(path.join(dir, 'voices'));
  writeFileSync(path.join(dir, 'voices', 'slide-01.m4a'), bytes('one'));
  writeFileSync(path.join(dir, 'voices', 'slide-02-01.wav'), bytes('beat'));
  writeFileSync(path.join(dir, 'voices', 'slide-01.visemes.json'), '{}');
  writeFileSync(path.join(dir, 'voices', 'notes.txt'), 'not audio');
  mkdirSync(path.join(dir, 'cloud'));
  writeFileSync(path.join(dir, 'cloud', 'take.mp3'), bytes('local'));
  writeFileSync(path.join(dir, 'cloud', 'manifest.json'), JSON.stringify({ slides: [
    { file: 'take.mp3' },
    { file: 'slide-02.m4a', url: 'https://bucket.example/slide-02.m4a?sig=x' },
    null,
  ] }));
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, '<!doctype html><html><head></head><body><div class="decklight"><section><h2>One</h2></section></div>'
    + `<script type="application/json" data-decklight-config>${JSON.stringify(config)}</script></body></html>`);
  return { dir, file };
}

const run = (...args) => spawnSync(process.execPath, [CLI, 'bundle', ...args], { encoding: 'utf8' });
const audioBlocks = (html) => Object.fromEntries([...html.matchAll(
  /<script type="application\/json" data-decklight-audio="([^"]+)">([^<]*)<\/script>/g)].map((m) => [m[1], JSON.parse(m[2])]));

const TRACKS = { narration: { files: [{ label: 'Me', dir: 'voices' }, { label: 'Cloud', manifest: 'cloud/manifest.json' }] } };

test('bundle leaves the recorded audio beside the deck by default, and says where', (t) => {
  const { dir, file } = deck(t, TRACKS);
  const out = path.join(dir, 'out.html');
  const r = run(file, '-o', out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(audioBlocks(readFileSync(out, 'utf8')), {}, 'no audio inside');
  assert.match(r.stdout, /narration audio: 3 file\(s\) stay beside the deck, in voices\/ \(2\), cloud\/ \(1\)/);
  assert.match(r.stdout, /--audio to carry them inside/, 'and names the option that would');
  // --no-audio is the default said out loud
  const r2 = run(file, '-o', out, '--no-audio');
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(audioBlocks(readFileSync(out, 'utf8')), {});
});

test('bundle --audio carries every file a track plays, keyed by the URL the runtime builds', (t) => {
  const { dir, file } = deck(t, TRACKS);
  const out = path.join(dir, 'out.html');
  const r = run(file, '-o', out, '--audio');
  assert.equal(r.status, 0, r.stderr);
  const blocks = audioBlocks(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(blocks).sort(), ['cloud/take.mp3', 'voices/slide-01.m4a', 'voices/slide-02-01.wav'],
    'a whole slide, a ⟨CLICK⟩ beat and a manifest\'s local file — no sidecar, no stray file');
  assert.equal(blocks['voices/slide-01.m4a'], `data:audio/mp4;base64,${bytes('one').toString('base64')}`);
  assert.equal(blocks['voices/slide-02-01.wav'], `data:audio/wav;base64,${bytes('beat').toString('base64')}`);
  assert.equal(blocks['cloud/take.mp3'], `data:audio/mpeg;base64,${bytes('local').toString('base64')}`);
  assert.match(r.stdout, /narration audio: inlined 3 file\(s\), 0\.0 KB, from voices\/ \(2\), cloud\/ \(1\)/);
  assert.match(r.stdout, /1 manifest file\(s\) live at a URL and stay there/, 'a signed bucket URL is left where it is');
});

test('bundle --audio reads the one-string track form and a deck with no recorded audio', (t) => {
  const one = deck(t, { narration: { files: 'voices', ext: 'wav' } });
  const out = path.join(one.dir, 'out.html');
  assert.equal(run(one.file, '-o', out, '--audio').status, 0);
  assert.deepEqual(Object.keys(audioBlocks(readFileSync(out, 'utf8'))).sort(), ['voices/slide-01.m4a', 'voices/slide-02-01.wav']);

  const none = deck(t, { narration: { slowRate: 0.8 } });
  const r = run(none.file, '-o', path.join(none.dir, 'out.html'), '--audio');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /narration audio/, 'nothing to say about audio a deck does not have');
});

/** Two seconds of a 440 Hz tone as 16-bit stereo 44.1 kHz PCM: a WAV the size the recorder writes. */
function wav(seconds = 2) {
  const rate = 44100, ch = 2, n = rate * seconds;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
    for (let c = 0; c < ch; c++) data.writeInt16LE(v, (i * ch + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('bundle --small-audio re-encodes the voice small, keyed by the same URL', { skip: !have('ffmpeg') && 'needs ffmpeg' }, (t) => {
  const dir = scratch('bundle-audio', t);
  mkdirSync(path.join(dir, 'voices'));
  const original = wav();
  writeFileSync(path.join(dir, 'voices', 'slide-01.wav'), original);
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, '<!doctype html><html><head></head><body><div class="decklight"><section><h2>One</h2></section></div>'
    + `<script type="application/json" data-decklight-config>${JSON.stringify({ narration: { files: 'voices', ext: 'wav' } })}</script></body></html>`);
  const out = path.join(dir, 'out.html');
  const r = run(file, '-o', out, '--small-audio');
  assert.equal(r.status, 0, r.stderr);
  const blocks = audioBlocks(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(blocks), ['voices/slide-01.wav'], 'the URL the track plays, whatever the bytes became');
  const m = /^data:audio\/mp4;base64,(.*)$/.exec(blocks['voices/slide-01.wav']);
  assert.ok(m, 'AAC in an MP4 container');
  const small = Buffer.from(m[1], 'base64');
  assert.ok(small.length * 10 < original.length, `a tenth of the WAV at most (${small.length} of ${original.length} bytes)`);
  assert.match(r.stdout, /inlined 1 file\(s\), [\d.]+ KB \(re-encoded from 344\.6 KB, mono AAC 32 kbps\), from voices\/ \(1\)/);
});

test('bundle --small-audio without ffmpeg says what to install, or how to carry the files as they are', (t) => {
  const { dir, file } = deck(t, TRACKS);
  const r = spawnSync(process.execPath, [CLI, 'bundle', file, '-o', path.join(dir, 'out.html'), '--small-audio'],
    // every spelling of PATH emptied: Windows keeps it as `Path`
    { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--small-audio re-encodes the narration with ffmpeg, which is not installed — install it, or bundle with --audio/);
});
