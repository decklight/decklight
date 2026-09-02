// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The shared disk cache: a sentence is synthesized ONCE, by anyone.
//
// Warming 184 say previews took ~6 minutes of background synthesis — and
// again on every bridge restart, because the response cache lived in the
// process. Worse on a paid engine: the live bridge and `decklight voiceover`
// are separate processes, so previewing a deck in the browser and then batch-
// recording it billed ElevenLabs twice for identical words.
//
// So clips persist under $XDG_CACHE_HOME/decklight/tts, keyed by everything
// that changes the AUDIO — engine, model, format, voice, style, text — and
// nothing that does not. Putting the MODEL in the key is what makes caching a
// cloud engine safe: a server that changes its model underneath us produces a
// MISS, not a stale clip filed under today's name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './helpers.mjs';
import { cacheKey, clipKey, createTtsCache, extFor } from '../tools/tts-cache.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/decklight.mjs');

/** ffmpeg is a soak dependency, not a unit-test one — these two steps skip without it. */
const haveFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function startBridge(t, env) {
  const child = spawn(process.execPath, [CLI, 'tts', '--port', '0', '--engine', 'say'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  return new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = log.match(/tts bridge on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve({ child, port: Number(m[1]), log: () => log }); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('bridge exited early:\n' + log)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('no bridge URL:\n' + log)); }, 20000);
  });
}

test('a say synthesis survives the bridge — the SECOND bridge answers from disk', async (t) => {
  if (process.platform !== 'darwin') { t.skip('say is macOS — the sapi/piper paths share the code'); return; }

  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ttscache-'));
  t.after(() => rmTemp(cacheHome));
  const env = { XDG_CACHE_HOME: cacheHome };
  const say = async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Cache check.', voice: 'Samantha' }),
    });
    assert.equal(r.status, 200);
    return (await r.arrayBuffer()).byteLength;
  };

  // first bridge: a real synthesis, and the wav lands in the cache dir
  const a = await startBridge(t, env);
  const bytes1 = await say(a.port);
  assert.ok(bytes1 > 44, 'no audio came back');
  const dir = path.join(cacheHome, 'decklight', 'tts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
  assert.equal(files.length, 1, 'the synthesis was not written to the disk cache');
  a.child.kill('SIGTERM');
  await new Promise((ok) => a.child.on('exit', ok));

  // second bridge, same machine: the identical request is a DISK hit — no
  // synthesis, the same bytes, and the log says where they came from
  const b = await startBridge(t, env);
  const bytes2 = await say(b.port);
  assert.equal(bytes2, bytes1, 'the cached clip is not the clip that was cached');
  assert.match(b.log(), /cached on disk/, 'the second bridge synthesized instead of reading the cache');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 1, 'a duplicate landed');
});


// ── the key: everything that changes the audio, and nothing that does not ────

test('the key moves for every field that changes how it sounds', () => {
  const base = {
    engine: 'elevenlabs', model: 'eleven_multilingual_v2', format: 'wav',
    voice: 'Rachel', style: undefined, text: 'Hello there.',
  };
  const k = cacheKey(base);
  for (const [field, value] of [
    ['engine', 'gemini'], ['model', 'eleven_v3'], ['format', 'mp3'],
    ['voice', 'Adam'], ['style', 'excited'], ['text', 'Hello there!'],
  ]) {
    assert.notEqual(cacheKey({ ...base, [field]: value }), k, `${field} did not move the key`);
  }
  // Stable across processes and runs — the whole point is that two DIFFERENT
  // programs hash the same sentence to the same name.
  assert.equal(cacheKey(base), k);
  assert.equal(cacheKey({ ...base }), k);
});

test('the model is in the key, which is what makes a cloud engine cacheable', () => {
  // THE BUG this prevents: keyed without the model, `--tts-model eleven_v3`
  // reads back the multilingual_v2 take of the same words and calls it a hit.
  const of = (model) => cacheKey({ engine: 'elevenlabs', model, voice: 'Rachel', text: 'One.' });
  assert.notEqual(of('eleven_v3'), of('eleven_multilingual_v2'));
});

