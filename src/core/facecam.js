// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Your face, filmed while you read the deck aloud (PRESENTING, the your-voice
// recorder's Camera option). The voice recorder cuts its audio at every →;
// this cuts the film at the same moments, so every beat has a clip of its own
// beside its WAV, and a retake, a beat taken again or a slide gone back over
// drops the clip with the audio by simply never asking for it.
//
// One MediaRecorder per beat rather than one per take: a take that runs on
// across → would have to be cut afterwards at times measured on another
// clock, and a beat dropped mid-take (⇧⌫) would have to be cut out of the
// middle. Stopping one recorder and starting the next in the same tick loses
// a frame at most, and the server makes every clip exactly as long as its
// beat's WAV anyway (tools/face-clip.mjs).
//
// The camera is a stream of its own, never the microphone's: the voice is
// captured as PCM by WebAudio, and the film carries no sound.

import { TYPES } from './film.js';

/**
 * `getUserMedia`, `createRecorder` and `isTypeSupported` are injectable for the
 * harness, which has no camera.
 */
export function createFaceCam({
  getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
  createRecorder = (stream, opts) => new MediaRecorder(stream, opts),
  isTypeSupported = (t) => globalThis.MediaRecorder?.isTypeSupported?.(t) ?? false,
  debugLog = () => {},
} = {}) {
  let stream = null;
  let rec = null;          // the beat being filmed: { recorder, chunks, done }
  const type = () => TYPES.find((t) => isTypeSupported(t)) ?? '';

  /** Open the camera (`device` is a deviceId, asked for and not demanded). Throws the browser's refusal. */
  async function open(device = '') {
    if (stream) return stream;
    stream = await getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user', ...(device ? { deviceId: { ideal: device } } : {}) },
      audio: false,
    });
    debugLog('narr', `camera open${device ? ` (${device.slice(0, 8)}…)` : ''}`);
    return stream;
  }

  /** Start filming a beat, unless one is already being filmed. */
  function start() {
    if (!stream || rec) return;
    const t = type();
    const chunks = [];
    let recorder;
    try { recorder = createRecorder(stream, t ? { mimeType: t } : {}); } catch (e) {
      debugLog('narr', `camera: no recorder (${e?.message ?? e})`);
      return;
    }
    const done = new Promise((resolve) => {
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || t || 'video/webm' }) : null);
      recorder.onerror = () => resolve(null);
    });
    try { recorder.start(); } catch { return; }
    rec = { recorder, done };
  }

  /**
   * The beat filmed so far, ended: resolves its clip, or null when nothing was
   * filmed. `rolling` starts the next beat's clip in the same tick, for a take
   * that runs on across the →.
   */
  function cut(rolling = false) {
    const was = rec;
    rec = null;
    if (rolling) start();
    if (!was) return Promise.resolve(null);
    try { if (was.recorder.state !== 'inactive') was.recorder.stop(); } catch { return Promise.resolve(null); }
    return was.done;
  }

  /** Stop filming and close the camera, on every way out. */
  function close() {
    cut(false).catch(() => {});
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return {
    open, start, cut, close,
    get stream() { return stream; },
    get filming() { return !!rec; },
  };
}

/** Is there a camera to offer? Without asking for it: a camera's entry is listed before it is allowed. */
export async function hasCamera(win = globalThis) {
  try {
    const all = await win.navigator.mediaDevices.enumerateDevices();
    return all.some((d) => d.kind === 'videoinput');
  } catch { return false; }
}
