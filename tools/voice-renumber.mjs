// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A voice folder follows its slides (#916).
 *
 * A track folder is matched to the deck by POSITION: manifest entry n is
 * slide n, and its files are `slide-NN.wav`, `slide-NN-KK.wav`,
 * `slide-NN.txt`, `slide-NN-KK.visemes.json`. So a slide inserted at 30 used
 * to mark every recording after it as out of step, though no word of theirs
 * changed: only the numbering moved. This is the renumbering, three ways in:
 *
 *  - a slide op: new, duplicate, delete, up, down, move and the template
 *    insert each say exactly where every slide goes, so the folders are moved
 *    in the same step as the deck;
 *  - an agent's edit, or any that rewrote the deck at once (#920): where each
 *    slide went is read off the sections before and after (`slideRenumber`
 *    in cli/commit-split.mjs), and carried out as `pairs`;
 *  - a realign (`realignMoves`): the deck was reordered somewhere else (an
 *    editor, a checkout), so where each recording belongs is read from what it
 *    was recorded FROM, the beats or the hash its manifest entry stores, and
 *    for one whose words changed since, loosely, from its saved script;
 *  - undo and redo, which replay the inverse.
 *
 * What is renumbered, and what undo keeps, is a STEP — `{ dir, op, slide, to }`
 * or `{ dir, pairs }` — never a list of files or a copy of the manifest. A step
 * is planned against the folder as it is when it runs, so a take recorded
 * between an op and its undo is renumbered with everything else rather than
 * written over by a stale snapshot, and its manifest entry goes with it.
 *
 * Nothing is ever deleted: a deleted slide's files go to `.trash/` inside
 * the folder (a dot folder, so no track list walks into it), its manifest
 * entry rides in the inverse step, and undo brings both back. A rename that
 * would land on a file outside the plan is refused before anything moves.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { slideBeats, slideTexts, priorSlideTexts, entryMatches, scriptDrift } from './narration-manifest.mjs';

/** A per-slide file of a track: `slide-NN` then an optional `-KK` beat, then its extension. */
const SLIDE_FILE = /^slide-(\d+)((?:-\d+)?\..+)$/;
/** The audio a track plays — what makes a folder a voice folder, with or without a manifest. */
const SLIDE_AUDIO = /^slide-\d+(-\d+)?\.(wav|m4a|mp3|ogg|opus|flac|aac)$/i;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Where slide k (1-based) is after a slide op, as a function: a number, or
 * null for the slide the op deleted. Total over every k, not only the deck's
 * slides, so a manifest longer than the deck shifts with its tail.
 * `insert` is the template insert, which is `new` with a layout.
 */
export function slideOpRenumber(op, slide, to) {
  const swap = (a, b) => (k) => (k === a ? b : k === b ? a : k);
  switch (op) {
    case 'new': case 'duplicate': case 'insert': return (k) => (k > slide ? k + 1 : k);
    case 'delete': return (k) => (k === slide ? null : k > slide ? k - 1 : k);
    case 'up': return swap(slide - 1, slide);
    case 'down': return swap(slide, slide + 1);
    case 'move': return (k) => {
      if (k === slide) return to;
      if (slide < to && k > slide && k <= to) return k - 1;
      if (slide > to && k >= to && k < slide) return k + 1;
      return k;
    };
    default: throw new Error(`no renumbering for "${op}"`);
  }
}

/** `[[from, to | null]]` as a renumbering: every other slide stays. */
export const movesRenumber = (pairs) => {
  const map = new Map(pairs);
  return (k) => (map.has(k) ? map.get(k) : k);
};

/** A step's renumbering. */
const stepRenumber = (step) => (step.pairs ? movesRenumber(step.pairs) : slideOpRenumber(step.op, step.slide, step.to));

/**
 * The step that undoes `step` — the slots it deleted are put back by the
 * plan's `restore`, so here a delete's inverse is only the gap it reopens.
 */
