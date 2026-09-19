// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The machine-narration core: a deck's notes in, a track's audio and manifest
 * entries out (#555). Every path that synthesizes a track calls THIS —
 * `decklight voiceover`, the export that voices a range before rendering it,
 * and whatever refreshes one stale slide later — so a track produced by one of
 * them can be refreshed by another without its format, voice or manifest
 * drifting.
 *
 * It sits BESIDE the identity layer, not over it: tools/narration-manifest.mjs
 * says what a slide's text is and what its hash is, tools/tts-cache.mjs whether
 * anyone has paid for the words. This owns the rest — sentence synthesis
 * through that cache, the ⟨CLICK⟩ beat files, stitching a slide from its beats,
 * encoding into the TRACK's format, and the skip-by-hash that makes a rerun
 * free.
 *
 * The format is the track's. Before this, `voiceover` always wrote m4a, so
 * pointing it at a track the deck's own recorder had made (wav) re-voiced it in
 * piper, wrote m4a beside the wav and rewrote the header — one stale slide
 * could not be refreshed in place. wav is the synthesis intermediate anyway, so
 * a wav track is written directly; only an m4a or mp3 track is encoded.
 *
 * A human voice is out of scope: a microphone is the browser's, and the deck's
 * recorder keeps that path.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { clipKey, extFor } from './tts-cache.mjs';
import { cleanNotes, notesSegments } from './deck-html.mjs';
import { slideNotes, manifestHash, legacyHash } from './narration-manifest.mjs';
import { run as runBounded, PROBE_MS, CODEC_MS } from './exec.mjs';

/** The formats a track can be in — what a manifest's `file` names end with. */
export const TRACK_FORMATS = ['wav', 'm4a', 'mp3'];

/** A fresh track's format, as `decklight voiceover` has always written it. */
export const DEFAULT_FORMAT = 'm4a';

/** The manifest header's own keys — everything else in a header is carried. */
const HEADER_KEYS = ['engine', 'model', 'voice', 'style', 'format', 'slides'];

/**
 * The format an existing track is in: the extension its slide files carry,
 * or null for a track with nothing in it yet. A track is one format — the
 * first file says which, and a refresh keeps to it.
 */
export function trackFormat(manifest) {
  for (const entry of manifest?.slides ?? []) {
    const ext = entry?.file ? extname(entry.file).slice(1).toLowerCase() : '';
    if (TRACK_FORMATS.includes(ext)) return ext;
  }
  return null;
}

/** A manifest.json in `dir`, or null — absent, unreadable, or the old array form. */
export function readTrack(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return m && Array.isArray(m.slides) ? m : null;
  } catch { return null; }
}

/**
 * Why a RANGED run into this track would leave it in two voices, or null.
 *
 * A header can describe one voice. A run over slides 3–4 in another engine,
 * voice or model would write their audio and a header naming the new voice —
 * and every slide outside the range would then be "stale" against a header
 * it was never voiced under. Refused rather than resolved: the fix is to voice
 * the whole track, or to put the other voice in its own folder.
 */
export function voiceDrift(prev, { engine, model, voice }, { modelIsVoice = true } = {}) {
  if (!prev?.slides?.some(Boolean)) return null;
  const was = [];
  if (prev.engine != null && prev.engine !== engine) was.push(`engine ${prev.engine}`);
  if (prev.voice != null && voice != null && prev.voice !== voice) was.push(`voice ${prev.voice}`);
  // a header written before `model` was recorded has none to disagree with;
  // and for say/sapi the "model" is only the voice a bridge booted with — the
  // voice that spoke is `voice` — so it has nothing to say about identity
  if (modelIsVoice && prev.model != null && model != null && prev.model !== model) was.push(`model ${prev.model}`);
  return was.length ? was.join(', ') : null;
}

/** Which encoder is on this machine: ffmpeg first, then Core Audio's afconvert. */
export function findEncoder(run = runBounded) {
  const have = (bin) => {
    try { run(bin, ['-version'], { stdio: 'ignore', timeout: PROBE_MS }); return true; } catch (e) { return e?.code !== 'ENOENT'; }
  };
  return have('ffmpeg') ? 'ffmpeg' : have('afconvert') ? 'afconvert' : null;
}

