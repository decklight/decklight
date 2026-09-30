// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The external programs that turn a wav into a mouth: rhubarb (visemes),
// Wav2Lip and SadTalker (a talking head), and ffmpeg (mute + faststart). The
// batch tool (lipsync.mjs) and the bridge (lipsync-server.mjs) each drove all
// four, and the argv had already started to drift (a timeout here, not there).
//
// This is the invocation ONLY — each caller still owns its own temp-file names,
// disk cache, dedup, and GPU queue, and the cache KEYS stay per-tool on purpose
// (unifying them would invalidate every user's cached clips). Everything is
// async: the batch tool was execFileSync in a loop, but it runs under a
// top-level await, so awaiting a shared runner is the same sequential work.
//
// COVERAGE: runRhubarb is exercised by test/lipsync.test.mjs (bridge) and
// test/lipsync-batch.test.mjs (batch) against a stub rhubarb. runWav2lip /
// runSadtalker need a GPU + model checkpoints and run in neither, so they are
// preserved argv-for-argv from the two call sites rather than re-derived.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeRhubarb } from './visemes.mjs';

const run = promisify(execFile);

// captured (not inherited) so the tool's own progress lines aren't drowned; a
// GPU job the batch tool wants to watch live passes inherit:true instead.
const bufOpts = (timeout, inherit) => ({
  ...(timeout ? { timeout } : {}),
  ...(inherit ? { stdio: 'inherit' } : { maxBuffer: 64 * 1024 * 1024 }),
});

/** rhubarb: `wav` (+ optional `dialogFile`) → normalized viseme timeline. */
export async function runRhubarb(rhubarb, { wav, dialogFile, out, timeout } = {}) {
  const dialog = dialogFile ? ['--dialogFile', dialogFile] : [];
  await run(rhubarb, ['-f', 'json', '-o', out, '--machineReadable', ...dialog, wav],
    timeout ? { timeout } : {});
  return normalizeRhubarb(JSON.parse(readFileSync(out, 'utf8')));
}

/**
 * Wav2Lip: `face` (a still, or a veo motion clip) + `wav` → mp4 at `out`.
 * `smallBatches` when the face is a multi-frame clip — the default batch size
 * OOMs an 8 GB card ("Image too big to run face detection on GPU").
 */
export async function runWav2lip(python, { dir, checkpoint, face, wav, out, smallBatches, box, inherit, timeout } = {}) {
  const batches = smallBatches ? ['--face_det_batch_size', '4', '--wav2lip_batch_size', '32'] : [];
  // A known face box (a still's, found once — `faceBox`) skips Wav2Lip's own
  // per-clip detection; its order is top bottom left right.
  const boxArgs = box ? ['--box', String(box.y1), String(box.y2), String(box.x1), String(box.x2)] : [];
  await run(python, ['inference.py', '--checkpoint_path', resolve(checkpoint),
    '--face', face, '--audio', wav, '--outfile', out, ...batches, ...boxArgs],
  { cwd: resolve(dir), ...bufOpts(timeout, inherit) });
}

/** The longest side a portrait is handed to Wav2Lip at — S3FD misses faces in a phone photo at full size. */
export const STILL_MAX = 1024;

/**
 * A portrait as Wav2Lip can use it: at most STILL_MAX tall (a 3088-pixel
 * phone photo is a face S3FD does not find — measured: none at full size,
 * found at half), JPEG, cached by content. Small enough already: the file itself.
 */
export async function prepareStill(still, cacheDir, { timeout = 60000 } = {}) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', still], { timeout });
  const [w, h] = String(stdout).trim().split(',').map(Number);
  if (!(Math.max(w, h) > STILL_MAX)) return still;
  const key = createHash('sha256').update(readFileSync(still)).digest('hex').slice(0, 24);
  const out = join(cacheDir, `still-${key}.jpg`);
  try { statSync(out); return out; } catch { /* not yet */ }
  const scale = h >= w ? `scale=-2:${STILL_MAX}` : `scale=${STILL_MAX}:-2`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', still, '-vf', scale, '-q:v', '2', out], { timeout });
  return out;
}

/**
 * Where the face is in a still — found ONCE, with Wav2Lip's own detector and
 * the Python that has its packages, and cached. Padded 25 px below the chin
 * (Wav2Lip's `--pads 0 10` leaves a seam across it). Null when no face is
 * found: Wav2Lip then detects per clip, and the composite is skipped.
 */
