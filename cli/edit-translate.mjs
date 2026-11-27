// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Languages…, the edit server's half (SPEC TRANSLATE_PANEL): a deck's
 * languages listed with what is behind, a run of `decklight translate`
 * started, followed and stopped, and a translation's slide marked read.
 *
 * A SECOND DOOR TO THE COMMAND, NOT A SECOND IMPLEMENTATION. A run is the
 * `decklight translate` a terminal would run, started as a child process: the
 * same matching, the same checks, the same report, its lines relayed to the
 * page as `translate` events. The list is `readLanguage`, which is what
 * `--status` and `decklight check` read. Nothing here asks a model.
 *
 * And the one refusal: a translation takes its structure from its source, so
 * the routes that change a slide's structure, its look or the deck's
 * configuration are refused on one, naming the file to make the change in.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { deckFamily } from '../tools/deck-family.mjs';
import { deckLang, sectionBodies, slideName } from '../tools/deck-html.mjs';
import { formatRecord, languageName, parseRecord } from './translate-core.mjs';
import { voiceFolders } from '../tools/voice-renumber.mjs';
import { slideNotes, staleSlides } from '../tools/narration-manifest.mjs';
import { knownLanguages, readLanguage, recordOf, resolveSource, slidesPhrase } from './translate-files.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'decklight.mjs');
const TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/**
 * The edit routes a translation refuses: everything that changes a slide's
 * structure, the deck's look or its configuration. Its words (the text and
 * notes editors, find and replace, the writing tools) stay open.
 */
export const STRUCTURAL_ROUTES = new Set([
  'slide', 'slide/attr', 'slide/background', 'slide/builds', 'slide/face', 'slide/hidden', 'slide/layout',
  'slide/template', 'slide/sources', 'timings', 'asset',
  'element/build', 'element/canvas', 'element/concept', 'element/concepts', 'element/connector', 'element/content',
  'element/duplicate', 'element/effect', 'element/geometry', 'element/group', 'element/image', 'element/insert',
  'element/join', 'element/move', 'element/options', 'element/order', 'element/paste', 'element/picture',
  'element/remove', 'element/shape', 'element/style', 'element/turn',
  'theme', 'theme/add', 'theme/mark', 'brand-themes', 'concepts', 'config', 'font/mark',
  'design-system/apply', 'design-system/mark', 'design-system/migrate',
].map((r) => `/deck/edit/${r}`));

/** Is the deck at `deckPath` a translation, and of which file? `{ source, lang }` or null. */
export function translationOf(deckPath) {
  const fam = deckFamily(deckPath);
  if (!fam.lang || !existsSync(recordOf(deckPath))) return null;
  const { source } = resolveSource(deckPath);
  return source === deckPath ? null : { source, lang: fam.lang };
}

/** Why `pathname` is refused on this deck, or null: `{ error, source }`, the source file's name to open. */
export function structureRefusal(deckPath, pathname) {
  if (!STRUCTURAL_ROUTES.has(pathname)) return null;
  const t = translationOf(deckPath);
  if (!t) return null;
  return {
    source: basename(t.source),
    error: `${basename(deckPath)} is the ${languageName(t.lang, { in: 'en' })} of ${basename(t.source)}, made from it by decklight translate: `
      + `change the slides in ${basename(t.source)}, and the next run brings the change here. This file takes edits to its words only`,
  };
}

/**
 * The recorded takes a language's script has moved away from: its own tracks
 * (voiceFolders, which keeps to the deck's language) whose manifest says a
 * slide was voiced from other notes than the translation has now.
 * `{ tracks, slides }`, or null when it has none.
 */
export function staleTakes(deckPath, html, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  const texts = slideNotes(html);
  const slides = new Set();
  let tracks = 0;
  for (const dir of voiceFolders(deckPath)) {
    let manifest;
    try { manifest = JSON.parse(read(join(dirname(deckPath), dir, 'manifest.json'))); } catch { continue; }
    const s = staleSlides(manifest, texts).stale;
    if (s.length) { tracks++; s.forEach((n) => slides.add(n)); }
  }
  return tracks ? { tracks, slides: [...slides].sort((a, b) => a - b) } : null;
}

