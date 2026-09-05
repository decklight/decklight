#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Voice-over generator: per-slide narration audio from a deck's speaker notes.
//
//   node tools/voiceover.mjs <deck.html> [-o <dir>] [--engine piper|chirp|gemini|elevenlabs]
//                            [--voice <name>] [--data-dir <dir>]
//                            [--project <id>] [--location global] [--lang en-US]
//                            [--tts-model gemini-2.5-pro-tts]
//                            [--model qwen3:30b-a3b] [--no-llm] [--reuse-text]
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
// ⟨CLICK⟩ markers removed) → optionally rewrite into flowing narration with a
// LOCAL Ollama model (LLMs write text; they don't speak) → synthesize → AAC
// .m4a per slide + manifest.json. --reuse-text skips the LLM pass and
// re-voices the existing slide-NN.txt files, so switching voices or engines
// doesn't re-roll the narration. Audio is a build artifact, not source.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createEngine } from './tts-engines.mjs';
import { clipKey, createTtsCache, extFor } from './tts-cache.mjs';
import { argReader } from './args.mjs';
import { sectionBodies, NOTES_ASIDE, cleanNotes, notesSegments } from './deck-html.mjs';
import { run, PROBE_MS, CODEC_MS } from './exec.mjs';

const args = process.argv.slice(2);

const HELP = `decklight voiceover — batch-synthesize a deck's narration into a folder

Usage:
  decklight voiceover <deck.html> [-o <dir>] [--engine piper|chirp|gemini|elevenlabs]
                      [--voice <name>] [--no-llm] [--reuse-text] [--keep-wav]
                      [--no-cache]

The headless counterpart of the deck's V \u2192 Record this deck\u2026: it reads each slide's speaker
notes and writes one slide-NN.m4a per slide (plus a file per \u27e8CLICK\u27e9 beat)
and a manifest.json into <dir>, so a deck can point at it with
narration: { files: [{ label, dir, segments: true }] }.

  -o <dir>       output folder (default: <deck>/voiceover)
  --engine       piper (local, free, default) · chirp · gemini · elevenlabs
  --voice        the engine's voice name (piper: a model name; elevenlabs: omit
                 for the first of YOUR voices)
  --no-llm       skip the local-LLM notes rewrite; voice the notes as written
  --reuse-text   re-voice the existing slide-NN.txt without re-rolling the text
                 — switch voices or engines without a new narration pass
  --keep-wav     keep the lossless WAVs (tools/lipsync.mjs consumes them)
  --no-cache     re-synthesize every slide, ignoring the shared clip cache

Synthesis is cached on disk (~/.cache/decklight/tts) under a key made of
(engine, model, format, voice, style, text) — the SAME key the live bridge
uses, so a sentence you previewed in the deck is recorded here for free
instead of being billed a second time.

Cloud engines need --project or $GOOGLE_CLOUD_PROJECT and application-default
credentials; elevenlabs needs $ELEVENLABS_API_KEY. Audio is a build artifact.`;

if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
const deckPath = args.find((a) => !a.startsWith('-'));
if (!deckPath) { console.error('decklight voiceover: name the deck to voice\n\n' + HELP); process.exit(1); }
const { opt } = argReader(args);
const outDir = resolve(opt('-o', join(resolve(deckPath, '..'), 'voiceover')));
const engine = opt('--engine', 'piper');
// elevenlabs has no default name worth guessing: the roster is the account's,
// and undefined means "the first of yours", which is what you came for
const voice = opt('--voice', engine === 'piper' ? 'en_US-ryan-high'
  : engine === 'elevenlabs' ? undefined : 'Alnilam');
const style = opt('--style',
  'Read in a warm, welcoming tone, like a friendly battle-hardened senior ' +
  'engineer who is still curious about new technology.');
const dataDir = resolve(opt('--data-dir', join(homedir(), '.local', 'share', 'piper')));
const project = opt('--project', process.env.GOOGLE_CLOUD_PROJECT);
const model = opt('--model', 'qwen3:30b-a3b');
const useLlm = !args.includes('--no-llm');
const reuseText = args.includes('--reuse-text');
const keepWav = args.includes('--keep-wav');
const useCache = !args.includes('--no-cache');

