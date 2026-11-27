// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// LETTER_BY_LETTER. The accessible label is the one complete sentence in a
// legacy title, including in translations whose visible slots got scrambled.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { deckFamily } from '../tools/deck-family.mjs';
import { decodeNoteEntities, elementChildRanges, sectionCloseIndex, splitOpenTag } from '../tools/deck-html.mjs';
import { escapeHtml } from '../tools/escape.mjs';
import { attrList, attrOf, withAttr, withStyle } from './edit-address.mjs';
import { deckParts, formatRecord, parseRecord, slideParts, slideShape } from './translate-core.mjs';
import { recordOf, resolveSource } from './translate-files.mjs';

const irrelevant = new Set(['aside', 'code', 'pre', 'script', 'style', 'svg', 'template', 'textarea']);
const inline = new Set(['span', 'b', 'i', 'em', 'strong', 'small', 'mark', 'u', 's', 'sub', 'sup']);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const oneGrapheme = (text) => !!text.trim() && graphemes.segment(text).containing(0)?.segment === text;
const timeIndex = /(?:^|;)\s*--i\s*:\s*\d+\s*(?=;|$)/;
const timeCount = /(?:^|;)\s*--n\s*:\s*\d+\s*(?=;|$)/;

function openParts(el) {
  const { attrs, close, rest } = splitOpenTag(el);
  return { attrs, open: attrs + close, rest };
}

function cleanChildren(el, open) {
  const kids = elementChildRanges(el);
  if (!kids.length) return null;
  let at = open.length;
  for (const { start, end, tag } of kids) {
    if (decodeNoteEntities(el.slice(at, start)).trim() || irrelevant.has(tag)) return null;
    at = end;
  }
  const close = el.lastIndexOf('</');
  return close >= at && !el.slice(at, close).trim() ? { kids, close } : null;
}

function legacyTitle(el, start, sourceAt) {
  const { attrs, open } = openParts(el);
  const label = attrList(attrs).find((a) => a.name === 'aria-label');
  const text = decodeNoteEntities(label?.value).trim();
  if (!text) return null;
  const parent = cleanChildren(el, open);
  if (!parent) return null;
  let total = 0;
  const timed = timeCount.test(attrOf(attrs, 'style') ?? '');
  const words = [];
  for (const w of parent.kids) {
    if (!inline.has(w.tag)) return null;
    const word = el.slice(w.start, w.end);
    const wrapped = cleanChildren(word, openParts(word).open);
    if (!wrapped) return null;
    let original = '';
    for (const c of wrapped.kids) {
      if (!inline.has(c.tag)) return null;
      const { attrs: letterAttrs, open: letterOpen, rest } = openParts(word.slice(c.start, c.end));
      const close = rest.indexOf('<');
      if (close < 0 || !rest.startsWith('</', close)) return null;
      const visible = decodeNoteEntities(rest.slice(0, close));
      const source = sourceAt?.get(start + w.start + c.start + letterOpen.length) ?? visible;
      if (!oneGrapheme(source) && !(timed && timeIndex.test(attrOf(letterAttrs, 'style') ?? ''))) return null;
      original += source;
      total++;
    }
    words.push(original);
  }
  if (total < 2 && !timed) return null;
  return { start, end: start + el.length, contentStart: start + open.length, contentEnd: start + parent.close,
    label, text, original: words.join(' '), attrs, close: el.slice(parent.close) };
}

function scan(body, sourceAt) {
  const titles = [], followers = [];
  if (!/aria-label\s*=/i.test(body)) return { titles, followers };
  const { attrs, close } = splitOpenTag(body);
  const from = attrs.length + close.length;
  const end = sectionCloseIndex(body);
  const section = `<section>${body.slice(from, end < 0 ? undefined : end)}</section>`;
  function visit(el, at, tag) {
    if (irrelevant.has(tag)) return;
    const title = legacyTitle(el, at, sourceAt);
    if (title) { titles.push(title); return; }
    const { attrs: opening } = openParts(el);
    if ((attrOf(opening, 'class') ?? '').split(/\s+/).includes('cf-after')) followers.push({ at, opening });
    for (const c of elementChildRanges(el)) visit(el.slice(c.start, c.end), at + c.start, c.tag);
  }
  for (const c of elementChildRanges(section)) visit(section.slice(c.start, c.end), from - '<section>'.length + c.start, c.tag);
  return { titles, followers };
}

export const legacyWriting = (body) => scan(body).titles.map((t) => t.text);

function classes(attrs, remove) {
  return (attrOf(attrs, 'class') ?? '').split(/\s+/).filter((c) => c && !remove.includes(c)).join(' ') || null;
}

function replacement(title) {
  const out = (attrOf(title.attrs, 'class') ?? '').split(/\s+/).includes('cf-write-out');
  let attrs = withAttr(title.attrs, 'class', classes(title.attrs, ['cf-write', 'cf-write-out']));
  attrs = withAttr(attrs, 'aria-label', null);
  if (timeCount.test(attrOf(attrs, 'style') ?? '')) attrs = withStyle(attrs, '--n', null);
  return `${withAttr(attrs, 'data-write', out ? 'out' : true)}>${escapeHtml(title.text)}${title.close}`;
}

