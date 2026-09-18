// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The machine-narration core (#555): one producer of track audio, so a track
// made by one path can be refreshed by another without its format, voice or
// manifest drifting. The core runs in-process against a stand-in engine; the
// CLI runs for real against a stand-in piper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  synthesizeSlides, trackFormat, voiceDrift, readTrack, TRACK_FORMATS,
} from '../tools/narration-synth.mjs';
import { recorderManifest, slideTexts, staleSlides } from '../tools/narration-manifest.mjs';
import { createTtsCache } from '../tools/tts-cache.mjs';
import { createEngine } from '../tools/tts-engines.mjs';
import { tmp, writeFakePiper } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli', 'decklight.mjs');

const deck = (notes) => `<!doctype html><html><body><div class="decklight">${notes
  .map((n, i) => `<section><h2>S${i + 1}</h2>${n == null ? '' : `<aside class="notes">${n}</aside>`}</section>`)
  .join('')}</div></body></html>`;
const THREE = deck(['One says this.', 'Two says that.', 'Three says the rest.']);

/** A WAV whose bytes depend on the words — so a re-voice is visible on disk. */
function wavOf(text) {
  const pcm = Buffer.from(text.padEnd(64, '.'));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** An engine as tools/tts-engines.mjs shapes one, counting what it is asked to say. */
function fakeTts({ name = 'fake', model = 'm1' } = {}) {
  const said = [];
  const synth = Object.assign(async (text) => { said.push(text); return { wav: wavOf(text), usage: { cost: 0 } }; },
    { mimeType: 'audio/wav' });
  return { name, model, stylable: false, synth, said };
}

const noCache = () => createTtsCache({ enabled: false });
const quiet = () => {};
const run = (opts) => synthesizeSlides({ cache: noCache(), log: quiet, encoder: null, voice: 'v1', style: 'warm', ...opts });

test('a track is one format, read off its files; a track with nothing in it has none yet', () => {
  assert.equal(trackFormat({ slides: [null, { file: 'slide-02.wav' }, { file: 'slide-03.m4a' }] }), 'wav');
  assert.equal(trackFormat({ slides: [{ file: 'slide-01.m4a' }] }), 'm4a');
  assert.equal(trackFormat({ slides: [null] }), null);
  assert.equal(trackFormat(null), null);
  assert.deepEqual(TRACK_FORMATS, ['wav', 'm4a', 'mp3']);
});

test('a ranged run in another voice would leave the track in two — named, so it can be refused', () => {
  const prev = { engine: 'piper', model: 'ryan', voice: 'ryan', slides: [{ file: 'slide-01.wav' }] };
  assert.equal(voiceDrift(prev, { engine: 'piper', model: 'ryan', voice: 'ryan' }), null);
  assert.match(voiceDrift(prev, { engine: 'elevenlabs', model: 'x', voice: 'Rachel' }), /engine piper/);
  assert.match(voiceDrift(prev, { engine: 'piper', model: 'amy', voice: 'amy' }), /voice ryan.*model ryan/);
  // say/sapi: the "model" is the voice a bridge booted with, not identity
  assert.equal(voiceDrift({ ...prev, engine: 'say', model: 'Albert', voice: 'Samantha' },
    { engine: 'say', model: 'Voice 1', voice: 'Samantha' }, { modelIsVoice: false }), null);
  // an empty track has no voice to keep to
  assert.equal(voiceDrift({ engine: 'piper', slides: [null] }, { engine: 'say' }), null);
});

test('a wav track is written directly — no encoder, one file per slide, the manifest names them', async (t) => {
  const dir = tmp('synth-wav', t);
  const tts = fakeTts();
  const { manifest } = await run({ html: THREE, dir, tts, format: 'wav' });
  assert.deepEqual(manifest.slides.map((s) => s.file), ['slide-01.wav', 'slide-02.wav', 'slide-03.wav']);
  assert.deepEqual({ ...manifest, slides: undefined }, { engine: 'fake', model: 'm1', voice: 'v1', style: 'warm', slides: undefined });
  for (const s of manifest.slides) assert.ok(existsSync(path.join(dir, s.file)));
  assert.deepEqual(readTrack(dir), manifest, 'what it returns is what it wrote');
  assert.equal(tts.said.length, 3);

  // a rerun is free: every slide's hash still matches and its file is there
  const again = fakeTts();
  const r = await run({ html: THREE, dir, tts: again, format: 'wav', prev: readTrack(dir) });
  assert.equal(again.said.length, 0);
  assert.equal(r.skipped, 3);
});

test('refreshing one stale slide of a wav track writes wav for that slide and touches nothing else', async (t) => {
  const dir = tmp('synth-refresh', t);
  await run({ html: THREE, dir, tts: fakeTts(), format: 'wav' });
  const before = (n) => readFileSync(path.join(dir, `slide-0${n}.wav`));
  const [one, three] = [before(1), before(3)];
  const mtimes = [1, 3].map((n) => statSync(path.join(dir, `slide-0${n}.wav`)).mtimeMs);

  const edited = deck(['One says this.', 'Two says something new.', 'Three says the rest.']);
  const prev = readTrack(dir);
  assert.deepEqual(staleSlides(prev, slideTexts(edited)).stale, [2], 'the export would flag slide 2');

  const tts = fakeTts();
  const { manifest } = await run({ html: edited, dir, tts, format: trackFormat(prev), prev, range: { from: 2, to: 2 } });
  assert.deepEqual(tts.said, ['Two says something new.'], 'only the stale slide was voiced');
  assert.equal(manifest.slides[1].file, 'slide-02.wav', 'in the track\'s own format');
  assert.deepEqual(readFileSync(path.join(dir, 'slide-02.wav')), wavOf('Two says something new.'));
  assert.deepEqual([before(1), before(3)], [one, three], 'the other slides\' audio is untouched');
  assert.deepEqual([1, 3].map((n) => statSync(path.join(dir, `slide-0${n}.wav`)).mtimeMs), mtimes);
  assert.deepEqual(manifest.slides[0], prev.slides[0]);
  assert.deepEqual(manifest.slides[2], prev.slides[2]);
  assert.deepEqual(staleSlides(manifest, slideTexts(edited)).stale, [], 'and the track is current again');
});

test('a track the deck\'s recorder made is refreshed as that track — kept, and its header carried', async (t) => {
  // The mismatch #555 removes: a recorder track is wav under the live voice's
  // header, and `voiceover` used to re-voice it in piper as m4a.
  const dir = tmp('synth-recorder', t);
  const header = { engine: 'fake', model: 'm1', voice: 'v1', style: 'warm' };
  const texts = slideTexts(THREE);
  const recorded = recorderManifest({ prev: null, header, texts, range: { from: 1, to: 3 }, recorded: { 1: {}, 2: {}, 3: {} } });
  mkdirSync(dir, { recursive: true });
  for (const s of recorded.slides) writeFileSync(path.join(dir, s.file), 'a take');
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(recorded));

  const tts = fakeTts();
  const { manifest, skipped } = await run({ html: THREE, dir, tts, format: trackFormat(recorded), prev: recorded });
  assert.equal(tts.said.length, 0, 'the recorder\'s hashes are the core\'s: nothing to re-voice');
  assert.equal(skipped, 3);
  assert.equal(manifest.recorder, 'deck', 'a header field the core does not own is carried');
  assert.deepEqual(manifest.slides.map((s) => s.file), ['slide-01.wav', 'slide-02.wav', 'slide-03.wav']);
});

