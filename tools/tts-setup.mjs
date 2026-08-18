// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// First-run TTS setup (SPEC PRESENTING): the guided questions that turn "gemini needs
// a GCP project" from a dead end into a working voice. Both entry points share
// it — `decklight tts` runs it where it used to exit with that error (and on
// `--setup`), `decklight author` offers it where it would otherwise skip the
// voice bridge.
//
// The questions ARE the engines' error strings turned around: everything the
// wizard asks about is something tts-engines.mjs would have thrown about one
// keypress later. It ends with one real test synthesis — the picker's preview
// sentence — and saves NOTHING unless that synthesis succeeded, so a saved
// config is a config that has actually spoken.
//
// Interaction is injected (`ask`, the resolvePortConflict pattern), so every
// path is testable without a TTY.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  binOnPath,
  createEngine, ENGINES, PIPER_DEFAULT_VOICE, piperModelDir,
  piperDownloadCmd, piperDownloadLine,
} from './tts-engines.mjs';
import { gcloudToken, validProjectId } from './gemini-tts.mjs';
import { KEY_ENV as ELEVENLABS_KEY_ENV, apiKey as elevenLabsKey } from './elevenlabs-tts.mjs';

// The picker's preview default (SPEC PRESENTING) — the wizard's proof is the same
// audio the deck's N picker previews.
export const TEST_SENTENCE = 'Hey, this is Decklight';

/** The saved answers live at ~/.config/decklight/tts.json — $XDG_CONFIG_HOME honored. */
export function ttsConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'decklight', 'tts.json');
}

/** The saved config, or null — a missing (or unreadable) file is first-run, not an error. */
export function loadTtsConfig(env = process.env) {
  try { return JSON.parse(readFileSync(ttsConfigPath(env), 'utf8')); }
  catch { return null; }
}

