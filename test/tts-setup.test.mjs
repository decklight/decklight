// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// First-run TTS setup (SPEC §8): the config file, the guided wizard, and the
// two entry points. The wizard's side effects are all injected, so every
// question path runs hermetically; the end-to-end runs use a real pty
// (script(1)) and the stub piper from helpers.mjs, so `decklight tts` is
// exercised exactly as a presenter on a fresh machine would hit it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEST_SENTENCE, ttsConfigPath, loadTtsConfig, saveTtsConfig,
  suggestEngine, runSetupWizard,
} from '../tools/tts-setup.mjs';
import { writeFakePiper } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-tts-setup-'));

// scripted answers: the wizard asking more questions than the script has is a
// failure, not a hang
const scripted = (answers) => {
  const queue = [...answers];
  return async (q) => {
    if (!queue.length) throw new Error(`wizard asked more than scripted: ${q}`);
    return queue.shift();
  };
};
const collect = () => {
  const lines = [];
  const log = (s = '') => lines.push(String(s));
  log.text = () => lines.join('\n');
  return log;
};
const fakeEngine = (over = {}) => {
  const synth = async () => ({ wav: Buffer.alloc(64), usage: { note: '9 tokens', cost: 0 } });
  synth.close = () => { synth.closed = true; };
  return { name: 'fake', model: 'fake-1', cost: 'free · offline', synth, ...over };
};

test('the config file honors $XDG_CONFIG_HOME and falls back to ~/.config', () => {
  assert.equal(ttsConfigPath({ XDG_CONFIG_HOME: '/xdg' }),
    path.join('/xdg', 'decklight', 'tts.json'));
  assert.equal(ttsConfigPath({ HOME: '/home/u' }),
    path.join('/home/u', '.config', 'decklight', 'tts.json'));
});

test('save/load roundtrip — missing or corrupt files read as first-run, never throw', () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  assert.equal(loadTtsConfig(env), null, 'nothing saved yet');
  const file = saveTtsConfig({ engine: 'piper', voice: 'en_US-ryan-high' }, env);
  assert.equal(file, ttsConfigPath(env));
  assert.deepEqual(loadTtsConfig(env), { engine: 'piper', voice: 'en_US-ryan-high' });
  fs.writeFileSync(file, 'not json at all');
  assert.equal(loadTtsConfig(env), null, 'a corrupt file resets to first-run');
});

test('the suggested engine follows what the machine already has', () => {
  const piperInstalled = (b) => b === 'piper';
  assert.equal(suggestEngine({ hasBin: piperInstalled }), 'piper');
  assert.equal(suggestEngine({ hasBin: () => false, project: 'proj-1' }), 'chirp');
  assert.equal(suggestEngine({ hasBin: () => false }), 'piper', 'a bare machine gets the free path');
});

test('piper happy path: Enter takes the default, the test synthesis gates the save', async () => {
  const home = tmp();
  const env = { HOME: home, PATH: '' };
  fs.mkdirSync(path.join(home, '.local', 'share', 'piper'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'share', 'piper', 'en_US-ryan-high.onnx'), '');
  const log = collect();
  const made = [];
  const result = await runSetupWizard({
    ask: scripted(['']),
    log,
    env,
    hasBin: (b) => b === 'piper',
    detectProject: () => null,
    makeEngine: (o) => { made.push(o); return fakeEngine({ name: 'piper', model: 'en_US-ryan-high' }); },
    play: () => {},
  });
  assert.deepEqual(result.config, { engine: 'piper', voice: 'en_US-ryan-high' });
  assert.deepEqual(loadTtsConfig(env), result.config, 'saved where both commands read it');
  assert.deepEqual(made, [{ engine: 'piper', project: undefined, voice: 'en_US-ryan-high' }]);
  assert.match(log.text(), new RegExp(TEST_SENTENCE), 'the proof is the picker preview sentence');
  assert.match(log.text(), /✓ spoke in \d+\.\d+s · 9 tokens · free · offline/, 'duration and cost note');
});

test('a missing piper is an offered install — declined means nothing runs, nothing saves', async () => {
  const env = { HOME: tmp(), PATH: '' };
  const log = collect();
  let ran = 0;
  const result = await runSetupWizard({
    ask: scripted(['1', 'n']),
    log,
    env,
    hasBin: () => false,
    detectProject: () => null,
    runCmd: () => { ran++; return true; },
  });
  assert.equal(result, null);
  assert.equal(ran, 0, 'install commands run only on an explicit yes');
  assert.match(log.text(), /uv tool install piper-tts/, 'the exact command is shown');
  assert.equal(loadTtsConfig(env), null);
});

