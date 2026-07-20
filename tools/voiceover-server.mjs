#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Live voice bridge: a tiny local HTTP server the player calls to synthesize
// narration ON THE FLY (SPEC §8 live voice). The browser can't mint Google
// credentials (nor run piper), so this process holds them and exposes:
//
//   GET  /ping    → { ok, engine, model, voices, stylable }   (player probes)
//   GET  /voices  → [[name, flavor], …]
//   POST /tts     → audio/wav                                 { text, voice, style }
//
//   decklight tts [--port 8787] [--engine gemini|chirp|piper]
//                 [--project <id>]              (or set GOOGLE_CLOUD_PROJECT)
//                 [--tts-model gemini-2.5-flash-tts] [--location global]
//                 [--voice en_US-ryan-high] [--data-dir <dir>] [--lang en-US]
//
// Engines differ in what they cost and what they can be told (tts-engines.mjs):
// gemini takes a style instruction and has no free tier; chirp is ~1s a
// sentence with 1M free chars a month; piper is offline and unlimited. /ping
// reports which one is live, so the player's picker offers only voices this
// bridge can actually speak.
//
// CORS is wide open (decks run on file://, origin "null") — the server binds
// 127.0.0.1 only. Responses are cached in memory by (text, voice, style), so
// stepping back through slides replays instantly and costs nothing.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createEngine, ENGINES } from './tts-engines.mjs';
import { argReader, isMain } from './args.mjs';

export async function ttsMain(args) {
  if (args.includes('--help')) {
    console.log(`usage: decklight tts [--port 8787] [--engine ${ENGINES.join('|')}] [--project <id>]
                     [--tts-model id] [--location global] [--voice name] [--data-dir dir] [--lang en-US]

  gemini  gemini-2.5-pro-tts (default) or --tts-model gemini-2.5-flash-tts — Vertex AI, best
          delivery, the only engine that honors a style instruction. No free tier.
  chirp   Chirp 3: HD on the Cloud Text-to-Speech API — same 30 voices, ~1s a sentence,
          1M characters a month free. Needs texttospeech.googleapis.com enabled.
  piper   local neural TTS — offline, unlimited, no credentials, no cost.

  project also read from $GOOGLE_CLOUD_PROJECT (gemini and chirp only)`);
    return;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8787));
  const engineName = opt('--engine', 'gemini');
  if (!ENGINES.includes(engineName)) {
    console.error(`decklight tts: unknown engine '${engineName}' — use ${ENGINES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let engine;
  try {
    engine = createEngine({
      engine: engineName,
      project: opt('--project', process.env.GOOGLE_CLOUD_PROJECT),
      model: opt('--tts-model'),
      location: opt('--location'),
      voice: opt('--voice'),
      dataDir: opt('--data-dir'),
      lang: opt('--lang'),
    });
  } catch (e) {
    console.error(`decklight tts: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const cache = new Map();

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // the player reads the cost estimate for its debug window
    'access-control-expose-headers': 'x-tts-cost, x-tts-tokens, x-tts-cached',
  };
  let totalCost = 0;
  let totalChars = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        engine: engine.name,
        model: engine.model,
        stylable: engine.stylable, // gemini alone can be told HOW to say it
        voices: engine.voices,     // piper speaks one voice, not the star roster
      }));
    }
    if (req.method === 'GET' && req.url === '/voices') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify(engine.voices));
    }
    if (req.method === 'POST' && req.url === '/tts') {
      try {
        // body read INSIDE the try: a client abort mid-request rejects the
        // stream, and outside the try it would crash the whole bridge
        let body = '';
        for await (const chunk of req) body += chunk;
        const { text, voice, style } = JSON.parse(body);
        if (!text?.trim()) { res.writeHead(400, CORS); return res.end('no text'); }
        // NUL joins the fields so they cannot run together (a style ending in a
        // space and a text starting with one must not hash like their neighbours)
        // — but written as an ESCAPE, not a raw byte. This file used to carry
        // literal NULs, and git calls any file with one in its first 8 KB binary:
        // it silently became undiffable and unreviewable.
        const key = createHash('sha256')
          .update([engine.name, voice, style, text].join('\u0000')).digest('hex');
        const fresh = !cache.has(key);
        if (fresh) {
          process.stdout.write(`  ${engine.name} ${voice}: ${text.length} chars … `);
          const t0 = Date.now();
          cache.set(key, await engine.synth(text, { voice, style }));
          const u = cache.get(key).usage;
          totalCost += u.cost;
          totalChars += u.chars ?? text.length;
          // chirp's free tier is denominated in CHARACTERS, so show those too —
          // a dollar estimate alone would read as a bill for something free
          const spend = engine.name === 'chirp'
            ? `${(totalChars / 1000).toFixed(1)}k/1000k free chars this month · ~$${totalCost.toFixed(4)} list`
            : `~$${u.cost.toFixed(4)} (session ~$${totalCost.toFixed(4)})`;
          console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s · ${u.note} · ${spend}`);
        }
        const { wav, usage } = cache.get(key);
        res.writeHead(200, {
          ...CORS,
          'content-type': 'audio/wav',
          // cost is charged once, at synthesis — cache replays are free
          'x-tts-cost': fresh ? usage.cost.toFixed(6) : '0',
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
    const cost = engine.name === 'piper' ? 'free · offline'
      : engine.name === 'chirp' ? 'first 1M chars/month free'
        : 'billed per call — no free tier';
    console.log(`decklight tts bridge on http://127.0.0.1:${port} — ${engine.name} · ${engine.model} (${cost}) — Ctrl-C stops`);
    // piper loads a ~120 MB model on start; do it now, while the deck is still
    // being opened, so the first sentence isn't a 13-second silence
    if (engine.synth.warm) {
      console.log('  warming the model (first synthesis waits for it)…');
      engine.synth.warm();
    }
  });
}

if (isMain(import.meta.url)) ttsMain(process.argv.slice(2));
