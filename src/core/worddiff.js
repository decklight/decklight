// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What changed between two versions of a text, word by word — the notes
// editor's before/after (SPEC PRESENTING): an agent's rewrite, or your own
// typing, against the notes as last saved, read BEFORE ⌘⏎ writes it.
//
// A longest-common-subsequence over tokens (words, and the whitespace between
// them, so line breaks and [click] lines survive the round trip). Notes are a
// few hundred words; a pair too big for the table falls back to whole lines,
// which is coarser and still right.

const TOKEN = /\s+|[^\s]+/g;
const MAX_CELLS = 4_000_000;

/**
 * `a` → `b` as runs: `[{ op: '=' | '-' | '+', text }]`, in reading order,
 * neighbouring runs of the same op merged. Joining the '=' and '-' runs gives
 * back `a`; joining '=' and '+' gives `b`. Pure.
 */
export function wordDiff(a, b) {
  let x = String(a ?? '').match(TOKEN) ?? [];
  let y = String(b ?? '').match(TOKEN) ?? [];
  if (x.length * y.length > MAX_CELLS) {
    x = String(a ?? '').split(/(?<=\n)/);
    y = String(b ?? '').split(/(?<=\n)/);
  }
  return lcsRuns(x, y);
}

/** Token arrays `x` → `y` as merged runs, by longest common subsequence. */
function lcsRuns(x, y) {
  const n = x.length, m = y.length;
  // lengths of the common subsequence of x[i..] and y[j..]
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push(out, '=', x[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push(out, '-', x[i++]);
    else push(out, '+', y[j++]);
  }
  while (i < n) push(out, '-', x[i++]);
  while (j < m) push(out, '+', y[j++]);
  return out;
}

function push(out, op, text) {
  const last = out[out.length - 1];
  if (last?.op === op) last.text += text; else out.push({ op, text });
}

// a replacement longer than this is read as words, never split into letters
const MAX_REFINE = 400;

/**
 * The runs of `wordDiff`, with each replacement that is nearly the word it
 * replaces read letter by letter (#940): `nice-to-have,` → `nice-to-have;`
 * marks the `,` and the `;`, not two whole words. A replacement unlike what
 * it replaces stays whole words, since a sprinkle of shared letters reads
 * worse than the swap. Same contract as `wordDiff`; pure.
 */
export function refineRuns(runs) {
  const out = [];
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k], next = runs[k + 1];
    if (r.op !== '-' || next?.op !== '+') { push(out, r.op, r.text); continue; }
    const a = [...r.text], b = [...next.text];
    k++;
    if (a.length > MAX_REFINE || b.length > MAX_REFINE) { push(out, '-', r.text); push(out, '+', next.text); continue; }
    const chars = lcsRuns(a, b);
    const same = chars.reduce((c, x) => c + (x.op === '=' ? [...x.text].length : 0), 0);
    // nearly alike: half the longer one is common, and something of substance is
    if (same * 2 < Math.max(a.length, b.length) || !/[^\s\p{P}\p{S}]/u.test(chars.filter((x) => x.op === '=').map((x) => x.text).join(''))) {
      push(out, '-', r.text); push(out, '+', next.text); continue;
    }
    for (const c of chars) push(out, c.op, c.text);
  }
  return out;
}

/**
 * What changed, one piece per place: `[{ before, after, at }]`, each a run of
 * removed and added words with no unchanged word between them, `at` its
 * offset in `a`. Read off `wordDiff`'s runs, so a piece is whole words. Pure.
 */
export function diffHunks(runs) {
  const out = [];
  let cur = null, pos = 0;
  for (const r of runs) {
    if (r.op === '=') {
      // whitespace alone between two changes does not part them
      if (cur && /^\s+$/.test(r.text)) { cur.gap = (cur.gap ?? '') + r.text; pos += r.text.length; continue; }
      if (cur) { delete cur.gap; out.push(cur); cur = null; }
      pos += r.text.length;
      continue;
    }
    if (!cur) cur = { before: '', after: '', at: pos };
    else if (cur.gap) { cur.before += cur.gap; cur.after += cur.gap; delete cur.gap; }
    if (r.op === '-') { cur.before += r.text; pos += r.text.length; } else cur.after += r.text;
  }
  if (cur) { delete cur.gap; out.push(cur); }
  return out.map((h) => ({ before: h.before.trim(), after: h.after.trim(), at: h.at }));
}

/**
 * Whether `a` → `b` changes nothing but punctuation and spacing: a comma for a
 * semicolon, a hyphen, a doubled space. Letters, digits and their case are
 * the same. False when nothing changed. Pure.
 */
export function punctuationOnly(a, b) {
  const bare = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
  return String(a ?? '') !== String(b ?? '') && bare(a) === bare(b);
}

/** How many words went and came: `{ removed, added }`. */
export function diffCounts(runs) {
  const words = (t) => (t.match(/[^\s]+/g) ?? []).length;
  return runs.reduce((c, r) => {
    if (r.op === '-') c.removed += words(r.text);
    if (r.op === '+') c.added += words(r.text);
    return c;
  }, { removed: 0, added: 0 });
}
