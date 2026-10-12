// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The debug log's RING BUFFER (palette: Help: Debug log) — what is recorded, and when. The window
// that displays it stays in engine.js with the rest of the chrome.
//
// The buffer starts recording at init and never stops, because the events
// worth reading are the ones that already happened: by the time a presenter
// notices the voice stopped and presses D, the reason is thirty seconds old.
// A log that only records while its window is `open` would have nothing to show
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
export function createDebugLog({ now = Date.now, keep = DEBUG_KEEP, seed = [], first = null } = {}) {
  const t0 = now();
  // What the page before the reload had recorded (`unstashDebug`), marked
  // `prev`: their times are that page's, and the window dims them
  const entries = seed.slice(-keep).map((e) => ({ t: String(e.t), kind: String(e.kind), msg: String(e.msg), prev: true }));
  // This page's first word (the reason it reloaded), stamped AT t0, not
  // logged after it: a log() a moment later reads 0.001 on a slow machine,
  // and "this page starts at zero" is the promise the window makes
  if (first) entries.push({ t: (0).toFixed(3), kind: String(first.kind), msg: String(first.msg) });
  if (entries.length > keep) entries.shift();
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

// ── across a reload ──────────────────────────────────────────────────────
// Write mode reloads the page on every write of the file, and a reload
// wipes the buffer: the one moment an author asks "why did that reload?",
// the log that could answer is gone. So the page leaving stashes its buffer
// and the reason it was told (sessionStorage: this tab's, and only this
// tab's), and the page arriving seeds its buffer from the stash and says the
// reason first thing. Older than a minute, a stash is some other session's.

/** The stash's key: per deck, so two decks in one tab never read each other's. */
export const debugStashKey = (path) => 'decklight-debug:' + path;
export const DEBUG_STASH_TTL_MS = 60_000;

/** Leave the buffer and the reason for the page that comes next. */
export function stashDebug(storage, path, entries, reason = null, now = Date.now) {
  storage.setItem(debugStashKey(path), JSON.stringify({ t: now(), reason, entries: entries.slice(-DEBUG_KEEP) }));
}

/** The stash the page before left, taken (it is read once), or null: none, stale, or malformed. */
export function unstashDebug(storage, path, now = Date.now) {
  const key = debugStashKey(path);
  const raw = storage.getItem(key);
  if (raw === null) return null;
  storage.removeItem(key);
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j.t !== 'number' || now() - j.t > DEBUG_STASH_TTL_MS || !Array.isArray(j.entries)) return null;
    return { reason: typeof j.reason === 'string' ? j.reason : null, entries: j.entries };
  } catch { return null; }
}

/**
 * The reload message, as the log says it: the server names what wrote the
 * file (`{"reload":"notes saved","from":"<page>"}`), and the page it came from
 * is "this tab" or "another tab" when the write said which. An older server
 * sends a bare `reload`, which is a reload all the same.
 */
export function reloadLine(data, pageId = null) {
  let p = null;
  try { p = JSON.parse(data); } catch { /* an older server: bare "reload" */ }
  if (!p || typeof p !== 'object' || typeof p.reload !== 'string') return 'the file changed';
  const who = typeof p.from === 'string' && p.from ? (p.from === pageId ? ' · this tab' : ' · another tab') : '';
  return p.reload + who;
}
