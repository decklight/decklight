// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The system voice actually being the voice you picked (SPEC PRESENTING).
//
// This file exists because of a bug that was invisible in every place anybody
// would have looked. `createNative` closed over the voice chosen when the
// BRIDGE STARTED and ignored the one sent with the sentence, so all 184 macOS
// voices played the first one — while the bridge's log printed the requested
// name on every line, because the log quotes the request. Green tests, a
// confident log, and one voice.
//
// So the assertions here are on the ARGUMENT VECTOR, which is the only place
// the truth was: what actually reached `say -v`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../tools/tts-engines.mjs';
import { sayArgs, sapiArgs } from '../tools/local-voice.mjs';

const ROSTER = [
  { name: 'Albert', locale: 'en_US', tier: 4 },
  { name: 'Samantha', locale: 'en_US', tier: 3 },
  { name: 'Daniel', locale: 'en_GB', tier: 3 },
  { name: 'Alice', locale: 'it_IT', tier: 3 },
];
const detect = () => ({ engine: 'say', voices: ROSTER, label: 'macOS built-in: Albert' });

/** A `say` engine built against a fixed roster rather than this machine's. */
const sayEngine = ({ lang, voice } = {}) => createEngine({ engine: 'say', lang, voice, detect });

test('sayArgs puts the voice on the command line, and only when there is one', () => {
  assert.deepEqual(sayArgs('hello', 'Samantha', '/tmp/o.wav'),
    ['-v', 'Samantha', '--data-format=LEI16@24000', '-o', '/tmp/o.wav', '--', 'hello']);
  // no voice → no -v, so `say` uses the system default deliberately rather than
  // by accident
  assert.deepEqual(sayArgs('hello', null, '/tmp/o.wav'),
    ['--data-format=LEI16@24000', '-o', '/tmp/o.wav', '--', 'hello']);
  // the text is passed after `--`, so a sentence starting with a dash is text
  assert.equal(sayArgs('-v not a flag', 'Alex', '/tmp/o.wav').at(-1), '-v not a flag');
});

test('sapi selects the voice too, with the name escaped for PowerShell', () => {
  // the script is the LAST argument — the three before it are PowerShell's own
  const script = sapiArgs('hello', "O'Brien", 'C:\\o.wav').at(-1);
  assert.match(script, /SelectVoice\('O''Brien'\)/, 'a quote in a voice name must not end the string');
  assert.doesNotMatch(sapiArgs('hello', null, 'C:\\o.wav').at(-1), /SelectVoice/);
});

test('the engine reports the roster the machine has, not a built-in list', () => {
  const engine = sayEngine();
  // [name, flavor, group]: the quality category is a STRUCTURED third element
  // — the picker draws it as a labelled separator over each shelf — and the
  // flavor stays the locale alone. Deck-language voices get quality shelves;
  // every other locale shares ONE tail group, because shelving 140 foreign
  // voices by quality answers a question nobody browsing this deck asked.
  assert.deepEqual(engine.voices, [
    ['Albert', 'en_US', 'novelty'],
    ['Samantha', 'en_US', 'average'],
    ['Daniel', 'en_GB', 'average'],
    ['Alice', 'it_IT', 'other languages'],
  ]);
  assert.equal(engine.stylable, false, 'a system voice takes no delivery instruction');
  assert.equal(engine.model, 'Albert', 'the startup voice is the first the OS ranked');
});

test('a name this machine cannot say is refused, never quietly swapped', async () => {
  // The reason this is a hard error: `say -v Zephyr` exits 0 and produces the
  // SYSTEM DEFAULT voice. A typo, a voice saved under a different engine, or a
  // roster prefetch from somewhere else all sound exactly like success — you
  // get somebody else's voice and nothing anywhere says so.
  const engine = sayEngine();
  await assert.rejects(() => engine.synth('hello', { voice: 'Zephyr' }),
    /no say voice named "Zephyr"/);
  // and the message points at where the real list is
  await assert.rejects(() => engine.synth('hello', { voice: 'Zephyr' }), /GET \/voices/);
});

test('a voice the machine DOES have is not refused', async () => {
  const engine = sayEngine();
  // It reaches the real `say` here, which is the point — this asserts the guard
  // lets a legitimate name through rather than that synthesis works.
  const out = await engine.synth('hi', { voice: 'Samantha' }).catch((e) => e);
  assert.ok(!(out instanceof Error && /no say voice named/.test(out.message)),
    `a real voice was refused: ${out.message ?? ''}`);
});

test('the per-sentence voice wins over the one the bridge started with', async (t) => {
  // The bug, stated as a property. Every other engine takes the voice from the
  // second argument; this one used to take it from the closure, so the picker
  // was decoration.
  const engine = sayEngine({ voice: 'Albert' });
  const a = await engine.synth('the same sentence', { voice: 'Albert' }).catch(() => null);
  const b = await engine.synth('the same sentence', { voice: 'Samantha' }).catch(() => null);
  if (!a || !b) return t.skip('no working `say` on this machine');
  assert.notDeepEqual(a.wav, b.wav, 'two voices produced byte-identical audio');
  assert.equal(a.usage.model, 'Albert');
  assert.equal(b.usage.model, 'Samantha', 'usage named the startup voice, not the one that spoke');
});

test('with no voice asked for, the startup voice still speaks', async (t) => {
  const engine = sayEngine({ voice: 'Daniel' });
  const out = await engine.synth('hello there', {}).catch(() => null);
  if (!out) return t.skip('no working `say` on this machine');
  assert.equal(out.usage.model, 'Daniel');
});

test('an empty roster does not lock the engine out of speaking', async (t) => {
  // The guard keys off a roster the detector supplied. A detector that reports
  // an engine but no names must not turn every sentence into a refusal — that
  // would trade a wrong voice for no voice at all.
  const engine = createEngine({
    engine: 'say', voice: 'Samantha', detect: () => ({ engine: 'say', voices: [{ name: 'Samantha' }] }),
  });
  const out = await engine.synth('hello', { voice: 'Samantha' }).catch(() => null);
  if (!out) return t.skip('no working `say` on this machine');
  assert.ok(out.wav.length);
});

test('the install route\'s one exec is a frozen argv, opening a Settings pane and nothing else', async () => {
  const { openVoiceSettings, VOICE_SETTINGS_URI, WINDOWS_VOICE_SETTINGS_URI } = await import('../tools/voiceover-server.mjs');
  const calls = [];
  openVoiceSettings((bin, args) => calls.push([bin, args]), 'darwin');
  assert.deepEqual(calls, [['open', ['x-apple.systempreferences:com.apple.preference.universalaccess']]]);
  // Windows: the Narrator page, where "Add natural voices" lives — every
  // token a constant, the "" being `start`'s title argument so the URI can
  // never be read as one
  calls.length = 0;
  openVoiceSettings((bin, args) => calls.push([bin, args]), 'win32');
  assert.deepEqual(calls, [['cmd', ['/c', 'start', '""', 'ms-settings:easeofaccess-narrator']]]);
  assert.equal(WINDOWS_VOICE_SETTINGS_URI, 'ms-settings:easeofaccess-narrator');
  // the URI the caveat prints and the one the route opens must be the same door
  assert.equal(VOICE_SETTINGS_URI, 'x-apple.systempreferences:com.apple.preference.universalaccess');
});
