// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What this machine can say out loud — every branch of it, from Linux.
//
// The whole feature is "behave differently per operating system", which is the
// one thing CI cannot exercise by running. So the platform, the binaries and
// the command output are all injected, and every OS is tested on every OS.

import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  parseSayVoices, parseSapiVoices, sayTier, sayArgs, sapiArgs,
  detectLocalVoice, ollamaRunning, OLLAMA_NOTE,
} from '../tools/local-voice.mjs';
import { planServices, voiceModelOffer } from '../cli/dev.mjs';
import { ENGINES, NATIVE_ENGINES } from '../tools/tts-engines.mjs';

// real `say -v '?'` output: names carry spaces and a parenthesised tier
const SAY = `Agnes               en_US    # Isn't it nice to have a computer that will talk to you?
Alice               it_IT    # Salve, mi chiamo Alice e sono una voce italiana.
Ava (Premium)       en_US    # Hello! My name is Ava.
Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.
Gilles (Personal Voice)   en_US    # Hi, this is my voice.
Zarvox              en_US    # Hello! My name is Zarvox.`;

test('macOS voices are ranked by how good they will sound, not alphabetically', () => {
  // the roster mixes twenty years of engines; first-alphabetically is Agnes,
  // a 1990s formant voice, which is the wrong answer on every modern Mac
  const v = parseSayVoices(SAY);
  assert.equal(v[0].name, 'Gilles (Personal Voice)', 'the voice the user recorded wins');
  assert.equal(v[1].name, 'Ava (Premium)');
  assert.equal(v[2].name, 'Daniel (Enhanced)');
  assert.deepEqual(v.map((x) => x.name).slice(3), ['Agnes', 'Zarvox', 'Alice']);
});

test('a name with spaces and a tier is parsed whole, and the locale kept', () => {
  const v = parseSayVoices(SAY);
  assert.equal(v.find((x) => x.name === 'Ava (Premium)').locale, 'en_US');
  assert.equal(v.find((x) => x.name === 'Alice').locale, 'it_IT');
  assert.equal(parseSayVoices('').length, 0);
  assert.equal(parseSayVoices('garbage that is not a voice list').length, 0);
});

test('a deck in another language gets that language\'s voices first', () => {
  // a Mac whose best voice speaks Italian must not narrate an English deck
  assert.equal(parseSayVoices(SAY, { lang: 'it' })[0].name, 'Alice');
  assert.equal(parseSayVoices(SAY, { lang: 'it-IT' })[0].name, 'Alice');
});

test('the tiers macOS itself labels are the ones we rank', () => {
  assert.equal(sayTier('Gilles (Personal Voice)'), 0);
  assert.equal(sayTier('Ava (Premium)'), 1);
  assert.equal(sayTier('Daniel (Enhanced)'), 2);
  assert.equal(sayTier('Agnes'), 3);
});

test('Windows natural voices outrank the desktop ones', () => {
  const v = parseSapiVoices('Microsoft David Desktop - English (United States)\n'
    + 'Microsoft Aria Online (Natural) - English (United States)\n\n');
  assert.equal(v[0].name, 'Microsoft Aria Online (Natural) - English (United States)');
  assert.equal(v.length, 2, 'and blank lines are not voices');
});

test('macOS is asked for 24 kHz PCM — the shape every other engine returns', () => {
  const a = sayArgs('hello there', 'Ava (Premium)', '/tmp/o.wav');
  assert.deepEqual(a, ['-v', 'Ava (Premium)', '--data-format=LEI16@24000', '-o', '/tmp/o.wav', '--', 'hello there']);
  // `--` matters: a line starting with a dash would otherwise become a flag
  assert.ok(a.indexOf('--') < a.indexOf('hello there'));
});

test('PowerShell quoting cannot be closed by the text being spoken', () => {
  const cmd = sapiArgs("it's a 'quoted' word", "Microsoft Aria", '/tmp/o.wav').at(-1);
  assert.match(cmd, /\$s\.Speak\('it''s a ''quoted'' word'\)/, "a ' is doubled, not escaped away");
  assert.match(cmd, /SetOutputToWaveFile\('\/tmp\/o\.wav'\)/);
  assert.match(cmd, /SelectVoice\('Microsoft Aria'\)/);
});

test('macOS is detected through say, and reports what it found', () => {
  const d = detectLocalVoice({ platform: 'darwin', hasBin: (b) => b === 'say', exec: () => SAY });
  assert.equal(d.engine, 'say');
  assert.equal(d.voices[0].name, 'Gilles (Personal Voice)');
  assert.match(d.label, /^macOS personal voice: Gilles/);
});

