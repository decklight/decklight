#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The live-editing deck server behind `decklight author` (SPEC PRESENTING
// author mode). Not a command of its own anymore — the dispatcher refuses
// `edit` out loud — author spawns this module directly:
//
//   node cli/edit.mjs <deck.html> [--port 8788] [--git | --no-git]
//                     [--commit-every <seconds>] [--agent <name>] [--commit-messages]
//
// It binds 127.0.0.1 and nothing else. The phone remote used to be here behind
// `--remote`, which meant a clicker cost you an editing server on the LAN;
// `decklight present --remote` hosts it now, with no edit surface to widen
// (PRESENT#REMOTE). Both flags are refused out loud rather than ignored.
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /edit/ping            → { ok, deck, undo, redo, git, agents, agentBusy, wizards }
//   GET  /edit/events          → SSE; `reload` on deck change, `agent` job status
//   POST /edit/notes           → { slide, text }           rewrite that slide's notes
//   POST /edit/layout          → { slide, layout }         write data-layout to the file
//   GET  /edit/element/source  → ?slide=&index=            an element's outerHTML, fresh from the file
//   POST /edit/element/remove  → { slide, index }          delete that element
//   POST /edit/element/content → { slide, index, html }    replace its outerHTML
//   POST /edit/element/effect  → { slide, index, effect }  write data-build (null strips it)
//   POST /edit/undo            → step the deck file back through the edit history
//   POST /edit/redo            → step it forward again
//   POST /edit/agent           → { prompt, agent? }        one-shot AI agent edit
//   POST /edit/shutdown        → final autocommit, then exit — same as Ctrl-C, so a
//                                port conflict can take over an old session cleanly
//
// Every mutation goes through ONE undo history — snapshots of the whole
// file, held in memory, capped. Undo/redo is deliberately independent of
// git: git commits (below) are the durable record, the history is the
// second-to-second "that ring entry was worse" loop, and neither consumes
// the other. An agent run snapshots before it starts, so Z takes an
// agent's edit back exactly like the player's own.
//
// Git: with --git (or when the deck already sits in a repository and
// --no-git wasn't passed) the server auto-commits the deck on a regular
// basis — every --commit-every seconds when it actually changed, plus a
// final commit on Ctrl-C. --git also creates the repository when none
// exists — seeded with a starter .gitignore (createRepo, below).
// `decklight author` asks interactively before passing --git down.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, watch, existsSync } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { agentCommand, detectAgents, agentUnavailable, preferredAgent, setPreferredAgent } from './agents.mjs';
import { exitWhenOrphaned } from './supervise.mjs';
import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { NOTES_ASIDE, locateSlide, sectionChildRanges } from '../tools/deck-html.mjs';
// the boot-call locator audit and upgrade share — three commands, one answer
// about which <script> is the init call
import { classifyScripts } from './audit.mjs';
import { reviewPathFor, parseReview, serializeRecord, newId } from './review-store.mjs';
import { deckHistory, decorateHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';
import { escapeHtml, sseChannel, staticFiles, listenTakingOverIfNeeded, allowEditRequest } from './serve.mjs';
import { reviewsWaiting, reviewLine, reviewCheckSuppressed } from './review-remote.mjs';
import { configureEngine, loadCredentials, forgetCredentials, redactAnswers, validateSchema, provenance, BRIDGE_ADDR, CONFIGURED, UNREACHABLE, PREREQUISITE } from './wizard.mjs';

// The `/edit/*` surface answers loopback only — but "loopback" is the wrong
// boundary for the threat (#222). The dangerous caller is not off-machine: it
// is the user's own browser, where any open tab can `fetch()` this port. Binding
// 127.0.0.1 does nothing about that, and a wildcard `access-control-allow-origin`
// actively invites it. So every request is gated by `allowEditRequest` on its
// `Origin` (below), and CORS is echoed per request rather than granted to `*` —
// a foreign site's `fetch` never reaches a handler. The one origin still let
// through besides loopback is `null`: a file://-opened deck probes this server
// directly, and the SPEC keeps that double-click path (PRESENTING).
const corsHeadersFor = (origin) => ({
  ...(origin !== undefined ? { 'access-control-allow-origin': origin } : {}),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  vary: 'Origin',
});

// ── remote access & static serving: extracted to serve.mjs / remote.mjs ────
// (PRESENT_SERVER in MARKETPLACE.md: `decklight present` reuses the same core
// with the /edit/* routes ABSENT, not merely refused.) Re-exported here so
// existing importers — the tests, init.mjs — and SPEC citations keep working.
export { isLoopback, lanAddress, escapeHtml } from './serve.mjs';

/** ⟨CLICK⟩-separated plain text → the aside's inner HTML (one <p> per segment). */
export function notesTextToAside(text) {
  const segs = text.split(/\s*⟨CLICK⟩\s*/).map((s) => s.replace(/\s+/g, ' ').trim());
  const ps = [];
  segs.forEach((seg, i) => {
    if (i > 0) ps.push('<p>⟨CLICK⟩</p>');
    if (seg) ps.push(`<p>${escapeHtml(seg)}</p>`);
  });
  return ps.join('\n        ');
}

/** Replace (or insert) slide N's <aside class="notes"> in the deck html. */
export function setSlideNotes(html, slide, asideInner) {
  const { parts, idx } = locateSlide(html, slide);
  const aside = `<aside class="notes">\n        ${asideInner}\n      </aside>`;
  const seg = parts[idx];
  parts[idx] = NOTES_ASIDE.test(seg)
    ? seg.replace(NOTES_ASIDE, aside)
    : seg.replace(/<\/section>/, `  ${aside}\n    </section>`);
  return parts.join('');
}

// the same ring the player cycles — the file is the source of truth now
export const LAYOUTS = ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'];

/** Set (or, for 'auto', remove) slide N's data-layout attribute in the deck html. */
export function setSlideLayout(html, slide, name) {
  if (!LAYOUTS.includes(name)) throw new Error(`unknown layout "${name}"`);
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const gt = seg.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed <section> tag`);
  let head = seg.slice(0, gt).replace(/\s+data-layout=("[^"]*"|'[^']*')/, '');
  if (name !== 'auto') head += ` data-layout="${name}"`;
  parts[idx] = head + seg.slice(gt);
  return parts.join('');
}

/** Look up element `index` (raw child position) on slide `slide`, or throw. */
function locateElement(html, slide, index) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const ranges = sectionChildRanges(seg);
  const r = ranges[index];
  if (!r) throw new Error(`slide ${slide}: no element at index ${index} (has ${ranges.length})`);
  return { parts, idx, seg, r };
}

/** Remove slide N's element at raw child index `index` (title included). */
export function removeSlideElement(html, slide, index) {
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  parts[idx] = seg.slice(0, r.start) + seg.slice(r.end);
  return parts.join('');
}

/** Replace slide N's element at raw child index `index` with `outerHtml` verbatim. */
export function setSlideElementHtml(html, slide, index, outerHtml) {
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  parts[idx] = seg.slice(0, r.start) + outerHtml + seg.slice(r.end);
  return parts.join('');
}

// The spec's 7 entrance styles (MOTION), plus 'none' — an explicit, instant
// build step, distinct from having no data-build attribute at all: one more
// advance still reveals the element, it just has no animation.
/**
 * Skip one JS string literal starting at `i` (which is its quote). Returns the
 * index of the closing quote, or the end of the text if it never closes.
 *
 * The whole reason the walkers below are walkers and not regexes: a config
 * carrying `{ alt: "Acme (Inc)" }` or `{ title: "a } b" }` closes nothing, and
 * a regex counting brackets reads both as structure. `cli/audit.mjs` learned
 * this first (isBootCall); this is the same rule applied to the object.
 */
function skipString(text, i) {
  const q = text[i];
  for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
  return i;
}

/**
 * Skip one JS comment starting at `i` (which is its `/`). Returns the index of
 * the comment's last character, or `i` unchanged when this `/` is not a
 * comment at all (division, a lone slash in whatever).
 *
 * The walkers below skip strings and skipped nothing else — so a deck whose
 * boot call carried a commented-out earlier track (`// narration: { files:
 * 'old' }` — exactly what an author leaves behind) had that key
 * FOUND, the splice landed inside the comment, and the UI said ✓ while the
 * deck played nothing. An unbalanced `)` in a comment likewise ended
 * initArgument's span early, and a splice into a truncated span corrupts the
 * file rather than missing it.
 */
function skipComment(text, i) {
  if (text[i] !== '/') return i;
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i + 2);
    return nl === -1 ? text.length : nl;
  }
  if (text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 1;
  }
  return i;
}

/**
 * The `Decklight.init(…)` argument in `html`: where it starts and ends.
 *
 * Located through the same classifier `audit` and `upgrade` use, so all three
 * agree on which `<script>` is the boot call rather than each finding its own.
 * Returns null when the deck has no boot call at all.
 */
export function initArgument(html) {
  const boot = classifyScripts(html).find((b) => b.kind === 'boot');
  if (!boot) return null;
  const inner = html.slice(boot.start, boot.end);
  const m = /Decklight\s*\.\s*init\s*\(/.exec(inner);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(inner, i); continue; }
    if (c === '/') { const j = skipComment(inner, i); if (j !== i) { i = j; continue; } }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      return { start: boot.start + open + 1, end: boot.start + i };
    }
  }
  return null;
}

/**
 * Where a TOP-LEVEL key's value sits inside an object literal, or null.
 *
 * Depth-aware and string-aware: a `narration:` nested inside `character: {…}`
 * is not this object's key, and `{ note: "narration: off" }` is not a key at
 * all. Both are things a plausible deck contains.
 */
function objectKey(obj, key) {
  const re = new RegExp(`^${key}\\s*:`);
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(obj, i); continue; }
    if (c === '/') { const j = skipComment(obj, i); if (j !== i) { i = j; continue; } }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (depth !== 1) continue;
    // The boundary is checked against the PREVIOUS character, not folded into
    // the regex: `^` matches the start of every slice, so the old
    // `(^|[{,\\s])` form let `mynarration:` match at its own `n`.
    if (i > 0 && !/[{,\s]/.test(obj[i - 1])) continue;
    const m = re.exec(obj.slice(i, i + key.length + 2));
    if (!m) continue;
    // the value runs to the comma or closing brace at THIS depth
    let j = i + m[0].length;
    let d = 0;
    for (; j < obj.length; j++) {
      const v = obj[j];
      if (v === '"' || v === "'" || v === '`') { j = skipString(obj, j); continue; }
      if (v === '/') { const k2 = skipComment(obj, j); if (k2 !== j) { j = k2; continue; } }
      if (v === '{' || v === '[' || v === '(') d++;
      else if (v === '}' || v === ']' || v === ')') { if (d === 0) break; d--; }
      else if (v === ',' && d === 0) break;
    }
    return { from: i, to: j, valueFrom: i + m[0].length };
  }
  return null;
}

