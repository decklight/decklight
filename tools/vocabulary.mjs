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
 *   - the editor support files (cli/editor-support.mjs): VS Code's
 *     completions and hovers are generated from this table at the moment they
 *     are written, so they never drift from it.
 *
 * Here and not in src/ for the reason tools/click-match.mjs gives: cli/ never
 * imports src/, src/ may import a tool. It ships in the runtime bundle, so it
 * stays a table and a few small functions, zero dependencies.
 *
 * test/vocabulary.test.mjs keeps it honest: every `data-*` name in src/ is
 * either here or in ENGINE_ATTRIBUTES, and every entry here is read somewhere.
 */

/**
 * The attributes an author writes. `on` says where it goes when that matters
 * (`section`, a tag, or a short phrase); `values` is the enumeration when the
 * attribute takes one, `bare` means it may be written with no value, and
 * `number` that a number is a value too. `open` marks values that are only
 * suggestions (a CSS value may be anything else); `kind` names what a value
 * is, for the sentence a finding says.
 */
export const ATTRIBUTES = [
  // ── a slide ───────────────────────────────────────────────────────────────
  { name: 'data-layout', on: 'section', kind: 'layout', values: ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'],
    desc: 'How the slide is laid out: auto, centered, a pinned title, top, or split into two sides (split-flip mirrors them).' },
  { name: 'data-template', on: 'section', desc: 'The design-system slide template this slide is built on, as system/template.' },
  { name: 'data-pin', on: 'section', kind: 'pin', values: ['none'], bare: true, number: true,
    desc: 'Pin the title: bare forces the pin, none opts out, a number is its Y in design px.' },
  { name: 'data-subtitle', on: 'section', kind: 'subtitle setting', values: ['none'],
    desc: 'none: the paragraph after the title is not made its subtitle.' },
  { name: 'data-transition', on: 'section', kind: 'transition', values: ['none', 'fade', 'slide', 'scale', 'flip'],
    desc: 'The transition into this slide, over the deck\'s own.' },
  { name: 'data-auto-animate', on: 'section', bare: true,
    desc: 'Magic Move from the slide before: elements sharing a data-id move, the rest fade.' },
  { name: 'data-hidden', on: 'section', bare: true, desc: 'A slide the audience does not see. It keeps its number.' },
  { name: 'data-module', on: 'section', desc: 'Starts a chapter with this title; every slide after it belongs to it.' },
  { name: 'data-background-image', on: 'section', desc: 'An image behind the whole slide.' },
  { name: 'data-background-video', on: 'section', desc: 'A muted, looping video behind the slide while it is on.' },
  { name: 'data-background-poster', on: 'section', desc: 'The still that stands in for the background video (print needs it).' },
  { name: 'data-background-size', on: 'section', kind: 'background size', values: ['cover', 'contain'], open: true,
    desc: 'How the background image fills the slide (default cover).' },
  { name: 'data-background-position', on: 'section', desc: 'Where the background image sits (default center).' },
  { name: 'data-background-dim', on: 'section', number: true, desc: 'Dims the background media toward the canvas, 0 to 1, so text reads.' },
  { name: 'data-logo', on: 'section', bare: true, number: true, desc: 'A large copy of the deck\'s logo above the content; a number is its height in px.' },
  { name: 'data-math', on: 'section', bare: true, desc: 'Renders the LaTeX on this slide.' },
  { name: 'data-static-ok', on: 'section or svg', bare: true, desc: 'This diagram is meant to land all at once: no hint for it.' },
  { name: 'data-dense-ok', on: 'section', bare: true, desc: 'This slide is meant to be dense: no crowded warning for it.' },
  { name: 'data-timing', on: 'section', number: true, desc: 'Planned seconds on this slide, for rehearsal.' },
  { name: 'data-face', on: 'section', desc: 'Where the filmed face shows on this slide: a corner, hide, or full with a zoom.' },
  { name: 'data-narration', on: 'section', kind: 'narration setting', values: ['hold'],
    desc: 'hold: narration never moves off this slide by itself.' },
  { name: 'data-narration-pause', on: 'section', number: true, desc: 'Seconds the slide holds after its narration ends.' },
  { name: 'data-narration-beat-pause', on: 'section', number: true, desc: 'Seconds between one build\'s narration and the next.' },
  { name: 'data-narration-sentence-pause', on: 'section', number: true, desc: 'Seconds between two sentences of one beat.' },
  { name: 'data-video-hold', on: 'section', number: true, desc: 'Seconds this slide holds in a video export.' },

  // ── builds ────────────────────────────────────────────────────────────────
  { name: 'data-build', kind: 'build effect', values: ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight', 'none'], bare: true,
    desc: 'Reveal in steps: on a container each child is a step, on a leaf the element is one. The value is the entrance.' },
  { name: 'data-build-order', number: true, desc: 'The click this step comes on, over document order; equal numbers arrive together.' },
  { name: 'data-build-stay', on: 'child of a data-build container', bare: true, desc: 'This child is not a step: it is there from the start.' },
  { name: 'data-build-self', bare: true, desc: 'A container that is one step itself, not one per child.' },
  { name: 'data-draw-stops', on: 'stroke in a draw build', desc: 'Draws one stroke in stages: path lengths, or fractions of it.' },
  { name: 'data-draw-speed', on: 'stroke in a draw build', number: true, desc: 'Pace of a staged stroke, in path units per second (default 300).' },

  // ── diagrams ──────────────────────────────────────────────────────────────
  { name: 'data-node', on: 'svg shape or group', desc: 'Names this box so a connector can join it.' },
  { name: 'data-from', on: 'svg line, path or polyline', desc: 'The data-node this wire starts at.' },
  { name: 'data-to', on: 'svg line, path or polyline', desc: 'The data-node this wire ends at.' },
  { name: 'data-route', on: 'svg line, path or polyline', kind: 'route', values: ['straight', 'elbow', 'curve'],
    desc: 'How the wire runs between its nodes (default straight).' },
  { name: 'data-concept', on: 'svg shape or group', desc: 'Colours the shape by meaning: one concept, one colour, deck-wide.' },
  { name: 'data-nest', on: 'svg shape or group', kind: 'nesting setting', values: ['on', 'off'],
    desc: 'off: keep the authored fill inside a filled panel; on: nest a shape the box test misses.' },
  { name: 'data-id', desc: 'Matches this element across two auto-animate slides.' },
  { name: 'data-animate', kind: 'animation', values: ['pulse', 'float', 'shake', 'spin', 'blink', 'bounce', 'swing', 'glow', 'breathe'],
    desc: 'A looping attention animation while the slide is on.' },

  // ── charts ────────────────────────────────────────────────────────────────
  { name: 'data-chart', on: 'div.chart', kind: 'chart type', values: ['bar', 'line', 'area', 'pie', 'donut', 'scatter'],
    desc: 'A chart drawn from the JSON inside it.' },
  { name: 'data-title', on: 'chart or terminal', desc: 'The chart\'s title, or the terminal\'s window title.' },
  { name: 'data-aspect', on: 'div.chart', desc: 'The chart\'s shape as w:h (default 16:9).' },

  // ── code ──────────────────────────────────────────────────────────────────
  { name: 'data-lines', on: 'pre', desc: 'Steps through the code by lines, as segments: 1|3-5|all.' },
  { name: 'data-lines-numbers', on: 'pre', bare: true, desc: 'Shows line numbers.' },
  { name: 'data-fit', on: 'pre, or what holds several', bare: true, desc: 'Sizes the code to the room the slide gives it.' },

  // ── terminals ─────────────────────────────────────────────────────────────
  { name: 'data-cast', on: 'div.terminal', desc: 'The recorded session to play, a .cast.json file.' },
  { name: 'data-cast-inline', on: 'div.terminal', desc: 'The recorded session embedded in this page, as #id of its script block.' },
  { name: 'data-mode', on: 'div.terminal', kind: 'terminal mode', values: ['step', 'play'],
    desc: 'step: one command per click; play: it plays through.' },
  { name: 'data-rows', on: 'div.terminal', number: true, desc: 'The terminal\'s height in rows.' },
  { name: 'data-type-speed', on: 'div.terminal', number: true, desc: 'Typing speed, 1 (slow) to 10 (fast).' },
  { name: 'data-max-step', on: 'div.terminal', number: true, desc: 'The longest a step may play, in seconds.' },
  { name: 'data-speed', on: 'div.terminal', kind: 'playback speed', values: ['1', '2', '4'], desc: 'Initial playback speed.' },
  { name: 'data-type-sound', on: 'div.terminal', kind: 'key sound', values: ['thocky', 'creamy', 'clacky', 'off'],
    desc: 'The keyboard\'s sound (default thocky).' },

  // ── anything ──────────────────────────────────────────────────────────────
  { name: 'data-scroll-ok', bare: true, desc: 'This element scrolls on purpose: not counted as clipped.' },
  { name: 'data-no-advance', bare: true, desc: 'A click on this element does not advance the deck.' },

  // ── design-system templates, and the slots a slide fills ──────────────────
  { name: 'data-slot', desc: 'The template slot this element fills (on a slide) or is (in a template).' },
  { name: 'data-slot-hint', on: 'template', desc: 'What an author is expected to put in this slot, e.g. h1,h2.' },
  { name: 'data-slot-required', on: 'template', bare: true, desc: 'This slot must be filled.' },
  { name: 'data-slot-default', on: 'template', bare: true, desc: 'Where content that names no slot lands.' },
  { name: 'data-ds-bleed', on: 'template', bare: true, desc: 'This element\'s background is the slide\'s art, painted to the screen\'s edges.' },

  // ── the page ──────────────────────────────────────────────────────────────
  { name: 'data-decklight-config', on: 'script', bare: true, desc: 'The deck\'s configuration block, as JSON.' },
  { name: 'data-theme', on: 'style', desc: 'A theme carried in the page, by name.' },
];

