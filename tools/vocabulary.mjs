// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Decklight's authoring vocabulary: every `data-*` attribute an author writes
 * that the runtime (or a command that reads the deck) acts on, and every key
 * of the configuration block. ONE table, read by everything that needs to
 * know what a word means:
 *
 *   - `decklight check` (cli/check.mjs) and the Check deck… panel
 *     (src/core/deckcheck.js): a misspelled attribute, build effect or
 *     configuration key renders as if it were absent, and nothing said so.
 *     `data-buld` and `data-build="fade-upp"` are findings now, with what
 *     was meant.
 *
 * Here and not in src/ for the reason tools/click-match.mjs gives: cli/ never
 * imports src/, src/ may import a tool. It ships in the runtime bundle, so it
 * stays a table and a few small functions, zero dependencies.
 *
 * test/vocabulary.test.mjs keeps it honest: every `data-*` name in src/ is
 * either here or in ENGINE_ATTRIBUTES, and every entry here is read somewhere.
 */

/**
 * The attributes an author writes: what the rules need and nothing else,
 * since this ships in the runtime and so in every self-contained deck. Where
 * each goes and what it does is cli/vocabulary-docs.mjs's, joined by name for
 * the editor support files (cli/editor-support.mjs) and kept out of the
 * bundle. `values` is the enumeration when the
 * attribute takes one, `bare` means it may be written with no value, and
 * `number` that a number is a value too. `open` marks values that are only
 * suggestions (a CSS value may be anything else); `kind` names what a value
 * is, for the sentence a finding says.
 */