test('Windows is detected through PowerShell, whichever one is installed', () => {
  const out = 'Microsoft Aria Online (Natural) - English (United States)';
  const d = detectLocalVoice({ platform: 'win32', hasBin: (b) => b === 'pwsh.exe', exec: () => out });
  assert.equal(d.engine, 'sapi');
  assert.equal(d.shell, 'pwsh.exe', 'the shell it found is the one the engine must use');
  assert.match(d.label, /^Windows natural voice:/);
});

test('Android is refused, with the reason and what to do instead', () => {
  // Termux reports android and runs Node, so this WOULD look supportable
  const d = detectLocalVoice({ platform: 'android' });
  assert.equal(d.engine, null);
  assert.match(d.why, /in-app Java API/);
  assert.match(d.why, /no\s+command line behind it/);
  assert.match(d.suggest, /recorded track needs no bridge/);
});

test('a machine with nothing is told about piper, and only then', () => {
  const linux = detectLocalVoice({ platform: 'linux' });
  assert.equal(linux.engine, null);
  assert.match(linux.why, /Linux ships no system speech synthesizer/);
  assert.match(linux.suggest, /uv tool install piper-tts/);

  // a Mac whose say lists nothing is a different failure and says so
  const broken = detectLocalVoice({ platform: 'darwin', hasBin: () => true, exec: () => '' });
  assert.equal(broken.engine, null);
  assert.match(broken.why, /reported no voices/);
});

test('a synthesizer that errors out is "none", not a crash', () => {
  const d = detectLocalVoice({
    platform: 'darwin', hasBin: () => true,
    exec: () => { throw new Error('say: command failed'); },
  });
  assert.equal(d.engine, null);
});

test('the native engines are real engines the bridge can be asked for', () => {
  assert.deepEqual(NATIVE_ENGINES, ['say', 'sapi']);
  for (const e of NATIVE_ENGINES) assert.ok(ENGINES.includes(e), `${e} is selectable`);
});