test('an absent field is not the empty string wearing a hat', () => {
  // A voice named "" and no voice at all must not collide, or a roster with an
  // odd row in it would serve its audio for every unvoiced request.
  assert.notEqual(
    cacheKey({ engine: 'say', text: 'x' }),
    cacheKey({ engine: 'say', text: 'x', voice: ' ' }),
  );
  // …but undefined and missing ARE the same absence, in either order
  assert.equal(
    cacheKey({ engine: 'say', text: 'x' }),
    cacheKey({ engine: 'say', text: 'x', voice: undefined, style: undefined }),
  );
});

test('mp3 and wav are filed under different names', () => {
  assert.equal(extFor('audio/mpeg'), 'mp3');
  assert.equal(extFor('audio/wav'), 'wav');
  // An unknown mime is a WAV, because every engine but ElevenLabs-mp3 is one
  assert.equal(extFor(undefined), 'wav');
});

// ── the store ───────────────────────────────────────────────────────────────

test('a clip round-trips, and a miss is null rather than a throw', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-'));
  t.after(() => rmTemp(dir));
  const c = createTtsCache({ dir });

  assert.equal(c.read('nothing-here'), null, 'a miss threw or invented bytes');
  assert.equal(c.write('k1', Buffer.from('RIFFfake')), true);
  assert.deepEqual(c.read('k1'), Buffer.from('RIFFfake'));
  // the extension travels with the read: an mp3 is not findable as a wav
  assert.equal(c.read('k1', 'mp3'), null);
  assert.equal(c.write('k1', Buffer.from('ID3fake'), 'mp3'), true);
  assert.deepEqual(c.read('k1', 'mp3'), Buffer.from('ID3fake'));
});

test('empty audio is never filed — a poisoned key would outlive the bug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-'));
  try {
    const c = createTtsCache({ dir });
    assert.equal(c.write('k', Buffer.alloc(0)), false);
    assert.equal(c.read('k'), null);
  } finally { rmTemp(dir); }
});

test('an unwritable cache is a cache, not a failed talk', () => {
  // The disk being read-only must degrade to "synthesize it again". Pointing
  // the dir at a FILE is the portable way to make mkdir fail.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-')), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const c = createTtsCache({ dir: path.join(file, 'nested') });
  assert.equal(c.write('k', Buffer.from('abc')), false);
  assert.equal(c.read('k'), null);
  assert.equal(c.prune(), 0);
});

test('--no-cache is a cache that answers nothing and keeps nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-'));
  t.after(() => rmTemp(dir));
  const c = createTtsCache({ dir, enabled: false });
  assert.equal(c.write('k', Buffer.from('abc')), false);
  assert.equal(c.read('k'), null);
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0, 'a disabled cache wrote');
});

test('the oldest clips leave first, and only once the bound is passed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-'));
  t.after(() => rmTemp(dir));
  const c = createTtsCache({ dir, limit: 250 });
  for (const [i, name] of ['old', 'mid', 'new'].entries()) {
    c.write(name, Buffer.alloc(100));
    // mtimes a second apart, so the sort is not at the mercy of the clock
    const f = path.join(dir, `${name}.wav`);
    fs.utimesSync(f, new Date(), new Date(Date.now() - (3 - i) * 60_000));
  }
  assert.equal(c.prune(), 1, 'pruned the wrong number to get under 250 bytes');
  assert.equal(c.read('old'), null, 'the oldest clip survived');
  assert.ok(c.read('mid') && c.read('new'), 'a clip inside the bound was dropped');
  // and a second prune is a no-op: the directory already fits
  assert.equal(c.prune(), 0);
});

test('an mp3 counts against the bound too', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-clip-'));
  t.after(() => rmTemp(dir));
  const c = createTtsCache({ dir, limit: 50 });
  c.write('a', Buffer.alloc(100), 'mp3');
  assert.equal(c.prune(), 1, 'an mp3 was invisible to the bound');
});


// ── the two processes agree, which is the whole feature ─────────────────────

/** An engine object of the shape createEngine returns, for key derivation. */
const engineLike = ({ name, model, stylable = false, mime = 'audio/wav' }) =>
  ({ name, model, stylable, synth: Object.assign(() => {}, { mimeType: mime }) });