/**
 * Names the runtime, the servers and the CLI write themselves (state, marks,
 * the chrome's own markup), and the few no longer authored. Never a typo for
 * anything: a deck saved from a rendered page carries some of them, and a
 * name close to an authored one (`data-builds`, `data-pinned`) is the engine's.
 */
export const ENGINE_ATTRIBUTES = [
  'data-action', 'data-beat', 'data-beat-of', 'data-beats', 'data-bled', 'data-bleed', 'data-build-container',
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
  'data-overflow-by', 'data-phase', 'data-pinned', 'data-play', 'data-play-beat', 'data-plugin', 'data-pos',
  'data-poster', 'data-rate', 'data-redo', 'data-redo-beat', 'data-ref', 'data-roles', 'data-row', 'data-rule',
  'data-scope', 'data-series', 'data-sig', 'data-slide', 'data-slide-index', 'data-split-conflict', 'data-state',
  'data-tab', 'data-tag', 'data-takes', 'data-theme-added', 'data-theme-marketplace', 'data-theme-source',
  'data-token', 'data-tone', 'data-type', 'data-type-wpm', 'data-version', 'data-view', 'data-viseme', 'data-was',
];

/**
 * The configuration block's keys (SPEC DECK_ANATOMY): `<script
 * type="application/json" data-decklight-config>`. `values` as above.
 */
