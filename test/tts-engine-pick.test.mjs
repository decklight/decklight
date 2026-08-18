// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Choosing the speech engine from inside the deck (SPEC PRESENTING).
//
// Two things are worth pinning here, and neither is the happy path.
//
// The first is that ONE readiness check answers for both callers. `decklight
// author` uses it to decide whether to start the bridge at all; the bridge uses
// it to tell the deck what it may switch to. If they ever drift, the picker
// offers an engine author would have refused — which is a picker that lies, and
// the presenter finds out on the next keypress.
//
// The second is that readiness is asked BEFORE anything is built. gemini and
// chirp construct perfectly well against a project nobody has checked and fail
// on the first sentence. During a talk that is a keypress into silence, and no
// amount of good error handling further down makes it recoverable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineBlocker, engineMenu, engineStatus, ENGINES } from '../tools/tts-engines.mjs';
import { planServices } from '../cli/dev.mjs';

const NONE = () => false;                       // nothing on PATH
const ALL = () => true;                         // everything on PATH
const noFiles = () => false;
const files = () => true;
const mac = () => ({ engine: 'say', voices: [{ name: 'Ava', locale: 'en_US' }] });
const bare = () => ({ engine: null, why: 'Linux ships no system speech synthesizer' });

// ── the check itself ─────────────────────────────────────────────────────

test('a cloud engine is not ready just because it can be constructed', () => {
  // The whole reason this is not `try { createEngine() }`: both of these BUILD.
  for (const name of ['gemini', 'chirp']) {
    assert.equal(engineStatus(name, { env: {}, project: null }).reason, 'no-project', name);
    assert.equal(engineStatus(name, { env: {}, project: 'My Project!' }).reason, 'bad-project', name);
    assert.equal(engineStatus(name, { env: {}, project: 'my-project-123' }).ready, true, name);
  }
});

test('piper needs the binary AND the model, and says which is missing', () => {
  assert.equal(engineStatus('piper', { hasBin: NONE, exists: files }).reason, 'no-binary');
  const m = engineStatus('piper', { hasBin: ALL, exists: noFiles });
  assert.equal(m.reason, 'no-model');
  assert.ok(m.voice, 'the row has to name the voice it wants');
  assert.ok(m.dataDir, 'and where it looked');
  assert.equal(engineStatus('piper', { hasBin: ALL, exists: files }).ready, true);
});

test('elevenlabs is exactly its key', () => {
  assert.equal(engineStatus('elevenlabs', { env: {} }).reason, 'no-key');
  assert.equal(engineStatus('elevenlabs', { env: { ELEVENLABS_API_KEY: 'sk-x' } }).ready, true);
  // whitespace is not a key — this is the shape a bad `export` leaves behind
  assert.equal(engineStatus('elevenlabs', { env: { ELEVENLABS_API_KEY: '  ' } }).reason, 'no-key');
});

test('a native engine the OS does not have is refused with the OS\'s reason', () => {
  assert.equal(engineStatus('say', { detect: mac }).ready, true);
  const no = engineStatus('say', { detect: bare });
  assert.equal(no.reason, 'no-native-voice');
  assert.match(no.why, /Linux/);
  // asking for the wrong platform's engine is the same answer, not a crash
  assert.equal(engineStatus('sapi', { detect: mac }).reason, 'no-native-voice');
});

test('an unknown name is a named state, never a throw', () => {
  assert.equal(engineStatus('not-an-engine', {}).reason, 'unknown');
  assert.equal(engineStatus(undefined, {}).reason, 'unknown');
});

// ── the two callers cannot disagree ──────────────────────────────────────

const started = (plan) => !!plan.run.find((r) => r.name === 'tts');

test('author starts the bridge for exactly the engines the check calls ready', () => {
  // The property the whole shared-check design exists for. If these two ever
  // part company, the deck's picker starts recommending what author refuses.
  const cases = [
    { engine: 'piper', hasBin: ALL, exists: files, env: {} },
    { engine: 'piper', hasBin: ALL, exists: noFiles, env: {} },
    { engine: 'piper', hasBin: NONE, exists: files, env: {} },
    { engine: 'elevenlabs', hasBin: NONE, exists: noFiles, env: {} },
    { engine: 'elevenlabs', hasBin: NONE, exists: noFiles, env: { ELEVENLABS_API_KEY: 'sk-x' } },
    { engine: 'chirp', hasBin: NONE, exists: noFiles, env: {} },
    { engine: 'chirp', hasBin: NONE, exists: noFiles, env: { GOOGLE_CLOUD_PROJECT: 'my-project-123' } },
    { engine: 'gemini', hasBin: NONE, exists: noFiles, env: { GOOGLE_CLOUD_PROJECT: 'nope!' } },
    { engine: 'say', hasBin: NONE, exists: noFiles, env: {} },
  ];
  for (const c of cases) {
    const plan = planServices({
      args: ['d.html', '--tts-engine', c.engine], env: c.env,
      hasBin: c.hasBin, exists: c.exists, detect: mac,
    });
    const status = engineStatus(c.engine, {
      env: c.env, project: c.env.GOOGLE_CLOUD_PROJECT ?? null,
      hasBin: c.hasBin, exists: c.exists, detect: mac,
    });
    assert.equal(started(plan), status.ready,
      `${c.engine} with ${JSON.stringify(c.env)}: author says ${started(plan)}, the check says ${status.ready}`);
  }
});

