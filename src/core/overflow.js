// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The overflow guardrail's WATCH — the machinery that decides *when* a slide
// gets measured. What "overflowing" means is `checkOverflow` in engine.js and
// stays there; this file is only the ears.
//
// Extracted from init()'s closure so it can be tested at all: every observer
// and the scheduler arrive as arguments, so a Node test can drive a mount, a
// late resize and a late `load` without a browser. Before, the only way to
// exercise it was a render harness, which is exactly how the two bugs it has
// had (#184's one-frame latch, #251's post-arming growth) reached a release.
//
// THE THREE EARS, AND WHY IT IS THREE. Nothing here is belt-and-braces; each
// hears a case the others cannot:
//
//   - ResizeObserver — boxes changing size: a webfont resolving, an image
//     decoding.
//   - MutationObserver — content ARRIVING. An overfull child is flex-shrunk to
//     the space available, so its box height does not move while its
//     scrollHeight runs away, and a resize watch sees nothing at all.
//   - capturing `load`/`error` — media landing. ResizeObserver DELIVERY rides
//     the rendering pipeline, and under `--virtual-time-budget` (every render
//     harness, and `decklight pdf`) frame production stops once the page goes
//     idle. `load` is a plain task and arrives anyway.
//
// And the re-check is scheduled on a TIMER, not a frame, for that same reason:
// a callback booked on requestAnimationFrame after the page goes idle is never
// called, and an unmeasured slide reads exactly like a clean one. Reading
// scrollHeight forces the layout it needs anyway.
//
// A MISSED flag is the dangerous direction: the authoring contract (SPEC
// PRESENTING) has agents assert `[data-overflow]` is absent, so a slide that
// settles into clipping after the one measurement does not fail that check —
// it passes it, quietly, forever.

/**
 * Wire an overflow watch.
 *
 * `sectionsOf()` returns the deck's sections, for turning a watched section
 * back into the slide number `checkOverflow` reports. The observer
 * constructors and the scheduler are injected so this runs headless.
 */
export function createOverflowWatch({
  sectionsOf,
  checkOverflow,
  ResizeObs = typeof ResizeObserver === 'function' ? ResizeObserver : null,
  MutationObs = typeof MutationObserver === 'function' ? MutationObserver : null,
  schedule = (fn) => setTimeout(fn),
}) {
  let watched = [];
  let timer = 0;

  /** Measure every watched section, coalescing the bursts a mount arrives in. */
  function recheck() {
    if (timer) return;
    timer = schedule(() => {
      timer = 0;
      const sections = sectionsOf();
      for (const s of watched) checkOverflow(s, sections.indexOf(s) + 1);
    }) || 1;   // a schedule() returning 0/undefined still counts as pending
  }

  const resize = ResizeObs ? new ResizeObs(recheck) : null;

  /**
   * Recruit `el` and everything inside it into the resize watch.
   *
   * The section box is a fixed design-resolution rectangle, so content growing
   * inside it never resizes it — only the content can report that. And ALL of
   * the content, not just the direct children: a grandchild can grow on its own
   * (an image decoding long after mount) while every box between it and the
   * section sits clamped at its flex minimum, moving nothing a shallower watch
   * observes. Terminal internals are skipped for the same reason the mutation
   * filter does: a playing cast redraws constantly, and terminals are excluded
   * from the clip test anyway (SPEC TERMINAL_PLAYER — they scroll by design).
   */
  function watchResizes(el) {
    if (!resize) return;
    for (const n of [el, ...el.querySelectorAll('*')]) {
      if (!n.parentElement?.closest('.terminal')) resize.observe(n);
    }
  }

  const mutate = MutationObs ? new MutationObs((records) => {
    const outside = (n) => !(n.nodeType === 1 ? n : n.parentElement)?.closest('.terminal');
    let relevant = false;
    for (const r of records) {
      if (!outside(r.target)) continue;
      relevant = true;
      // Measuring an arriving subtree once is not enough: its later growth (an
      // image inside it decoding a second on) fires no further mutation, and
      // once every box above it is clamped, no resize of anything armed
      // earlier. Nodes that arrive after arming join the watch the same way
      // arming recruited what was already on stage (#251).
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.isConnected) watchResizes(n);
    }
    if (relevant) recheck();
  }) : null;

  // `load`/`error` do not bubble, but a capturing listener still hears every
  // descendant's — including on media that mounts after arming.
  const onLateMedia = (e) => {
    if (!e.target.closest?.('.terminal')) recheck();
  };

  return {
    /** Re-aim the watch at `sections` (the active slide, or the whole deck in print). */
    watch(sections) {
      resize?.disconnect();
      mutate?.disconnect();
      for (const s of watched) for (const t of ['load', 'error']) s.removeEventListener(t, onLateMedia, true);
      watched = sections.filter(Boolean);
      for (const s of watched) {
        watchResizes(s);
        mutate?.observe(s, { childList: true, subtree: true, characterData: true });
        for (const t of ['load', 'error']) s.addEventListener(t, onLateMedia, true);
      }
      recheck();   // arming is also the first measurement
    },
    /** What is on watch right now — for tests and the debug log. */
    get watched() { return watched.slice(); },
  };
}
