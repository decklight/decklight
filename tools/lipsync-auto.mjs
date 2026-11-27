// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Lip-sync that follows the audio (#1244, SPEC CHARACTER).
 *
 * A deck with a 2D character (`narration.character.mode: 'viseme'`) plays a
 * `slide-NN[-KK].visemes.json` beside each audio file. Whatever writes that
 * audio — `decklight narrate`, the export's re-voicing of stale slides, the
 * deck's own "Generate an AI recording" — calls THIS afterwards, so the
 * sidecars are cut from the audio that is now on disk instead of waiting for
 * someone to remember `decklight narrate <deck> --face`.
 *
 * Two halves:
 *   - `lipsyncStatus(dir)`: which stems' sidecars are missing or belong to
 *     another recording (tools/viseme-match.mjs: the `audio` stamp, then the
 *     lipsync.json hash, then the length). The voice card shows it.
 *   - `makeLipsync(dir, stems)`: tools/lipsync.mjs on just those stems, in
 *     parallel (`--jobs`), its `[k/N]` progress passed on line by line.
 *
 * Without Rhubarb the sidecars are still made, read from the voice
 * (tools/mouth.mjs, marked `source: 'builtin'`), and the caller says ONCE how
 * to get Rhubarb's (`RHUBARB_HINT`). Once Rhubarb is here those count as out
 * of date (tools/viseme-match.mjs), so the next run replaces them.
 *
 * A slide filmed with your face (the manifest's `face`, and its .mp4 beside
 * the audio) plays the film, not the character, so it is never counted or cut.
 *
 * Node-only.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, PROBE_MS } from './exec.mjs';
import { loadLipsyncConfig } from './lipsync-config.mjs';
import { visemeMismatch, wavDuration } from './viseme-match.mjs';
import { deckConfigSource } from '../cli/runtime-link.mjs';

const LIPSYNC = fileURLToPath(new URL('./lipsync.mjs', import.meta.url));

/** Said once, when audio was written and its lip-sync could not be. */
export const RHUBARB_HINT = 'lip-sync read from the voice: Rhubarb is not installed, which makes it more exact. '
  + 'Install it from https://github.com/DanielSWolf/rhubarb-lip-sync and run decklight setup face --rhubarb <bin>; '
  + 'then decklight narrate <deck> --face (or the voice card\'s "Update lip-sync") remakes it';

/** The deck's configured character mode: 'viseme', 'video', 'off', or null when it names none. */
export function characterMode(html) {
  try { return deckConfigSource(html).config?.narration?.character?.mode ?? null; } catch { return null; }
}

/** The Rhubarb this machine would run: what `decklight setup face` saved, else the one on PATH. */
export function rhubarbBin(env = process.env) {
  return loadLipsyncConfig(env)?.rhubarb ?? 'rhubarb';
}

/** Whether Rhubarb runs here. */
export function haveRhubarb(bin = rhubarbBin(), probe = run) {
  try { probe(bin, ['--version'], { stdio: 'ignore', timeout: PROBE_MS }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
}

// asked at most every 30 s: the voice card polls the status, and installing
// Rhubarb mid-session should still be noticed
let rhubarbSeen = null;
function rhubarbNow() {
  if (!rhubarbSeen || Date.now() - rhubarbSeen.at > 30_000) rhubarbSeen = { at: Date.now(), have: haveRhubarb() };
  return rhubarbSeen.have;
}

/** The stems of slides filmed with your face: they play the film, never the character. */
function filmedStems(dir, stems) {
  let m;
  try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { return new Set(); }
  const filmed = new Set((m?.slides ?? []).map((e, i) => (e?.face === true ? String(i + 1).padStart(2, '0') : null)).filter(Boolean));
  return new Set(stems.filter((st) => filmed.has(st.slice(6, 8)) && existsSync(join(dir, `${st}.mp4`))));
}

// file → [stat key, verdict]: a track of 150 WAVs is read once, not on every
// open of the voice card
const memo = new Map();
const statKey = (f) => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'none'; } };

/**
 * The lip-sync of the track in `dir`: `{ stems, stale }` — every stem with
 * audio the character plays, and those whose sidecar is missing or is not
 * this audio's, each `{ stem, why }`.
 */
