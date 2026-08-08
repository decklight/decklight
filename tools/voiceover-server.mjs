#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Live voice bridge: a tiny local HTTP server the player calls to synthesize
// narration ON THE FLY (SPEC PRESENTING live voice). The browser can't mint Google
// credentials (nor run piper), so this process holds them and exposes:
//
//   GET  /ping    → { ok, engine, model, voices, stylable }   (player probes)
//   GET  /voices  → [[name, flavor], …]
//   POST /tts     → audio/wav                                 { text, voice, style }
//
//   decklight tts [--port 8787] [--engine gemini|chirp|piper|elevenlabs]
//                 [--project <id>]              (or set GOOGLE_CLOUD_PROJECT)
//                 [--tts-model gemini-2.5-flash-tts] [--location global]
//                 [--voice en_US-ryan-high] [--data-dir <dir>] [--lang en-US]
//                 [--tts-format pcm|mp3]        (elevenlabs)
//                 [--setup]                     (re-run the guided setup)
//
// First run: with nothing configured on a terminal, tts walks through the
// guided setup (tts-setup.mjs) instead of exiting with the engine's error —
// engine choice, that engine's prerequisites, one test synthesis — and saves
// the answers to ~/.config/decklight/tts.json ($XDG_CONFIG_HOME honored).
// Precedence: flags > environment > saved config > built-in default.
//
// Engines differ in what they cost and what they can be told (tts-engines.mjs):
// gemini takes a style instruction and has no free tier; chirp is ~1s a
// sentence with 1M free chars a month; piper is offline and unlimited;
// elevenlabs speaks your account's own voices, cloned ones included. /ping
// reports which one is live, so the player's picker offers only voices this
// bridge can actually speak — which for ElevenLabs means asking the account
// first, so /ping and /voices await that lookup rather than guessing.
//
// CORS is wide open (decks run on file://, origin "null") — the server binds
// 127.0.0.1 only. Responses are cached in memory by (text, voice, style), so
// stepping back through slides replays instantly and costs nothing.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { resolveEngine, ENGINES } from './tts-engines.mjs';
import { loadTtsConfig, runSetupWizard, ttsConfigPath } from './tts-setup.mjs';
import { argReader, isMain } from './args.mjs';
import { corsHeaders, readBody } from './bridge.mjs';
import { installedVoices } from '../cli/units.mjs';