export const CONFIG_KEYS = [
  { name: 'decklight', type: 'string', desc: 'The Decklight version this deck was written for.' },
  { name: 'theme', type: 'string', desc: 'The theme the deck opens on (default aurora).' },
  { name: 'transition', type: 'string', kind: 'transition', values: ['none', 'fade', 'slide', 'scale', 'flip'], desc: 'The slide transition (default fade).' },
  { name: 'hash', type: 'boolean', desc: 'Keep the slide and build step in the URL (default true).' },
  { name: 'controls', type: 'boolean', desc: 'Show the previous and next chevrons (default true).' },
  { name: 'slideNumber', type: ['boolean', 'string'], kind: 'slide number style', values: ['n', 'n/N'], desc: 'Show the slide number: false, "n" or "n/N" (default false).' },
  { name: 'width', type: 'number', desc: 'The design width in px (default 1280).' },
  { name: 'height', type: 'number', desc: 'The design height in px (default 720).' },
  { name: 'pinTitles', type: ['boolean', 'number'], desc: 'Pin slide titles at one height: true, false, or a Y in px (default true).' },
  { name: 'themes', type: 'array', desc: 'The themes the picker offers, by name (default: every shipped theme).' },
  { name: 'markedThemes', type: 'array', desc: 'Marketplace themes the deck uses, as name@marketplace.' },
  { name: 'themeSources', type: 'object', desc: 'Where each marketplace the deck references comes from.' },
  { name: 'brandThemesOnly', type: 'boolean', desc: 'Hold a design-system deck to its brand\'s themes (default true).' },
  { name: 'designSystems', type: 'array', desc: 'The design systems the deck is built on, as name@marketplace.' },
  { name: 'designSystemVersions', type: 'object', desc: 'The version of each design system the deck was written for.' },
  { name: 'fonts', type: 'array', desc: 'Marketplace fonts the deck uses, as name@marketplace.' },
  { name: 'font', type: 'string', desc: 'The font the deck is set in.' },
  { name: 'concepts', type: 'object', desc: 'Diagram concepts pinned to a fill slot (1 to 6) or a colour.' },
  { name: 'logo', type: 'object', desc: 'The brand mark: { onLight, onDark, src, height, position }.' },
  { name: 'playlist', type: 'array', desc: 'Decks that play one after another, as file paths.' },
  { name: 'narration', type: 'object', desc: 'The deck\'s voice: recorded tracks (files), the live bridge and its pauses.' },
  { name: 'bleed', type: 'boolean', desc: 'Paint a slide\'s background art to the screen\'s edges (default true).' },
  { name: 'edit', type: 'object', desc: 'Write mode: { url } of the edit server to use.' },
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
