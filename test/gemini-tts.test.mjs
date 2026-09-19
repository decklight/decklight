// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The pure half of the Gemini TTS engine (SPEC PRESENTING, SPEC ENGINE_UNITS).
//
// Everything around it needs ADC, a project and the network, so none of it had
// a test — but four decisions inside it are plain functions, and each one fails
// quietly rather than loudly. A project id that is not validated is
// interpolated straight into a request path, where a stray character comes back
// as a 403 about a project that "doesn't exist" and a slash rewrites the URL
// outright. A WAV header with the wrong byte rate still plays, at the wrong
// speed, after the whole deck has been synthesised. A steering style that is
// not normalised into one directive clause gets READ ALOUD in the voiceover.
//
// The module is side-effect free at import — its only import is tools/exec.mjs,
// which declares constants and functions and nothing else — so pulling these in
// starts no child process and opens no socket. Only the pure exports are
// imported here; createSynth is deliberately left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_VOICES, authHeaders, styledPrompt, validProjectId, wavFromPcm, SLOW_DIRECTION,
} from '../tools/gemini-tts.mjs';

// ── validProjectId ─────────────────────────────────────────────────────────

test('a missing project id is invalid rather than a crash', () => {
  // The caller reaches here before it has anything, so nullish has to be an
  // answer — `id ?? ''` exists so .test() never sees undefined.
  for (const nothing of ['', undefined, null]) {
    assert.equal(validProjectId(nothing), false, `${JSON.stringify(nothing)} is not a project id`);
  }
});

test('a project id shorter than six characters is invalid', () => {
  // GCP's own floor. Below it the id is not short, it is wrong.
  assert.equal(validProjectId('abcde'), false, 'five characters is under the minimum');
  assert.equal(validProjectId('abcdef'), true, 'six is the first length GCP accepts');
});

test('an uppercase letter anywhere makes a project id invalid', () => {
  // Project ids are lowercase; a copy-paste from a console title bar is not.
  assert.equal(validProjectId('MyProject'), false, 'a capitalised id is not the id');
  assert.equal(validProjectId('my-Project'), false, 'a capital in the middle counts too');
  assert.equal(validProjectId('myproject'), true, 'the lowercase form is fine');
});

test('a trailing hyphen makes a project id invalid', () => {
  assert.equal(validProjectId('my-project-'), false, 'GCP forbids it and Vertex answers with a 403');
  assert.equal(validProjectId('my-project'), true, 'an interior hyphen is allowed');
  assert.equal(validProjectId('-my-project'), false, 'an id starts with a letter, never a hyphen');
  assert.equal(validProjectId('1my-project'), false, 'nor with a digit');
});

test('the longest legal project id is thirty characters', () => {
  const thirty = `a${'b'.repeat(28)}c`;
  assert.equal(thirty.length, 30, 'the fixture is really thirty characters');
  assert.equal(validProjectId(thirty), true, 'thirty is the documented ceiling, not one past it');
  assert.equal(validProjectId(`${thirty}d`), false, 'thirty-one is over');
});

test('punctuation that would rewrite the request URL is rejected', () => {
  // This is the reason the check exists at all: `project` goes into the path.
  for (const bad of ['my/project', 'my project', 'my.project', 'my_project', 'my:project']) {
    assert.equal(validProjectId(bad), false, `${bad} must never reach the Vertex URL`);
  }
});

// ── wavFromPcm ─────────────────────────────────────────────────────────────

// The header fields, by offset, as the RIFF/WAVE spec lays them out.
const riffSize = (w) => w.readUInt32LE(4);
const fmtSize = (w) => w.readUInt32LE(16);
const audioFormat = (w) => w.readUInt16LE(20);
const channels = (w) => w.readUInt16LE(22);
const sampleRate = (w) => w.readUInt32LE(24);
const byteRate = (w) => w.readUInt32LE(28);
const blockAlign = (w) => w.readUInt16LE(32);
const bitsPerSample = (w) => w.readUInt16LE(34);
const dataSize = (w) => w.readUInt32LE(40);

