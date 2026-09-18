#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Voice-over generator: per-slide narration audio from a deck's speaker notes.
//
//   node tools/voiceover.mjs <deck.html> [-o <dir>] [--engine piper|chirp|gemini|elevenlabs]
//                            [--voice <name>] [--data-dir <dir>]
//                            [--project <id>] [--location global] [--lang en-US]
//                            [--tts-model gemini-2.5-pro-tts]
//                            [--reuse-text]
//                            [--keep-wav]  (keep the lossless intermediates —
//                                           tools/lipsync.mjs consumes them)
//
// Engines (tools/tts-engines.mjs — the same three the live bridge speaks with;
// the built-in macOS voices were dropped: not good enough):
//   piper  — neural local TTS, fully offline, unlimited, free. --voice takes a
//            piper model name (default en_US-ryan-high, a natural US male):
//              uv tool install piper-tts
//              uvx --from piper-tts python -m piper.download_voices en_US-ryan-high
//              (into --data-dir; a plain `python -m …` only works when piper was
//              pip-installed into the active environment, not `uv tool install`ed)
//   chirp  — Chirp 3: HD on the Cloud Text-to-Speech API. Same 30 star-named
//            voices as gemini, ~1s a sentence, and 1M characters a month free.
//            No --style: Chirp has no delivery-instruction channel.
//   gemini — gemini-2.5-{pro,flash}-tts on Vertex AI. The only engine that
//            honors --style (default: warm, welcoming battle-hardened senior
//            engineer). No free tier, and pro is slow.
//   elevenlabs — your ElevenLabs account's own voices, cloned ones included.
//            --voice takes the voice's NAME (or its id); omit it and the first
//            of YOUR voices is used, which is the point of the engine. Needs
//            $ELEVENLABS_API_KEY. No --style. --tts-format mp3 if your plan has
//            no PCM output — but this tool wants WAV (--keep-wav feeds
//            tools/lipsync.mjs), so pcm is the sane choice here.
//   Cloud engines: --project or $GOOGLE_CLOUD_PROJECT, auth via
//   gcloud auth application-default login.
//
// Pipeline: extract each slide's notes (HTML asides or markdown Note: blocks,
// ⟨CLICK⟩ markers removed) → synthesize them as written → a file per slide in
// the track's format + manifest.json. The pipeline itself is
// tools/narration-synth.mjs, which every producer of a track shares (#555);
// this file is its command line. --reuse-text re-voices the existing slide-NN.txt files, so a
// script edited by hand, or another voice or engine, narrates the same words.
// Audio is a build artifact, not source.
//
// Nothing here writes or rewrites the words. The notes ARE the script: a
// deck's content — its notes included — is written by the author or by the
// agent they ask (A in author mode, SPEC PRESENTING), and an agent that runs on
// a local model brings that model with it. A second writer here, voicing words
// nobody had read, was the wrong place for one.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createEngine } from './tts-engines.mjs';
import { createTtsCache } from './tts-cache.mjs';
import { argReader } from './args.mjs';
import { sectionBodies } from './deck-html.mjs';
import { parseSlideRange } from './video.mjs';
import { synthesizeSlides, readTrack, trackFormat, planLine, TRACK_FORMATS, DEFAULT_FORMAT } from './narration-synth.mjs';

const args = process.argv.slice(2);

const HELP = `decklight voiceover — batch-synthesize a deck's narration into a folder

Usage:
  decklight voiceover <deck.html> [-o <dir>] [--engine piper|chirp|gemini|elevenlabs]
                      [--voice <name>] [--format m4a|wav|mp3] [--reuse-text] [--keep-wav]
                      [--slides a-b] [--no-cache]

The headless counterpart of the deck's V → Record this deck…: it reads each slide's speaker
notes and writes one slide-NN file per slide (plus a file per ⟨CLICK⟩ beat)
and a manifest.json into <dir>, so a deck can point at it with
narration: { files: [{ label, dir, segments: true }] }.

A folder that already holds a track is REFRESHED as that track: its engine,
voice, style and format are the defaults, so voicing one stale slide of a track
the deck's recorder made writes wav in the same voice, beside the rest. A flag
overrides any of them; a --slides run in another voice is refused, since a
track has one voice.

  -o <dir>       output folder (default: <deck>/voiceover)
  --engine       piper (local, free, default) · chirp · gemini · elevenlabs
  --voice        the engine's voice name (piper: a model name; elevenlabs: omit
                 for the first of YOUR voices)
  --format       m4a (default for a new track) · wav · mp3 (an existing track
                 keeps its own)
  --reuse-text   re-voice the existing slide-NN.txt (edit one to change what is
                 said) — switch voices or engines on the same script
  --keep-wav     keep the lossless WAVs of an m4a/mp3 track (tools/lipsync.mjs
                 consumes them)
  --slides a-b   voice only this range (1-based, inclusive; "7" for one slide)
                 — every other slide's files and manifest entry are left alone
  --no-cache     re-synthesize every slide, ignoring the shared clip cache

Synthesis is cached on disk (~/.cache/decklight/tts) under a key made of
(engine, model, format, voice, style, text) — the SAME key the live bridge
uses, so a sentence you previewed in the deck is recorded here for free
instead of being billed a second time.

Cloud engines need --project or $GOOGLE_CLOUD_PROJECT and application-default
credentials; elevenlabs needs $ELEVENLABS_API_KEY. Audio is a build artifact.`;

