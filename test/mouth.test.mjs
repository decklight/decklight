// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The built-in mouth (src/core/mouth.js): a timeline in the sidecar's shape,
// at rest where there is no voice, and its shapes from what the sound is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mouthTimeline, shapeOf } from '../src/core/mouth.js';

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
