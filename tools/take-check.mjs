// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Does a take's length fit its text?
//
// A generative voice is a sample, and now and then a bad one: ElevenLabs once
// read "You ask, it answers." as "You ask, you ask, it answers", 3.28 s where
// the sentence runs 2.16 s, and the cache kept it, so every pass over that
// slide said it that way (#1005). A take far longer than its text's pace is
// the shape of a repeated phrase, and one far shorter of a dropped one. Both
// are cheap to see from the WAV header and cheap to fix with one more sample.
//
// Only engines that sample are checked. piper, chirp and the system voices
// say a sentence the same way every time, so a retry would buy the same take.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripAudioTags } from './sentences.mjs';
import { wavSeconds } from './face-clip.mjs';
import { PROBE_MS } from './exec.mjs';

/**
 * Characters a second, per engine, for ordinary narration. Wide on purpose:
 * the band around it is a factor of two either way, so this only has to be
 * the right order, not a measurement of any one voice.
 */
export const PACE = { elevenlabs: 14, gemini: 13 };

/** A take inside [LOW × expected, HIGH × expected] fits. */
export const BAND = [0.5, 2];

// A short sentence's take carries the voice's breath in and out, which no
// pace accounts for: below a second of speech the factor alone would flag
// "Yes." for running 0.7 s. So the top of the band is never under expected + 1 s.
const SLACK = 1;
// an audio tag ([sighs], [pause]) is a beat of its own, said or held
const PER_TAG = 1;

const TAG = /\[[^[\]]{1,40}\]/g;

/**
 * The seconds a text should take on this engine, or null when the engine is
 * not checked (it does not sample, or has no pace on record).
 */
export function expectedSeconds(engineName, text) {
  const pace = PACE[engineName];
  if (!pace) return null;
  const chars = stripAudioTags(text).replace(/\s+/g, ' ').trim().length;
  return chars ? chars / pace : null;
}

/**
 * `{ seconds, expected, ok }` for a take of `text`, or null when it cannot be
 * judged: an engine that is not checked, or audio that is not a WAV (mp3
 * carries no length in a header we read).
 */
export function judgeTake(engineName, text, seconds) {
  const expected = expectedSeconds(engineName, text);
  if (expected == null || !(seconds > 0)) return null;
  const tags = (String(text).match(TAG) ?? []).length;
  const low = BAND[0] * expected;
  const high = Math.max(BAND[1] * expected, expected + SLACK) + tags * PER_TAG;
  return { seconds, expected, ok: seconds >= low && seconds <= high };
}

/** {@link judgeTake} of a WAV. */
export const judgeWav = (engineName, text, wav) => judgeTake(engineName, text, wavSeconds(wav));

// how far a take is from its text's pace, either way
const miss = (j) => Math.abs(Math.log(j.seconds / j.expected));

/**
 * `engine.synth(text, opts)`, with a take whose length does not fit its text
 * synthesized once more. When the second fits, it is the take; when it does
 * not either, the one nearer the expected length is kept, which for a repeated
 * phrase is the shorter. Either way the result carries `take`:
 * `{ seconds: [first, second], expected, fits }`, `fits` false when neither
 * did. Usage is the sum of both requests: both were billed.
 */
export async function checkedSynth(engine, text, opts = {}) {
  const first = await engine.synth(text, opts);
  const a = judgeWav(engine.name, text, first.wav);
  if (!a || a.ok) return first;
  const second = await engine.synth(text, opts);
  const b = judgeWav(engine.name, text, second.wav);
  const keep = !b || b.ok || miss(b) < miss(a) ? second : first;
  const usage = { ...keep.usage };
  for (const k of ['chars', 'cost']) {
    const sum = (first.usage?.[k] ?? 0) + (second.usage?.[k] ?? 0);
    if (typeof first.usage?.[k] === 'number' || typeof second.usage?.[k] === 'number') usage[k] = sum;
  }
  return {
    ...keep,
    usage,
    take: { seconds: [a.seconds, b?.seconds ?? null], expected: a.expected, fits: !b || b.ok },
  };
}

const s = (n) => (n == null ? '?' : `${n.toFixed(2)} s`);

/** One line for a retried take: what it was, what came back, what was kept. */
export function takeLine(text, take) {
  const [a, b] = take.seconds;
  const said = String(text).length > 70 ? `${String(text).slice(0, 67)}…` : String(text);
  return `“${said}” ran ${s(a)} against ~${s(take.expected)}; the retry ran ${s(b)}`
    + (take.fits ? ' and is kept' : ', also outside — kept the nearer, worth a listen');
}

/** A file's seconds: a WAV from its header, anything else by ffprobe; null when neither can say. */
function fileSeconds(path) {
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  const wav = wavSeconds(buf);
  if (wav != null) return wav;
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8', timeout: PROBE_MS });
  const n = Number(String(r.stdout ?? '').trim());
  return r.status === 0 && n > 0 ? n : null;
}

/**
 * The clips of a recorded track whose length does not fit their text: every
 * `slide-NN[-KK].{wav,m4a,mp3}` with its `.txt` beside it, judged at the
 * engine's pace. `[{ file, seconds, expected }]`, in file order; empty for an
 * engine that is not checked. A clip with no script, or one nothing can
 * measure (no ffprobe for an m4a), is not judged rather than guessed at.
 */
export function auditTrack(dir, engineName) {
  if (!PACE[engineName]) return [];
  let names;
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const file of names) {
    const m = /^(slide-\d+(?:-\d+)?)\.(wav|m4a|mp3)$/.exec(file);
    if (!m) continue;
    // a slide cut into beats is judged beat by beat: its whole file is the
    // beats joined, and would name the same bad take twice
    if (m[1].split('-').length === 2 && names.some((n) => n.startsWith(`${m[1]}-`))) continue;
    let text;
    try { text = readFileSync(join(dir, `${m[1]}.txt`), 'utf8'); } catch { continue; }
    const j = judgeTake(engineName, text, fileSeconds(join(dir, file)));
    if (j && !j.ok) out.push({ file, seconds: j.seconds, expected: j.expected });
  }
  return out;
}
