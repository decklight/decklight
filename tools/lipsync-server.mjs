#!/usr/bin/env node
// Lip-sync bridge: a tiny local HTTP server the player calls to turn
// narration audio into lip-sync data for the character overlay (SPEC PRESENTING).
// Everything runs on THIS machine — Rhubarb Lip Sync for viseme timelines,
// Wav2Lip / SadTalker (local python repos, your GPU) for talking-head video.
// No cloud service is involved; the browser just can't spawn native
// processes, so this bridge does, exactly like `decklight tts` holds the
// Google credentials the browser can't.
//
//   GET  /ping    → { ok, engines: { viseme, video: [names] }, portraits }
//   POST /viseme?text=<transcript>              (body: audio/wav)
//        → viseme timeline JSON v1 (tools/visemes.mjs)
//   POST /video?engine=wav2lip&portrait=<name>  (body: audio/wav)
//        → video/mp4 (muted talking head)
//   GET  /portrait?name=<name>  → image/jpeg: the still the clips are made from
//        (scaled, cropped square around the head) — shown under the video
//
//   decklight lipsync [--port 8789] [--rhubarb <bin>]
//                     [--portrait <name=img.png|clip.mp4>]…   (first one is 'default')
//                     [--wav2lip-dir <repo> --wav2lip-ckpt <pth>]
//                     [--sadtalker-dir <repo>] [--python <bin>]
//                     [--cache-dir ~/.cache/decklight/lipsync]
//
// Rhubarb: https://github.com/DanielSWolf/rhubarb-lip-sync — one static
// binary, ~0.1× real-time. The transcript (?text=) markedly improves cue
// accuracy, so the player always sends it. Wav2Lip suits LIVE mode (static
// pose → seamless per-sentence cuts, near real-time on a decent GPU);
// SadTalker suits BATCH clips (tools/lipsync.mjs) — minutes per clip.
//
// CORS is wide open (decks run on file://, origin "null") — the server binds
// 127.0.0.1 only. Results are cached ON DISK keyed by a hash of (audio,
// route, params): restarts keep the cache, so a replayed deck costs nothing
// and the player's 10-sentence lookahead only ever pays for new sentences.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { canBind, resolvePortConflict } from '../cli/port-conflict.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createVeo, DEFAULT_PROMPT, VEO_MODELS } from './veo.mjs';
import { argReader, isMain, parsePort, badPort } from './args.mjs';
import { runRhubarb, runWav2lip, runSadtalker, muteFaststart, prepareStill, faceBox, headCrop, mouthComposite, isClip, prepareClip, CLIP_MAX_SECONDS } from './lipsync-engines.mjs';
import { loadLipsyncConfig, saveLipsyncConfig, lipsyncConfigPath, videoSetup, SETUP_HINT, portraitsDir, withPortrait } from './lipsync-config.mjs';
import { corsHeaders, readBody } from './bridge.mjs';
import { readyLine } from '../cli/banner.mjs';

const run = promisify(execFile);

/** The largest film the deck may send — ten seconds of 1080p is well under it. */
const FILM_MAX = 200 * 1024 * 1024;

// width-limited job queue: rhubarb gets 2 lanes, the GPU exactly 1 — a burst
// of lookahead prefetches must never launch parallel model runs
function makeQueue(width) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= width || !waiting.length) return;
    active++;
    const { fn, res, rej } = waiting.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { waiting.push({ fn, res, rej }); next(); });
}

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

