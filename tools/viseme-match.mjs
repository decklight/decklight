// Does a viseme sidecar belong to the audio beside it? (#1244)
//
// A slide-NN.visemes.json is cut from ONE recording. Re-record the audio and
// leave the sidecar, and the character mouths the previous take: its mouth
// stops early, or moves out of time, with nothing to say so. Every writer of
// narration audio does not also write lip-sync (the deck's recorder skips it
// when the bridge is down; voiceover and the export's re-voicing never run
// it), so the sidecar has to carry what ties it to its audio, and the readers
// have to look.
//
// Three things can say a sidecar is not this audio's, strongest first:
//   - `audio` inside the sidecar: the hash of the audio bytes it was cut from.
//     tools/lipsync.mjs and the deck's record endpoint stamp it. When present
//     it settles the question either way.
//   - lipsync.json's per-stem `visemes` hash (text + audio bytes), which
//     tools/lipsync.mjs has always kept — for a sidecar made before the stamp.
//   - the timeline's own `duration` against the audio's, the floor: a take of
//     different length is a different take.
//
// Node-only. The runtime makes the duration check alone (tools/viseme-fit.mjs).

import { createHash } from 'node:crypto';
import { timelineEnd, timelineFits } from './viseme-fit.mjs';

export { DRIFT_S, timelineEnd, timelineFits } from './viseme-fit.mjs';

const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 16);
};

/** The `audio` stamp: which recording a sidecar was cut from. */
export const audioStamp = (audioBytes) => sha(audioBytes);

/** lipsync.json's `visemes` hash — the words Rhubarb was told and the audio. */
export const visemeHash = (text, audioBytes) => sha('visemes|', text, '|', audioBytes);

/** A PCM WAV's length in seconds from its header, or null when it is not one. */
export function wavDuration(bytes) {
  if (!bytes || bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = bytes.readUInt32LE(at + 16);
    if (id === 'data') {
      // a streamed WAV may say 0 or 0xFFFFFFFF here: what is on disk is the data
      const data = size && size !== 0xffffffff ? Math.min(size, bytes.length - at - 8) : bytes.length - at - 8;
      return byteRate ? data / byteRate : null;
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Why `tl` is not the lip-sync of this audio, or null when nothing says so.
 * `rhubarb`: whether Rhubarb runs here. A sidecar read from the voice
 * (tools/mouth.mjs, `source: 'builtin'`) stands in for Rhubarb's only while
 * Rhubarb is missing: once it is here, every reader takes that sidecar as out
 * of date, so the next lip-sync run or export replaces it with Rhubarb's.
 * `audioBytes`: the audio file. `stateHash`/`text`: lipsync.json's entry for
 * the stem and the script beside it. `duration`: the audio's, in seconds.
 * Anything not given is not checked.
 */
export function visemeMismatch(tl, { audioBytes = null, stateHash = null, text = '', duration = null, rhubarb = false } = {}) {
  if (rhubarb && tl?.source === 'builtin') return 'it was read from the voice, and Rhubarb is here to make it';
  if (typeof tl?.audio === 'string' && audioBytes) {
    return tl.audio === audioStamp(audioBytes) ? null : 'it was made from another recording';
  }
  if (stateHash && audioBytes && stateHash !== visemeHash(text, audioBytes)) {
    return 'its audio or script changed since it was made';
  }
  if (!timelineFits(tl, duration)) return `it lasts ${timelineEnd(tl).toFixed(1)}s and its audio ${duration.toFixed(1)}s`;
  return null;
}
