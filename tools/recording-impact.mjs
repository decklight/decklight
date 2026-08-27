// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What an edit does to the recordings a deck carries — SPEC NARRATION.
//
// A recorded track is minutes of somebody's own voice, and it lives in two
// places that an edit can silently pull apart: the AUDIO on disk, and the
// deck's `narration.files` config that points at it and the NOTES the audio
// reads. An agent asked to "rewrite the voiceover" reasonably rewrote the
// whole `Decklight.init` call and dropped the config with it — every
// recording orphaned, the WAVs still on disk but nothing playing them, and no
// sign until you press N and the track is gone. That actually happened.
//
// So an edit that changes what recordings mean is worth a word. Three shapes:
//
//   orphaned — a track configured before is gone from the config after, and
//              it has audio on disk. The whole track stops playing.
//   stale    — a track still configured, but a slide's NOTES changed and that
//              slide has a recording: the voice now reads something the slide
//              no longer says.
//   reshaped — a track still configured, but the slide COUNT changed. Recorded
//              files map to slides by position (slide-NN.wav), so an insert or
//              delete shifts every recording after it onto the wrong slide.
//
// Pure, over injected `dirsOf` (parse the config — the caller owns the init
// walkers) and `recordedSlides` (read the disk). The notes diff is the one
// thing done here, because deck-html is importable and the runtime is not.

import { sectionBodies, NOTES_ASIDE, cleanNotes } from './deck-html.mjs';

/** Each slide's notes as plain compared text, index-aligned to the deck. */
function notesPerSlide(html) {
  return sectionBodies(html).map((body) => {
    const m = body.match(NOTES_ASIDE);
    return m ? cleanNotes(m[1]) : '';
  });
}

/**
 * The recordings an edit would orphan, stale, or reshape.
 *
 * `dirsOf(html)` → the track dirs the deck's config names (a manifest/cloud
 * entry has no local dir and is not one). `recordedSlides(dir)` → the 1-based
 * slide numbers with audio in that dir, `[]` for a dir with none. Both are
 * injected so this stays testable without a filesystem or the init walkers.
 */
export function recordingImpact(before, after, { dirsOf, recordedSlides }) {
  const beforeDirs = dirsOf(before);
  const afterDirs = new Set(dirsOf(after));
  const nb = notesPerSlide(before);
  const na = notesPerSlide(after);

  const orphaned = [];
  const stale = [];
  const reshaped = [];
  for (const dir of beforeDirs) {
    const recorded = recordedSlides(dir);
    if (!recorded.length) continue;   // nothing on disk → nothing to lose
    if (!afterDirs.has(dir)) { orphaned.push({ dir, slides: recorded.length }); continue; }
    // still configured — did the slides move or change under it?
    if (nb.length !== na.length) { reshaped.push({ dir, before: nb.length, after: na.length }); continue; }
    const has = new Set(recorded);
    const slides = [];
    for (let i = 0; i < nb.length; i++) {
      if (nb[i] !== na[i] && has.has(i + 1)) slides.push(i + 1);
    }
    if (slides.length) stale.push({ dir, slides });
  }
  return { orphaned, stale, reshaped };
}

/** True when there is anything worth saying. */
export function hasImpact(impact) {
  return !!(impact && (impact.orphaned.length || impact.stale.length || impact.reshaped.length));
}

/**
 * One line a person reads — or null when nothing changed.
 *
 * Says which track and how much, and ends with the one fact that turns a
 * scare into a fix: Z takes the edit back, the audio never left the disk.
 */
export function impactWarning(impact) {
  if (!hasImpact(impact)) return null;
  const parts = [];
  for (const o of impact.orphaned) {
    parts.push(`${o.dir} (${o.slides} recorded slide${o.slides === 1 ? '' : 's'}) is no longer played`);
  }
  for (const r of impact.reshaped) {
    parts.push(`${r.dir}’s recordings no longer line up — the deck went from ${r.before} slides to ${r.after}`);
  }
  for (const s of impact.stale) {
    const list = s.slides.join(', ');
    parts.push(`${s.dir}: the recording no longer matches the notes on slide${s.slides.length === 1 ? '' : 's'} ${list}`);
  }
  return `🎙 heads up — ${parts.join('; ')}. Z takes the edit back; the audio is still on disk.`;
}

/**
 * Slide numbers with audio under `dir`, from its filenames — the default
 * `recordedSlides`. `slide-07.wav` and `slide-07-02.wav` both count slide 7.
 */
export function slidesFromFiles(names) {
  const out = new Set();
  for (const name of names ?? []) {
    const m = /^slide-(\d{2,})(?:-\d+)?\.(?:wav|m4a|mp3)$/i.exec(String(name));
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}
