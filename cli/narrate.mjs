// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight narrate — put the deck's narration into a folder beside it.
 *
 *   decklight narrate <deck.html> [--engine E] [--voice V] [--format F] [--slides a-b] [--dir NAME]
 *   decklight narrate <deck.html> --mic [--slides a-b] [--dir NAME] [--port N] [--no-open]
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
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstPositional, isMain } from '../tools/args.mjs';
import { runMain, wrongRecorder } from './util.mjs';

const VOICEOVER = fileURLToPath(new URL('../tools/voiceover.mjs', import.meta.url));
// the flags either side takes a value for, so the deck is found past them
const VALUE_FLAGS = new Set(['-o', '--dir', '--engine', '--voice', '--style', '--data-dir', '--project',
  '--format', '--slides', '--port', '--model', '--lang', '--location', '--tts-format', '--tts-stability']);

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
    --port N, --no-open
    EXAMPLE: decklight narrate talk.html --mic

  either way
    --slides a-b only these slides; every other slide's files are left alone
    --dir NAME   the folder, relative to the deck  [its narration.files, else voiceover]

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

export async function narrateMain(argv = []) {
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (!argv.length || (wantsHelp && !argv.includes('--engine') && !argv.includes('--mic'))) {
    console.log(USAGE);
    return argv.length ? 0 : 1;
  }
  const plan = narratePlan(argv);
  // a terminal script is `cast`'s, whichever way it was meant to be narrated
  const mixedUp = wrongRecorder('narrate', plan.deck);
  if (mixedUp) { console.error(mixedUp); return 2; }   // the code record and cast give it
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