test('an empty pcm buffer still yields a complete 44-byte header', () => {
  // A zero-length synth result is the degenerate case, and a header that
  // shrinks with it is unreadable rather than silent.
  const w = wavFromPcm(Buffer.alloc(0), 24000);
  assert.equal(w.length, 44, 'the canonical RIFF/WAVE header is 44 bytes');
  assert.equal(w.subarray(0, 4).toString('latin1'), 'RIFF', 'chunk id');
  assert.equal(w.subarray(8, 12).toString('latin1'), 'WAVE', 'format');
  assert.equal(w.subarray(12, 16).toString('latin1'), 'fmt ', 'the trailing space is part of the id');
  assert.equal(w.subarray(36, 40).toString('latin1'), 'data', 'data chunk id');
  assert.equal(riffSize(w), 36, 'RIFF size counts everything after itself: 44 - 8 with no payload');
  assert.equal(dataSize(w), 0, 'no samples');
});

test('the format chunk describes 16-bit mono at the rate it was given', () => {
  // 24 kHz is Gemini's audio/L16; ElevenLabs' pcm_24000 lands here too, and
  // getting the rate from the mime type rather than a constant is why it is a
  // parameter. A wrong byte rate plays the whole deck at the wrong speed.
  const w = wavFromPcm(Buffer.alloc(0), 24000);
  assert.equal(fmtSize(w), 16, 'a PCM fmt chunk is 16 bytes');
  assert.equal(audioFormat(w), 1, '1 is uncompressed PCM');
  assert.equal(channels(w), 1, 'mono');
  assert.equal(sampleRate(w), 24000, 'the rate the caller passed, verbatim');
  assert.equal(byteRate(w), 48000, 'rate * channels * bytesPerSample = 24000 * 1 * 2');
  assert.equal(blockAlign(w), 2, 'one 16-bit mono frame is 2 bytes');
  assert.equal(bitsPerSample(w), 16, '16-bit samples');
});

test('a different sample rate moves the rate and the byte rate together', () => {
  const w = wavFromPcm(Buffer.alloc(0), 16000);
  assert.equal(sampleRate(w), 16000, 'the rate is not hard-coded to 24000');
  assert.equal(byteRate(w), 32000, 'the byte rate is derived from it, not pinned alongside it');
});

test('the pcm payload is appended verbatim and both sizes shift by its length', () => {
  // The two size fields are what afconvert and <audio> trust; a payload that
  // is longer than data size says is simply cut off at playback.
  const pcm = Buffer.from([0x01, 0xff]);
  const w = wavFromPcm(pcm, 24000);
  assert.equal(w.length, 46, '44 header bytes plus 2 of pcm');
  assert.equal(riffSize(w), 38, '36 + payload length');
  assert.equal(dataSize(w), 2, 'the payload length exactly');
  assert.deepEqual(w.subarray(44), pcm, 'the samples are copied, not re-encoded');
  assert.equal(riffSize(w) - dataSize(w), 36, 'the two sizes always differ by the header remainder');
});

// ── styledPrompt ───────────────────────────────────────────────────────────

const TEXT = 'The second slide is about latency.';

test('no style at all leaves the text exactly as written', () => {
  // The overwhelmingly common case: nothing prepended, nothing to be read out.
  for (const nothing of ['', '   ', undefined, null]) {
    assert.equal(styledPrompt(nothing, TEXT), TEXT,
      `a ${JSON.stringify(nothing)} style must not add a directive to speak`);
  }
});

test('a one-sentence directive loses its trailing period and gains a colon', () => {
  // The documented shape is one clause ending in a colon, fused to the
  // content. "Say cheerfully.: text" would be read as punctuation.
  assert.equal(styledPrompt('Say cheerfully.', TEXT), `Say cheerfully: ${TEXT}`);
  assert.equal(styledPrompt('Say cheerfully', TEXT), `Say cheerfully: ${TEXT}`,
    'with or without the period, the same prompt comes out');
  assert.equal(styledPrompt('  Speak slowly!  ', TEXT), `Speak slowly: ${TEXT}`,
    'surrounding whitespace and any end punctuation are dropped');
});

