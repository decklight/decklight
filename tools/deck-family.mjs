// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck and the same deck in other languages, side by side in one folder:
// `talk.html`, `talk.fr.html`, `talk.pt-br.html` (SPEC PRESENTING_VOICE). They
// are one deck for the rules that count the decks in a folder, and each has
// its own narration: a take in French is not a track of the English deck.
//
// Nothing here is configured. A file is another language of a deck when its
// name says so AND its `<html lang>` agrees, so `talk.old.html` and
// `talk.min.html` are what they always were: other decks.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { deckLang } from './deck-html.mjs';

const TAG = '[a-z]{2,3}(?:-[a-z0-9]{2,8})*';
const SUFFIXED = new RegExp(`^(.+)\\.(${TAG})(\\.html?)$`, 'i');
const LANG_ROOT = new RegExp(`^voices-(${TAG})$`, 'i');

const primary = (tag) => String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0] || null;

/** The language a deck file is in, when its name carries one its `<html lang>` agrees with: `fr` for `talk.fr.html`. */
function suffixLang(dir, name) {
  const m = SUFFIXED.exec(name);
  if (!m) return null;
  let html;
  try { html = readFileSync(join(dir, name), 'utf8'); } catch { return null; }
  if (!/class\s*=\s*["'][^"']*\bdecklight\b/.test(html)) return null;
  return primary(deckLang(html)) === primary(m[2]) ? m[2].toLowerCase() : null;
}

/**
 * The deck's family: `{ lang, members }`.
 *
 * `lang` is this deck's own language when it is another language of a deck
 * beside it (`fr` for `talk.fr.html` next to `talk.html`), null for the deck
 * the others are languages of, and for a deck with no such company.
 * `members` are the OTHER files of the family: `[{ name, lang }]`, `lang`
 * null for the one with no language in its name.
 */
export function deckFamily(deckPath) {
  const dir = dirname(deckPath);
  const name = basename(deckPath);
  const m = SUFFIXED.exec(name);
  // `talk.fr.html` is a language of `talk.html` only when that deck is there
  const own = m && existsSync(join(dir, m[1] + m[3])) ? suffixLang(dir, name) : null;
  const stem = own ? m[1] : name.replace(/\.html?$/i, '');
  let names = [];
  try { names = readdirSync(dir); } catch { /* no folder, no family */ }
  const members = [];
  for (const n of names) {
    if (n === name) continue;
    if (own && new RegExp(`^${escapeRe(stem)}\\.html?$`, 'i').test(n)) { members.push({ name: n, lang: null }); continue; }
    const s = SUFFIXED.exec(n);
    if (!s || s[1] !== stem) continue;
    const lang = suffixLang(dir, n);
    if (lang) members.push({ name: n, lang });
  }
  return { lang: own, members };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The language a track was recorded in, as far as it says: its folder's
 * (`voices-fr/anna`), else the one its manifest was voiced in. Null for a
 * track that says nothing, which is every track recorded in English.
 */
export function trackLang(rel, manifest = null) {
  const top = String(rel ?? '').split(/[/\\]/).filter(Boolean)[0] ?? '';
  const m = LANG_ROOT.exec(top);
  if (m) return m[1].toLowerCase();
  return typeof manifest?.lang === 'string' && manifest.lang ? manifest.lang.toLowerCase() : null;
}

/**
 * Is the track at `rel` this deck's? Another language of a deck takes only
 * the tracks in its language. The deck the others are languages of takes
 * everything that is not one of theirs — so a deck with no family, which is
 * every deck before a second language exists, takes what it always took.
 */
export function ownsTrack(family, rel, manifest = null) {
  const lang = primary(trackLang(rel, manifest));
  if (family.lang) return lang === primary(family.lang);
  return !lang || !family.members.some((f) => f.lang && primary(f.lang) === lang);
}

/** Where a deck's new takes go: `voices`, or `voices-fr` for the French of a deck. */
export const tracksRoot = (family) => (family.lang ? `voices-${family.lang}` : 'voices');

/** The folder a deck is voiced into when nothing names one: `voiceover`, or `voices-fr/voiceover` for the French of a deck. */
export const defaultTrackDir = (deckPath) => {
  const family = deckFamily(deckPath);
  return family.lang ? `${tracksRoot(family)}/voiceover` : 'voiceover';
};

/** `manifest.json` in a folder, parsed, or null. */
export function readManifest(abs) {
  try { return JSON.parse(readFileSync(join(abs, 'manifest.json'), 'utf8')); } catch { return null; }
}