export async function faceBox(python, { dir, still, cacheDir, timeout = 180000 } = {}) {
  const key = createHash('sha256').update(readFileSync(still)).digest('hex').slice(0, 24);
  const out = join(cacheDir, `box-${key}.json`);
  try { return JSON.parse(readFileSync(out, 'utf8')); } catch { /* not yet */ }
  const code = [
    'import sys, json, cv2, numpy as np, face_detection',
    'img = cv2.imread(sys.argv[1])',
    "det = face_detection.FaceAlignment(face_detection.LandmarksType._2D, flip_input=False, device='cpu')",
    'r = det.get_detections_for_batch(np.array([img]))[0]',
    'print(json.dumps(None if r is None else [int(v) for v in r[:4]]))',
  ].join('\n');
  const { stdout } = await run(python, ['-c', code, resolve(still)], { cwd: resolve(dir), timeout, maxBuffer: 16 * 1024 * 1024 });
  const found = JSON.parse(String(stdout).trim().split('\n').pop() || 'null');
  const box = found && { x1: found[0], y1: found[1], x2: found[2], y2: found[3] + 25 };
  writeFileSync(out, JSON.stringify(box));
  return box;
}

/**
 * The still cropped to a SQUARE around the head — what the deck's round
 * overlay shows, so the face fills it instead of sitting small in a whole
 * head-and-shoulders photo (and a smaller frame renders faster). The box comes
 * back moved into the crop. Cached by content and box.
 */
export async function headCrop(still, box, cacheDir, { width, height, timeout = 60000 } = {}) {
  if (!width || !height) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', still], { timeout });
    [width, height] = String(stdout).trim().split(',').map(Number);
  }
  const fw = box.x2 - box.x1;
  const fh = box.y2 - box.y1;
  const side = Math.min(width, height, Math.round(1.7 * Math.max(fw, fh)));
  const cx = (box.x1 + box.x2) / 2;
  const cy = box.y1 + 0.45 * fh;
  const x = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)));
  const key = createHash('sha256').update(readFileSync(still)).update(`${x},${y},${side}`).digest('hex').slice(0, 24);
  const out = join(cacheDir, `head-${key}.jpg`);
  try { statSync(out); } catch {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', still, '-vf', `crop=${side}:${side}:${x}:${y}`, '-q:v', '2', out], { timeout });
  }
  return { file: out, box: { x1: box.x1 - x, y1: box.y1 - y, x2: box.x2 - x, y2: box.y2 - y } };
}

/**
 * The mouth, and only the mouth, from Wav2Lip's clip, laid over the SHARP
 * still. Wav2Lip redraws the whole face box at 96 px, so glasses, eyes and
 * skin come back soft and blocky; a feathered ellipse over the mouth and chin
 * — placed from the face box — keeps everything else the photograph.
 */
export async function mouthComposite(still, talk, box, out, { timeout = 180000 } = {}) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const cx = Math.round((box.x1 + box.x2) / 2);
  const cy = Math.round(box.y1 + 0.74 * h);
  const rx = Math.round(0.44 * w);
  const ry = Math.round(0.26 * h);
  const mask = `format=gray,geq=lum='if(lt(pow((X-${cx})/${rx},2)+pow((Y-${cy})/${ry},2),1),255,0)',gblur=sigma=18`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', talk, '-loop', '1', '-i', still,
    '-filter_complex',
    `[0:v]format=yuv444p,split[talk][ref];[1:v]format=yuv444p[st];[st][ref]scale2ref[still][sz];[sz]${mask},format=yuv444p[m];`
      // limited range, like every other clip: a JPEG still makes it yuvj420p
      // (full range), which some players decode washed out or not at all
      + '[still][talk][m]maskedmerge,scale=out_range=tv,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a?', '-shortest', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', out], { timeout });
}

/**
 * SadTalker: `still` + `wav` → mp4 at `out`. It writes `<timestamp>/….mp4`
 * into `resultDir`; take the newest and move it to `out`. (SadTalker makes its
 * own head motion, so it always gets the still, never a veo clip.)
 */
export async function runSadtalker(python, { dir, still, wav, out, resultDir, inherit, timeout } = {}) {
  mkdirSync(resultDir, { recursive: true });
  await run(python, ['inference.py', '--driven_audio', wav, '--source_image', still, '--result_dir', resultDir],
    { cwd: resolve(dir), ...bufOpts(timeout, inherit) });
  const found = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f); const s = statSync(p);
      if (s.isDirectory()) walk(p); else if (f.endsWith('.mp4')) found.push([s.mtimeMs, p]);
    }
  };
  walk(resultDir);
  if (!found.length) throw new Error('sadtalker produced no mp4');
  renameSync(found.sort((a, b) => b[0] - a[0])[0][1], out);
}

/** Strip the audio track (playback is muted — narrAudio is the voice) and
 *  front-load the moov atom so the player can start instantly. */
export async function muteFaststart(src, out, { timeout } = {}) {
  await run('ffmpeg', ['-y', '-i', src, '-an', '-movflags', '+faststart', '-c:v', 'copy', out],
    timeout ? { timeout } : {});
}
