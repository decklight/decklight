// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The ElevenLabs engine. Everything here is exercised against an injected
// fetch, so the whole engine — roster shaping, voice resolution, the WAV
// wrapping, the retry — is testable without a key, a network, or an account.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_ENV, DEFAULT_MODEL, V3_MODEL, STABILITY_PRESETS, FORMATS,
  apiKey, shapeVoices, pickVoice, synthError, createSynth, styleTag,
} from '../tools/elevenlabs-tts.mjs';
import { createEngine, ENGINES } from '../tools/tts-engines.mjs';
import { suggestEngine } from '../tools/tts-setup.mjs';
import { planServices } from '../cli/dev.mjs';

const VOICES = {
  voices: [
    { voice_id: 'p1', name: 'Rachel', category: 'premade', labels: { description: 'calm' } },
    { voice_id: 'c1', name: 'Gilles', category: 'cloned' },
    { voice_id: 'p2', name: 'Adam', category: 'premade', labels: { accent: 'american' } },
    { voice_id: 'pro1', name: 'Studio Read', category: 'professional' },
  ],
};

/** A fetch that answers the two endpoints from a script, and records calls. */
function fakeFetch({ voices = VOICES, audio = Buffer.from('pcmpcmpcm'), fail = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/voices')) {
      return { ok: true, json: async () => voices };
    }
    if (fail) {
      const { status, body } = fail;
      fail = fail.once ? null : fail;
      return { ok: false, status, text: async () => body };
    }
    return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) };
  };
  f.calls = calls;
  return f;
}

// ── the roster: yours first ────────────────────────────────────────────────

test('the account roster puts YOUR voices above the stock ones', () => {
  const shaped = shapeVoices(VOICES);
  assert.deepEqual(shaped.map((v) => v.name), ['Gilles', 'Studio Read', 'Rachel', 'Adam'],
    'cloned, then professional, then premade — the reason to pick this engine goes first');
  assert.equal(shaped[0].flavor, 'cloned', 'and it says so, so it is findable at a glance');
});

test('a premade voice borrows its flavor from the labels, never the bare category', () => {
  const byName = Object.fromEntries(shapeVoices(VOICES).map((v) => [v.name, v.flavor]));
  assert.equal(byName.Rachel, 'calm');
  assert.equal(byName.Adam, 'american', 'no description — the accent is the next best word');
});

test('voices without an id are dropped, and an empty answer is empty, not a crash', () => {
  assert.deepEqual(shapeVoices({ voices: [{ name: 'ghost' }] }), []);
  assert.deepEqual(shapeVoices({}), []);
  assert.deepEqual(shapeVoices(null), []);
});

test('a nameless voice falls back to its id rather than rendering as blank', () => {
  assert.equal(shapeVoices({ voices: [{ voice_id: 'x9' }] })[0].name, 'x9');
});

// ── picking one ────────────────────────────────────────────────────────────

test('the player sends a name; an id pasted from the dashboard works too', () => {
  const r = shapeVoices(VOICES);
  assert.equal(pickVoice(r, 'Gilles').id, 'c1');
  assert.equal(pickVoice(r, 'gilles').id, 'c1', 'case came from a text field');
  assert.equal(pickVoice(r, ' Studio  Read ').id, 'pro1', 'and so did the spacing');
  assert.equal(pickVoice(r, 'p2').id, 'p2', 'a raw voice_id needs no lookup');
});

test('no voice asked for means the first one — which is yours', () => {
  assert.equal(pickVoice(shapeVoices(VOICES), undefined).name, 'Gilles');
  assert.equal(pickVoice([], 'Gilles'), null);
  assert.equal(pickVoice(shapeVoices(VOICES), 'Nobody'), null);
});

// ── errors that name the way out ───────────────────────────────────────────

test('a rejected key names the environment variable to fix', () => {
  assert.match(synthError(401, 'unauthorized'), new RegExp(`\\$${KEY_ENV}`));
  assert.match(synthError(403, 'forbidden'), new RegExp(`\\$${KEY_ENV}`));
});

