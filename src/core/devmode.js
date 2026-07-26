// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The message every dev-gated action shows when there is no edit server
// (SPEC §8). Layout cycling, undo/redo, ask-an-agent and the notes editor each
// hand-wrote their own version of it, they disagreed on the command — one said
// `decklight edit` — and none of them told you the thing you actually need:
// what to type, and where to type it. That matters most for the commonest
// case, a deck opened by double-clicking the file, where `location.pathname`
// IS a real filesystem path and can name the folder to run from.
//
// Pure and location-injected so it is node-testable (the parseBackground
// idiom); the engine passes the real `location`.

const CMD = 'npx decklight dev';

/**
 * Split a `file:` pathname into its folder and filename. Returns empty strings
 * when the path cannot be read that way, so callers degrade to the generic
 * message rather than printing half a path.
 */
function splitFilePath(pathname) {
  let p = pathname || '';
  try { p = decodeURIComponent(p); } catch { /* %-escapes we cannot read: use it raw */ }
  // A Windows file URL arrives as /C:/decks/talk.html — that leading slash is
  // URL syntax, not part of the path.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  const cut = p.lastIndexOf('/');
  return { dir: cut > 0 ? p.slice(0, cut) : '', file: cut >= 0 ? p.slice(cut + 1) : p };
}

/**
 * The toast text for `action` (a short label — "layout", "undo", "asking an
 * agent") when the edit server is not available.
 *
 * On `file:` it names the folder to run from and the deck's filename, because
 * there the pathname is a real filesystem path. On an http(s) origin that
 * simply is not wired up it still gives the command, but never claims a folder
 * — a URL path is not necessarily one.
 */
export function needsDevMode(action, loc = {}) {
  const { protocol = '', pathname = '' } = loc;
  const { dir, file } = splitFilePath(pathname);
  const deck = /\.html?$/i.test(file) ? file : '<deck.html>';
  const where = protocol === 'file:' && dir ? `from ${dir}, ` : '';
  return `${action} needs dev mode: ${where}run ${CMD} ${deck}, then reopen the URL it prints`;
}
