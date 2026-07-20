#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Veo (Vertex AI) — the MOTION half of the talking head.
//
// Wav2Lip is a mouth, not a person: it repaints the lip region and leaves the
// rest of the source exactly as it found it. Given a photo, that means a frozen
// stare with a moving mouth — lifelike lips on a mannequin. Given a VIDEO of a
// person, the same model keeps the head turns, the blinks and the shoulders and
// still puts the deck's narration on the lips. So the fix is not a better mouth,
// it is a better source: Veo animates the portrait once, Wav2Lip re-syncs that
// clip to every sentence.
//
// The unit is the PORTRAIT, never the sentence. A Veo call takes ~40s and is
// billed per second of output, while the player asks the bridge for video once
// per SENTENCE, through a 10-sentence lookahead — one Veo call per sentence
// would be both unusably slow and a runaway bill. So each portrait is turned
// into one short motion loop, on first use, and cached on disk: a deck of any
// length costs exactly one Veo call per portrait, ever. Delete the cache dir to
// re-roll the performance.
//
// Audio is deliberately OFF (generateAudio: false — also the cheaper rate). The
// deck plays the character video muted and takes the voice from its narration
// track, so a Veo voice would be a second speaker talking over the first.
//
//   const veo = createVeo({ project, cacheDir });
//   const clip = await veo.motionFor('/path/portrait.jpg');   // → mp4 path
//
// Models (Vertex, us-central1): veo-3.1-lite-generate-001 (default — cheapest,
// and its extra fidelity would go into a mouth Wav2Lip is about to repaint
// anyway), veo-3.1-fast-generate-001, veo-3.1-generate-001, veo-3.0-*.
// Durations are fixed by the API: 4, 6 or 8 seconds.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gcloudToken, authHeaders } from './gemini-tts.mjs';

const run = promisify(execFile);

export const VEO_MODELS = [
  'veo-3.1-lite-generate-001',
  'veo-3.1-fast-generate-001',
  'veo-3.1-generate-001',
  'veo-3.0-fast-generate-001',
  'veo-3.0-generate-001',
];
export const VEO_SECONDS = [4, 6, 8];

// Direct the camera, not the performance: Wav2Lip will overwrite the mouth, so
// what has to survive is head motion, blinks and a steady frame. A moving camera
// or a changing background would make every per-sentence cut visible.
export const DEFAULT_PROMPT =
  'The person in the photograph looks directly into the camera and speaks to the viewer, '
  + 'calm and engaged. Subtle natural head movement, occasional blinks, small shifts of the '
  + 'shoulders, warm attentive expression. Locked-off static camera, no zoom, no pan. '
  + 'The background stays exactly as it is. Photorealistic, natural skin, soft even lighting.';

/**
 * @param {object} o
 * @param {string} o.project     GCP project (billed)
 * @param {string} [o.cacheDir]  motion clips land here, keyed by the inputs
 * @param {number} [o.faceY]     square crop's top edge, as a fraction of height.
 *                               Veo is asked for 9:16 (a talking head is taller
 *                               than it is wide) but the deck's overlay is a
 *                               CIRCLE, so the clip is cropped square around the
 *                               head — which sits high in a portrait frame.
 * @param {Function} [o.token]   injectable for tests (default: ADC via gcloud)
 * @param {Function} [o.fetch]   injectable for tests
 * @param {Function} [o.exec]    injectable for tests (default: ffmpeg via execFile)
 */
