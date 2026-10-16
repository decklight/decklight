// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight narrate — put the deck's narration into a folder beside it.
 *
 *   decklight narrate <deck.html> [--engine E] [--voice V] [--format F] [--slides a-b] [--dir NAME]
 *   decklight narrate <deck.html> --mic [--slides a-b] [--dir NAME] [--port N] [--remote] [--no-open]
 *   decklight narrate <deck.html> --face [--video] [--dir NAME]
 *
 * One command for the two ways a deck gets a recorded voice: an engine reads
 * the notes (what `decklight voiceover` did), or you do, into the microphone,
 * one [click] beat at a time (what `decklight record` did). Both write the
 * same files into the same folder, the deck's own `narration.files` or
 * `voiceover/`, and both refresh only `--slides` when asked. They were two
 * commands with two spellings of the folder (`-o PATH` and `--dir NAME`) and
 * a help that had to say which one was not `cast` (ROADMAP section 4).
 *
 * The implementations stay where they were: tools/voiceover.mjs (spawned: it
 * parses its argv at load) and cli/record.mjs. This is the grammar in front.
 * `video --voiceover` stays a flag of `video`, and `enhance` rewrites the
 * script rather than voicing it, so neither is here.
 *
 * `--face` is the third: the narration already in the folder gets the
 * character's lip-sync (tools/lipsync.mjs, which had no command). It never
 * voices anything, so a take recorded at the microphone cannot be replaced by
 * an engine on the way to getting a face; voice first, then `--face`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstPositional, isMain } from '../tools/args.mjs';
import { runMain, wrongRecorder } from './util.mjs';
import { configuredTrackDirs } from './edit.mjs';

const VOICEOVER = fileURLToPath(new URL('../tools/voiceover.mjs', import.meta.url));
const LIPSYNC = fileURLToPath(new URL('../tools/lipsync.mjs', import.meta.url));
// the flags either side takes a value for, so the deck is found past them
const VALUE_FLAGS = new Set(['-o', '--dir', '--engine', '--voice', '--style', '--data-dir', '--project',
  '--format', '--slides', '--beats', '--port', '--model', '--lang', '--location', '--tts-format', '--tts-stability',
  '--rhubarb', '--portrait', '--python', '--wav2lip-dir', '--wav2lip-ckpt', '--sadtalker-dir',
  '--veo-project', '--veo-location', '--veo-model', '--veo-seconds', '--veo-prompt', '--veo-face-y']);

export const USAGE = `usage: decklight narrate <deck.html> [--mic] [--slides a-b] [--dir NAME] …

  writes the deck's narration into a folder beside it: one slide-NN file per
  slide and one per [click] beat, which the deck then plays

  an engine reads the notes                       (the default)
    --engine E   piper (local, free) · chirp · gemini · elevenlabs · a native voice
    --voice V    the engine's voice name
    --format F   m4a (a new track's default) · wav · mp3
    --reuse-text, --keep-wav, --no-cache          (decklight narrate <deck> --help --engine)
    EXAMPLE: decklight narrate talk.html --engine chirp --voice Achernar

  you read the notes, into the microphone
    --mic        serves the deck on http://127.0.0.1 (a microphone needs it) and
                 opens it with the recorder up; → ends a beat and reveals the
                 next build, so your voice paces the deck as it will be presented
    --beats k-l  with --slides N: only these beats of slide N; the others are kept
    --remote     the phone remote too: its next ends a beat, its retake redoes one,
                 so no keystroke gets into the take
    --port N, --no-open
    EXAMPLE: decklight narrate talk.html --mic

  either way, an engine or the microphone
    --slides a-b only these slides; every other slide's files are left alone
    --dir NAME   the folder, relative to the deck
                 [an engine: its narration.files, else voiceover · --mic: voices/me]

  the character mouths what is already there                (--face)
    --face       lip-sync for every slide and [click] beat in the folder, which the
                 character plays with no bridge running; voices nothing, so voice first
    --video      a talking-head clip per slide too (SadTalker or Wav2Lip, slow)
    uses what decklight setup face saved: rhubarb, the portrait, the engine, Veo
    --rhubarb, --portrait NAME|FILE, --engine sadtalker|wav2lip, --no-veo   for this run only
    --dir NAME   only this folder  [every one the deck's narration.files names]
    EXAMPLE: decklight narrate talk.html --face

  is the narration still the notes?                        (--check)
    --check      every track beside the deck, slide by slide: in step, the words
                 changed, or (your own voice) only the [click] split moved, which
                 a recording cannot follow; each with the command that fixes it.
                 Exits 1 when something is out of step
    --dir NAME   only this folder
    EXAMPLE: decklight narrate talk.html --check

  the deck plays the folder back with
    narration: { files: '<dir>', segments: true }            (wav: ext: 'wav')
`;

