// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The built-in mouth (src/core/mouth.js): a timeline in the sidecar's shape,
// at rest where there is no voice, and its shapes from what the sound is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mouthTimeline, shapeOf, wavSamples } from '../tools/mouth.mjs';

const SR = 16000;
/** A vowel-like buzz: harmonics of 140 Hz shaped by two resonances. */
function vowel(seconds, f1, f2, amp = 0.3) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let h = 1; h * 140 < 4000; h++) {
    const f = h * 140;
    const gain = 1 / (1 + ((f - f1) / 90) ** 2) + 0.7 / (1 + ((f - f2) / 120) ** 2);
    for (let i = 0; i < out.length; i++) out[i] += amp * gain * Math.sin(2 * Math.PI * f * i / SR) / 4;
  }
  return out;
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const silence = (s) => new Float32Array(Math.round(s * SR));

test('silence is a mouth at rest, start to end, in the sidecar shape', () => {
  const tl = mouthTimeline(silence(1), SR);
  assert.equal(tl.v, 1);
  assert.equal(tl.kind, 'visemes');
  assert.equal(tl.duration, 1);
  assert.deepEqual(tl.cues.map((c) => c.v), ['X']);
});

test('a voice between silences opens the mouth and rests it again', () => {
  const tl = mouthTimeline(join(silence(0.3), vowel(0.4, 800, 1300), vowel(0.4, 300, 2400), vowel(0.4, 350, 900), silence(0.3)), SR);
  assert.equal(tl.cues[0].v, 'X');
  assert.equal(tl.cues.at(-1).v, 'X');
  const said = tl.cues.map((c) => c.v).join('');
  assert.match(said, /[CD]/, `an open vowel opens the mouth: ${said}`);
  for (const [a, b] of tl.cues.slice(1).map((c, i) => [tl.cues[i], c])) assert.ok(b.t > a.t, 'cues in time order');
});

test('the rules: hiss shows teeth, a quiet hum closes the lips, formants shape the vowel', () => {
  assert.equal(shapeOf({ rel: -40, hiss: 0, open: 0.5, front: 0.5 }), 'X');
  assert.equal(shapeOf({ rel: -10, hiss: 0.6, open: null, front: null }), 'B');
  assert.equal(shapeOf({ rel: -25, hiss: 0, open: 0.5, front: 0.5 }), 'A');
  assert.equal(shapeOf({ rel: -2, hiss: 0, open: 0.9, front: 0.3 }), 'D');
  assert.equal(shapeOf({ rel: -2, hiss: 0, open: 0.1, front: 0.9 }), 'B');
  assert.equal(shapeOf({ rel: -2, hiss: 0, open: 0.1, front: 0.1 }), 'F');
  assert.equal(shapeOf({ rel: -2, hiss: 0, open: 0.5, front: 0.1 }), 'E');
});

test('a voice decoded at 48 kHz reads as it does at 16 kHz: the reader works at 16 kHz either way', async () => {
  const { at16k } = await import('../tools/mouth.mjs');
  const at48 = (s16) => Float32Array.from({ length: s16.length * 3 }, (_, i) => s16[Math.floor(i / 3)]);
  const voice = join(silence(0.3), vowel(0.5, 800, 1300), vowel(0.5, 300, 2400), silence(0.3));
  const a = mouthTimeline(voice, SR), b = mouthTimeline(at48(voice), 48000);
  assert.equal(b.duration, a.duration);
  assert.deepEqual(b.cues.map((c) => c.v), a.cues.map((c) => c.v));
  assert.equal(at16k(new Float32Array(480), 48000).samples.length, 160);
});

/** `samples` as a WAV file: `format` 1 (integer PCM) or 3 (float), every channel the same. */
function toWav(samples, { bits = 16, channels = 1, format = 1, rate = SR, list = false } = {}) {
  const width = bits / 8, size = samples.length * width * channels, extra = list ? 12 : 0;
  const d = new DataView(new ArrayBuffer(44 + extra + size));
  const str = (at, t) => [...t].forEach((c, k) => d.setUint8(at + k, c.charCodeAt(0)));
  str(0, 'RIFF'); d.setUint32(4, 36 + extra + size, true); str(8, 'WAVE');
  str(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, format, true); d.setUint16(22, channels, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * width * channels, true); d.setUint16(32, width * channels, true); d.setUint16(34, bits, true);
  let at = 36;
  if (list) { str(at, 'LIST'); d.setUint32(at + 4, 4, true); str(at + 8, 'INFO'); at += 12; }
  str(at, 'data'); d.setUint32(at + 4, size, true); at += 8;
  for (const v of samples) for (let c = 0; c < channels; c++, at += width) {
    if (format === 3) d.setFloat32(at, v, true);
    else if (bits === 16) d.setInt16(at, Math.round(v * 32767), true);
    else if (bits === 24) { const n = Math.round(v * 8388607); d.setUint8(at, n & 255); d.setUint8(at + 1, (n >> 8) & 255); d.setInt8(at + 2, n >> 16); }
  }
  return new Uint8Array(d.buffer);
}

test('a WAV is read without a decoder: 16- and 24-bit, float, stereo, a chunk before the audio', () => {
  const voice = join(silence(0.2), vowel(0.4, 800, 1300), silence(0.2));
  const direct = mouthTimeline(voice, SR).cues.map((c) => c.v).join('');
  for (const opts of [{}, { bits: 24, channels: 2 }, { bits: 32, format: 3 }, { list: true }]) {
    const pcm = wavSamples(toWav(voice, opts));
    assert.equal(pcm.sampleRate, SR, JSON.stringify(opts));
    assert.equal(pcm.samples.length, voice.length, JSON.stringify(opts));
    assert.equal(mouthTimeline(pcm.samples, pcm.sampleRate).cues.map((c) => c.v).join(''), direct, JSON.stringify(opts));
  }
  // anything else is left to a decoder
  assert.equal(wavSamples(new TextEncoder().encode('ID3 an mp3, not a wav')), null);
  assert.equal(wavSamples(toWav(voice, { bits: 16, format: 2 })), null);   // ADPCM
});
