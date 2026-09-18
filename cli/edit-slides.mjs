// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The routes that CHANGE A SLIDE: notes, sources, rehearsed timings, layout,
// hidden, the four element-edit ones, whole slides (new, duplicate, delete,
// reorder), a dropped image and the `<img>` that points at it, and the
// narration track the recorder points the deck at (SPEC PRESENTING author
// mode).
//
// They came out of cli/edit.mjs because they are the one group in that server
// that needs almost nothing FROM it. Each is the same three steps — read the
// deck, run one pure `(html, …) → html` transform over it, put the result
// through `applyEdit` so `Z` takes it back — and between them they want four
// bindings, not the fifty editMain has in scope. Naming those four in a
// parameter list is what lets a handler be called from a test with a temp file
// and no socket at all, which is how the ones here are covered.
//
// `/edit/asset` is the one that is not a text transform at all — it writes an
// image file beside the deck — and it sits here because what an author does
// next is put that image on a slide, and the two halves of one drop should not
// be two files apart.
//
// The transforms themselves stay in edit.mjs: they are the deck-rewriting
// vocabulary the whole command shares (and what test/edit.test.mjs cites), so
// this file imports them rather than owning them — which makes the two modules
// a cycle, deliberately and STATICALLY. Not dynamically: edit.mjs ends in a
// top-level `await` (its isMain boot), so an `await import('./edit-slides.mjs')`
// from inside editMain would be waiting on an evaluation that is waiting on it,
// and the author server would come up to the agents line and hang there — which
// is exactly what it did. A static cycle has no such moment: every binding on
// both sides is a hoisted function declaration, and nothing is read until a
// request arrives.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import {
  notesTextToAside, setSlideNotes,
  sourcesToAside, setSlideSources,
  setSlideTiming, setSlideLayout, setSlideHidden,
  upsertNarrationTrack,
  locateElement, removeSlideElement, setSlideElementHtml, setSlideElementBuild, setElementStyles,
} from './edit.mjs';
import { oneline } from './git.mjs';
// The whole-slide and image transforms are NOT in edit.mjs with the rest: they
// are string surgery on a deck's sections, which is what tools/deck-html.mjs
// is, and nothing about them wants the server.
import {
  sectionBodies, insertBlankSlide, duplicateSlide, deleteSlide, swapSlides, insertImage,
} from '../tools/deck-html.mjs';

/**
 * Put the slide-mutation routes into `routes`, the table cli/edit.mjs
 * dispatches on, and hand it back.
 *
 * `ctx` is the whole of what these handlers may touch, written out rather than
 * closed over: `readDeck()` for the current file, `applyEdit()` for the one
 * door every mutation goes through (snapshot, then write), `history` for the
 * undo/redo counts every one of them reports back, and `deckPath` — the only
 * one that is not about the deck's TEXT — because a dropped image is saved
 * beside the deck and nowhere else.
 */