/**
 * The argv for the side that does the work. Pure, so the folder translation
 * (`--dir NAME` relative to the deck, `-o PATH` from here) is testable.
 */
export function narratePlan(argv = [], cwd = process.cwd()) {
  const mic = argv.includes('--mic');
  const args = argv.filter((a) => a !== '--mic');
  const deck = firstPositional(args, VALUE_FLAGS);
  const deckDir = deck ? dirname(resolve(cwd, deck)) : cwd;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir' || a === '-o') {
      const v = args[++i];
      if (v === undefined) { out.push(a); continue; }
      const abs = isAbsolute(v) ? v : (a === '--dir' ? join(deckDir, v) : resolve(cwd, v));
      // the recorder names its folder relative to the deck; the synthesizer takes a path
      if (mic) out.push('--dir', relative(deckDir, abs) || '.');
      else out.push('-o', abs);
      continue;
    }
    out.push(a);
  }
  return { mic, deck, args: out };
}

/** Audio a track folder holds: `slide-NN.wav|m4a`, the whole slide or one beat. */
const hasAudio = (dir) => existsSync(dir) && readdirSync(dir).some((f) => /^slide-\d+(?:-\d+)?\.(wav|m4a)$/.test(f));

/**
 * The folders `--face` cuts sidecars into: `--dir NAME`, else every local
 * folder the deck's `narration.files` names, else `voiceover/`. A folder
 * without audio is skipped, but only when the deck chose it; one named by
 * `--dir` that has nothing in it is the caller's mistake and is reported.
 */
export function faceFolders(deckPath, html, dirArg) {
  const deckDir = dirname(resolve(deckPath));
  if (dirArg) return [resolve(deckDir, dirArg)];
  const named = configuredTrackDirs(html).filter((d) => !/^[a-z][a-z0-9+.-]*:/i.test(d));
  const dirs = (named.length ? named : ['voiceover']).map((d) => resolve(deckDir, d));
  return [...new Set(dirs)].filter(hasAudio);
}

/**
 * `--face`: the deck's narration folders, each through tools/lipsync.mjs.
 * `--slides` is refused rather than ignored: the batch is incremental by
 * audio hash, so a rerun already touches only what changed.
 */
