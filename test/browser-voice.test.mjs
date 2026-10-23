// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The browser's own voice (SPEC PRESENTING_BROWSER_VOICE): what the picker is
// offered, whether there is a voice at all, and when a sentence is over. The
// last one is the dangerous one — a chain waiting on an `end` that never comes
// parks the whole talk — so it is pinned against a fake synthesizer that
// misbehaves the ways Chrome does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserRoster, browserPing, loadVoices, speakSentence, BROWSER_ENGINE } from '../src/core/browser-voice.js';

const V = (name, lang, extra = {}) => ({ name, lang, localService: true, default: false, ...extra });

class Utt {
  constructor(text) { this.text = text; }
}

/** A synthesizer that does what it is told by the test, and nothing else. */
function fakeSynth(voices = [], { late = false } = {}) {
  const listeners = new Set();
  let list = late ? [] : voices;
  const synth = {
    speaking: false, pending: false, paused: false, spoken: [],
    getVoices: () => list,
    addEventListener: (_, f) => listeners.add(f),
    removeEventListener: (_, f) => listeners.delete(f),
    speak(u) { synth.spoken.push(u); synth.current = u; },
    arrive() { list = voices; for (const f of listeners) f(); },
    start() { synth.speaking = true; synth.current.onstart?.(); },
    end() { synth.speaking = false; synth.current.onend?.(); },
    fail(error) { synth.speaking = false; synth.current.onerror?.({ error }); },
  };
  return synth;
}

test('the roster is the bridge shape, the deck language first, default first within it', () => {
  const rows = browserRoster([
    V('Thomas', 'fr-FR'),
    V('Daniel', 'en-GB'),
    V('Samantha', 'en-US', { default: true }),
    V('Google US English', 'en-US', { localService: false }),
    V('Daniel', 'en-GB'),   // repeated by some browsers
  ], 'en');
  assert.deepEqual(rows.map((r) => r[0]), ['Samantha', 'Daniel', 'Google US English', 'Thomas']);
  assert.deepEqual(rows[0], ['Samantha', 'this machine', null, ['en']]);
  assert.equal(rows[2][1], 'online');
});

test('no synthesizer, or one with no voices, is no browser voice', async () => {
  assert.equal(await browserPing(null), null);
  assert.equal(await browserPing({ getVoices: () => [] }), null);   // cannot speak
  assert.equal(await browserPing(fakeSynth([]), { waitMs: 10 }), null);
});

test('a voice list that arrives late is waited for', async () => {
  const synth = fakeSynth([V('Zira', 'en-US')], { late: true });
  const p = loadVoices(synth, 1000);
  synth.arrive();
  assert.deepEqual((await p).map((v) => v.name), ['Zira']);
  const ping = await browserPing(synth);
  assert.equal(ping.engine, BROWSER_ENGINE);
  assert.equal(ping.stylable, false);
  assert.equal(ping.audioTags, false);
});

test('a sentence speaks with the named voice and rate, and resolves on end', async () => {
  const synth = fakeSynth([V('Zira', 'en-US'), V('Hortense', 'fr-FR')]);
  const done = speakSentence(synth, Utt, { text: 'Bonjour.', voice: 'Hortense', rate: 1.25 });
  const u = synth.spoken[0];
  assert.equal(u.voice.name, 'Hortense');
  assert.equal(u.lang, 'fr-FR');
  assert.equal(u.rate, 1.25);
  synth.start();
  synth.end();
  assert.equal(await done, 'ended');
});

test('an end event that never fires still ends the sentence once speaking stops', async () => {
  const synth = fakeSynth([V('Zira', 'en-US')]);
  const done = speakSentence(synth, Utt, { text: 'Hello.', voice: 'Zira' });
  synth.start();
  synth.speaking = false;   // dropped mid-sentence: no end, no error
  assert.equal(await done, 'ended');
});

test('a paused sentence is not an ended one, even when the browser says it is not speaking', async () => {
  const synth = fakeSynth([V('Zira', 'en-US')]);
  let over = false;
  const done = speakSentence(synth, Utt, { text: 'Hold on.' }).then((r) => { over = true; return r; });
  synth.start();
  synth.paused = true;
  synth.speaking = false;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(over, false);
  synth.paused = false;
  synth.end();
  assert.equal(await done, 'ended');
});

test('cancel is not a failure; a refusal and an error are', async () => {
  const synth = fakeSynth([V('Zira', 'en-US')]);
  let done = speakSentence(synth, Utt, { text: 'a' });
  synth.fail('interrupted');
  assert.equal(await done, 'cancelled');
  done = speakSentence(synth, Utt, { text: 'b' });
  synth.fail('not-allowed');
  await assert.rejects(done, /browser: not-allowed/);
  done = speakSentence(synth, Utt, { text: 'c' });
  synth.fail('synthesis-failed');
  await assert.rejects(done, /browser: synthesis-failed/);
});
