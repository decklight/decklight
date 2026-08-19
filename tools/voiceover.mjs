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
import { argReader } from './args.mjs';
import { sectionBodies, NOTES_ASIDE, cleanNotes, notesSegments } from './deck-html.mjs';

const args = process.argv.slice(2);
const deckPath = args.find((a) => !a.startsWith('-'));
if (!deckPath) { console.error('usage: voiceover.mjs <deck.html> [-o dir] [--engine piper|chirp|gemini|elevenlabs] [--voice name] [--no-llm] [--reuse-text]'); process.exit(1); }
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
  try { execFileSync(bin, flags, { stdio: 'ignore' }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
};
const encoder = have('ffmpeg') ? 'ffmpeg' : have('afconvert') ? 'afconvert' : null;
if (!encoder) {
  console.error('no AAC encoder — install ffmpeg (apt install ffmpeg / brew install ffmpeg)');
  process.exit(1);
}
const toAac = (wav, m4a) => execFileSync(encoder, encoder === 'ffmpeg'
  ? ['-y', '-i', wav, '-c:a', 'aac', '-b:a', '128k', m4a]
  : ['-f', 'm4af', '-d', 'aac', wav, m4a], { stdio: 'ignore' });

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
// Incremental: the manifest stores a hash of (engine, voice, style, text) per
// slide, so a rerun only synthesizes slides whose narration actually changed.
mkdirSync(outDir, { recursive: true });
let totalCost = 0;
const slideHash = (text) =>
  createHash('sha256').update(`${engine}|${voice}|${style}|${text}`).digest('hex').slice(0, 16);
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
  if (prev?.slides?.[i]?.hash === hash && existsSync(m4a)) {
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
  if (segs) {
    const parts = [];
    for (let k = 0; k < segs.length; k++) {
      const kk = String(k + 1).padStart(2, '0');
      const sWav = join(outDir, `slide-${n}-${kk}.wav`);
      const sM4a = join(outDir, `slide-${n}-${kk}.m4a`);
      const out = await tts.synth(segs[k], { voice, style });
      writeFileSync(sWav, out.wav);
      usage = { cost: usage.cost + (out.usage?.cost ?? 0) };
      toAac(sWav, sM4a);
      if (!keepWav) rmSync(sWav);
      parts.push({ file: `slide-${n}-${kk}.m4a`, path: sM4a });
    }
    const list = join(outDir, `slide-${n}.concat`);
    writeFileSync(list, `${parts.map((p) => `file '${p.path.replaceAll("'", "'\\''")}'`).join('\n')}\n`);
    execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', m4a],
      { stdio: 'ignore' });
    rmSync(list, { force: true });
    manifest[i].segments = parts.map((p) => ({ file: p.file }));
  } else {
    const out = await tts.synth(text, { voice, style });
    writeFileSync(wav, out.wav);
    usage = out.usage ?? { cost: 0 };
    toAac(wav, m4a);
    if (!keepWav) rmSync(wav);
  }
  totalCost += usage.cost ?? 0;
  const costNote = usage.cost ? ` · ~$${usage.cost.toFixed(4)}` : '';
  console.log(`  slide ${n}: ${text.length} chars → ${basename(m4a)}`
    + `${segs ? ` (${segs.length} ⟨CLICK⟩ segments)` : ''}${costNote}`);
  // crash-safe: persist progress after every slide so an interrupted run
  // resumes incrementally instead of re-synthesizing everything
  writeFileSync(join(outDir, 'manifest.json'),
    JSON.stringify({ engine, voice, style, slides: manifest }, null, 1));
}
writeFileSync(join(outDir, 'manifest.json'),
  JSON.stringify({ engine, voice, style, slides: manifest }, null, 1));
// piper is held resident (§ createPiper) — without this the tool prints `done`
// and then hangs on the live child process
tts.synth.close?.();
console.log(`done → ${outDir}${skipped ? ` (${skipped} unchanged, skipped)` : ''}`
  + (totalCost ? ` · estimated cost ~$${totalCost.toFixed(4)}` : ''));
