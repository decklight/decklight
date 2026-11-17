// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A code block's settings (SPEC CODE_AND_MATH), as the inspector's Options tab
// offers them and the edit server writes them: its language, line numbers,
// fit to its space, the line steps and their callouts. Pure and shared, so the page (which
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

/**
 * How a block fits its space, as the field offers it: `off` (no `data-fit`),
 * `shrink` (bare `data-fit`: as large as fits, never past its own size) or
 * `fill` (`data-fit="fill"`: grows short code too, up to `--code-max-size`).
 */
export const FIT_MODES = [['off', 'off'], ['shrink', 'shrink to fit'], ['fill', 'fill']];

/** `data-fit`'s value (null when absent) as one of FIT_MODES: any value but fill reads as a plain fit, as the runtime reads it. */
export const fitOf = (value) => (value == null ? 'off' : String(value).trim().toLowerCase() === 'fill' ? 'fill' : 'shrink');

/** A FIT_MODES value as the edit route's `data-fit`: null takes it off, true writes it bare. */
export const fitAttr = (mode) => (mode === 'fill' ? 'fill' : mode === 'shrink' ? true : null);

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

/**
 * `data-callouts` as its labels, one a step in step order (#1182): `|` between
 * them, `\|` a bar inside one, an empty entry a step with none. Trailing
 * empties are no labels at all, so `a|b|` is two. None is [].
 */
export function calloutsOf(spec) {
  if (spec == null) return [];
  const s = String(spec);
  const out = [''];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { out[out.length - 1] += '|'; i++; }
    else if (s[i] === '|') out.push('');
    else out[out.length - 1] += s[i];
  }
  const labels = out.map((t) => t.replace(/\s+/g, ' ').trim());
  while (labels.length && labels[labels.length - 1] === '') labels.pop();
  return labels;
}

/** The labels written back as `data-callouts` (a bar in one escaped), or null for none. */
export function calloutsSpec(labels) {
  const l = [...(labels ?? [])].map((t) => String(t ?? '').replace(/\s+/g, ' ').trim());
  while (l.length && l[l.length - 1] === '') l.pop();
  return l.length ? l.map((t) => t.replace(/\|/g, '\\|')).join('|') : null;
}

/**
 * Which stepped block each `<aside class="callouts">` of a slide labels: the
 * one its `data-for` names (an id, with or without `#`), else the next stepped
 * block, in order, that no aside names. `blocks` are the slide's stepped
 * blocks as `{ id }`, `asides` its callout asides as `{ for }`, both in
 * document order; the answer is a block index (or -1, none) per aside.
 */
export function calloutBlocks(blocks, asides) {
  const idOf = (v) => String(v ?? '').trim().replace(/^#/, '');
  const named = new Set(asides.map((a) => idOf(a.for)).filter(Boolean));
  const free = blocks.map((_, i) => i).filter((i) => !(blocks[i].id && named.has(blocks[i].id)));
  let k = 0;
  return asides.map((a) => {
    const id = idOf(a.for);
    if (id) return blocks.findIndex((b) => b.id === id);
    return k < free.length ? free[k++] : -1;
  });
}

/**
 * The step each entry of a callouts aside labels: its `data-step` when it has
 * one, else the step after the entry before it. `steps` are the entries'
 * `data-step` values (undefined for none); the answer is 1-based.
 */
export function calloutSteps(steps) {
  let n = 0;
  return steps.map((s) => {
    const v = parseInt(s ?? '', 10);
    n = Number.isFinite(v) && v >= 1 ? v : n + 1;
    return n;
  });
}
