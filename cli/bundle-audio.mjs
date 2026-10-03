// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The narration's recorded audio in a bundle (SPEC DECK_ANATOMY): which files a
// deck's tracks play, how big each way of carrying them would make the file,
// and the blocks that carry them.
//
// Three ways, and leaving it out is a fourth:
//
//   original  the files as recorded: nothing lost, nothing gained
//   aac       mono AAC at 32 kbps, about 4 KB a second of voice: plays in
//             every browser, which is what a file that is SENT needs
//   opus      mono Opus at 24 kbps in WebM, about 3 KB a second and better
//             at that rate than AAC: the smallest, for a recent browser
//             (Safari from 17)
//
// A recorder WAV is about forty times the AAC. A re-encode that would not
// shrink a file leaves it as it was: encoding an already-small file again only
// loses. Every block is keyed by the URL the track would play, which is what
// the runtime looks up before playing that URL (narration.js bundledAudio).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredTrackDirs } from './edit.mjs';
import { runAsync, CODEC_MS, PROBE_MS } from '../tools/exec.mjs';

export const AUDIO_CHOICES = ['original', 'aac', 'opus'];

export const CODECS = {
  aac: {
    label: 'AAC, mono 32 kbps', kbps: 32, overhead: 1.03, ext: 'm4a', mime: 'audio/mp4', encoder: 'aac',
    args: ['-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart'],
  },
  opus: {
    label: 'Opus, mono 24 kbps', kbps: 24, overhead: 1.09, ext: 'webm', mime: 'audio/webm', encoder: 'libopus',
    // constrained VBR: the size stays near the bitrate whatever was recorded,
    // which is what lets the bundle card's estimate be one
    args: ['-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-vbr', 'constrained', '-application', 'voip'],
  },
};

