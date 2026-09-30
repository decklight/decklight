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
  const n = x.length, m = y.length;
  // lengths of the common subsequence of x[i..] and y[j..]
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, text) => {
    const last = out[out.length - 1];
    if (last?.op === op) last.text += text; else out.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('=', x[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('-', x[i++]);
    else push('+', y[j++]);
  }
  while (i < n) push('-', x[i++]);
  while (j < m) push('+', y[j++]);
  return out;
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