function inverseStep(step) {
  if (step.pairs) return { pairs: step.pairs.filter(([, t]) => t != null).map(([f, t]) => [t, f]) };
  const { op, slide, to } = step;
  switch (op) {
    case 'new': case 'duplicate': case 'insert': return { op: 'delete', slide: slide + 1 };
    case 'delete': return { op: 'new', slide: slide - 1 };
    case 'move': return { op: 'move', slide: to, to: slide };
    default: return { op, slide };   // up and down are a swap, their own inverse
  }
}

/**
 * Is `dir` a deck's folder? A `.html` there that is a decklight deck, other
 * than `except`. Track folders are found by walking beside the deck, and one
 * that belongs to another deck is not this deck's to renumber.
 */
function holdsDeck(dir, except = null) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /\.html?$/i.test(n) && n !== except); } catch { return false; }
  return names.some((n) => {
    try { return /class\s*=\s*["'][^"']*\bdecklight\b/.test(readFileSync(join(dir, n), 'utf8')); } catch { return false; }
  });
}

/** Is `deckPath` the only deck in its folder? */
export const aloneInFolder = (deckPath) => !holdsDeck(dirname(deckPath), basename(deckPath));

/** Is this folder a voice track: per-slide audio, or a manifest with slides? */
function isTrack(abs) {
  let names = [];
  try { names = readdirSync(abs); } catch { return false; }
  if (names.some((n) => SLIDE_AUDIO.test(n))) return true;
  if (!names.includes('manifest.json')) return false;
  try { return Array.isArray(JSON.parse(readFileSync(join(abs, 'manifest.json'), 'utf8')).slides); } catch { return false; }
}

/**
 * The deck's voice folders, relative to its directory: the ones its config
 * names, and — when it is the only deck there — every folder up to two levels
 * down (`voices/<voice>`, the convention) that is a track: slide audio, or a
 * manifest with slides. A folder holding a deck of its own is another deck's,
 * and is neither taken nor walked into. Nothing outside the deck's directory.
 */
export function voiceFolders(deckPath, configured = []) {
  const deckDir = dirname(deckPath);
  const out = new Set();
  const inside = (rel) => {
    const abs = resolve(deckDir, rel);
    return abs.startsWith(deckDir + sep) ? abs.slice(deckDir.length + 1).split(sep).join('/') : null;
  };
  for (const c of configured) {
    const rel = typeof c === 'string' ? inside(c.replace(/\/+$/, '')) : null;
    if (rel && existsSync(resolve(deckDir, rel))) out.add(rel);
  }
  if (aloneInFolder(deckPath)) {
    const look = (rel) => {
      const abs = resolve(deckDir, rel);
      if (rel !== '.' && holdsDeck(abs)) return [];
      if (rel !== '.' && isTrack(abs)) out.add(rel);
      let entries;
      try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return []; }
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
    };
    for (const e of look('.')) for (const k of look(e.name)) look(`${e.name}/${k.name}`);
  }
  return [...out].sort();
}

/** A manifest's `file` entry renamed: the folder part, if any, kept; a slide that stays keeps its spelling. */
function renameRef(file, renumber) {
  if (typeof file !== 'string') return file;
  const at = file.lastIndexOf('/') + 1;
  const m = SLIDE_FILE.exec(file.slice(at));
  if (!m) return file;
  const was = Number(m[1]);
  const n = renumber(was);
  return n == null || n === was ? file : `${file.slice(0, at)}slide-${pad(n)}${m[2]}`;
}

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const listFiles = (abs) => { try { return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } };

/** A dated trash folder name: `.trash/<time>-<what>`. */
const trashFor = (what) => `.trash/${new Date().toISOString().replace(/[:.]/g, '-')}-${what}`;

/**
 * What carrying out `step` on its folder takes, read off the folder as it is
 * now, without touching it:
 *   { dir, moves: [[from, to]], before, after, conflicts: [sentence], inverse }
 *
 * `moves` are paths relative to the folder: every per-slide file renumbered,
 * a deleted slide's to a fresh `.trash/` folder, and the files a step's
 * `restore` brings back from its `from` folder. `after` is the manifest's new
 * text (null when it does not change): the CURRENT manifest's entries
 * renumbered, and a restored slide's entry put back. `inverse` is the step
 * that undoes this one, carrying what it deleted. A conflict is a rename that
 * would land on a file outside the plan, or two onto one name: a plan with
 * any is not to be carried out.
 */