test('author still explains itself in its own words, not the picker\'s', () => {
  // Shared DECISION, separate phrasing: the terminal has room for the whole
  // answer (where to make a key, what this machine lacks instead), the row in
  // a deck has one line.
  const why = planServices({
    args: ['d.html', '--tts-engine', 'elevenlabs'], env: {}, hasBin: NONE, exists: noFiles, detect: mac,
  }).skip.find((s) => s.name === 'voice').why;
  assert.match(why, /elevenlabs needs \$ELEVENLABS_API_KEY/);
  assert.match(why, /elevenlabs\.io/, 'the terminal says where to make one');
  const row = engineBlocker(engineStatus('elevenlabs', { env: {} }));
  assert.equal(row.why, 'needs $ELEVENLABS_API_KEY');
  assert.ok(!/elevenlabs\.io/.test(row.fix), 'the deck row stays one line');
});

// ── the menu the picker draws ────────────────────────────────────────────

test('every engine is listed — a blocked one is shown, never hidden', () => {
  // "Where did ElevenLabs go?" must have an answer. Silence is not one.
  const menu = engineMenu({ env: {}, hasBin: NONE, exists: noFiles });
  const names = menu.map((e) => e.name);
  for (const n of ['piper', 'chirp', 'gemini', 'elevenlabs']) assert.ok(names.includes(n), n);
  assert.ok(menu.every((e) => e.ready || e.why), 'a blocked row with no reason is just a greyed name');
});

test('a ready row quotes a price and a blocked row does not', () => {
  const menu = engineMenu({ env: { GOOGLE_CLOUD_PROJECT: 'my-project-123' }, hasBin: NONE, exists: noFiles });
  const chirp = menu.find((e) => e.name === 'chirp');
  assert.equal(chirp.ready, true);
  assert.match(chirp.cost, /free/);
  // ...and nothing quotes a price for an engine that cannot speak: a cost note
  // beside a blocker reads as an offer.
  const eleven = menu.find((e) => e.name === 'elevenlabs');
  assert.equal(eleven.ready, false);
  assert.ok(eleven.why);
  assert.equal(eleven.cost, undefined, 'a blocked engine quoted a price');
  // The coupling is the point and it is easy to break: readiness is probed
  // with a settled project and the cost note comes from BUILDING the engine,
  // which refuses that same missing project. Probe with one and build with the
  // other and every ready cloud row silently loses its price.
  for (const e of menu) {
    if (!e.ready) assert.equal(e.cost, undefined, `${e.name}: blocked but priced`);
  }
});

test('the menu recommends free first, and never offers the other OS\'s engine', () => {
  const names = engineMenu({ env: {}, hasBin: NONE, exists: noFiles }).map((e) => e.name);
  const native = process.platform === 'win32' ? 'sapi' : 'say';
  const other = process.platform === 'win32' ? 'say' : 'sapi';
  assert.equal(names[0], native, 'the engine that needs no setup comes first');
  assert.ok(!names.includes(other), `${other} is not a choice on this platform`);
  assert.ok(names.indexOf('piper') < names.indexOf('gemini'), 'free before billed');
});

test('every reason a status can carry has words for it', () => {
  // A row whose blocker rendered as "undefined" would be worse than no row.
  const reasons = new Set(['unknown', 'no-binary', 'no-model', 'no-key',
    'no-project', 'bad-project', 'no-native-voice']);
  for (const reason of reasons) {
    const b = engineBlocker({ name: 'x', reason, voice: 'v', dataDir: '/d', project: 'p' });
    assert.ok(b?.why, `${reason} has no sentence`);
  }
  assert.equal(engineBlocker({ reason: 'ok' }), null);
  assert.equal(engineBlocker(null), null);
});

test('ENGINES is still the list the whole feature is about', () => {
  // A new engine added to the six must show up in the picker without anybody
  // remembering to add it there.
  const menu = engineMenu({ env: {}, hasBin: NONE, exists: noFiles }).map((e) => e.name);
  for (const name of ENGINES) {
    const native = ['say', 'sapi'];
    if (native.includes(name)) continue;   // one per platform, checked above
    assert.ok(menu.includes(name), `${name} is in ENGINES but not in the picker`);
  }
});
