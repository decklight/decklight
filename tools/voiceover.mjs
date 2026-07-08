#!/usr/bin/env node
// Voice-over generator: per-slide narration audio from a deck's speaker notes.
//
//   node tools/voiceover.mjs <deck.html> [-o <dir>] [--engine piper|gemini]
//                            [--voice <name>] [--data-dir <dir>]
//                            [--project <id>] [--location global]
//                            [--tts-model gemini-2.5-pro-tts]
//                            [--model qwen3:30b-a3b] [--no-llm] [--reuse-text]
//
// Engines (the built-in macOS voices were dropped: not good enough):
//   piper  — neural local TTS, fully offline. --voice takes a piper model
//            name (default en_US-ryan-high, a natural US male). Install:
//              uv tool install piper-tts
//              python -m piper.download_voices en_US-ryan-high  (in --data-dir)
//   gemini — gemini-2.5-pro-tts on Vertex AI. Set the GCP project with
//            --project or $GOOGLE_CLOUD_PROJECT. --voice takes a prebuilt voice name (default Alnilam;
//            also Charon, Puck, Fenrir, Iapetus, Kore…). --style sets the
//            delivery instruction prepended to every slide (default: warm,
//            welcoming battle-hardened senior engineer).
//            Auth: gcloud auth application-default login.
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
import { createSynth } from './gemini-tts.mjs';

const args = process.argv.slice(2);
const deckPath = args.find((a) => !a.startsWith('-'));
if (!deckPath) { console.error('usage: voiceover.mjs <deck.html> [-o dir] [--engine piper|gemini] [--voice name] [--no-llm] [--reuse-text]'); process.exit(1); }
const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const outDir = resolve(opt('-o', join(resolve(deckPath, '..'), 'voiceover')));
const engine = opt('--engine', 'piper');
const voice = opt('--voice', engine === 'gemini' ? 'Alnilam' : 'en_US-ryan-high');
const style = opt('--style',
  'Read in a warm, welcoming tone, like a friendly battle-hardened senior ' +
  'engineer who is still curious about new technology.');
const dataDir = resolve(opt('--data-dir', join(homedir(), '.local', 'share', 'piper')));
const project = opt('--project', process.env.GOOGLE_CLOUD_PROJECT);
const model = opt('--model', 'qwen3:30b-a3b');
const useLlm = !args.includes('--no-llm');
const reuseText = args.includes('--reuse-text');
if (engine === 'gemini' && !project) {
  console.error('gemini engine needs a GCP project — pass --project <id> or set GOOGLE_CLOUD_PROJECT'); process.exit(1);
}
const synthGemini = engine === 'gemini'
  ? createSynth({ project, ttsModel: opt('--tts-model'), location: opt('--location') })
  : null;

if (engine === 'piper') {
  try { execFileSync('piper', ['--help'], { stdio: 'ignore' }); }
  catch { console.error('piper not found — install with: uv tool install piper-tts'); process.exit(1); }
} else if (engine !== 'gemini') {
  console.error(`unknown engine '${engine}' — use piper or gemini`);
  process.exit(1);
}

// ── extract per-slide narration text ─────────────────────────────────────────
const html = readFileSync(deckPath, 'utf8');
const sections = html.split(/<section\b/).slice(1);
const clean = (s) => s
  .replace(/⟨CLICK⟩/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
const slides = sections.map((sec, i) => {
  const aside = sec.match(/<aside class="notes">([\s\S]*?)<\/aside>/);
  if (aside) return clean(aside[1]);
  const md = sec.match(/^Note:\s*$([\s\S]*?)(?=^Rehearse:\s*$|<\/script>)/m);
  if (md) return clean(md[1]);
  return '';
});
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
    skipped++;
    console.log(`  slide ${n}: unchanged — kept`);
    continue;
  }
  let costNote = '';
  if (engine === 'gemini') {
    const { wav: buf, usage } = await synthGemini(text, { voice, style });
    writeFileSync(wav, buf);
    totalCost += usage.cost;
    costNote = ` · ~$${usage.cost.toFixed(4)}`;
  } else {
    execFileSync('piper', ['-m', voice, '--data-dir', dataDir, '-f', wav], { input: text });
  }
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', wav, m4a]);
  rmSync(wav);
  console.log(`  slide ${n}: ${text.length} chars → ${basename(m4a)}${costNote}`);
  // crash-safe: persist progress after every slide so an interrupted run
  // resumes incrementally instead of re-synthesizing everything
  writeFileSync(join(outDir, 'manifest.json'),
    JSON.stringify({ engine, voice, style, slides: manifest }, null, 1));
}
writeFileSync(join(outDir, 'manifest.json'),
  JSON.stringify({ engine, voice, style, slides: manifest }, null, 1));
console.log(`done → ${outDir}${skipped ? ` (${skipped} unchanged, skipped)` : ''}`
  + (totalCost ? ` · estimated cost ~$${totalCost.toFixed(4)}` : ''));
