#!/usr/bin/env node
// Lip-sync generator for RECORDED narration: sidecar files for every
// slide-NN audio clip in a voiceover directory (tools/voiceover.mjs or a
// deck-recorded set — V → Record this deck…), so a deck plays back with an animated character and no
// bridge running. Fully offline, like everything else here.
//
//   node tools/lipsync.mjs <voiceover-dir> [--visemes] [--video]
//                          [--rhubarb <bin>]
//                          [--engine sadtalker|wav2lip] [--portrait <img>]
//                          [--wav2lip-dir <repo> --wav2lip-ckpt <pth>]
//                          [--sadtalker-dir <repo>] [--python python3]
//
// Outputs, next to the audio they belong to (config: narration.files dir):
//   --visemes (default) — slide-NN.visemes.json  (timeline v1, via Rhubarb)
//   --video             — slide-NN.mp4           (muted talking head)
//
// Rhubarb wants WAV: slide-NN.wav is used when present (voiceover.mjs
// --keep-wav, or a set the deck recorded); otherwise the .m4a is decoded on the fly with
// ffmpeg (afconvert fallback on macOS). The transcript slide-NN.txt, when
// present, markedly improves cue accuracy. For batch video SadTalker is the
// default engine — per-slide clips are long enough that its natural head
// motion beats Wav2Lip's static pose (live mode is the reverse).
//
// Incremental like voiceover.mjs: lipsync.json stores a hash of
// (audio bytes, tool, engine, portrait) per slide, persisted after every
// slide, so a rerun only regenerates what actually changed.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { createVeo, DEFAULT_PROMPT, VEO_MODELS } from './veo.mjs';
import { argReader } from './args.mjs';
import { runRhubarb, runWav2lip, runSadtalker, muteFaststart } from './lipsync-engines.mjs';
import { run, PROBE_MS, CODEC_MS } from './exec.mjs';

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('-'));
if (!dirArg || args.includes('--help')) {
  console.error('usage: lipsync.mjs <voiceover-dir> [--visemes] [--video] [--rhubarb bin]\n'
    + '                   [--engine sadtalker|wav2lip] [--portrait img]\n'
    + '                   [--wav2lip-dir repo --wav2lip-ckpt pth] [--sadtalker-dir repo] [--python bin]');
  process.exit(dirArg ? 0 : 1);
}
const dir = resolve(dirArg);
const { opt } = argReader(args);
const doVideo = args.includes('--video');
const doVisemes = args.includes('--visemes') || !doVideo; // visemes by default
const rhubarb = opt('--rhubarb', 'rhubarb');
const engine = opt('--engine', 'sadtalker');
const portrait = opt('--portrait') && resolve(opt('--portrait'));
const wav2lipDir = opt('--wav2lip-dir');
const wav2lipCkpt = opt('--wav2lip-ckpt');
const sadtalkerDir = opt('--sadtalker-dir');
const python = opt('--python', 'python3');
// --veo: animate the portrait ONCE through Vertex (tools/veo.mjs) and give
// wav2lip that clip instead of the still, so the recorded narrator moves
// instead of staring. One billed call per portrait, cached next to the audio.
const veoOn = args.includes('--veo');

const veo = veoOn ? createVeo({
  project: opt('--veo-project', process.env.GOOGLE_CLOUD_PROJECT),
  location: opt('--veo-location', 'us-central1'),
  model: opt('--veo-model', VEO_MODELS[0]),
  seconds: Number(opt('--veo-seconds', 8)),
  prompt: opt('--veo-prompt', DEFAULT_PROMPT),
  faceY: Number(opt('--veo-face-y', 0.12)),
  cacheDir: dir,
}) : null;

const have = (bin, flags = ['--version']) => {
  try { run(bin, flags, { stdio: 'ignore', timeout: PROBE_MS }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
};
if (doVisemes && !have(rhubarb)) {
  console.error(`rhubarb not found — install https://github.com/DanielSWolf/rhubarb-lip-sync or pass --rhubarb <bin>`);
  process.exit(1);
}
if (doVideo) {
  if (!portrait || !existsSync(portrait)) { console.error('--video needs --portrait <image>'); process.exit(1); }
  if (engine === 'wav2lip' && !(wav2lipDir && wav2lipCkpt)) { console.error('--engine wav2lip needs --wav2lip-dir and --wav2lip-ckpt'); process.exit(1); }
  if (engine === 'sadtalker' && !sadtalkerDir) { console.error('--engine sadtalker needs --sadtalker-dir'); process.exit(1); }
}
const ffmpegOk = have('ffmpeg', ['-version']);

// Every stem with audio, wav preferred over m4a: slide-NN, and slide-NN-KK for
// a track whose ⟨CLICK⟩ beats were recorded separately.
//
// A beat needs its OWN sidecar. The player plays one beat's audio at a time on
// a beat-paced track (PRESENTING), so a timeline cut for the whole slide starts
// at zero against every one of them — right for the first beat and
// progressively wronger after it. Cutting one per beat is the fix, and it costs
// only Rhubarb passes: they are seconds each, and incremental like everything
// else here.
const stems = [...new Set(readdirSync(dir)
  .map((f) => f.match(/^(slide-\d+(?:-\d+)?)\.(wav|m4a)$/)?.[1])
  .filter(Boolean))].sort();
const slides = stems.filter((st) => !/-\d+-\d+$/.test(st));
const beats = stems.filter((st) => /-\d+-\d+$/.test(st));
if (!stems.length) { console.error(`${dir}: no slide-NN.wav/.m4a files`); process.exit(1); }
console.log(`${basename(dir)}: ${slides.length} slides with audio`
  + (beats.length ? ` · ${beats.length} ⟨CLICK⟩ beats` : ''));

// incremental state — its own file so voiceover.mjs reruns can't clobber it
const statePath = join(dir, 'lipsync.json');
let state = {};
try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }

const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 16);
};

