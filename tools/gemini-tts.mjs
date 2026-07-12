// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Shared Gemini TTS synthesis (Vertex AI) — used by tools/voiceover.mjs
// (batch pre-render) and tools/voiceover-server.mjs (live bridge for the
// player). generateContent with responseModalities AUDIO returns base64 raw
// PCM (audio/L16, 24 kHz mono); we wrap a WAV header so both afconvert and
// the browser's <audio> can read it. Auth is ADC via gcloud; the model id /
// location pair is probed once (GA vs -preview, global vs us-central1) and
// cached for the synth's lifetime.

import { execFileSync } from 'node:child_process';

/**
 * GCP project ids: 6–30 chars, lowercase, leading letter, no trailing hyphen.
 * Worth checking rather than letting Vertex answer, because `project` is
 * interpolated straight into the request path — punctuation dragged in from a
 * copy-paste comes back as an opaque 403 on a project that "doesn't exist",
 * and a stray slash would rewrite the URL outright.
 */
export const validProjectId = (id) => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id ?? '');

// The prebuilt voice roster (docs' flavor words) — the player shows this
// same list, keep the two in sync (engine.js GEMINI_VOICES).
export const GEMINI_VOICES = [
  ['Zephyr', 'bright'], ['Puck', 'upbeat'], ['Charon', 'informative'],
  ['Kore', 'firm'], ['Fenrir', 'excitable'], ['Leda', 'youthful'],
  ['Orus', 'firm'], ['Aoede', 'breezy'], ['Callirrhoe', 'easy-going'],
  ['Autonoe', 'bright'], ['Enceladus', 'breathy'], ['Iapetus', 'clear'],
  ['Umbriel', 'easy-going'], ['Algieba', 'smooth'], ['Despina', 'smooth'],
  ['Erinome', 'clear'], ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'],
  ['Laomedeia', 'upbeat'], ['Achernar', 'soft'], ['Alnilam', 'firm'],
  ['Schedar', 'even'], ['Gacrux', 'mature'], ['Pulcherrima', 'forward'],
  ['Achird', 'friendly'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'],
  ['Sadachbia', 'lively'], ['Sadaltager', 'knowledgeable'], ['Sulafat', 'warm'],
];

function gcloudToken() {
  return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'],
    { encoding: 'utf8' }).trim();
}

// Published Vertex AI list prices (USD per 1M tokens) — the API returns
// token counts in usageMetadata, never dollars, so cost is an ESTIMATE.
const PRICES = [
  [/flash/i, { input: 0.50, output: 10.00 }],
  [/./, { input: 1.00, output: 20.00 }], // gemini-2.5-pro-tts
];
function estimateCost(model, usage) {
  const p = PRICES.find(([re]) => re.test(model))[1];
  return ((usage.promptTokenCount ?? 0) * p.input + (usage.candidatesTokenCount ?? 0) * p.output) / 1e6;
}

function wavFromPcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Compose the steering prompt in the DOCUMENTED shape: one directive
 * clause ending in a colon, fused to the content ("Say cheerfully: …").
 * Free-form styles are normalized — multi-sentence personas collapse into
 * a single clause (periods → semicolons) and anything not already phrased
 * as a speech directive gets wrapped in one — because instruction-looking
 * text is steering, but content-looking text ("You're a friendly senior
 * engineer…") can stochastically be read aloud, especially when the
 * instruction dwarfs a short sentence.
 */
export function styledPrompt(style, text) {
  const s = (style ?? '').trim();
  if (!s) return text;
  const clause = s
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:\s]+$/, '')   // drop trailing punctuation
    .replace(/\.\s+/g, '; ');     // fuse sentences into one clause
  const directive = /^(read|say|speak|narrate|deliver|announce|whisper|shout|recite|tell)\b/i.test(clause)
    ? clause
    : `Say this in the following style — ${clause}`;
  return `${directive}: ${text}`;
}

/**
 * Returns async (text, { voice, style }) → { wav: Buffer, usage } where
 * usage = { model, promptTokens, audioTokens, cost } (cost is an estimate
 * from published list prices — the API only reports token counts).
 * `style` steers delivery via styledPrompt() — never spoken content.
 */
export function createSynth({ project, ttsModel, location } = {}) {
  if (!project) throw new Error('Gemini TTS needs a GCP project — pass { project } (CLI: --project <id> or set GOOGLE_CLOUD_PROJECT)');
  if (!validProjectId(project)) throw new Error(`not a GCP project id: ${JSON.stringify(project)} — expected 6-30 chars, lowercase letters, digits and hyphens, starting with a letter (stray punctuation from a copy-paste?)`);
  let token = null;
  let route = null;

  async function call(text, voice, model, loc) {
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    if (!res.ok) { const e = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
    const json = await res.json();
    const data = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!data) throw new Error('no audio in response');
    const rate = Number(/rate=(\d+)/.exec(data.mimeType)?.[1] ?? 24000);
    const um = json.usageMetadata ?? {};
    return {
      wav: wavFromPcm(Buffer.from(data.data, 'base64'), rate),
      usage: {
        model,
        promptTokens: um.promptTokenCount ?? 0,
        audioTokens: um.candidatesTokenCount ?? 0,
        cost: estimateCost(model, um),
      },
    };
  }

  return async function synth(text, { voice = 'Alnilam', style = '' } = {}) {
    token ??= gcloudToken();
    const prompt = styledPrompt(style, text);
    const routes = route ? [route]
      : [ttsModel ?? 'gemini-2.5-pro-tts', 'gemini-2.5-pro-preview-tts']
        .flatMap((m) => [location ?? 'global', 'us-central1'].map((l) => ({ model: m, location: l })))
        .filter((r, i, a) => a.findIndex((x) => x.model === r.model && x.location === r.location) === i);
    let lastErr;
    for (const r of routes) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const out = await call(prompt, voice, r.model, r.location);
          route ??= r;
          return out;
        } catch (e) {
          lastErr = e;
          if (e.status === 429) { await new Promise((ok) => setTimeout(ok, 15000 * (attempt + 1))); continue; }
          if (e.status === 401) { token = gcloudToken(); continue; }
          break; // 404/400 → next route
        }
      }
    }
    throw lastErr;
  };
}