export async function lipsyncMain(args) {
  // A clean exit on SIGTERM, not the default abrupt one. Invisible in
  // production, decisive under test: V8 writes a process's coverage only when
  // it exits through process.exit, so a bridge the suite stops with SIGKILL —
  // or an unhandled SIGTERM — reports NOTHING of the handler it ran. The edit
  // and present servers already do this; voiceover-server does now too.
  process.on('SIGTERM', () => process.exit(0));
  if (args.includes('--help')) {
    console.log(`usage: decklight lipsync [--port 8789] [--rhubarb <bin>]
  [--portrait <name=img.png|clip.mp4>]... portraits offered for video mode (first = default)
  [--wav2lip-dir <repo> --wav2lip-ckpt <checkpoint.pth>]
  [--sadtalker-dir <repo>] [--python python3]
  [--cache-dir ~/.cache/decklight/lipsync]
  [--save]                              remember these (lipsync.json) — author then needs no flags
  [--veo] [--veo-project <id>] [--veo-model veo-3.1-lite-generate-001]
  [--veo-seconds 4|6|8] [--veo-prompt "..."] [--veo-location us-central1]
  [--veo-face-y 0.12]                   where the square crop starts, as a fraction of height

Viseme timelines need rhubarb on PATH (or --rhubarb):
  https://github.com/DanielSWolf/rhubarb-lip-sync
Talking-head video needs a local Wav2Lip and/or SadTalker checkout, its
Python, and at least one --portrait (a head-and-shoulders photo; a large one is
scaled down for the face detector). Everything runs offline on this machine.
A portrait can be FILMED instead (.mp4 .mov .m4v .webm .mkv): 5-10 s of you
facing the camera, mouth relaxed, blinking, not talking. Its first ${CLIP_MAX_SECONDS} s are
played forward then back, so the head never snaps back; hold the head still
and only the mouth is redrawn over the film.
Set it up once and --save it:
  ${SETUP_HINT}
Wav2Lip redraws the face at 96 px, so only the MOUTH is taken from it and laid
over the sharp photo.

--veo is the exception, and the only thing here that leaves the machine: it
animates each portrait ONCE through Veo on Vertex AI (head turns, blinks,
shoulders) and hands Wav2Lip that clip instead of the still, so the narrator
moves like a person instead of staring. One billed call per portrait, cached
in --cache-dir forever; the per-sentence lip-sync stays local on your GPU.
Give it a HEAD-AND-SHOULDERS portrait (3:4 or taller). The clip is cropped
square around the head for the deck's circular overlay, and a tight square
photo puts the face lower in Veo's 9:16 frame — chin off the bottom. Nudge
--veo-face-y up (~0.22) for such a portrait, or feed it one with headroom.`);
    return;
  }
  const { opt, opts } = argReader(args);
  const port = parsePort(opt('--port', 8789));
  if (port === null) { console.error(`decklight lipsync: ${badPort('--port', opt('--port'))}`); process.exitCode = 1; return; }
  // Flags win; what `--save` remembered fills the rest (tools/lipsync-config.mjs),
  // so a talking head set up once starts with every `decklight author`.
  const saved = loadLipsyncConfig() ?? {};
  const rhubarb = opt('--rhubarb', saved.rhubarb ?? 'rhubarb');
  const python = opt('--python', saved.python ?? 'python3');
  const wav2lipDir = opt('--wav2lip-dir', saved.wav2lipDir);
  const wav2lipCkpt = opt('--wav2lip-ckpt', saved.wav2lipCkpt);
  const sadtalkerDir = opt('--sadtalker-dir', saved.sadtalkerDir);
  const portraitSpecs = opts('--portrait').length ? opts('--portrait') : (saved.portraits ?? []);
  if (args.includes('--save')) {
    const abs = (p) => (p ? resolve(p) : undefined);
    const next = {
      ...saved,
      ...(wav2lipDir ? { wav2lipDir: abs(wav2lipDir) } : {}),
      ...(wav2lipCkpt ? { wav2lipCkpt: abs(wav2lipCkpt) } : {}),
      ...(sadtalkerDir ? { sadtalkerDir: abs(sadtalkerDir) } : {}),
      ...(python !== 'python3' ? { python: python.includes('/') ? abs(python) : python } : {}),
      ...(portraitSpecs.length ? { portraits: portraitSpecs.map((sp) => {
        const at = sp.indexOf('=');
        return at > 0 ? `${sp.slice(0, at)}=${abs(sp.slice(at + 1))}` : abs(sp);
      }) } : {}),
    };
    const { engines, problems } = videoSetup(next);
    console.log(`saved to ${saveLipsyncConfig(next)} — decklight <deck> starts the lip-sync bridge with it from now on`);
    console.log(engines.length ? `  neural video: ${engines.join(', ')} ready` : '  neural video: not ready yet');
    for (const p of problems) console.log(`  ${p}`);
    // saving is the whole job: `author` starts the bridge with it (and a second
    // bridge here would only fight the one author runs for the port)
    process.exitCode = problems.length && !engines.length ? 1 : 0;
    return;
  }
  const cacheDir = resolve(opt('--cache-dir', join(homedir(), '.cache', 'decklight', 'lipsync')));
  mkdirSync(cacheDir, { recursive: true });

  // Veo: the portrait's MOTION, bought once (tools/veo.mjs). Only wav2lip can
  // use it — SadTalker animates the head itself and wants a still.
  const veoOn = args.includes('--veo');
  let veo = null;
  if (veoOn) {
    try {
      veo = createVeo({
        project: opt('--veo-project', process.env.GOOGLE_CLOUD_PROJECT),
        location: opt('--veo-location', 'us-central1'),
        model: opt('--veo-model', VEO_MODELS[0]),
        seconds: Number(opt('--veo-seconds', 8)),
        prompt: opt('--veo-prompt', DEFAULT_PROMPT),
        faceY: Number(opt('--veo-face-y', 0.12)),
        cacheDir,
      });
    } catch (e) {
      // A misconfigured --veo must not cost you the whole bridge: visemes and
      // still-portrait video still work, so say what broke and carry on.
      console.error(`veo disabled — ${e.message}`);
      veo = null;
    }
  }

  // portraits: --portrait alice=face.png (or a bare path — named by basename)
  const portraits = new Map();
  for (const p of portraitSpecs) {
    if (!p) continue;
    const eq = p.indexOf('=');
    const name = eq > 0 ? p.slice(0, eq) : basename(p).replace(/\.[^.]+$/, '');
    const file = resolve(eq > 0 ? p.slice(eq + 1) : p);
    if (!existsSync(file)) { console.error(`portrait not found: ${file}`); process.exitCode = 1; return; }
    if (!portraits.size) portraits.set('default', file); // first doubles as 'default'
    portraits.set(name, file);
  }

  const has = async (bin, flags = ['--version']) => {
    try { await run(bin, flags); return true; } catch (e) { return e?.code !== 'ENOENT'; }
  };
  const visemeOk = await has(rhubarb);
  const ffmpegOk = await has('ffmpeg', ['-version']);
  const wav2lipReady = !!(wav2lipDir && wav2lipCkpt && existsSync(join(wav2lipDir, 'inference.py')) && existsSync(wav2lipCkpt));
  const sadtalkerReady = !!(sadtalkerDir && existsSync(join(sadtalkerDir, 'inference.py')));
  // grows when a portrait is filmed from the deck (POST /portrait)
  const videoEngines = [];
  const enginesNow = () => {
    if (!portraits.size) return;
    if (wav2lipReady && !videoEngines.includes('wav2lip')) videoEngines.push('wav2lip');
    if (sadtalkerReady && !videoEngines.includes('sadtalker')) videoEngines.push('sadtalker');
  };
  enginesNow();
  // Filming yourself from the deck needs Wav2Lip's face detector and ffmpeg
  // here — not a portrait: filming is how the first one gets made.
  const filmWhy = !wav2lipReady ? (videoSetup({ wav2lipDir, wav2lipCkpt, python }).problems[0] ?? `Wav2Lip is not set up — ${SETUP_HINT}`)
    : !ffmpegOk ? 'ffmpeg is not installed on this machine' : null;
  // What stands in the way of video, in the same words doctor and the deck use
  const setupNow = videoSetup({ wav2lipDir, wav2lipCkpt, sadtalkerDir, python, portraits: portraitSpecs });
  if (!videoEngines.length) {
    for (const p of setupNow.problems) console.log(`  video: ${p}`);
    if (!wav2lipDir && !sadtalkerDir) console.log(`  video: not set up — ${SETUP_HINT}`);
    else if (!filmWhy) console.log('  video: or film yourself from the deck — V → Character → Film yourself');
  }
  // Wav2Lip with no portrait yet still serves: filming one is what the deck does next
  if (!visemeOk && !videoEngines.length && filmWhy) {
    console.error(`neither engine is usable:
  visemes — rhubarb not found (install it, or pass --rhubarb <bin>)
  video   — needs Wav2Lip or SadTalker and a portrait, set up once: ${SETUP_HINT}`);
    process.exitCode = 1;
    return;
  }

  const rhubarbQ = makeQueue(2);
  const gpuQ = makeQueue(1);
  const inflight = new Map(); // cache key → promise, dedups concurrent misses
  const dedup = (key, fn) => {
    if (!inflight.has(key)) {
      const p = fn().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return inflight.get(key);
  };
  const sha = (...parts) => {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return h.digest('hex').slice(0, 32);
  };

  async function visemes(wav, text) {
    const key = sha('viseme|', text, '|', wav);
    const out = join(cacheDir, `${key}.json`);
    if (existsSync(out)) return { body: readFileSync(out), cached: true };
    await dedup(key, () => rhubarbQ(async () => {
      if (existsSync(out)) return;
      const tmpWav = join(cacheDir, `${key}.tmp.wav`);
      const tmpTxt = join(cacheDir, `${key}.tmp.txt`);
      const tmpOut = join(cacheDir, `${key}.tmp.json`);
      writeFileSync(tmpWav, wav);
      if (text.trim()) writeFileSync(tmpTxt, text);
      try {
        const t0 = Date.now();
        const tl = await runRhubarb(rhubarb, { wav: tmpWav, dialogFile: text.trim() ? tmpTxt : undefined, out: tmpOut, timeout: 120000 });
        writeFileSync(out, JSON.stringify(tl));
        console.log(`  viseme: ${(wav.length / 1024).toFixed(0)} KB wav → ${tl.cues.length} cues · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } finally {
        for (const f of [tmpWav, tmpTxt, tmpOut]) rmSync(f, { force: true });
      }
    }));
    return { body: readFileSync(out), cached: false };
  }

  /**
   * A portrait as the clips are made from it: scaled down for the face
   * detector, its face box found once, cropped square around the head — and
   * what the deck shows UNDER the video (GET /portrait), so the photo and the
   * clips line up exactly. Cached per portrait; `box` is null without Wav2Lip.
   * A FILMED portrait (a video) becomes a forward-and-back loop the same way
   * (`prepareClip`): `loop` is what Wav2Lip is given, `file` its first frame,
   * and `box` is only kept when the head held still enough to use it.
   */
  const prepared = new Map();
  function stillFor(name) {
    const still = portraits.get(name);
    if (!still) return Promise.reject(new Error(`unknown portrait '${name}'`));
    // keyed by FILE: 'default' and its own name are one portrait, prepared once
    if (!prepared.has(still)) {
      prepared.set(still, (async () => {
        if (isClip(still)) {
          // without ffmpeg or Wav2Lip's detector the film goes in as it is:
          // Wav2Lip finds the face per frame, and the loop jumps at its end
          if (!ffmpegOk || !wav2lipDir) return { file: null, loop: still, box: null };
          const t0 = Date.now();
          const c = await prepareClip(python, { dir: wav2lipDir, clip: still, cacheDir });
          console.log(`  portrait ${name}: filmed · ${c.seconds.toFixed(1)}s, played there and back · face in ${c.faces} frames · `
            + (c.steady ? 'head steady — only the mouth is redrawn'
              : 'head moves — the whole face is redrawn (softer); film with the head still for a sharper one')
            + ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          return { file: c.still, loop: c.loop, box: c.steady ? c.box : null };
        }
        const small = await prepareStill(still, cacheDir).catch(() => still);
        const found = wav2lipDir ? await faceBox(python, { dir: wav2lipDir, still: small, cacheDir }).catch(() => null) : null;
        const head = found && ffmpegOk ? await headCrop(small, found, cacheDir).catch(() => null) : null;
        return { file: head?.file ?? small, box: head?.box ?? found };
      })());
      prepared.get(still).catch((e) => {
        console.error(`  portrait ${name}: ${String(e.message ?? e).slice(0, 200)}`);
        prepared.delete(still);
      });
    }
    return prepared.get(still);
  }

  async function video(wav, engine, portraitName) {
    if (!videoEngines.includes(engine)) throw new Error(`engine '${engine}' not available`);
    const still = portraits.get(portraitName);
    if (!still) throw new Error(`unknown portrait '${portraitName}'`);
    // With --veo, wav2lip's source is the portrait's motion clip rather than the
    // portrait: same model, same per-sentence cost, but the head is alive under
    // the new mouth. Bought once per portrait and cached (tools/veo.mjs), so
    // this awaits a network call only the very first time. SadTalker is left
    // alone — it makes its own head motion and needs the still.
    // A filmed portrait already moves: Veo is not asked to animate a film.
    const filmed = isClip(still);
    const moving = veo && engine === 'wav2lip' && !filmed;
    // a phone photo is too big for the face detector, and the head should fill
    // the round overlay: scaled, face found, cropped — once per portrait
    const ready = moving ? null : await stillFor(portraitName);
    const small = ready?.file ?? still;
    if (filmed && engine !== 'wav2lip' && !ready?.file) throw new Error(`${engine} needs a still — no frame could be taken from ${still} (is ffmpeg installed?)`);
    const face = moving ? await veo.motionFor(still) : filmed && engine === 'wav2lip' ? ready.loop : small;
    // the key reads `face`, so a veo clip and a still can never share a cache
    // entry — flip --veo off and yesterday's clips are still there, untouched.
    // `mouth-v1`: clips from before the mouth-only composite are not reused.
    const key = sha('video|head-v2|', engine, '|', readFileSync(face), '|', wav);
    const out = join(cacheDir, `${key}.mp4`);
    if (existsSync(out)) return { body: readFileSync(out), cached: true };
    await dedup(key, () => gpuQ(async () => {
      if (existsSync(out)) return;
      const tmpWav = join(cacheDir, `${key}.tmp.wav`);
      const tmpMp4 = join(cacheDir, `${key}.tmp.mp4`);
      const tmpDir = join(cacheDir, `${key}.tmp.d`);
      writeFileSync(tmpWav, wav);
      try {
        const t0 = Date.now();
        process.stdout.write(`  video ${engine} · ${portraitName}: ${(wav.length / 1024).toFixed(0)} KB wav … `);
        if (engine === 'wav2lip') {
          // A still is ONE frame to detect a face in; a --veo motion clip is a
          // couple of hundred. Wav2Lip's face detector batches 16 frames by
          // default, halving on CUDA OOM until it gives up at 1 with "Image too
          // big to run face detection on GPU" — which it will do on an 8 GB card
          // that a desktop is already using half of. Batch small instead: the
          // clip is short, and the GPU queue is serial anyway.
          // A still's face is found ONCE (cached), handed to Wav2Lip as --box so
          // it skips detection per clip — and it places the mouth-only
          // composite below. A motion clip moves, so neither applies to it.
          // the head-cropped still and its face box (stillFor) — handed to
          // Wav2Lip as --box so it skips detection per clip
          // A filmed portrait whose head held still gets the same: one box for
          // every frame, and the mouth laid over the film (frame-aligned).
          const src = face;
          const box = moving ? null : ready?.box ?? null;
          const raw = box ? join(cacheDir, `${key}.tmp.raw.mp4`) : tmpMp4;
          await runWav2lip(python, { dir: wav2lipDir, checkpoint: wav2lipCkpt, face: src,
            wav: tmpWav, out: raw, smallBatches: moving || (filmed && !box), box, timeout: 600000 });
          // Wav2Lip redraws the whole face at 96 px; keep the photo sharp and
          // take only the mouth from it (lipsync-engines.mjs `mouthComposite`)
          if (box && ffmpegOk) {
            try { await mouthComposite(src, raw, box, tmpMp4); }
            finally { rmSync(raw, { force: true }); }
          } else if (box) renameSync(raw, tmpMp4);
        } else {
          // SadTalker writes <timestamp>/….mp4 into result_dir — runSadtalker
          // takes the newest and moves it to tmpMp4.
          await runSadtalker(python, { dir: sadtalkerDir, still: small,
            wav: tmpWav, out: tmpMp4, resultDir: tmpDir, timeout: 1800000 });
        }
        // strip the audio track (playback is muted — narrAudio is the voice)
        // and front-load the moov atom so the player can start instantly
        if (ffmpegOk) await muteFaststart(tmpMp4, out, { timeout: 120000 });
        else copyFileSync(tmpMp4, out);
        console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s → ${(statSync(out).size / 1024).toFixed(0)} KB`);
      } finally {
        for (const f of [tmpWav, tmpMp4]) rmSync(f, { force: true });
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }));
    return { body: readFileSync(out), cached: false };
  }

  const CORS = corsHeaders('x-lipsync-cached');

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        engines: { viseme: visemeOk, video: videoEngines },
        // why there is no video, in the words doctor uses — the deck says it
        ...(videoEngines.length ? {} : { videoWhy: setupNow.problems[0] ?? 'no Wav2Lip or SadTalker set up' }),
        // what the head is driven from: a veo motion clip, or the still photo
        motion: veo ? { engine: 'veo', model: veo.model, seconds: veo.seconds } : null,
        // whether the deck may film a portrait here (POST /portrait), and why not
        film: !filmWhy, ...(filmWhy ? { filmWhy } : {}),
        portraits: [...portraits.keys()],
      }));
    }
    // the portrait the clips are made from, for the deck to show UNDER the
    // video — so the medallion is the photo, not black, while a clip renders
    if (req.method === 'GET' && url.pathname === '/portrait') {
      try {
        const { file } = await stillFor(url.searchParams.get('name') || 'default');
        if (!file) throw new Error('no still for a film without ffmpeg');
        res.writeHead(200, { ...CORS, 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
        return res.end(readFileSync(file));
      } catch (e) {
        res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
        return res.end(String(e.message ?? e));
      }
    }
    // A portrait filmed in the deck: prepared like any film, kept beside
    // lipsync.json, remembered there, and offered at once — no restart.
    if (req.method === 'POST' && url.pathname === '/portrait') {
      const answer = (code, body) => { res.writeHead(code, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const name = url.searchParams.get('name') || 'filmed';
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || name === 'default') return answer(400, { error: `a portrait name is letters, digits, - and _ (not '${name}')` });
      if (filmWhy) return answer(409, { error: filmWhy });
      const type = String(req.headers['content-type'] ?? '');
      const ext = /mp4/.test(type) ? '.mp4' : /webm/.test(type) ? '.webm' : /quicktime/.test(type) ? '.mov' : null;
      if (!ext) return answer(415, { error: `a film is video/mp4, video/webm or video/quicktime, not '${type || 'nothing'}'` });
      const tmp = join(cacheDir, `upload-${process.pid}-${Date.now()}${ext}`);
      try {
        const body = await readBody(req, { max: FILM_MAX });
        if (body.length < 1024) return answer(400, { error: 'no film in the request' });
        writeFileSync(tmp, body);
        const t0 = Date.now();
        const c = await prepareClip(python, { dir: wav2lipDir, clip: tmp, cacheDir });
        const dir = portraitsDir();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${name}${ext}`);
        // a retake in another container must not leave the old take behind
        for (const old of ['.mp4', '.webm', '.mov']) if (old !== ext) rmSync(join(dir, `${name}${old}`), { force: true });
        copyFileSync(tmp, file);
        prepared.delete(file);          // a retake: same path, new film
        if (!portraits.size) portraits.set('default', file);
        portraits.set(name, file);
        enginesNow();
        const saved = saveLipsyncConfig(withPortrait(loadLipsyncConfig(), name, file,
          { wav2lipDir: resolve(wav2lipDir), wav2lipCkpt: resolve(wav2lipCkpt), python: python.includes('/') ? resolve(python) : python }));
        console.log(`  portrait ${name}: filmed in the deck · ${c.seconds.toFixed(1)}s · face in ${c.faces} frames · `
          + `${c.steady ? 'head steady' : 'head moves'} · ${((Date.now() - t0) / 1000).toFixed(1)}s → ${file}`);
        return answer(200, { ok: true, name, file, saved, seconds: c.seconds, steady: c.steady, faces: c.faces });
      } catch (e) {
        const msg = String(e.message ?? e);
        console.error(`  portrait ${name}: ${msg.slice(0, 200)}`);
        return answer(e.code === 'E2BIG' ? 413 : /no face found/.test(msg) ? 422 : 500,
          { error: e.code === 'E2BIG' ? `a film is at most ${FILM_MAX / 1024 / 1024} MB` : msg.replace(tmp, 'the film') });
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    if (req.method === 'POST' && (url.pathname === '/viseme' || url.pathname === '/video')) {
      try {
        const wav = await readBody(req);
        if (wav.length < 44) { res.writeHead(400, CORS); return res.end('no audio'); }
        const out = url.pathname === '/viseme'
          ? await visemes(wav, url.searchParams.get('text') ?? '')
          : await video(wav, url.searchParams.get('engine') ?? 'wav2lip', url.searchParams.get('portrait') ?? 'default');
        res.writeHead(200, {
          ...CORS,
          'content-type': url.pathname === '/viseme' ? 'application/json' : 'video/mp4',
          'x-lipsync-cached': out.cached ? '1' : '0',
        });
        return res.end(out.body);
      } catch (e) {
        console.error(`  ${url.pathname.slice(1)} error: ${String(e).slice(0, 160)}`);
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
    const what = [visemeOk && 'visemes (rhubarb)', ...videoEngines.map((e) => `video (${e})`)].filter(Boolean).join(' · ')
      || 'no portrait yet — film one from the deck (V → Character)';
    if (process.env.DECKLIGHT_BANNER) console.log(readyLine({ key: 'lips', text: `${what} — on :${port}` }));
    else console.log(`decklight lipsync bridge on http://127.0.0.1:${port} — ${what} — Ctrl-C stops`);
    if (veo) {
      console.log(`veo: ${veo.model} · ${veo.seconds}s — each portrait is animated ONCE (billed), `
        + 'then wav2lip re-syncs that clip locally for every sentence');
    }
    console.log(`cache: ${cacheDir}`);
    // A filmed portrait takes a minute to prepare (a face found in every
    // second of it): start now, not on the first sentence of the talk.
    if (videoEngines.length) {
      const seen = new Set();
      // by the name it was given, not the 'default' alias it also answers to
      for (const [name, file] of [...portraits].reverse()) {
        if (!seen.has(file)) { seen.add(file); stillFor(name).catch(() => {}); }
      }
    }
  });
  return server;
}

if (isMain(import.meta.url)) {
  lipsyncMain(process.argv.slice(2)).catch((e) => { console.error(`decklight lipsync: ${e.message}`); process.exitCode = 1; });
}
