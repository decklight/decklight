// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The 2D character's mouth, read from the voice itself (PRESENTING_VOICE,
// Character). No Rhubarb, no bridge, no model: a few measurements of the
// sound, 100 times a second, and rules modelled on Rhubarb's for turning them
// into its nine mouth shapes. It does not recognise speech, so it cannot tell
// an "m" from a "t" the way Rhubarb can; it can tell silence from a hum, a
// hiss from a vowel, and a dark vowel ("oo", "oh") from a bright one ("ah",
// "ee"), which is most of what a cartoon mouth shows.
//
// Pure and DOM-free: it takes samples and returns a timeline in the shape
// tools/lipsync.mjs writes (`{ v: 1, kind: 'visemes', duration, cues:
// [{ t, v }] }`), so the deck, the bundle and the video renderer read it
// exactly as they read Rhubarb's.
//
// The shapes (Rhubarb's names):
//   A closed (m, b, p)        B slightly open, teeth (most consonants, "ee")
//   C open ("eh", "a")        D wide open ("ah")
//   E slightly rounded ("or") F puckered ("oo", "w")
//   G teeth on lip (f, v)     H tongue (l)          X rest

const HOP_S = 0.01;          // one measurement every 10 ms
const WIN_S = 0.03;          // over 30 ms of sound
const MIN_CUE_S = 0.06;      // no shape shorter than this (Rhubarb holds ~2 frames at 24 fps)
const REST_S = 0.18;         // a silence this long rests the mouth; shorter, it closes

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * The vocal tract's two lowest resonances (formants) in one frame, from its
 * LPC envelope: F1 rises as the mouth opens, F2 rises as the tongue moves
 * forward and falls as the lips round. Peaks of the envelope, read on a grid
 * (no polynomial roots): the first above 250 Hz is F1, the next F2.
 */
const LPC_ORDER = 14;
function lpc(frame) {
  const p = LPC_ORDER;
  const r = new Float64Array(p + 1);
  for (let k = 0; k <= p; k++) { let s = 0; for (let i = k; i < frame.length; i++) s += frame[i] * frame[i - k]; r[k] = s; }
  if (r[0] <= 0) return null;
  r[0] *= 1.0001;   // a touch of white noise: keeps the recursion stable on pure tones
  const a = new Float64Array(p + 1); a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return null;
  }
  return a;
}
const GRID = 200, GRID_TOP = 4000;   // 20 Hz steps to 4 kHz
function formants(a, sampleRate, trig) {
  const env = new Float64Array(GRID);
  for (let g = 0; g < GRID; g++) {
    let re = 0, im = 0;
    for (let k = 0; k < a.length; k++) { re += a[k] * trig.cos[g][k]; im -= a[k] * trig.sin[g][k]; }
    env[g] = 1 / (re * re + im * im);
  }
  // the strongest peak where each formant lives: F1 from 250 Hz to 1.1 kHz,
  // F2 from 200 Hz above F1 to 3 kHz. The first peak would be a harmonic as
  // often as a formant on a high voice.
  const strongest = (lo, hi) => {
    let best = null;
    for (let g = 1; g < GRID - 1; g++) {
      const hz = g * GRID_TOP / GRID;
      if (hz < lo || hz > hi || !(env[g] > env[g - 1] && env[g] >= env[g + 1])) continue;
      if (best == null || env[g] > env[best]) best = g;
    }
    return best == null ? null : best * GRID_TOP / GRID;
  };
  const f1 = strongest(250, 1100);
  return { f1, f2: f1 == null ? null : strongest(f1 + 200, 3000) };
}
function trigFor(sampleRate) {
  const cos = [], sin = [];
  for (let g = 0; g < GRID; g++) {
    const w = 2 * Math.PI * (g * GRID_TOP / GRID) / sampleRate;
    cos.push(Float64Array.from({ length: LPC_ORDER + 1 }, (_, k) => Math.cos(w * k)));
    sin.push(Float64Array.from({ length: LPC_ORDER + 1 }, (_, k) => Math.sin(w * k)));
  }
  return { cos, sin };
}

/**
 * What the voice is doing, frame by frame: loudness (dB), how much of its
 * energy is hiss (above 3.5 kHz), how much is low (below 900 Hz, where an open
 * vowel's first formant sits), and how much is in the middle (900 Hz to
 * 2.5 kHz, where a front vowel's second formant sits).
 */
