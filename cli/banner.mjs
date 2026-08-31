// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * One banner for `decklight author`, and the deck's URL is the last thing on it.
 *
 * author runs its servers as child processes and used to let each one print its
 * own startup lines through a pipe that did nothing but prefix them. That gave
 * two problems no amount of rewording fixes:
 *
 *   THE ORDER WAS A RACE. `deck` and `voice` are separate processes announcing
 *   themselves whenever they happen to be ready, so the URL a person is meant
 *   to click landed wherever it landed — often above the bridge's line, which
 *   is also a URL, and the wrong one to click.
 *
 *   NOBODY OWNED THE WHOLE. Each line was defensible alone and the eight
 *   together were a wall, because no single place could see them all and
 *   decide what mattered.
 *
 * So author prints the banner and the children stop printing startup lines —
 * they hand author a FACT instead, on the same pipe, behind a sentinel
 * (`readyLine`). Only under author: with no `DECKLIGHT_BANNER` in the
 * environment every child prints exactly what it printed before, which is what
 * `decklight edit` and `decklight tts` run on their own still do.
 *
 * Nothing here does I/O. `renderBanner` takes facts and returns lines, so the
 * layout is a unit test rather than something you check by starting a server.
 */

/**
 * The marker a child puts in front of a startup fact.
 *
 * The leading \u0001 is deliberate: it cannot occur in a human-facing line, so
 * ordinary child output can never be mistaken for a fact, and a fact can never
 * leak onto the terminal as something to read.
 */
export const READY = '\u0001decklight:ready ';

/** What a child writes instead of its own startup line. */
export function readyLine(fact) {
  return READY + JSON.stringify(fact);
}

/** A child's line as a fact, or null if it is ordinary output to pass through. */
export function parseReady(line) {
  if (typeof line !== 'string' || !line.startsWith(READY)) return null;
  try {
    const fact = JSON.parse(line.slice(READY.length));
    return fact && typeof fact === 'object' && !Array.isArray(fact) ? fact : null;
  } catch { return null; }
}

/**
 * The order rows appear in, whatever order the processes woke up in — which is
 * the entire point of collecting them all before printing any.
 *
 * `reviews` is last because it is the only row that is a THING TO DO rather
 * than a thing that is merely true, so it sits closest to the URL.
 */
export const ROW_ORDER = ['voice', 'lips', 'skipped', 'git', 'agents', 'reviews'];

const ESC = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', under: '\x1b[4m', reset: '\x1b[0m' };

/**
 * The banner, as lines. `rows` is `[{ key, text }]` in any order; a key not in
 * ROW_ORDER keeps its arrival position after the known ones, so a service added
 * later still appears without anyone having to remember to edit that list.
 */
export function renderBanner({ deck, url, keys, rows = [], color = false } = {}) {
  const c = (s, ...codes) => (color ? codes.map((k) => ESC[k]).join('') + s + ESC.reset : s);
  const rank = (k) => { const i = ROW_ORDER.indexOf(k); return i === -1 ? ROW_ORDER.length : i; };
  const shown = rows
    .filter((r) => r && r.key && r.text)
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i);

  const out = [`decklight author${deck ? ` ${c('·', 'dim')} ${deck}` : ''}`];
  if (shown.length) {
    out.push('');
    const w = Math.max(...shown.map((r) => r.key.length));
    for (const r of shown) out.push(`  ${c(r.key.padEnd(w), 'dim')}  ${r.text}`);
  }
  // The URL last, and the only coloured thing here, because a person scanning
  // this is looking for exactly one thing and it is this.
  out.push('', `  ${c('▸', 'cyan')} ${c(url, 'bold', 'cyan', 'under')}`);
  if (keys) out.push(`    ${c(keys, 'dim')}`);
  return out;
}

/**
 * How long to wait before printing the banner, or null for "not yet".
 *
 * Pure, because the ordering bug it encodes is not one you want to find by
 * starting three servers and squinting. A grace window ALONE is not enough:
 * the voice bridge enumerates the machine's voices before it can say what it
 * is, so it reports hundreds of milliseconds after the deck server does, and
 * any grace short enough to feel instant printed the banner without it — the
 * bridge's row then landed UNDER the url, which is the one thing the banner
 * exists to prevent. So the wait is on NAMES: nobody still owed, then a short
 * grace for the genuinely late (the review check fires detached, after the
 * deck server is already listening), and a cap so one silent child cannot sit
 * on the url forever.
 */
export function nextFlushDelay({ waiting = 0, elapsed = 0, cap = 5000, grace = 350 } = {}) {
  if (waiting > 0) return null;
  return Math.max(0, Math.min(grace, cap - elapsed));
}

/**
 * How anything WATCHING author's output finds the deck's url.
 *
 * Exported because six harnesses each carried their own copy of the old
 * `decklight author on http://…`, and the day that line changed shape all six
 * timed out for the same reason in six different files. A banner is a thing
 * people read, so its wording will change again; this is the part that is a
 * contract, and it lives next to the code that prints it.
 *
 * Group 1 is the port. Tolerant of the colour codes a terminal gets and a pipe
 * does not, so it matches whichever way author was run.
 */
export const DECK_URL_RE = /\u25b8\s*(?:\x1b\[[0-9;]*m)*http:\/\/127\.0\.0\.1:(\d+)/;
