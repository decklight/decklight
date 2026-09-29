// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where speech breaks into sentences — one rule for the live voice and captions
// (src/core/narration.js, which re-exports it) and for a rendered video's
// subtitles (tools/video.mjs), so the two break in the same places.
//
// In tools/ because the package ships tools/ and not src/: the CLI may not
// import from the runtime, and the runtime bundles what it imports from here.

/**
 * Where the live voice breathes: sentence ends, with closing quotes kept on
 * the sentence. An audio tag that FOLLOWS a sentence — `Wow! [laughs]` — is
 * direction for that sentence, not one of its own: on its own it would be a
 * clip that is only a laugh, or, on an engine that cannot act on tags, a clip
 * of nothing.
 */
export function splitSentences(text) {
  const out = [];
  for (const s of ((text ?? '').match(/[^.!?…]+[.!?…]+[”’"')\]]*|[^.!?…]+$/g) ?? []).map((x) => x.trim()).filter(Boolean)) {
    if (out.length && ONLY_TAGS.test(s)) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
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
 * A long hold — ElevenLabs v4's own `[long pause]` — is two pauses: held by
 * decklight the same on every engine, the way `[pause]` is, so a script
 * written for v4 paces the same in piper's voice. As two marks it needs no
 * path of its own anywhere downstream; `writtenMarks` gives the words back.
 */
export const LONG_PAUSE = PAUSE_MARK + PAUSE_MARK;

/**
 * `[slow]` WAS a marker — decklight said the stretch slower itself — and is
 * now what any other bracketed word is, an audio tag (below): direction a
 * voice that can act on it performs, and any other never hears. Its old
 * spellings (`<slow>`, `⟨SLOW⟩`, `&lt;slow&gt;`) read as that tag, and a
 * closing one (`[/slow]`) as nothing — never read aloud as words.
 */
const SLOW_TAG = '[slow]';

const MARK_OF = { pause: PAUSE_MARK, click: CLICK_MARK, slow: SLOW_TAG, 'long pause': LONG_PAUSE };
const markFor = (close, word) => (close ? '' : MARK_OF[word.toLowerCase().replace(/\s+/g, ' ')]);   // nothing has a close

// `[pause]`, `<Click>`, `&lt;pause&gt;`, `[/slow]`, `⟨pause⟩` — any case, spaces
// inside allowed, the brackets a matched pair. Only these words: `[1]`,
// `[data-mouth]` and `<script>` in a note are somebody's prose.
const TEXT_MARK = /\[\s*(\/?)\s*(long\s+pause|pause|click|slow)\s*\]|<\s*(\/?)\s*(long\s+pause|pause|click|slow)\s*\/?\s*>|&lt;\s*(\/?)\s*(long\s+pause|pause|click|slow)\s*\/?\s*&gt;|⟨\s*(\/?)\s*(long\s+pause|pause|click|slow)\s*⟩/gi;

/**
 * Every spelling of a marker written as TEXT, in its one canonical form —
 * `[pause]` and `<PAUSE>` are `⟨PAUSE⟩`, `[click]` is `⟨CLICK⟩` — and any
 * `slow` spelling is the `[slow]` tag, a closing one nothing. A script written
 * for a person to record says `[pause]`; the deck should do what it says, not read it out.
 * The canonical forms map to themselves, so a deck using only those reads —
 * and hashes — exactly as before.
 */
export const canonMarks = (text) => String(text ?? '').replace(TEXT_MARK,
  (m, c1, w1, c2, w2, c3, w3, c4, w4) => markFor(c1 || c2 || c3 || c4, w1 || w2 || w3 || w4));

const MARK_TAG = /<(\/?)\s*(pause|click|slow)\b[^>]*>/gi;

/**
 * Marker ELEMENTS in notes markup as their canonical text: `<pause>` and
 * `<click>` (their closing tags dropped — an unclosed one only wraps the words
 * after it, which stay words), and an old `<slow>` as the `[slow]` tag.
 * Written in a deck's HTML they ARE elements, which `textContent` reads as
 * nothing, so a tool reading the file has to see them the way the runtime's
 * walk does (`notesPlain` in src/core/narration.js).
 */
export const markTags = (html) => String(html ?? '').replace(MARK_TAG, (m, close, word) => markFor(close, word));

/** Notes MARKUP, every marker spelling — element or text — in canonical form. */
export const notesMarks = (html) => canonMarks(markTags(html));

/**
 * The markers as decklight WRITES them: `[click]`, `[pause]` and
 * `[long pause]` — the square brackets a script for a voice is
 * written with (and ElevenLabs v4 reads). Every spelling is still READ
 * (`canonMarks`); this is only what the notes editor shows, what a scaffold
 * and a saved script are written in. Internally the forms stay ⟨…⟩ — that is
 * what recordings were hashed against — so writing brackets re-voices nothing.
 */
export const writtenMarks = (text) => String(text ?? '')
  .replaceAll(LONG_PAUSE, '[long pause]').replaceAll(PAUSE_MARK, '[pause]').replaceAll(CLICK_MARK, '[click]');

/**
 * An AUDIO TAG: direction for a voice that can act on it — ElevenLabs v3 and
 * v4's `[whispers]`, `[laughs]`, `[excited]`, `[door slams]`. Square brackets
 * around words and nothing else (letters, spaces, a hyphen or an apostrophe),
 * so `[1]`, `[ ]` and `[2024]` stay prose. The markers are not tags — they
 * are read first (`canonMarks`) and never reach this.
 */
const AUDIO_TAG = /\[\s*\p{L}[\p{L}' -]{0,38}\]/gu;
const ONLY_TAGS = /^(?:\[\s*\p{L}[\p{L}' -]{0,38}\]\s*)+$/u;

/** The text as an engine that CANNOT act on audio tags should hear it: every tag taken out, never read aloud. */
export const stripAudioTags = (text) => String(text ?? '').replace(AUDIO_TAG, ' ')
  .replace(/[ \t]+/g, ' ').replace(/ ([.,;:!?…])/g, '$1').trim();

/** Each audio tag in `text` replaced by `fn(words)` — how a view shows one as a cue, not as prose. */
export const markAudioTags = (text, fn) => String(text ?? '').replace(AUDIO_TAG, (m) => fn(m.slice(1, -1).trim()));

/** What an engine is sent: tags kept for one that acts on them (`audioTags`), taken out for any other. */
export const forEngine = (engine, text) => (engine?.audioTags ? String(text ?? '') : stripAudioTags(text));

/** The text with every ⟨PAUSE⟩ gone — what is spoken, captioned, subtitled. */
export const stripPauses = (text) => String(text ?? '').replaceAll(PAUSE_MARK, ' ');

/** What of a text is words: every ⟨PAUSE⟩ gone, whitespace flat. */
export const spoken = (text) => stripPauses(text).replace(/\s+/g, ' ').trim();

/** What of a text is SAID, for a caption or a subtitle: `spoken`, and no audio tag — tags are direction, not words. */
export const captioned = (text) => stripAudioTags(spoken(text));

/**
 * Is there anything here to TAKE? Words, not direction: a beat that is only
 * `[pause]`s and audio tags has no take of its own on any engine — direction
 * needs words to direct. Engine-blind on purpose: the runtime predicts the
 * recorder's file names with it (`segmentFileIndex`), so a take cannot exist
 * for one voice and not another.
 */
export const hasWords = (text) => captioned(text) !== '';

/**
 * A text cut at its ⟨PAUSE⟩ markers: `runs` are the stretches of words, each
 * with the number of markers that FOLLOW it; `lead` counts the markers before
 * any word at all.
 *
 * Every ⟨PAUSE⟩ belongs to the words before it — between two sentences,
 * attached to one, or standing on its own line — except the ones before the
 * first word, which hold before it. That difference is what keeps
 * `A. ⟨PAUSE⟩ ⟨CLICK⟩ B.` (hold, then reveal) apart from
 * `A. ⟨CLICK⟩ ⟨PAUSE⟩ B.` (reveal, then hold). A marker mid-sentence cuts the
 * sentence there: the author put the silence exactly where they wanted it.
 */
export function speechRuns(text) {
  const runs = [];
  let lead = 0;
  String(text ?? '').split(PAUSE_MARK).forEach((p, j) => {
    if (j > 0) { if (runs.length) runs[runs.length - 1].pause++; else lead++; }
    const words = p.replace(/\s+/g, ' ').trim();
    if (words) runs.push({ text: words, pause: 0 });
  });
  return { lead, runs };
}