test('PCM refused by the plan is translated — nobody would guess what it means', () => {
  const msg = synthError(422, '{"detail":"output_format pcm_24000 requires a paid subscription"}');
  assert.match(msg, /--tts-format mp3/);
  assert.match(msg, /⇧V offline recording and the lip-sync bridge/, 'and what mp3 costs you');
  // the same body under mp3 is not that error, so it must not claim to be
  assert.doesNotMatch(synthError(422, 'output_format bad', { format: 'mp3' }), /--tts-format mp3/);
});

test('a rate limit says what is bursty about narration', () => {
  assert.match(synthError(429, ''), /429/);
  assert.match(synthError(429, ''), /lookahead/);
});

// ── the synth ──────────────────────────────────────────────────────────────

test('a key is required, and the message says where to make one', () => {
  assert.throws(() => createSynth({ key: null }), new RegExp(`\\$${KEY_ENV}`));
  assert.throws(() => createSynth({ key: null }), /elevenlabs\.io/);
});

test('an unknown format is refused up front, not at the first sentence', () => {
  assert.throws(() => createSynth({ key: 'k', format: 'flac' }), /use pcm or mp3/);
  assert.deepEqual(FORMATS, ['pcm', 'mp3']);
});

test('pcm comes back as a real WAV — a header the ⇧V stitcher can read', async () => {
  const fetchImpl = fakeFetch({ audio: Buffer.alloc(100, 7) });
  const { synth } = createSynth({ key: 'k', fetchImpl });
  const { wav, usage } = await synth('hello', { voice: 'Gilles' });

  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(4) + 8, wav.length, 'the declared length is the real one');
  assert.equal(wav.readUInt32LE(24), 24000, '24 kHz, matching the other engines');
  assert.equal(wav.length, 144, '44-byte header + 100 bytes of samples');
  assert.equal(usage.chars, 5);
  assert.equal(usage.cost, 0, 'no invented dollar figure — the plan rate is not visible');
  assert.match(usage.note, /5 chars · Gilles/);
});

test('mp3 is passed through untouched — it is already a container', async () => {
  const fetchImpl = fakeFetch({ audio: Buffer.from('ID3mp3body') });
  const { synth } = createSynth({ key: 'k', format: 'mp3', fetchImpl });
  const { wav } = await synth('hello', {});
  assert.equal(wav.toString(), 'ID3mp3body');
  assert.equal(synth.mimeType, 'audio/mpeg', 'so the bridge does not label mp3 as audio/wav');
});

// ── v3 audio tags — style as a short bracketed cue, v3 only ────────────────

test('styleTag wraps plain text, keeps a well-formed cue verbatim, and drops a second one', () => {
  assert.equal(styleTag('excited'), '[excited]', 'someone who does not know v3 syntax still gets a cue');
  assert.equal(styleTag('[whispers]'), '[whispers]', 'someone who already knows it gets exactly that');
  assert.equal(styleTag('[whispers] [also excited]'), '[whispers]', 'only the first cue — a second is not invited');
  assert.equal(styleTag(''), '', 'nothing to say is not a tag');
  assert.equal(styleTag(null), '');
  assert.equal(styleTag('   '), '', 'whitespace is nothing, not a cue');
});

test('a persona too long to be a cue is cut back, not spoken', () => {
  const long = 'a'.repeat(80);
  const tag = styleTag(long, 10);
  assert.equal(tag, `[${'a'.repeat(10)}]`);
});

test('a tag is prepended to the text and billed as part of what was sent — v3 only', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'k', model: V3_MODEL, fetchImpl });
  const { usage } = await synth('Hello there.', { voice: 'Gilles', style: 'excited' });

  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).text, '[excited] Hello there.');
  assert.equal(usage.chars, '[excited] Hello there.'.length, 'billed on what actually went out');
  assert.match(usage.note, /\[excited\]/, 'the per-sentence line shows the cue it sent');
});