test('an explicit yes runs the exact install and download commands', async () => {
  const home = tmp();
  const env = { HOME: home, PATH: '' };
  const models = path.join(home, '.local', 'share', 'piper');
  const log = collect();
  const cmds = [];
  const result = await runSetupWizard({
    ask: scripted(['1', 'y', 'y']),
    log,
    env,
    hasBin: () => false,
    detectProject: () => null,
    runCmd: (bin, args) => { cmds.push([bin, ...args]); return true; },
    makeEngine: () => fakeEngine({ name: 'piper', model: 'en_US-ryan-high' }),
    play: () => {},
  });
  assert.deepEqual(cmds, [
    ['uv', 'tool', 'install', 'piper-tts'],
    ['python', '-m', 'piper.download_voices', 'en_US-ryan-high', '--data-dir', models],
  ]);
  assert.deepEqual(result.config, { engine: 'piper', voice: 'en_US-ryan-high' });
});

test('cloud engines ask for the project — validated, prefilled, re-asked on garbage', async () => {
  const env = { XDG_CONFIG_HOME: tmp(), PATH: '' };
  const log = collect();
  const result = await runSetupWizard({
    ask: scripted(['2', 'Not A Project!', 'my-proj-123']),
    log,
    env,
    hasBin: () => false,
    detectProject: () => 'env-proj',
    mintToken: () => 'tok',
    makeEngine: () => fakeEngine({ name: 'chirp', model: 'chirp3-hd', cost: 'first 1M chars/month free' }),
    play: () => {},
  });
  assert.deepEqual(result.config, { engine: 'chirp', project: 'my-proj-123' });
  assert.match(log.text(), /not a GCP project id: "Not A Project!"/);

  // Enter accepts the prefill (the environment / gcloud config detection)
  const viaPrefill = await runSetupWizard({
    ask: scripted(['3', '']),
    log: collect(),
    env,
    hasBin: () => false,
    detectProject: () => 'env-proj',
    mintToken: () => 'tok',
    makeEngine: () => fakeEngine({ name: 'gemini' }),
    play: () => {},
  });
  assert.deepEqual(viaPrefill.config, { engine: 'gemini', project: 'env-proj' });
});

test('missing credentials name the gcloud command and save nothing — never a browser flow', async () => {
  const env = { XDG_CONFIG_HOME: tmp(), PATH: '' };
  const log = collect();
  const result = await runSetupWizard({
    ask: scripted(['2', 'my-proj-123']),
    log,
    env,
    hasBin: () => false,
    detectProject: () => null,
    mintToken: () => { throw new Error('no ADC'); },
  });
  assert.equal(result, null);
  assert.match(log.text(), /gcloud auth application-default login/);
  assert.equal(loadTtsConfig(env), null);
});

test('a failed test synthesis shows the engine error and saves nothing', async () => {
  const env = { XDG_CONFIG_HOME: tmp(), HOME: tmp(), PATH: '' };
  fs.mkdirSync(path.join(env.HOME, '.local', 'share', 'piper'), { recursive: true });
  fs.writeFileSync(path.join(env.HOME, '.local', 'share', 'piper', 'en_US-ryan-high.onnx'), '');
  const log = collect();
  const broken = fakeEngine();
  broken.synth = Object.assign(async () => { throw new Error('429 quota exceeded'); },
    { close() { broken.closed = true; } });
  const result = await runSetupWizard({
    ask: scripted(['1']),
    log,
    env,
    hasBin: (b) => b === 'piper',
    detectProject: () => null,
    makeEngine: () => broken,
  });
  assert.equal(result, null);
  assert.match(log.text(), /429 quota exceeded/, "the engine's own error");
  assert.equal(loadTtsConfig(env), null, 'a config that has not spoken is not saved');
  assert.equal(broken.closed, true, 'a resident engine is not left running');
});

// ---- the entry points, end to end -----------------------------------------

const ptySkip = fs.existsSync('/usr/bin/script') ? false : 'needs util-linux script(1) for a pty';

// a fresh "machine": stub piper + voice model under a temp HOME, no
// GOOGLE_CLOUD_PROJECT, nothing saved
function freshMachine() {
  const home = tmp();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  writeFakePiper(bin);
  const models = path.join(home, '.local', 'share', 'piper');
  fs.mkdirSync(models, { recursive: true });
  fs.writeFileSync(path.join(models, 'en_US-ryan-high.onnx'), '');
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.XDG_CONFIG_HOME;
  delete env.GOOGLE_CLOUD_PROJECT;
  return { home, env };
}