test('a ranged run in another voice is refused before anything is written', async (t) => {
  const dir = tmp('synth-drift', t);
  await run({ html: THREE, dir, tts: fakeTts(), format: 'wav' });
  const prev = readTrack(dir);
  const tts = fakeTts();
  await assert.rejects(run({ html: THREE, dir, tts, voice: 'someone-else', format: 'wav', prev, range: { from: 2, to: 2 } }),
    /voiced in voice v1 — voicing slides 2–2 in another would leave the track in two voices/);
  assert.equal(tts.said.length, 0);
  assert.deepEqual(readTrack(dir), prev);
});

test('an m4a track is encoded, ⟨CLICK⟩ beats and all — one synthesis per beat, stitched', async (t) => {
  const dir = tmp('synth-m4a', t);
  const calls = [];
  // the encoder stands in: it writes its output, which is always the last argument
  const fakeRun = (bin, args) => { calls.push([bin, ...args]); writeFileSync(args[args.length - 1], `${bin}-out`); };
  const tts = fakeTts();
  const html = deck(['Beat one. ⟨CLICK⟩ Beat two.', 'Whole slide.']);
  const { manifest } = await run({ html, dir, tts, format: 'm4a', encoder: 'ffmpeg', run: fakeRun });
  assert.deepEqual(tts.said, ['Beat one.', 'Beat two.', 'Whole slide.'], 'the beats, not the slide twice');
  assert.equal(manifest.slides[0].file, 'slide-01.m4a');
  assert.deepEqual(manifest.slides[0].segments, [{ file: 'slide-01-01.m4a' }, { file: 'slide-01-02.m4a' }]);
  assert.equal(manifest.slides[1].file, 'slide-02.m4a');
  assert.ok(calls.some((c) => c.includes('concat')), 'the slide was stitched from its beats');
  assert.ok(calls.some((c) => c.includes('aac')), 'and encoded to AAC');
  assert.ok(!existsSync(path.join(dir, 'slide-02.wav')), 'no intermediate is left without --keep-wav');
});