test('an Ollama that is not there costs nothing and answers false', async () => {
  assert.equal(await ollamaRunning({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
  assert.equal(await ollamaRunning({ fetchImpl: async () => ({ ok: true }) }), true);
  assert.equal(await ollamaRunning({ fetchImpl: async () => ({ ok: false }) }), false);
  // a hung Ollama must not hang dev — the probe aborts on its own
  const hangs = () => new Promise(() => {});
  assert.equal(await ollamaRunning({ fetchImpl: hangs, timeoutMs: 20 }), false);
});

// ── how dev uses it ───────────────────────────────────────────────────────

const say = () => ({ engine: 'say', voices: [{ name: 'Ava (Premium)', locale: 'en_US', tier: 1 }], label: 'macOS premium: Ava (Premium)' });
const sapi = () => ({ engine: 'sapi', shell: 'powershell.exe', voices: [{ name: 'Aria', locale: 'en', tier: 1 }], label: 'Windows natural voice: Aria' });
const nothing = () => ({ engine: null, why: 'Linux ships no system speech synthesizer', suggest: 'install piper' });

const voiceEngine = (plan) => {
  const tts = plan.run.find((r) => r.name === 'tts');
  if (!tts) return { skipped: plan.skip.find((s) => s.name === 'voice')?.why };
  const i = tts.args.indexOf('--engine');
  return { engine: i < 0 ? 'gemini (default)' : tts.args[i + 1] };
};

test('with no credentials, dev uses the voice the machine already has', () => {
  assert.equal(voiceEngine(planServices({ args: ['d.html'], env: {}, detect: say })).engine, 'say');
  assert.equal(voiceEngine(planServices({ args: ['d.html'], env: {}, detect: sapi })).engine, 'sapi');
});

test('a detected engine is actually PASSED to the bridge', () => {
  // without this the bridge starts with no --engine and falls back to its own
  // default, so a machine picked for its system voice reaches for Vertex AI
  const tts = planServices({ args: ['d.html'], env: {}, detect: say }).run.find((r) => r.name === 'tts');
  assert.ok(tts.args.includes('--engine'));
  assert.equal(tts.args[tts.args.indexOf('--engine') + 1], 'say');
});

test('flags and a saved config both win over detection, which is never consulted', () => {
  const boom = () => { throw new Error('detection must not run when the choice is already made'); };
  assert.equal(voiceEngine(planServices({ args: ['d.html', '--tts-engine', 'piper'], env: {}, hasBin: () => true, exists: () => true, detect: boom })).engine, 'piper');
  assert.equal(voiceEngine(planServices({ args: ['d.html', '--project', 'my-proj'], env: {}, detect: boom })).engine, 'gemini (default)');
  assert.equal(voiceEngine(planServices({ args: ['d.html'], env: { GOOGLE_CLOUD_PROJECT: 'my-project-123' }, detect: boom })).engine, 'gemini (default)');
  assert.equal(voiceEngine(planServices({ args: ['d.html'], env: {}, saved: { engine: 'chirp', project: 'my-project-123' }, detect: boom })).engine, 'chirp');
});

test('piper on PATH is NOT claimed silently — the setup wizard owns that choice', () => {
  // A native voice needs nothing: no install, no download, no credential, so
  // using it without asking costs the presenter nothing. piper needs a
  // toolchain and a ~120 MB model, and picking it behind their back would skip
  // the first-run wizard whose whole job is to make and SAVE that choice.
  const plan = planServices({ args: ['d.html'], env: {}, detect: nothing, hasBin: (b) => b === 'piper' });
  assert.notEqual(voiceEngine(plan).engine, 'piper');
});

test('nothing at all is a skip that explains this machine, not a generic hint', () => {
  const { skipped } = voiceEngine(planServices({ args: ['d.html'], env: {}, detect: nothing, hasBin: () => false }));
  assert.match(skipped, /needs a GCP project/);
  assert.match(skipped, /no system voice either: Linux ships no system speech synthesizer/);
  assert.match(skipped, /install piper/);
  assert.doesNotMatch(skipped, /Ollama/, 'and says nothing about Ollama when it is not running');
});

test('a running Ollama is told the truth about itself', () => {
  // the single most common thing a local-AI user assumes covers this
  const { skipped } = voiceEngine(planServices({ args: ['d.html'], env: {}, detect: nothing, hasBin: () => false, ollama: true }));
  assert.match(skipped, /serves LLMs and cannot speak/);
  assert.match(OLLAMA_NOTE, /no speech endpoint/);
});

test('--no-tts still wins over everything', () => {
  const { skipped } = voiceEngine(planServices({ args: ['d.html', '--no-tts'], env: {}, detect: say }));
  assert.match(skipped, /disabled with --no-tts/);
});

test('piper with no voice model is caught before the bridge starts', () => {
  // Otherwise the bridge comes up looking healthy and fails on the first
  // sentence — a keypress into silence, for a file that was never there.
  const plan = planServices({
    args: ['d.html', '--tts-engine', 'piper'],
    env: { HOME: '/home/x' },
    hasBin: (b) => b === 'piper' || b === 'uvx',
    exists: () => false,
  });
  const offer = voiceModelOffer(plan);
  assert.ok(offer, 'the skip carries the command that fixes it');
  assert.match(offer.why, /piper voice en_US-ryan-high is not in/);
  assert.match(offer.why, /~120 MB, one time/, 'the size is stated before anything is downloaded');
  assert.equal(offer.download.bin, 'uvx');
  assert.deepEqual(offer.download.args.slice(-4),
    ['piper.download_voices', 'en_US-ryan-high', '--data-dir', '/home/x/.local/share/piper']);
});

test('a present model just starts the bridge, and --voice/--data-dir are honored', () => {
  const seen = [];
  const plan = planServices({
    args: ['d.html', '--tts-engine', 'piper', '--voice', 'en_GB-alba-medium', '--data-dir', '/models'],
    env: {}, hasBin: () => true,
    exists: (p) => { seen.push(p); return true; },
  });
  assert.ok(plan.run.find((r) => r.name === 'tts'), 'the bridge runs');
  assert.equal(voiceModelOffer(plan), null, 'and there is nothing to offer');
  // join(), not a literal: the product builds this with the host's separator,
  // and on Windows `\models\en_GB-alba-medium.onnx` is the RIGHT answer.
  assert.ok(seen.includes(join('/models', 'en_GB-alba-medium.onnx')), `looked in the right place: ${seen}`);
});

test('a voice given as a path needs no data dir', () => {
  const seen = [];
  planServices({
    args: ['d.html', '--tts-engine', 'piper', '--voice', '/opt/voices/custom.onnx'],
    env: {}, hasBin: () => true, exists: (p) => { seen.push(p); return true; },
  });
  assert.ok(seen.includes('/opt/voices/custom.onnx'), `the path is the model: ${seen}`);
});
