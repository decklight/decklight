#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight video — render a deck to a narrated mp4.
//
//   decklight video deck.html -o deck.mp4
//                   [--narration <dir>] [--size 1280x720] [--fps 30] [--hold 5]
//                   [--theme <name>] [--slides a-b] [--voiceover]
//
// One still per slide (final build state), each held for the duration of its
// narration audio plus a short tail, muxed with that audio into one mp4 — a
// deck with generated narration becomes a watchable, shareable video in one
// command. Narration resolves --narration <dir> → <deckdir>/voiceover/
// (the manifest tools/voiceover.mjs writes) → a fully silent deck where every
// slide holds --hold seconds (per-slide override: data-video-hold="8" on the
// section). Silent slides still carry a silent audio segment (anullsrc) so the
// concatenated audio track stays continuous.
//
// Capture is the tools/shot.mjs mechanism: one one-shot headless Chrome per
// frame against file://deck.html#/n/999 (an oversized step clamps to the last
// build, so every slide renders fully built). No puppeteer, no CDP, no new
// deps — which is also the honest limit: frames are stills, so the character
// overlay appears but frozen, and timing is per-slide, not per-build-step
// (animated lipsync needs a CDP screencast — a Node ≥22 follow-up).

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromeBin, chromeArgs } from './chrome.mjs';
import { argReader } from './args.mjs';

const run = promisify(execFile);

/** Every slide breathes before the next one starts talking. */
export const TAIL_SECONDS = 0.4;

const HELP = `decklight video <deck.html> [options] — render the deck to a narrated mp4

  -o, --out <file>     output mp4 (default: <deck>.mp4 next to the deck)
  --narration <dir>    narration dir (default: <deckdir>/voiceover if it has a
                       manifest.json; otherwise the deck renders silent)
  --size <WxH>         frame size (default 1280x720; both must be even)
  --fps <n>            video frame rate (default 30)
  --hold <s>           seconds a slide without narration holds (default 5;
                       per-slide override: data-video-hold="8" on the section)
  --theme <name>       render with themes/<name>.css instead of the deck's theme
  --slides <a-b>       only this slide range (1-based, inclusive)
  --voiceover          run the voiceover batch (tools/voiceover.mjs) first

Slides with narration hold for the audio's real duration + ${TAIL_SECONDS}s; slides
without hold --hold seconds over silence, so the audio track stays continuous.
Needs ffmpeg + ffprobe on PATH, and a Chrome ($CHROME or an installed one).
`;

/** '1280x720' → { w, h }. Both even — libx264 yuv420p refuses odd dimensions. */
export function parseSize(s) {
  const m = /^(\d+)x(\d+)$/.exec(s ?? '');
  if (!m) throw new Error(`--size must be WxH, e.g. 1280x720 (got "${s}")`);
  const w = Number(m[1]); const h = Number(m[2]);
  if (w % 2 || h % 2) throw new Error(`--size must be even in both dimensions (yuv420p), got ${w}x${h}`);
  return { w, h };
}

/** '2-5' or '3' → { from, to } (1-based, inclusive), validated against the deck. */
export function parseSlideRange(s, total) {
  if (!s) return { from: 1, to: total };
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) throw new Error(`--slides must be a-b or a single slide number (got "${s}")`);
  const from = Number(m[1]); const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to > total || from > to) {
    throw new Error(`--slides ${s} is outside this deck (${total} slide${total === 1 ? '' : 's'})`);
  }
  return { from, to };
}

/** Per-slide hold seconds: data-video-hold="8" on the section, else the default. */
export function extractHolds(html, defaultHold) {
  return html.split(/<section\b/).slice(1).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    const m = tag.match(/data-video-hold="([\d.]+)"/);
    return m ? Number(m[1]) : defaultHold;
  });
}

/**
 * The per-slide schedule: which audio plays under slide n, and for how long.
 *
 * @param {Array|null} manifest   manifest.slides from tools/voiceover.mjs
 *                                ({ file } per slide, null for silent slides) —
 *                                or null for a fully silent deck
 * @param {object} durations      audio file → real (ffprobe) seconds
 * @param {number[]} holds        per-slide hold seconds (one per section)
 * @param {{from,to}} [range]     1-based inclusive slide range
 * @returns {Array<{slide, audio, duration}>}  audio null ⇒ silent hold
 */