export function planFolder(deckDir, step) {
  const { dir } = step;
  const abs = resolve(deckDir, dir);
  const renumber = stepRenumber(step);
  const names = listFiles(abs);
  const before = readText(join(abs, 'manifest.json'));
  let manifest = null;
  try { manifest = before == null ? null : JSON.parse(before); } catch { /* not ours to rewrite */ }
  const entries = Array.isArray(manifest?.slides) ? manifest.slides : null;

  // the slides this step deletes, and what each leaves behind
  const gone = new Set();
  for (const name of names) {
    const m = SLIDE_FILE.exec(name);
    if (m && renumber(Number(m[1])) === null) gone.add(Number(m[1]));
  }
  entries?.forEach((e, i) => { if (renumber(i + 1) === null) gone.add(i + 1); });
  const trash = gone.size ? trashFor(`slide-${[...gone].sort((a, b) => a - b).map(pad).join('-')}`) : null;

  const moves = [];
  for (const name of names) {
    const m = SLIDE_FILE.exec(name);
    if (!m) continue;
    const was = Number(m[1]);
    const n = renumber(was);
    if (n === was) continue;
    moves.push([name, n === null ? `${trash}/${name}` : `slide-${pad(n)}${m[2]}`]);
  }
  // a deleted slide coming back: its files from the trash it went to, at its slot
  const restore = Array.isArray(step.restore) ? step.restore : [];
  const back = new Set(restore.map((r) => r.slot));
  if (restore.length && typeof step.from === 'string' && safe(step.from)) {
    for (const name of listFiles(join(abs, step.from))) {
      const m = SLIDE_FILE.exec(name);
      if (m && back.has(Number(m[1]))) moves.push([`${step.from}/${name}`, name]);
    }
  }

  const conflicts = [];
  let after = null;
  if (entries) {
    const slides = [];
    let len = 0;
    entries.forEach((entry, i) => {
      const n = renumber(i + 1);
      if (n == null) return;
      len = Math.max(len, n);
      if (!entry) return;
      if (slides[n - 1]) { conflicts.push(`two recordings would both become slide ${n}`); return; }
      slides[n - 1] = {
        ...entry,
        ...(entry.file !== undefined ? { file: renameRef(entry.file, renumber) } : {}),
        ...(Array.isArray(entry.segments) ? { segments: entry.segments.map((s) => (s && s.file !== undefined ? { ...s, file: renameRef(s.file, renumber) } : s)) } : {}),
      };
    });
    for (const r of restore) {
      if (!r.entry) continue;
      if (slides[r.slot - 1]) { conflicts.push(`slide ${r.slot} already has a recording to come back onto`); continue; }
      slides[r.slot - 1] = r.entry;
      len = Math.max(len, r.slot);
    }
    const text = JSON.stringify({ ...manifest, slides: Array.from({ length: len }, (_, i) => slides[i] ?? null) }, null, 2) + '\n';
    if (text !== before) after = text;
  }
  conflicts.push(...blockers(abs, moves).map((b) => `${dir}/${b} is in the way`));
  const targets = moves.map(([, t]) => t);
  for (const t of new Set(targets.filter((t, i) => targets.indexOf(t) !== i))) conflicts.push(`two files would both become ${dir}/${t}`);

  const inverse = {
    dir,
    ...inverseStep(step),
    ...(gone.size ? { from: trash, restore: [...gone].map((slot) => ({ slot, entry: entries?.[slot - 1] ?? null })) } : {}),
  };
  return { dir, moves, before, after, conflicts, inverse };
}

/** The targets of `moves` that exist and are not themselves moving: what a rename would overwrite. */
function blockers(abs, moves) {
  const sources = new Set(moves.map(([f]) => f));
  return moves.map(([, t]) => t).filter((t) => !sources.has(t) && existsSync(join(abs, t)));
}

/** A path inside the folder: relative, no `..`, no absolute spelling. */
const safe = (p) => typeof p === 'string' && p && !/^[/\\]/.test(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[/\\]/).includes('..');