export async function ttsMain(args) {
  if (args.includes('--help')) {
    console.log(`usage: decklight tts [--port 8787] [--engine ${ENGINES.join('|')}|<installed>] [--project <id>]
                     [--tts-model id] [--location global] [--voice name] [--data-dir dir] [--lang en-US]
                     [--tts-format pcm|mp3] [--tts-stability creative|natural|robust] [--setup]

  gemini  gemini-2.5-pro-tts (default) or --tts-model gemini-2.5-flash-tts — Vertex AI, best
          delivery, the only engine that honors a style instruction. No free tier.
  chirp   Chirp 3: HD on the Cloud Text-to-Speech API — same 30 voices, ~1s a sentence,
          1M characters a month free. Needs texttospeech.googleapis.com enabled.
  piper   local neural TTS — offline, unlimited, no credentials, no cost.
  elevenlabs  your ElevenLabs account's own voices — the ones you cloned included, listed
          first in the picker. Needs $ELEVENLABS_API_KEY (never written to disk).
          --tts-model eleven_multilingual_v2 (default) / eleven_turbo_v2_5 for latency /
          eleven_v3 to opt into style direction via audio tags — higher latency, more
          variable consistency, and best on short prompts; the only ElevenLabs model
          the picker's tone step appears for.
          --tts-stability creative|natural|robust — how hard v3 follows a tag (v3 only;
          refused on any other model rather than silently doing nothing).
          --tts-format mp3 if your plan has no PCM output (costs you ⇧V and lip-sync).

  <installed>  any engine from a marketplace (decklight engine add <name>) — --engine
          takes its name like any of the six above, and the picker treats it the same.

  project also read from $GOOGLE_CLOUD_PROJECT (gemini and chirp only)

  first run: with nothing configured on a terminal, tts asks a few guided
  questions (engine, prerequisites, one test synthesis) and saves the answers
  to ${ttsConfigPath()} — --setup re-runs them.
  precedence: flags > environment > saved config > built-in default`);
    return;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8787));
  const saved = loadTtsConfig();
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const engineName = opt('--engine') ?? saved?.engine ?? 'gemini';
  // saved voice/data-dir belong to the engine they were saved for — a piper
  // model name is meaningless to gemini
  const savedFor = saved?.engine === engineName ? saved : null;

  const wizard = async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await runSetupWizard({ ask: (q) => rl.question(q), prefill: saved ?? {} }); }
    finally { rl.close(); }
  };

  let engine;
  if (args.includes('--setup')) {
    if (!tty) {
      console.error('decklight tts: --setup needs a terminal to ask its questions on');
      process.exitCode = 1;
      return;
    }
    engine = (await wizard())?.engine;
    if (!engine) { process.exitCode = 1; return; }
  } else {
    try {
      // resolveEngine, not createEngine: a name that is not one of the six
      // built-ins may still be an INSTALLED engine (SPEC ENGINE_UNITS), and
      // the bridge cannot know which kind it was handed.
      engine = await resolveEngine({
        engine: engineName,
        project: opt('--project') ?? process.env.GOOGLE_CLOUD_PROJECT ?? saved?.project,
        model: opt('--tts-model'),
        location: opt('--location'),
        voice: opt('--voice') ?? savedFor?.voice,
        dataDir: opt('--data-dir') ?? savedFor?.dataDir,
        lang: opt('--lang'),
        format: opt('--tts-format') ?? savedFor?.format,
        stability: opt('--tts-stability'),
      });
    } catch (e) {
      // an explicit --engine/--project is a hand on the wheel — fail exactly
      // as before; otherwise, on a terminal, the error becomes the first
      // question of the guided setup instead of the end of the road
      if (!tty || args.includes('--engine') || args.includes('--project')) {
        console.error(`decklight tts: ${e.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`no voice engine configured yet (${e.message})`);
      engine = (await wizard())?.engine;
      if (!engine) { process.exitCode = 1; return; }
    }
  }

  // ElevenLabs' roster belongs to the account, so it is a network call, not a
  // constant. Cached inside the engine; this just picks whichever kind of
  // answer the live engine has.
  // Installed marketplace voices are references, not audio (SPEC VOICE_UNITS):
  // the library holds `{engine, voiceId}` and the engine does the speaking. Read
  // once at startup — the library is a local directory the presenter edits with
  // a CLI, not something that changes under a running bridge.
  //
  // The picker offers the human-readable name, so the id it stands for has to be
  // put back before synth; that resolution lives HERE, next to the merge that
  // made the name offerable, rather than in each engine — an engine that had to
  // know about the unit library would be an engine that could no longer be
  // tested without one.
  const refs = installedVoices(engine.name);
  const refIds = new Map(refs.map((r) => [r.label, r.voiceId]));
  if (refs.length) console.log(`  voices: +${refs.length} installed (decklight voice list)`);

  const voiceRoster = async () => [
    ...(engine.listVoices ? (await engine.listVoices()).map((v) => [v.name, v.flavor]) : engine.voices),
    ...refs.map((r) => [r.label, r.marketplace ?? 'installed']),
  ];

  const cache = new Map();

  // the player reads the cost estimate for its debug window
  const CORS = corsHeaders('x-tts-cost, x-tts-tokens, x-tts-cached');
  let totalCost = 0;
  let totalChars = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'GET' && req.url === '/ping') {
      // A roster the bridge cannot fetch is not a reason to report itself dead:
      // the player falls back to its built-in list, and a synth would say why.
      const voices = await voiceRoster().catch((e) => {
        console.error(`  voices: ${String(e.message ?? e).slice(0, 160)}`);
        return [];
      });
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        engine: engine.name,
        model: engine.model,
        stylable: engine.stylable, // gemini alone can be told HOW to say it
        voices,                    // piper speaks one voice, not the star roster
      }));
    }
    if (req.method === 'GET' && req.url === '/voices') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify(await voiceRoster()));
    }
    if (req.method === 'POST' && req.url === '/tts') {
      try {
        const { text, voice: picked, style } = JSON.parse((await readBody(req)).toString());
        if (!text?.trim()) { res.writeHead(400, CORS); return res.end('no text'); }
        const voice = refIds.get(picked) ?? picked;
        // NUL joins the fields so they cannot run together (a style ending in a
        // space and a text starting with one must not hash like their neighbours)
        // — but written as an ESCAPE, not a raw byte. This file used to carry
        // literal NULs, and git calls any file with one in its first 8 KB binary:
        // it silently became undiffable and unreviewable.
        const key = createHash('sha256')
          .update([engine.name, voice, style, text].join('\u0000')).digest('hex');
        const fresh = !cache.has(key);
        if (fresh) {
          process.stdout.write(`  ${engine.name} ${picked}: ${text.length} chars … `);
          const t0 = Date.now();
          cache.set(key, await engine.synth(text, { voice, style }));
          const u = cache.get(key).usage;
          // `cost` is OPTIONAL, and an installed engine is why (SPEC
          // ENGINE_UNITS): the six built-ins all happen to report one, so
          // reading it unguarded worked until a marketplace engine that
          // meters differently — or not at all — returned usage without it
          // and took the sentence down mid-talk with a TypeError. A missing
          // price is not zero either; it is "no list price to quote", which
          // is what `hasCost` below shows instead of inventing $0.0000.
          const hasCost = typeof u.cost === 'number' && Number.isFinite(u.cost);
          if (hasCost) totalCost += u.cost;
          totalChars += u.chars ?? text.length;
          // chirp's free tier is denominated in CHARACTERS, so show those too —
          // a dollar estimate alone would read as a bill for something free
          // A dollar figure is only honest where a list price exists. Chirp has
          // one behind a free tier; ElevenLabs meters characters against a plan
          // rate we cannot see, so it gets characters and no invented number.
          const spend = engine.name === 'chirp'
            ? `${(totalChars / 1000).toFixed(1)}k/1000k free chars this month · ~$${totalCost.toFixed(4)} list`
            : engine.name === 'elevenlabs'
              ? `${totalChars} chars this session · billed against your plan`
              : hasCost
                ? `~$${u.cost.toFixed(4)} (session ~$${totalCost.toFixed(4)})`
                : `${totalChars} chars this session`;
          console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s · ${u.note ?? `${text.length} chars`} · ${spend}`);
        }
        const { wav, usage } = cache.get(key);
        res.writeHead(200, {
          ...CORS,
          // mp3 is an ElevenLabs opt-in; every other path is a real WAV
          'content-type': engine.synth.mimeType ?? 'audio/wav',
          // cost is charged once, at synthesis — cache replays are free.
          // An engine that quotes no price sends no number rather than '0',
          // which would read as "this was free" (SPEC ENGINE_UNITS).
          'x-tts-cost': fresh && typeof usage.cost === 'number' && Number.isFinite(usage.cost)
            ? usage.cost.toFixed(6)
            : '0',
          'x-tts-tokens': usage.note ?? '',
          'x-tts-cached': fresh ? '0' : '1',
        });
        return res.end(wav);
      } catch (e) {
        console.error(`  tts error: ${String(e).slice(0, 120)}`);
        if (!res.headersSent) res.writeHead(502, CORS);
        return res.end(String(e));
      }
    }
    res.writeHead(404, CORS);
    res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    // The BOUND port, not the requested one: `--port 0` legitimately means
    // "pick a free one", and printing the 0 back made the one line telling a
    // presenter where their bridge is into an unusable URL.
    const bound = server.address()?.port ?? port;
    // `cost` is optional (SPEC ENGINE_UNITS) — an installed engine that
    // quotes no list price says nothing here rather than "(undefined)".
    const price = engine.cost ? ` (${engine.cost})` : '';
    console.log(`decklight tts bridge on http://127.0.0.1:${bound} — ${engine.name} · ${engine.model}${price} — Ctrl-C stops`);
    // Stated here, once, where the presenter is still choosing — not
    // discovered mid-talk when the delivery already varied more than expected.
    if (engine.caveat) console.log(`  ${engine.caveat}`);
    // piper loads a ~120 MB model on start; do it now, while the deck is still
    // being opened, so the first sentence isn't a 13-second silence
    if (engine.synth.warm) {
      console.log('  warming the model (first synthesis waits for it)…');
      engine.synth.warm();
    }
  });
}

if (isMain(import.meta.url)) ttsMain(process.argv.slice(2));