export function measure(samples, sampleRate) {
  const hop = Math.max(1, Math.round(HOP_S * sampleRate));
  const win = Math.round(WIN_S * sampleRate);
  let n = 1; while (n < win) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  const hann = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1)));
  const bin = (hz) => Math.min(n / 2, Math.round(hz * n / sampleRate));
  const [b150, b900, b2500, b3500, b8000] = [150, 900, 2500, 3500, 8000].map(bin);
  const frames = [];
  const trig = trigFor(sampleRate);
  const pre = new Float64Array(win);
  for (let at = 0; at + win <= samples.length; at += hop) {
    let sq = 0;
    for (let i = 0; i < win; i++) {
      const s = samples[at + i]; sq += s * s; re[i] = s * hann[i]; im[i] = 0;
      pre[i] = (s - 0.97 * (at + i > 0 ? samples[at + i - 1] : 0)) * hann[i];
    }
    const a = lpc(pre);
    const { f1, f2 } = a ? formants(a, sampleRate, trig) : { f1: null, f2: null };
    for (let i = win; i < n; i++) { re[i] = 0; im[i] = 0; }
    fft(re, im);
    const band = (lo, hi) => { let e = 0; for (let k = lo; k < hi; k++) e += re[k] * re[k] + im[k] * im[k]; return e; };
    const low = band(b150, b900), mid = band(b900, b2500), high = band(b3500, b8000);
    const all = low + mid + band(b2500, b3500) + high + 1e-12;
    frames.push({
      t: at / sampleRate,
      db: 10 * Math.log10(sq / win + 1e-12),
      low: low / all, mid: mid / all, hiss: high / all, f1, f2,
    });
  }
  return frames;
}

/** The clip's speaking level: loud speech, not its peak (one shout does not set the scale). */
function speechLevel(frames) {
  const dbs = frames.map((f) => f.db).sort((a, b) => a - b);
  return dbs.length ? dbs[Math.floor(dbs.length * 0.9)] : 0;
}

/**
 * One frame's mouth. `rel` is dB below the speaking level; `open` and `front`
 * are F1 and F2 placed within this voice's own range (0 its lowest, 1 its
 * highest), since a man's "ah" and a woman's "ee" can share an F1 in hertz.
 */
export function shapeOf({ rel, hiss, open, front }) {
  if (rel < -35) return 'X';                        // silence (closures are decided later)
  if (hiss > 0.3 && rel < -4) return 'B';           // s, sh, t, k, ch: teeth
  if (rel < -22) return 'A';                        // a quiet hum between sounds: lips together (m, n, b)
  if (open == null || front == null) return 'C';   // voiced, formants unread: plainly open
  if (open > 0.62) return front > 0.6 ? 'C' : 'D';  // open: "a" in cat, or "ah"
  if (open > 0.35) return front < 0.3 ? 'E' : 'C';  // half open: "aw", "or", else "eh"
  return front > 0.55 ? 'B' : front < 0.3 ? 'F' : 'E'; // closed: "ee", "oo", or between ("er")
}

/** `x` placed between this voice's 10th and 90th percentiles of `xs`. */
function placer(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < 5) return () => null;
  const lo = v[Math.floor(v.length * 0.1)], hi = v[Math.floor(v.length * 0.9)];
  return (x) => (x == null || hi <= lo ? null : Math.min(1, Math.max(0, (x - lo) / (hi - lo))));
}

/**
 * The voice at 16 kHz, where the formant reading is tuned (its LPC order
 * suits a 16 kHz band; a browser decodes at 44.1 or 48 kHz). Averaged over
 * each step before it is picked, so nothing above 8 kHz folds back down.
 */
const RATE = 16000;
export function at16k(samples, sampleRate) {
  if (sampleRate <= RATE) return { samples, sampleRate };
  const step = sampleRate / RATE;
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    let sum = 0; for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return { samples: out, sampleRate: RATE };
}

/**
 * A WAV's voice as mono samples (-1..1) and its rate, or null for anything
 * this does not read (not a WAV, a compressed one, a format it does not know):
 * the caller decodes those some other way. Integer PCM at 8, 16, 24 or 32
 * bits and 32-bit float, channels averaged. Pure, so the deck and Node read a
 * recording the same way without a decoder: a headless browser's media stack
 * and a machine without ffmpeg both stopped the mouth before this.
 */
