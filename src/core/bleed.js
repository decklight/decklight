// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Bleed (SPEC DECK_ANATOMY, DESIGN_SYSTEMS; #643): a slide's BACKGROUND art
 * fills the whole screen, whatever its shape, while its CONTENT stays on the
 * 16:9 stage.
 *
 * The stage is scaled to fit without changing its shape, so a 16:9 deck on a
 * 16:10 laptop or a 4:3 projector leaves bands above and below — and every
 * background stopped at the stage's edge, because everything a slide paints
 * lives inside the section, inside the stage. Reveal.js solves it with a
 * viewport-level background layer separate from the slides; this is the same
 * shape: ONE layer, behind the stage, covering the viewport, that paints the
 * current slide's art and nothing else.
 *
 * What bleeds:
 *   - background media — the slide's `.slide-bg` (data-background-image /
 *     -video / -poster): its image with its own size and position, now
 *     resolved against the viewport (cover, centred), or a muted clone of its
 *     video playing in step;
 *   - a slide template's art — the element its template marks
 *     `data-ds-bleed`: its computed background (colour, image, size,
 *     position, repeat), resolved against the viewport.
 *
 * While a slide bleeds, its on-stage copy of that art is hidden (the section
 * carries `data-bled`), so it is never drawn twice at two scales. The layer
 * cross-fades with the slide transition. It is never used in print, in an
 * embedded preview (the theme picker's, the speaker view's), or when the deck
 * says `"bleed": false`.
 */

const BG_PROPS = ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat'];

/** The art a section would bleed, or null: its background media, else its slide template's marked element. */
export function bleedSource(sec) {
  const media = sec?.querySelector(':scope > .slide-bg');
  if (media) return { kind: 'media', el: media };
  const ds = sec?.querySelector('[data-ds-injected][data-ds-bleed]');
  if (ds) return { kind: 'ds', el: ds };
  return null;
}

export function createBleed({ root, enabled }) {
  if (!enabled) return { update() {}, clear() {}, layer: null };
  const layer = document.createElement('div');
  layer.className = 'decklight-bleed';
  layer.setAttribute('aria-hidden', 'true');
  root.insertBefore(layer, root.firstChild);
  let current = null;   // { sec, piece }

  /** A painted copy of a section's art, at viewport size. */
  function pieceFor(sec, src) {
    const piece = document.createElement('div');
    piece.className = 'bleed-piece';
    // read BEFORE the on-stage copy is hidden: the computed style is what the author saw
    const cs = getComputedStyle(src.el);
    for (const p of BG_PROPS) piece.style[p] = cs[p];
    if (src.kind === 'media') {
      // a background image is a photograph: cover the viewport, centred
      if (!src.el.style.backgroundSize) piece.style.backgroundSize = 'cover';
      const video = src.el.querySelector('video');
      if (video) {
        const clone = document.createElement('video');
        for (const a of ['src', 'poster']) if (video.getAttribute(a)) clone.setAttribute(a, video.getAttribute(a));
        for (const s of video.querySelectorAll('source')) clone.appendChild(s.cloneNode());
        Object.assign(clone, { muted: true, loop: video.loop, playsInline: true, autoplay: true });
        clone.muted = true;
        try { clone.currentTime = video.currentTime || 0; } catch { /* not seekable yet */ }
        piece.appendChild(clone);
        clone.play?.()?.catch?.(() => {});
      }
      const dim = src.el.querySelector('.slide-bg-dim');
      if (dim) {
        const d = document.createElement('div');
        d.className = 'bleed-dim';
        d.style.background = getComputedStyle(dim).background;
        d.style.opacity = getComputedStyle(dim).opacity;
        piece.appendChild(d);
      }
    }
    return piece;
  }

  function retire(entry, ms) {
    if (!entry) return;
    const { sec, piece } = entry;
    piece.style.opacity = '0';
    const done = () => {
      piece.querySelector('video')?.pause?.();
      piece.remove();
      if (current?.sec !== sec) sec.removeAttribute('data-bled');
    };
    if (ms > 0) setTimeout(done, ms + 40); else done();
  }

  /**
   * Show `sec`'s art on the layer (or nothing, when it has none), fading over
   * `ms`. Idempotent for the slide already shown — a re-sync that changed its
   * art repaints it in place.
   */
  function update(sec, { ms = 0 } = {}) {
    const src = bleedSource(sec);
    if (current?.sec === sec) {
      if (!src) { retire(current, 0); current = null; return; }
      // the same slide: repaint only when its art changed (a live edit)
      const sig = BG_PROPS.map((p) => getComputedStyle(src.el)[p]).join('|');
      if (sig === current.sig) return;
      sec.removeAttribute('data-bled');
      const fresh = pieceFor(sec, src);
      fresh.style.opacity = '1';
      layer.replaceChild(fresh, current.piece);
      sec.setAttribute('data-bled', '');
      current = { sec, piece: fresh, sig: BG_PROPS.map((p) => getComputedStyle(src.el)[p]).join('|') };
      return;
    }
    const was = current;
    current = null;
    if (src) {
      sec.removeAttribute('data-bled');
      const sig = BG_PROPS.map((p) => getComputedStyle(src.el)[p]).join('|');
      const piece = pieceFor(sec, src);
      piece.style.transition = ms > 0 ? `opacity ${ms}ms ease` : '';
      piece.style.opacity = ms > 0 ? '0' : '1';
      layer.appendChild(piece);
      sec.setAttribute('data-bled', '');
      if (ms > 0) requestAnimationFrame(() => requestAnimationFrame(() => { piece.style.opacity = '1'; }));
      current = { sec, piece, sig };
    }
    if (was) {
      was.piece.style.transition = ms > 0 ? `opacity ${ms}ms ease` : '';
      retire(was, ms);
    }
  }

  function clear() {
    for (const p of [...layer.children]) { p.querySelector('video')?.pause?.(); p.remove(); }
    current?.sec.removeAttribute('data-bled');
    current = null;
  }

  return { update, clear, layer };
}
