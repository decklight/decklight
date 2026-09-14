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
  // The same list as a Set: every mutation record has to be attributed to a
  // watched section, and that lookup happens far more often than a re-aim.
  let live = new Set();
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

  // ── what is armed, and what it cost to arm ────────────────────────────────
  // Both observers outlive every navigation. Tearing them down and rebuilding
  // them per slide change was the whole cost of a keypress: `querySelectorAll`
  // plus a `.closest('.terminal')` walk per node, for a subtree that had not
  // changed since the last time that slide was on stage. A deck is navigated
  // back and forth; the arming is not.

  /**
   * Section → the nodes it currently has under the resize watch.
   *
   * Not derivable from the section on demand: it also holds the nodes that
   * ARRIVED after arming (#251), which are not in the cached descendant list.
   * This is what re-aiming unobserves, so it has to be what was observed.
   */
  const observed = new Map();
  /** Section → its descendant list, until the DOM under it says otherwise. */
  const subtree = new WeakMap();
  /** Sections handed to the mutation observer — which has no `unobserve`. */
  const mutating = new WeakSet();
  /** Sections whose DOM has moved since they were armed. */
  const dirty = new WeakSet();

  /**
   * `el` and everything inside it, minus terminal internals.
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
  const nodesUnder = (el) => [el, ...el.querySelectorAll('*')]
    .filter((n) => !n.parentElement?.closest('.terminal'));

  /** Recruit `nodes` into the resize watch, on `section`'s tab. */
  function watchResizes(section, nodes) {
    if (!resize) return;
    const mine = observed.get(section);
    for (const n of nodes) { resize.observe(n); mine.push(n); }
  }

  /** Which watched section does this record belong to, if any? */
  function sectionOf(node) {
    for (let n = node?.nodeType === 1 ? node : node?.parentElement; n; n = n.parentElement) {
      if (live.has(n)) return n;
    }
    return null;
  }

  const mutate = MutationObs ? new MutationObs((records) => {
    const outside = (n) => !(n.nodeType === 1 ? n : n.parentElement)?.closest('.terminal');
    let relevant = false;
    for (const r of records) {
      // A section stays registered with the mutation observer after it leaves
      // the stage — there is no way to take one target off — so the filter is
      // here instead: a record under no watched section is another slide's
      // business, and the deck is not standing on it.
      const section = sectionOf(r.target);
      if (!section || !outside(r.target)) continue;
      relevant = true;
      // The shape of this section changed, so the cached descendant list is a
      // description of a DOM that no longer exists. Drop it, and mark the
      // section for a full re-arm at the next aim — the arriving nodes are
      // recruited below, but the DEPARTED ones are still on the resize watch
      // and still referenced, and dev mode re-renders a slide in place over and
      // over while it stays on stage.
      if (r.type === 'childList') { subtree.delete(section); dirty.add(section); }
      // Measuring an arriving subtree once is not enough: its later growth (an
      // image inside it decoding a second on) fires no further mutation, and
      // once every box above it is clamped, no resize of anything armed
      // earlier. Nodes that arrive after arming join the watch the same way
      // arming recruited what was already on stage (#251).
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.isConnected) watchResizes(section, nodesUnder(n));
      }
    }
    if (relevant) recheck();
  }) : null;

  // `load`/`error` do not bubble, but a capturing listener still hears every
  // descendant's — including on media that mounts after arming.
  const onLateMedia = (e) => {
    if (!e.target.closest?.('.terminal')) recheck();
  };

  return {
    /**
     * Re-aim the watch at `sections` (the active slide, or the whole deck in
     * print).
     *
     * A DIFFERENCE, not a rebuild: a section that is still on the list keeps
     * everything it already had — the observed nodes, the listeners, the cached
     * descendant list — so arrowing forward and back re-arms nothing. Only what
     * arrived and what left is touched.
     */
    watch(sections) {
      const next = sections.filter(Boolean);
      const keep = new Set(next);
      for (const [s, nodes] of observed) {
        if (keep.has(s)) continue;
        for (const n of nodes) resize?.unobserve(n);
        observed.delete(s);
        for (const t of ['load', 'error']) s.removeEventListener(t, onLateMedia, true);
      }
      watched = next;
      live = keep;
      for (const s of watched) {
        const armed = observed.has(s);
        if (armed && !dirty.has(s)) continue;   // already armed, and still correct
        if (armed) for (const n of observed.get(s)) resize?.unobserve(n);
        observed.set(s, []);
        dirty.delete(s);
        let nodes = subtree.get(s);
        if (!nodes) subtree.set(s, nodes = nodesUnder(s));
        watchResizes(s, nodes);
        if (armed) continue;   // the listeners and the mutation watch stayed put
        // Re-registering a target the mutation observer already holds would
        // just replace the registration with the identical one, so the cheaper
        // thing is not to ask.
        if (!mutating.has(s)) { mutating.add(s); mutate?.observe(s, { childList: true, subtree: true, characterData: true }); }
        for (const t of ['load', 'error']) s.addEventListener(t, onLateMedia, true);
      }
      recheck();   // arming is also the first measurement
    },
    /** What is on watch right now — for tests and the debug log. */
    get watched() { return watched.slice(); },
  };
}