test('two sentences fuse into one clause joined by a semicolon', () => {
  // A persona split across sentences is still steering, but a period mid-
  // prompt reads as the end of the instruction and the rest as content.
  assert.equal(
    styledPrompt('Read this slowly. Pause at commas.', TEXT),
    `Read this slowly; Pause at commas: ${TEXT}`,
    'the sentence break becomes "; " so the whole thing stays one directive',
  );
});

test('a style that is not phrased as a directive gets wrapped in one', () => {
  // "You're a friendly senior engineer…" is content-looking text, and content
  // -looking text can stochastically be spoken aloud. The wrapper is what
  // makes it unambiguously an instruction.
  assert.equal(
    styledPrompt('warm and calm', TEXT),
    `Say this in the following style — warm and calm: ${TEXT}`,
    'an adjective phrase is not a speech directive on its own',
  );
  assert.equal(
    styledPrompt("You're a friendly senior engineer. Keep it brisk.", TEXT),
    `Say this in the following style — You're a friendly senior engineer; Keep it brisk: ${TEXT}`,
    'wrapping and sentence-fusing compose, in that order',
  );
});

test('internal whitespace collapses so a multi-line style stays one clause', () => {
  assert.equal(styledPrompt('Say  it\n\tsoftly', TEXT), `Say it softly: ${TEXT}`,
    'a style typed across lines in a deck must not carry newlines into the prompt');
});

test('every documented directive verb is recognised without a wrapper', () => {
  for (const verb of ['read', 'Say', 'SPEAK', 'narrate', 'deliver', 'announce',
    'whisper', 'shout', 'recite', 'tell']) {
    const out = styledPrompt(`${verb} it warmly`, TEXT);
    assert.equal(out, `${verb} it warmly: ${TEXT}`,
      `"${verb}" already reads as an instruction, so double-wrapping it would be noise`);
  }
});

// ── authHeaders ────────────────────────────────────────────────────────────

test('vertex headers carry the bearer token and bill the caller\'s project', () => {
  // x-goog-user-project is what sends the bill and the quota to the project in
  // the URL rather than to whoever's gcloud happens to be signed in.
  assert.deepEqual(authHeaders('ya29.tok', 'my-project'), {
    authorization: 'Bearer ya29.tok',
    'content-type': 'application/json',
    'x-goog-user-project': 'my-project',
  }, 'three headers, lowercase names, and the token prefixed with "Bearer "');
});

// ── GEMINI_VOICES ──────────────────────────────────────────────────────────

test('the voice roster is thirty name/flavour pairs with no duplicates', () => {
  // The player ships the same list (engine.js GEMINI_VOICES); a name that
  // exists in one and not the other is a synth call that 400s at present time.
  assert.equal(GEMINI_VOICES.length, 30, 'the prebuilt roster is thirty voices');
  for (const v of GEMINI_VOICES) {
    assert.equal(v.length, 2, `${v[0]} is a [name, flavour] pair`);
    assert.match(v[0], /^[A-Z][A-Za-z]+$/, `${v[0]} is a bare voice name`);
    assert.ok(v[1].length > 0, `${v[0]} carries a flavour word`);
  }
  const names = GEMINI_VOICES.map(([n]) => n);
  assert.equal(new Set(names).size, names.length, 'a duplicated name would hide a missing voice');
});

test('the default voice createSynth uses is in the roster', () => {
  // synth() defaults to Alnilam; a default that is not a real voice fails only
  // when somebody records without passing --voice.
  assert.ok(GEMINI_VOICES.some(([n]) => n === 'Alnilam'),
    'the default has to be one of the prebuilt voices');
});

test('a slow stretch reaches Gemini as direction, beside the style it already reads', () => {
  assert.equal(styledPrompt(SLOW_DIRECTION, 'Filter first.'), 'Say slowly and deliberately: Filter first.');
  assert.match(styledPrompt(['warm', SLOW_DIRECTION].join('; '), 'x'), /^Say this in the following style — warm; Say slowly and deliberately: x$/);
});
