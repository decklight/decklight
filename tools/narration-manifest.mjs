// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A narration track's manifest.json — what the synthesis core writes
 * (tools/narration-synth.mjs, behind `decklight voiceover`) and
 * the deck's own synthesized recorder now writes too (#535), so the two are
 * interchangeable to everything that reads one: `decklight video`, the export
 * dialog, the narration picker.
 *
 *   { engine, model, voice, style, slides: [{ file, hash, segments: [{ file }] } | null] }
 *
 * `hash` is the CLIP KEY shortened — the same key the on-disk clip cache files
 * a sentence under — computed over the slide's whole cleaned notes, so "is
 * this folder still the deck's notes?" (`video`, #536) and "has anyone paid
 * for these words?" (the cache) are one definition, never two.
 */

import { createHash } from 'node:crypto';
import { cacheKey } from './tts-cache.mjs';
import { V3_MODEL as ELEVENLABS_V3_MODEL } from './elevenlabs-tts.mjs';
import { sectionBodies, NOTES_ASIDE, cleanNotes, isHiddenSection } from './deck-html.mjs';
import { deckConfig } from '../cli/runtime-link.mjs';

/**
 * Each slide's notes as WRITTEN — the notes aside's markup, or a markdown
 * Note: block, ⟨CLICK⟩ markers and all; '' for a hidden slide (no file, and
 * the numbering stays) or one with no notes. Index i is slide i+1. The raw
 * form is what the ⟨CLICK⟩ beats are cut from (tools/narration-synth.mjs).
 */
export function slideNotes(html) {
  return sectionBodies(html).map((sec) => {
    if (isHiddenSection(sec)) return '';
    const aside = sec.match(NOTES_ASIDE);
    if (aside) return aside[1];
    const md = sec.match(/^Note:\s*$([\s\S]*?)(?=^Rehearse:\s*$|<\/script>)/m);
    return md ? md[1] : '';
  });
}

/**
 * Each slide's narration text, from the deck FILE — exactly what the
 * synthesis core voices (tools/narration-synth.mjs): the notes, ⟨CLICK⟩
 * markers removed, whitespace collapsed; '' for a hidden slide or one with no
 * notes. Index i is slide i+1.
 *
 * ⟨PAUSE⟩ markers STAY (#560). A recording bakes the hold into its audio, so
 * a take made before a marker was added — or moved — is not the deck's take
 * any more, and this is the text the hash is taken over. A slide with no
 * marker reads exactly as it did before markers existed: no track churns.
 */
export const slideTexts = (html) => slideNotes(html).map((raw) => (raw ? cleanNotes(raw, { pauses: true }) : ''));

/**
 * The built-in beat pause, mirrored from the runtime (src/core/narration.js
 * `BEAT_PAUSE_S`), which the CLI may not import; test/narration-manifest
 * pins the two together, the way test/video pins the slide pause.
 */
export const BEAT_PAUSE_DEFAULT = 0.5;

/**
 * Seconds one ⟨PAUSE⟩ holds on each slide: two beat pauses (#560), resolved
 * the way the runtime's `pauseFor` resolves every narration pause — the
 * section's `data-narration-beat-pause`, else the configuration block's
 * `narration.beatPause`, else the default; a value that is not a finite
 * number ≥ 0 falls through to the next tier. Read off the section's OPEN tag,
 * so the attribute in a slide's content is never mistaken for the slide's.
 * Index i is slide i+1.
 */
export function markerPauses(html) {
  const cfg = deckConfig(html)?.narration?.beatPause;
  const deck = typeof cfg === 'number' && Number.isFinite(cfg) && cfg >= 0 ? cfg : BEAT_PAUSE_DEFAULT;
  return sectionBodies(html).map((sec) => {
    const raw = sec.slice(0, sec.indexOf('>')).match(/\sdata-narration-beat-pause="([^"]*)"/)?.[1];
    const n = raw != null && raw.trim() !== '' ? Number(raw) : NaN;
    return 2 * (Number.isFinite(n) && n >= 0 ? n : deck);
  });
}