test('a style is never sent to a non-v3 model — the brackets would just be read aloud', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'k', fetchImpl }); // DEFAULT_MODEL, not v3
  const { usage } = await synth('Hello there.', { voice: 'Gilles', style: 'excited' });

  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).text, 'Hello there.', 'unchanged — no tag riding along');
  assert.equal(usage.chars, 'Hello there.'.length);
  assert.doesNotMatch(usage.note, /\[/, 'nothing bracketed in the report either');
});

test('no style at all sends the sentence untouched, even on v3', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'k', model: V3_MODEL, fetchImpl });
  await synth('Hello there.', { voice: 'Gilles' });
  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).text, 'Hello there.');
});

// ── v3 stability presets — a v3-only knob, refused elsewhere ───────────────

test('a stability preset maps to its documented number and rides in voice_settings', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'k', model: V3_MODEL, stability: 'creative', fetchImpl });
  await synth('hi', { voice: 'Gilles' });
  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).voice_settings.stability, STABILITY_PRESETS.creative);
  assert.equal(STABILITY_PRESETS.creative, 0);
  assert.equal(STABILITY_PRESETS.natural, 0.5);
  assert.equal(STABILITY_PRESETS.robust, 1);
});

test('unasked, no voice_settings is sent at all — the account setting is left alone', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'k', model: V3_MODEL, fetchImpl });
  await synth('hi', { voice: 'Gilles' });
  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.equal(JSON.parse(post.init.body).voice_settings, undefined);
});

test('a stability preset asked of a model with no such slider is refused up front', () => {
  assert.throws(
    () => createSynth({ key: 'k', model: DEFAULT_MODEL, stability: 'creative' }),
    /--tts-stability is a v3 feature/,
  );
});

test('an unknown stability name is refused, not silently rounded to the nearest preset', () => {
  assert.throws(
    () => createSynth({ key: 'k', model: V3_MODEL, stability: 'chill' }),
    /unknown --tts-stability 'chill'/,
  );
});

test('the request carries the key, the model and the resolved voice id', async () => {
  const fetchImpl = fakeFetch();
  const { synth } = createSynth({ key: 'sk-abc', fetchImpl });
  await synth('hi', { voice: 'Gilles' });

  const post = fetchImpl.calls.find((c) => c.init.method === 'POST');
  assert.match(post.url, /\/text-to-speech\/c1\?/, 'the NAME resolved to the id');
  assert.match(post.url, /output_format=pcm_24000/);
  assert.equal(post.init.headers['xi-api-key'], 'sk-abc');
  assert.equal(JSON.parse(post.init.body).model_id, DEFAULT_MODEL);
});

test('the roster is fetched once and shared by every synth', async () => {
  const fetchImpl = fakeFetch();
  const { synth, listVoices } = createSynth({ key: 'k', fetchImpl });
  await Promise.all([synth('a', {}), synth('b', {}), listVoices()]);
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/voices')).length, 1);
});

test('a voice this key cannot speak is refused by name, listing the ones it can', async () => {
  const { synth } = createSynth({ key: 'k', fetchImpl: fakeFetch() });
  await assert.rejects(synth('hi', { voice: 'Alnilam' }), /no ElevenLabs voice named "Alnilam"/);
  await assert.rejects(synth('hi', { voice: 'Alnilam' }), /Gilles/);
});

test('a 429 is retried; a 4xx that retrying cannot fix is not', async () => {
  const transient = fakeFetch({ fail: { status: 429, body: 'slow down', once: true } });
  const { synth } = createSynth({ key: 'k', fetchImpl: transient });
  const { wav } = await synth('hi', {});
  assert.ok(wav.length > 44, 'the retry got audio');

  const permanent = fakeFetch({ fail: { status: 401, body: 'bad key' } });
  const bad = createSynth({ key: 'k', fetchImpl: permanent });
  await assert.rejects(bad.synth('hi', {}), new RegExp(`\\$${KEY_ENV}`));
  assert.equal(permanent.calls.filter((c) => c.init.method === 'POST').length, 1, 'not retried');
});

// ── how the rest of decklight sees it ──────────────────────────────────────

