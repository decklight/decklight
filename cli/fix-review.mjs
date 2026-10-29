// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A quick fix, reviewed before it lands (SPEC PRESENTING_EDITING, #907).
//
// Check deck…'s quick fixes used to land the moment they were made: the
// agent edited deck.html in place, the page reloaded, the work was committed,
// and the author met the change afterwards, on whatever slide they happened to
// be on. Seventy-five findings fixed in one sitting is seventy-five commits
// nobody looked at. Now a fix is held as a CANDIDATE: the deck on disk stays
// as it was, nothing is committed, no page reloads, and the review view
// (src/core/fixreview.js) shows the deck as it is beside the deck as the fix
// would make it, a slide at a time. What the author approves is merged into
// the deck as one write and one undo entry; the commit is theirs to make.
//
// THE UNIT IS A SLIDE. A slide can be taken from the candidate or left as it
// is without disturbing its neighbours, which is what makes a partial apply
// possible at all; the build steps inside a slide are where the view stops to
// show the change, not something that can be taken half of. What lies outside
// the slides — the head's styles, the `Decklight.init` config, anything
// between and after the sections — is one more unit, `head`, taken whole.
//
// Keys survive an adjustment: a changed or removed slide is named by its
// number in the deck AS IT IS (`s4`), which an agent working on the candidate
// cannot move; an added one by its number in the candidate (`a5`).
//
// The routes take their bindings explicitly, like cli/edit-slides.mjs, so a
// test drives them with a temp deck and no socket.

import { deckOutline } from './commit-message.mjs';
import { slideOps } from './commit-split.mjs';
import { withBaseHref } from './restore.mjs';
import { linkRuntime } from './runtime-link.mjs';
import { linkReferences } from './deck-refs.mjs';

/**
 * The deck cut at its slides: `{ prefix, slides, gaps, suffix }`, where
 * `prefix + slides[0] + gaps[0] + slides[1] + … + suffix` is the deck again,
 * byte for byte. A slide is whole lines (deckOutline's ranges). Null when two
 * slides share a line, where no cut keeps them apart. Pure.
 */
export function deckParts(html) {
  const text = String(html ?? '');
  const outline = deckOutline(text);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineStart = (n) => starts[n - 1];
  const lineEnd = (n) => (n < starts.length ? starts[n] - 1 : text.length);
  const slides = [], gaps = [];
  let at = 0, prefix = '', lastTo = 0;
  for (const [k, s] of outline.entries()) {
    if (s.from <= lastTo) return null;
    const from = lineStart(s.from), to = lineEnd(s.to);
    if (k === 0) prefix = text.slice(0, from);
    else gaps.push(text.slice(at, from));
    slides.push(text.slice(from, to));
    at = to;
    lastTo = s.to;
  }
  return { prefix: outline.length ? prefix : text, slides, gaps, suffix: outline.length ? text.slice(at) : '' };
}

/** What lies outside the slides, as one comparable string; whitespace between slides is not a change. */
const headOf = (p) => `${p.prefix}\u0000${p.gaps.map((g) => g.trim()).filter(Boolean).join('\u0000')}\u0000${p.suffix}`;

/** What lies outside the slides, as text a person reads: the head, the config, and what follows. */
const outside = (p) => [p.prefix, ...p.gaps.map((g) => g.trim()).filter(Boolean), p.suffix].join('\n');

/**
 * The lines two texts do not share, with the lines they share at either end
 * cut away: `{ before, after }`, each at most `max` lines. What the review
 * shows for a change to the deck's head, where the slides look the same and
 * a bundled deck's head is most of a megabyte. Pure.
 */
export function changedLines(a, b, max = 40) {
  const x = String(a).split('\n'), y = String(b).split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const cut = (lines) => {
    const mid = lines.slice(i, lines.length - j);
    return (mid.length > max ? [...mid.slice(0, max), `… ${mid.length - max} more lines`] : mid).join('\n');
  };
  return { before: cut(x), after: cut(y) };
}