/**
 * The key fields for a manifest header, the way `clipKey` derives them from
 * an engine object (tools/tts-cache.mjs) — spelled out per engine here
 * because a manifest is written where no engine object exists: the author
 * server writing the deck recorder's take knows only what the bridge said of
 * itself. The traits are the engines' own (tools/tts-engines.mjs):
 *   piper      voiceIsFixed — the model IS the voice, and it is what is keyed
 *   say, sapi  modelIsDefaultVoice — the spoken voice is keyed, the boot voice is not
 *   elevenlabs voice and model both; a delivery style only on eleven_v3
 *   chirp      voice and its one model; no style
 *   gemini     voice and model; the one engine every style reaches
 * `format` is the audio's extension, wav unless a header says otherwise —
 * ElevenLabs alone can be told to speak mp3.
 */
export function manifestKey({ engine, model, voice, style, format } = {}, text) {
  const e = engine ?? '';
  const fixed = e === 'piper';
  const defaultVoice = e === 'say' || e === 'sapi';
  const stylable = e === 'gemini' || (e === 'elevenlabs' && model === ELEVENLABS_V3_MODEL);
  return cacheKey({
    engine: e,
    model: fixed || defaultVoice ? undefined : (model ?? undefined),
    format: format ?? 'wav',
    voice: fixed ? model : defaultVoice ? (voice ?? model) : voice,
    style: stylable ? style : undefined,
    text,
  });
}

/** The manifest's per-slide hash: the clip key, shortened (voiceover.mjs `slideHash`). */
export const manifestHash = (header, text) => manifestKey(header, text).slice(0, 16);

/**
 * The hash a manifest written before the key carried `model` used
 * (voiceover.mjs `legacyHash`): accepted for a header that predates the
 * field, so a folder recorded then is not flagged for a formula change.
 */
export const legacyHash = ({ engine, voice, style } = {}, text) => createHash('sha256')
  .update(`${engine}|${voice}|${style}|${text}`).digest('hex').slice(0, 16);

/** Does this manifest slide entry vouch for `text`, under its header? */
export function entryMatches(header, entry, text) {
  if (!entry?.hash) return true;   // a hand-recorded take carries no hash to disagree
  if (entry.hash === manifestHash(header, text)) return true;
  return header?.model === undefined && entry.hash === legacyHash(header, text);
}

/**
 * The slides of `manifest` whose audio was voiced from other notes than
 * `texts` — 1-based, within `range` (default: every slide the manifest has).
 * `hashless` counts the entries with no hash at all, which are exempt and
 * worth one line rather than a verdict.
 */
export function staleSlides(manifest, texts, range = null) {
  const out = { stale: [], hashless: 0 };
  const slides = manifest?.slides ?? [];
  for (let i = 0; i < slides.length; i++) {
    const n = i + 1;
    if (range && (n < range.from || n > range.to)) continue;
    const entry = slides[i];
    if (!entry) continue;
    if (!entry.hash) { out.hashless++; continue; }
    if (!entryMatches(manifest, entry, texts[i] ?? '')) out.stale.push(n);
  }
  return out;
}

/**
 * The manifest the deck recorder writes, after each slide of a take (#535):
 * `recorded` maps slide number → its beat file numbers; every slide inside
 * `range` not in it has no notes and is null; every slide outside it keeps
 * `prev`'s entry — a ranged re-record is a surgical redo, the same promise
 * `voiceover --slides` makes. Files are wav: the recorder stitches WAV.
 */
export function recorderManifest({ prev, header, texts, range, recorded }) {
  const total = Math.max(texts.length, prev?.slides?.length ?? 0);
  const slides = [];
  for (let i = 0; i < total; i++) {
    const n = i + 1;
    if (n < range.from || n > range.to) { slides.push(prev?.slides?.[i] ?? null); continue; }
    const take = recorded[n];
    if (!take) { slides.push(null); continue; }
    const nn = String(n).padStart(2, '0');
    const entry = { file: `slide-${nn}.wav`, hash: manifestHash(header, texts[i] ?? '') };
    const segs = (take.segments ?? []).filter((k) => Number.isInteger(k) && k > 0);
    if (segs.length) entry.segments = segs.map((k) => ({ file: `slide-${nn}-${String(k).padStart(2, '0')}.wav` }));
    slides.push(entry);
  }
  const { engine, model, voice, style } = header;
  return { engine, model, voice, style, recorder: 'deck', slides };
}