export function createVeo({
  project,
  location = 'us-central1',
  model = VEO_MODELS[0],
  seconds = 8,
  prompt = DEFAULT_PROMPT,
  cacheDir = '.',
  faceY = 0.12,
  size = 640,
  token = gcloudToken,
  fetch: fetchImpl = fetch,
  exec = run,
  pollMs = 10_000,
} = {}) {
  if (!project) throw new Error('veo needs a GCP project — pass --veo-project <id> or set GOOGLE_CLOUD_PROJECT');
  if (!VEO_SECONDS.includes(Number(seconds))) {
    throw new Error(`veo: --veo-seconds must be one of ${VEO_SECONDS.join(', ')} (the API allows no others)`);
  }
  mkdirSync(cacheDir, { recursive: true });

  const base = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}`
    + `/locations/${location}/publishers/google/models/${model}`;
  const inflight = new Map();   // portrait path → promise, so a burst of
                                // lookahead prefetches cannot buy two clips

  async function generate(portrait) {
    const headers = authHeaders(token(), project);
    const body = {
      instances: [{
        prompt,
        image: {
          bytesBase64Encoded: readFileSync(portrait).toString('base64'),
          mimeType: portrait.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        },
      }],
      parameters: {
        aspectRatio: '9:16',
        durationSeconds: Number(seconds),
        sampleCount: 1,
        generateAudio: false,        // the deck owns the voice (and it is cheaper)
        personGeneration: 'allow_adult',
        resolution: '720p',
      },
    };

    // Vertex can answer a transient 429/5xx (quota, a backend blip) on the
    // start call or any of the ~120 polls; without a retry one blip throws
    // away a billed long-running operation. Back off and retry the transient
    // statuses, and refresh the token on a 401 — the poll loop can outlive it.
    async function post(url, payload) {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        if (res.status === 401 && attempt < 4) { headers.authorization = `Bearer ${token()}`; continue; }
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        return res.json();
      }
    }

    const started = await post(`${base}:predictLongRunning`, body);
    if (started.error) throw new Error(`veo: ${started.error.message ?? JSON.stringify(started.error)}`);

    // Generation is a long-running operation: minutes, not milliseconds.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const op = await post(`${base}:fetchPredictOperation`, { operationName: started.name });
      if (op.error) throw new Error(`veo: ${op.error.message ?? JSON.stringify(op.error)}`);
      if (!op.done) continue;
      const vids = op.response?.videos ?? op.response?.generatedSamples ?? [];
      const b64 = vids[0]?.bytesBase64Encoded ?? vids[0]?.video?.bytesBase64Encoded;
      // A refusal is a SUCCESS with nothing in it — Veo's safety filters decline
      // some real faces outright, and saying so is more use than an empty file.
      if (!b64) {
        throw new Error('veo returned no video — the safety filter refused this portrait '
          + `(raiMediaFilteredReasons: ${JSON.stringify(op.response?.raiMediaFilteredReasons ?? 'none given')}). `
          + 'Try another photo, or run without --veo for a still portrait.');
      }
      return Buffer.from(b64, 'base64');
    }
    throw new Error('veo: timed out waiting for the operation');
  }

  /** portrait image → a cached mp4 of that person moving. One call per portrait. */
  async function motionFor(portrait) {
    const key = createHash('sha256')
      .update(readFileSync(portrait)).update(`|${model}|${seconds}|${size}|${faceY}|${prompt}`)
      .digest('hex').slice(0, 32);
    const out = join(cacheDir, `veo-${key}.mp4`);
    if (existsSync(out)) return out;

    if (!inflight.has(key)) {
      const p = (async () => {
        if (existsSync(out)) return out;
        const raw = join(cacheDir, `veo-${key}.raw.mp4`);
        const tmp = join(cacheDir, `veo-${key}.tmp.mp4`);
        try {
          const t0 = Date.now();
          process.stdout.write(`  veo ${model} · ${seconds}s · ${portrait} … `);
          writeFileSync(raw, await generate(portrait));
          // 9:16 → a square on the head, at the size the face detector likes:
          // s3fd misses faces in a big frame (it found nothing at 1070px wide,
          // everything at 640), and the deck's overlay is a circle anyway.
          await exec('ffmpeg', ['-y', '-i', raw,
            '-vf', `crop=iw:iw:0:ih*${faceY},scale=${size}:${size}`,
            '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp],
          { timeout: 300_000 });
          renameSync(tmp, out);
          console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s → ${out}`);
          return out;
        } finally {
          for (const f of [raw, tmp]) rmSync(f, { force: true });
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return inflight.get(key);
  }

  return { motionFor, model, seconds };
}