/** What Languages… lists, for the deck at `deckPath`, from either side. No model. */
export function languagesList(deckPath, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  const t = translationOf(deckPath);
  const source = t?.source ?? deckPath;
  const sourceHtml = read(source);
  const langs = knownLanguages(source, sourceHtml);
  const languages = langs.map((lang) => {
    const l = readLanguage(source, sourceHtml, lang, { read });
    const row = { lang, name: languageName(lang), file: basename(l.files.deck), exists: l.exists };
    if (l.error) return { ...row, error: l.error };
    if (!l.exists) return row;
    const st = l.status;
    const overflow = Array.isArray(l.record.overflow) ? l.record.overflow : [];
    const stale = staleTakes(l.files.deck, l.translation, { read });
    return {
      ...row, up: st.up, changed: st.changed, missing: st.missing, reviewed: st.reviewed, total: st.total,
      behind: st.behind, behindPhrase: slidesPhrase(sourceHtml, st.behind), structure: l.back.structure.length > 0,
      corrected: l.back.corrected,
      overflow, overflowPhrase: slidesPhrase(l.translation, overflow),
      staleTakes: stale && { ...stale, phrase: slidesPhrase(l.translation, stale.slides) },
    };
  });
  const out = {
    ok: true, deck: basename(deckPath), source: basename(source), sourceLang: deckLang(sourceHtml),
    sourceName: languageName(deckLang(sourceHtml) ?? 'en'), isTranslation: !!t, lang: t?.lang ?? deckLang(sourceHtml), languages,
  };
  if (t) {
    // a translation lists the slides a person has not read yet
    const rec = parseRecord(read(recordOf(deckPath)));
    const bodies = sectionBodies(read(deckPath));
    out.unread = rec.slides.map((S, i) => ({ slide: i + 1, n: S.filter((u) => u.state === 'machine').length }))
      .filter((x) => x.n).map((x) => ({ ...x, name: slideName(bodies[x.slide - 1] ?? '') || `slide ${x.slide}` }));
  }
  return out;
}

/** A translation's slide as the record has it: each unit's source beside its translation. */
export function translationSlide(deckPath, slide, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  const rec = parseRecord(read(recordOf(deckPath)));
  const S = rec.slides[slide - 1];
  if (!S) return null;
  return S.map((u) => ({ kind: u.kind, source: u.source, target: u.target, state: u.state }));
}

/** Mark a translation's slide read: its `machine` units `reviewed`. Returns how many. */
export function markReviewed(deckPath, slide, { read = (p) => readFileSync(p, 'utf8'), write = writeFileAtomic } = {}) {
  const file = recordOf(deckPath);
  const rec = parseRecord(read(file));
  const S = rec.slides[slide - 1];
  if (!S) return null;
  let n = 0;
  rec.slides[slide - 1] = S.map((u) => (u.state === 'machine' ? (n++, { ...u, state: 'reviewed' }) : u));
  if (n) write(file, formatRecord(rec));
  return n;
}

/**
 * The routes, registered into the edit server's table. `spawnRun` is how a
 * run is started (a test hands in its own); it returns the child.
 */
