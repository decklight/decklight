// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The built-in mouth (tools/mouth.mjs) of one audio file on disk, for the
// Node side: `decklight lipsync` writing a sidecar without Rhubarb, and
// `decklight video` reading one it could not have made. ffmpeg decodes it
// straight to the 16 kHz mono the reader works at. Node-only; the deck
// decodes through the browser instead (src/core/character.js).

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { mouthTimeline } from './mouth.mjs';

/** The timeline read from `audio`'s voice; throws when ffmpeg cannot read it. */
export function mouthFromFile(audio) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', audio, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`ffmpeg could not read ${basename(audio)}`);
  const raw = r.stdout;
  return mouthTimeline(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)), 16000);
}
