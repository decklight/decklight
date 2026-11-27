// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a deck's languages live, and what `decklight check` says about them
 * (SPEC TRANSLATIONS). Kept apart from cli/translate.mjs so that check, which
 * starts no agent, does not load the agent machinery to read a record.
 *
 *   talk.html                    the source
 *   talk.fr.html                 the French, written by decklight translate
 *   talk.fr.translation.json     the record it was written from
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { deckConfig } from './runtime-link.mjs';
import { deckFamily } from '../tools/deck-family.mjs';
import { deckLang, sectionBodies, sectionInner, slideHeading, slideName } from '../tools/deck-html.mjs';
import { deckUnits, languageName, languageStatus, matchRecord, parseRecord, readBack } from './translate-core.mjs';

/** `talk.html` → `{ stem: 'talk', ext: '.html' }`. */
export const splitName = (name) => { const m = /^(.*?)(\.html?)$/i.exec(name); return m ? { stem: m[1], ext: m[2] } : { stem: name, ext: '.html' }; };

/** Where a language of `sourcePath` lives: its deck and its record. */
export function languageFiles(sourcePath, lang) {
  const dir = dirname(sourcePath);
  const { stem, ext } = splitName(basename(sourcePath));
  return { deck: join(dir, `${stem}.${lang}${ext}`), record: join(dir, `${stem}.${lang}.translation.json`) };
}

/** A translation's own record: `talk.fr.html` → `talk.fr.translation.json`. */
export const recordOf = (translationPath) => join(dirname(translationPath), `${splitName(basename(translationPath)).stem}.translation.json`);

