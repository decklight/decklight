// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A deck in several languages, the part that needs no model (SPEC
 * TRANSLATIONS): what is translated in a slide (TRANSLATION_UNITS), the record
 * of what each piece was translated from (TRANSLATION_RECORD), matching the
 * source against that record to say what is behind, and writing the
 * translation, which is the source with its words replaced.
 *
 * Everything here is pure: strings in, strings and plain objects out. The
 * command (cli/translate.mjs) reads and writes the files and asks the agent.
 *
 * WHY THE SOURCE'S STRUCTURE IS RE-READ EVERY TIME. A translation is never
 * edited into shape: `talk.fr.html` is `talk.html` with each unit's text
 * replaced, so a slide moved, restyled or rebuilt in the source is moved,
 * restyled or rebuilt in French by the next run, at no model cost when its
 * words did not change. The record is what makes "did its words change"
 * a string comparison rather than a question for a model.
 */

import { createHash } from 'node:crypto';
import { NOTES_ASIDE, decodeNoteEntities, readNotes, sectionCloseIndex, deckLang } from '../tools/deck-html.mjs';
import { CLICK_MARK, hasWords } from '../tools/sentences.mjs';
import { textRuns } from './rewrite.mjs';
import { deckTitle, setDeckTitle, withConfigKeys } from './runtime-link.mjs';

export const RECORD_VERSION = 1;

/** The attributes whose words are a slide's (TRANSLATION_UNITS `attr`). */
export const UNIT_ATTRS = ['alt', 'aria-label', 'title', 'data-title', 'data-module', 'data-steps', 'data-step'];

