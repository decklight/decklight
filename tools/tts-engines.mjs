#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The voices decklight can speak with. One factory, three engines, one shape:
//
//   createEngine({ engine, … }) → { name, model, voices, needsProject,
//                                   synth(text, { voice, style }) → { wav, usage } }
//
//   gemini — gemini-2.5-{pro,flash}-tts on Vertex AI. Best delivery, and the
//            only engine that takes a STYLE instruction. No free tier, and a
//            fresh project's per-minute quota is small: bursty narration 429s.
//            pro is slow (~20s a sentence); flash is the one to reach for.
//   chirp  — Chirp 3: HD on the Cloud Text-to-Speech API. A DIFFERENT API from
//            Vertex, with a permanent free tier (1M chars/month), ~1s a
//            sentence, and — conveniently — the same 30 star-named voices as
//            Gemini, so a deck keeps its voice when it changes engine. Style is
//            ignored: Chirp has no delivery-instruction channel.
//   piper  — local neural TTS. Free, offline, unlimited, no credentials. One
//            voice per installed model, so the picker's roster doesn't apply.
//
// Cost is always an ESTIMATE from published list prices. Chirp's estimate is
// the list price *ignoring* the free tier — we cannot see your monthly usage,
// so the bridge reports characters too, which is what the free tier is
// denominated in.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSynth as createGemini, GEMINI_VOICES, gcloudToken, validProjectId } from './gemini-tts.mjs';

export const ENGINES = ['gemini', 'chirp', 'piper'];

// Chirp 3: HD ships the same roster as Gemini TTS (verified against
// texttospeech.googleapis.com/v1/voices) — one name, two engines.
const CHIRP_PRICE_PER_1M = 30.0; // USD, list, after the 1M chars/month free tier
const chirpVoice = (voice, lang) => `${lang}-Chirp3-HD-${voice}`;

function createChirp({ project, lang = 'en-US' }) {
  if (!project) throw new Error('chirp needs a GCP project — pass --project <id> or set GOOGLE_CLOUD_PROJECT');
  if (!validProjectId(project)) throw new Error(`not a GCP project id: ${JSON.stringify(project)}`);
  let token = null;

  async function call(text, voice) {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-goog-user-project': project, // ADC is a user credential — bill/quota the project, not the user
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang, name: chirpVoice(voice, lang) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
      }),
    });
    if (!res.ok) { const e = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
    const { audioContent } = await res.json();
    if (!audioContent) throw new Error('no audio in response');
    // LINEAR16 comes back as a complete RIFF/WAVE — no header to bolt on
    return Buffer.from(audioContent, 'base64');
  }

  return async function synth(text, { voice = 'Alnilam' } = {}) {
    token ??= gcloudToken();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return {
          wav: await call(text, voice),
          usage: {
            model: 'chirp3-hd',
            chars: text.length,
            cost: (text.length / 1e6) * CHIRP_PRICE_PER_1M,
            note: `${text.length} chars`,
          },
        };
      } catch (e) {
        lastErr = e;
        if (e.status === 401) { token = gcloudToken(); continue; }
        if (e.status === 429 || e.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
        break;
      }
    }
    throw lastErr;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Piper, kept RESIDENT.
 *
 * piper reloads its model on every start — ~13s for en_US-ryan-high (116 MB),
 * against ~1.6s of interpreter startup — so a process per sentence would make
 * the offline engine slower than the cloud one and useless for live narration.
 * Held open it pays that once, and a warm sentence costs about twice its own
 * playing time (~4s for 2s of speech on a laptop CPU) — which the player's
 * lookahead buffer covers, since it synthesizes ahead of the playhead.
 *
 * Its stream interface is line-oriented: one line of text in, one WAV out, into
 * a spool dir, in order. So requests are serialized and the next unseen file is
 * ours — which also means the text must be flattened to a single line, or one
 * request would silently become several utterances.
 */