// ── the command line, for real, against a stand-in piper ──────────────────
const posix = process.platform !== 'win32';

function piperWorld(t) {
  const dir = tmp('synth-cli', t);
  const bin = path.join(dir, 'bin');
  const models = path.join(dir, 'models');
  mkdirSync(bin); mkdirSync(models);
  writeFakePiper(bin);
  writeFileSync(path.join(models, 'en_US-ryan-high.onnx'), '');
  writeFileSync(path.join(models, 'en_US-ryan-high.onnx.json'), '{}');
  // no ffmpeg on this PATH: a wav track must not need one
  const env = { ...process.env, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter), XDG_CACHE_HOME: path.join(dir, 'cache') };
  const voiceover = (...args) => spawnSync(process.execPath, [CLI, 'voiceover', ...args, '--data-dir', models],
    { encoding: 'utf8', env });
  return { dir, bin, models, env, voiceover };
}

test('the CLI and the core, given the same deck and voice, write byte-identical manifests', { skip: !posix && 'the stand-in piper is a POSIX script' }, async (t) => {
  const { dir, bin, models, voiceover } = piperWorld(t);
  const deckFile = path.join(dir, 'deck.html');
  writeFileSync(deckFile, THREE);
  const r = voiceover(deckFile, '-o', path.join(dir, 'cli'), '--format', 'wav');
  assert.equal(r.status, 0, r.stderr);

  const PATH = process.env.PATH;
  process.env.PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
  t.after(() => { process.env.PATH = PATH; });
  const tts = createEngine({ engine: 'piper', voice: 'en_US-ryan-high', dataDir: models });
  try {
    await synthesizeSlides({
      html: THREE, dir: path.join(dir, 'core'), tts, voice: 'en_US-ryan-high', format: 'wav',
      style: 'Read in a warm, welcoming tone, like a friendly battle-hardened senior engineer who is still curious about new technology.',
      cache: noCache(), log: quiet,
    });
  } finally { tts.synth.close?.(); }
  assert.equal(readFileSync(path.join(dir, 'core', 'manifest.json'), 'utf8'),
    readFileSync(path.join(dir, 'cli', 'manifest.json'), 'utf8'));
});

test('voiceover into an existing track keeps its engine, voice and format — flags only override', { skip: !posix && 'the stand-in piper is a POSIX script' }, async (t) => {
  const { dir, voiceover } = piperWorld(t);
  const deckFile = path.join(dir, 'deck.html');
  const out = path.join(dir, 'voices');
  writeFileSync(deckFile, THREE);
  assert.equal(voiceover(deckFile, '-o', out, '--format', 'wav').status, 0);
  // the recorder's mark on the header, as a deck-recorded track carries it
  const made = readTrack(out);
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...made, recorder: 'deck' }));

  // no --engine, no --voice, no --format: the track says
  writeFileSync(deckFile, deck(['One says this.', 'Two, rewritten.', 'Three says the rest.']));
  const r = voiceover(deckFile, '-o', out, '--slides', '2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /slide 01: |voicing slide 2 only/);
  const now = readTrack(out);
  assert.equal(now.slides[1].file, 'slide-02.wav', 'the track stays wav — no m4a beside it');
  assert.ok(!existsSync(path.join(out, 'slide-02.m4a')));
  assert.deepEqual([now.engine, now.voice, now.recorder], ['piper', 'en_US-ryan-high', 'deck']);
  assert.deepEqual(now.slides[0], made.slides[0]);

  // …and a ranged run in another voice is refused, with the way out
  const other = voiceover(deckFile, '-o', out, '--slides', '2', '--voice', 'en_US-amy-medium');
  assert.equal(other.status, 1);
  assert.match(other.stderr, /two voices/);
});