const AUDIO_MIME = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac',
};
const AUDIO_FILE = /^slide-\d+(?:-\d+)?\.(m4a|mp4|aac|mp3|wav|ogg|oga|opus|webm|flac)$/i;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/** "1.4 MB", "820.3 KB". */
export const sizeLabel = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Every recorded file a deck's tracks would play from this disk: a
 * `narration.files` folder's `slide-NN[-KK].<audio>`, and a local manifest's
 * `file` entries. `found` maps the URL the runtime plays to the file;
 * `folders` reads "voices/ (12), cloud/ (3)"; `remote` counts manifest entries
 * with a `url` of their own (a bucket's, often signed), which stay there.
 */
export function narrationAudio(html, deckDir) {
  const found = new Map();
  const where = new Map();
  const add = (key, abs) => {
    if (found.has(key) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    found.set(key, abs);
    const folder = path.posix.dirname(key);
    where.set(folder, (where.get(folder) ?? 0) + 1);
  };
  for (const d of configuredTrackDirs(html)) {
    if (ABSOLUTE.test(d)) continue; // a public bucket's prefix: nothing on this disk
    const abs = path.resolve(deckDir, d);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs).sort()) if (AUDIO_FILE.test(f)) add(`${d.replace(/\/+$/, '')}/${f}`, path.join(abs, f));
  }
  let remote = 0;
  // `manifest: '…'` in a boot call, `"manifest": "…"` in a configuration block
  for (const rel of new Set([...html.matchAll(/\bmanifest["']?\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))) {
    const abs = path.resolve(deckDir, rel);
    let data = null;
    try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
    const clean = rel.replace(/[?#].*$/, '');
    const base = clean.slice(0, clean.lastIndexOf('/') + 1); // voicetrack.js manifestBase
    const entries = (data?.slides ?? []).flatMap((e) => (e ? [e, ...(e.segments ?? []).filter(Boolean)] : []));
    for (const e of entries) {
      if (e.url) { remote++; continue; }
      if (typeof e.file !== 'string' || ABSOLUTE.test(e.file)) continue;
      add(base + e.file, path.resolve(path.dirname(abs), e.file));
    }
  }
  return { found, remote, folders: [...where].map(([f, n]) => `${f}/ (${n})`).join(', ') };
}

/** The block one file goes in, as the bundle writes it. */
function block(key, mime, buf) {
  return `<script type="application/json" data-decklight-audio="${key.replace(/"/g, '&quot;')}">`
    + `${JSON.stringify(`data:${mime};base64,${buf.toString('base64')}`)}</script>`;
}
/** That block's length for `n` bytes, without building it. */
const blockLength = (key, mime, n) => block(key, mime, Buffer.alloc(0)).length + 4 * Math.ceil(n / 3) + 1;

/** Which of the two encoders this machine's ffmpeg has: `{ aac, opus }`, both false without one. */
export async function encoders() {
  try {
    const out = String(await runAsync('ffmpeg', ['-hide_banner', '-encoders'], { timeout: PROBE_MS, why: 'listing encoders' }));
    return { aac: /^\s*A\S*\s+aac\s/m.test(out), opus: /^\s*A\S*\s+libopus\s/m.test(out) };
  } catch { return { aac: false, opus: false }; }
}

/** A file's length in seconds, or null when ffprobe cannot say. */
async function duration(abs) {
  try {
    const out = await runAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs],
      { timeout: PROBE_MS, why: 'reading a duration' });
    const s = Number.parseFloat(String(out));
    return Number.isFinite(s) ? s : null;
  } catch { return null; }
}

/**
 * What each choice would add to the file, in bytes, before anything is
 * encoded: `original` exactly; `aac` and `opus` from each file's duration at
 * the codec's bitrate, plus what its container adds (measured: 3% for MP4,
 * 9% for WebM), never more than the file itself, because a re-encode that
 * would not shrink it is skipped.
 * A codec this ffmpeg lacks, or durations ffprobe cannot read, give null with
 * the reason in `why`.
 */
export async function estimateAudio(found) {
  const files = [...found];
  const have = await encoders();
  const seconds = await Promise.all(files.map(([, abs]) => duration(abs)));
  const known = seconds.every((s) => s != null);
  const sizes = files.map(([, abs]) => fs.statSync(abs).size);
  const original = files.reduce((n, [key, abs], i) => n + blockLength(key, AUDIO_MIME[path.extname(abs).slice(1).toLowerCase()], sizes[i]), 0);
  const out = { files: files.length, bytes: sizes.reduce((a, b) => a + b, 0), seconds: known ? seconds.reduce((a, b) => a + b, 0) : null, original, why: {} };
  for (const [name, c] of Object.entries(CODECS)) {
    if (!have[name]) { out[name] = null; out.why[name] = `needs ffmpeg with ${c.encoder}`; continue; }
    if (!known) { out[name] = null; out.why[name] = 'ffprobe could not read the durations'; continue; }
    out[name] = files.reduce((n, [key, abs], i) => {
      const encoded = Math.ceil(seconds[i] * c.kbps * 1000 / 8 * c.overhead) + 1024;
      return n + (encoded < sizes[i] ? blockLength(key, c.mime, encoded)
        : blockLength(key, AUDIO_MIME[path.extname(abs).slice(1).toLowerCase()], sizes[i]));
    }, 0);
  }
  return out;
}

/**
 * The blocks that carry `found`, as recorded or re-encoded with `codec`
 * ('original' | 'aac' | 'opus'). Throws an Error with a sentence when ffmpeg
 * is missing or refuses a file. Returns `{ blocks, bytes, before }`.
 */
export async function inlineAudio(found, codec = 'original') {
  const c = CODECS[codec] ?? null;
  const scratch = c ? fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-audio-')) : null;
  const blocks = [];
  let bytes = 0, before = 0, nth = 0;
  try {
    for (const [key, abs] of found) {
      let buf = fs.readFileSync(abs);
      let mime = AUDIO_MIME[path.extname(abs).slice(1).toLowerCase()];
      before += buf.length;
      if (c) {
        const out = path.join(scratch, `${++nth}.${c.ext}`);
        try {
          await runAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vn', ...c.args, out],
            { timeout: CODEC_MS, why: `re-encoding ${key}` });
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error(`--audio ${codec} re-encodes the narration with ffmpeg, which is not installed — install it, or bundle with --audio original to carry the files as they are`);
          throw new Error(`--audio ${codec} could not re-encode ${key}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
        }
        const small = fs.readFileSync(out);
        // an already-small file stays as it was: re-encoding it again only loses
        if (small.length < buf.length) { buf = small; mime = c.mime; }
      }
      bytes += buf.length;
      blocks.push(block(key, mime, buf));
    }
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { blocks, bytes, before };
}