/** The languages a source has: its configuration's `languages`, and every record on disk beside it. */
export function knownLanguages(sourcePath, html, { list = (d) => readdirSync(d) } = {}) {
  const cfg = deckConfig(html);
  const named = Array.isArray(cfg?.languages) ? cfg.languages.filter((l) => typeof l === 'string') : [];
  const { stem } = splitName(basename(sourcePath));
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}\\.([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\\.translation\\.json$`, 'i');
  let found = [];
  try { found = list(dirname(sourcePath)).map((n) => re.exec(n)?.[1]).filter(Boolean); } catch { /* no folder */ }
  const seen = new Set();
  return [...named, ...found].filter((l) => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * The source for a deck: itself, or, for a translation (a deck named for a
 * language beside the deck it is the language of), that deck.
 */
export function resolveSource(deckPath) {
  const fam = deckFamily(deckPath);
  if (!fam.lang) return { source: deckPath, given: null };
  const src = fam.members.find((m) => m.lang === null);
  return src ? { source: join(dirname(deckPath), src.name), given: fam.lang } : { source: deckPath, given: null };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return `"${t.length > 60 ? `${t.slice(0, 59)}…` : t}"`; };

/** "on "Pricing" and slide 7": the slides named the way decklight names slides. */
export function slidesPhrase(html, numbers) {
  const bodies = sectionBodies(html);
  const names = numbers.slice(0, 4).map((n) => slideName(bodies[n - 1] ?? '') || `slide ${n}`);
  const more = numbers.length > 4 ? ` and ${plural(numbers.length - 4, 'other slide')}` : '';
  return names.length ? `on ${names.join(', ')}${more}` : '';
}

/**
 * A language of a source, read: the record and the translation as they are,
 * matched against the source. `{ lang, files, exists, record, back, matched,
 * status }`, or `{ error }` when the record cannot be read. No model.
 */
export function readLanguage(sourcePath, sourceHtml, lang, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const files = languageFiles(sourcePath, lang);
  if (!exists(files.deck) || !exists(files.record)) return { lang, files, exists: false };
  let record;
  try { record = parseRecord(read(files.record)); } catch (e) { return { lang, files, exists: true, error: e.message }; }
  const translation = read(files.deck);
  const back = readBack(record, translation);
  const base = back.structure.length ? { ...record, slides: [] } : back.record;
  const matched = matchRecord(deckUnits(sourceHtml), base);
  return { lang, files, exists: true, record, translation, back, matched, status: languageStatus(matched) };
}

/**
 * What `decklight check` says about a deck's languages (SPEC
 * TRANSLATION_RECORD). On a translation, errors: a piece made from words the
 * source no longer has (`translation-stale`), a piece not translated
 * (`translation-missing`), a slide changed in more than its words
 * (`translation-structure`), a language that is not the record's
 * (`translation-lang`), a record that cannot be read (`translation-record`).
 * On the source, a warning per language that is behind (`translation-behind`):
 * the source is not broken by having been edited. A deck with no languages
 * gets nothing. `finding` is check's constructor.
 */
export function translationFindings(path, html, { finding, read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const out = [];
  const bodies = sectionBodies(html);
  const head = (n) => (n ? slideHeading(sectionInner(bodies[n - 1] ?? ''), n - 1) : 'head');
  const fam = deckFamily(path);
  const fix = (src) => `run decklight translate ${basename(src)}`;

  if (fam.lang) {
    const rec = recordOf(path);
    if (!exists(rec)) return out;
    const { source } = resolveSource(path);
    if (source === path) return out;
    let record;
    try { record = parseRecord(read(rec)); } catch (e) {
      out.push(finding('error', 'translation-record', null, 'head', `${basename(rec)} cannot be read — ${e.message}`));
      return out;
    }
    const lang = deckLang(html);
    if (record.lang && (lang ?? '').toLowerCase() !== record.lang.toLowerCase()) {
      out.push(finding('error', 'translation-lang', null, 'head', `<html lang="${lang ?? ''}"> is not the language this file was translated into (${record.lang}): ${fix(source)} sets it`));
    }
    const back = readBack(record, html);
    for (const s of back.structure) {
      out.push(finding('error', 'translation-structure', s.slide, head(s.slide),
        `${s.why}: a translation takes its structure from ${basename(source)}. Make the change there, or run decklight translate ${basename(source)} --discard-structure`));
    }
    let sourceHtml;
    try { sourceHtml = read(source); } catch { return out; }
    const matched = matchRecord(deckUnits(sourceHtml), back.structure.length ? { ...record, slides: [] } : back.record);
    const say = (units, n) => {
      const stale = units.filter((u) => u.status === 'changed');
      const missing = units.filter((u) => u.status === 'missing');
      if (stale.length) out.push(finding('error', 'translation-stale', n, head(n), `${plural(stale.length, 'piece')} translated from words ${basename(source)} no longer has, such as ${quote(stale[0].text)} (it shows its previous translation): ${fix(source)}`));
      if (missing.length) out.push(finding('error', 'translation-missing', n, head(n), `${plural(missing.length, 'piece')} not translated, such as ${quote(missing[0].text)} (it shows the source's words): ${fix(source)}`));
    };
    if (!back.structure.length) {
      say(matched.deck, null);
      matched.slides.forEach((S, i) => say(S, i + 1));
    }
    return out;
  }

  for (const lang of knownLanguages(path, html)) {
    const l = readLanguage(path, html, lang, { read, exists });
    const name = `${languageName(lang, { in: 'en' })} (${basename(l.files.deck)})`;
    if (l.error) { out.push(finding('warn', 'translation-behind', null, 'head', `${name}: its record cannot be read — ${l.error}`)); continue; }
    if (!l.exists) { out.push(finding('warn', 'translation-behind', null, 'head', `${name} is listed in "languages" and not translated yet: ${fix(path)}`)); continue; }
    if (l.back.structure.length) { out.push(finding('warn', 'translation-behind', null, 'head', `${name} was changed in more than its words; decklight check ${basename(l.files.deck)} says where`)); continue; }
    const st = l.status;
    if (!st.up) out.push(finding('warn', 'translation-behind', null, 'head', `${name} is ${plural(st.changed + st.missing, 'piece')} behind ${slidesPhrase(html, st.behind)}: ${fix(path)}`));
  }
  return out;
}
