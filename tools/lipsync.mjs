#!/usr/bin/env node
// Lip-sync generator for RECORDED narration: sidecar files for every
// slide-NN audio clip in a voiceover directory (tools/voiceover.mjs or a
// ⇧V-recorded set), so a deck plays back with an animated character and no
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
// --keep-wav, or a ⇧V set); otherwise the .m4a is decoded on the fly with
// ffmpeg (afconvert fallback on macOS). The transcript slide-NN.txt, when
// present, markedly improves cue accuracy. For batch video SadTalker is the
// default engine — per-slide clips are long enough that its natural head
// motion beats Wav2Lip's static pose (live mode is the reverse).
//
// Incremental like voiceover.mjs: lipsync.json stores a hash of
// (audio bytes, tool, engine, portrait) per slide, persisted after every
// slide, so a rerun only regenerates what actually changed.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { normalizeRhubarb } from './visemes.mjs';
import { createVeo, DEFAULT_PROMPT, VEO_MODELS } from './veo.mjs';
import { argReader } from './args.mjs';

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
  try { execFileSync(bin, flags, { stdio: 'ignore' }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
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

// every slide-NN with audio, wav preferred over m4a
const slides = [...new Set(readdirSync(dir)
  .map((f) => f.match(/^slide-(\d+)\.(wav|m4a)$/)?.[1])
  .filter(Boolean))].sort();
if (!slides.length) { console.error(`${dir}: no slide-NN.wav/.m4a files`); process.exit(1); }
console.log(`${basename(dir)}: ${slides.length} slides with audio`);

// incremental state — its own file so voiceover.mjs reruns can't clobber it
const statePath = join(dir, 'lipsync.json');
let state = {};
try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }

const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 16);
};

function toWav(nn) {
  const wav = join(dir, `slide-${nn}.wav`);
  if (existsSync(wav)) return { path: wav, tmp: false };
  const m4a = join(dir, `slide-${nn}.m4a`);
  const tmp = join(dir, `slide-${nn}.tmp.wav`);
  if (ffmpegOk) execFileSync('ffmpeg', ['-y', '-i', m4a, tmp], { stdio: 'ignore' });
  else execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', m4a, tmp]);
  return { path: tmp, tmp: true };
}

// One portrait → one motion clip → every slide. Bought before the loop so the
// cost is one call, not one per slide, and so a failure stops us before any
// GPU time is spent.
const face = veo && engine === 'wav2lip' ? await veo.motionFor(portrait) : portrait;

let made = 0, kept = 0;
for (const nn of slides) {
  const audioFile = ['wav', 'm4a'].map((e) => join(dir, `slide-${nn}.${e}`)).find(existsSync);
  const audioBytes = readFileSync(audioFile);
  const txtPath = join(dir, `slide-${nn}.txt`);
  const text = existsSync(txtPath) ? readFileSync(txtPath, 'utf8').trim() : '';
  const st = (state[nn] ??= {});
  const jobs = [];
  if (doVisemes) jobs.push('visemes');
  if (doVideo) jobs.push('video');

  for (const job of jobs) {
    const outFile = join(dir, job === 'visemes' ? `slide-${nn}.visemes.json` : `slide-${nn}.mp4`);
    const hash = job === 'visemes'
      ? sha('visemes|', text, '|', audioBytes)
      : sha('video|', engine, '|', readFileSync(face), '|', audioBytes);   // `face`, so --veo re-renders
    if (st[job] === hash && existsSync(outFile)) {
      kept++;
      console.log(`  slide ${nn}: ${job} unchanged — kept`);
      continue;
    }
    const wav = toWav(nn);
    try {
      const t0 = Date.now();
      if (job === 'visemes') {
        const tmpOut = join(dir, `slide-${nn}.tmp.visemes.json`);
        const dialog = [];
        if (text) { writeFileSync(join(dir, `slide-${nn}.tmp.txt`), text); dialog.push('--dialogFile', join(dir, `slide-${nn}.tmp.txt`)); }
        execFileSync(rhubarb, ['-f', 'json', '-o', tmpOut, '--machineReadable', ...dialog, wav.path], { stdio: ['ignore', 'ignore', 'ignore'] });
        const tl = normalizeRhubarb(JSON.parse(readFileSync(tmpOut, 'utf8')));
        writeFileSync(outFile, JSON.stringify(tl));
        rmSync(tmpOut, { force: true });
        rmSync(join(dir, `slide-${nn}.tmp.txt`), { force: true });
        console.log(`  slide ${nn}: ${tl.cues.length} cues → ${basename(outFile)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } else {
        const tmpMp4 = join(dir, `slide-${nn}.tmp.mp4`);
        if (engine === 'wav2lip') {
          // a --veo clip is hundreds of frames to detect faces in, not one:
          // batch small or an 8GB card dies with "Image too big to run face
          // detection on GPU" (see lipsync-server.mjs)
          const batches = face === portrait ? [] : ['--face_det_batch_size', '4', '--wav2lip_batch_size', '32'];
          execFileSync(python, ['inference.py', '--checkpoint_path', resolve(wav2lipCkpt),
            '--face', face, '--audio', wav.path, '--outfile', tmpMp4, ...batches],
          { cwd: resolve(wav2lipDir), stdio: 'inherit' });
        } else {
          const resDir = join(dir, `slide-${nn}.tmp.d`);
          mkdirSync(resDir, { recursive: true });
          execFileSync(python, ['inference.py', '--driven_audio', wav.path,
            '--source_image', portrait, '--result_dir', resDir],
          { cwd: resolve(sadtalkerDir), stdio: 'inherit' });
          const found = [];
          const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (f.endsWith('.mp4')) found.push([s.mtimeMs, p]); } };
          walk(resDir);
          if (!found.length) throw new Error('sadtalker produced no mp4');
          renameSync(found.sort((a, b) => b[0] - a[0])[0][1], tmpMp4);
          rmSync(resDir, { recursive: true, force: true });
        }
        // mute + faststart: the player's audio always comes from narrAudio
        if (ffmpegOk) {
          execFileSync('ffmpeg', ['-y', '-i', tmpMp4, '-an', '-movflags', '+faststart', '-c:v', 'copy', outFile], { stdio: 'ignore' });
          rmSync(tmpMp4, { force: true });
        } else renameSync(tmpMp4, outFile);
        console.log(`  slide ${nn}: ${engine} → ${basename(outFile)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