function faceMain(plan, argv) {
  if (plan.mic) { console.error('decklight narrate: --face gives a recorded track its lip-sync; record it first (--mic), then run --face'); return 2; }
  if (argv.includes('--slides')) { console.error('decklight narrate: --face takes no --slides; a rerun only redoes the slides whose audio changed'); return 2; }
  if (!plan.deck || !existsSync(plan.deck)) { console.error(`decklight narrate: ${plan.deck ? `no deck at ${plan.deck}` : 'name the deck'}`); return 1; }
  const html = readFileSync(plan.deck, 'utf8');
  const dirAt = argv.indexOf('--dir');
  const dirArg = dirAt === -1 ? null : argv[dirAt + 1];
  const folders = faceFolders(plan.deck, html, dirArg);
  if (!folders.length || (dirArg && !hasAudio(folders[0]))) {
    console.error(`decklight narrate: no narration to give a face to${dirArg ? ` in ${dirArg}` : ''}; `
      + `voice it first: decklight narrate ${plan.deck}`);
    return 1;
  }
  // everything else passes through: the folder goes first, and the deck,
  // --face and --dir NAME are this command's, not the tool's
  const deckAt = argv.indexOf(plan.deck);
  const rest = argv.filter((a, i) => i !== deckAt && a !== '--face' && (dirAt === -1 || (i !== dirAt && i !== dirAt + 1)));
  for (const dir of folders) {
    const r = spawnSync(process.execPath, [LIPSYNC, dir, ...rest], { stdio: 'inherit' });
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

/**
 * The track folders beside a deck that carry a manifest: the same two levels
 * the edit server's track list walks (`voices/<voice>`), relative to the deck.
 */
export function manifestTracks(deckDir) {
  const out = [];
  const look = (rel) => {
    let entries;
    try { entries = readdirSync(join(deckDir, rel), { withFileTypes: true }); } catch { return []; }
    if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) out.push(rel);
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
  };
  for (const e of look('.')) {
    for (const k of look(e.name)) look(`${e.name}/${k.name}`);
  }
  return out.filter((d) => d !== '.');
}

/**
 * `--check` (#850): each track against the deck's notes, said per slide, with
 * the re-record line. A track recorded by hand before a manifest existed has
 * nothing to compare and is named as unchecked rather than passed.
 */
async function checkMain(plan, argv) {
  if (!plan.deck || !existsSync(plan.deck)) { console.error(`decklight narrate: ${plan.deck ? `no deck at ${plan.deck}` : 'name the deck'}`); return 1; }
  const { trackDrift, rerecordLine } = await import('../tools/narration-manifest.mjs');
  const html = readFileSync(plan.deck, 'utf8');
  const deckDir = dirname(resolve(plan.deck));
  const dirAt = argv.indexOf('--dir');
  const dirs = dirAt === -1 ? manifestTracks(deckDir) : [argv[dirAt + 1]];
  let out = 0;
  if (!dirs.length) { console.log('no narration track with a manifest beside this deck — nothing to check'); return 0; }
  for (const dir of dirs) {
    let m = null;
    try { m = JSON.parse(readFileSync(join(deckDir, dir, 'manifest.json'), 'utf8')); } catch { /* reported below */ }
    if (!Array.isArray(m?.slides)) { console.log(`${dir}/  no manifest: recorded before decklight kept one, not checked`); continue; }
    const mine = m.recorder === 'mic';
    const who = mine ? 'your voice' : [m.voice, m.engine].filter(Boolean).join(' · ') || 'recorded';
    const { drift, unknown } = trackDrift(m, html);
    const note = unknown ? ` (${unknown} slide${unknown === 1 ? '' : 's'} recorded before the script was kept: not checked)` : '';
    if (!drift.length) { console.log(`${dir}/  ${who}: in step with the notes${note}`); continue; }
    out = 1;
    console.log(`${dir}/  ${who}: ${drift.length} slide${drift.length === 1 ? '' : 's'} out of step${note}`);
    for (const d of drift) {
      console.log(d.why === 'clicks'
        ? `  slide ${d.slide}: the [click] split moved${d.was !== d.now ? ` (${d.was} beats → ${d.now})` : ''}, the words did not`
          + (mine ? ' — a recorded beat is cut where you pressed →, so the marker alone cannot move a build' : '')
        : `  slide ${d.slide}: the notes changed since it was recorded`);
      console.log(`    ${rerecordLine(plan.deck, dir, [d.slide], { mine })}`);
    }
  }
  return out;
}

export async function narrateMain(argv = []) {
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (!argv.length || (wantsHelp && !argv.includes('--engine') && !argv.includes('--mic'))) {
    console.log(USAGE);
    return argv.length ? 0 : 1;
  }
  const plan = narratePlan(argv);
  if (argv.includes('--check')) return checkMain(plan, argv);
  if (argv.includes('--face')) return faceMain(plan, argv);
  // a terminal script is `cast`'s, whichever way it was meant to be narrated
  const mixedUp = wrongRecorder('narrate', plan.deck);
  if (mixedUp) { console.error(mixedUp); return 2; }   // the code record and cast give it
  // an engine re-voices a slide from its notes in seconds; --beats exists
  // because reading a slide aloud again is what costs
  if (!plan.mic && argv.includes('--beats')) {
    console.error('decklight narrate: --beats re-records beats of your own voice; it goes with --mic');
    return 2;
  }
  if (plan.mic) {
    const { recordMain } = await import('./record.mjs');
    return recordMain(plan.args);
  }
  // spawned, exactly as `video --voiceover` spawns it: voiceover.mjs parses its
  // argv and exits at load. stdio inherited: its per-slide progress and cost
  // lines are the point of running it in a terminal.
  const r = spawnSync(process.execPath, [VOICEOVER, ...plan.args], { stdio: 'inherit' });
  return r.status ?? 1;
}

if (isMain(import.meta.url)) process.exitCode = await runMain('narrate', narrateMain);
