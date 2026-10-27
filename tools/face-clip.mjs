// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Your face, filmed while you recorded the deck (PRESENTING, the your-voice
// recorder), made into the clips the character plays and `decklight video`
// composes: slide-NN-KK.mp4 beside each beat's slide-NN-KK.wav, and
// slide-NN.mp4 joined from them beside the whole-slide file.
//
// The browser films with MediaRecorder: webm in Chrome, mp4 in Safari, a
// variable frame rate in both, and a start that lands a few frames after the
// audio's. So every clip is made the same thing here: H.264, 25 fps, no sound
// (the voice is the WAV's), and exactly as long as the beat's WAV, cut or held
// on its last frame. A clip a tenth of a second long or short is invisible on
// one beat and a visible drift by the end of a slide of eight; the WAV is the
// clock both players already follow.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { runAsync, CODEC_MS, PROBE_MS } from './exec.mjs';

export const FACE_FPS = 25;

/** The seconds a 16-bit PCM WAV runs, from its own header; null when it is not one. */
export function wavSeconds(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
    if (id === 'data') return byteRate ? Math.min(size, buf.length - at - 8) / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * ffmpeg argv: one filmed take → a clip of exactly `seconds`. `tpad` holds the
 * last frame long enough for a take that came in short, and `-t` cuts one
 * that came in long. Even dimensions, because yuv420p refuses odd ones.
 */
export function faceClipArgs({ input, out, seconds }) {
  const t = Math.max(0.04, Number(seconds) || 0).toFixed(3);
  return ['-y', '-loglevel', 'error', '-i', input, '-an',
    '-vf', `fps=${FACE_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,tpad=stop_mode=clone:stop_duration=${t}`,
    '-t', t, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out];
}

/** ffmpeg argv: the beats' clips, made alike by faceClipArgs, joined without re-encoding. */
export function faceJoinArgs({ list, out }) {
  return ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out];
}

/** Is there an ffmpeg to make clips with? */
export async function hasFfmpeg({ env = process.env } = {}) {
  try { await runAsync('ffmpeg', ['-version'], { timeout: PROBE_MS, env }); return true; } catch { return false; }
}

/**
 * Write `out` from the filmed `bytes`, as long as the WAV at `wav` (or as
 * filmed, when there is no WAV to measure). The take goes through a scratch
 * file beside `out`, since ffmpeg reads a webm's duration by seeking in it.
 */
export async function writeFaceClip({ bytes, out, wav = null, env = process.env }) {
  let seconds = null;
  if (wav && existsSync(wav)) seconds = wavSeconds(readFileSync(wav));
  const raw = `${out}.take`;
  const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
  writeFileSync(raw, bytes);
  try {
    const args = seconds == null
      ? ['-y', '-loglevel', 'error', '-i', raw, '-an', '-vf', `fps=${FACE_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]
      : faceClipArgs({ input: raw, out: tmp, seconds });
    await runAsync('ffmpeg', args, { timeout: CODEC_MS, env, why: 'making a filmed beat into a clip' });
    renameSync(tmp, out);
  } finally {
    rmSync(raw, { force: true });
    rmSync(tmp, { force: true });
  }
  return { seconds };
}

/** Join `parts` (paths, in order) into `out`. */
export async function joinFaceClips({ parts, out, env = process.env }) {
  const list = `${out}.list.txt`;
  const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
  writeFileSync(list, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
  try {
    await runAsync('ffmpeg', faceJoinArgs({ list, out: tmp }), { timeout: CODEC_MS, env, why: 'joining the filmed beats of a slide' });
    renameSync(tmp, out);
  } finally {
    rmSync(list, { force: true });
    rmSync(tmp, { force: true });
  }
}
