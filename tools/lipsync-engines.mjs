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
export async function runWav2lip(python, { dir, checkpoint, face, wav, out, smallBatches, inherit, timeout } = {}) {
  const batches = smallBatches ? ['--face_det_batch_size', '4', '--wav2lip_batch_size', '32'] : [];
  await run(python, ['inference.py', '--checkpoint_path', resolve(checkpoint),
    '--face', face, '--audio', wav, '--outfile', out, ...batches],
  { cwd: resolve(dir), ...bufOpts(timeout, inherit) });
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
