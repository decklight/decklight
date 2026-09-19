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
function fakeTts({ name = 'fake', model = 'm1', ...traits } = {}) {
  const said = [];
  const synth = Object.assign(async (text) => { said.push(text); return { wav: wavOf(text), usage: { cost: 0 } }; },
    { mimeType: 'audio/wav' });
  return { name, model, stylable: false, synth, said, ...traits };
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

// ── #553: a render re-voices a machine-voiced track's stale slides ─────────
import { revoiceStale } from '../tools/video.mjs';

/** A wav track voiced by a stand-in "piper", and the deck it was voiced from. */
async function piperTrack(t) {
  const dir = tmp('revoice', t);
  const tts = fakeTts({ name: 'piper', model: 'en_US-ryan-high', voiceIsFixed: true });
  await synthesizeSlides({ html: THREE, dir, tts, voice: 'en_US-ryan-high', style: 'warm', format: 'wav', cache: noCache(), log: quiet, encoder: null });
  return { dir, narration: { ...readTrack(dir), dir } };
}
const ready = () => ({ ready: true, reason: 'ok' });

test('revoice: exactly the stale slide is voiced again, in the track\'s own engine, voice and format', async (t) => {
  const { dir, narration } = await piperTrack(t);
  const edited = deck(['One says this.', 'Two has moved on.', 'Three says the rest.']);
  const { stale } = staleSlides(narration, slideTexts(edited));
  assert.deepEqual(stale, [2]);
  const untouched = [1, 3].map((n) => readFileSync(path.join(dir, `slide-0${n}.wav`)));

  const tts = fakeTts({ name: 'piper', model: 'en_US-ryan-high', voiceIsFixed: true });
  let asked = null;
  const lines = [];
  const r = await revoiceStale({
    html: edited, narration, stale, log: (l) => lines.push(l), cache: noCache(), status: ready,
    create: (opts) => { asked = opts; return tts; },
  });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([asked.engine, asked.voice], ['piper', 'en_US-ryan-high'], 'the track\'s engine and voice, not a default');
  assert.deepEqual(tts.said, ['Two has moved on.']);
  assert.match(lines[0], /re-voicing slide 2 in the track's own voice — 1 clip from piper \(en_US-ryan-high\)/, 'said before it spent anything');
  const now = readTrack(dir);
  assert.equal(now.slides[1].file, 'slide-02.wav', 'the track stays wav');
  assert.deepEqual([1, 3].map((n) => readFileSync(path.join(dir, `slide-0${n}.wav`))), untouched);
  assert.deepEqual(staleSlides(now, slideTexts(edited)).stale, [], 'and the render\'s check now passes');
});

test('revoice: a track with no engine is a human take — left to the refusal, and says why', async (t) => {
  const { narration } = await piperTrack(t);
  const r = await revoiceStale({ html: THREE, narration: { ...narration, engine: undefined }, stale: [2], status: ready, create: () => assert.fail('no engine to build') });
  assert.equal(r.ok, false);
  assert.match(r.why, /names no engine it was voiced with — a take in somebody's own voice is re-recorded/);
});

test('revoice: an engine this machine cannot run is named, with the missing credential — never a stack trace', async (t) => {
  const { narration } = await piperTrack(t);
  const r = await revoiceStale({
    html: THREE, narration: { ...narration, engine: 'elevenlabs', voice: 'Rachel', model: 'eleven_multilingual_v2' }, stale: [2],
    env: { ...process.env, ELEVENLABS_API_KEY: '' },
    status: (name) => ({ name, ready: false, reason: 'no-key' }), create: () => assert.fail('not built when unavailable'),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /voiced by elevenlabs, which needs \$ELEVENLABS_API_KEY — export it/);
});

// ── #557: the stamp is what the render's check computes ───────────────────
import { clipKey } from '../tools/tts-cache.mjs';

/** A stand-in ElevenLabs: no --voice means the first of the account's voices. */
const elevenTts = (mimeType = 'audio/wav') => {
  const tts = fakeTts({ name: 'elevenlabs', model: 'eleven_multilingual_v2', listVoices: async () => [{ name: 'Aria' }, { name: 'Chris' }] });
  tts.synth.mimeType = mimeType;
  return tts;
};

test('revoice: a default-voice track the recorder made is current after its stale slide is re-voiced (#557)', async (t) => {
  const dir = tmp('revoice-default-voice', t);
  const header = { engine: 'elevenlabs', model: 'eleven_multilingual_v2', voice: null, style: '' };
  const recorded = recorderManifest({ prev: null, header, texts: slideTexts(THREE), range: { from: 1, to: 3 }, recorded: { 1: {}, 2: {}, 3: {} } });
  mkdirSync(dir, { recursive: true });
  for (const s of recorded.slides) writeFileSync(path.join(dir, s.file), 'a take');
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(recorded));

  const edited = deck(['One says this.', 'Two has moved on.', 'Three says the rest.']);
  const narration = { ...readTrack(dir), dir };
  const { stale } = staleSlides(narration, slideTexts(edited));
  assert.deepEqual(stale, [2]);

  const tts = elevenTts();
  const r = await revoiceStale({ html: edited, narration, stale, log: quiet, cache: noCache(), status: ready, create: () => tts });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(tts.said, ['Two has moved on.']);
  const now = readTrack(dir);
  assert.deepEqual(staleSlides(now, slideTexts(edited)).stale, [], 'the check reproduces the stamp it wrote');
  assert.equal(now.voice, null, 'the header still says "the default voice" — not dropped, not resolved under the other slides');
  assert.ok(!('format' in now), 'nor given a format the other slides were not stamped under');
  assert.deepEqual([now.slides[0], now.slides[2]], [recorded.slides[0], recorded.slides[2]]);
});

test('a fresh track voiced without --voice names the voice and format its hashes were taken under (#557)', async (t) => {
  const dir = tmp('synth-resolved-voice', t);
  const fakeRun = (bin, args) => writeFileSync(args[args.length - 1], `${bin}-out`);
  const tts = elevenTts('audio/mpeg');
  const { manifest } = await run({ html: THREE, dir, tts, voice: undefined, style: '', format: 'wav', encoder: 'ffmpeg', run: fakeRun });
  assert.deepEqual([manifest.voice, manifest.format], ['Aria', 'mp3']);
  assert.deepEqual(staleSlides(readTrack(dir), slideTexts(THREE)).stale, []);
  assert.equal(manifest.slides[0].hash, clipKey(tts, { voice: 'Aria', style: '', text: 'One says this.' }).slice(0, 16),
    'and the hash is still the clip key, shortened');
});

test('a track stamped before #557 is kept and re-stamped — current again, nothing paid for twice', async (t) => {
  const dir = tmp('synth-pre557', t);
  const tts = elevenTts();
  // what the core wrote then: hashed under the resolved voice, a header naming none
  const texts = slideTexts(THREE);
  const slides = texts.map((text, i) => ({ file: `slide-0${i + 1}.wav`, hash: clipKey(tts, { voice: 'Aria', style: '', text }).slice(0, 16) }));
  mkdirSync(dir, { recursive: true });
  for (const s of slides) writeFileSync(path.join(dir, s.file), 'audio');
  const prev = { engine: 'elevenlabs', model: 'eleven_multilingual_v2', style: '', slides };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(prev));
  assert.deepEqual(staleSlides(prev, texts).stale, [1, 2, 3], 'the render refused it');

  const { skipped } = await run({ html: THREE, dir, tts, voice: undefined, style: '', format: 'wav', prev });
  assert.equal(tts.said.length, 0);
  assert.equal(skipped, 3);
  assert.deepEqual(staleSlides(readTrack(dir), texts).stale, []);
});