/**
 * The span of each top-level element of an array literal, `[` … `]` included
 * in the input. String- and depth-aware for the same reason everything else
 * here is: `[{ label: 'a, b' }]` is one element, not two.
 */
function arrayEntries(arr) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(arr, i); continue; }
    if (c === '/') { const j = skipComment(arr, i); if (j !== i) { i = j; continue; } }
    if (c === '{' || c === '[' || c === '(') {
      if (depth === 1 && start === -1) start = i;
      depth++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 1 && start !== -1) { out.push({ from: start, to: i + 1 }); start = -1; }
      continue;
    }
    if (depth === 1 && start === -1 && !/[\s,]/.test(c)) start = i;
    if (depth === 1 && start !== -1 && c === ',') { out.push({ from: start, to: i }); start = -1; }
  }
  if (start !== -1) out.push({ from: start, to: arr.lastIndexOf(']') });
  return out;
}

/** `{ files: 'voiceover', ext: 'wav', segments: true }`, as a person writes it. */
export function narrationLiteral(cfg) {
  const parts = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}: ${typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : v}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Point the deck's own config at a track that was just recorded.
 *
 * The recorder writes the files and then had to ask you to paste a config line
 * into the deck by hand — the one manual step in a flow that is otherwise a
 * key and an arrow. The author server already owns this file (it writes notes,
 * layouts and element edits), so it can write this too, through the same
 * applyEdit door: Z undoes it, live-reload shows it.
 *
 * Returns the new HTML, or **null when the config is not a literal at the call
 * site** — `const cfg = {…}; Decklight.init(cfg)` has nothing here to edit, and
 * guessing which `cfg` is meant, in which scope, is how an editor corrupts a
 * file. That deck keeps the printed line and is told why.
 */
/** `{ label: 'Rachel · ElevenLabs', dir: 'voices/rachel', ext: 'wav' }` */
export function trackLiteral(track) {
  return narrationLiteral(track);
}

/**
 * Add a recorded track to the deck's `narration.files`, or update it in place.
 *
 * ADD, not replace. A deck can carry as many tracks as you have voices — four
 * cloned ones, the system voice, two takes of your own — and `N` is the
 * switcher. Replacing the key (which is what this did when it only knew how to
 * write one) threw the others away the first time somebody recorded a second
 * voice, which is exactly when a multi-track deck exists.
 *
 * A track already listed under the same `dir` is UPDATED rather than added
 * twice: re-recording into a folder should refresh what the deck says about
 * it, not leave the picker showing the same folder twice.
 *
 * The one-string form (`files: 'voiceover'`, with `ext`/`segments` beside it)
 * becomes a one-element list carrying those same keys — the shape
 * `narrationTracks()` already normalises it to internally, so the deck plays
 * identically before and after.
 *
 * Returns the new HTML, or null when there is no literal here to edit.
 */
