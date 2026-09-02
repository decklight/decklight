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
// 127.0.0.1 only. Responses are cached in memory AND on disk (tools/tts-cache.mjs)
// by (engine, model, format, voice, style, text), so stepping back through
// slides replays instantly, a restarted bridge replays for free, and
// `decklight voiceover` reuses whatever this bridge already said.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { canBind, resolvePortConflict } from '../cli/port-conflict.mjs';
import { execFile } from 'node:child_process';
import { cacheHome, clipKey, createTtsCache, extFor } from './tts-cache.mjs';

/**
 * The one exec a deck may trigger: open macOS's voice-download pane.
 *
 * The argv is a FROZEN CONSTANT — no byte of any request reaches it — and it
 * opens a System Settings pane and nothing else; the download itself stays a
 * human clicking through, which is the point of the pane. `exec` is injected
 * so the test can assert the argv without a Settings window opening mid-suite.
 */
export const VOICE_SETTINGS_URI = 'x-apple.systempreferences:com.apple.preference.universalaccess';
/** …and Windows' Narrator page, where "Add natural voices" lives. */
export const WINDOWS_VOICE_SETTINGS_URI = 'ms-settings:easeofaccess-narrator';
export function openVoiceSettings(exec = execFile, platform = process.platform) {
  if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is its title argument, so the
    // URI is never mistaken for one. Every token is a constant.
    exec('cmd', ['/c', 'start', '""', WINDOWS_VOICE_SETTINGS_URI], () => { /* fire and forget */ });
    return;
  }
  exec('open', [VOICE_SETTINGS_URI], () => { /* fire and forget — Settings owns the rest */ });
}
import { resolveEngine, engineBlocker, engineMenu, engineStatus, ENGINES } from './tts-engines.mjs';
import { loadTtsConfig, runSetupWizard, ttsConfigPath } from './tts-setup.mjs';
import { argReader, isMain } from './args.mjs';
import { corsHeaders, readBody } from './bridge.mjs';
import { installedVoices } from '../cli/units.mjs';
import { readyLine } from '../cli/banner.mjs';

/** One line from the terminal, for the taken-port question. Closed straight after. */
async function askLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // EOF ANSWERS THE SAFE WAY. `rl.question` never settles if the input closes
  // first (a Ctrl-D, a terminal whose stdin is a spent pipe), and an unsettled
  // promise here aborted the bridge through the top-level handler — reported to
  // the user as "this one is a bug, please report it", over a question about a
  // port. An empty answer is the declining answer everywhere it is read.
  try {
    return await new Promise((resolve) => {
      // `line` is registered FIRST and readline emits it before `close`, so a
      // key that was actually typed always beats the EOF that follows it. The
      // two racing as promises did not: a piped `k\n` lost to the close and
      // read as a decline, which is a terrible way to lose a keystroke.
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      rl.once('line', done);
      rl.once('close', () => done(''));
      rl.setPrompt(prompt);
      rl.prompt();
    });
  } finally { rl.close(); }
}