test('the bridge and the recorder hash one sentence to one name', () => {
  // THE FEATURE: the deck previews a sentence through the bridge, then
  // `decklight voiceover` records the deck. Different processes, different
  // argument shapes, one key — or ElevenLabs is billed twice for it.
  const eleven = engineLike({ name: 'elevenlabs', model: 'eleven_multilingual_v2' });
  const text = 'Decklight decks are one HTML file.';

  // the bridge: style comes from the deck, which usually sends none
  const fromBridge = clipKey(eleven, { voice: 'Rachel', style: undefined, text });
  // the recorder: --style defaults to a paragraph nobody asked for, and this
  // model cannot act on it. A key that included it would miss every clip.
  const CLI_DEFAULT_STYLE = 'Read in a warm, welcoming tone, like a friendly '
    + 'battle-hardened senior engineer who is still curious about new technology.';
  const fromRecorder = clipKey(eleven, { voice: 'Rachel', style: CLI_DEFAULT_STYLE, text });

  assert.equal(fromRecorder, fromBridge,
    'a style the engine cannot read split the key — the batch recording re-bills');
});

test('on an engine that CAN act on a style, the style is part of the sound', () => {
  // The mirror of the test above, and the reason the rule is `stylable` rather
  // than "drop style always": gemini reads the instruction, so two styles are
  // two performances and must not share a clip.
  const gemini = engineLike({ name: 'gemini', model: 'gemini-2.5-pro-tts', stylable: true });
  const text = 'One line.';
  assert.notEqual(
    clipKey(gemini, { voice: 'Alnilam', style: 'excited', text }),
    clipKey(gemini, { voice: 'Alnilam', style: 'sombre', text }),
  );
});

test('a native engine keys on the voice that SPEAKS, not the one it booted with', () => {
  // THE BUG, and it defeated the whole feature: `model` on say/sapi is the
  // boot default, while createNative honours a different voice per sentence.
  // A bridge started bare and a recorder started `--voice Samantha` hashed the
  // same Samantha sentence two ways, so the batch recording hit nothing.
  const booted = (dflt) =>
    ({ name: 'say', model: dflt, modelIsDefaultVoice: true, synth: Object.assign(() => {}, {}) });
  assert.equal(
    clipKey(booted('Alex'), { voice: 'Samantha', text: 'Hi.' }),
    clipKey(booted('Samantha'), { voice: 'Samantha', text: 'Hi.' }),
    'the boot voice leaked into the key',
  );
  // and with no voice asked for, the boot default IS the voice
  assert.equal(
    clipKey(booted('Alex'), { text: 'Hi.' }),
    clipKey(booted('Alex'), { voice: 'Alex', text: 'Hi.' }),
  );
  assert.notEqual(clipKey(booted('Alex'), { text: 'Hi.' }), clipKey(booted('Samantha'), { text: 'Hi.' }));
});

test('piper keys on its loaded model and ignores the asked-for voice', () => {
  // The opposite mistake: piper's synth takes only text, so a per-sentence
  // voice changes nothing about the sound. Keying on the request would let two
  // runs under DIFFERENT --voice models share one key and serve the wrong one.
  const loaded = (m) =>
    ({ name: 'piper', model: m, voiceIsFixed: true, synth: Object.assign(() => {}, {}) });
  assert.equal(
    clipKey(loaded('en_US-ryan-high'), { voice: 'anything', text: 'Hi.' }),
    clipKey(loaded('en_US-ryan-high'), { text: 'Hi.' }),
  );
  assert.notEqual(
    clipKey(loaded('en_US-ryan-high'), { text: 'Hi.' }),
    clipKey(loaded('en_GB-alan-low'), { text: 'Hi.' }),
    'two piper models collided on one key',
  );
});

test('the format reaches the key through the engine, not through the caller', () => {
  // --tts-format mp3 is different bytes for the same words; deriving it from
  // the engine is what stops one caller remembering to pass it and the other
  // forgetting.
  const wav = engineLike({ name: 'elevenlabs', model: 'eleven_v3' });
  const mp3 = engineLike({ name: 'elevenlabs', model: 'eleven_v3', mime: 'audio/mpeg' });
  assert.notEqual(clipKey(wav, { text: 'x' }), clipKey(mp3, { text: 'x' }));
});