function toWav(stem) {
  const wav = join(dir, `${stem}.wav`);
  if (existsSync(wav)) return { path: wav, tmp: false };
  const m4a = join(dir, `${stem}.m4a`);
  const tmp = join(dir, `${stem}.tmp.wav`);
  if (ffmpegOk) run('ffmpeg', ['-y', '-i', m4a, tmp], { stdio: 'ignore', timeout: CODEC_MS, why: 'the encoder is stuck on this file — check it plays, then retry' });
  else run('afconvert', ['-f', 'WAVE', '-d', 'LEI16', m4a, tmp], { timeout: CODEC_MS, why: 'the encoder is stuck on this file — check it plays, then retry' });
  return { path: tmp, tmp: true };
}

// One portrait → one motion clip → every slide. Bought before the loop so the
// cost is one call, not one per slide, and so a failure stops us before any
// GPU time is spent.
const face = veo && engine === 'wav2lip' ? await veo.motionFor(portrait) : portrait;

let made = 0, kept = 0;
for (const stem of stems) {
  // A beat gets visemes only. A talking head is minutes of GPU time per clip,
  // and the player's video element mirrors the audio's transport rather than
  // seeking a timeline — so cutting video per beat would cost a great deal to
  // fix a smaller error than the visemes had.
  const isBeat = /-\d+-\d+$/.test(stem);
  const audioFile = ['wav', 'm4a'].map((e) => join(dir, `${stem}.${e}`)).find(existsSync);
  const audioBytes = readFileSync(audioFile);
  const txtPath = join(dir, `${stem}.txt`);
  const text = existsSync(txtPath) ? readFileSync(txtPath, 'utf8').trim() : '';
  const st = (state[stem] ??= {});
  const jobs = [];
  if (doVisemes) jobs.push('visemes');
  if (doVideo && !isBeat) jobs.push('video');

  for (const job of jobs) {
    const outFile = join(dir, job === 'visemes' ? `${stem}.visemes.json` : `${stem}.mp4`);
    const hash = job === 'visemes'
      ? sha('visemes|', text, '|', audioBytes)
      : sha('video|', engine, '|', readFileSync(face), '|', audioBytes);   // `face`, so --veo re-renders
    if (st[job] === hash && existsSync(outFile)) {
      kept++;
      console.log(`  ${stem}: ${job} unchanged — kept`);
      continue;
    }
    const wav = toWav(stem);
    try {
      const t0 = Date.now();
      if (job === 'visemes') {
        const tmpOut = join(dir, `${stem}.tmp.visemes.json`);
        let dialogFile;
        if (text) { dialogFile = join(dir, `${stem}.tmp.txt`); writeFileSync(dialogFile, text); }
        const tl = await runRhubarb(rhubarb, { wav: wav.path, dialogFile, out: tmpOut });
        writeFileSync(outFile, JSON.stringify(tl));
        rmSync(tmpOut, { force: true });
        rmSync(join(dir, `${stem}.tmp.txt`), { force: true });
        console.log(`  ${stem}: ${tl.cues.length} cues → ${basename(outFile)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } else {
        const tmpMp4 = join(dir, `${stem}.tmp.mp4`);
        if (engine === 'wav2lip') {
          // a --veo clip is hundreds of frames to detect faces in, not one:
          // batch small or an 8GB card dies with "Image too big to run face
          // detection on GPU" (see lipsync-server.mjs)
          await runWav2lip(python, { dir: wav2lipDir, checkpoint: wav2lipCkpt, face,
            wav: wav.path, out: tmpMp4, smallBatches: face !== portrait, inherit: true });
        } else {
          const resDir = join(dir, `${stem}.tmp.d`);
          await runSadtalker(python, { dir: sadtalkerDir, still: portrait,
            wav: wav.path, out: tmpMp4, resultDir: resDir, inherit: true });
          rmSync(resDir, { recursive: true, force: true });
        }
        // mute + faststart: the player's audio always comes from narrAudio
        if (ffmpegOk) {
          await muteFaststart(tmpMp4, outFile);
          rmSync(tmpMp4, { force: true });
        } else renameSync(tmpMp4, outFile);
        console.log(`  ${stem}: ${engine} → ${basename(outFile)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
      st[job] = hash;
      made++;
      // crash-safe: persist progress after every slide (voiceover.mjs idiom)
      writeFileSync(statePath, JSON.stringify(state, null, 1));
    } finally {
      if (wav.tmp) rmSync(wav.path, { force: true });
    }
  }
}
writeFileSync(statePath, JSON.stringify(state, null, 1));
console.log(`done → ${dir} (${made} generated${kept ? `, ${kept} unchanged` : ''})`);