// one factory, three engines — the same ones the live bridge speaks with
let tts;
try {
  tts = createEngine({
    engine, project, voice, dataDir,
    model: opt('--tts-model'), location: opt('--location'), lang: opt('--lang'),
    format: opt('--tts-format'),
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// WAV → AAC. ffmpeg everywhere; afconvert is Core Audio, so it only exists on
// macOS — probing in that order keeps this working off a Mac (as tools/lipsync.mjs
// already does), and both engines' output goes through here.
const have = (bin, flags = ['-version']) => {
  try { run(bin, flags, { stdio: 'ignore', timeout: PROBE_MS }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
};
const encoder = have('ffmpeg') ? 'ffmpeg' : have('afconvert') ? 'afconvert' : null;
if (!encoder) {
  console.error('no AAC encoder — install ffmpeg (apt install ffmpeg / brew install ffmpeg)');
  process.exit(1);
}
const toAac = (wav, m4a) => run(encoder, encoder === 'ffmpeg'
  ? ['-y', '-i', wav, '-c:a', 'aac', '-b:a', '128k', m4a]
  : ['-f', 'm4af', '-d', 'aac', wav, m4a], { stdio: 'ignore', timeout: CODEC_MS, why: 'the encoder is stuck on this file — check it plays, then retry' });

// ── extract per-slide narration text ─────────────────────────────────────────
const html = readFileSync(deckPath, 'utf8');
const sections = sectionBodies(html);
const raw = sections.map((sec) => {
  const aside = sec.match(NOTES_ASIDE);
  if (aside) return aside[1];
  const md = sec.match(/^Note:\s*$([\s\S]*?)(?=^Rehearse:\s*$|<\/script>)/m);
  return md ? md[1] : '';
});
const slides = raw.map(cleanNotes);
/**
 * A slide's ⟨CLICK⟩ segments, or null when there is only one.
 *
 * These are the author's own build cues, and the sync rule they carry already
 * ships: src/core/narration.js speaks segment k over build step k in live
 * playback, and captions, rehearse mode and the notes editor all read the same
 * segmentation. Recording them separately is what lets a rendered mp4 mirror
 * that (SPEC PRESENTING). An empty segment is dropped rather than synthesised
 * as silence — a ⟨CLICK⟩ at the very start or end of a note is punctuation,
 * not a beat.
 */
// Segmenting needs ffmpeg specifically: the per-slide file is CONCATENATED from
// the segments, and afconvert (Core Audio, macOS-only) has no concat demuxer.
// Without it the slide is synthesised whole, exactly as before.
const canSegment = encoder === 'ffmpeg';
const segmented = raw.map((r) => (canSegment ? notesSegments(r) : null));
if (!canSegment && raw.some((r) => notesSegments(r))) {
  console.log('  note: ⟨CLICK⟩ segments need ffmpeg to concatenate — narrating each slide whole');
}
console.log(`${basename(deckPath)}: ${slides.length} slides, ${slides.filter(Boolean).length} with notes`);

// ── optional narration pass through a local model ────────────────────────────
function narrate(text, slideNo) {
  if (!useLlm || !text) return text;
  const prompt =
    'Rewrite these presentation speaker notes as a single flowing voice-over ' +
    'narration paragraph. Natural spoken English, roughly the same length, no ' +
    'headings, no stage directions, no markdown, plain text only. Notes: ' +
    text + ' /no_think';
  try {
    const out = execFileSync('ollama', ['run', model, prompt], { encoding: 'utf8', timeout: 180000 });
    const cleaned = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return cleaned || text;
  } catch (e) {
    console.warn(`  slide ${slideNo}: ollama failed (${String(e).slice(0, 60)}) — using raw notes`);
    return text;
  }
}

// ── synthesize ────────────────────────────────────────────────────────────────
// TWO layers of reuse, and they answer different questions.
//
// The MANIFEST answers "is this folder already correct?" — a hash per slide,
// so a rerun re-synthesizes only the slides whose narration actually changed
// and leaves the rest of the .m4a files alone.
//
// The CLIP CACHE (tools/tts-cache.mjs) answers "has anyone, ever, paid for
// these exact words?" — it is keyed by content rather than by folder, so it
// survives a different -o, a deleted manifest, and above all the process
// boundary: the live bridge fills the same cache while you preview the deck,
// and this run collects it. An ElevenLabs deck used to be billed twice for
// that, once in the browser and once here.
//
// Both keys carry the same fields, and the reason is one bug rather than two:
// anything that changes the AUDIO must change the key. `model` is in them
// because `--tts-model eleven_v3` is a different voice performance of the same
// words, and a hash without it skipped the slide and kept the old take. STYLE
// is in them only when the engine can act on it — every engine but gemini and
// ElevenLabs v3 ignores the instruction entirely, and letting a style the
// engine never read change the hash would miss the bridge's own clip for no
// audible reason.
mkdirSync(outDir, { recursive: true });
let totalCost = 0;
const audioExt = extFor(tts.synth.mimeType ?? 'audio/wav');
const clips = createTtsCache({ enabled: useCache });
clips.prune();
// `--voice` omitted on ElevenLabs means "the first of your voices", and the
// deck's picker offers that same roster in that same order — so the name is
// resolved HERE, for the key. Left undefined it would hash differently from
// the identical sentence the bridge just synthesized, and the cross-process
// reuse this cache exists for would silently never hit.
let keyVoice = voice;
if (!keyVoice && tts.listVoices) {
  try { keyVoice = (await tts.listVoices())[0]?.name; } catch { /* keep it undefined */ }
}

/** `tts.synth`, but a sentence anyone has already paid for is free. */
async function synth(text) {
  const key = clipKey(tts, { voice: keyVoice, style, text });
  const hit = clips.read(key, audioExt);
  if (hit) return { wav: hit, usage: { chars: 0, cost: 0 }, cached: true };
  const out = await tts.synth(text, { voice, style });
  clips.write(key, out.wav, audioExt);
  return { ...out, cached: false };
}
// The manifest hash is the CLIP KEY, shortened: one definition of "the same
// audio", so the folder-level skip and the content-level cache can never
// disagree about whether a slide changed.
const slideHash = (text) => clipKey(tts, { voice: keyVoice, style, text }).slice(0, 16);
// ONE-TIME MIGRATION. The hash above gained `model` and lost the style no
// engine reads, so every folder recorded before this change hashes differently
// — and a folder that hashes differently is re-synthesized in full. That audio
// is not stale; it is exactly what today's key describes, and re-rolling it
// would hand an ElevenLabs user a bill for clips already on their disk.
//
// So a slide matching the OLD formula is accepted once and re-stamped. The
// gate is `prev.model === undefined`: only a manifest written before this
// change lacks that field, so the allowance cannot be claimed twice, and a
// later `--tts-model` switch is a genuine miss again. The one case it lets
// through is changing the model in the SAME run as the upgrade — narrow, and
// `--no-cache` is the way out of it.
const legacyHash = (text) => createHash('sha256')
  .update(`${engine}|${voice}|${style}|${text}`).digest('hex').slice(0, 16);
const preDatesModel = (m) => m && m.model === undefined
  && m.engine === engine && m.voice === voice && m.style === style;
let prev = null;
try {
  const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  if (m && Array.isArray(m.slides)) prev = m;
} catch { /* no previous manifest, or the old array format: regenerate all */ }
let skipped = 0;
const manifest = [];
for (let i = 0; i < slides.length; i++) {
  const n = String(i + 1).padStart(2, '0');
  if (!slides[i]) { manifest.push(null); continue; }
  const txt = join(outDir, `slide-${n}.txt`);
  // --reuse-text falls back to the deck's default voiceover/ scripts so a
  // second take (other engine/voice) narrates the SAME text, not a re-roll
  const prior = [txt, join(resolve(deckPath, '..'), 'voiceover', `slide-${n}.txt`)]
    .find((f) => reuseText && existsSync(f));
  const text = prior ? readFileSync(prior, 'utf8').trim() : narrate(slides[i], i + 1);
  const wav = join(outDir, `slide-${n}.wav`);
  const m4a = join(outDir, `slide-${n}.m4a`);
  writeFileSync(txt, text);
  const hash = slideHash(text);
  manifest.push({ file: `slide-${n}.m4a`, hash });
  const stamped = prev?.slides?.[i]?.hash;
  if ((stamped === hash || (preDatesModel(prev) && stamped === legacyHash(text))) && existsSync(m4a)) {
    // Carry the segments across, or an unchanged slide loses its build sync on
    // the next rerun: the audio is still on disk and the manifest is the only
    // thing that knows it is there.
    const kept = prev.slides[i].segments;
    if (kept?.every((sg) => existsSync(join(outDir, sg.file)))) manifest[i].segments = kept;
    skipped++;
    console.log(`  slide ${n}: unchanged — kept${manifest[i].segments ? ` (${manifest[i].segments.length} segments)` : ''}`);
    continue;
  }
  // A segmented slide is synthesised segment by segment, and the per-slide file
  // is CONCATENATED from those — one synthesis, both shapes. TTS is billed per
  // character; asking for the same words twice to get the same audio cut two
  // ways would be a bill nobody agreed to. --reuse-text takes the whole-slide
  // path, since its prior text is one script rather than segments.
  const segs = prior ? null : segmented[i];
  let usage = { cost: 0 };
  let cachedBeats = 0;
  if (segs) {
    const parts = [];
    for (let k = 0; k < segs.length; k++) {
      const kk = String(k + 1).padStart(2, '0');
      const sWav = join(outDir, `slide-${n}-${kk}.wav`);
      const sM4a = join(outDir, `slide-${n}-${kk}.m4a`);
      const out = await synth(segs[k]);
      if (out.cached) cachedBeats++;
      writeFileSync(sWav, out.wav);
      // The beat's own words, beside its own audio — tools/lipsync.mjs hands
      // this to Rhubarb as the dialog hint, and a hint for the whole slide
      // would be worse than none against one beat of it.
      writeFileSync(join(outDir, `slide-${n}-${kk}.txt`), segs[k]);
      usage = { cost: usage.cost + (out.usage?.cost ?? 0) };
      toAac(sWav, sM4a);
      if (!keepWav) rmSync(sWav);
      parts.push({ file: `slide-${n}-${kk}.m4a`, path: sM4a });
    }
    const list = join(outDir, `slide-${n}.concat`);
    writeFileSync(list, `${parts.map((p) => `file '${p.path.replaceAll("'", "'\\''")}'`).join('\n')}\n`);
    run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', m4a],
      { stdio: 'ignore' });
    rmSync(list, { force: true });
    manifest[i].segments = parts.map((p) => ({ file: p.file }));
  } else {
    const out = await synth(text);
    if (out.cached) cachedBeats++;
    writeFileSync(wav, out.wav);
    usage = out.usage ?? { cost: 0 };
    toAac(wav, m4a);
    if (!keepWav) rmSync(wav);
  }
  totalCost += usage.cost ?? 0;
  const costNote = usage.cost ? ` · ~$${usage.cost.toFixed(4)}` : '';
  // "cached" is worth a word: on a paid engine it is the difference between a
  // rerun that costs nothing and one that quietly re-bills the whole deck
  const cacheNote = cachedBeats
    ? ` · ${segs ? `${cachedBeats}/${segs.length} ` : ''}cached`
    : '';
  console.log(`  slide ${n}: ${text.length} chars → ${basename(m4a)}`
    + `${segs ? ` (${segs.length} ⟨CLICK⟩ segments)` : ''}${cacheNote}${costNote}`);
  // crash-safe: persist progress after every slide so an interrupted run
  // resumes incrementally instead of re-synthesizing everything
  writeFileSync(join(outDir, 'manifest.json'),
    JSON.stringify({ engine, model: tts.model ?? null, voice, style, slides: manifest }, null, 1));
}
writeFileSync(join(outDir, 'manifest.json'),
  JSON.stringify({ engine, model: tts.model ?? null, voice, style, slides: manifest }, null, 1));
// piper is held resident (§ createPiper) — without this the tool prints `done`
// and then hangs on the live child process
tts.synth.close?.();
console.log(`done → ${outDir}${skipped ? ` (${skipped} unchanged, skipped)` : ''}`
  + (totalCost ? ` · estimated cost ~$${totalCost.toFixed(4)}` : ''));
