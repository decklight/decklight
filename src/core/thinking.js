// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A wait whose length nobody knows — an agent writing a commit subject from a
// diff takes one second or twenty — shown as moving ASCII, so a still window
// is never mistaken for a stuck one.
//
// ASCII on purpose: `| / - \` renders in every font a deck can be themed with,
// at every size, and never falls back to a tofu box the way a braille spinner
// does on a machine without the glyphs. The elapsed seconds join once the wait
// is long enough to be worth counting. Under `prefers-reduced-motion` the mark
// becomes slow dots instead of a spinning bar.

const FRAMES = ['|', '/', '-', '\\'];

/**
 * Start the indicator. `paint(text)` is called at once and on every frame
 * with e.g. `thinking /` or `thinking - 4s`; the returned function stops it.
 * Stopping is idempotent, so every way out of a wait can call it.
 */
export function thinking(paint, { label = 'thinking', every = 120 } = {}) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const started = Date.now();
  let frame = 0;
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const mark = reduced ? '.'.repeat(1 + (frame % 3)).padEnd(3) : FRAMES[frame % FRAMES.length];
    paint(`${label} ${mark}${secs >= 2 ? ` ${secs}s` : ''}`);
    frame++;
  };
  tick();
  const timer = setInterval(tick, reduced ? 600 : every);
  let stopped = false;
  return () => { if (!stopped) { stopped = true; clearInterval(timer); } };
}