export function registerTranslateRoutes(routes, {
  deckPath, broadcast = () => {}, spawnRun = (args) => spawn(process.execPath, [CLI, 'translate', ...args], {
    env: { ...process.env, DECKLIGHT_NO_UPDATE_CHECK: '1', DECKLIGHT_BANNER: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  }),
}) {
  let running = null;   // { child, langs }

  function listRoute({ json }) {
    try { return json(200, { ...languagesList(deckPath), running: running ? { langs: running.langs } : null }); }
    catch (e) { return json(500, { ok: false, error: String(e.message ?? e) }); }
  }

  function slideRoute({ url, json }) {
    const n = Number(url.searchParams.get('slide'));
    if (!translationOf(deckPath)) return json(409, { ok: false, error: 'this deck is not a translation' });
    const units = Number.isInteger(n) && n > 0 ? translationSlide(deckPath, n) : null;
    if (!units) return json(400, { ok: false, error: 'which slide? — a number of this deck' });
    return json(200, { ok: true, slide: n, units });
  }

  function runRoute({ body, json }) {
    if (running) return json(409, { ok: false, error: `a translation is already running (${running.langs.join(', ')})` });
    const { to, slides = null, agent = true } = JSON.parse(body || '{}');
    const langs = Array.isArray(to) ? to.filter((x) => typeof x === 'string') : [];
    if (!langs.length || !langs.every((l) => TAG.test(l))) return json(400, { ok: false, error: 'to: the languages, as tags (fr, pt-BR)' });
    if (slides !== null && !(Array.isArray(slides) && slides.every((n) => Number.isInteger(n) && n > 0))) return json(400, { ok: false, error: 'slides: slide numbers' });
    const source = translationOf(deckPath)?.source ?? deckPath;
    const args = [source, '--to', langs.join(','), '--from-server',
      ...(slides?.length ? ['--slides', slides.join(',')] : []), ...(agent === false ? ['--no-agent'] : [])];
    const child = spawnRun(args);
    running = { child, langs };
    broadcast('translate', { state: 'start', langs });
    let tail = '';
    const relay = (stream) => {
      let buf = '';
      stream?.on('data', (b) => {
        buf += String(b);
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines.map((l) => l.trimEnd()).filter(Boolean)) {
          tail = line;
          broadcast('translate', { state: 'line', text: line.replace(/^(?:decklight )?translate: /, '') });
        }
      });
    };
    relay(child.stdout); relay(child.stderr);
    child.on('close', (code) => {
      running = null;
      console.log(`  translate: ${tail || `finished (${code})`}`);
      broadcast('translate', { state: 'done', code, tail: tail.replace(/^(?:decklight )?translate: /, '') });
    });
    return json(200, { ok: true, started: true, langs });
  }

  function stopRoute({ json }) {
    if (!running) return json(200, { ok: true, stopped: false });
    // the slides in flight finish and what passed is written: the command
    // reads "stop" on its input when the server started it
    try { running.child.stdin?.write('stop\n'); } catch { running.child.kill(); }
    return json(200, { ok: true, stopped: true });
  }

  function reviewedRoute({ body, json }) {
    if (!translationOf(deckPath)) return json(409, { ok: false, error: 'this deck is not a translation' });
    const { slide } = JSON.parse(body || '{}');
    const n = Number.isInteger(slide) && slide > 0 ? markReviewed(deckPath, slide) : null;
    if (n === null) return json(400, { ok: false, error: 'which slide? — a number of this deck' });
    broadcast('translate', { state: 'reviewed', slide, n });
    return json(200, { ok: true, slide, marked: n });
  }

  routes.set('GET /deck/edit/translations', listRoute);
  routes.set('GET /deck/edit/translation/slide', slideRoute);
  routes.set('POST /deck/edit/translate', runRoute);
  routes.set('POST /deck/edit/translate/stop', stopRoute);
  routes.set('POST /deck/edit/translation/reviewed', reviewedRoute);
  return { running: () => running };
}

/**
 * After a save to a source, the languages it put behind: `[{ lang, name, n }]`
 * for each language that was up to date before the save and is not after.
 */
export function newlyBehind(deckPath, before, afterHtml) {
  if (translationOf(deckPath)) return [];
  const out = [];
  for (const lang of knownLanguages(deckPath, afterHtml)) {
    const was = readLanguage(deckPath, before, lang);
    const now = readLanguage(deckPath, afterHtml, lang);
    if (!was.exists || was.error || now.error) continue;
    if (was.status.up && !now.status.up) out.push({ lang, name: languageName(lang, { in: 'en' }), n: now.status.changed + now.status.missing });
  }
  return out;
}
