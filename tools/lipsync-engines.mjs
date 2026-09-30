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
 * Where the face is in each of `files` (same-size frames), with Wav2Lip's own
 * detector and the Python that has its packages: `{x1, y1, x2, y2}` or null
 * per file. Padded 25 px below the chin (Wav2Lip's `--pads 0 10` leaves a
 * seam across it).
 */
async function detectFaces(python, { dir, files, timeout }) {
  const code = [
    'import sys, json, cv2, numpy as np, face_detection',
    "det = face_detection.FaceAlignment(face_detection.LandmarksType._2D, flip_input=False, device='cpu')",
    'out = []',
    'for f in sys.argv[1:]:',
    '    r = det.get_detections_for_batch(np.array([cv2.imread(f)]))[0]',
    '    out.append(None if r is None else [int(v) for v in r[:4]])',
    'print(json.dumps(out))',
  ].join('\n');
  const { stdout } = await run(python, ['-c', code, ...files.map((f) => resolve(f))],
    { cwd: resolve(dir), timeout, maxBuffer: 16 * 1024 * 1024 });
  const found = JSON.parse(String(stdout).trim().split('\n').pop() || '[]');
  return found.map((r) => r && { x1: r[0], y1: r[1], x2: r[2], y2: r[3] + 25 });
}

/**
 * Where the face is in a still — found ONCE and cached. Null when no face is
 * found: Wav2Lip then detects per clip, and the composite is skipped.
 */
export async function faceBox(python, { dir, still, cacheDir, timeout = 180000 } = {}) {
  const key = createHash('sha256').update(readFileSync(still)).digest('hex').slice(0, 24);
  const out = join(cacheDir, `box-${key}.json`);
  try { return JSON.parse(readFileSync(out, 'utf8')); } catch { /* not yet */ }
  const [box = null] = await detectFaces(python, { dir, files: [still], timeout });
  writeFileSync(out, JSON.stringify(box));
  return box;
}

/**
 * The square a head is cropped to in a `width`×`height` frame: 1.7× the face,
 * the face a little above centre, kept inside the frame. Pure.
 */
export function squareAround(box, width, height) {
  const fw = box.x2 - box.x1;
  const fh = box.y2 - box.y1;
  const side = Math.min(width, height, Math.round(1.7 * Math.max(fw, fh))) & ~1; // even, for yuv420p
  const cx = (box.x1 + box.x2) / 2;
  const cy = box.y1 + 0.45 * fh;
  const x = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)));
  return { x, y, side };
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
  const { x, y, side } = squareAround(box, width, height);
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
 * `still` may be a filmed portrait's loop (`prepareClip`) instead: Wav2Lip's
 * frame i is the loop's frame i, both from 0 at 25 fps, so the loop replayed
 * beside it lines up frame for frame.
 */
export async function mouthComposite(still, talk, box, out, { timeout = 180000 } = {}) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const cx = Math.round((box.x1 + box.x2) / 2);
  const cy = Math.round(box.y1 + 0.74 * h);
  const rx = Math.round(0.44 * w);
  const ry = Math.round(0.26 * h);
  const mask = `format=gray,geq=lum='if(lt(pow((X-${cx})/${rx},2)+pow((Y-${cy})/${ry},2),1),255,0)',gblur=sigma=18`;
  const source = isClip(still) ? ['-stream_loop', '-1', '-i', still] : ['-loop', '1', '-i', still];
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', talk, ...source,
    '-filter_complex',
    `[0:v]format=yuv444p,split[talk][ref];[1:v]format=yuv444p[st];[st][ref]scale2ref[still][sz];[sz]${mask},format=yuv444p[m];`
      // limited range, like every other clip: a JPEG still makes it yuvj420p
      // (full range), which some players decode washed out or not at all
      + '[still][talk][m]maskedmerge,scale=out_range=tv,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a?', '-shortest', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', out], { timeout });
}

/** A portrait given as a video — filmed, not photographed. */
export const isClip = (file) => /\.(mp4|mov|m4v|webm|mkv)$/i.test(String(file));

/** The longest stretch of a filmed portrait used — it plays forward, then back. */
export const CLIP_MAX_SECONDS = 10;
const CLIP_FPS = 25;

