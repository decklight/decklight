// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The message every author-mode-gated action shows when there is no edit
// server (SPEC PRESENTING). Layout cycling, undo/redo, ask-an-agent and the notes
// editor each hand-wrote their own version of it, they disagreed on the
// command — and none of them told you the thing you actually need: what to
// type, and where to type it. That matters most for the commonest case, a
// deck opened by double-clicking the file, where `location.pathname` IS a
// real filesystem path and can name the folder to run from.
//
// Pure and location-injected so it is node-testable (the parseBackground
// idiom); the engine passes the real `location`.

const CMD = 'npx decklight author';

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
  return `${action} needs author mode: ${where}run ${CMD} ${deck}, then reopen the URL it prints`;
}

// ── "the agent is still working" ───────────────────────────────────────────
//
// An agent ask used to report itself twice — a toast when it started and a
// toast when it finished — and both expired in a couple of seconds. In between,
// for a run that can last minutes, the deck said nothing at all, and the only
// way to find out it was still going was to press A again and read the refusal.
// A one-shot notification is the wrong shape for a job with a duration.
//
// So the chip is PERSISTENT while the job is, and what makes it worth looking
// at is the elapsed time: a name alone cannot tell you the difference between
// "working" and "wedged", and a clock that is still moving can.

/** mm:ss for a duration, counting past an hour rather than wrapping to zero. */
export function elapsedLabel(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}:${s}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`;
}

/**
 * `18 minutes ago` → `18m`, for the metadata line under a subject.
 *
 * Compressed here rather than asked of git, because `deckHistory`'s shape is
 * the CLI's too and a fifth field would ripple into `decklight restore` and
 * `decklight history` for a label only the overlay wants. Git's `%ar` is
 * stable English regardless of locale, so the parse is safe — and anything it
 * does not recognise falls through unchanged rather than becoming a guess.
 * The unabbreviated form is still under the preview.
 */
export const AGE_UNIT = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
export function shortAge(when) {
  const m = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/.exec(String(when ?? '').trim());
  return m ? `${m[1]}${AGE_UNIT[m[2]]}` : String(when ?? '');
}

/**
 * What the chip says for a running job, or null when nothing is running.
 *
 * `startedAt` comes from the SERVER (it is in the `agent` start event and in
 * `/edit/ping`), so a reload mid-run shows the true elapsed time rather than
 * restarting the clock — the job outlives the page, and the chip should say so.
 * A missing or unreadable `startedAt` still gets a chip: knowing an agent is
 * running matters more than knowing for how long, and dropping the whole
 * indicator over a bad timestamp would be the tail wagging the dog.
 */
export function agentChipText(job, now = Date.now()) {
  if (!job || !job.agent) return null;
  const started = Number(job.startedAt);
  if (!Number.isFinite(started) || started <= 0 || started > now) return job.agent;
  return `${job.agent} · ${elapsedLabel(now - started)}`;
}

// ── "you have not pushed any of this" ─────────────────────────────────────
//
// The fourth place that mentions unpushed work, and the only one that
// interrupts. The other three are read when you go looking — `decklight
// history`, the H overlay's footer, the line author mode prints on its way out
// — so this one has to earn a toast, and the governing is most of the design.

/**
 * The toast text for unpushed work, or null for "say nothing".
 *
 * THREE THINGS KEEP IT FROM NAGGING, and one-per-session is the load-bearing
 * one: a limit expressed as a count cannot become a limit expressed as "every
 * few minutes" by accident, which is what happens to interval-based nudges and
 * why people turn them off. After that it is the message log's job (`` ` ``),
 * where it stays without asking again.
 *
 * A repository with NO REMOTE is silent here on purpose. Telling somebody to
 * push when there is nowhere to push is noise, and that nudge belongs to
 * `decklight init`, once, at the moment a remote could actually be added.
 */
export function pushToastText(remote, { shown = false, threshold = 10 } = {}) {
  if (shown || !remote) return null;
  if (!['ok', 'no-upstream'].includes(remote.state)) return null;
  const n = remote.state === 'ok' ? remote.ahead : remote.unpushed;
  if (!n || n < threshold) return null;
  return `↑${n} commits are only on this machine — H shows them`;
}