export function saveTtsConfig(config, env = process.env) {
  const file = ttsConfigPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** The project gcloud is configured with — the prefill when $GOOGLE_CLOUD_PROJECT is unset. */
export function gcloudConfigProject() {
  try {
    const out = execFileSync('gcloud', ['config', 'get-value', 'project'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out && !out.startsWith('(') ? out : null; // '(unset)' when none
  } catch { return null; }
}

/**
 * The suggested default follows what the machine already has. An ElevenLabs key
 * in the environment is the strongest signal of the four: nobody exports one by
 * accident, and it is the only engine that can speak in a voice that is yours.
 * After that, piper on PATH speaks for free today and a visible GCP project puts
 * chirp one Enter away. A bare machine suggests piper — the wizard can install
 * it, and it is the only engine with no bill attached.
 */
export function suggestEngine({ hasBin = binOnPath, env = process.env, project = null } = {}) {
  if (elevenLabsKey(env)) return 'elevenlabs';
  if (hasBin('piper', env)) return 'piper';
  if (project) return 'chirp';
  return 'piper';
}

// Proof you can HEAR, when the machine has a player — silence is not a
// failure (CI has no speakers), and the synthesis already proved itself.
function playWav(wav, env = process.env) {
  const player = ['afplay', 'paplay', 'aplay'].find((b) => binOnPath(b, env));
  if (!player) return;
  const f = join(tmpdir(), `decklight-tts-test-${process.pid}.wav`);
  try {
    writeFileSync(f, wav);
    execFileSync(player, [f], { stdio: 'ignore', timeout: 15_000 });
  } catch { /* headless audio stack */ }
  finally { rmSync(f, { force: true }); }
}

const yes = (answer, dflt) => (answer.trim() === '' ? dflt : /^y/i.test(answer.trim()));

// Menu order is a recommendation — free first — so it is NOT tts-engines'
// ENGINES order (which keeps gemini first as the historical default).
const MENU = ['piper', 'chirp', 'gemini', 'elevenlabs'];

/**
 * The guided setup. `ask` is `(prompt) => Promise<string>` and is required —
 * the caller owns the readline (dev already holds one for its git question).
 * Everything with a side effect is injectable so tests never touch PATH,
 * gcloud, or the network. Returns `{ config, engine }` — the engine has
 * already spoken the test sentence, so `decklight tts` can serve with it as
 * is — or null when setup was declined or the test synthesis failed; in
 * either of those cases NOTHING was saved.
 */
export async function runSetupWizard({
  ask,
  log = console.log,
  env = process.env,
  hasBin = binOnPath,
  detectProject,
  mintToken = gcloudToken,
  makeEngine = createEngine,
  runCmd, // (bin, args) => ok — install commands, run only on an explicit yes
  canImport, // (python) => can it import piper? injected so tests never spawn one
  play = playWav,
  prefill = {}, // --setup re-runs: the saved answers become the defaults
} = {}) {
  detectProject ??= () => env.GOOGLE_CLOUD_PROJECT || prefill.project || gcloudConfigProject();
  runCmd ??= (bin, args) => {
    log(`  $ ${bin} ${args.join(' ')}`);
    return spawnSync(bin, args, { stdio: 'inherit' }).status === 0;
  };

  // 1. the engine, with the trade-offs stated
  const detected = detectProject();
  const suggested = MENU.includes(prefill.engine) ? prefill.engine
    : suggestEngine({ hasBin, env, project: detected });
  log('  which voice engine?');
  log('    1) piper   free · offline · unlimited — one-time ~120 MB voice model download');
  log('    2) chirp   Google Cloud TTS — 30 voices, 1M chars/month free');
  log('    3) gemini  best delivery, honors a tone — billed, no free tier');
  log(`    4) elevenlabs  your own account's voices, cloned ones included — needs $${ELEVENLABS_KEY_ENV}`);
  let engineName;
  for (;;) {
    const a = (await ask(`  engine [${MENU.indexOf(suggested) + 1}] `)).trim().toLowerCase();
    engineName = a === '' ? suggested : (MENU[Number(a) - 1] ?? (MENU.includes(a) ? a : undefined));
    if (engineName) break;
    log(`    1, 2, 3, 4 — or a name: ${MENU.join(', ')}`);
  }
  const config = { engine: engineName };

  // 2. only what that engine actually needs
  if (engineName === 'piper') {
    // Whether the downloader can be reached through uvx is knowledge this code
    // HAS and generic detection does not: if the wizard installs piper below it
    // does so with uv, and uvx ships with uv. Detecting it instead would make
    // the wizard's behaviour depend on the machine running the test.
    let uvx = hasBin('uvx', env);
    if (!hasBin('piper', env)) {
      log('  piper is not installed. the install is one command:');
      log('    uv tool install piper-tts');
      if (!yes(await ask('  run it now? [y/N] '), false)) {
        log('  install piper, then run: decklight tts');
        return null;
      }
      if (!runCmd('uv', ['tool', 'install', 'piper-tts'])) {
        log('  install failed — nothing saved');
        return null;
      }
      uvx = true;   // uv just ran, so uvx is there too
    }
    const voice = prefill.voice ?? PIPER_DEFAULT_VOICE;
    const models = piperModelDir(env);
    if (!existsSync(join(models, `${voice}.onnx`))) {
      // the command is CHOSEN, not assumed: `uv tool install piper-tts` above
      // puts piper in an isolated venv the ambient python cannot import from,
      // so the plain `python -m piper.download_voices` we used to print here
      // failed with ModuleNotFoundError on a machine that had just installed
      // piper successfully — following our own instructions
      const dl = piperDownloadCmd(voice, models, {
        hasBin: (b) => (b === 'uvx' ? uvx : hasBin(b, env)),
        ...(canImport ? { canImport } : {}),
      });
      log(`  the ${voice} voice model is missing (~120 MB, one-time). the download is one command:`);
      log(`    ${piperDownloadLine(dl)}`);
      if (!dl) return null;
      if (!yes(await ask('  run it now? [y/N] '), false)) {
        log('  fetch the model, then run: decklight tts');
        return null;
      }
      mkdirSync(models, { recursive: true });
      if (!runCmd(dl.bin, dl.args)) {
        log('  download failed — nothing saved');
        return null;
      }
    }
    config.voice = voice;
  } else if (engineName === 'elevenlabs') {
    // The key is the whole prerequisite, and it is the one answer this wizard
    // will not write down: config files get committed, and a key is not a
    // preference. Name where to get it and where to put it, then move on.
    if (!elevenLabsKey(env)) {
      log(`  no ${ELEVENLABS_KEY_ENV} in the environment. create a key at`);
      log('    https://elevenlabs.io/app/settings/api-keys');
      log('  then export it (your shell profile is the right home for it — decklight');
      log('  deliberately never writes it to its config file):');
      log(`    export ${ELEVENLABS_KEY_ENV}=...`);
      log('  then run: decklight tts');
      return null;
    }
    // Which voice is a question the account answers, not the user: the roster
    // arrives with the test synthesis below and the picker offers it, yours
    // first. Nothing to ask, so nothing is asked.
  } else {
    // chirp and gemini are the same two checks: which project, and can a
    // token be minted. The id is validated here with the same rule the
    // engines enforce — punctuation from a copy-paste must not survive to
    // become an opaque 403.
    let project = detected;
    for (;;) {
      const a = (await ask(`  GCP project id${project ? ` [${project}]` : ''} `)).trim() || project || '';
      if (validProjectId(a)) { project = a; break; }
      log(`    not a GCP project id: ${JSON.stringify(a)} — 6-30 chars, lowercase letters, digits and hyphens`);
    }
    config.project = project;
    try { mintToken(); }
    catch {
      // detect and name the way in — never drive a browser auth flow
      log('  no application-default credentials — mint them with:');
      log('    gcloud auth application-default login');
      log('  then run: decklight tts');
      return null;
    }
  }

  // 3. prove it: one real synthesis of the picker's preview sentence
  let engine;
  try {
    engine = makeEngine({ engine: config.engine, project: config.project, voice: config.voice, env });
    log(`  testing ${engine.name} · ${engine.model} — "${TEST_SENTENCE}" …`);
    const t0 = Date.now();
    const { wav, usage } = await engine.synth(TEST_SENTENCE, {});
    log(`  ✓ spoke in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${usage.note} · ${engine.cost}`);
    // an account roster is worth reporting: it is the reason to pick this engine
    const roster = await engine.listVoices?.().catch(() => null);
    if (roster) log(`  ${roster.length} voice(s) on this key — ${roster.slice(0, 3).map((v) => `${v.name} (${v.flavor})`).join(', ')}${roster.length > 3 ? ', …' : ''}`);
    play(wav, env);
  } catch (e) {
    engine?.synth.close?.();
    log(`  test synthesis failed: ${e.message ?? e}`);
    log('  nothing saved — fix that, then run: decklight tts --setup');
    return null;
  }

  // 4. only a config that has spoken gets saved
  const file = saveTtsConfig(config, env);
  log(`  saved to ${file} — decklight tts and decklight author read it from now on`);
  return { config, engine };
}