/**
 * One box for a head across a filmed portrait's sampled frames: their union,
 * and whether the head held STILL — every frame has a face, and its centre
 * wanders less than `tol` of the face's width. A steady head's union box can
 * be handed to Wav2Lip for every frame and the mouth composited over the
 * film; a moving one cannot. Pure.
 */
export function steadyBox(boxes, { tol = 0.1 } = {}) {
  const found = boxes.filter(Boolean);
  if (!found.length) return { box: null, steady: false, found: 0 };
  const box = {
    x1: Math.min(...found.map((b) => b.x1)), y1: Math.min(...found.map((b) => b.y1)),
    x2: Math.max(...found.map((b) => b.x2)), y2: Math.max(...found.map((b) => b.y2)),
  };
  const cx = found.map((b) => (b.x1 + b.x2) / 2);
  const cy = found.map((b) => (b.y1 + b.y2) / 2);
  const width = Math.min(...found.map((b) => b.x2 - b.x1));
  const wander = Math.max(Math.max(...cx) - Math.min(...cx), Math.max(...cy) - Math.min(...cy));
  return { box, steady: found.length === boxes.length && wander <= tol * width, found: found.length };
}

/**
 * A filmed portrait as Wav2Lip can use it, made ONCE and cached by content:
 *   - at most CLIP_MAX_SECONDS, 25 fps, no sound, at most STILL_MAX tall;
 *   - its face found in one frame a second (`steadyBox`);
 *   - cropped square around the head, like a photo;
 *   - played forward then backward, so the loop Wav2Lip makes of it for a
 *     long sentence never snaps the head back to the start;
 *   - its first frame kept as the still the deck shows under the video.
 * Returns `{ loop, still, box, steady, seconds }` — `box` in the crop.
 * Throws when no frame has a face: a film of the back of a head is not a
 * portrait, and saying so beats a Wav2Lip traceback per sentence.
 */
export async function prepareClip(python, { dir, clip, cacheDir, timeout = 600000 } = {}) {
  const key = createHash('sha256').update('clip-v1|').update(readFileSync(clip)).digest('hex').slice(0, 24);
  const meta = join(cacheDir, `clip-${key}.json`);
  try { return JSON.parse(readFileSync(meta, 'utf8')); } catch { /* not yet */ }
  const work = join(cacheDir, `clip-${key}.tmp.d`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const norm = join(work, 'norm.mp4');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', clip, '-t', String(CLIP_MAX_SECONDS), '-an',
      '-vf', `fps=${CLIP_FPS},scale=w='min(iw,${STILL_MAX})':h='min(ih,${STILL_MAX})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', norm], { timeout });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', norm], { timeout });
    const probe = JSON.parse(String(stdout));
    const { width, height } = probe.streams[0];
    const seconds = Number(probe.format?.duration) || 0;
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', norm, '-vf', 'fps=1', '-q:v', '2', join(work, 'f-%03d.jpg')], { timeout });
    const frames = readdirSync(work).filter((f) => /^f-\d+\.jpg$/.test(f)).sort().map((f) => join(work, f));
    const { box, steady, found } = steadyBox(await detectFaces(python, { dir, files: frames, timeout }));
    if (!box) throw new Error(`no face found in ${clip} — film the face toward the camera, evenly lit`);
    const { x, y, side } = squareAround(box, width, height);
    const loop = join(cacheDir, `clip-${key}.mp4`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', norm, '-filter_complex',
      // the turn-around frame once, not twice — a held frame reads as a hitch
      `[0:v]crop=${side}:${side}:${x}:${y},split[f][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[f][r]concat=n=2:v=1:a=0,format=yuv420p[v]`,
      '-map', '[v]', '-r', String(CLIP_FPS), '-c:v', 'libx264', '-crf', '16', '-movflags', '+faststart', loop], { timeout });
    const still = join(cacheDir, `clip-${key}.jpg`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', loop, '-frames:v', '1', '-q:v', '2', still], { timeout });
    const prepared = {
      loop, still, steady, seconds, faces: `${found}/${frames.length}`,
      box: { x1: box.x1 - x, y1: box.y1 - y, x2: box.x2 - x, y2: box.y2 - y },
    };
    writeFileSync(meta, JSON.stringify(prepared));
    return prepared;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
