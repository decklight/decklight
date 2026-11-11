// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A take whose length does not fit its text is sampled once more, and an
// already-recorded track can be audited for one after the fact (#1005).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { judgeTake, expectedSeconds, checkedSynth, takeLine, auditTrack, PACE } from '../tools/take-check.mjs';
import { wavFromPcm } from '../tools/gemini-tts.mjs';

const RATE = 24000;
const wavOf = (seconds) => wavFromPcm(Buffer.alloc(Math.round(seconds * RATE) * 2), RATE);

test('the stutter from the ticket is outside the band, the clean take inside', () => {
  const said = 'You ask, it answers.';
  assert.equal(judgeTake('elevenlabs', said, 3.28).ok, false, '"You ask, you ask, it answers"');
  assert.equal(judgeTake('elevenlabs', said, 2.16).ok, true, 'the same sentence, said once');
  assert.equal(judgeTake('elevenlabs', said, 0.4).ok, false, 'a dropped phrase is outside too');
});

test('a one-word sentence has room for its breath, and a tag has room for its beat', () => {
  assert.equal(judgeTake('elevenlabs', 'Yes.', 0.9).ok, true, 'twice four characters is no time at all');
  const long = 'This one runs a little longer than the others do.';
  const at = expectedSeconds('elevenlabs', long);
  assert.equal(expectedSeconds('elevenlabs', `[sighs] ${long}`), at, 'a tag is not speech');
  assert.equal(judgeTake('elevenlabs', long, at * 2 + 0.8).ok, false);
  assert.equal(judgeTake('elevenlabs', `[sighs] ${long}`, at * 2 + 0.8).ok, true);
});

test('an engine that says a sentence the same way every time is not judged', () => {
  for (const e of ['piper', 'chirp', 'say']) {
    assert.equal(PACE[e], undefined);
    assert.equal(judgeTake(e, 'You ask, it answers.', 9), null);
  }
});

/** An engine that answers with these takes, one per call. */
const engineOf = (takes, name = 'elevenlabs') => {
  const calls = [];
  return {
    name,
    calls,
    synth: async (text, opts) => {
      calls.push({ text, opts });
      return { wav: wavOf(takes[calls.length - 1]), usage: { chars: text.length, cost: 0.01 } };
    },
  };
};

test('a take that fits is the take: one request', async () => {
  const e = engineOf([2.16]);
  const out = await checkedSynth(e, 'You ask, it answers.', { voice: 'Gilles' });
  assert.equal(e.calls.length, 1);
  assert.equal(out.take, undefined);
});

test('a take outside the band is sampled again, and the retry is what is kept and billed', async () => {
  const e = engineOf([3.28, 2.16]);
  const out = await checkedSynth(e, 'You ask, it answers.', { voice: 'Gilles', style: 'warmly' });
  assert.equal(e.calls.length, 2);
  assert.deepEqual(e.calls[1].opts, { voice: 'Gilles', style: 'warmly' }, 'asked the same way twice');
  assert.equal(out.wav.length, wavOf(2.16).length);
  assert.equal(out.take.fits, true);
  assert.deepEqual(out.take.seconds.map((n) => Number(n.toFixed(2))), [3.28, 2.16]);
  assert.equal(out.usage.chars, 40, 'both requests were billed');
  assert.equal(out.usage.cost, 0.02);
  assert.match(takeLine('You ask, it answers.', out.take), /ran 3\.28 s .*the retry ran 2\.16 s and is kept/);
});

test('when the retry is outside too, the take nearer the text\'s pace is kept and said', async () => {
  const e = engineOf([3.6, 3.1]);
  const out = await checkedSynth(e, 'You ask, it answers.');
  assert.equal(e.calls.length, 2, 'once more, not until it fits');
  assert.equal(out.wav.length, wavOf(3.1).length, 'the shorter of two long takes');
  assert.equal(out.take.fits, false);
  assert.match(takeLine('You ask, it answers.', out.take), /also outside — kept the nearer, worth a listen/);
});

test('a deterministic engine is never asked twice', async () => {
  const e = engineOf([9, 2], 'piper');
  const out = await checkedSynth(e, 'You ask, it answers.');
  assert.equal(e.calls.length, 1);
  assert.equal(out.take, undefined);
});

test('an mp3 take has no header length to judge, and is kept as it came', async () => {
  const e = { name: 'elevenlabs', calls: 0, synth: async () => { e.calls++; return { wav: Buffer.from('ID3not-a-wav'), usage: {} }; } };
  await checkedSynth(e, 'You ask, it answers.');
  assert.equal(e.calls, 1);
});

test('a recorded track is audited clip by clip, a beat-cut slide by its beats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-take-'));
  try {
    const put = (stem, text, seconds) => {
      writeFileSync(join(dir, `${stem}.wav`), wavOf(seconds));
      writeFileSync(join(dir, `${stem}.txt`), text);
    };
    put('slide-01', 'You ask, it answers.', 2.1);
    put('slide-02', 'You ask, it answers.', 3.28);
    // slide 3 is cut into beats: its whole file is not judged again
    put('slide-03', 'Beat one is here. [click] Beat two is here.', 9);
    put('slide-03-01', 'Beat one is here.', 1.4);
    put('slide-03-02', 'Beat two is here.', 4.5);
    writeFileSync(join(dir, 'slide-04.wav'), wavOf(20));   // no script: not judged
    const odd = auditTrack(dir, 'elevenlabs');
    assert.deepEqual(odd.map((t) => t.file), ['slide-02.wav', 'slide-03-02.wav']);
    assert.ok(Math.abs(odd[0].seconds - 3.28) < 0.01);
    assert.deepEqual(auditTrack(dir, 'piper'), [], 'not an engine that samples');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
