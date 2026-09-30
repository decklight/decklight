// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The talking-head setup, remembered (SPEC PRESENTING, character).
 *
 * Neural video needs four things decklight cannot find on its own: a Wav2Lip
 * (or SadTalker) checkout, its checkpoint, the Python that has its packages,
 * and a portrait. Passing them as flags to every `decklight author` is how
 * nobody ends up using the feature — so `decklight lipsync … --save` writes
 * them here once, the way the voice setup lives in `tts.json`, and the
 * lip-sync bridge, `author` and `doctor` all read the same file.
 *
 * `~/.config/decklight/lipsync.json` ($XDG_CONFIG_HOME honored):
 *   { wav2lipDir, wav2lipCkpt, sadtalkerDir, python, portraits: ["name=path", …] }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

export function lipsyncConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'decklight', 'lipsync.json');
}

/** The saved setup, or null — a missing or unreadable file is "not set up", not an error. */
export function loadLipsyncConfig(env = process.env) {
  try { return JSON.parse(readFileSync(lipsyncConfigPath(env), 'utf8')); }
  catch { return null; }
}

export function saveLipsyncConfig(config, env = process.env) {
  const file = lipsyncConfigPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** `alice=face.png` → ['alice', '/abs/face.png']; a bare path is named by its basename. */
export function parsePortrait(spec) {
  const at = String(spec).indexOf('=');
  const file = resolve(at > 0 ? spec.slice(at + 1) : spec);
  const name = at > 0 ? spec.slice(0, at) : basename(file, extname(file));
  return [name, file];
}

/**
 * What neural video can use, and what stands in the way — ONE answer, so the
 * bridge's startup line, the deck's character row and `doctor` never disagree.
 * `setup` is the flags-over-saved view: `{ wav2lipDir, wav2lipCkpt,
 * sadtalkerDir, python, portraits: [spec] }`. Returns
 * `{ engines: ['wav2lip'?, 'sadtalker'?], problems: [sentence…] }`.
 */
export function videoSetup(setup, { exists = existsSync } = {}) {
  const engines = [];
  const problems = [];
  const portraits = (setup?.portraits ?? []).map(parsePortrait);
  const missingPortraits = portraits.filter(([, f]) => !exists(f)).map(([n, f]) => `${n} (${f})`);
  if (missingPortraits.length) problems.push(`portrait not found: ${missingPortraits.join(', ')}`);
  const havePortrait = portraits.some(([, f]) => exists(f));
  const { wav2lipDir, wav2lipCkpt, sadtalkerDir } = setup ?? {};
  if (wav2lipDir) {
    if (!exists(join(wav2lipDir, 'inference.py'))) problems.push(`no Wav2Lip checkout at ${wav2lipDir} (inference.py is missing)`);
    else if (!wav2lipCkpt) problems.push('Wav2Lip needs its checkpoint: --wav2lip-ckpt <wav2lip_gan.pth>');
    else if (!exists(wav2lipCkpt)) problems.push(`Wav2Lip checkpoint not found: ${wav2lipCkpt}`);
    else if (havePortrait) engines.push('wav2lip');
  }
  if (sadtalkerDir) {
    if (!exists(join(sadtalkerDir, 'inference.py'))) problems.push(`no SadTalker checkout at ${sadtalkerDir} (inference.py is missing)`);
    else if (havePortrait) engines.push('sadtalker');
  }
  if ((wav2lipDir || sadtalkerDir) && !havePortrait && !missingPortraits.length) {
    problems.push('no portrait — add one: --portrait me=photo.jpg (a head-and-shoulders photo)');
  }
  if (setup?.python && setup.python.includes('/') && !exists(setup.python)) problems.push(`python not found: ${setup.python}`);
  return { engines, problems };
}

/** The one command that sets neural video up — said wherever it is missing. */
export const SETUP_HINT = 'decklight lipsync --wav2lip-dir <Wav2Lip checkout> --wav2lip-ckpt <wav2lip_gan.pth>'
  + ' --python <its venv python> --portrait me=<photo.jpg> --save';