if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
// Every option voiceover takes, and nothing else. It used to accept anything
// that started with a dash and ignore whatever it did not read, so a removed or
// mistyped flag was dropped without a word and the run went ahead doing
// something else. The value options are listed apart because the token after
// one is its VALUE, not the deck — which is also how `-o out deck.html` used to
// take `out` for the deck.
const VALUE_OPTIONS = new Set(['-o', '--engine', '--voice', '--style', '--data-dir', '--project',
  '--location', '--lang', '--tts-model', '--tts-format', '--slides', '--format']);
const SWITCHES = new Set(['--reuse-text', '--keep-wav', '--no-cache']);
let deckPath;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_OPTIONS.has(a)) { i++; continue; }
  if (SWITCHES.has(a)) continue;
  if (a.startsWith('-')) {
    console.error(`decklight voiceover: unknown option ${a} — see decklight voiceover --help`);
    process.exit(1);
  }
  deckPath ??= a;
}
if (!deckPath) { console.error('decklight voiceover: name the deck to voice\n\n' + HELP); process.exit(1); }
const { opt } = argReader(args);
// before the engine and encoder probes: a mistyped deck or a range past its end
// is not a missing ffmpeg
if (!existsSync(deckPath)) { console.error(`decklight voiceover: no deck at ${deckPath}`); process.exit(1); }
const html = readFileSync(deckPath, 'utf8');
let range;
try { range = parseSlideRange(opt('--slides'), sectionBodies(html).length); } catch (e) {
  console.error(`decklight voiceover: ${e.message}`);
  process.exit(1);
}
const outDir = resolve(opt('-o', join(resolve(deckPath, '..'), 'voiceover')));

// The track already in the folder, if any, and what it was voiced with: the
// defaults for everything a flag does not say. Refreshing a track is voicing it
// AS that track — the voice its other slides speak in, the format its files
// are in — not re-voicing it in whatever this command defaults to (#555).
const prev = readTrack(outDir);
const engine = opt('--engine', prev?.engine ?? 'piper');
const track = prev?.engine === engine ? prev : null;   // its header speaks for THIS engine only
// elevenlabs has no default name worth guessing: the roster is the account's,
// and undefined means "the first of yours", which is what you came for
const voice = opt('--voice', track ? track.voice : engine === 'piper' ? 'en_US-ryan-high'
  : engine === 'elevenlabs' ? undefined : 'Alnilam');
const style = opt('--style', track?.style ??
  'Read in a warm, welcoming tone, like a friendly battle-hardened senior ' +
  'engineer who is still curious about new technology.');
// the model is identity only where the engine has more than one per voice
const model = opt('--tts-model', track?.model != null && (engine === 'elevenlabs' || engine === 'gemini') ? track.model : undefined);
const format = opt('--format', trackFormat(prev) ?? DEFAULT_FORMAT);
if (!TRACK_FORMATS.includes(format)) {
  console.error(`decklight voiceover: --format is ${TRACK_FORMATS.join(', ')}, not ${format}`);
  process.exit(1);
}
const dataDir = resolve(opt('--data-dir', join(homedir(), '.local', 'share', 'piper')));
const project = opt('--project', process.env.GOOGLE_CLOUD_PROJECT);

// one factory, every engine — the same ones the live bridge speaks with
let tts;
try {
  tts = createEngine({
    engine, project, voice, dataDir, model,
    location: opt('--location'), lang: opt('--lang'), format: opt('--tts-format'),
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// `· N to voice` closes the line because the author server reads it: an export
// that voices its slides first counts them off against this number.
console.log(planLine(basename(deckPath), html, range, !!opt('--slides')));
const reuseTextFrom = args.includes('--reuse-text')
  // falls back to the deck's default voiceover/ scripts so a second take
  // (other engine/voice) narrates the SAME text, not a re-roll
  ? [outDir, join(resolve(deckPath, '..'), 'voiceover')]
  : [];
try {
  const cache = createTtsCache({ enabled: !args.includes('--no-cache') });
  cache.prune();
  const { skipped, cost } = await synthesizeSlides({
    html, dir: outDir, tts, voice, style, format,
    range: opt('--slides') ? range : null, prev, cache, reuseTextFrom,
    keepWav: args.includes('--keep-wav'),
  });
  console.log(`done → ${outDir}${skipped ? ` (${skipped} unchanged, skipped)` : ''}`
    + (cost ? ` · estimated cost ~$${cost.toFixed(4)}` : ''));
} catch (e) {
  console.error(`decklight voiceover: ${e.message}`);
  process.exitCode = 1;
} finally {
  // piper is held resident (§ createPiper) — without this the tool prints
  // `done` and then hangs on the live child process
  tts.synth.close?.();
}
