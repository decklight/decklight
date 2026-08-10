// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Slide layout cycling (L / ⇧L) — SPEC PRESENTING.
//
// Walking the current slide through the layout ring is an AUTHOR-mode edit,
// not a presenting control: the pick lands on the section as `data-layout` and
// is written back into the file through the edit server. Without that server
// the key explains itself and changes nothing, so a presenter cannot silently
// fork the deck from what is on disk — the thing they will hand someone later.
//
// TWO RULES WORTH TESTING, WHICH IS WHY THIS IS ITS OWN FILE:
//
//   THE RING SKIPS WHAT WOULD DO NOTHING. `pinned` is dropped when the slide
//   already pins automatically, `split-flip` when there are not two content
//   blocks to swap. Every press has to change something visible, or L reads
//   as broken on exactly the slides where the author most wants to try things.
//
//   THE WRITE-THROUGH IS DEBOUNCED, AND A SLIDE CHANGE FLUSHES IT. The DOM
//   updates on every press; only the FINAL pick of a burst goes to the server,
//   because each write makes the watcher reload every open browser. But if the
//   burst moves to a DIFFERENT slide, the pending pick is flushed first —
//   otherwise cycling on slide 3 and stepping to slide 4 loses slide 3's edit,
//   which the author saw applied and has every reason to believe was saved.

/** The ring, in order. 'auto' means no attribute at all — the author's default. */
export const LAYOUTS = ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'];

/**
 * The ring for one slide, with entries that cannot change its look removed.
 *
 * `autoPins` and `hasSplitPair` are the two questions the deck answers about a
 * section; passing them in keeps the rule readable and lets it be checked
 * without a layout engine.
 */
export function ringFor({ autoPins, hasSplitPair }) {
  return LAYOUTS.filter((n) =>
    (n !== 'pinned' || !autoPins) &&
    (n !== 'split-flip' || hasSplitPair));
}

/** The next entry `dir` steps from `current`, wrapping in both directions. */
export function nextInRing(ring, current, dir) {
  if (!ring.length) return null;
  const at = Math.max(0, ring.indexOf(current));
  return ring[(at + dir + ring.length) % ring.length];
}

/**
 * Wire L / ⇧L for a deck.
 *
 * Every effect is injected: `apply` puts the pick on the section, `relayout`
 * re-derives pinned titles, split and the overflow flag, `post` is the
 * write-through, and `schedule`/`cancel` are the debounce's clock.
 */
export function createLayoutCycler({
  slideOf, sectionAt, describe, available, unavailableMessage,
  apply, relayout, post, toast, debugLog,
  schedule = setTimeout, cancel = clearTimeout, delay = 600,
}) {
  let pending = null;   // { slide, name }
  let timer = null;

  /** Send the pending pick, if any. Called on debounce, and on a slide change. */
  function flush() {
    cancel(timer);
    const p = pending;
    pending = null;
    if (!p) return;
    post({ slide: p.slide, layout: p.name })
      .then(() => debugLog('layout', `slide ${p.slide}: ${p.name} → saved to file`))
      .catch(() => toast('layout save failed — is the dev server still up?', 2200));
  }

  /** The ring the given slide would cycle through. */
  function ring(idx = slideOf()) {
    const sec = sectionAt(idx);
    return sec ? ringFor(describe(sec)) : [];
  }

  /** Step the current slide `dir` through its ring. */
  function cycle(dir) {
    if (!available()) {
      toast(unavailableMessage(), 3200);
      return;
    }
    const idx = slideOf();
    const sec = sectionAt(idx);
    if (!sec) return;

    const name = nextInRing(ring(idx), sec.getAttribute('data-layout') || 'auto', dir);
    if (!name) return;
    apply(sec, name);

    if (pending && pending.slide !== idx) flush();   // a different slide's pick must not be dropped
    pending = { slide: idx, name };
    cancel(timer);
    timer = schedule(flush, delay);

    // geometry changed: pinned titles, split and the overflow guardrail re-derive
    const conflict = relayout(sec, idx);
    // the pick can land split on a slide that hand-rolls its own columns — say
    // so at the keypress, not only in a console nobody has open
    toast(conflict
      ? `layout: ${name} — fights this slide's own column flexbox; pick one`
      : `layout: ${name}`);
    debugLog('layout', `slide ${idx}: ${name}`);
  }

  return { ring, cycle, flush };
}