export function lipsyncStatus(dir, { rhubarb = rhubarbNow() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return { stems: [], stale: [] }; }
  const audioOf = new Map();
  for (const f of names) {
    const m = /^(slide-\d+(?:-\d+)?)\.(wav|m4a)$/.exec(f);
    // wav first: it is what lipsync.mjs cuts from, and what the deck plays
    if (m && (!audioOf.has(m[1]) || m[2] === 'wav')) audioOf.set(m[1], join(dir, f));
  }
  const all = [...audioOf.keys()].sort();
  const filmed = filmedStems(dir, all);
  const stems = all.filter((st) => !filmed.has(st));
  let state = {};
  try { state = JSON.parse(readFileSync(join(dir, 'lipsync.json'), 'utf8')); } catch { /* none kept */ }
  const stale = [];
  for (const stem of stems) {
    const audio = audioOf.get(stem);
    const side = join(dir, `${stem}.visemes.json`);
    const txt = join(dir, `${stem}.txt`);
    const key = [statKey(audio), statKey(side), statKey(txt), state[stem]?.visemes ?? '', rhubarb].join('|');
    const hit = memo.get(side);
    let why;
    if (hit?.[0] === key) why = hit[1];
    else {
      why = null;
      if (!existsSync(side)) why = 'it is missing';
      else {
        let tl = null;
        try { tl = JSON.parse(readFileSync(side, 'utf8')); } catch { /* unreadable */ }
        if (!Array.isArray(tl?.cues)) why = 'it is not a viseme timeline';
        else {
          const bytes = readFileSync(audio);
          why = visemeMismatch(tl, {
            audioBytes: bytes,
            stateHash: state[stem]?.visemes ?? null,
            text: existsSync(txt) ? readFileSync(txt, 'utf8').trim() : '',
            duration: audio.endsWith('.wav') ? wavDuration(bytes) : null,
            rhubarb,
          });
        }
      }
      memo.set(side, [key, why]);
    }
    if (why) stale.push({ stem, why });
  }
  return { stems, stale };
}

/**
 * tools/lipsync.mjs on `stems` of `dir` (all that need it when omitted), in
 * parallel. Each progress line goes to `log`. Resolves `{ ok, made, why }`;
 * never rejects. `spawnImpl` is for tests.
 */
export function makeLipsync(dir, stems = null, { log = console.log, jobs = null, spawnImpl = spawn, env = process.env } = {}) {
  const list = stems ?? lipsyncStatus(dir).stale.map((s) => s.stem);
  if (!list.length) return Promise.resolve({ ok: true, made: 0, why: null });
  const args = [LIPSYNC, dir, '--visemes', '--remake', list.join(',')];
  if (jobs) args.push('--jobs', String(jobs));
  return new Promise((done) => {
    let child;
    try { child = spawnImpl(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env }); } catch (e) {
      done({ ok: false, made: 0, why: e.message });
      return;
    }
    let made = 0;
    let err = '';
    let buf = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (/cues →/.test(line)) made++;
        // the per-file lines and the pool size; the tool's own header and
        // summary say what the caller says better
        if (/^\s+(\[\d+\/\d+\]|cutting up to)/.test(line)) log(`  lip-sync: ${line.trim()}`);
      }
    });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => done({ ok: false, made, why: e.message }));
    child.on('close', (code) => done(code === 0
      ? { ok: true, made, why: null }
      : { ok: false, made, why: String(err).trim().split('\n').pop() || `lipsync exited ${code}` }));
  });
}

/**
 * After audio was written into `dir` for the deck `html`: cut its lip-sync
 * when the deck has a 2D character. New audio deleted its old sidecar
 * (synthesizeSlides' `encode`), so what the run wrote is among the stale
 * stems, and any other stale sidecar of the folder comes along: one run of
 * Rhubarb is the cheapest place to fix it. Says what it did, or once why it
 * did nothing. Resolves `{ ran, made, why }`.
 */
export async function lipsyncAfterVoicing({ html, dir, log = console.log, have = haveRhubarb, make = makeLipsync }) {
  if (characterMode(html) !== 'viseme') return { ran: false, made: 0, why: null };
  const rhubarb = have();
  const stems = lipsyncStatus(dir, { rhubarb }).stale.map((s) => s.stem);
  if (!stems.length) return { ran: false, made: 0, why: null };
  if (!rhubarb) log(`  ${RHUBARB_HINT}`);
  log(`  lip-sync: cutting ${stems.length} file${stems.length === 1 ? '' : 's'} for the 2D character in ${basename(dir)}/`
    + `${rhubarb ? ' with Rhubarb' : ', read from the voice'}…`);
  const r = await make(dir, stems, { log });
  if (!r.ok) log(`  lip-sync: not made — ${r.why}; decklight narrate <deck> --face tries again`);
  else log(`  lip-sync: ${r.made} file${r.made === 1 ? '' : 's'} made`);
  return { ran: true, made: r.made, why: r.ok ? null : r.why };
}