/** A slide's notes as text: the aside's words, a `<br>` or a block a line. Pure. */
export function notesText(slideSrc) {
  const m = /<aside\b[^>]*class\s*=\s*["'][^"']*\bnotes\b[^"']*["'][^>]*>([\s\S]*?)<\/aside\s*>/i.exec(String(slideSrc ?? ''));
  if (!m) return '';
  return m[1]
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A slide's title, as the outline reads it (its first h1/h2), or null. */
const titleOf = (src) => deckOutline(src)[0]?.heading ?? null;

/**
 * What a candidate changes, as the units a review decides on, in reading
 * order: `{ key, kind, slide?, was?, title, notes? }`. `kind` is `head`,
 * `changed`, `added` or `removed`; `slide` numbers the slide in the
 * candidate, `was` in the deck as it is. `notes: { before, after }` when the
 * slide's notes differ. Null when the deck cannot be cut (deckParts). Pure.
 */
export function candidateUnits(before, after) {
  const pb = deckParts(before), pa = deckParts(after);
  if (!pb || !pa) return null;
  const units = [];
  if (headOf(pb) !== headOf(pa)) {
    units.push({ key: 'head', kind: 'head', title: 'the deck: styles, config and anything outside the slides', lines: changedLines(outside(pb), outside(pa)) });
  }
  for (const op of slideOps(before, after)) {
    if (op.kind === 'same') continue;
    const was = op.was ? pb.slides[op.was - 1] : null;
    const now = op.slide ? pa.slides[op.slide - 1] : null;
    const unit = {
      key: op.kind === 'added' ? `a${op.slide}` : `s${op.was}`,
      kind: op.kind,
      ...(op.slide ? { slide: op.slide } : {}),
      ...(op.was ? { was: op.was } : {}),
      title: titleOf(now ?? was) ?? titleOf(was ?? '') ?? null,
    };
    const nb = was === null ? '' : notesText(was), na = now === null ? '' : notesText(now);
    if (nb !== na) unit.notes = { before: nb, after: na };
    units.push(unit);
  }
  return units;
}

/**
 * The deck with the units in `take` from the candidate and everything else as
 * it is. Taking every unit is the candidate exactly, taking none the deck
 * exactly; in between, each slide is the version its unit chose, joined by the
 * spacing of the version it came from. Null when either side cannot be cut.
 * Pure.
 */
export function mergeCandidate(before, after, take) {
  const want = take instanceof Set ? take : new Set(take ?? []);
  const units = candidateUnits(before, after);
  if (!units) return null;
  if (units.every((u) => want.has(u.key))) return after;
  if (!units.some((u) => want.has(u.key))) return before;
  const pb = deckParts(before), pa = deckParts(after);
  const shell = want.has('head') ? pa : pb;
  // each slide kept, with the spacing that followed it where it came from
  const out = [];
  const from = (p, n) => ({ text: p.slides[n - 1], gap: p.gaps[n - 1] ?? null });
  for (const op of slideOps(before, after)) {
    if (op.kind === 'same') out.push(from(pb, op.was));
    else if (op.kind === 'changed') out.push(want.has(`s${op.was}`) ? from(pa, op.slide) : from(pb, op.was));
    else if (op.kind === 'added') { if (want.has(`a${op.slide}`)) out.push(from(pa, op.slide)); }
    else if (!want.has(`s${op.was}`)) out.push(from(pb, op.was));
  }
  const spacing = pb.gaps[0] ?? pa.gaps[0] ?? '\n';
  return shell.prefix
    + out.map((s, i) => (i < out.length - 1 ? s.text + (s.gap ?? spacing) : s.text)).join('')
    + shell.suffix;
}

/** `slide 4`, `slides 4 and 5`, `slides 3, 4 and 5`. */
const slidesPhrase = (ns) => (ns.length === 1 ? `slide ${ns[0]}`
  : `slides ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/** Where a unit is, in words: `slide 4`, `slide 5 (added)`, `slide 3 (removed)`, `the deck`. */
export const unitPlace = (u) => (u.kind === 'head' ? 'the deck'
  : u.kind === 'added' ? `slide ${u.slide} (added)`
    : u.kind === 'removed' ? `slide ${u.was} (removed)` : `slide ${u.slide}`);

/**
 * The commit a reviewed apply drafts: `{ subject, body }`. The subject names
 * what landed, on the slides it landed on (`fix: off-role on slides 24 and
 * 25`); the body lists what was rejected, with the reviewer's comment, so the
 * history says what the fix did NOT do as well. `what` is `fix: <rule>`, or an
 * agent-review ask's own words. Pure.
 */
export function commitDraft(what, units, taken, rejected = []) {
  const took = units.filter((u) => taken.has(u.key));
  const ns = [...new Set(took.filter((u) => u.kind !== 'head').map((u) => u.slide ?? u.was))].sort((a, b) => a - b);
  const base = String(what || 'fix').replace(/\s+on (?:slides? [\d, and]+|the deck)$/, '');
  const subject = ns.length ? `${base} on ${slidesPhrase(ns)}` : base;
  const lines = rejected
    .map((r) => { const u = units.find((x) => x.key === r.key); return u ? `- ${unitPlace(u)}${r.comment ? `: ${String(r.comment).replace(/\s+/g, ' ').trim()}` : ''}` : null; })
    .filter(Boolean);
  return { subject, body: lines.length ? `Rejected in review:\n${lines.join('\n')}` : '' };
}

/**
 * Put the review's routes into `routes` and hand back the door the fixers
 * use: `hold({ before, after, what, rule?, slide?, agent? })` keeps a fix as
 * THE candidate (one at a time: a new fix replaces one never applied) and
 * answers its summary; `held()` is the candidate or null; `adjusted(id, after)`
 * replaces its deck after an agent adjusted one slide of it.
 *
 * `ctx`: `readDeck()`; `applyEdit(next, before)`, the one undo entry;
 * `broadcast(event, data)`; `saveBefore(what)`, which commits the work that
 * was already outstanding so the fix's own commit is only the fix; and
 * `adjust({ candidate, unit, comment })`, which hands one slide back to the
 * agent and answers `{ ok, agent }` or `{ ok: false, error, code }`.
 */
export function registerFixReviewRoutes(routes, {
  readDeck, applyEdit, broadcast = () => {}, saveBefore = () => {}, adjust = null,
}) {
  let candidate = null;   // { id, rev, before, after, what, rule, slide, agent, units, at }
  let seq = 0;

  const summary = (c) => ({
    id: c.id, rev: c.rev, what: c.what, kind: c.kind, rule: c.rule ?? null, slide: c.slide ?? null, agent: c.agent ?? null,
    units: c.units, left: c.left, adjusting: c.adjusting ?? null,
  });

  /**
   * `kind` says what made the candidate, for the review's words: a `fix`
   * (Check deck…), a `script` rewrite (the writing tools, PRESENTING_VOICE),
   * or an `ask` (A). `left` lists the slides the job looked at and left as
   * they were, `[{ slide, why }]`: an answer that failed its check, a slide
   * edited while the agent thought. They are not units (nothing changed
   * there), but the review says so rather than leaving the author to guess.
   */
  function hold({ before, after, what, kind = 'fix', rule = null, slide = null, agent = null, left = [] }) {
    const units = candidateUnits(before, after);
    if (!units) return { ok: false, error: 'this deck puts two slides on one line — a change to it cannot be reviewed slide by slide' };
    candidate = { id: `c${++seq}`, rev: 1, before, after, what, kind, rule, slide, agent, units, left, at: Date.now() };
    console.log(`  ${kind}: "${what}" held for review — ${units.length} change${units.length === 1 ? '' : 's'}, nothing written`);
    return { ok: true, ...summary(candidate) };
  }

  function adjusted(id, after, key) {
    if (!candidate || candidate.id !== id) return null;
    candidate.adjusting = null;
    const units = after === null ? null : candidateUnits(candidate.before, after);
    if (units) { candidate.after = after; candidate.units = units; candidate.rev += 1; }
    broadcast('candidate', { id, rev: candidate.rev, adjusted: key, ok: !!units });
    return candidate;
  }

  const current = (id) => (candidate && candidate.id === id ? candidate : null);

  function candidateRoute({ url, json }) {
    const id = url.searchParams.get('id');
    if (!candidate || (id && candidate.id !== id)) return json(404, { ok: false, error: 'no fix is waiting for review' });
    return json(200, { ok: true, ...summary(candidate) });
  }

  /**
   * One side of the candidate as a page, served the way a version in the
   * history is (the `<base>`, the runtime, the references it marks), so the
   * two panes are drawn by the same runtime from the same place.
   */
  function candidateAtRoute({ res, url, json, CORS }) {
    const c = current(url.searchParams.get('id'));
    if (!c) return json(404, { ok: false, error: 'no such fix waiting for review' });
    const side = url.searchParams.get('side') === 'after' ? c.after : c.before;
    res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(linkReferences(linkRuntime(withBaseHref(side))));
  }

  /**
   * `POST /deck/edit/candidate/apply { id, take: [key], rejected: [{ key,
   * comment? }] }`: the approved slides from the candidate, everything else as
   * it is, written as ONE undo entry. Refused when the deck moved since the
   * fix was made: the review was of a deck that no longer exists. Nothing is
   * committed here; the answer carries the commit the page offers.
   */
  function applyRoute({ body, json }) {
    const { id, take = [], rejected = [] } = JSON.parse(body || '{}');
    if (!Array.isArray(take) || !Array.isArray(rejected)) throw new Error('bad payload');
    const c = current(id);
    if (!c) return json(404, { ok: false, error: 'no such fix waiting for review — it was discarded or replaced' });
    if (c.adjusting) return json(409, { ok: false, error: 'the agent is still adjusting it' });
    if (readDeck() !== c.before) {
      return json(409, { ok: false, code: 'MOVED', error: 'the deck changed while the fix was waiting — run the fix again on the deck as it is now' });
    }
    const keys = new Set(c.units.map((u) => u.key));
    const taken = new Set(take.filter((k) => keys.has(k)));
    const said = rejected.filter((r) => r && keys.has(r.key) && !taken.has(r.key))
      .map((r) => ({ key: r.key, comment: typeof r.comment === 'string' ? r.comment.slice(0, 500) : '' }));
    const skipped = c.units.length - taken.size;
    const line = `applied ${taken.size} of ${c.units.length}${said.length ? ` · ${said.length} rejected` : ''}`
      + (skipped - said.length > 0 ? ` · ${skipped - said.length} left out` : '');
    candidate = null;
    if (!taken.size) {
      console.log(`  fix: "${c.what}" — nothing approved, the deck stays as it is`);
      return json(200, { ok: true, changed: false, said: 'nothing approved — the deck is unchanged', applied: 0, of: c.units.length });
    }
    const next = mergeCandidate(c.before, c.after, taken);
    if (next === null) return json(409, { ok: false, error: 'the fix could not be merged slide by slide' });
    saveBefore(c.what);
    const changed = applyEdit(next, c.before);
    const commit = commitDraft(c.what, c.units, taken, said);
    console.log(`  fix: "${c.what}" — ${line}`);
    return json(200, { ok: true, changed, said: line, applied: taken.size, of: c.units.length, rejected: said.length, commit });
  }

  function discardRoute({ body, json }) {
    const { id } = JSON.parse(body || '{}');
    const c = current(id);
    if (!c) return json(200, { ok: true, discarded: false });
    candidate = null;
    console.log(`  fix: "${c.what}" discarded — the deck stays as it is`);
    return json(200, { ok: true, discarded: true });
  }

  /**
   * `POST /deck/edit/candidate/adjust { id, key, comment }`: that slide of the
   * candidate back to the agent with the reviewer's words. The answer is
   * immediate; a `candidate` event says when the new version is in.
   */
  async function adjustRoute({ body, json }) {
    const { id, key, comment } = JSON.parse(body || '{}');
    if (typeof comment !== 'string' || !comment.trim()) return json(400, { ok: false, error: 'say what to change' });
    const c = current(id);
    if (!c) return json(404, { ok: false, error: 'no such fix waiting for review' });
    const unit = c.units.find((u) => u.key === key);
    if (!unit) return json(400, { ok: false, error: 'no such change in this fix' });
    if (unit.kind === 'removed') return json(400, { ok: false, error: 'a removed slide has nothing to adjust — reject it to keep it' });
    if (c.adjusting) return json(409, { ok: false, error: 'the agent is already adjusting it' });
    if (!adjust) return json(409, { ok: false, error: 'no agent CLI on this machine to adjust it' });
    // marked first: the agent may be done (and `adjusted` called) before `adjust` answers
    c.adjusting = key;
    const r = await adjust({ candidate: c, unit, comment: comment.trim().slice(0, 1000) });
    if (!r?.ok) { if (c.adjusting === key) c.adjusting = null; return json(r?.code ?? 409, { ok: false, error: r?.error ?? 'the agent could not be asked' }); }
    return json(200, { ok: true, agent: r.agent, adjusting: c.adjusting });
  }

  routes.set('GET /deck/edit/candidate', candidateRoute);
  routes.set('GET /deck/edit/candidate/at', candidateAtRoute);
  routes.set('POST /deck/edit/candidate/apply', applyRoute);
  routes.set('POST /deck/edit/candidate/discard', discardRoute);
  routes.set('POST /deck/edit/candidate/adjust', adjustRoute);
  return { hold, held: () => candidate, adjusted };
}

/**
 * The ask that adjusts one slide of a held fix: the reviewer's words, the
 * slide, and the instruction to leave the rest alone — the agent works on
 * the candidate, which is in the deck file while it runs.
 */
export const adjustPrompt = (unit, comment, what) => `This deck holds a proposed fix ("${what}") that is being reviewed.`
  + ` On slide ${unit.slide}${unit.title ? ` ("${unit.title}")` : ''}, the reviewer asks for a change to it: ${comment}`
  + ' Change only that slide, and only as asked; leave every other slide exactly as it is.';
