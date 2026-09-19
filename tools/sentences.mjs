// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where speech breaks into sentences — one rule for the live voice and captions
// (src/core/narration.js, which re-exports it) and for a rendered video's
// subtitles (tools/video.mjs), so the two break in the same places.
//
// In tools/ because the package ships tools/ and not src/: the CLI may not
// import from the runtime, and the runtime bundles what it imports from here.

/** Where the live voice breathes: sentence ends, with closing quotes kept on the sentence. */
export function splitSentences(text) {
  return ((text ?? '').match(/[^.!?…]+[.!?…]+[”’"')\]]*|[^.!?…]+$/g) ?? [])
    .map((s) => s.trim()).filter(Boolean);
}

/**
 * The let-it-sink-in marker (#560): `⟨PAUSE⟩` anywhere in a slide's notes
 * holds twice the beat pause at that spot. Like ⟨CLICK⟩ it is punctuation for
 * the voice, never words — and unlike ⟨CLICK⟩ it cuts no beat, so it lives
 * INSIDE one, where only a recording can hold it. One definition here, read
 * by the live voice, the deck's recorder, the synthesis core and a video's
 * subtitles alike, so all four hold it in the same place.
 */
export const PAUSE_MARK = '⟨PAUSE⟩';

/** The beat marker: segment k of a slide's notes narrates build step k. */
export const CLICK_MARK = '⟨CLICK⟩';

/**
 * A stretch said slowly: `⟨SLOW⟩ … ⟨/SLOW⟩`, or `⟨SLOW⟩` alone for the rest
 * of its sentence.
 */
export const SLOW_OPEN = '⟨SLOW⟩';
export const SLOW_CLOSE = '⟨/SLOW⟩';

/**
 * How much slower a ⟨SLOW⟩ stretch is said: 0.85× unless the deck's
 * `narration.slowRate` says otherwise. Bounded to 0.5–1 — slower than half
 * speed stops being emphasis and starts being a malfunction, and "slow" at
 * more than 1× is a typo — and a value out of bounds costs the default, never
 * the feature. One definition for the live voice and the synthesis core.
 */
export const SLOW_RATE = 0.85;
export const slowRateOf = (cfg) => (typeof cfg === 'number' && Number.isFinite(cfg) && cfg >= 0.5 && cfg <= 1 ? cfg : SLOW_RATE);

const MARK_OF = { pause: PAUSE_MARK, click: CLICK_MARK, slow: SLOW_OPEN };
const markFor = (close, word) => {
  const w = word.toLowerCase();
  if (w === 'slow') return close ? SLOW_CLOSE : SLOW_OPEN;
  return close ? '' : MARK_OF[w];   // a pause or a click has nothing to close
};

// `[pause]`, `<Click>`, `&lt;SLOW&gt;`, `[/slow]`, `⟨pause⟩` — any case, spaces
// inside allowed, the brackets a matched pair. Only the three words: `[1]`,
// `[data-mouth]` and `<script>` in a note are somebody's prose.
const TEXT_MARK = /\[\s*(\/?)\s*(pause|click|slow)\s*\]|<\s*(\/?)\s*(pause|click|slow)\s*\/?\s*>|&lt;\s*(\/?)\s*(pause|click|slow)\s*\/?\s*&gt;|⟨\s*(\/?)\s*(pause|click|slow)\s*⟩/gi;

/**
 * Every spelling of a marker written as TEXT, in its one canonical form —
 * `[pause]` and `<PAUSE>` are `⟨PAUSE⟩`, `[click]` is `⟨CLICK⟩`, `[slow]` and
 * `[/slow]` are `⟨SLOW⟩` and `⟨/SLOW⟩`. A script written for a person to
 * record says `[pause]`; the deck should do what it says, not read it out.
 * The canonical forms map to themselves, so a deck using only those reads —
 * and hashes — exactly as before.
 */
export const canonMarks = (text) => String(text ?? '').replace(TEXT_MARK,
  (m, c1, w1, c2, w2, c3, w3, c4, w4) => markFor(c1 || c2 || c3 || c4, w1 || w2 || w3 || w4));

// Where the browser closes a <slow> element the source left open: the end of
// its paragraph, list item or block — or the start of the next one, which
// closes the paragraph it sits in.
const BLOCK_EDGE = '<\\/?(?:p|li|div|ul|ol|blockquote|h[1-6]|table|tr|td|th)\\b[^>]*>';
const MARK_TAG = new RegExp(`<(\\/?)\\s*(pause|click|slow)\\b[^>]*>|(${BLOCK_EDGE})`, 'gi');

/**
 * Marker ELEMENTS in notes markup as their canonical text: `<pause>` and
 * `<click>` (their closing tags dropped — an unclosed one only wraps the words
 * after it, which stay words), `<slow>…</slow>` as `⟨SLOW⟩…⟨/SLOW⟩`. Written
 * in a deck's HTML they ARE elements, which `textContent` reads as nothing,
 * so a tool reading the file has to see them the way the runtime's walk does
 * (`notesPlain` in src/core/narration.js) — including where the parser closes
 * a `<slow>` nobody closed.
 */
export function markTags(html) {
  let open = false;
  const out = String(html ?? '').replace(MARK_TAG, (m, close, word, edge) => {
    if (edge) { if (!open) return m; open = false; return SLOW_CLOSE + m; }
    if (word.toLowerCase() !== 'slow') return markFor(close, word);
    if (!close === open) return '';          // a second opener, or a stray close
    open = !close;
    return close ? SLOW_CLOSE : SLOW_OPEN;
  });
  return open ? out + SLOW_CLOSE : out;
}

/** Notes MARKUP, every marker spelling — element or text — in canonical form. */
export const notesMarks = (html) => canonMarks(markTags(html));

/**
 * The text with every ⟨SLOW⟩ and ⟨/SLOW⟩ gone — without a space in their
 * place: they wrap words like emphasis does, so `⟨SLOW⟩six⟨/SLOW⟩.` is `six.`
 */
export const stripSlow = (text) => String(text ?? '').replaceAll(SLOW_OPEN, '').replaceAll(SLOW_CLOSE, '');

/** The text with every ⟨PAUSE⟩ gone — what is spoken, captioned, subtitled. */
export const stripPauses = (text) => String(text ?? '').replaceAll(PAUSE_MARK, ' ');

/** What of a text is words: every ⟨PAUSE⟩, ⟨SLOW⟩ and ⟨/SLOW⟩ gone, whitespace flat. */
export const spoken = (text) => stripSlow(stripPauses(text)).replace(/\s+/g, ' ').trim();

// splitSentences' sentence end: terminal punctuation, closing quotes kept on it
const SENTENCE_END = /[.!?…]+[”’"')\]]*/;
const ENDS_SENTENCE = /[.!?…][”’"')\]]*$/;
// punctuation that belongs to the words BEFORE it, even across a marker:
// `⟨SLOW⟩slowly⟨/SLOW⟩.` is `slowly.`, said slowly
const LEADING_PUNCT = /^[.,;:!?…”’"')\]]+/;

/**
 * Every ⟨SLOW⟩ closed: one the text never closes lasts to the end of the
 * sentence it starts — `[slow] The rule of thumb.` slows that sentence, the
 * way a script marks the line that carries the step. A second opener inside
 * a stretch and a close with nothing open are dropped.
 */
export function closeSlow(text) {
  const parts = String(text ?? '').split(/(⟨SLOW⟩|⟨\/SLOW⟩)/);
  const out = [];
  let open = false, scoped = false;
  parts.forEach((p, j) => {
    if (p === SLOW_OPEN) {
      if (open) return;
      open = true;
      scoped = !parts.slice(j + 1).includes(SLOW_CLOSE);
      out.push(p);
      return;
    }
    if (p === SLOW_CLOSE) {
      if (!open) return;
      open = scoped = false;
      out.push(p);
      return;
    }
    const end = open && scoped ? SENTENCE_END.exec(p) : null;
    if (!end) { out.push(p); return; }
    const at = end.index + end[0].length;
    out.push(p.slice(0, at), SLOW_CLOSE, p.slice(at));
    open = scoped = false;
  });
  if (open) out.push(SLOW_CLOSE);
  return out.join('');
}

/**
 * A text cut at its ⟨PAUSE⟩ markers and its ⟨SLOW⟩ edges: `runs` are the
 * stretches of words, each with the number of markers that FOLLOW it, whether
 * it is said slowly, and whether it `glue`s to the next run — ends mid-
 * sentence at a slow edge, so no breath is taken there. `lead` counts the
 * markers before any word at all.
 *
 * Every ⟨PAUSE⟩ belongs to the words before it — between two sentences,
 * attached to one, or standing on its own line — except the ones before the
 * first word, which hold before it. That difference is what keeps
 * `A. ⟨PAUSE⟩ ⟨CLICK⟩ B.` (hold, then reveal) apart from
 * `A. ⟨CLICK⟩ ⟨PAUSE⟩ B.` (reveal, then hold). A marker mid-sentence cuts the
 * sentence there: the author put the silence exactly where they wanted it.
 * A slow edge mid-sentence cuts it too — a clip is said at one rate — and
 * punctuation right after a stretch stays on it.
 */
export function speechRuns(text) {
  const runs = [];
  let lead = 0, slow = false;
  for (const p of closeSlow(text).split(/(⟨PAUSE⟩|⟨SLOW⟩|⟨\/SLOW⟩)/)) {
    if (p === PAUSE_MARK) { if (runs.length) runs[runs.length - 1].pause++; else lead++; continue; }
    if (p === SLOW_OPEN || p === SLOW_CLOSE) { slow = p === SLOW_OPEN; continue; }
    let words = p.replace(/\s+/g, ' ').trim();
    const last = runs[runs.length - 1];
    const punct = last && !last.pause ? LEADING_PUNCT.exec(words) : null;
    if (punct) { last.text += punct[0]; words = words.slice(punct[0].length).trim(); }
    if (!words) continue;
    if (last && !last.pause && last.slow === slow) last.text += ` ${words}`;
    else runs.push({ text: words, pause: 0, slow });
  }
  runs.forEach((r, j) => { r.glue = j < runs.length - 1 && !r.pause && !ENDS_SENTENCE.test(r.text); });
  return { lead, runs };
}

/** A sentence as the live voice carries it: a slow one leads with ⟨SLOW⟩. */
export const slowSentence = (s) => (String(s ?? '').startsWith(SLOW_OPEN)
  ? { text: s.slice(SLOW_OPEN.length), slow: true } : { text: String(s ?? ''), slow: false });

/** Is any stretch of this text said slowly? */
export const hasSlow = (text) => String(text ?? '').includes(SLOW_OPEN);