export const ATTRIBUTES = [
  // ── a slide ───────────────────────────────────────────────────────────────
  { name: 'data-layout', kind: 'layout', values: ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'] },
  { name: 'data-template' },
  { name: 'data-pin', kind: 'pin', values: ['none'], bare: true, number: true },
  { name: 'data-subtitle', kind: 'subtitle setting', values: ['none'] },
  { name: 'data-transition', kind: 'transition', values: ['none', 'fade', 'slide', 'scale', 'flip'] },
  { name: 'data-auto-animate', bare: true },
  { name: 'data-hidden', bare: true },
  { name: 'data-module' },
  { name: 'data-background-image' },
  { name: 'data-background-video' },
  { name: 'data-background-poster' },
  { name: 'data-background-size', kind: 'background size', values: ['cover', 'contain'], open: true },
  { name: 'data-background-position' },
  { name: 'data-background-dim', number: true },
  { name: 'data-logo', bare: true, number: true },
  { name: 'data-math', bare: true },
  { name: 'data-static-ok', bare: true },
  { name: 'data-dense-ok', bare: true },
  { name: 'data-timing', number: true },
  { name: 'data-face' },
  { name: 'data-narration', kind: 'narration setting', values: ['hold'] },
  { name: 'data-narration-pause', number: true },
  { name: 'data-narration-beat-pause', number: true },
  { name: 'data-narration-sentence-pause', number: true },
  { name: 'data-video-hold', number: true },

  // ── builds ────────────────────────────────────────────────────────────────
  { name: 'data-build', kind: 'build effect', values: ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight', 'none'], bare: true },
  { name: 'data-build-order', number: true },
  { name: 'data-build-stay', bare: true },
  { name: 'data-build-self', bare: true },
  { name: 'data-draw-stops' },
  { name: 'data-draw-speed', number: true },

  // ── diagrams ──────────────────────────────────────────────────────────────
  { name: 'data-node' },
  { name: 'data-from' },
  { name: 'data-to' },
  { name: 'data-route', kind: 'route', values: ['straight', 'elbow', 'curve'] },
  { name: 'data-shape', kind: 'shape', values: ['diamond', 'hexagon', 'cylinder', 'document', 'note', 'cloud'] },
  { name: 'data-concept' },
  { name: 'data-nest', kind: 'nesting setting', values: ['on', 'off'] },
  { name: 'data-id' },
  { name: 'data-animate', kind: 'animation', values: ['pulse', 'float', 'shake', 'spin', 'blink', 'bounce', 'swing', 'glow', 'breathe'] },

  // ── charts ────────────────────────────────────────────────────────────────
  { name: 'data-chart', kind: 'chart type', values: ['bar', 'line', 'area', 'pie', 'donut', 'scatter'] },
  { name: 'data-title' },
  { name: 'data-aspect' },

  // ── code ──────────────────────────────────────────────────────────────────
  { name: 'data-lines' },
  { name: 'data-lines-numbers', bare: true },
  { name: 'data-fit', bare: true },

  // ── terminals ─────────────────────────────────────────────────────────────
  { name: 'data-cast' },
  { name: 'data-cast-inline' },
  { name: 'data-mode', kind: 'terminal mode', values: ['step', 'play'] },
  { name: 'data-rows', number: true },
  { name: 'data-type-speed', number: true },
  { name: 'data-max-step', number: true },
  { name: 'data-speed', kind: 'playback speed', values: ['1', '2', '4'] },
  { name: 'data-type-sound', kind: 'key sound', values: ['thocky', 'creamy', 'clacky', 'off'] },

  // ── anything ──────────────────────────────────────────────────────────────
  { name: 'data-scroll-ok', bare: true },
  { name: 'data-no-advance', bare: true },

  // ── design-system templates, and the slots a slide fills ──────────────────
  { name: 'data-slot' },
  { name: 'data-slot-hint' },
  { name: 'data-slot-required', bare: true },
  { name: 'data-slot-default', bare: true },
  { name: 'data-ds-bleed', bare: true },

  // ── the page ──────────────────────────────────────────────────────────────
  { name: 'data-decklight-config', bare: true },
  { name: 'data-theme' },
];

/**
 * Names the runtime, the servers and the CLI write themselves (state, marks,
 * the chrome's own markup), and the few no longer authored. Never a typo for
 * anything: a deck saved from a rendered page carries some of them, and a
 * name close to an authored one (`data-builds`, `data-pinned`) is the engine's.
 */
export const ENGINE_ATTRIBUTES = [
  'data-action', 'data-axis', 'data-beat', 'data-beat-of', 'data-beats', 'data-bled', 'data-bleed', 'data-build-container',
  'data-build-state', 'data-build-style', 'data-builds', 'data-canvas', 'data-chan', 'data-click-mismatch', 'data-col',
  'data-concept-hints', 'data-corner', 'data-count', 'data-custom', 'data-decklight-audio', 'data-decklight-runtime',
  'data-decklight-terminal', 'data-decklight-version', 'data-decklight-visemes', 'data-decklight-voices', 'data-dense',
  'data-design-system', 'data-design-system-meta', 'data-design-system-palette', 'data-design-system-templates',
  'data-design-system-theme', 'data-design-system-version', 'data-display-fill', 'data-dl-unsaved', 'data-dock',
  'data-draw-marker-end', 'data-draw-marker-start', 'data-draw-masked', 'data-draw-orig', 'data-ds-expanded',
  'data-ds-injected', 'data-ds-missing', 'data-ds-required-empty', 'data-eyelid', 'data-filmed', 'data-fit-scale',
  'data-font', 'data-font-meta', 'data-font-preview', 'data-font-version', 'data-generated', 'data-go', 'data-how',
  'data-href', 'data-i', 'data-idle', 'data-key', 'data-label', 'data-markdown', 'data-markdown-removed', 'data-mouth',
  'data-n', 'data-name', 'data-nest-fill', 'data-noise', 'data-off', 'data-off-fix', 'data-off-undo', 'data-overflow',
  'data-overflow-by', 'data-phase', 'data-pinned', 'data-play', 'data-play-beat', 'data-plugin', 'data-point', 'data-pos',
  'data-poster', 'data-rate', 'data-redo', 'data-redo-beat', 'data-ref', 'data-roles', 'data-row', 'data-rule',
  'data-scope', 'data-series', 'data-sig', 'data-slide', 'data-slide-index', 'data-split-conflict', 'data-state',
  'data-tab', 'data-tag', 'data-takes', 'data-theme-added', 'data-theme-marketplace', 'data-theme-source',
  'data-token', 'data-tone', 'data-type', 'data-type-wpm', 'data-value', 'data-version', 'data-view', 'data-viseme', 'data-was',
];

/**
 * The configuration block's keys (SPEC DECK_ANATOMY): `<script
 * type="application/json" data-decklight-config>`, with the JSON type each
 * takes. `values` as above.
 */
export const CONFIG_KEYS = [
  { name: 'decklight', type: 'string' },
  { name: 'theme', type: 'string' },
  { name: 'transition', type: 'string', kind: 'transition', values: ['none', 'fade', 'slide', 'scale', 'flip'] },
  { name: 'hash', type: 'boolean' },
  { name: 'controls', type: 'boolean' },
  { name: 'slideNumber', type: ['boolean', 'string'], kind: 'slide number style', values: ['n', 'n/N'] },
  { name: 'width', type: 'number' },
  { name: 'height', type: 'number' },
  { name: 'pinTitles', type: ['boolean', 'number'] },
  { name: 'themes', type: 'array' },
  { name: 'markedThemes', type: 'array' },
  { name: 'themeSources', type: 'object' },
  { name: 'brandThemesOnly', type: 'boolean' },
  { name: 'designSystems', type: 'array' },
  { name: 'designSystemVersions', type: 'object' },
  { name: 'fonts', type: 'array' },
  { name: 'font', type: 'string' },
  { name: 'concepts', type: 'object' },
  { name: 'logo', type: 'object' },
  { name: 'playlist', type: 'array' },
  { name: 'narration', type: 'object' },
  { name: 'bleed', type: 'boolean' },
  { name: 'edit', type: 'object' },
];

// ── lookups ──────────────────────────────────────────────────────────────────

const BY_NAME = new Map(ATTRIBUTES.map((a) => [a.name, a]));
const ENGINE = new Set(ENGINE_ATTRIBUTES);
const AUTHORED = ATTRIBUTES.map((a) => a.name);
const CONFIG_BY_NAME = new Map(CONFIG_KEYS.map((k) => [k.name, k]));

/** The table's entry for an attribute name, or undefined. */
export const attributeEntry = (name) => BY_NAME.get(String(name).toLowerCase());

/** Does Decklight know this `data-*` name, as authored or as its own? */
export const isKnownAttribute = (name) => {
  const n = String(name).toLowerCase();
  return BY_NAME.has(n) || ENGINE.has(n);
};

// ── did you mean ─────────────────────────────────────────────────────────────

/**
 * Edit distance with a swap of two neighbours costing one (optimal string
 * alignment): `bulid` is one slip from `build`, as a typist would count it.
 */
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * How far a word may be from the one meant and still be a slip of it: none
 * for a word of three letters or fewer (`to`, `id`: everything is close to
 * those), one up to six, two beyond.
 */
const reach = (word) => (word.length <= 3 ? 0 : word.length <= 6 ? 1 : 2);

/**
 * The candidate `word` is most likely a slip of, or null when none is close.
 * Case is no slip: `Fade-Up` means `fade-up`. A tie goes to the earlier
 * candidate, so the order of a list is its preference.
 */
export function didYouMean(word, candidates, { strip = '' } = {}) {
  const w = String(word).toLowerCase().slice(strip.length);
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const core = String(c).toLowerCase().slice(strip.length);
    if (!core) continue;
    const d = editDistance(w, core);
    if (d <= reach(core) && d < bestD) { best = c; bestD = d; }
  }
  return best;
}

// ── the rules ────────────────────────────────────────────────────────────────

const finding = (level, rule, slide, title, message) => ({ level, rule, slide, title, message });

const an = (noun) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;

/** `fade, fade-up or zoom`, with what else the entry takes after it. */
const takes = (entry) => {
  const more = [...(entry.number ? ['a number'] : []), ...(entry.bare ? ['no value'] : [])];
  const all = [...entry.values, ...more];
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} or ${all.at(-1)}` : all[0];
};

/** Is `value` one the entry takes? */
function valueAccepted(entry, value) {
  const v = String(value).trim();
  if (v === '') return !!entry.bare || !entry.values;
  if (entry.number && v !== '' && Number.isFinite(Number(v))) return true;
  return entry.values.includes(v);
}

/**
 * The findings for a set of elements' attributes, one per distinct slip per
 * slide. `elements` is `[{ slide, title, attrs }]` with `attrs` a plain
 * `{ name: value }` (cli/check.mjs reads it off the file, deckcheck.js off
 * the live page); `slide` is null outside any slide.
 *
 *   unknown-attribute  a `data-*` name one slip from one Decklight reads:
 *                      the element behaves as if it had none. A name close to
 *                      nothing is the author's own and is left alone.
 *   unknown-value      a value an enumerated attribute does not take
 */
export function attributeFindings(elements) {
  const out = [];
  const said = new Set();
  for (const { slide = null, title = '', attrs = {} } of elements) {
    for (const [rawName, value] of Object.entries(attrs)) {
      const name = rawName.toLowerCase();
      if (!name.startsWith('data-')) continue;
      const entry = BY_NAME.get(name);
      if (!entry) {
        if (ENGINE.has(name)) continue;
        const meant = didYouMean(name, AUTHORED, { strip: 'data-' });
        if (!meant) continue;
        const key = `a:${slide}:${name}`;
        if (said.has(key)) continue;
        said.add(key);
        out.push(finding('warn', 'unknown-attribute', slide, title,
          `${name} is not an attribute Decklight reads: did you mean ${meant}? As written it does nothing`));
        continue;
      }
      if (!entry.values || entry.open || valueAccepted(entry, value)) continue;
      // a slashed data-layout names a template: ds-layout-attr says that one
      if (name === 'data-layout' && String(value).includes('/')) continue;
      const key = `v:${slide}:${name}=${value}`;
      if (said.has(key)) continue;
      said.add(key);
      const meant = didYouMean(String(value).trim(), entry.values);
      const shown = String(value).trim() === '' ? `${name} with no value` : `${name}="${value}"`;
      out.push(finding('warn', 'unknown-value', slide, title,
        `${shown} is not ${an(entry.kind)}${meant ? `: did you mean ${meant}?` : '.'} It takes ${takes(entry)}`));
    }
  }
  return out;
}

/**
 * Where a JSON parser said it stopped, as `{ line, column }` in `text`, or
 * null. V8 says `at position N` (and lately `(line L column C)`), Firefox
 * `at line L column C`; Safari says neither.
 */
export function jsonErrorAt(message, text) {
  const p = /position (\d+)/.exec(message);
  if (!p) {
    const m = /line (\d+) column (\d+)/.exec(message);
    return m ? { line: Number(m[1]), column: Number(m[2]), offset: null } : null;
  }
  const offset = Number(p[1]);
  const before = String(text).slice(0, offset).split('\n');
  return { line: before.length, column: before.at(-1).length + 1, offset };
}

/**
 * The configuration block's findings. `text` is what the block holds (null:
 * the deck has none, and nothing is said); `line` is the deck line its text
 * starts on, when the caller knows it, so a position names a line of the file.
 *
 *   config-json  the block is not JSON, or not a JSON object: the deck boots
 *                with its defaults, ignoring everything in it (an error)
 *   config-key   a key Decklight does not read, with the one meant
 *   config-value a key's value it does not take
 */
export function configFindings(text, { line = null } = {}) {
  if (text == null) return [];
  const out = [];
  const head = (level, rule, message) => out.push(finding(level, rule, null, 'head', message));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const raw = String(err?.message ?? err);
    const at = jsonErrorAt(raw, text);
    const reason = raw.replace(/^JSON\.parse: /, '').replace(/\s*(?:in JSON )?at (?:position \d+|line \d+ column \d+).*$/s, '').replace(/\s*\(line \d+ column \d+\)/, '').trim();
    const where = at ? (line != null ? `line ${line + at.line - 1}, column ${at.column}` : `line ${at.line} of the block, column ${at.column}`) : null;
    // the slip a hand typist makes most: a comma after the last entry
    const trailing = at?.offset != null && /,\s*$/.test(String(text).slice(0, at.offset)) && /^\s*[}\]]/.test(String(text).slice(at.offset));
    head('error', 'config-json', `the configuration block is not valid JSON${where ? ` (${where})` : ''}: ${reason || 'it does not parse'}`
      + `${trailing ? ' (a comma after the last entry?)' : ''}. The deck boots with its defaults, ignoring all of it`);
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    head('error', 'config-json', 'the configuration block is not a JSON object ({ … }): the deck boots with its defaults, ignoring it');
    return out;
  }
  for (const [key, value] of Object.entries(parsed)) {
    const entry = CONFIG_BY_NAME.get(key);
    if (!entry) {
      const meant = didYouMean(key, CONFIG_KEYS.map((k) => k.name));
      head('warn', 'config-key', `"${key}" is not a configuration key Decklight reads${meant ? `: did you mean "${meant}"?` : '.'} As written it does nothing`);
      continue;
    }
    if (entry.values && typeof value === 'string' && !entry.values.includes(value)) {
      const meant = didYouMean(value, entry.values);
      head('warn', 'config-value', `"${key}": "${value}" is not ${an(entry.kind)}${meant ? `: did you mean "${meant}"?` : '.'} It takes ${entry.values.map((v) => `"${v}"`).join(', ')}`);
    }
  }
  return out;
}
