// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight setup — set up this machine's voice and face, once.
 *
 *   decklight setup voice                 the guided engine setup (was `tts --setup`)
 *   decklight setup face <flags>          remember a talking head (was `lipsync … --save`)
 *
 * The voice bridge and the lip-sync bridge are things `decklight <deck>`
 * starts, so they stopped being commands a person types (ROADMAP section 4):
 * `tts` and `lipsync` still run, because write mode spawns them and a deck
 * opened from a file still talks to a bridge run on its own, but they are out
 * of the help. What a person does type is the one-time setup, and it is a
 * setup: it saves the answers and stops, rather than going on to serve.
 */

import { createInterface } from 'node:readline/promises';
import { isMain } from '../tools/args.mjs';
import { runMain } from './util.mjs';

export const USAGE = `usage: decklight setup <voice | face> …

  decklight setup voice
    the guided setup for live narration: which engine (a system voice,
    piper, chirp, gemini, elevenlabs), what it needs, and one test sentence.
    The answers are saved; decklight <deck> uses them from then on.
    Run it again to change engine or voice.

  decklight setup voice [--engine E] [--voice V] [--project P] [--model M]
                        [--location L] [--lang en-US] [--format pcm|mp3]
                        [--stability creative|natural|robust] [--data-dir D]
    save exactly these, no questions: what used to be a flag on every
    decklight <deck> run. A new --engine drops the old engine's voice,
    model, format, stability and data dir.
    EXAMPLE: decklight setup voice --engine elevenlabs --model eleven_v3 --stability natural

  decklight setup face --portrait me=<photo.jpg | clip.mp4> [--wav2lip-dir <checkout>
                       --wav2lip-ckpt <wav2lip_gan.pth>] [--sadtalker-dir <checkout>]
                       [--python <its venv python>]
    remember a talking head for the narrator (V → Character): the portrait
    and the local lip-sync models. Saved; decklight <deck> starts the
    lip-sync bridge with it. A clip can also be filmed in the deck.
    Also saved when given: --cache-dir, --rhubarb, and --veo (animate the
    portrait through Vertex: BILLED once per portrait, then cached; --no-veo
    turns it off) with --veo-project, --veo-model, --veo-seconds,
    --veo-prompt, --veo-location, --veo-face-y.
`;

// `setup voice` flag → tts.json key. The settings tied to one engine are
// dropped when the engine changes, as the guided setup's answers are.
const VOICE_FLAGS = { '--engine': 'engine', '--voice': 'voice', '--project': 'project', '--model': 'model',
  '--location': 'location', '--lang': 'lang', '--format': 'format', '--stability': 'stability', '--data-dir': 'dataDir' };
const ENGINE_BOUND = ['voice', 'model', 'format', 'stability', 'dataDir'];

/** The voice settings given as flags, or null when none were (the guided setup runs). Pure. */
export function voiceSettings(args = []) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = VOICE_FLAGS[args[i]];
    if (key && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out[key] = args[++i];
  }
  return Object.keys(out).length ? out : null;
}

export async function setupMain(args = []) {
  const [what, ...rest] = args;
  if (!what || what === '--help' || what === '-h' || what === 'help') { console.log(USAGE); return what ? 0 : 1; }
  if (what === 'voice') {
    if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
    // Flags: save them as given, no questions. This is where a setting that
    // used to be a flag on `decklight <deck>` every run is now given once.
    const given = voiceSettings(rest);
    if (given) {
      const { loadTtsConfig, saveTtsConfig } = await import('../tools/tts-setup.mjs');
      const was = loadTtsConfig() ?? {};
      // engine-specific settings (voice, model, format, data dir, stability)
      // belong to the engine they were given for: a new engine starts clean
      const keepEngineBound = !given.engine || given.engine === was.engine;
      const base = keepEngineBound ? was
        : Object.fromEntries(Object.entries(was).filter(([k]) => !ENGINE_BOUND.includes(k)));
      const file = saveTtsConfig({ ...base, ...given });
      console.log(`saved to ${file}: ${Object.entries(given).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      console.log('  decklight <deck> uses it from now on (V in the deck)');
      return 0;
    }
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      console.error('decklight setup voice: needs a terminal to ask its questions on');
      return 1;
    }
    const { runSetupWizard, loadTtsConfig } = await import('../tools/tts-setup.mjs');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const done = await runSetupWizard({ ask: (q) => rl.question(q), prefill: loadTtsConfig() ?? {} });
      if (!done) return 1;
      // the wizard's test sentence may hold a resident engine (piper): let it go
      done.engine?.synth?.close?.();
      console.log('  decklight <deck> uses it from now on (V in the deck)');
      return 0;
    } finally { rl.close(); }
  }
  if (what === 'face') {
    if (rest.includes('--help') || rest.includes('-h') || !rest.length) { console.log(USAGE); return rest.length ? 0 : 1; }
    const { lipsyncMain } = await import('../tools/lipsync-server.mjs');
    await lipsyncMain([...rest.filter((a) => a !== '--save'), '--save']);
    return process.exitCode ?? 0;
  }
  console.error(`decklight setup: "${what}" is not something to set up — voice or face\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exitCode = await runMain('setup', setupMain);