const LETTER = /\p{L}/u;
const blank = (s, re) => String(s).replace(re, (m) => ' '.repeat(m.length));
const encText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encAttr = (s) => encText(s).replace(/"/g, '&quot;');

/**
 * One beat of notes as text: tags gone (a `<br>` a line break, a closing `<p>`
 * a paragraph), entities read, markers in the square brackets decklight
 * writes, paragraphs a blank line apart, every other run of space one space.
 */
export function beatText(part) {
  const s = decodeNoteEntities(String(part ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/?(?:p|div|li|ul|ol|h\d|tr|td|th|table|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/⟨(\/?)([A-Z][A-Z ]*)⟩/g, (m, close, word) => `[${close}${word.toLowerCase()}]`);
  return s.split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

/** A chart's strings a reader sees, by path: labels, series names, axis titles, marker, threshold and now labels. */
function chartStrings(obj) {
  const out = [];
  const take = (holder, key) => {
    if (typeof holder?.[key] === 'string' && LETTER.test(holder[key])) out.push({ holder, key });
  };
  if (Array.isArray(obj.labels)) obj.labels.forEach((_, i) => take(obj.labels, i));
  take(obj, 'x'); take(obj, 'y'); take(obj, 'title');
  if (obj.threshold && typeof obj.threshold === 'object') take(obj.threshold, 'label');
  if (obj.now && typeof obj.now === 'object') take(obj.now, 'label');
  for (const s of Array.isArray(obj.series) ? obj.series : []) {
    if (!s || typeof s !== 'object') continue;
    take(s, 'name');
    for (const m of Array.isArray(s.markers) ? s.markers : []) if (m && typeof m === 'object') take(m, 'label');
  }
  return out;
}

/** A chart's references to a label by its text (`at`, `dashFrom`, `now`), so they follow a translated label. */
function chartRefs(obj) {
  const out = [];
  const ref = (holder, key) => { if (typeof holder?.[key] === 'string') out.push({ holder, key }); };
  ref(obj, 'now');
  if (obj.now && typeof obj.now === 'object') ref(obj.now, 'at');
  for (const s of Array.isArray(obj.series) ? obj.series : []) {
    if (!s || typeof s !== 'object') continue;
    ref(s, 'dashFrom');
    for (const m of Array.isArray(s.markers) ? s.markers : []) if (m && typeof m === 'object') ref(m, 'at');
  }
  return out;
}

/**
 * A section body (`sectionBodies`: the rest of the open tag, the inside, the
 * close and whatever follows) as units and the edits that write them back:
 * `{ units: [{ kind, text }], edits: [{ start, end, make(texts) }] }`. The
 * units are in the order TRANSLATION_UNITS gives: runs, beats, attributes,
 * labels. The edits never overlap. Pure.
 */
export function slideParts(body) {
  const src = String(body ?? '');
  const open = src.indexOf('>');
  const closeAt = sectionCloseIndex(src);
  const to = closeAt < 0 ? src.length : closeAt;
  const from = open + 1;
  const inner = src.slice(from, to);
  const units = [];
  const edits = [];
  const add = (kind, text) => { units.push({ kind, text }); return units.length - 1; };

  // runs: the text the audience reads, cut exactly as the writing tools cut it
  for (const r of textRuns(inner)) {
    const i = add('run', r.text);
    edits.push({ start: from + r.start, end: from + r.end, make: (T) => encText(T[i]) });
  }

  // beats: the notes cut at [click]; the markers are not units, so a
  // translated slide has the source's beats by construction
  const aside = NOTES_ASIDE.exec(inner);
  if (aside) {
    const aStart = from + aside.index + aside[0].indexOf('>') + 1;
    const aEnd = aStart + aside[1].length;
    const parts = readNotes(aside[1]).split(CLICK_MARK).map(beatText);
    const ids = parts.map((p) => (hasWords(p) ? add('beat', p) : -1));
    edits.push({
      start: aStart, end: aEnd,
      // indented under the aside, the way a person writes notes
      make: (T) => {
        const ind = /(?:^|\n)([ \t]*)[^\n]*$/.exec(src.slice(0, aStart))?.[1] ?? '';
        const at = `\n${ind}  `;
        const beat = (k) => encText(ids[k] >= 0 ? T[ids[k]] : parts[k]).split('\n').join(at).replace(new RegExp(`${at}(?=${at})`, 'g'), '\n');
        return `${at}${parts.map((_, k) => beat(k)).join(`${at}[click]${at}`)}\n${ind}`;
      },
    });
  }

  // attributes, the section's own open tag first
  const scan = blank(src.slice(0, to),
    /<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<aside class="notes">[\s\S]*?<\/aside>/gi);
  const tags = [{ index: 0, text: scan.slice(0, from) }];
  for (const m of scan.slice(from).matchAll(/<[a-zA-Z][^>]*>/g)) tags.push({ index: from + m.index, text: m[0] });
  const attrRe = new RegExp(`\\s(${UNIT_ATTRS.join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi');
  for (const tag of tags) {
    for (const m of tag.text.matchAll(attrRe)) {
      const name = m[1].toLowerCase();
      const raw = m[2] ?? m[3] ?? '';
      const vStart = tag.index + m.index + m[0].length - 1 - raw.length;
      const vEnd = vStart + raw.length;
      const value = decodeNoteEntities(raw);
      if (name === 'data-steps') {
        const items = value.split(',').map((x) => x.trim());
        const ids = items.map((x) => (LETTER.test(x) ? add('attr', x) : -1));
        if (ids.some((i) => i >= 0)) edits.push({ start: vStart, end: vEnd, make: (T) => encAttr(items.map((x, k) => (ids[k] >= 0 ? T[ids[k]] : x)).join(', ')) });
      } else if (LETTER.test(value)) {
        const i = add('attr', value.trim());
        edits.push({ start: vStart, end: vEnd, make: (T) => encAttr(T[i]) });
      }
    }
  }

  // labels: the words drawn in an SVG diagram …
  const plain = blank(inner, /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi);
  for (const svg of plain.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)) {
    const base = from + svg.index;
    let at = 0;
    const text = svg[0];
    for (const t of [...text.matchAll(/<[^>]+>/g), { index: text.length, 0: '' }]) {
      const piece = text.slice(at, t.index);
      if (LETTER.test(piece)) {
        const lead = piece.match(/^\s*/)[0].length;
        const trail = piece.match(/\s*$/)[0].length;
        const i = add('label', decodeNoteEntities(piece.slice(lead, piece.length - trail)));
        const s = base + at + lead;
        edits.push({ start: s, end: base + at + piece.length - trail, make: (T) => encText(T[i]) });
      }
      at = t.index + t[0].length;
    }
  }
  // … and in a chart's JSON
  for (const sc of inner.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/application\/json/i.test(sc[1]) || /data-decklight-config/i.test(sc[1])) continue;
    let obj;
    try { obj = JSON.parse(sc[2]); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !(obj.labels || obj.series)) continue;
    const strings = chartStrings(obj);
    if (!strings.length) continue;
    const ids = strings.map(({ holder, key }) => add('label', holder[key].trim()));
    const sStart = from + sc.index + sc[0].indexOf('>') + 1;
    edits.push({
      start: sStart, end: sStart + sc[2].length,
      make: (T) => {
        const copy = JSON.parse(sc[2]);
        const was = new Map();
        chartStrings(copy).forEach(({ holder, key }, k) => { was.set(holder[key], T[ids[k]]); holder[key] = T[ids[k]]; });
        for (const { holder, key } of chartRefs(copy)) if (was.has(holder[key])) holder[key] = was.get(holder[key]);
        return `\n${JSON.stringify(copy)}\n`;
      },
    });
  }
  return { units, edits };
}

/** A section body's units. Pure. */
export const slideUnits = (body) => slideParts(body).units;

/** A section body with `texts[i]` written into unit i. Pure. */
export function writeSlide(body, texts) {
  const { edits } = slideParts(body);
  let out = String(body ?? '');
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.make(texts) + out.slice(e.end);
  return out;
}

/**
 * A slide's shape, hashed: the section with every unit's text taken out. Two
 * slides with the same shape differ only in words, so a translation whose
 * slide no longer has the shape it was written with was changed in more than
 * its words, and `decklight translate` will not overwrite that silently.
 */
export function slideShape(body) {
  const n = slideUnits(body).length;
  const written = writeSlide(body, Array.from({ length: n }, () => '•'));
  return createHash('sha1').update(written.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** The bodies of a deck's sections, cut so they can be written back: `[preamble, '<section', body, …]`. */
export const deckParts = (html) => String(html ?? '').split(/(<section\b)/);
const bodiesOf = (parts) => parts.filter((_, i) => i >= 2 && i % 2 === 0);

/** Every slide's units, and the deck's own (its title). Pure. */
export function deckUnits(html) {
  const title = deckTitle(html);
  return {
    deck: LETTER.test(title) ? [{ kind: 'title', text: title }] : [],
    slides: bodiesOf(deckParts(html)).map(slideUnits),
  };
}

/** A new, empty record for `lang`, translated from `source`. */
export const emptyRecord = (source, from, lang) => ({ version: RECORD_VERSION, source, from: from ?? null, lang, glossary: {}, deck: [], slides: [], structure: [] });

/** Read a record's text; a broken one is an error the caller reports, never an empty record. */
export function parseRecord(text) {
  const r = JSON.parse(text);
  if (!r || typeof r !== 'object' || !Array.isArray(r.slides)) throw new Error('not a translation record (no "slides")');
  if (r.version !== RECORD_VERSION) throw new Error(`a translation record of version ${r.version}, and this decklight reads ${RECORD_VERSION}`);
  return { glossary: {}, deck: [], structure: [], ...r };
}

/**
 * The record as it is written: one unit per line, so a re-translated sentence
 * is a one-line diff. Stable key order.
 */
export function formatRecord(r) {
  const unit = (u) => `      ${JSON.stringify(u)}`;
  const slides = r.slides.map((s) => (s.length ? `    [\n${s.map(unit).join(',\n')}\n    ]` : '    []'));
  return `{\n  "version": ${r.version},\n  "source": ${JSON.stringify(r.source)},\n  "from": ${JSON.stringify(r.from)},\n  "lang": ${JSON.stringify(r.lang)},\n`
    + `  "glossary": ${JSON.stringify(r.glossary ?? {})},\n`
    + `  "deck": [${(r.deck ?? []).map((u) => `\n    ${JSON.stringify(u)}`).join(',')}${r.deck?.length ? '\n  ' : ''}],\n`
    + `  "structure": ${JSON.stringify(r.structure ?? [])},\n`
    + (Array.isArray(r.overflow) ? `  "overflow": ${JSON.stringify(r.overflow)},\n` : '')
    + `  "slides": [\n${slides.join(',\n')}\n  ]\n}\n`;
}

const live = (p) => p && p.state !== 'pending';

/**
 * Read back a person's corrections (TRANSLATION_RECORD): every unit of the
 * translation whose text is no longer the record's `target` was edited by
 * somebody, so the record takes the new text, `reviewed`. A slide whose shape
 * is not the one the record wrote is a structural change, listed in
 * `structure` and left alone. Returns `{ record, corrected, structure }`.
 */
export function readBack(record, translationHtml) {
  const next = { ...record, deck: [...(record.deck ?? [])], slides: record.slides.map((s) => s.map((u) => ({ ...u }))) };
  const structure = [];
  let corrected = 0;
  if (!translationHtml) return { record: next, corrected, structure };
  const bodies = bodiesOf(deckParts(translationHtml));
  if (bodies.length !== next.slides.length) structure.push({ slide: null, why: `it has ${bodies.length} slides, and it was written with ${next.slides.length}` });
  const take = (u, text) => {
    if (u.target === text) return u;
    corrected++;
    return { kind: u.kind, state: 'reviewed', source: u.source, target: text };
  };
  bodies.forEach((body, i) => {
    const R = next.slides[i];
    if (!R) return;
    if (next.structure?.[i] && slideShape(body) !== next.structure[i]) { structure.push({ slide: i + 1, why: 'it was changed in more than its words' }); return; }
    const T = slideUnits(body);
    if (T.length !== R.length || T.some((u, k) => u.kind !== R[k].kind)) { structure.push({ slide: i + 1, why: 'its words are not the ones it was written with' }); return; }
    next.slides[i] = R.map((u, k) => take(u, T[k].text));
  });
  const title = deckTitle(translationHtml);
  if (next.deck[0] && title && title !== next.deck[0].target) next.deck[0] = take(next.deck[0], title);
  return { record: next, corrected, structure };
}

/**
 * The source's units matched against the record (TRANSLATION_RECORD): each
 * unit `current` (with the record's target and state), `changed` (with the
 * previous version, which goes to the model) or `missing`. Slides are matched
 * by what they say, a record slide claimed once; a unit not on its matched
 * slide is looked up across the record. Pure.
 *
 * Returns `{ deck: [unit], slides: [[unit]] }`, each unit
 * `{ kind, text, status, target, state, previous }`.
 */
export function matchRecord(source, record) {
  const R = record.slides ?? [];
  const key = (kind, text) => `${kind}\u0000${text}`;
  const global = new Map();
  for (const slide of R) for (const p of slide) {
    if (!live(p)) continue;
    const k = key(p.kind, p.source);
    const had = global.get(k);
    if (!had || (had.state !== 'reviewed' && p.state === 'reviewed')) global.set(k, p);
  }
  for (const p of record.deck ?? []) if (live(p)) global.set(key(p.kind, p.source), p);
  const inSource = new Set();
  for (const s of source.slides) for (const u of s) inSource.add(key(u.kind, u.text));
  for (const u of source.deck) inSource.add(key(u.kind, u.text));

  const has = (slide, u) => slide.some((p) => live(p) && p.kind === u.kind && p.source === u.text);
  const claimed = new Set();
  const match = source.slides.map(() => -1);
  const claim = (i, j) => { match[i] = j; claimed.add(j); };
  // the same units, all of them; then most of them; then the slide in the same place
  source.slides.forEach((S, i) => {
    if (!S.length) return;
    const j = R.findIndex((slide, jj) => !claimed.has(jj) && slide.length === S.length && S.every((u) => has(slide, u)));
    if (j >= 0) claim(i, j);
  });
  source.slides.forEach((S, i) => {
    if (match[i] >= 0 || !S.length) return;
    let best = -1, score = 0;
    R.forEach((slide, j) => {
      if (claimed.has(j)) return;
      const n = S.filter((u) => has(slide, u)).length;
      if (n > score) { best = j; score = n; }
    });
    if (best >= 0) claim(i, best);
  });
  source.slides.forEach((S, i) => { if (match[i] < 0 && R[i] && !claimed.has(i)) claim(i, i); });

  const resolve = (u, M, place) => {
    const own = M?.find((p) => live(p) && p.kind === u.kind && p.source === u.text);
    const found = own ?? global.get(key(u.kind, u.text));
    if (found) return { ...u, status: 'current', target: found.target, state: found.state };
    const there = M?.filter((p) => p.kind === u.kind)[place];
    if (there?.state === 'pending' && there.was) return { ...u, status: 'changed', previous: there.was };
    if (there && live(there) && !inSource.has(key(there.kind, there.source))) {
      return { ...u, status: 'changed', previous: { source: there.source, target: there.target, state: there.state } };
    }
    return { ...u, status: 'missing' };
  };
  const placed = (units, M) => {
    const seen = {};
    return units.map((u) => { const place = seen[u.kind] = (seen[u.kind] ?? -1) + 1; return resolve(u, M, place); });
  };
  return {
    deck: placed(source.deck, record.deck ?? []),
    slides: source.slides.map((S, i) => placed(S, match[i] >= 0 ? R[match[i]] : null)),
  };
}

/** A unit still behind, as the translation shows it: its previous translation, else the source's own text. */
export const placeholder = (u) => (u.status === 'changed' ? u.previous.target : u.text);

/** The text written into the translation for a matched unit. */
export const writtenText = (u) => (u.status === 'current' || u.status === 'translated' ? u.target : placeholder(u));

/** A matched unit as the record keeps it. */
export function recordUnit(u) {
  if (u.status === 'current' || u.status === 'translated') return { kind: u.kind, state: u.state ?? 'machine', source: u.text, target: u.target };
  return { kind: u.kind, state: 'pending', source: u.text, target: placeholder(u), ...(u.status === 'changed' ? { was: { source: u.previous.source, target: u.previous.target } } : {}) };
}

/** Is `lang` written right to left? From its likely script (Intl), so `ar`, `he`, `fa`, `ur` and their regions are. */
export function isRtl(lang) {
  try { return ['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg'].includes(new Intl.Locale(lang).maximize().script); } catch { return false; }
}

/** `<html>` with `lang` set, and `dir="rtl"` for a language written right to left (a `dir` already there is replaced). */
export function withHtmlLang(html, lang) {
  return String(html).replace(/<html\b([^>]*)>/i, (m, attrs) => {
    let a = attrs.replace(/\s(?:lang|dir)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    a += ` lang="${encAttr(lang)}"`;
    if (isRtl(lang)) a += ' dir="rtl"';
    return `<html${a}>`;
  });
}

/**
 * `html` with its languages linked in `<head>`: one `<link rel="alternate"
 * hreflang href>` per language of the deck, the one on screen included, in
 * place of any decklight wrote before. They are what the language switch
 * reads in a translation (TRANSLATION_SWITCH), and what a search engine reads
 * of a published one.
 */
export function withAlternates(html, links) {
  const s = String(html).replace(/[ \t]*<link\b[^>]*\bdata-decklight-lang\b[^>]*>\r?\n?/gi, '');
  if (!links?.length) return s;
  const head = /<head\b[^>]*>/i.exec(s);
  if (!head) return s;
  const at = head.index + head[0].length;
  const indent = /\n([ \t]*)\S/.exec(s.slice(at))?.[1] ?? '  ';
  const tags = links.map((l) => `\n${indent}<link rel="alternate" hreflang="${encAttr(l.lang)}" href="${encAttr(l.href)}" data-decklight-lang>`).join('');
  return s.slice(0, at) + tags + s.slice(at);
}

/**
 * The translation, written: the source with each unit's text replaced, its
 * `<html lang>` (and `dir`), its title, and `translationOf` in its
 * configuration (`languages` is the source's to keep). Returns `{ html,
 * structure }`, `structure` each slide's shape as written, for the record.
 */
export function renderTranslation(sourceHtml, matched, { lang, sourceName, alternates = null }) {
  const parts = deckParts(sourceHtml);
  let s = 0;
  for (let i = 2; i < parts.length; i += 2) {
    const units = matched.slides[s++] ?? [];
    parts[i] = writeSlide(parts[i], units.map(writtenText));
  }
  let html = withHtmlLang(parts.join(''), lang);
  if (matched.deck[0]) html = setDeckTitle(html, writtenText(matched.deck[0]));
  html = withConfigKeys(html, { translationOf: sourceName, languages: null }) ?? html;
  if (alternates) html = withAlternates(html, alternates);
  return { html, structure: bodiesOf(deckParts(html)).map(slideShape) };
}

/** The record a run writes, from the matched (and translated) units. */
export function nextRecord(previous, matched, structure) {
  return {
    ...previous,
    version: RECORD_VERSION,
    deck: matched.deck.map(recordUnit),
    slides: matched.slides.map((S) => S.map(recordUnit)),
    structure,
  };
}

/**
 * How far behind a language is: units `current`, `changed`, `missing` and
 * `reviewed` (current and read by a person), with the slides that are
 * behind. Pure.
 */
export function languageStatus(matched) {
  const count = { current: 0, changed: 0, missing: 0, reviewed: 0, total: 0 };
  const behind = [];
  const tally = (u) => {
    count.total++;
    const st = u.status === 'translated' ? 'current' : u.status;
    count[st]++;
    if (st === 'current' && u.state === 'reviewed') count.reviewed++;
  };
  matched.deck.forEach(tally);
  matched.slides.forEach((S, i) => {
    S.forEach(tally);
    if (S.some((u) => u.status === 'changed' || u.status === 'missing')) behind.push(i + 1);
  });
  return { ...count, behind, up: count.changed + count.missing === 0 };
}

/** The language a deck is written in, for the record's `from`. */
export const sourceLang = (html) => deckLang(html);

/** A language's name in its own language (`Français`), else the tag. */
export function languageName(tag, { in: where = tag } = {}) {
  try {
    const n = new Intl.DisplayNames([where], { type: 'language' }).of(tag);
    return n ? n[0].toLocaleUpperCase(where) + n.slice(1) : tag;
  } catch { return tag; }
}