test('createEngine hands back the shape every engine has', () => {
  assert.ok(ENGINES.includes('elevenlabs'));
  const e = createEngine({ engine: 'elevenlabs', env: { [KEY_ENV]: 'k' } });
  assert.equal(e.name, 'elevenlabs');
  assert.equal(e.model, DEFAULT_MODEL);
  assert.equal(e.needsProject, false, 'no GCP project — a key is the whole prerequisite');
  assert.equal(e.stylable, false, 'no delivery-instruction channel, so the picker skips tones');
  assert.equal(e.caveat, undefined, 'nothing to warn about on a model with no style channel');
  assert.deepEqual(e.voices, [], 'the roster belongs to the account, so it is fetched');
  assert.equal(typeof e.listVoices, 'function');
});

test('eleven_v3 alone reports stylable — the tone step follows the model, not the engine name', () => {
  const v3 = createEngine({ engine: 'elevenlabs', model: V3_MODEL, env: { [KEY_ENV]: 'k' } });
  assert.equal(v3.stylable, true);
  assert.match(v3.caveat, /eleven_v3/, 'the trade-offs are named, ready for the startup line');
  assert.match(v3.caveat, /250 characters/);

  const v2 = createEngine({ engine: 'elevenlabs', model: DEFAULT_MODEL, env: { [KEY_ENV]: 'k' } });
  assert.equal(v2.stylable, false);
  assert.equal(v2.caveat, undefined);
});

test('the key is read from the environment, and only from there', () => {
  assert.equal(apiKey({ [KEY_ENV]: '  sk-x  ' }), 'sk-x');
  assert.equal(apiKey({}), null);
  assert.equal(apiKey({ [KEY_ENV]: '   ' }), null, 'an empty export is not a key');
  assert.throws(() => createEngine({ engine: 'elevenlabs', env: {} }), new RegExp(`\\$${KEY_ENV}`));
});

test('a key in the environment is the strongest hint about which engine to suggest', () => {
  const hasPiper = () => true;
  assert.equal(suggestEngine({ hasBin: hasPiper, env: { [KEY_ENV]: 'k' }, project: 'p' }), 'elevenlabs');
  assert.equal(suggestEngine({ hasBin: hasPiper, env: {} }), 'piper', 'unchanged without one');
});

test('dev starts the bridge only when the key is there, and says where to get one', () => {
  const plan = (env) => planServices({ args: ['deck.html', '--tts-engine', 'elevenlabs'], env, hasBin: () => false });

  const without = plan({});
  assert.equal(without.run.find((s) => s.name === 'tts'), undefined);
  const why = without.skip.find((s) => s.name === 'voice').why;
  assert.match(why, new RegExp(`\\$${KEY_ENV}`));
  assert.match(why, /elevenlabs\.io/);

  const with_ = plan({ [KEY_ENV]: 'sk-x' });
  const tts = with_.run.find((s) => s.name === 'tts');
  assert.deepEqual(tts.args, ['tts', '--port', '8787', '--engine', 'elevenlabs'],
    'no --project: this engine has none, and passing an empty one would be a lie');
});

test('--tts-format rides along to the bridge', () => {
  const p = planServices({
    args: ['deck.html', '--tts-engine', 'elevenlabs', '--tts-format', 'mp3'],
    env: { [KEY_ENV]: 'k' },
    hasBin: () => false,
  });
  assert.ok(p.run.find((s) => s.name === 'tts').args.join(' ').includes('--tts-format mp3'));
  assert.equal(p.deck, 'deck.html', 'and the deck is still found past it');
});

test('--tts-model and --tts-stability both ride along, and the deck is still found past them', () => {
  const p = planServices({
    args: ['deck.html', '--tts-engine', 'elevenlabs', '--tts-model', V3_MODEL, '--tts-stability', 'natural'],
    env: { [KEY_ENV]: 'k' },
    hasBin: () => false,
  });
  const argv = p.run.find((s) => s.name === 'tts').args.join(' ');
  assert.ok(argv.includes(`--tts-model ${V3_MODEL}`));
  assert.ok(argv.includes('--tts-stability natural'));
  assert.equal(p.deck, 'deck.html');
});
