// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Media an author put ON a slide (SPEC DECK_ANATOMY): a <video> or an <audio>
// in a section, never the background layer's clip (media.js drives that one).
// Every slide is in the page at once, so without this a clip on slide 9 marked
// `autoplay` plays from load, with its sound, while slide 1 is on screen, and a
// clip left running keeps playing after its slide has gone.
//
// So: the native `autoplay` is taken off at boot (it is remembered as the
// author's ask to play on ARRIVAL), a clip never plays while its slide is not
// the current one, leaving a slide pauses its clips and returns them to their
// start, and arriving plays the ones that asked. A page that is not a live
// talk (print, a capture for a video or a picture, an embedded preview such as
// the speaker view's) plays nothing at all, and loads the first frame so a
// clip without a poster still shows a picture.

const MEDIA = 'video, audio';

/** The media the author put in a slide, never the engine's background clip. */
export function slideMedia(sec) {
  return [...(sec?.querySelectorAll?.(MEDIA) ?? [])].filter((m) => !m.closest('.slide-bg'));
}

/**
 * `sections()` the deck's slides, `current()` the one on screen, `live` false
 * for a page that only shows (print, capture, embedded).
 */
export function createSlideMedia({ root, sections, current, live }) {
  const onArrival = new WeakSet();
  const isSlideMedia = (m) => !!m?.matches?.(MEDIA) && !m.closest('.slide-bg') && !!m.closest('section');
  const onScreen = (m) => live && !!current()?.contains(m);

  function adopt(m) {
    if (m.hasAttribute('autoplay')) {
      onArrival.add(m);
      m.removeAttribute('autoplay');
    }
    if (!live && m.preload !== 'auto') m.preload = 'auto';
    if (!m.paused && !onScreen(m)) m.pause();
  }
  /** Every slide's media taken in: at boot, and after an edit put new media on a slide. */
  function adoptAll() {
    for (const s of sections()) for (const m of slideMedia(s)) adopt(m);
  }

  // A clip may still start on its own (it had its data before boot, or a
  // copy of it is shown somewhere else): never off the slide on screen.
  root.addEventListener('play', (e) => {
    if (isSlideMedia(e.target) && !onScreen(e.target)) e.target.pause();
  }, true);

  let shown = null;
  /** The slide changed: what was left stops and goes back to its start, what arrived plays when it asked to. */
  function sync() {
    adoptAll();
    const now = current() ?? null;
    if (now === shown) return;
    shown = now;
    for (const s of sections()) {
      if (s === now) continue;
      for (const m of slideMedia(s)) {
        if (!m.paused) m.pause();
        if (m.currentTime > 0) m.currentTime = 0;
      }
    }
    if (!live || !now) return;
    for (const m of slideMedia(now)) if (onArrival.has(m)) m.play()?.catch?.(() => {});
  }

  return {
    sync,
    adopt: adoptAll,
    /** Did the author ask this clip to play when its slide arrives? */
    playsOnArrival: (m) => onArrival.has(m),
  };
}