export async function ttsMain(args) {
  if (args.includes('--help')) {
    console.log(`usage: decklight tts [--port 8787] [--engine ${ENGINES.join('|')}|<installed>] [--project <id>]
                     [--tts-model id] [--location global] [--voice name] [--data-dir dir] [--lang en-US]
                     [--tts-format pcm|mp3] [--tts-stability creative|natural|robust] [--setup]
                     [--no-cache]

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
          --tts-format mp3 if your plan has no PCM output (costs you the panel's
          Record this deck… and lip-sync, both of which read WAV).

  <installed>  any engine from a marketplace (decklight engine add <name>) — --engine
          takes its name like any of the six above, and the picker treats it the same.

  project also read from $GOOGLE_CLOUD_PROJECT (gemini and chirp only)

  cache   every synthesis is kept in ${cacheHome()} under a key made of
          (engine, model, format, voice, style, text), so a restarted bridge
          replays for free and 'decklight voiceover' reuses what you already
          previewed instead of paying for it twice. Oldest clips are dropped
          past 400 MB. --no-cache re-synthesizes everything, for a fresh take.

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
  // Everything derived from the live engine, recomputed together — because the
  // deck can now change which engine that is (SPEC `NARRATION`), and a roster
  // or an id map left behind from the previous one would offer voices the
  // current engine cannot say.
  let refs = [];
  let refIds = new Map();
  const useEngine = (e) => {
    engine = e;
    refs = installedVoices(e.name);
    refIds = new Map(refs.map((r) => [r.label, r.voiceId]));
    if (refs.length) console.log(`  voices: +${refs.length} installed (decklight voice list)`);
  };
  useEngine(engine);

  const voiceRoster = async () => [
    ...(engine.listVoices ? (await engine.listVoices()).map((v) => [v.name, v.flavor]) : engine.voices),
    ...refs.map((r) => [r.label, r.marketplace ?? 'installed']),
  ];

  // The engine's NAME is part of every cache key, so a swap cannot serve one
  // engine's audio under another's voice — the cache survives the switch, and
  // switching back replays instantly rather than re-billing.
  const cache = new Map();
  // The DISK half (tools/tts-cache.mjs), for EVERY engine including the paid
  // ones. Warming 184 say previews took ~6 minutes of background synthesis and
  // should cost that once per machine rather than once per bridge — and an
  // ElevenLabs sentence should be paid for once per sentence, not once per
  // process, which is what a memory-only cache charged for a preview here and
  // a batch recording ten minutes later. The MODEL is in the key, so a cloud
  // engine changing its model underneath us is a miss rather than a stale clip.
  // `--no-cache` opts out for a deliberate re-roll.
  const disk = createTtsCache({ enabled: !args.includes('--no-cache') });
  disk.prune();

  // What the bridge could become, and what stands in the way. The options the
  // deck's picker draws (SPEC `NARRATION`).
  //
  // The blockers are all fixed in a TERMINAL and this route never collects
  // one: a key or a project id typed into a web page — even one on loopback —
  // is a different thing from one exported in a shell, and a deck under
  // `--remote` is reachable from a phone. So the deck lists what is missing and
  // says where to fix it; it never becomes the place you configure credentials.
  const menuOpts = () => ({
    env: process.env,
    project: opt('--project') ?? process.env.GOOGLE_CLOUD_PROJECT ?? saved?.project,
    voice: opt('--voice'), dataDir: opt('--data-dir'), lang: opt('--lang'),
  });

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
        // the engine's standing note — for `say` with no Siri voice this is
        // the download hint, and the picker keys its install row off it
        ...(engine.caveat ? { caveat: engine.caveat } : {}),
        voices,                    // piper speaks one voice, not the star roster
      }));
    }
    // ── the one exec a deck may trigger: open the voice-download pane ──
    // Darwin only, loopback only (like every route here), and the argv is a
    // FROZEN CONSTANT — no byte of the request reaches it. It opens a System
    // Settings pane and does nothing else; the download itself stays a human
    // clicking, which is the whole point of the pane.
    if (req.method === 'POST' && req.url === '/voices/install') {
      if (process.platform !== 'darwin' && process.platform !== 'win32') { res.writeHead(404); return res.end(); }
      try {
        openVoiceSettings();
        console.log(process.platform === 'win32'
          ? '  voices: opened Settings → Accessibility → Narrator (add natural voices, then restart me)'
          : '  voices: opened System Settings → Accessibility (download a Siri voice, then restart me)');
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
      }
    }
    // ── which engine is speaking, and what else could (SPEC `NARRATION`) ──
    if (req.method === 'GET' && req.url === '/engines') {
      // Ready or not, every engine is listed. Hiding the ones this machine
      // cannot use would answer "where did ElevenLabs go?" with silence — the
      // useful answer is that it is there and needs a key.
      const opts = menuOpts();
      const menu = engineMenu(opts).map((e) => ({ ...e, current: e.name === engine.name }));
      // An engine the bridge was STARTED with is ready by definition — it is
      // speaking. Detection can disagree (a marketplace engine is not one of
      // the six, and a project passed by flag is invisible to a later probe),
      // and a picker that greyed out the running engine would be absurd.
      if (!menu.some((e) => e.current)) {
        menu.unshift({ name: engine.name, ready: true, reason: 'ok', current: true, cost: engine.cost });
      }
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, engine: engine.name, engines: menu }));
    }
    if (req.method === 'POST' && req.url === '/engine') {
      let name;
      try { ({ engine: name } = JSON.parse((await readBody(req)).toString())); }
      catch { name = null; }
      if (typeof name !== 'string' || !name) {
        res.writeHead(400, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'name the engine' }));
      }
      if (name === engine.name) {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, engine: engine.name, model: engine.model,
          stylable: engine.stylable, voices: await voiceRoster().catch(() => []), changed: false }));
      }
      const opts = menuOpts();
      // Checked BEFORE building, because two of the six build perfectly well
      // and only fail on the first sentence — which mid-talk is a keypress into
      // silence. A refusal here is recoverable; that one is not.
      const status = engineStatus(name, opts);
      if (ENGINES.includes(name) && !status.ready) {
        // The blocker travels WITH the refusal. The deck's picker normally has
        // it already (it came down with /engines), but a menu can be a minute
        // stale — a key exported and un-exported, a model deleted — and a
        // refusal the deck cannot put words to is a row that does nothing when
        // clicked.
        res.writeHead(409, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false, error: status.reason, ...status, ...(engineBlocker(status, opts) ?? {}),
        }));
      }
      let next;
      try {
        next = await resolveEngine({ ...opts, engine: name, model: undefined });
      } catch (e) {
        res.writeHead(409, { ...CORS, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 200) }));
      }
      // Only now, once the new engine exists: a failed swap must leave the
      // bridge speaking exactly as it was, not half-way between two engines.
      const was = engine.name;
      useEngine(next);
      console.log(`  engine: ${was} → ${engine.name} (asked for by the deck)`);
      if (engine.caveat) console.log(`  ${engine.caveat}`);
      const voices = await voiceRoster().catch(() => []);
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, engine: engine.name, model: engine.model,
        stylable: engine.stylable, cost: engine.cost, caveat: engine.caveat, voices, changed: true }));
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
        // The key is the SAME function `decklight voiceover` hashes with, and
        // that is the point: a sentence previewed here and then batch-recorded
        // is one synthesis, not two identical bills (SPEC `NARRATION`).
        const ext = extFor(engine.synth.mimeType ?? 'audio/wav');
        const key = clipKey(engine, { voice, style, text });
        let fresh = !cache.has(key);
        if (fresh) {
          const bytes = disk.read(key, ext);
          if (bytes) {
            cache.set(key, { wav: bytes, usage: { chars: 0, cost: 0, note: 'cached on disk' } });
            fresh = false;
            console.log(`  ${engine.name} ${picked}: ${text.length} chars · cached on disk`);
          }
        }
        if (fresh) {
          process.stdout.write(`  ${engine.name} ${picked}: ${text.length} chars … `);
          const t0 = Date.now();
          cache.set(key, await engine.synth(text, { voice, style }));
          disk.write(key, cache.get(key).wav, ext);
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

  // A TAKEN PORT IS NOT A CRASH. Without this the bind threw EADDRINUSE as an
  // unhandled 'error' event: a raw Node stack trace in the middle of author's
  // startup output, which reads as decklight falling over when the truth is
  // that something else has the port. The edit server has resolved conflicts
  // for a long time (cli/port-conflict.mjs) — the bridges simply never called
  // it, so they were the one place the deck could still look broken.
  //
  // On a TTY it names the occupant and offers a choice; anywhere else — and
  // author spawns these with a piped stdin, so that is the usual case — it
  // moves to the next free port and says so. The player finds the bridge by
  // probing, so a moved port costs nothing.
  // `canBind`, NOT `isPortOpen`: this file's own note says why, and getting it
  // wrong the first time proved the point. `isPortOpen` CONNECTS, answering "is
  // somebody there" — a listener that never accepts (backlog full, or a socket
  // opened and ignored) refuses the connect and reads as free, and then the
  // bind fails anyway. "May I have this port" is a different question and only
  // a trial bind answers it.
  //
  // `--port 0` is "let the OS pick", which cannot conflict — resolving it would
  // turn a deliberate 0 into port 1. Only a REAL port that is taken gets the
  // question; everything else binds exactly as before.
  const asked = port && !(await canBind(port))
    ? await resolvePortConflict(port, {
      kind: 'bridge',
      ask: process.stdin.isTTY && process.stdout.isTTY ? askLine : undefined,
      log: console.log,
    })
    : port;
  // null is "stand down" — either a bridge is already serving this port, or
  // somebody else holds it and this one cannot move (the deck only ever calls
  // the one number). Exiting is the honest outcome: author prints "carrying on
  // without it" and the deck degrades where you can see it, instead of a
  // bridge running somewhere nothing will ever knock.
  if (asked === null) process.exit(0);
  server.listen(asked, '127.0.0.1', () => {
    // The BOUND port, not the requested one: `--port 0` legitimately means
    // "pick a free one", and printing the 0 back made the one line telling a
    // presenter where their bridge is into an unusable URL.
    const bound = server.address()?.port ?? port;
    // `cost` is optional (SPEC ENGINE_UNITS) — an installed engine that
    // quotes no list price says nothing here rather than "(undefined)".
    const price = engine.cost ? ` (${engine.cost})` : '';
    // Under author this is a banner ROW, not a line: author prints one block
    // ending in the DECK's url, and a bridge url above it is the wrong thing
    // to click. Standalone, the bridge is the whole program and says so.
    if (process.env.DECKLIGHT_BANNER) {
      console.log(readyLine({ key: 'voice', text: `${engine.name} · ${engine.model}${price} — on :${bound}` }));
      if (engine.caveat) console.log(readyLine({ key: 'voice', text: engine.caveat }));
    } else {
      console.log(`decklight tts bridge on http://127.0.0.1:${bound} — ${engine.name} · ${engine.model}${price} — Ctrl-C stops`);
      // Stated here, once, where the presenter is still choosing — not
      // discovered mid-talk when the delivery already varied more than expected.
      if (engine.caveat) console.log(`  ${engine.caveat}`);
    }
    // piper loads a ~120 MB model on start; do it now, while the deck is still
    // being opened, so the first sentence isn't a 13-second silence
    if (engine.synth.warm) {
      console.log('  warming the model (first synthesis waits for it)…');
      engine.synth.warm();
    }
  });
}

if (isMain(import.meta.url)) ttsMain(process.argv.slice(2));