export function registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath }) {
  function notesRoute({ body, json }) {
    const { slide, text } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string') throw new Error('bad payload');
    applyEdit((html) => setSlideNotes(html, slide, notesTextToAside(text)));
    console.log(`  notes saved: slide ${slide} (${text.length} chars)`);
    return json(200, { ok: true, ...history.counts() });
  }

  // Where a slide got what it says, written back (SLIDE_SOURCES). One
  // applyEdit, so `Z` takes the whole card back the way it takes a note.
  function sourcesRoute({ body, json }) {
    const { slide, facts, links } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1) throw new Error('bad payload');
    const dropped = [];
    const inner = sourcesToAside({
      facts: Array.isArray(facts) ? facts : [],
      links: Array.isArray(links) ? links : [],
    }, dropped);
    const changed = applyEdit((html) => setSlideSources(html, slide, inner));
    if (changed) {
      console.log(`  sources saved: slide ${slide}`
        + (inner ? ` (${(facts ?? []).length} fact(s), ${(links ?? []).length} link(s))` : ' — cleared')
        + (dropped.length ? ` — refused ${dropped.join(', ')}` : ''));
    }
    return json(200, { ok: true, changed, dropped, ...history.counts() });
  }

  function timingsRoute({ body, json }) {
    // every slide's rehearsed time in ONE edit — one undo entry, one commit
    const { timings } = JSON.parse(body);
    if (!Array.isArray(timings) || !timings.every((t) => Number.isInteger(t?.slide) && t.slide >= 1 && Number.isFinite(t?.seconds))) throw new Error('bad payload');
    const changed = applyEdit((html) => timings.reduce((h, t) => setSlideTiming(h, t.slide, t.seconds), html));
    if (changed) console.log(`  rehearsal timings saved: ${timings.length} slides`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function layoutRoute({ body, json }) {
    const { slide, layout } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof layout !== 'string') throw new Error('bad payload');
    const changed = applyEdit((html) => setSlideLayout(html, slide, layout));
    if (changed) console.log(`  layout saved: slide ${slide} → ${layout}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function hiddenRoute({ body, json }) {
    const { slide, hidden } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof hidden !== 'boolean') throw new Error('bad payload');
    const changed = applyEdit((html) => setSlideHidden(html, slide, hidden));
    if (changed) console.log(`  slide ${slide} ${hidden ? 'hidden' : 'shown again'}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function narrationRoute({ body, json }) {
    const { files, ext, segments } = JSON.parse(body || '{}');
    // The same three shapes /edit/record refuses for a folder, refused
    // again here: this one is written INTO the deck, where a bad value is
    // not a failed request but a deck that no longer plays.
    if (typeof files !== 'string' || !files.trim() || files.length > 200
        || /^[/\\]/.test(files) || /^[a-zA-Z]:/.test(files)
        || files.split(/[/\\]/).includes('..')) {
      return json(400, { ok: false, error: 'bad narration folder' });
    }
    if (ext !== undefined && !/^[a-z0-9]{1,5}$/.test(String(ext))) {
      return json(400, { ok: false, error: 'bad ext' });
    }
    if (segments !== undefined && typeof segments !== 'boolean') {
      return json(400, { ok: false, error: 'bad segments' });
    }
    const { label } = JSON.parse(body || '{}');
    if (label !== undefined && (typeof label !== 'string' || label.length > 120)) {
      return json(400, { ok: false, error: 'bad label' });
    }
    // upsert, never replace: a deck carries as many tracks as you have
    // voices, and writing one must not throw the others away. Read here rather
    // than inside applyEdit because `null` is an ANSWER, not an edit — it has
    // to be looked at before anything is written.
    const before = readDeck();
    const next = upsertNarrationTrack(before, {
      label: label || files.trim(),
      dir: files.trim(),
      ...(ext === undefined ? {} : { ext }),
      ...(segments === undefined ? {} : { segments }),
    });
    if (next === null) {
      // Not a failure of this server — a deck whose config is built
      // somewhere else. Say which, so the answer is "paste this line",
      // not "it did not work".
      return json(409, { ok: false,
        error: 'this deck builds its config outside the Decklight.init(…) call, so there is no literal here to edit' });
    }
    const changed = applyEdit(next, before);
    if (changed) console.log(`  narration: ${files} in the deck's config`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  // ── element edit mode (E, right-click a slide element) — #112 ─────
  // Reads the element's outerHTML fresh from the FILE, never the live
  // DOM: the engine mutates elements in place (pinned-title classes,
  // namespaced SVG ids, chart/code/math subtree replacement), so the DOM
  // the player sees is not what a Save should write back over.
  function elementSourceRoute({ url, json }) {
    const slide = Number(url.searchParams.get('slide'));
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    try {
      const { parts, idx, r } = locateElement(readDeck(), slide, index);
      return json(200, { ok: true, html: parts[idx].slice(r.start, r.end) });
    } catch (e) {
      return json(404, { ok: false, error: oneline(e) });
    }
  }

  // The three that WRITE an element. Same door as layout and notes: a pure
  // (html, slide, index, …) → html transform, through applyEdit, onto the ONE
  // undo/redo stack.
  function elementRemoveRoute({ body, json }) {
    const { slide, index } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    const changed = applyEdit((html) => removeSlideElement(html, slide, index));
    if (changed) console.log(`  element removed: slide ${slide} #${index}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function elementContentRoute({ body, json }) {
    const { slide, index, html } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || typeof html !== 'string') {
      throw new Error('bad payload');
    }
    const changed = applyEdit((deck) => setSlideElementHtml(deck, slide, index, html));
    if (changed) console.log(`  element content saved: slide ${slide} #${index}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function elementEffectRoute({ body, json }) {
    const { slide, index, effect } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0
        || (effect !== null && typeof effect !== 'string')) {
      throw new Error('bad payload');
    }
    const changed = applyEdit((html) => setSlideElementBuild(html, slide, index, effect));
    if (changed) console.log(`  element effect saved: slide ${slide} #${index} → ${effect ?? '(removed)'}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /edit/element/style` — `{ slide, index, edits }`: the colour picker's
   * save (element edit mode → Colors…). One applyEdit for a shape's fill and
   * its text together, so `Z` takes the pair back in one press.
   */
  function elementStyleRoute({ body, json }) {
    const { slide, index, edits } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    let changed;
    try { changed = applyEdit((html) => setElementStyles(html, slide, index, edits)); }
    catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  element colours saved: slide ${slide} #${index} → ${edits.map((e) => `${e.prop} ${e.value}`).join(', ')}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  // ── whole slides: the slide bar's new · duplicate · delete · reorder ──────

  const SLIDE_OPS = new Set(['new', 'duplicate', 'delete', 'up', 'down']);

  /**
   * `POST /edit/slide` — `{ op, slide }`, one section moved, copied, made or
   * taken away.
   *
   * Every op is ONE applyEdit, so `Z` takes the whole thing back in one press:
   * a reorder is two sections changing places, and an undo that put one of
   * them back would be a deck in a state nobody typed.
   *
   * The answer carries `slide` — where the stage should BE afterwards — rather
   * than leaving the browser to work it out: the number moves differently for
   * every op (a new slide is the one you are now on, a delete at the end
   * leaves you on the new end), and two implementations of that arithmetic is
   * one too many.
   *
   * Numbering is by SOURCE ORDER, hidden slides counted (DECK_ANATOMY), which
   * is how comments, review anchors and history already number them.
   */
  function slideRoute({ body, json }) {
    const { op, slide } = JSON.parse(body || '{}');
    if (!SLIDE_OPS.has(op) || !Number.isInteger(slide) || slide < 1) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    const before = readDeck();
    const total = sectionBodies(before).length;
    if (slide > total) return json(404, { ok: false, error: `no slide ${slide} (deck has ${total})` });
    // The three refusals, said as sentences: a deck with no slides is not a
    // deck, and the ends of the list are the ends of the list.
    if (op === 'delete' && total === 1) return json(409, { ok: false, error: 'a deck needs at least one slide' });
    if (op === 'up' && slide === 1) return json(409, { ok: false, error: 'already the first slide' });
    if (op === 'down' && slide === total) return json(409, { ok: false, error: 'already the last slide' });

    const after = op === 'delete' ? total - 1 : (op === 'up' || op === 'down') ? total : total + 1;
    const show = {
      new: slide + 1,
      duplicate: slide + 1,
      delete: Math.min(slide, after),   // deleting the last slide leaves you on the new last
      up: slide - 1,
      down: slide + 1,
    }[op];
    applyEdit((html) => {
      switch (op) {
        case 'new': return insertBlankSlide(html, slide);
        case 'duplicate': return duplicateSlide(html, slide);
        case 'delete': return deleteSlide(html, slide);
        case 'up': return swapSlides(html, slide - 1, slide);
        default: return swapSlides(html, slide, slide + 1);
      }
    }, before);
    console.log(`  slide ${op}: ${slide} → ${after} slide${after === 1 ? '' : 's'}`);
    return json(200, { ok: true, slide: show, total: after, ...history.counts() });
  }

  // ── an image dropped on the stage ────────────────────────────────────────

  /**
   * What an author may drop, and the extension it is SAVED under. The
   * extension comes from the content type and never from the name the browser
   * sent: the name is the author's to choose, what the bytes ARE is not.
   */
  const IMAGE_TYPES = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
    ['image/webp', 'webp'], ['image/svg+xml', 'svg'], ['image/avif', 'avif'],
  ]);
  const MAX_ASSET_BYTES = 25e6;

  /**
   * The basename an upload is saved under: lower-case, `[a-z0-9._-]`, no
   * directory part and no extension of its own.
   *
   * Every character that could make this a PATH rather than a name is gone
   * before `resolve` ever sees it — a separator, a drive letter, a `..`, a
   * leading dot that would hide the file from `present`'s dotfile rule. The
   * containment check at the write is the second lock on the same door, not
   * the first.
   */
  function safeStem(name) {
    const leaf = String(name ?? '').split(/[/\\]/).pop();
    const stem = leaf.replace(/\.[a-z0-9]{1,8}$/i, '');
    const safe = stem.toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 60);
    return safe || 'image';
  }

  /**
   * `POST /edit/asset` — the raw bytes of an image dropped onto the stage,
   * saved into `assets/` beside the deck. Answers the `src` the caller then
   * hands to `POST /edit/image`.
   *
   * Ahead of the shared body read (`BEFORE_BODY` in cli/edit.mjs) for the same
   * reason `/edit/record` is: the body is BINARY and megabytes of it, so the
   * string concat and its 1 MB ceiling are both wrong. The size limit is
   * enforced on the way IN — `content-length` first when the browser declared
   * one, then the stream itself — because a limit that buffers 2 GB before
   * announcing it is a limit that costs more than it saves.
   *
   * SVG is accepted and NOTHING is stripped from it. A saved file is the
   * author's bytes, and an editor that silently rewrote them would be lying
   * about what is on the slide; if that SVG is ever inlined into the deck,
   * `decklight present --check` names its scripts like any other block, which
   * is the mechanism that exists for this (SPEC PRESENTING, the ingredients
   * label). What is refused is an SVG that arrives with a script already in
   * it — that is not an author's picture, and saving it would be putting a
   * payload one `<object>` away from the deck under the author's own hand.
   */
  async function assetRoute({ req, json }) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES.get(type);
    if (!ext) return json(415, { ok: false, error: `${type || 'that'} is not an image a slide can carry` });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      return json(413, { ok: false, error: 'image too large' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_ASSET_BYTES) return json(413, { ok: false, error: 'image too large' });
      chunks.push(chunk);
    }
    if (!size) return json(400, { ok: false, error: 'no image in the request body' });
    const buf = Buffer.concat(chunks);
    // latin1, not utf8: the needle is ASCII, and decoding byte-for-byte cannot
    // turn a stray sequence into a replacement character that hides it.
    if (ext === 'svg' && /<script/i.test(buf.toString('latin1'))) {
      return json(400, { ok: false, error: 'an SVG with a script is not an image' });
    }

    const dir = resolve(deckPath, '..', 'assets');
    const stem = safeStem(req.headers['x-decklight-name']);
    let name = `${stem}.${ext}`;
    try {
      mkdirSync(dir, { recursive: true });
      // De-duplicate by NAME, not by content: two pictures called `logo` are
      // two pictures, and overwriting the first would change a slide the
      // author was not editing. `wx` is what decides it — an existsSync ahead
      // of the write is a check that can go stale between the two lines.
      for (let i = 2; ; i++) {
        const at = resolve(dir, name);
        if (at !== resolve(dir, basename(at)) || !at.startsWith(dir + sep)) {
          return json(400, { ok: false, error: 'bad image name' });
        }
        try { writeFileSync(at, buf, { flag: 'wx' }); break; }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (i > 999) return json(409, { ok: false, error: `too many images called ${stem}` });
          name = `${stem}-${i}.${ext}`;
        }
      }
    } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
    console.log(`  image saved: assets/${name} (${Math.round(size / 1024)} kB)`);
    return json(200, { ok: true, src: `assets/${name}`, bytes: size });
  }

  /**
   * Is `src` a path this deck can carry? Relative, and only relative.
   *
   * A scheme is somebody else's server (or, for `javascript:` and `data:`,
   * somebody else's code); a leading slash is the serving root rather than the
   * folder the deck lives in, so it breaks the moment the deck is opened over
   * `file://` or published under a path; and `..` points outside what travels
   * with the file. A deck is one HTML file and what sits beside it
   * (DECK_ANATOMY), and an `<img>` the author cannot send anybody is worse
   * than a refusal.
   */
  const relativeSrc = (s) => typeof s === 'string' && !!s.trim()
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)
    && !/^[/\\]/.test(s)
    && !s.split(/[/\\]/).includes('..');

  /**
   * `POST /edit/image` — `{ slide, index, src, alt }`, an `<img>` onto a
   * slide, addressed by the same top-level child index every element route
   * uses (`sectionChildRanges`).
   *
   * `index: null` means "wherever it belongs on this slide": after the last
   * content child and before the asides, so a picture dropped on a slide that
   * has speaker notes lands on the slide instead of inside the notes, where
   * the audience would never see it.
   *
   * The answer names the new element's index, because everything after the
   * insertion has just shifted and the caller's next act is usually to open
   * element edit mode on what it just made.
   */
  function imageRoute({ body, json }) {
    const { slide, index = null, src, alt } = JSON.parse(body || '{}');
    const text = alt == null ? '' : alt;
    if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string'
        || (index !== null && (!Number.isInteger(index) || index < 0))) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    if (!relativeSrc(src)) {
      return json(400, { ok: false, error: 'an image src must be a relative path beside the deck' });
    }
    let at = null;
    try {
      applyEdit((html) => {
        const out = insertImage(html, slide, index, { src, alt: text });
        at = out.index;
        return out.html;
      });
    } catch (e) { return json(404, { ok: false, error: oneline(e) }); }
    console.log(`  image added: slide ${slide} #${at} → ${src}`);
    return json(200, { ok: true, index: at, ...history.counts() });
  }

  routes.set('POST /edit/notes', notesRoute);
  routes.set('POST /edit/sources', sourcesRoute);
  routes.set('POST /edit/timings', timingsRoute);
  routes.set('POST /edit/layout', layoutRoute);
  routes.set('POST /edit/hidden', hiddenRoute);
  routes.set('POST /edit/narration', narrationRoute);
  routes.set('GET /edit/element/source', elementSourceRoute);
  routes.set('POST /edit/element/remove', elementRemoveRoute);
  routes.set('POST /edit/element/content', elementContentRoute);
  routes.set('POST /edit/element/effect', elementEffectRoute);
  routes.set('POST /edit/element/style', elementStyleRoute);
  routes.set('POST /edit/slide', slideRoute);
  routes.set('POST /edit/asset', assetRoute);
  routes.set('POST /edit/image', imageRoute);
  return routes;
}