test('a bare `decklight tts` on a TTY runs the guided setup, then serves the bridge', { skip: ptySkip, timeout: 60_000 }, async () => {
  const { home, env } = freshMachine();
  const port = 18000 + (process.pid % 500);

  const out = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/script',
      ['-qec', `node "${CLI}" tts --port ${port}`, '/dev/null'],
      { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    const done = { engine: false, int: false };
    const answer = (key, re, reply) => {
      if (done[key] || !re.test(text)) return;
      done[key] = true;
      setTimeout(() => child.stdin.write(reply), 100);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      answer('engine', /engine \[1\]/, '\n');           // Enter takes the piper default
      answer('int', /decklight tts bridge on http/, '\x03');
    });
    child.stderr.on('data', (c) => { text += c; });
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out:\n${text}`)); }, 45_000);
    child.on('close', () => { clearTimeout(kill); resolve(text); });
    child.on('error', reject);
  });

  assert.match(out, /which voice engine\?/, 'the wizard ran instead of the old error');
  assert.match(out, /✓ spoke in \d+\.\d+s .* free · offline/, 'one real test synthesis, with duration and cost note');
  assert.match(out, new RegExp(`decklight tts bridge on http://127\\.0\\.0\\.1:${port}`), 'the bridge came up in the same session');
  assert.match(out, /no voice engine configured yet/, 'the old dead end became the first question');
  assert.deepEqual(loadTtsConfig({ HOME: home }), { engine: 'piper', voice: 'en_US-ryan-high' });

  // …and from then on the voice starts with no questions asked
  const again = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'tts', '--port', String(port + 1)], { cwd: home, env });
    let text = '';
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out:\n${text}`)); }, 20_000);
    const check = (chunk) => {
      text += chunk;
      if (/decklight tts bridge on http/.test(text)) { clearTimeout(kill); child.kill('SIGTERM'); resolve(text); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('error', reject);
  });
  assert.doesNotMatch(again, /which voice engine\?/, 'no questions on later runs');
  assert.match(again, /piper · en_US-ryan-high \(free · offline\)/, 'the saved engine is the one serving');
});

test('non-TTY with nothing configured keeps today’s exit code and message — it never prompts', () => {
  const home = tmp();
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg') };
  delete env.GOOGLE_CLOUD_PROJECT;
  const r = spawnSync(process.execPath, [CLI, 'tts'], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a GCP project/);
  assert.doesNotMatch(r.stdout + r.stderr, /which voice engine\?/);
});

test('flags still beat the saved config, and --setup refuses to run headless', () => {
  const home = tmp();
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), PATH: '/nonexistent' };
  delete env.GOOGLE_CLOUD_PROJECT;
  saveTtsConfig({ engine: 'piper', voice: 'en_US-ryan-high' }, env);

  // saved piper is read (the error is piper's, not gemini's)…
  const saved = spawnSync(process.execPath, [CLI, 'tts'], { encoding: 'utf8', env });
  assert.equal(saved.status, 1);
  assert.match(saved.stderr, /piper not found — install with: uv tool install piper-tts/);

  // …but an explicit --engine wins over it, and fails with ITS error, no wizard
  const flag = spawnSync(process.execPath, [CLI, 'tts', '--engine', 'chirp'], { encoding: 'utf8', env });
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /chirp needs a GCP project/);

  const setup = spawnSync(process.execPath, [CLI, 'tts', '--setup'], { encoding: 'utf8', env });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /--setup needs a terminal/);
});

test('`decklight dev` on a TTY offers the same setup where it would skip the voice', { skip: ptySkip, timeout: 60_000 }, async () => {
  const { home, env } = freshMachine();
  fs.writeFileSync(path.join(home, 'talk.html'), '<!doctype html><div class="decklight"><section><h2>Hi</h2></section></div>');
  spawnSync('git', ['init', '-q'], { cwd: home }); // no git question — the voice offer is the one under test
  const editPort = 18600 + (process.pid % 300);

  const out = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/script',
      ['-qec', `node "${CLI}" dev talk.html --port ${editPort} --tts-port ${editPort + 1} --no-lipsync`, '/dev/null'],
      { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    const done = { offer: false, engine: false, int: false };
    const answer = (key, re, reply) => {
      if (done[key] || !re.test(text)) return;
      done[key] = true;
      setTimeout(() => child.stdin.write(reply), 100);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      answer('offer', /set up live narration now\? \(V \/ N in the deck use it\) \[Y\/n\]/, '\n');
      answer('engine', /engine \[1\]/, '\n');
      answer('int', /decklight tts bridge on http/, '\x03');
    });
    child.stderr.on('data', (c) => { text += c; });
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out:\n${text}`)); }, 45_000);
    child.on('close', () => { clearTimeout(kill); resolve(text); });
    child.on('error', reject);
  });

  assert.match(out, /no voice engine configured — set up live narration now\?/);
  assert.match(out, /decklight tts bridge on http/, 'the bridge joined the same dev session');
  assert.doesNotMatch(out, /voice\s+skipped/, 'no skip line once setup completed');
  assert.deepEqual(loadTtsConfig({ HOME: home }), { engine: 'piper', voice: 'en_US-ryan-high' });
});