/**
 * Voice `html`'s notes into `dir`.
 *
 *   tts       an engine from tools/tts-engines.mjs `createEngine`
 *   voice, style   what each sentence is asked for with — the header records them
 *   format    'wav' | 'm4a' | 'mp3' — the track's (trackFormat), or a fresh one's
 *   range     { from, to }, 1-based — outside it every entry of `prev` stands
 *   prev      the track's manifest before this run (readTrack), or null
 *   cache     tools/tts-cache.mjs `createTtsCache`
 *   reuseTextFrom   folders whose slide-NN.txt is voiced instead of the notes
 *   keepWav   keep the lossless intermediates of an encoded track (lipsync)
 *
 * Returns `{ manifest, skipped, cost }`. The manifest is also written after
 * every slide, so an interrupted run resumes where it stopped. A slide whose
 * hash still matches and whose file is on disk is kept, whoever made it.
 */
export async function synthesizeSlides({
  html, dir, tts, voice, style, format = DEFAULT_FORMAT, range = null, prev = null,
  cache, reuseTextFrom = [], keepWav = false, log = console.log,
  run = runBounded, encoder = undefined,
}) {
  if (!TRACK_FORMATS.includes(format)) throw new Error(`a track is ${TRACK_FORMATS.join(', ')} — not ${format}`);
  const raw = slideNotes(html);
  const slides = raw.map((r) => (r ? cleanNotes(r) : ''));
  const span = range ?? { from: 1, to: slides.length };
  if (range && prev) {
    const drift = voiceDrift(prev, { engine: tts.name, model: tts.model ?? null, voice }, { modelIsVoice: !tts.modelIsDefaultVoice });
    if (drift) {
      throw new Error(`${dir} is voiced in ${drift} — voicing slides ${span.from}–${span.to} in another would leave the `
        + 'track in two voices; voice the whole track, or give the other voice its own folder (-o)');
    }
  }

  const synthExt = extFor(tts.synth.mimeType ?? 'audio/wav');
  // An encoder is needed only to change what the engine spoke into something
  // else, and to stitch beats together — which the concat demuxer does, so
  // stitching needs ffmpeg specifically.
  const enc = encoder === undefined ? findEncoder(run) : encoder;
  if (format !== synthExt && !enc) {
    throw new Error(`no encoder for a ${format} track — install ffmpeg (apt install ffmpeg / brew install ffmpeg)`);
  }
  if (format === 'mp3' && enc !== 'ffmpeg') throw new Error('an mp3 track needs ffmpeg — install it (brew install ffmpeg)');
  const canSegment = enc === 'ffmpeg';
  if (!canSegment && raw.some((r) => notesSegments(r))) {
    log('  note: ⟨CLICK⟩ segments need ffmpeg to concatenate — narrating each slide whole');
  }
  /** `src` (in the synthesis format) into `dst` in the track's, or a plain write. */
  const encode = (audio, dst) => {
    if (format === synthExt) { writeFileSync(dst, audio); return; }
    const src = `${dst}.${synthExt}`;
    writeFileSync(src, audio);
    const args = format === 'm4a'
      ? (enc === 'ffmpeg' ? ['-y', '-i', src, '-c:a', 'aac', '-b:a', '128k', dst] : ['-f', 'm4af', '-d', 'aac', src, dst])
      : format === 'mp3' ? ['-y', '-i', src, '-c:a', 'libmp3lame', '-b:a', '128k', dst]
        : ['-y', '-i', src, dst];
    run(enc, args, { stdio: 'ignore', timeout: CODEC_MS, why: 'the encoder is stuck on this file — check it plays, then retry' });
    // keep the lossless intermediate beside it, named as it always was
    if (keepWav && synthExt === 'wav') writeFileSync(dst.replace(/\.\w+$/, '.wav'), audio);
    rmSync(src, { force: true });
  };

  // `--voice` omitted on ElevenLabs means "the first of your voices", and the
  // deck's picker offers that roster in that order — so the name is resolved
  // HERE, for the clip cache's key. Left undefined it would key differently
  // from the identical sentence the bridge just synthesized, and the
  // cross-process reuse the cache exists for would silently never hit.
  let keyVoice = voice;
  if (!keyVoice && tts.listVoices) {
    try { keyVoice = (await tts.listVoices())[0]?.name; } catch { /* keep it undefined */ }
  }
  /** `tts.synth`, but a sentence anyone has already paid for is free. */
  const synth = async (text) => {
    const key = clipKey(tts, { voice: keyVoice, style, text });
    const hit = cache.read(key, synthExt);
    if (hit) return { wav: hit, usage: { chars: 0, cost: 0 }, cached: true };
    const out = await tts.synth(text, { voice, style });
    cache.write(key, out.wav, synthExt);
    return { ...out, cached: false };
  };

  // THE HEADER IS WHAT THE STAMP IS TAKEN OVER — every field of it, and
  // nothing that is not in it (#557). A slide's hash is `manifestHash(header,
  // text)`, the very function `decklight video` checks freshness with, over
  // the very header written to disk; so whatever a later check recomputes from
  // the file is what was stamped. The first cut stamped with the clip cache's
  // key — the resolved voice and the engine's native format — while writing a
  // header that named neither, and the check could never agree with it: a
  // re-voiced slide was still stale, forever.
  //
  //   voice   the voice that spoke. A fresh track records the one resolved
  //           above, so a default-voice ElevenLabs run names who it was. A
  //           refresh of a track whose header says "the default" (voice null
  //           — the deck recorder's, for the first of your voices) keeps
  //           saying so: its other slides were stamped under that header,
  //           and naming a voice now would turn every one of them stale.
  //   format  the key's format axis. A refresh keeps the track's own — a
  //           header without one is wav, as the checker has always read it;
  //           a fresh track records what the engine spoke.
  const sameTrack = prev && prev.engine === tts.name;
  const header = {
    engine: tts.name,
    model: tts.model ?? null,
    voice: voice ?? (sameTrack && prev.voice == null ? null : keyVoice ?? null),
    style,
    format: prev ? (prev.format ?? 'wav') : synthExt,
  };
  const slideHash = (text) => manifestHash(header, text);
  // ONE-TIME MIGRATION. The hash gained `model` and lost the style no engine
  // reads, so a folder recorded before that hashes differently — and would be
  // re-synthesized in full, handing an ElevenLabs user a bill for clips already
  // on disk. A slide matching the OLD formula is accepted once and re-stamped;
  // only a header without `model` can claim it, so it cannot be claimed twice.
  const preDatesModel = prev && prev.model === undefined
    && prev.engine === header.engine && prev.voice === voice && prev.style === style;

  // Whatever else the header carried (the recorder's `recorder: 'deck'`) is
  // the track's, and a refresh of it keeps it.
  const extras = Object.fromEntries(Object.entries(prev ?? {}).filter(([k]) => !HEADER_KEYS.includes(k)));
  const manifestOf = (entries) => ({ ...extras, ...header, slides: entries });
  const save = (entries) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf(entries), null, 1));

  mkdirSync(dir, { recursive: true });
  let skipped = 0;
  let cost = 0;
  const entries = [];
  for (let i = 0; i < slides.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    // Outside the range the track's own entry stands, segments and all: a
    // ranged run is a surgical redo, the promise `decklight record --slides`
    // makes, and the video rendered from this folder still finds the rest.
    if (i + 1 < span.from || i + 1 > span.to) { entries.push(prev?.slides?.[i] ?? null); continue; }
    if (!slides[i]) { entries.push(null); continue; }
    const txt = join(dir, `slide-${n}.txt`);
    // reused text: a second take (another engine or voice) narrates the SAME
    // words, not a re-roll
    const prior = reuseTextFrom.map((d) => join(d, `slide-${n}.txt`)).find((f) => existsSync(f));
    const text = prior ? readFileSync(prior, 'utf8').trim() : slides[i];
    const file = `slide-${n}.${format}`;
    writeFileSync(txt, text);
    const hash = slideHash(text);
    entries.push({ file, hash });

    // Unchanged: the audio on disk is still these words in this voice. The
    // file checked is the one the ENTRY names — a slide another producer wrote
    // (the deck's recorder) is kept as it is, never re-voiced to rename it.
    // A file in another format is not kept: a track is one format, and a run
    // asked for another (`--format`) is converting it.
    const was = prev?.slides?.[i];
    if (was?.file && extname(was.file) === `.${format}`
      && (was.hash === hash || (preDatesModel && was.hash === legacyHash(prev, text)))
      && existsSync(join(dir, was.file))) {
      entries[i] = { ...was, hash };
      // Carry the segments across only while they are still on disk — the
      // manifest is the one thing that knows they are there.
      if (!was.segments?.every((sg) => existsSync(join(dir, sg.file)))) delete entries[i].segments;
      skipped++;
      log(`  slide ${n}: unchanged — kept${entries[i].segments ? ` (${entries[i].segments.length} segments)` : ''}`);
      continue;
    }

    // A segmented slide is synthesized beat by beat and the slide's file is
    // CONCATENATED from the beats — one synthesis, both shapes; TTS is billed
    // per character. Reused text is one script, so it goes whole.
    const segs = prior || !canSegment ? null : notesSegments(raw[i]);
    let slideCost = 0;
    let cachedBeats = 0;
    if (segs) {
      const parts = [];
      for (let k = 0; k < segs.length; k++) {
        const kk = String(k + 1).padStart(2, '0');
        const beat = `slide-${n}-${kk}.${format}`;
        const out = await synth(segs[k]);
        if (out.cached) cachedBeats++;
        // the beat's own words beside its audio — tools/lipsync.mjs hands this
        // to Rhubarb as the dialog hint for that beat
        writeFileSync(join(dir, `slide-${n}-${kk}.txt`), segs[k]);
        slideCost += out.usage?.cost ?? 0;
        encode(out.wav, join(dir, beat));
        parts.push(beat);
      }
      const list = join(dir, `slide-${n}.concat`);
      writeFileSync(list, `${parts.map((p) => `file '${join(dir, p).replaceAll("'", "'\\''")}'`).join('\n')}\n`);
      run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(dir, file)], { stdio: 'ignore' });
      rmSync(list, { force: true });
      entries[i].segments = parts.map((p) => ({ file: p }));
    } else {
      const out = await synth(text);
      if (out.cached) cachedBeats++;
      slideCost = out.usage?.cost ?? 0;
      encode(out.wav, join(dir, file));
    }
    cost += slideCost;
    // "cached" is worth a word: on a paid engine it is the difference between
    // a rerun that costs nothing and one that quietly re-bills the deck
    const cacheNote = cachedBeats ? ` · ${segs ? `${cachedBeats}/${segs.length} ` : ''}cached` : '';
    log(`  slide ${n}: ${text.length} chars → ${file}`
      + `${segs ? ` (${segs.length} ⟨CLICK⟩ segments)` : ''}${cacheNote}${slideCost ? ` · ~$${slideCost.toFixed(4)}` : ''}`);
    save(entries);   // crash-safe: an interrupted run resumes from here
  }
  save(entries);
  return { manifest: manifestOf(entries), skipped, cost };
}

/** The plan line `decklight voiceover` prints — the author server reads its `· N to voice`. */
export function planLine(name, html, range, ranged) {
  const texts = slideNotes(html).map((r) => (r ? cleanNotes(r) : ''));
  const span = range ?? { from: 1, to: texts.length };
  const toVoice = texts.filter((s, i) => s && i + 1 >= span.from && i + 1 <= span.to).length;
  return `${name}: ${texts.length} slides, ${texts.filter(Boolean).length} with notes`
    + `${!ranged ? '' : span.from === span.to ? ` — voicing slide ${span.from} only` : ` — voicing slides ${span.from}–${span.to} only`}`
    + ` · ${toVoice} to voice`;
}