/** A plan worth carrying out: something moves, or the manifest changes. */
export const planMoves = (p) => p.moves.length > 0 || p.after !== null;

/** Plan every step; `{ plans }` worth carrying out, or `{ error }` naming the first conflict. */
export function planSteps(deckDir, steps) {
  const plans = steps.map((s) => planFolder(deckDir, s)).filter(planMoves);
  const stuck = plans.find((p) => p.conflicts.length);
  if (stuck) return { error: `the recordings in ${stuck.dir}/ cannot follow the slides: ${stuck.conflicts[0]}`, plans };
  return { plans };
}

/**
 * Carry out one plan: renames in two phases — every file to a temporary
 * name, then every one to its own — so slide-30 → slide-31 never lands on a
 * slide-31 that has not moved yet. If a rename fails partway, every rename
 * already made is reversed and the error thrown: the folder is as it was.
 */
function carryOut(abs, moves) {
  const tag = `.renumber-${process.pid}-${Date.now()}`;
  const done = [];
  const go = (from, to) => { renameSync(join(abs, from), join(abs, to)); done.push([from, to]); };
  try {
    moves.forEach(([f], i) => go(f, `${tag}-${i}`));
    moves.forEach(([, t], i) => {
      mkdirSync(dirname(join(abs, t)), { recursive: true });
      go(`${tag}-${i}`, t);
    });
  } catch (e) {
    for (const [from, to] of done.reverse()) { try { renameSync(join(abs, to), join(abs, from)); } catch { /* left under its name; said below */ } }
    throw e;
  }
}

/**
 * Carry out `plans` (from `planFolder`/`planSteps`). A move whose file is gone
 * is skipped; two onto one name are refused, always. A target that exists and is not moving: refused (an Error
 * naming it, nothing moved) unless `aside`, which undo and redo pass — the
 * file is then moved into `.trash/aside-<time>/` rather than written over,
 * and named in the answer. A folder that fails is put back as it was, and so
 * is every folder before it, before the error is thrown.
 * Returns `{ moved, setAside }`.
 */