// ── the recorder end to end: a clip the bridge paid for is not paid for twice ─

test('voiceover reuses the bridge\'s clip, and re-synthesizes under --no-cache', async (t) => {
  if (process.platform !== 'darwin') { t.skip('needs say; the engine is irrelevant to the key'); return; }
  if (!haveFfmpeg()) { t.skip('needs ffmpeg to write the .m4a'); return; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-x-'));
  t.after(() => rmTemp(home));
  const env = { XDG_CACHE_HOME: path.join(home, 'cache') };
  const deck = path.join(home, 'deck.html');
  const NOTE = 'A sentence said once.';
  fs.writeFileSync(deck, `<!doctype html><div class="decklight">`
    + `<section><h1>One</h1><aside class="notes">${NOTE}</aside></section></div>`);

  // the BROWSER's half: one sentence through the live bridge
  const a = await startBridge(t, env);
  const live = await fetch(`http://127.0.0.1:${a.port}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: NOTE, voice: 'Samantha' }),
  });
  assert.equal(live.status, 200);
  const spoken = Buffer.from(await live.arrayBuffer());
  a.child.kill('SIGTERM');
  await new Promise((ok) => a.child.on('exit', ok));

  const record = (out, extra = []) => {
    const r = spawnSync(process.execPath, [
      CLI, 'voiceover', deck, '--engine', 'say', '--voice', 'Samantha',
      '--no-llm', '--keep-wav', '-o', out, ...extra,
    ], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, `voiceover failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };

  // THE FEATURE: a different process, a folder with no manifest in it, and the
  // sentence still costs nothing — because the key is the words, not the folder
  const out = path.join(home, 'take-1');
  assert.match(record(out), /cached/, 'the recorder re-synthesized what the bridge had already said');
  assert.deepEqual(fs.readFileSync(path.join(out, 'slide-01.wav')), spoken,
    'the reused clip is not the clip the bridge returned');
  assert.equal(fs.readdirSync(path.join(home, 'cache', 'decklight', 'tts')).length, 1,
    'the recorder filed a second copy under a different name');

  // --no-cache is the way to a genuinely fresh take
  const fresh = record(path.join(home, 'take-2'), ['--no-cache']);
  assert.equal(/cached/.test(fresh), false, '--no-cache still answered from the cache');
});

test('a folder recorded before the key gained `model` is not re-synthesized', async (t) => {
  if (process.platform !== 'darwin') { t.skip('needs say'); return; }
  if (!haveFfmpeg()) { t.skip('needs ffmpeg'); return; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mig-'));
  t.after(() => rmTemp(home));
  const env = { XDG_CACHE_HOME: path.join(home, 'cache') };
  const deck = path.join(home, 'deck.html');
  const NOTE = 'Recorded last week.';
  fs.writeFileSync(deck, `<!doctype html><div class="decklight">`
    + `<section><h1>One</h1><aside class="notes">${NOTE}</aside></section></div>`);
  const out = path.join(home, 'voiceover');
  const run = () => {
    const r = spawnSync(process.execPath, [
      CLI, 'voiceover', deck, '--engine', 'say', '--voice', 'Samantha', '--no-llm', '-o', out,
    ], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  run();

  // age the folder back to the old world: the old hash formula, and no `model`
  const CLI_STYLE = 'Read in a warm, welcoming tone, like a friendly '
    + 'battle-hardened senior engineer who is still curious about new technology.';
  const mPath = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  delete m.model;
  m.slides[0].hash = createHash('sha256')
    .update(`say|Samantha|${CLI_STYLE}|${NOTE}`).digest('hex').slice(0, 16);
  fs.writeFileSync(mPath, JSON.stringify(m, null, 1));
  // and empty the clip cache, so ONLY the manifest can save the audio
  rmTemp(path.join(home, 'cache'));

  assert.match(run(), /unchanged/, 'upgrading re-synthesized a folder that was already correct');
  // re-stamped, so the allowance is spent — a later model change is a real miss
  const after = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  assert.notEqual(after.model, undefined, 'the manifest was not re-stamped');
});
