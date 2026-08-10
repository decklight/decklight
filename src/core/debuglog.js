// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The debug log's RING BUFFER (D) — what is recorded, and when. The window
// that displays it stays in engine.js with the rest of the chrome.
//
// The buffer starts recording at init and never stops, because the events
// worth reading are the ones that already happened: by the time a presenter
// notices the voice stopped and presses D, the reason is thirty seconds old.
// A log that only records while its window is open would have nothing to show
// exactly when it is opened.
//
// It has to exist before almost anything else in init — theme restoration logs
// during startup, before there is any chrome to log into — which is why it was
// the first thing in the closure and why it takes its sink separately: the
// window attaches later, and until it does, entries just accumulate.

/** How many entries to keep. Enough for a talk's worth of interesting moments. */
export const DEBUG_KEEP = 200;

/**
 * A timestamped ring buffer.
 *
 * `now` is injected so a test can assert the timestamps rather than the fact
 * that timestamps exist — the elapsed figure is the whole point of the log,
 * since "3.001s in" is what ties a stall to what caused it.
 */
export function createDebugLog({ now = Date.now, keep = DEBUG_KEEP } = {}) {
  const t0 = now();
  const entries = [];
  let sink = null;

  /** Record one event: `kind` groups it, `msg` is what a human reads. */
  function log(kind, msg) {
    const entry = { t: ((now() - t0) / 1000).toFixed(3), kind, msg };
    entries.push(entry);
    if (entries.length > keep) entries.shift();
    sink?.(entry);
    return entry;
  }

  return {
    log,
    /** Everything recorded so far, oldest first — what the window renders on open. */
    get entries() { return entries.slice(); },
    /**
     * Attach the window (or detach it with null). Called when D opens the
     * panel, which is always after events have been recorded, never before.
     */
    onEntry(fn) { sink = fn; },
  };
}
