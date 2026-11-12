// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A code block's settings (SPEC CODE_AND_MATH), as the inspector's Options tab
// offers them and the edit server writes them: its language, line numbers,
// fit to its space, and the line steps. Pure and shared, so the page (which
// shows a change at once) and the server (which writes it) hold one closed set
// and one reading of `data-lines`.

/** The languages the runtime highlights (src/code/code.js), as the field lists them. */
export const CODE_LANGUAGES = [
  ['bash', 'Bash, shell'], ['css', 'CSS'], ['go', 'Go'], ['xml', 'HTML, XML'], ['java', 'Java'],
  ['javascript', 'JavaScript'], ['json', 'JSON'], ['python', 'Python'], ['rust', 'Rust'],
  ['sql', 'SQL'], ['typescript', 'TypeScript'], ['yaml', 'YAML'],
];
/** The other names a `language-` class may carry for the same language (code.js's aliases). */
const ALIASES = {
  js: 'javascript', ts: 'typescript', shell: 'bash', sh: 'bash', zsh: 'bash', html: 'xml',
  text: '', plain: '', plaintext: '',
};

/**
 * The language a `language-` class names, as the field shows it: one of
 * CODE_LANGUAGES, '' for plain text (no class, or a plain one), or null for a
 * name the runtime does not highlight (shown as it is, never rewritten).
 */
export function languageOf(name) {
  if (name == null || name === '') return '';
  const n = String(name).toLowerCase();
  if (Object.hasOwn(ALIASES, n)) return ALIASES[n];
  return CODE_LANGUAGES.some(([v]) => v === n) ? n : null;
}

/** The lines a block's code has, counted as the runtime counts them (its file's first newline and trailing space are layout). */
export function lineCount(code) {
  const text = String(code ?? '').replace(/^\n/, '').replace(/\s+$/, '');
  return text === '' ? 0 : text.split('\n').length;
}

/** `data-lines` as its steps, one string each (`1-2|4` → `['1-2', '4']`); none is []. */
export const stepsOf = (spec) => (spec == null || String(spec).trim() === '' ? [] : String(spec).split('|').map((s) => s.trim()));
/** The steps written back as `data-lines`, or null for none. */
export const specOf = (steps) => (steps.length ? steps.map((s) => String(s).trim()).join('|') : null);

/**
 * What is wrong with one step for a block of `total` lines, in a sentence, or
 * null: `all`, a line (`4`), a range (`6-9`), or several (`1,3-4`).
 */
export function stepError(step, total) {
  const s = String(step ?? '').trim();
  if (s === '') return 'a step needs its lines, like 1-2, or all';
  if (s === 'all') return null;
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return `“${part.trim()}” is not a line or a range: write 4, 6-9, or 1,3`;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1) return 'lines are counted from 1';
    if (b < a) return `${a}-${b} runs backwards: write ${b}-${a}`;
    if (b > total) return `the block has ${total} line${total === 1 ? '' : 's'}: ${b} is past its end`;
  }
  return null;
}

/** The first step's error in `data-lines` for `total` lines, with its number, or null. */
export function linesError(spec, total) {
  const steps = stepsOf(spec);
  for (let i = 0; i < steps.length; i++) {
    const why = stepError(steps[i], total);
    if (why) return steps.length > 1 ? `step ${i + 1}: ${why}` : why;
  }
  return null;
}

/**
 * A step with line `n` added (a click on a line of the block), its lines kept
 * in order and joined into ranges: `1-2` with 3 is `1-3`, with 5 is `1-2,5`.
 * A line it already has is taken out again.
 */
export function toggleLine(step, n) {
  const have = new Set();
  const s = String(step ?? '').trim();
  if (s !== 'all') {
    for (const part of s.split(',')) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : Number(m[2]);
      for (let i = a; i <= b && i - a < 10000; i++) have.add(i);
    }
  }
  if (have.has(n)) have.delete(n); else have.add(n);
  const lines = [...have].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(j > i ? `${lines[i]}-${lines[j]}` : String(lines[i]));
    i = j;
  }
  return out.join(',');
}