export function planTimeline(manifest, durations, holds, range = null) {
  const from = range?.from ?? 1;
  const to = range?.to ?? holds.length;
  const plan = [];
  for (let n = from; n <= to; n++) {
    const file = manifest?.[n - 1]?.file ?? null;
    const dur = file ? durations?.[file] : null;
    plan.push(Number.isFinite(dur)
      ? { slide: n, audio: file, duration: Math.round((dur + TAIL_SECONDS) * 1000) / 1000 }
      : { slide: n, audio: null, duration: holds[n - 1] });
  }
  return plan;
}

/**
 * ffmpeg argv for one slide's segment: the still looped at --fps under its
 * audio. Narrated slides pad the audio with the tail and stop there; silent
 * slides synthesize the same stereo/44.1k silence (anullsrc), so every segment
 * carries an audio stream and the concat-demuxer's `-c copy` audio track never
 * goes discontinuous. -t bounds both the infinite loop and the infinite
 * anullsrc (-shortest can't end a segment whose streams are both endless).
 */
export function segmentArgs({ frame, audio, duration, fps, out }) {
  return [
    '-y', '-loop', '1', '-framerate', String(fps), '-i', frame,
    ...(audio
      ? ['-i', audio, '-af', `apad=pad_dur=${TAIL_SECONDS}`]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-t', Number(duration).toFixed(3), '-movflags', '+faststart', out,
  ];
}

/** The concat-demuxer list: one `file '…'` line per segment, quotes escaped. */
export function concatList(segments) {
  return segments.map((s) => `file '${s.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

/** ffmpeg argv joining the segments into the output without re-encoding. */
export function concatArgs(listFile, out) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy',
    '-movflags', '+faststart', out];
}

/** ffprobe argv for a file's real duration in seconds (prints one number). */
export function ffprobeArgs(file) {
  return ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file];
}

/**
 * Where the narration lives: --narration <dir> (its manifest is then required)
 * → <deckdir>/voiceover/manifest.json → null (a silent deck).
 * @returns {{ dir, slides }|null}
 */
export function resolveNarration(deckPath, narrationDir) {
  const load = (dir, required) => {
    const path = join(dir, 'manifest.json');
    if (!existsSync(path)) {
      if (required) {
        throw new Error(`--narration: no manifest.json in ${dir} — `
          + 'run tools/voiceover.mjs (or decklight video --voiceover) first');
      }
      return null;
    }
    const m = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(m?.slides)) {
      throw new Error(`${path}: not a voiceover manifest (no slides array) — regenerate it with tools/voiceover.mjs`);
    }
    return { dir, slides: m.slides };
  };
  if (narrationDir) return load(resolve(narrationDir), true);
  return load(join(resolve(deckPath, '..'), 'voiceover'), false);
}

const have = (bin) => {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; }
  catch (e) { return e?.code !== 'ENOENT'; }
};

export async function videoMain(argv, { exec = run, log = console.log } = {}) {
  const { opt } = argReader(argv);
  const deckArg = argv.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (argv.includes('--help') || !deckArg) {
    (deckArg ? process.stdout : process.stderr).write(HELP);
    process.exit(deckArg ? 0 : 1);
  }
  const deck = resolve(deckArg);
  if (!existsSync(deck)) { console.error(`decklight video: no such deck: ${deck}`); process.exit(1); }

  // the voiceover encoder-detection policy: a missing tool is a hard, friendly
  // error naming what to install — not a stack trace three steps later
  if (!have('ffmpeg') || !have('ffprobe')) {
    console.error('decklight video needs ffmpeg and ffprobe — install ffmpeg '
      + '(apt install ffmpeg / brew install ffmpeg)');
    process.exit(1);
  }

  let out; let plan; let narration;
  try {
    out = resolve(opt('-o', opt('--out', deck.replace(/\.html?$/i, '.mp4'))));
    const { w, h } = parseSize(opt('--size', '1280x720'));
    const fps = Number(opt('--fps', '30'));
    const hold = Number(opt('--hold', '5'));
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`--fps must be a positive number`);
    if (!Number.isFinite(hold) || hold <= 0) throw new Error(`--hold must be positive seconds`);
    const theme = opt('--theme');

    const html = readFileSync(deck, 'utf8');
    const holds = extractHolds(html, hold);
    if (!holds.length) throw new Error(`${basename(deck)} has no <section> slides`);
    const range = parseSlideRange(opt('--slides'), holds.length);

    if (argv.includes('--voiceover')) {
      const vo = [new URL('./voiceover.mjs', import.meta.url).pathname, deck];
      const nd = opt('--narration');
      if (nd) vo.push('-o', resolve(nd));
      const r = spawnSync(process.execPath, vo, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('voiceover batch failed — see its output above');
    }

    narration = resolveNarration(deck, opt('--narration'));

    // real durations, not the manifest's word count: ffprobe each audio file
    const durations = {};
    for (let n = range.from; n <= range.to; n++) {
      const file = narration?.slides?.[n - 1]?.file;
      if (!file || durations[file] != null) continue;
      const path = join(narration.dir, file);
      if (!existsSync(path)) {
        console.warn(`  slide ${String(n).padStart(2, '0')}: ${file} is in the manifest but not on disk — holding ${holds[n - 1]}s of silence`);
        continue;
      }
      durations[file] = Number((await exec('ffprobe', ffprobeArgs(path))).stdout.trim());
    }

    plan = planTimeline(narration?.slides ?? null, durations, holds, range);
    log(`${basename(deck)}: ${plan.length} slide${plan.length === 1 ? '' : 's'}, `
      + `${plan.filter((p) => p.audio).length} narrated`
      + (narration ? ` (${narration.dir})` : ' (silent)'));

    // --theme: a sibling copy so every relative href still resolves (shot.mjs)
    const src = theme
      ? deck.replace(/\.html?$/i, `.__video-${process.pid}.html`)
      : deck;
    if (theme) {
      writeFileSync(src, html.replace(/(<\/head>)/i,
        `<link rel="stylesheet" href="themes/${theme}.css">$1`));
    }

    const work = mkdtempSync(join(tmpdir(), 'decklight-video-'));
    try {
      const chrome = chromeBin('video');
      const segments = [];
      for (const p of plan) {
        const nn = String(p.slide).padStart(2, '0');
        const frame = join(work, `frame-${nn}.png`);
        // one one-shot Chrome per frame; #/n/999 clamps to the last build step
        await exec(chrome, chromeArgs(
          '--hide-scrollbars',
          '--allow-file-access-from-files',
          '--autoplay-policy=no-user-gesture-required',
          `--window-size=${w},${h}`,
          '--virtual-time-budget=1500',
          `--screenshot=${frame}`,
          `file://${src}#/${p.slide}/999`,
        ));
        if (!existsSync(frame)) throw new Error(`chrome produced no frame for slide ${p.slide}`);
        const seg = join(work, `seg-${nn}.mp4`);
        await exec('ffmpeg', segmentArgs({
          frame, duration: p.duration, fps, out: seg,
          audio: p.audio ? join(narration.dir, p.audio) : null,
        }));
        segments.push(seg);
        log(`  slide ${nn}: ${p.duration.toFixed(1)}s ${p.audio ?? '(silence)'}`);
      }

      const list = join(work, 'concat.txt');
      writeFileSync(list, concatList(segments));
      await exec('ffmpeg', concatArgs(list, out));
    } finally {
      rmSync(work, { recursive: true, force: true });
      if (theme) rmSync(src, { force: true });
    }

    const total = Number((await exec('ffprobe', ffprobeArgs(out))).stdout.trim());
    log(`done → ${out} (${total.toFixed(1)}s)`);
  } catch (e) {
    console.error(`decklight video: ${e.message}`);
    process.exit(1);
  }
}

// direct execution still works: node tools/video.mjs deck.html -o deck.mp4
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await videoMain(process.argv.slice(2));
}