export function upsertNarrationTrack(html, track) {
  const arg = initArgument(html);
  if (!arg) return null;
  const raw = html.slice(arg.start, arg.end);
  const splice = (from, to, text) => html.slice(0, from) + text + html.slice(to);
  const one = narrationLiteral(track);

  // no config object at the call site at all
  if (!raw.trim()) return splice(arg.start, arg.end, `{ narration: { files: [${one}] } }`);
  const open = raw.indexOf('{');
  if (open === -1 || raw.slice(0, open).trim()) return null;
  const close = raw.lastIndexOf('}');
  if (close < open) return null;
  const obj = raw.slice(open, close + 1);
  const at = arg.start + open;

  const narr = objectKey(obj, 'narration');
  if (!narr) {
    const inner = obj.slice(1, -1);
    const body = inner.trim()
      ? `{ narration: { files: [${one}] },${inner.replace(/^\s*\n?/, inner.includes('\n') ? '\n' : ' ')}}`
      : `{ narration: { files: [${one}] } }`;
    return splice(at, arg.start + close + 1, body);
  }

  const nval = obj.slice(narr.valueFrom, narr.to).trim();
  const nvalAt = at + narr.valueFrom + (obj.slice(narr.valueFrom, narr.to).length - obj.slice(narr.valueFrom, narr.to).trimStart().length);
  if (!nval.startsWith('{')) return null;   // narration built elsewhere

  const files = objectKey(nval, 'files');
  if (!files) {
    const inner = nval.slice(1, -1);
    const body = inner.trim() ? `{ files: [${one}],${inner.replace(/^\s*/, ' ')}}` : `{ files: [${one}] }`;
    return splice(nvalAt, nvalAt + nval.length, body);
  }

  const fval = nval.slice(files.valueFrom, files.to).trim();
  const fvalStart = nvalAt + nval.indexOf(fval, files.valueFrom);

  // already a list: update the entry naming this folder, else append
  if (fval.startsWith('[')) {
    const entries = arrayEntries(fval);
    const same = entries.find((e) => {
      const m = /\bdir\s*:\s*(['"`])([^'"`]*)\1/.exec(fval.slice(e.from, e.to));
      return m && m[2] === track.dir;
    });
    if (same) return splice(fvalStart + same.from, fvalStart + same.to, one);
    const closeAt = fval.lastIndexOf(']');
    const body = entries.length ? `,\n    ${one}\n  ` : one;
    return splice(fvalStart + closeAt, fvalStart + closeAt, body);
  }

  // the one-string form: carry it across as the first entry, keys and all
  const m = /^(['"`])([^'"`]*)\1$/.exec(fval);
  if (!m) return null;
  const kept = { label: m[2], dir: m[2] };
  for (const k of ['ext', 'segments']) {
    const found = objectKey(nval, k);
    if (!found) continue;
    const v = nval.slice(found.valueFrom, found.to).trim();
    kept[k] = v === 'true' ? true : v === 'false' ? false : v.replace(/^['"`]|['"`]$/g, '');
  }
  const list = kept.dir === track.dir ? [one] : [narrationLiteral(kept), one];
  // the sibling ext/segments moved INTO the entry they described, so they must
  // not stay behind saying it about every track
  const rest = [];
  for (const [k, span] of ['liveUrl', 'character', 'engine', 'voice', 'style']
    .map((k) => [k, objectKey(nval, k)]).filter(([, v]) => v)) {
    rest.push(nval.slice(span.from, span.to).trim().replace(/,$/, ''));
  }
  const body = `{ files: [\n    ${list.join(',\n    ')}\n  ]${rest.length ? `, ${rest.join(', ')}` : ''} }`;
  return splice(nvalAt, nvalAt + nval.length, body);
}

export function setNarrationConfig(html, cfg) {
  const arg = initArgument(html);
  if (!arg) return null;
  const raw = html.slice(arg.start, arg.end);
  const literal = narrationLiteral(cfg);
  const splice = (from, to, text) => html.slice(0, from) + text + html.slice(to);

  // `Decklight.init()` — nothing passed at all
  if (!raw.trim()) return splice(arg.start, arg.end, `{ narration: ${literal} }`);
  // anything that is not an object literal: an identifier, a call, a spread of
  // something declared elsewhere. Not ours to rewrite.
  const open = raw.indexOf('{');
  if (open === -1 || raw.slice(0, open).trim()) return null;
  const close = raw.lastIndexOf('}');
  if (close < open) return null;

  const obj = raw.slice(open, close + 1);
  const found = objectKey(obj, 'narration');
  if (found) {
    return splice(arg.start + open + found.valueFrom, arg.start + open + found.to, ` ${literal}`);
  }
  // no narration key yet — add one, keeping whatever else is configured
  const inner = obj.slice(1, -1);
  const body = inner.trim()
    ? `{ narration: ${literal},${inner.replace(/^\s*\n?/, inner.includes('\n') ? '\n' : ' ')}}`
    : `{ narration: ${literal} }`;
  return splice(arg.start + open, arg.start + close + 1, body);
}

export const BUILD_EFFECTS = ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight', 'none'];

/**
 * Set slide N's element `index`'s build/entrance effect, or — when `effect`
 * is `null` — strip `data-build` entirely (the menu's separate "remove
 * effect" action).
 */
export function setSlideElementBuild(html, slide, index, effect) {
  if (effect !== null && !BUILD_EFFECTS.includes(effect)) throw new Error(`unknown build effect "${effect}"`);
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  const el = seg.slice(r.start, r.end);
  const gt = el.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed element at index ${index}`);
  let head = el.slice(0, gt).replace(/\s+data-build=("[^"]*"|'[^']*')/, '');
  if (effect !== null) head += ` data-build="${effect}"`;
  parts[idx] = seg.slice(0, r.start) + head + el.slice(gt) + seg.slice(r.end);
  return parts.join('');
}

/**
 * The edit history: whole-file snapshots, in memory, capped. record() the
 * content a mutation is about to replace; undo()/redo() take the CURRENT
 * file content (which may include edits made outside the server — those
 * land on the opposite stack, so nothing is silently lost) and return what
 * to write, or null when the stack is empty.
 */
export function createHistory(limit = 200) {
  const past = [];
  const future = [];
  return {
    record(before) {
      past.push(before);
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      future.push(current);
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(current);
      return future.pop();
    },
    counts() { return { undo: past.length, redo: future.length }; },
  };
}

// ── git: the durable record (the history above is the fast loop) ──────────
// The plumbing lives in git.mjs now; imported for editMain's use below and
// re-exported so long-standing importers (init, the tests) keep finding it
// where edit grew it.
import { inGitRepo, createRepo, STARTER_GITIGNORE, gitAutocommit, lastCommitSha, resolveGitMode, shouldCommit, commitSubject, exitPushLine, oneline, remoteLine, remoteState, unpushed } from './git.mjs';
import { describeCommit, messagesLine } from './commit-message.mjs';
export { inGitRepo, createRepo, STARTER_GITIGNORE, gitAutocommit };

/** Who the author is, from git's own answer — see cli/review.mjs. */
function reviewerName(cwd = process.cwd()) {
  const cfg = (key) => {
    try { return execFileSync('git', ['config', key], { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
  };
  const name = cfg('user.name');
  const email = cfg('user.email');
  return (name && email) ? `${name} <${email}>` : (name || email || '');
}

export async function editMain(args, { onListen = null } = {}) {
  // /edit/review/incoming's answer, briefly remembered (see the route).
  let incomingCache = null;
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    console.log(`usage: node cli/edit.mjs <deck.html> [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>] [--commit-messages]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (right-click a slide's background), per-slide layout (L/⇧L),
  element edit mode (E, then right-click an element), undo/redo (Z/⇧Z), agent asks (A)
  a taken --port offers to take over that session (on a TTY) or moves on to
  the next free one
  --git            auto-commit the deck on a regular basis (creates the repo if needed)
  --no-git         never touch git (default outside a repository)
  --commit-every N autocommit cadence in seconds (timer mode)             [300]
  --git-mode M     when to commit: timer (a cadence), agent (one commit per
                   agent edit, with the agent's own message), off      [timer]
  --agent <name>   preferred AI agent for A (default: first one detected)
  the server binds 127.0.0.1 only; for a phone remote use decklight present`);
    return;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8788));
  // Refused out loud, not ignored (PRESENT#REMOTE). Someone typing --remote
  // wants a clicker; silently binding loopback would leave them holding a phone
  // that never connects and no idea why. `present` is where the remote went,
  // and the reason it went is worth saying at the moment it is asked for.
  const gone = ['--remote', '--host'].filter((f) => args.some((a) => a === f || a.startsWith(f + '=')));
  if (gone.length) {
    console.error(`author no longer takes ${gone.join(' or ')} — the phone remote moved to \`decklight present\`.`);
    console.error('  A clicker used to cost you an editing server on the LAN: /edit/notes, /edit/layout and');
    console.error('  /edit/agent were reachable from the same run you were not watching. present has no edit');
    console.error('  surface to widen, so that is where it lives.');
    console.error(`\n  decklight present ${firstPositional(args, ['--port', '--commit-every', '--agent']) ?? '<deck.html>'} --remote`);
    process.exitCode = 2;
    return;
  }
  const host = '127.0.0.1';
  const root = process.cwd();
  const deckPath = resolve(root, firstPositional(args, ['--port', '--commit-every', '--agent']));
  if (!existsSync(deckPath)) { console.error(`deck not found: ${deckPath}`); process.exitCode = 1; return; }
  if (!deckPath.startsWith(root + sep)) { console.error('deck must live under the current directory'); process.exitCode = 1; return; }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');
  const deckRel = deckUrl.slice(1);

  const history = createHistory();
  const readDeck = () => readFileSync(deckPath, 'utf8');
  // one door for every mutation: snapshot, then write — so Z always works
  const applyEdit = (next, before = readDeck()) => {
    if (next === before) return false;
    history.record(before);
    writeFileSync(deckPath, next);
    return true;
  };

  // Declared before the git block below, which reads it to hold the cadence
  // back while a job is in flight.
  let agentJob = null; // { name, prompt, startedAt } — strictly one at a time

  // ── git autocommit — the durable record, independent of undo/redo ──────
  const noGit = args.includes('--no-git');
  const wantGit = args.includes('--git');
  const commitEvery = Math.max(5, Number(opt('--commit-every', 300)) || 300);
  // --commit-messages: an agent writes the subject decklight would otherwise
  // template. Opt-in, because it sends the deck's diffs to whichever agent CLI
  // is installed and most of them are cloud-backed — a permission decklight
  // does not infer from what happens to be on PATH.
  const wantMessages = args.includes('--commit-messages');

  /**
   * Every commit decklight authors ITSELF goes through here — the cadence, the
   * session bookends, the save that clears the way before an agent edit.
   *
   * One funnel, because the amend has to happen right after the commit while
   * the sha is still the tip, and a second call site that forgot to ask would
   * silently be the one that keeps saying "autosave". Commits made from an
   * AGENT'S OWN message do not come through here: they already say what
   * happened, and asking an agent to rewrite an agent's sentence is a call
   * that buys nothing.
   *
   * The describe is deliberately unawaited. The commit has landed by the time
   * this returns, which is the whole contract of autocommit — the subject is
   * an improvement that arrives late or not at all.
   */
  function ownCommit(message) {
    const made = message === undefined
      ? gitAutocommit(deckPath, root)
      : gitAutocommit(deckPath, root, message);
    if (!made) return false;
    const sha = lastCommitSha;
    if (wantMessages && sha) {
      const template = message ?? `decklight: autosave ${basename(deckPath)}`;
      describeCommit({ cwd: root, sha, deckPath, template, agent: agentPref })
        .then((subject) => { if (subject) console.log(`  git: subject → "${subject}"`); })
        .catch(() => { /* the commit stands; the wording was the optional part */ });
    }
    return true;
  }
  // timer (default, unchanged) · agent (one commit per agent edit) · off
  const gitMode = resolveGitMode(args);
  let gitOn = false;
  if (!noGit && (wantGit || inGitRepo(root))) {
    if (!inGitRepo(root)) {
      try {
        const wroteIgnore = createRepo(root);
        console.log(`  git: initialized a repository in ${root}${wroteIgnore ? ' (with a starter .gitignore)' : ''}`);
      } catch (e) {
        console.error(`  git init failed: ${String(e.stderr || e.message || e).slice(0, 160)}`);
      }
    }
    if (inGitRepo(root)) {
      gitOn = true;
      ownCommit(`decklight: start editing ${basename(deckPath)}`);
      // The cadence is the backstop, and it runs in agent mode too: an agent
      // job only ever sees edits IT made, so hand edits — and any agent driven
      // from outside the A flow — would otherwise reach git only via the
      // Ctrl-C bookend, which a crash skips. It is held back while a job is in
      // flight so nothing commits a half-finished agent run.
      setInterval(() => {
        if (shouldCommit(gitMode, { kind: 'timer', agentBusy: !!agentJob })) ownCommit();
      }, commitEvery * 1000).unref();
      console.log(gitMode === 'agent'
        ? `  git: committing ${deckRel} once per agent edit with the agent's own message, every ${commitEvery}s otherwise (and on Ctrl-C)`
        : `  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`);
    }
  }
  const finalCommit = () => {
    if (!gitOn) return;
    // Not ownCommit: this runs inside the SIGINT handler and the process exits
    // immediately after, so there is no later for an amend to arrive in. The
    // bookend keeps its literal subject, which is true anyway.
    gitAutocommit(deckPath, root, `decklight: stop editing ${basename(deckPath)}`);
    // The last moment anyone is looking. Synchronous and fetch-free on purpose:
    // this runs inside the SIGINT handler, and a network call there would hang
    // a Ctrl-C — the worst possible place to hang.
    try {
      const line = exitPushLine(remoteState(root));
      if (line) console.log(line);
    } catch { /* a reminder is never worth failing an exit over */ }
  };
  process.on('SIGINT', () => { finalCommit(); process.exit(0); });
  process.on('SIGTERM', () => { finalCommit(); process.exit(0); });

  // ── AI agents — one-shot editing tasks from the player (A) ─────────────
  // Precedence, like every other saved choice: the flag wins, then what was
  // remembered (#125), then the first detected agent.
  let agentPref = opt('--agent') ?? preferredAgent();
  const agents = detectAgents();
  if (agents.length) {
    const mark = (a) => a.name + (a.name === agentPref ? ' (preferred)' : '') + (a.installed ? ' (installed)' : '');
    console.log(`  agents: ${agents.map(mark).join(', ')} — “Ask agent” (A) is live`);
  }
  // A remembered agent that is not on this machine is said ONCE, at startup,
  // rather than discovered at the moment someone presses A mid-talk.
  if (agentPref && !agents.some((a) => a.name === agentPref)) {
    console.log(`  agent: ${agentUnavailable(agentPref, agents)}`);
  }
  // Said out loud, every session it is on: this is the switch that starts
  // sending the deck somewhere, and a capability nobody is reminded of is one
  // they stop counting on being off. Printed HERE rather than up with the other
  // git lines because it names the agent, and the roster is only resolved now.
  if (gitOn && wantMessages) {
    const who = agents.find((a) => a.name === agentPref) ?? agents[0];
    console.log(`  ${messagesLine(who?.name ?? null)}`);
  }

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  const clients = sseChannel();
  const broadcast = (event, data) => clients.broadcast(event, data);

  // ── the catalogs, read from cache and never fetched ──────────────────────
  const catalogMap = async () => {
    const { loadRegistry, loadCatalog } = await import('./marketplace.mjs');
    const out = {};
    for (const name of Object.keys(loadRegistry().marketplaces ?? {})) {
      const loaded = loadCatalog(name);
      if (loaded?.ok) out[name] = loaded.manifest;
    }
    return out;
  };
  /** Every theme entry a registered marketplace offers, qualified. */
  const browsableThemes = async () => {
    const { loadRegistry, loadCatalog, checkoutPath, classifySource, configHome } = await import('./marketplace.mjs');
    const registry = loadRegistry().marketplaces ?? {};
    const themes = [];
    // Registered-but-never-fetched is the FIRST-RUN state, not an error — the
    // first-party marketplace is deliberately in it — so it is reported as
    // something the presenter can act on (`marketplace update <name>`) rather
    // than as an empty list that looks like an empty marketplace.
    const stale = [];
    for (const [market, m] of Object.entries(registry)) {
      const loaded = loadCatalog(market);
      if (!loaded) { stale.push(market); continue; }
      if (!loaded.ok) { stale.push(market); continue; }
      // A cached catalog whose FILES are not on disk is the same actionable
      // state wearing a different face: since MARKETPLACES#CLONE an entry
      // installs from the marketplace's checkout, so listing its themes would
      // be offering rows that can only fail. `marketplace update` fixes both.
      if (classifySource(m.source ?? '').kind !== 'local' && !existsSync(checkoutPath(configHome(), market))) {
        stale.push(market);
        continue;
      }
      for (const e of loaded.manifest.entries ?? []) {
        if (e.type !== 'theme') continue;
        themes.push({
          name: e.name, marketplace: market, qualified: `${e.name}@${market}`,
          description: e.description ?? '', source: e.source,
        });
      }
    }
    return { themes, stale };
  };
  /**
   * Every entry a registered marketplace declares a wizard for, qualified.
   * Advertised in /edit/ping beside the agents: the palette's Configure rows
   * come from here, so a player never has to guess an engine name to ask
   * /edit/wizard about (ENGINES#WIZARD).
   */
  const configurableEngines = async () => {
    const { loadRegistry, loadCatalog } = await import('./marketplace.mjs');
    const engines = [];
    for (const market of Object.keys(loadRegistry().marketplaces ?? {})) {
      const loaded = loadCatalog(market);
      if (!loaded?.ok) continue;
      for (const e of loaded.manifest.entries ?? []) {
        if (!e.wizard) continue;
        // The title is display-only; a malformed schema still gets listed, so
        // opening it surfaces validateSchema's refusal instead of silence.
        engines.push({
          name: e.name, qualified: `${e.name}@${market}`,
          title: typeof e.wizard.title === 'string' ? e.wizard.title : e.name,
        });
      }
    }
    return engines;
  };

  // ── the engine wizard: where a schema comes from, and who checks answers ─
  // Both injected into configureEngine rather than reached for inside it: this
  // server knows how catalogs are read, and cli/wizard.mjs has no business
  // knowing — which is also what lets the framework be tested without a
  // network or a real key.
  const wizardEntry = async (engine) => {
    const { resolveEntry, MarketplaceError } = await import('./marketplace.mjs');
    // resolveEntry is the seam every install surface goes through — its docblock
    // names the engine wizard as one of them — so `elevenlabs@voices` works, and
    // a bare name that exists in two marketplaces is reported as ambiguous
    // rather than silently resolved to whichever was registered first.
    // loadCatalog returns the VALIDATION result, not the manifest — a cached
    // catalog that no longer validates has no entries to offer, which is the
    // right answer rather than a crash. catalogMap does that unwrapping once.
    try {
      const hit = resolveEntry(engine, await catalogMap());
      // The whole hit, not just the entry: `qualified` is what the wizard's
      // provenance line shows as the asker (#232), and it has to come from the
      // registry rather than from anything the schema itself declares.
      return hit.entry.wizard ? hit : null;
    } catch (e) {
      if (e instanceof MarketplaceError) return null;
      throw e;
    }
  };
  const wizardSchemaFor = async (engine) => {
    const hit = await wizardEntry(engine);
    if (!hit) throw new Error(`no wizard declared for "${engine}" in any registered marketplace`);
    return hit.entry.wizard;
  };
  /**
   * Ask the engine's own bridge whether the answers work.
   *
   * The plugin declares a PATH, never an origin — a schema that could name where
   * to send a freshly pasted key would be a credential exfiltration primitive
   * with a config file for a delivery mechanism. So the origin is this machine,
   * and the plugin only chooses the path on it.
   */
  const wizardValidate = async (schema, answers) => {
    if (!schema.validate) return true;
    // BRIDGE_ADDR is shared with provenance() so the destination the player
    // showed the presenter and the one this line posts to cannot drift apart.
    const r = await fetch(`http://${BRIDGE_ADDR}${schema.validate}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: schema.engine, answers }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j?.ok === true;
  };

  let pending = null;
  watch(deckPath, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      clients.raw('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  function runAgent(prompt, name, message) {
    const cmd = agentCommand(name || agentPref, prompt, deckRel);
    if (!cmd) return null;
    // Anything uncommitted at this moment is the PLAYER's work, not the
    // agent's. Sweeping it into its own commit first is what keeps the agent's
    // commit honest: otherwise a hand edit made just before pressing A lands
    // under the agent's message, and a history that misattributes authorship is
    // worse than one that only says "autosave".
    if (gitOn && shouldCommit(gitMode, { kind: 'bookend' })
        && ownCommit(`decklight: save before ${cmd.name} edits ${basename(deckPath)}`)) {
      console.log('  git: committed your outstanding changes first');
    }
    const before = readDeck();
    agentJob = { agent: cmd.name, label: cmd.label, prompt, startedAt: Date.now() };
    broadcast('agent', { state: 'start', ...agentJob });
    console.log(`  agent: ${cmd.name} ← "${prompt.slice(0, 80)}"`);
    const child = spawn(cmd.bin, cmd.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timeout);
      agentJob = null;
      broadcast('agent', { state: 'done', agent: cmd.name, ok: false, changed: false, error: String(e.message || e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const after = readDeck();
      const changed = after !== before;
      if (changed) history.record(before); // Z takes the agent's edit back
      // One commit per completed agent edit, carrying the agent's own summary
      // — the boundary and the message both come from the work, not a clock.
      // A failed run or one that changed nothing commits nothing.
      if (gitOn && shouldCommit(gitMode, { kind: 'agent', ok: code === 0, changed })) {
        const subject = commitSubject(message ?? prompt, `decklight: ${cmd.name} edited ${basename(deckPath)}`);
        if (gitAutocommit(deckPath, root, subject)) console.log(`  git: committed "${subject}"`);
      }
      agentJob = null;
      broadcast('agent', {
        state: 'done', agent: cmd.name, ok: code === 0, changed, code,
        tail: tail.trim().split('\n').slice(-6).join('\n').slice(-600),
      });
      console.log(`  agent: ${cmd.name} exited (${code}) — deck ${changed ? 'changed' : 'unchanged'}`);
    });
    return cmd;
  }

  const files = staticFiles(root, { index: deckUrl });
  const server = createServer(async (req, res) => {
    // The CSRF gate (#222), before anything runs. A same-machine browser tab is
    // the threat, not an off-machine caller, so the check is the request's
    // `Origin`, not its socket address. A foreign origin is refused here —
    // before the body is read, before any file is written, before an agent is
    // spawned — and refused WITHOUT permissive CORS, so the page cannot even
    // read the refusal. Loopback origins, `null` (file://), and the header's
    // absence (the CLI, the port-conflict probe, curl) pass.
    const origin = req.headers.origin;
    const CORS = corsHeadersFor(origin);
    if (!allowEditRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden: the author edit surface answers this machine only, and not a foreign web origin');
      return;
    }
    try {
      const url = new URL(req.url, 'http://x');
      const json = (code, obj) => {
        res.writeHead(code, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/edit/ping') {
        return json(200, {
          ok: true, deck: deckUrl, name: basename(deckPath),
          ...history.counts(), git: gitOn,
          // What the player's one push nudge reads. Computed once, like everything
          // else on ping: the toast is threshold-driven, not live.
          remote: gitOn ? remoteState(root) : null,
          agents: agents.map((a) => ({ name: a.name, label: a.label })),
          // which one A reaches for, so the picker opens on it rather than
          // defaulting to the first detected agent every session (#125)
          preferredAgent: agentPref ?? null,
          agentBusy: agentJob && { agent: agentJob.agent, prompt: agentJob.prompt, startedAt: agentJob.startedAt },
          wizards: await configurableEngines(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/edit/events') {
        clients.add(req, res, CORS);
        return;
      }
      // ── the deck's durable history (#129): what the R overlay reads ────
      // Loopback-only like every other /edit/* path: this serves arbitrary
      // historical revisions of the deck, which is nobody else's business.
      if (req.method === 'GET' && url.pathname === '/edit/history') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session — there is no history' });
        try {
          // One round trip serves the whole overlay: the commits, which of them
          // exist nowhere but this machine, and where the branch stands. All of
          // it is a LOCAL read — `unpushed` and `@{u}` read remote-tracking
          // refs, so opening the history never touches the network (SPEC
          // PRESENTING).
          // `slides` is what that version WAS, `add`/`del` what it CHANGED —
          // the two questions a hash and a subject cannot answer, and the ones
          // that tell "tightened the wording" apart from "cut four slides"
          // before you restore it rather than after.
          const entries = decorateHistory(deckHistory(deckPath, root), deckPath, root);
          const remote = remoteState(root);
          // `pushed` is null for "not a question worth answering here", and the
          // two cases are different: git could not tell us, or there is no
          // remote at all — in which case EVERY commit is unpushed and marking
          // all of them is a wall of arrows saying what the footer says once.
          const local = ['no-remote', 'ambiguous-remote'].includes(remote.state) ? null : unpushed(root);
          const set = local ? new Set(local) : null;
          for (const e of entries) e.pushed = set ? !set.has(e.full) : null;
          // The LINE is computed here, not in the player: cli/git.mjs is Node
          // (it spawns git), the runtime has zero dependencies and cannot
          // import it, and duplicating the wording in the browser is how the
          // four places that talk about unpushed work start disagreeing.
          return json(200, { ok: true, entries, remote: { ...remote, line: remoteLine(remote) } });
        } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
      }
      if (req.method === 'GET' && url.pathname === '/edit/at') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        try {
          // <base href="/"> because this is served from /edit/, not the root:
          // without it every relative ../dist and ./casts path in the deck
          // would resolve one directory too deep and the preview would be bare.
          const html = withBaseHref(deckAt(deckPath, url.searchParams.get('ref') || '', root));
          res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(html);
        } catch {
          res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
          return res.end('no such revision of this deck');
        }
      }
      // ── element edit mode (E, right-click a slide element) — #112 ─────
      // Reads the element's outerHTML fresh from the FILE, never the live
      // DOM: the engine mutates elements in place (pinned-title classes,
      // namespaced SVG ids, chart/code/math subtree replacement), so the DOM
      // the player sees is not what a Save should write back over.
      if (req.method === 'GET' && url.pathname === '/edit/element/source') {
        const slide = Number(url.searchParams.get('slide'));
        const index = Number(url.searchParams.get('index'));
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) {
          return json(400, { ok: false, error: 'bad payload' });
        }
        try {
          const { parts, idx, r } = locateElement(readDeck(), slide, index);
          return json(200, { ok: true, html: parts[idx].slice(r.start, r.end) });
        } catch (e) {
          return json(404, { ok: false, error: oneline(e) });
        }
      }

      if (req.method === 'POST' && url.pathname === '/edit/shutdown') {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // same shutdown a Ctrl-C takes — final autocommit, then actually exit —
        // once the response has cleared the socket, so the asker sees it land
        res.once('finish', () => { finalCommit(); process.exit(0); });
        return;
      }
      if (req.method === 'POST' && /^\/edit\/(undo|redo)$/.test(url.pathname)) {
        const dir = url.pathname.endsWith('undo') ? 'undo' : 'redo';
        const cur = readDeck();
        const content = history[dir](cur);
        if (content === null) return json(409, { ok: false, error: `nothing to ${dir}`, ...history.counts() });
        writeFileSync(deckPath, content);
        console.log(`  ${dir} → ${JSON.stringify(history.counts())}`);
        return json(200, { ok: true, ...history.counts() });
      }
      // ── ⇧V offline recordings (PRESENTING) ───────────────────────────────
      // The player used to hand every stitched slide to the browser's DOWNLOAD
      // path, which is why a deck's voice arrived as thirty slide-NN.wav in
      // whatever folder the OS calls Downloads — never the deck's, and on
      // Windows not even near it. `bundle` only ever looks NEXT TO THE DECK, so
      // the recording was finished and in the wrong place, and the last step
      // was moving files by hand. In author mode the server that already owns
      // the deck file writes them itself.
      //
      // Ahead of the shared body read below because this body is BINARY and
      // megabytes of it: a slide of speech is ~48 kB a second, so the string
      // concat and its 1 MB ceiling would both be wrong.
      if (req.method === 'POST' && url.pathname === '/edit/record') {
        const slide = Number(url.searchParams.get('slide'));
        const kind = url.searchParams.get('kind');
        if (!Number.isInteger(slide) || slide < 1 || slide > 9999) return json(400, { ok: false, error: 'bad slide' });
        if (kind !== 'wav' && kind !== 'visemes') return json(400, { ok: false, error: 'bad kind' });
        // `seg` is the per-⟨CLICK⟩ file number — the audio that lets a recording
        // step the builds (slide-NN-KK.wav) and the viseme timeline cut to
        // match it (slide-NN-KK.visemes.json). Absent means the whole slide.
        // Bounded and integral like `slide`, and for the same reason: it is
        // half of a filename this server builds, and the only defence that
        // survives someone deciding the name should be more flexible one day.
        const segRaw = url.searchParams.get('seg');
        const seg = segRaw == null ? null : Number(segRaw);
        if (seg !== null && (!Number.isInteger(seg) || seg < 1 || seg > 999)) {
          return json(400, { ok: false, error: 'bad seg' });
        }
        // The player names the FOLDER (its own `narration.files`, so a recorded
        // set lands where that deck already plays from) and nothing else: the
        // file name is built here, so no request can choose one. The folder is
        // contained to the served root by the same rule staticFiles reads by —
        // and `..`, absolute paths and Windows drive letters are refused before
        // it, because `resolve` would happily swallow all three.
        const want = url.searchParams.get('dir') || 'voiceover';
        const bad = want.length > 200 || /^[/\\]/.test(want) || /^[a-zA-Z]:/.test(want)
          || want.split(/[/\\]/).includes('..');
        const dir = bad ? null : resolve(deckPath, '..', want);
        if (!dir || (!dir.startsWith(root + sep) && dir !== root)) {
          return json(400, { ok: false, error: 'the recording folder must sit inside the deck\'s own directory' });
        }
        const name = `slide-${String(slide).padStart(2, '0')}`
          + (seg === null ? '' : `-${String(seg).padStart(2, '0')}`)
          + `.${kind === 'wav' ? 'wav' : 'visemes.json'}`;
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64e6) return json(413, { ok: false, error: 'recording too large' });
          chunks.push(chunk);
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, name), Buffer.concat(chunks));
        } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
        console.log(`  recorded ${want}/${name} (${Math.round(size / 1024)} kB)`);
        return json(200, { ok: true, dir: want, file: name });
      }
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
      }
      // ── review comments (SPEC REVIEW) ─────────────────────────────
      // The author's side of `decklight review`. The same file, the same
      // append-only rule: this server may add a line (a resolve, a reply) and
      // may not rewrite one, because `merge=union` is what keeps two reviewers
      // from conflicting and an edit in place is what would break it.
      if (req.method === 'GET' && url.pathname === '/edit/review') {
        const store = reviewPathFor(deckPath);
        if (!existsSync(store)) return json(200, { ok: true, records: [], skipped: 0 });
        const { records, skipped } = parseReview(readFileSync(store, 'utf8'));
        return json(200, { ok: true, records, skipped });
      }
      // What reviews are waiting on the remote — the M overlay's incoming
      // section. This one is a fetch the author DID ask for: it runs behind
      // the keypress that just opened the overlay, on demand and nowhere else.
      // The 60s cache is what keeps a nervous author tapping M from turning
      // one gesture into a fetch storm; the off switches still win outright.
      if (req.method === 'GET' && url.pathname === '/edit/review/incoming') {
        const skipped = reviewCheckSuppressed({ args });
        if (skipped) return json(200, { ok: true, state: 'suppressed', reason: skipped, reviews: [] });
        if (!incomingCache || Date.now() - incomingCache.at > 60_000) {
          const r = await reviewsWaiting(deckPath);
          incomingCache = { at: Date.now(), r };
        }
        return json(200, { ok: true, ...incomingCache.r });
      }
      // What tracks already sit next to this deck. The runtime cannot see the
      // filesystem — which is why `segments: true` is opt-in at all — so it
      // cannot know that `voices/rachel` is taken before proposing it. One
      // question, asked when a recorder opens.
      if (req.method === 'GET' && url.pathname === '/edit/tracks') {
        const root2 = resolve(deckPath, '..');
        const seen = [];
        const look = (rel) => {
          let entries;
          try { entries = readdirSync(resolve(root2, rel), { withFileTypes: true }); } catch { return; }
          const wav = entries.filter((e) => e.isFile() && /^slide-\d+(-\d+)?\.(wav|m4a|mp3)$/.test(e.name));
          if (wav.length) {
            let engine = null; let voice = null;
            try {
              const m = JSON.parse(readFileSync(resolve(root2, rel, 'manifest.json'), 'utf8'));
              engine = m.engine ?? null; voice = m.voice ?? null;
            } catch { /* a folder recorded by hand has no manifest, and needs none */ }
            seen.push({
              dir: rel.split(sep).join('/'),
              files: wav.length,
              // the beats are what let a track pace the builds, so whether it
              // has them is the one fact worth reporting beside the count
              segments: wav.some((e) => /^slide-\d+-\d+\./.test(e.name)),
              ext: (wav[0].name.split('.').pop()),
              engine,
              voice,
            });
          }
          return entries;
        };
        for (const e of look('.') ?? []) {
          if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
          const kids = look(e.name) ?? [];
          // one more level, because the convention is voices/<voice>
          for (const k of kids) {
            if (k.isDirectory() && !k.name.startsWith('.')) look(`${e.name}${sep}${k.name}`);
          }
        }
        return json(200, { ok: true, tracks: seen });
      }
      // Point the deck at a track the recorder just wrote. The one manual step
      // in a flow that is otherwise a key and an arrow — and this server
      // already owns the file, so it can take that step too.
      if (req.method === 'POST' && url.pathname === '/edit/review') {
        const { op, re, body: text } = JSON.parse(body || '{}');
        if (typeof re !== 'string' || !/^[a-z0-9]{1,12}$/.test(re)) {
          return json(400, { ok: false, error: 'bad comment id' });
        }
        if (op !== 'resolve' && !(typeof text === 'string' && text.trim() && text.length <= 4000)) {
          return json(400, { ok: false, error: 'a reply needs something in it' });
        }
        const store = reviewPathFor(deckPath);
        // A reply is a new statement about the deck and carries which version it
        // was made against, exactly as a comment does. A resolve does not: it is
        // about the comment, not about the slide.
        let at = null;
        try { at = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
        catch { at = null; }
        const rec = op === 'resolve'
          ? { op: 'resolve', re, at: new Date().toISOString(), by: reviewerName() }
          : {
            id: newId(),
            at: new Date().toISOString(),
            by: reviewerName(),
            ...(at ? { deck: at } : {}),
            re,
            body: text,
          };
        try { appendFileSync(store, `${serializeRecord(rec)}\n`); }
        catch (e) { return json(500, { ok: false, error: oneline(e) }); }
        if (gitOn) {
          gitAutocommit(store, root, op === 'resolve'
            ? commitSubject(`review: resolve ${re}`, 'review: resolve a comment')
            : commitSubject(`review: reply to ${re}`, 'review: a reply'));
        }
        console.log(`  review: ${op === 'resolve' ? `resolved ${re}` : `replied to ${re}`}`);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/edit/narration') {
        const { files, ext, segments } = JSON.parse(body || '{}');
        // The same three shapes /edit/record refuses for a folder, refused
        // again here: this one is written INTO the deck, where a bad value is
        // not a failed request but a deck that no longer plays.
        if (typeof files !== 'string' || !files.trim() || files.length > 200
            || /^[/\\]/.test(files) || /^[a-zA-Z]:/.test(files)
            || files.split(/[/\\]/).includes('..')) {
          return json(400, { ok: false, error: 'bad narration folder' });
        }
        if (ext !== undefined && !/^[a-z0-9]{1,5}$/.test(String(ext))) {
          return json(400, { ok: false, error: 'bad ext' });
        }
        if (segments !== undefined && typeof segments !== 'boolean') {
          return json(400, { ok: false, error: 'bad segments' });
        }
        const { label } = JSON.parse(body || '{}');
        if (label !== undefined && (typeof label !== 'string' || label.length > 120)) {
          return json(400, { ok: false, error: 'bad label' });
        }
        // upsert, never replace: a deck carries as many tracks as you have
        // voices, and writing one must not throw the others away
        const next = upsertNarrationTrack(readDeck(), {
          label: label || files.trim(),
          dir: files.trim(),
          ...(ext === undefined ? {} : { ext }),
          ...(segments === undefined ? {} : { segments }),
        });
        if (next === null) {
          // Not a failure of this server — a deck whose config is built
          // somewhere else. Say which, so the answer is "paste this line",
          // not "it did not work".
          return json(409, { ok: false,
            error: 'this deck builds its config outside the Decklight.init(…) call, so there is no literal here to edit' });
        }
        const changed = applyEdit(next);
        if (changed) console.log(`  narration: ${files} in the deck's config`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/restore') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        const { ref } = JSON.parse(body || '{}');
        if (typeof ref !== 'string' || !ref.trim()) throw new Error('bad payload');
        const before = readDeck();
        let result;
        try { result = restoreDeck(deckPath, ref.trim(), root); }
        catch (e) { return json(400, { ok: false, error: oneline(e) }); }
        // Z takes a restore back like any other edit — the git-level move and
        // the keystroke-level stack stay in step rather than disagreeing.
        if (result.changed) history.record(before);
        console.log(`  restored ${basename(deckPath)} to ${result.short}`);
        return json(200, { ok: true, ...result, ...history.counts() });
      }
      // An intermediate commit point: a multi-step agent calls this when IT
      // decides one logical change is finished, so the boundaries follow the
      // work instead of a clock. The message is the agent's, and untrusted.
      if (req.method === 'POST' && url.pathname === '/edit/commit') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        const { message } = JSON.parse(body || '{}');
        const subject = commitSubject(message, `decklight: autosave ${basename(deckPath)}`);
        const committed = gitAutocommit(deckPath, root, subject);
        if (committed) console.log(`  git: committed "${subject}"`);
        return json(200, { ok: true, committed, subject });
      }
      // ── theme Browse (THEME_BROWSE#UI) ─────────────────────────────────
      // What the picker's Browse entry lists. Cache-only by construction: this
      // reads the catalogs `marketplace update` already fetched and never
      // fetches one itself, so a deck on a plane lists what it has and says so
      // rather than hanging on a network that is not there.
      if (req.method === 'GET' && url.pathname === '/edit/theme/browse') {
        const { themes, stale } = await browsableThemes();
        return json(200, { ok: true, themes, stale, cacheOnly: true });
      }
      // Installing goes through `theme add`'s own functions — validation, the
      // WCAG gates, the block shape — so a theme refused on the command line is
      // refused here, by the same code, for the same reason.
      if (req.method === 'POST' && url.pathname === '/edit/theme/add') {
        const { ref, name: asName } = JSON.parse(body || '{}');
        if (typeof ref !== 'string' || !ref.trim()) return json(400, { ok: false, error: 'which theme?' });
        const { resolveEntry, MarketplaceError } = await import('./marketplace.mjs');
        const { fetchTheme, installTheme, resolveSource } = await import('./theme.mjs');
        const { validateTheme, themeNameFrom, validThemeName } = await import('../tools/theme-check.mjs');

        let hit;
        try { hit = resolveEntry(ref.trim(), await catalogMap()); }
        catch (e) {
          if (e instanceof MarketplaceError) return json(404, { ok: false, error: e.message });
          throw e;
        }
        if (hit.entry.type !== 'theme') {
          return json(400, { ok: false, error: `"${hit.qualified}" is a ${hit.entry.type}, not a theme` });
        }
        const name = asName || hit.entry.name;
        if (!validThemeName(name)) return json(400, { ok: false, error: `not a usable theme name: "${name}"` });

        // A manifest's `source` is relative to its MARKETPLACE, not to whoever
        // is installing — resolveSource is where that is worked out, and it lives
        // in theme.mjs because fetching an artifact and fetching a catalog are
        // different permissions on this path.
        const { loadRegistry } = await import('./marketplace.mjs');
        const market = loadRegistry().marketplaces?.[hit.marketplace];
        let src;
        try { src = resolveSource(hit.entry.source, { name: hit.marketplace, source: market?.source }); }
        catch (e) {
          if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
          throw e;
        }
        let css;
        try { css = await fetchTheme(src); }
        catch (e) { return json(502, { ok: false, error: `could not read ${src}: ${oneline(e)}` }); }

        const check = validateTheme(css);
        if (!check.ok) {
          // The deck is left byte-for-byte unchanged: a picker that could leave
          // a deck carrying a broken theme would be worse than no picker.
          return json(400, { ok: false, error: `${name} fails the theme contract`, problems: check.errors ?? [] });
        }
        const before = readDeck();
        const out = installTheme(before, name, css);
        if (!out.html) return json(500, { ok: false, error: 'the deck has no </head> to install into' });
        history.record(before);   // Z takes an install back like any other edit
        writeFileSync(deckPath, out.html);
        console.log(`  theme: ${out.replaced ? 'replaced' : 'installed'} ${name} from ${hit.qualified}`);
        return json(200, { ok: true, name, from: hit.qualified, replaced: out.replaced, ...history.counts() });
      }
      // ── the engine wizard (ENGINES#WIZARD) ─────────────────────────────
      // The schema the player renders. Validated on the way OUT as well as on
      // the way in: a catalog is a file someone else wrote, and handing the
      // renderer a schema core has not vetted is how "core renders, a plugin
      // declares" becomes "core renders whatever a plugin sent".
      if (req.method === 'GET' && url.pathname === '/edit/wizard') {
        const engine = url.searchParams.get('engine') ?? '';
        const hit = await wizardEntry(engine);
        if (!hit) return json(404, { ok: false, error: `no wizard declared for "${engine}"` });
        try {
          const schema = validateSchema(hit.entry.wizard);
          // Provenance rides BESIDE the schema, never inside it (#232): `from`
          // is the registry's name for the entry and the sentence pair is
          // derived here from the vetted schema, so the card can say who is
          // asking and where the answer goes in words the plugin did not write.
          return json(200, { ok: true, schema, from: hit.qualified, provenance: provenance(schema, hit.qualified) });
        } catch (e) {
          return json(400, { ok: false, error: `${engine} declares a wizard core cannot render: ${e.message}` });
        }
      }
      // Author-mode only, and that is structural rather than checked: this
      // server answers loopback alone, and `present` registers nothing like
      // these at all. A credential prompt in a deck you were emailed has
      // nowhere to post.
      if (req.method === 'POST' && url.pathname === '/edit/wizard') {
        const { engine, answers } = JSON.parse(body);
        if (typeof engine !== 'string') return json(400, { ok: false, error: 'which engine?' });
        // "No such engine" is a third answer, not one of the two failures. It is
        // not an outage to wait out and not a refusal by a provider — it is a
        // marketplace that was never added, and the fix is named.
        if (!(await wizardEntry(engine))) {
          return json(404, { ok: false, state: 'unknown',
            error: `no engine named "${engine}" declares a wizard in any registered marketplace — try: decklight marketplace add <owner/repo>` });
        }
        const r = await configureEngine(engine, answers, {
          fetchSchema: wizardSchemaFor,
          validateAnswers: wizardValidate,
        });
        if (r.state !== CONFIGURED) {
          // The three failures stay three: 503 for "could not reach", 400 for
          // "that was refused", and 412 for "this machine is missing something"
          // (ENGINES#LIPSYNC). A presenter whose key is wrong must not be told
          // to check their network, and one who is missing rhubarb must not be
          // told to check their key — the status code says which it is too.
          const code = r.state === UNREACHABLE ? 503 : r.state === PREREQUISITE ? 412 : 400;
          return json(code, { ok: false, state: r.state, error: r.reason, ...(r.unmet ? { unmet: r.unmet } : {}) });
        }
        // Redacted on the way out, always — the response is the one place a key
        // could leak back into a page, a devtools log, or a screen recording.
        console.log(`  wizard: ${engine} configured (${r.file} — ${r.protection.label})`);
        // A key that could not be restricted is worth an extra line, at the
        // moment it is stored rather than in a doc nobody reads (#308): what
        // decklight says about a credential and what is true of it on disk
        // have to be the same sentence.
        if (r.protection.state !== 'private') {
          console.log(`  wizard: decklight could NOT restrict that file to your account — ${r.protection.label}`);
          if (r.protection.why) console.log(`          the system said: ${r.protection.why}`);
        }
        return json(200, { ok: true, state: r.state, engine, stored: r.stored, protection: r.protection.label });
      }
      if (req.method === 'POST' && url.pathname === '/edit/wizard/forget') {
        const { engine } = JSON.parse(body);
        if (typeof engine !== 'string') return json(400, { ok: false, error: 'which engine?' });
        const had = forgetCredentials(engine);
        console.log(`  wizard: ${engine} ${had ? 'forgotten' : 'was not configured'}`);
        return json(200, { ok: true, forgotten: had });
      }
      if (req.method === 'POST' && url.pathname === '/edit/notes') {
        const { slide, text } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string') throw new Error('bad payload');
        applyEdit(setSlideNotes(readDeck(), slide, notesTextToAside(text)));
        console.log(`  notes saved: slide ${slide} (${text.length} chars)`);
        return json(200, { ok: true, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/layout') {
        const { slide, layout } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || typeof layout !== 'string') throw new Error('bad payload');
        const changed = applyEdit(setSlideLayout(readDeck(), slide, layout));
        if (changed) console.log(`  layout saved: slide ${slide} → ${layout}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      // ── element edit mode (E, right-click a slide element) — #112 ─────
      // Same door as layout/notes: a pure (html, slide, index, …) → html
      // transform, through applyEdit, onto the ONE undo/redo stack.
      if (req.method === 'POST' && url.pathname === '/edit/element/remove') {
        const { slide, index } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
        const changed = applyEdit(removeSlideElement(readDeck(), slide, index));
        if (changed) console.log(`  element removed: slide ${slide} #${index}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/element/content') {
        const { slide, index, html } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || typeof html !== 'string') {
          throw new Error('bad payload');
        }
        const changed = applyEdit(setSlideElementHtml(readDeck(), slide, index, html));
        if (changed) console.log(`  element content saved: slide ${slide} #${index}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/element/effect') {
        const { slide, index, effect } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0
            || (effect !== null && typeof effect !== 'string')) {
          throw new Error('bad payload');
        }
        const changed = applyEdit(setSlideElementBuild(readDeck(), slide, index, effect));
        if (changed) console.log(`  element effect saved: slide ${slide} #${index} → ${effect ?? '(removed)'}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      // Remember which agent A should reach for (#125, SPEC AGENT_UNITS). A
      // preference is a choice about this machine, not about the deck, so it
      // is written beside the unit library and never into the file.
      if (req.method === 'POST' && url.pathname === '/edit/agent/prefer') {
        const { agent } = JSON.parse(body);
        if (agent !== null && typeof agent !== 'string') throw new Error('bad payload');
        if (agent && !agents.some((a) => a.name === agent)) {
          return json(400, { ok: false, error: agentUnavailable(agent, agents) });
        }
        setPreferredAgent(agent);
        agentPref = agent ?? undefined;
        console.log(`  agent: ${agent ? `${agent} remembered as preferred` : 'preference cleared'}`);
        return json(200, { ok: true, preferredAgent: agent ?? null });
      }
      if (req.method === 'POST' && url.pathname === '/edit/agent') {
        const { prompt, agent, message } = JSON.parse(body);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
        if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
        const cmd = runAgent(prompt.trim(), agent, message);
        if (!cmd) return json(400, { ok: false, error: agentUnavailable(agent ?? agentPref, agents) });
        return json(200, { ok: true, agent: cmd.name, label: cmd.label });
      }
      // ── static files from the cwd (staticFiles, serve.mjs) ───────────
      if (files(req, res, url)) return;
      res.writeHead(405);
      res.end();
    } catch (e) {
      console.error(`  edit error: ${String(e).slice(0, 120)}`);
      if (!res.headersSent) res.writeHead(400, CORS);
      res.end(String(e.message || e));
    }
  });

  const actual = await listenTakingOverIfNeeded(server, port, host);
  // `decklight record` runs this same server in-process and needs to know
  // WHICH port it ended up on (a taken --port moves to the next free one) and
  // to print its own banner instead of the authoring one.
  if (onListen) onListen({ port: actual, deckUrl, server });
  else console.log(`decklight author on http://127.0.0.1:${actual}${deckUrl} — E element edit mode, L layouts, Z undo, A agent. Ctrl-C stops`);

  // Did somebody review this deck? Asked ONCE, after the last startup line,
  // detached and never awaited — the update-check shape: nothing about it can
  // delay the server coming up or hang authoring on a remote that is down. It
  // is a fetch the author did not type, which is why it is the sanctioned
  // exception cli/git.mjs names, why it is never on a timer, and why it is
  // nowhere near the SIGINT path (finalCommit above says what lives there and
  // why nothing else may).
  if (!onListen) {
    const skipped = reviewCheckSuppressed({ args });
    if (skipped) {
      console.log(`  reviews: not checked — ${skipped}`);
    } else {
      reviewsWaiting(deckPath)
        .then((r) => {
          const line = reviewLine(r, { deck: relative(process.cwd(), deckPath) || basename(deckPath) });
          if (line) console.log(`  ${line}`);
        })
        .catch(() => {});
    }
  }
  return { port: actual, deckUrl, host, server };
}


if (isMain(import.meta.url)) {
  // author spawns this module directly, so the leash the dispatcher used to
  // arm is armed here — a no-op unless a supervising parent set it up.
  exitWhenOrphaned();
  editMain(process.argv.slice(2));
}