function createPiper({ voice = 'en_US-ryan-high', dataDir }) {
  try { execFileSync('piper', ['--help'], { stdio: 'ignore' }); }
  catch { throw new Error('piper not found — install with: uv tool install piper-tts'); }
  // A bare model NAME only resolves against a data dir — without one, piper
  // searches its own default and calls the voice missing even when it is
  // sitting right there. A model PATH needs no dir at all.
  const models = dataDir ?? join(homedir(), '.local', 'share', 'piper');
  const byPath = voice.includes('/') || voice.endsWith('.onnx');

  let proc = null, spool = null, seen = null;
  let fatal = null;      // a config error (missing voice) — retrying cannot fix it
  let chain = Promise.resolve();

  function ensure() {
    if (proc) return;
    if (fatal) throw new Error(fatal);
    spool = mkdtempSync(join(tmpdir(), 'decklight-piper-'));
    seen = new Set();
    const p = spawn('piper', [
      '-m', voice, ...(byPath ? [] : ['--data-dir', models]),
      '-d', spool, '--output-dir-naming', 'timestamp',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
    p.on('exit', (code) => {
      if (proc === p) proc = null;
      rmSync(spool, { recursive: true, force: true });
      if (/Unable to find voice/.test(err)) {
        fatal = `piper voice '${voice}' not in ${models} — fetch it with: `
          + `python -m piper.download_voices ${voice} --data-dir ${models}`;
      } else if (code) {
        // a crash is not necessarily terminal: the next call respawns
        lastExit = `piper exited (${code}) ${err.trim().split('\n').pop() ?? ''}`.trim();
      }
    });
    proc = p;
  }
  let lastExit = null;

  // A WAV is complete when the RIFF header's declared length matches the bytes
  // on disk — piper patches that length when it closes the file. That is an
  // exact signal; "the size stopped changing" is not, since a write can simply
  // stall, and half a WAV is a corrupt WAV. (Belt and braces: if some build
  // never patched the header, fall back to a file that has not grown for ~1s.)
  const complete = (b) => b.length > 44 && b.readUInt32LE(4) + 8 === b.length;

  async function nextWav(timeoutMs = 180_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!proc) throw new Error(fatal ?? lastExit ?? 'piper stopped');
      // one line in → one file out, in order, and we serialize: the next file
      // we have not seen is this request's
      const [name] = readdirSync(spool).filter((f) => f.endsWith('.wav') && !seen.has(f));
      if (name) {
        const f = join(spool, name);
        let last = -1, still = 0;
        for (;;) {
          const b = readFileSync(f);
          if (complete(b)) { seen.add(name); rmSync(f, { force: true }); return b; }
          still = b.length === last ? still + 1 : 0;
          last = b.length;
          if (still >= 12 && b.length > 44) { seen.add(name); rmSync(f, { force: true }); return b; }
          await sleep(80);
        }
      }
      await sleep(40);
    }
    throw new Error('piper timed out');
  }

  function synth(text) {
    const line = String(text).replace(/\s+/g, ' ').trim(); // one utterance, one line
    chain = chain.catch(() => {}).then(async () => {
      ensure();
      proc.stdin.write(`${line}\n`);
      return {
        wav: await nextWav(),
        usage: { model: voice, chars: line.length, cost: 0, note: `${line.length} chars · local` },
      };
    });
    return chain;
  }
  // Start the model loading NOW rather than on the first sentence — otherwise
  // the presenter's first keypress pays the whole ~13s load, which reads as a
  // hung deck. By the time anyone has opened a slide, piper is warm.
  synth.warm = () => { try { ensure(); } catch { /* reported at synth time */ } };
  return synth;
}

/**
 * One engine, one shape. `voices` is what the player should offer: the star
 * roster for the cloud engines, and for piper the single installed model —
 * offering 30 Gemini names it cannot speak would just be a lie.
 */
export function createEngine({ engine = 'gemini', project, model, location, voice, dataDir, lang } = {}) {
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine '${engine}' — use ${ENGINES.join(', ')}`);

  if (engine === 'piper') {
    const m = voice ?? 'en_US-ryan-high';
    return {
      name: 'piper', model: m, needsProject: false, stylable: false,
      voices: [[m, 'local']],
      synth: createPiper({ voice: m, dataDir }),
    };
  }
  if (engine === 'chirp') {
    return {
      name: 'chirp', model: 'chirp3-hd', needsProject: true, stylable: false,
      voices: GEMINI_VOICES,
      synth: createChirp({ project, lang: lang ?? 'en-US' }),
    };
  }
  const m = model ?? 'gemini-2.5-pro-tts';
  return {
    name: 'gemini', model: m, needsProject: true, stylable: true,
    voices: GEMINI_VOICES,
    synth: createGemini({ project, ttsModel: m, location }),
  };
}
