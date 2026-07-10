#!/usr/bin/env node
// Lip-sync bridge: a tiny local HTTP server the player calls to turn
// narration audio into lip-sync data for the character overlay (SPEC §8).
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
//
//   decklight lipsync [--port 8789] [--rhubarb <bin>]
//                     [--portrait <name=img.png>]…   (first one is 'default')
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
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { normalizeRhubarb } from './visemes.mjs';

const run = promisify(execFile);

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

export async function lipsyncMain(args) {
  if (args.includes('--help')) {
    console.log(`usage: decklight lipsync [--port 8789] [--rhubarb <bin>]
  [--portrait <name=img.png>]...        portraits offered for video mode (first = default)
  [--wav2lip-dir <repo> --wav2lip-ckpt <checkpoint.pth>]
  [--sadtalker-dir <repo>] [--python python3]
  [--cache-dir ~/.cache/decklight/lipsync]

Viseme timelines need rhubarb on PATH (or --rhubarb):
  https://github.com/DanielSWolf/rhubarb-lip-sync
Talking-head video needs a local Wav2Lip and/or SadTalker checkout, a GPU,
and at least one --portrait. Everything runs offline on this machine.`);
    return;
  }
  const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const opts = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const port = Number(opt('--port', 8789));
  const rhubarb = opt('--rhubarb', 'rhubarb');
  const python = opt('--python', 'python3');
  const wav2lipDir = opt('--wav2lip-dir');
  const wav2lipCkpt = opt('--wav2lip-ckpt');
  const sadtalkerDir = opt('--sadtalker-dir');
  const cacheDir = resolve(opt('--cache-dir', join(homedir(), '.cache', 'decklight', 'lipsync')));
  mkdirSync(cacheDir, { recursive: true });

  // portraits: --portrait alice=face.png (or a bare path — named by basename)
  const portraits = new Map();
  for (const p of opts('--portrait')) {
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
  const videoEngines = [];
  if (wav2lipDir && wav2lipCkpt && existsSync(join(wav2lipDir, 'inference.py')) && existsSync(wav2lipCkpt) && portraits.size) videoEngines.push('wav2lip');
  if (sadtalkerDir && existsSync(join(sadtalkerDir, 'inference.py')) && portraits.size) videoEngines.push('sadtalker');
  if (!visemeOk && !videoEngines.length) {
    console.error(`neither engine is usable:
  visemes — rhubarb not found (install it, or pass --rhubarb <bin>)
  video   — needs --wav2lip-dir/--wav2lip-ckpt or --sadtalker-dir, plus --portrait`);
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
      const dialog = text.trim() ? (writeFileSync(tmpTxt, text), ['--dialogFile', tmpTxt]) : [];
      try {
        const t0 = Date.now();
        await run(rhubarb, ['-f', 'json', '-o', tmpOut, '--machineReadable', ...dialog, tmpWav], { timeout: 120000 });
        const tl = normalizeRhubarb(JSON.parse(readFileSync(tmpOut, 'utf8')));
        writeFileSync(out, JSON.stringify(tl));
        console.log(`  viseme: ${(wav.length / 1024).toFixed(0)} KB wav → ${tl.cues.length} cues · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } finally {
        for (const f of [tmpWav, tmpTxt, tmpOut]) rmSync(f, { force: true });
      }
    }));
    return { body: readFileSync(out), cached: false };
  }

  async function video(wav, engine, portraitName) {
    if (!videoEngines.includes(engine)) throw new Error(`engine '${engine}' not available`);
    const face = portraits.get(portraitName);
    if (!face) throw new Error(`unknown portrait '${portraitName}'`);
    const key = sha('video|', engine, '|', readFileSync(face), '|', wav);
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
          await run(python, ['inference.py', '--checkpoint_path', resolve(wav2lipCkpt),
            '--face', face, '--audio', tmpWav, '--outfile', tmpMp4],
          { cwd: resolve(wav2lipDir), timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
        } else {
          mkdirSync(tmpDir, { recursive: true });
          await run(python, ['inference.py', '--driven_audio', tmpWav,
            '--source_image', face, '--result_dir', tmpDir],
          { cwd: resolve(sadtalkerDir), timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
          // SadTalker writes <timestamp>/….mp4 into result_dir — take the newest
          const found = [];
          const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (f.endsWith('.mp4')) found.push([s.mtimeMs, p]); } };
          walk(tmpDir);
          if (!found.length) throw new Error('sadtalker produced no mp4');
          renameSync(found.sort((a, b) => b[0] - a[0])[0][1], tmpMp4);
        }
        // strip the audio track (playback is muted — narrAudio is the voice)
        // and front-load the moov atom so the player can start instantly
        if (ffmpegOk) await run('ffmpeg', ['-y', '-i', tmpMp4, '-an', '-movflags', '+faststart', '-c:v', 'copy', out], { timeout: 120000 });
        else copyFileSync(tmpMp4, out);
        console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s → ${(statSync(out).size / 1024).toFixed(0)} KB`);
      } finally {
        for (const f of [tmpWav, tmpMp4]) rmSync(f, { force: true });
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }));
    return { body: readFileSync(out), cached: false };
  }

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-expose-headers': 'x-lipsync-cached',
  };

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        engines: { viseme: visemeOk, video: videoEngines },
        portraits: [...portraits.keys()],
      }));
    }
    if (req.method === 'POST' && (url.pathname === '/viseme' || url.pathname === '/video')) {
      try {
        // body read INSIDE the try: a client abort mid-request rejects the
        // stream, and outside the try it would crash the whole bridge
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const wav = Buffer.concat(chunks);
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

  server.listen(port, '127.0.0.1', () => {
    const what = [visemeOk && 'visemes (rhubarb)', ...videoEngines.map((e) => `video (${e})`)].filter(Boolean).join(' · ');
    console.log(`decklight lipsync bridge on http://127.0.0.1:${port} — ${what} — Ctrl-C stops`);
    console.log(`cache: ${cacheDir}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) lipsyncMain(process.argv.slice(2));