export function wavSamples(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = null;
  for (let at = 12; at + 8 <= u8.length;) {
    const id = tag(at), body = at + 8;
    let size = d.getUint32(at + 4, true);
    if (id === 'fmt ' && size >= 16) {
      let format = d.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format GUID
      if (format === 0xfffe && size >= 26) format = d.getUint16(body + 24, true);
      fmt = { format, channels: d.getUint16(body + 2, true), rate: d.getUint32(body + 4, true), bits: d.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels || !fmt.rate) return null;
      // a streamed WAV says 0 or 0xFFFFFFFF: its data runs to the end
      if (!size || body + size > u8.length) size = u8.length - body;
      const { format, channels, rate, bits } = fmt, width = bits / 8;
      const read = format === 3 && bits === 32 ? (o) => d.getFloat32(o, true)
        : format !== 1 ? null
        : bits === 8 ? (o) => (d.getUint8(o) - 128) / 128
        : bits === 16 ? (o) => d.getInt16(o, true) / 32768
        : bits === 24 ? (o) => ((d.getUint8(o) | (d.getUint8(o + 1) << 8) | (d.getInt8(o + 2) << 16))) / 8388608
        : bits === 32 ? (o) => d.getInt32(o, true) / 2147483648
        : null;
      if (!read) return null;
      const n = Math.floor(size / (width * channels));
      const samples = new Float32Array(n);
      for (let i = 0, o = body; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++, o += width) sum += read(o);
        samples[i] = sum / channels;
      }
      return { samples, sampleRate: rate };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/**
 * The timeline for `samples` (mono, -1..1) at `sampleRate`: one shape per
 * frame, smoothed the way a mouth moves. A short silence between sounds is
 * lips closing, not resting; a shape held for less than a couple of frames is
 * folded into its longer neighbour; the mouth starts and ends at rest.
 */
export function mouthTimeline(input, inputRate) {
  const duration = input.length / inputRate;
  const { samples, sampleRate } = at16k(input, inputRate);
  const frames = measure(samples, sampleRate);
  const level = speechLevel(frames);
  // the voice's own range, read from where it is clearly voicing
  const voiced = frames.filter((f) => f.db - level > -15 && f.hiss < 0.2);
  const openOf = placer(voiced.map((f) => f.f1));
  const frontOf = placer(voiced.map((f) => f.f2));
  // and an absolute floor: in a clip of silence, the silence is not its speaking level
  const FLOOR_DB = -60;
  let shapes = frames.map((f) => (f.db < FLOOR_DB ? 'X'
    : shapeOf({ rel: f.db - level, hiss: f.hiss, open: openOf(f.f1), front: frontOf(f.f2) })));
  // a three-frame majority: one odd frame is a measurement, not a mouth
  shapes = shapes.map((s, i) => {
    const a = shapes[i - 1], b = shapes[i + 1];
    return a && a === b && s !== a ? a : s;
  });
  // runs of one shape
  let runs = [];
  for (let i = 0; i < shapes.length; i++) {
    const t = frames[i].t;
    if (runs.length && runs[runs.length - 1].v === shapes[i]) runs[runs.length - 1].end = t + HOP_S;
    else runs.push({ v: shapes[i], start: t, end: t + HOP_S });
  }
  // a short silence inside speech closes the lips (the stop of a p, b, t, k)
  runs = runs.map((r, i) => (r.v === 'X' && i > 0 && i < runs.length - 1 && r.end - r.start < REST_S ? { ...r, v: 'A' } : r));
  // too short to see: folded into the longer neighbour, until none is left
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.end - r.start >= MIN_CUE_S || runs.length === 1) continue;
      const prev = runs[i - 1], next = runs[i + 1];
      const into = !prev ? next : !next ? prev : (prev.end - prev.start >= next.end - next.start ? prev : next);
      into.start = Math.min(into.start, r.start);
      into.end = Math.max(into.end, r.end);
      runs.splice(i, 1);
      changed = true;
      break;
    }
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].v === runs[i - 1].v) { runs[i - 1].end = runs[i].end; runs.splice(i, 1); i--; changed = true; }
    }
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const cues = runs.map((r) => ({ t: r3(r.start), v: r.v }));
  if (!cues.length || cues[0].t > 0) cues.unshift({ t: 0, v: 'X' });
  if (cues[cues.length - 1].v !== 'X') cues.push({ t: r3(Math.min(duration, runs[runs.length - 1]?.end ?? duration)), v: 'X' });
  return { v: 1, kind: 'visemes', duration: r3(duration), source: 'builtin', cues };
}

/**
 * The loudness-only mouth the deck falls back to today, as a timeline: what
 * the prototype is compared with. Four shapes from the frame's level.
 */
export function loudnessTimeline(input, inputRate) {
  const { samples, sampleRate } = at16k(input, inputRate);
  const frames = measure(samples, sampleRate);
  const cues = [];
  for (const f of frames) {
    const rms = Math.sqrt(10 ** (f.db / 10));
    const v = rms < 0.02 ? 'X' : rms < 0.06 ? 'B' : rms < 0.12 ? 'C' : 'D';
    if (!cues.length || cues[cues.length - 1].v !== v) cues.push({ t: Math.round(f.t * 1000) / 1000, v });
  }
  return { v: 1, kind: 'visemes', duration: Math.round(samples.length / sampleRate * 1000) / 1000, source: 'loudness', cues };
}