export function applyPlans(deckDir, plans, { aside = false } = {}) {
  let moved = 0;
  const setAside = [];
  const done = [];
  try {
    for (const p of plans) {
      const abs = resolve(deckDir, p.dir);
      if (!abs.startsWith(deckDir + sep)) continue;
      const moves = p.moves.filter(([f, t]) => safe(f) && safe(t) && existsSync(join(abs, f)));
      const targets = moves.map(([, t]) => t);
      const twice = targets.find((t, i) => targets.indexOf(t) !== i);
      if (twice) throw new Error(`two files would both become ${p.dir}/${twice} — nothing was moved`);
      const blocked = blockers(abs, moves);
      if (blocked.length && !aside) throw new Error(`${p.dir}/${blocked[0]} is in the way — nothing was moved`);
      if (blocked.length) {
        const stamp = `.trash/aside-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        mkdirSync(join(abs, stamp), { recursive: true });
        for (const b of blocked) {
          const to = `${stamp}/${b.split('/').pop()}`;
          renameSync(join(abs, b), join(abs, to));
          setAside.push(`${p.dir}/${to}`);
        }
      }
      carryOut(abs, moves);
      done.push({ abs, moves, before: p.before, wrote: typeof p.after === 'string' });
      moved += moves.length;
      if (typeof p.after === 'string') writeFileSync(join(abs, 'manifest.json'), p.after);
      // a trash folder a restore just emptied goes; one with anything in it stays
      for (const f of new Set(moves.map(([f]) => f).filter((f) => f.startsWith('.trash/')))) {
        for (let d = dirname(join(abs, f)); d.startsWith(abs + sep); d = dirname(d)) {
          try { rmdirSync(d); } catch { break; }
        }
      }
    }
  } catch (e) {
    for (const d of done.reverse()) {
      try { carryOut(d.abs, d.moves.map(([f, t]) => [t, f])); } catch { /* the error below still says it failed */ }
      if (d.wrote && typeof d.before === 'string') { try { writeFileSync(join(d.abs, 'manifest.json'), d.before); } catch { /* as above */ } }
    }
    throw e;
  }
  return { moved, setAside };
}

/**
 * Where each of a manifest's recordings belongs, from what it was recorded
 * from — the deck was reordered by something other than the slide ops.
 *
 * A recording that matches its own slide stays. One that does not is moved
 * to the slide it does match (its stored `beats`, else its `hash`), the
 * nearest one when two do, and never onto a slide whose own recording
 * matches. One that matches nowhere — its words really changed, or it is a
 * deleted slide's — and that its placed neighbours do not agree on, is read
 * loosely (#920): its saved script (`scripts`, a
 * Map slide → the track's `slide-NN.txt`, see trackScripts), else its beats,
 * against each free slide's notes, and placed where half its words or more
 * still are, when one slide alone reads best. Failing that, a run of them
 * between two placed takes that shifted differently is split where the slide
 * was put in or taken out: a take that reads more like the slide on one side
 * of the split than the other says which side it is on. Otherwise it
 * follows its neighbours when both shifted the same way (or its one
 * neighbour, at either end of the track), and stays flagged there; when they
 * disagree it stays, and is named in `unplaced`. An entry with no record of
 * its words is never matched, only carried along by its neighbours, and it
 * never gives way. A move onto a slide
 * something else stays on: when that something is a recording that matches
 * no slide, it is set aside (`to` null, its files to `.trash/`), which is
 * what a slide deleted by hand leaves; otherwise the move is dropped, and so
 * is every move that leaves blocked.
 *
 * Returns `{ moves: [[from, to | null]], said, unplaced }`, `said` the
 * sentence offering it ("26 recordings look shifted by one from slide 30"),
 * '' when nothing moves.
 */
export function realignMoves(manifest, html, { scripts = null } = {}) {
  const slides = Array.isArray(manifest?.slides) ? manifest.slides : [];
  const beats = slideBeats(html);
  const texts = slideTexts(html);
  const prior = priorSlideTexts(html);
  const total = texts.length;
  const known = (e) => !!e && ((Array.isArray(e.beats) && e.beats.length > 0) || !!e.hash);
  const matches = (e, j) => {
    if (j < 1 || j > total || !texts[j - 1]) return false;
    if (Array.isArray(e.beats)) return e.beats.length > 0 && scriptDrift(e, beats[j - 1]) === null;
    return entryMatches(manifest, e, texts[j - 1])
      || (manifest.recorder === 'deck' && !!prior[j - 1] && entryMatches(manifest, e, prior[j - 1]));
  };
  const target = new Map();   // from → to, for every entry placed: itself when it matches in place
  const claimed = new Set();
  slides.forEach((e, i) => { if (known(e) && matches(e, i + 1)) { target.set(i + 1, i + 1); claimed.add(i + 1); } });
  slides.forEach((e, i) => {
    const n = i + 1;
    if (!known(e) || target.has(n)) return;
    const cands = [];
    for (let j = 1; j <= total; j++) if (!claimed.has(j) && matches(e, j)) cands.push(j);
    if (!cands.length) return;
    const best = Math.min(...cands.map((j) => Math.abs(j - n)));
    const at = cands.filter((j) => Math.abs(j - n) === best);
    if (at.length === 1) target.set(n, at[0]);
  });
  // its words changed: placed by what it SAID — its saved script, else its
  // beats — read loosely against each slide's notes now (#920)
  const bags = texts.map(words);
  const heard = new Map();
  const loose = (n, j) => {
    if (j < 1 || j > total) return 0;
    if (!heard.has(n)) {
      const e = slides[n - 1];
      const s = scripts?.get?.(n) ?? (Array.isArray(e?.beats) ? e.beats.join(' ') : null);
      heard.set(n, s ? words(s) : null);
    }
    return overlap(heard.get(n), bags[j - 1]);
  };
  for (const t of target.values()) claimed.add(t);
  // …only where the placed takes around it do not already say where it goes:
  // a take whose words changed between two that stayed is on its slide
  const placed = [...target.keys()].sort((a, b) => a - b);
  const shiftAt = (n) => {
    const prev = placed.filter((k) => k < n).pop();
    const next = placed.find((k) => k > n);
    const dp = prev === undefined ? null : target.get(prev) - prev;
    const dn = next === undefined ? null : target.get(next) - next;
    return dp === null ? dn : dn === null ? dp : dp === dn ? dp : null;
  };
  slides.forEach((e, i) => {
    const n = i + 1;
    if (!e || target.has(n) || shiftAt(n) !== null) return;
    let best = LOOSE, at = [];
    for (let j = 1; j <= total; j++) {
      if (claimed.has(j)) continue;
      const v = loose(n, j);
      if (v > best) { best = v; at = [j]; } else if (v === best && v > LOOSE) at.push(j);
    }
    // one slide reads best, or none does: a tie is the same words twice, not a place
    if (at.length === 1) { target.set(n, at[0]); claimed.add(at[0]); }
  });
  // a run of them between two placed takes that moved differently: the slide
  // put in (or taken out) is somewhere in the run. Each take says which side
  // of it it is on — it reads more like slide k+dp (before) or k+dn (after) —
  // and a take that cannot tell, or a run that contradicts itself, stays put
  let located = [...target.keys()].sort((a, b) => a - b);
  for (let x = 0; x + 1 < located.length; x++) {
    const prev = located[x], next = located[x + 1];
    const dp = target.get(prev) - prev, dn = target.get(next) - next;
    if (dp === dn || Math.abs(dn - dp) !== 1) continue;
    const run = [];
    for (let k = prev + 1; k < next; k++) if (slides[k - 1] && !target.has(k)) run.push(k);
    const side = (k) => {
      const p = loose(k, k + dp), q = loose(k, k + dn);
      return Math.max(p, q) < LOOSE / 2 || p === q ? null : p > q ? dp : dn;
    };
    const said = run.map((k) => [k, side(k)]).filter(([, d]) => d !== null);
    const lastBefore = Math.max(-Infinity, ...said.filter(([, d]) => d === dp).map(([k]) => k));
    const firstAfter = Math.min(Infinity, ...said.filter(([, d]) => d === dn).map(([k]) => k));
    if (!said.length || lastBefore > firstAfter) continue;
    for (const k of run) {
      if (k <= lastBefore) target.set(k, k + dp);
      else if (k >= firstAfter) target.set(k, k + dn);
    }
  }
  // matched nowhere: follow the neighbours when they agree, or the one there is
  located = [...target.keys()].sort((a, b) => a - b);
  const unplaced = new Set();
  const lost = [];
  slides.forEach((e, i) => {
    const n = i + 1;
    if (!e || target.has(n)) return;
    const prev = located.filter((k) => k < n).pop();
    const next = located.find((k) => k > n);
    const dp = prev === undefined ? null : target.get(prev) - prev;
    const dn = next === undefined ? null : target.get(next) - next;
    const d = dp === null ? dn : dn === null ? dp : dp === dn ? dp : null;
    if (d) { target.set(n, n + d); return; }
    if (known(e)) unplaced.add(n);
    if (d === null && known(e)) lost.push(n);
  });
  // settle: a move onto a slot something stays on, or that another move also
  // wants, is dropped — which can leave its own entry staying, so again. A
  // stayer that matches no slide gives way instead, to the trash.
  const moving = new Map([...target].filter(([f, t]) => f !== t && t >= 1));
  for (let changed = true; changed;) {
    changed = false;
    const stays = new Set(slides.map((e, i) => (e && !moving.has(i + 1) ? i + 1 : null)).filter(Boolean));
    const wanted = new Map();
    for (const t of moving.values()) if (t !== null) wanted.set(t, (wanted.get(t) ?? 0) + 1);
    for (const [f, t] of moving) {
      if (t === null) continue;
      if (wanted.get(t) > 1) { moving.delete(f); changed = true; continue; }
      if (stays.has(t)) {
        if (unplaced.has(t)) moving.set(t, null);
        else moving.delete(f);
        changed = true;
      }
    }
  }
  // a set-aside that nothing ended up needing is not set aside
  const wantedAtEnd = new Set([...moving.values()].filter((t) => t !== null));
  for (const [f, t] of moving) if (t === null && !wantedAtEnd.has(f)) moving.delete(f);
  const moves = [...moving].sort((a, b) => a[0] - b[0]);
  // what could not be placed is said, never left silently on a wrong slide
  const aside = new Set(moves.filter(([, t]) => t === null).map(([f]) => f));
  const left = lost.filter((n) => !aside.has(n));
  return { moves, said: realignSaid(moves, left), unplaced: left };
}

/** How loosely two scripts may agree and still be the same take: half their words. */
const LOOSE = 0.5;
/** A script's words, lowercased: what a loose comparison weighs. */
const words = (s) => new Set(String(s ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
/** The share of words two scripts have in common (Jaccard), 0 when either has none. */
function overlap(a, b) {
  if (!a?.size || !b?.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A track's saved scripts, `slide-NN.txt`: Map slide → text, what realign reads a stale take by. */
export function trackScripts(abs) {
  const out = new Map();
  for (const name of listFiles(abs)) {
    const m = /^slide-(\d+)\.txt$/.exec(name);
    if (!m) continue;
    const text = readText(join(abs, name));
    if (text != null) out.set(Number(m[1]), text);
  }
  return out;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * "26 recordings look shifted by one from slide 30", or the count when they
 * moved several ways; a recording set aside is named after it.
 */
export function realignSaid(moves, unplaced = []) {
  const shifted = moves.filter(([, t]) => t !== null);
  const aside = moves.filter(([, t]) => t === null).map(([f]) => f);
  if (!shifted.length) return '';
  const lost = unplaced.length
    ? `; slide${unplaced.length === 1 ? '' : 's'} ${ranges(unplaced)} could not be placed (${unplaced.length === 1 ? 'its notes' : 'their notes'} changed): check ${unplaced.length === 1 ? 'it' : 'them'}`
    : '';
  const n = shifted.length;
  const what = `${n} recording${n === 1 ? '' : 's'} look${n === 1 ? 's' : ''}`;
  const shifts = new Set(shifted.map(([f, t]) => t - f));
  const d = Math.abs([...shifts][0]);
  const head = shifts.size === 1 ? `${what} shifted by ${WORDS[d] ?? d} from slide ${shifted[0][0]}` : `${what} out of place, from slide ${shifted[0][0]}`;
  return head + (aside.length ? ` (slide ${aside.join(', ')}'s set aside: its slide is gone)` : '') + lost;
}

/** `[3, 4, 5, 9]` as "3–5, 9". */
function ranges(list) {
  const out = [];
  for (const n of [...list].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/**
 * The line an edit's renumbering of one folder is said in (#920): "voices/me:
 * 25 recordings moved with the new slide 32". `plan` is the folder's plan,
 * `pairs` the deck's renumbering, `was` and `now` its slide counts either side.
 */
export function followedSaid(plan, pairs, was, now) {
  const renumber = movesRenumber(pairs);
  const moved = new Set();
  for (const [from] of plan.moves) {
    const m = SLIDE_FILE.exec(from);
    if (m) moved.add(Number(m[1]));
  }
  const kept = new Set();
  for (let k = 1; k <= was; k++) { const n = renumber(k); if (n != null) kept.add(n); }
  const added = [];
  for (let n = 1; n <= now; n++) if (!kept.has(n)) added.push(n);
  const removed = pairs.filter(([, t]) => t == null).map(([f]) => f);
  const binned = [...moved].filter((k) => renumber(k) == null).sort((a, b) => a - b);
  const n = moved.size - binned.length;
  const why = added.length === 1 && !removed.length ? `with the new slide ${added[0]}`
    : removed.length === 1 && !added.length ? `as slide ${removed[0]} went`
    : !added.length && !removed.length ? 'with the slides that moved'
    : 'with the slides added, removed and moved';
  const parts = [];
  if (n) parts.push(`${n} recording${n === 1 ? '' : 's'} moved ${why}`);
  if (binned.length) parts.push(`slide ${ranges(binned)}'s set aside in .trash/`);
  return parts.length ? `${plan.dir}: ${parts.join('; ')}` : '';
}