function migrateSlide(body, record, hash) {
  const old = record ? slideParts(body) : null;
  const belongs = old && old.units.length === record.length && old.units.every((u, i) => u.kind === record[i].kind);
  const runEdits = old?.edits.filter((e) => old.units[e.units?.[0]]?.kind === 'run') ?? [];
  const sourceAt = belongs ? new Map(runEdits.map((e) => [e.start, record[e.units[0]].source])) : null;
  const { titles, followers } = scan(body, sourceAt);
  if (!titles.length) return { body, record, count: 0 };
  if (record && (!belongs || (hash && slideShape(body) !== hash))) {
    throw new Error('the slide differs structurally from its translation record');
  }
  const writes = titles.map((t) => ({ start: t.start, end: t.end, value: replacement(t) }));
  for (const { at, opening } of followers) {
    const attrs = withAttr(opening, 'class', classes(opening, ['cf-after']));
    writes.push({ start: at, end: at + opening.length, value: withAttr(attrs, 'data-write-after', true) });
  }
  let migrated = body;
  for (const { start, end, value } of writes.sort((a, b) => b.start - a.start)) {
    migrated = migrated.slice(0, start) + value + migrated.slice(end);
  }
  if (!record) return { body: migrated, count: titles.length };

  const removed = new Set();
  const insertions = new Map();
  for (const t of titles) {
    let labelPair;
    for (const e of old.edits) {
      if (e.start >= t.contentStart && e.end <= t.contentEnd) {
        for (const i of e.units ?? []) removed.add(i);
      } else if (e.start >= t.start + t.label.start && e.end <= t.start + t.label.end) {
        const i = e.units?.[0];
        if (i !== undefined) { removed.add(i); labelPair = record[i]; }
      }
    }
    const run = runEdits.find((e) => e.start >= t.contentStart)?.units[0] ?? runEdits.length;
    const pair = labelPair ? { ...labelPair, kind: 'run', target: t.text } :
      { kind: 'run', source: t.original, target: t.text, state: 'machine' };
    if (labelPair && labelPair.target !== t.text) { pair.state = 'reviewed'; delete pair.was; }
    const here = insertions.get(run) ?? [];
    here.push(pair);
    insertions.set(run, here);
  }
  const pairs = [...record, null].flatMap((pair, i) => [
    ...(insertions.get(i) ?? []), ...(pair && !removed.has(i) ? [pair] : []),
  ]);
  const after = slideParts(migrated);
  if (after.units.length !== pairs.length || after.units.some((u, i) => u.kind !== pairs[i].kind)) {
    throw new Error('could not align the converted text with its translation record');
  }
  return { body: migrated, count: titles.length, record: pairs, hash: slideShape(migrated) };
}

function planDeck(path, html, record) {
  const parts = deckParts(html);
  const slides = record?.slides.slice();
  const structure = record?.structure.slice();
  let count = 0;
  for (let at = 2; at < parts.length; at += 2) {
    const index = at / 2 - 1;
    let r;
    try { r = migrateSlide(parts[at], slides?.[index], structure?.[index]); }
    catch (e) { throw new Error(`${basename(path)}, slide ${index + 1}: ${e.message}`); }
    if (!r.count) continue;
    if (record && !slides[index]) throw new Error(`${basename(path)}, slide ${index + 1}: missing translation record`);
    count += r.count;
    parts[at] = r.body;
    if (record) { slides[index] = r.record; structure[index] = r.hash; }
  }
  return { html: parts.join(''), count, record: record && { ...record, slides, structure } };
}

/** Plan the whole family before writing. Restore earlier files if a write fails. */
export function migrateWriting(deck) {
  const { source } = resolveSource(deck);
  const paths = [source, ...deckFamily(source).members.filter((m) => m.lang).map((m) => join(dirname(source), m.name))];
  const writes = [];
  let count = 0;
  for (const path of paths) {
    const html = readFileSync(path, 'utf8');
    const recPath = recordOf(path);
    const rec = path !== source && existsSync(recPath) ? readFileSync(recPath, 'utf8') : null;
    const plan = planDeck(path, html, rec ? parseRecord(rec) : null);
    if (!plan.count) continue;
    count += plan.count;
    writes.push({ path, before: html, after: plan.html });
    if (rec) writes.push({ path: recPath, before: rec, after: formatRecord(plan.record) });
  }
  const done = [];
  try {
    for (const w of writes) {
      const current = readFileSync(w.path, 'utf8');
      if (current === w.after) continue;
      if (current !== w.before) throw new Error(`${basename(w.path)} changed during migration`);
      writeFileAtomic(w.path, w.after);
      done.push(w);
    }
  } catch (e) {
    const couldNotRestore = [];
    for (const w of done.reverse()) {
      try {
        if (readFileSync(w.path, 'utf8') !== w.after) throw new Error('file changed');
        writeFileAtomic(w.path, w.before);
      } catch { couldNotRestore.push(basename(w.path)); }
    }
    if (couldNotRestore.length) throw new Error(`${e.message}. Could not restore ${couldNotRestore.join(', ')}`);
    throw e;
  }
  return count;
}
