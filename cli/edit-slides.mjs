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
// `/deck/edit/asset` is the one that is not a text transform at all — it writes an
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
// and the edit server would come up to the agents line and hang there — which
// is exactly what it did. A static cycle has no such moment: every binding on
// both sides is a hoisted function declaration, and nothing is read until a
// request arrives.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

import {
  notesTextToAside, setSlideNotes,
  sourcesToAside, setSlideSources,
  setSlideTiming, setSlideLayout, setSlideHidden, setSlideFace,
  upsertNarrationTrack, configuredTrackDirs,
  removeSlideElement, setSlideElementHtml, setSlideElementBuild, setElementStyles, editedNodes, setElementAttr, setElementText, removeNestedElement, moveSlideElement,
  duplicateSlideElement } from './edit.mjs';
import { locateElement } from './edit-address.mjs';
import { setElementPicture, setSlideBackground, pictureToBackground, setSlideAttrs } from './edit.mjs';
import { setElementGeometry, addDiagramShape, duplicateDiagramNode, editConnector, CONNECTOR_OPS } from './edit.mjs';
import { oneline } from './git.mjs';
import { slotWriteProblem, slotMoveProblem, applySlideTemplate, insertSlideTemplateSlide, describeTemplateChange } from './design-system-edit.mjs';
import { designSystemRefs, resolveDesignSystemRef, packageVerdict } from './design-system-refs.mjs';
import { markedSources } from './theme-refs.mjs';
import { parseTemplateRef } from '../tools/design-system-format.mjs';
import { parseFaceLayout } from '../tools/face-layout.mjs';
import { setDeckConcepts } from './runtime-link.mjs';
// The whole-slide and image transforms are NOT in edit.mjs with the rest: they
// are string surgery on a deck's sections, which is what tools/deck-html.mjs
// is, and nothing about them wants the server.
import {
  sectionBodies, insertBlankSlide, duplicateSlide, deleteSlide, swapSlides,
} from '../tools/deck-html.mjs';
// A slide op moves the deck's recordings with their slides (#916): Node-only
// file moves, which is what tools/ is for.
import {
  voiceFolders, planSteps, applyPlans,
} from '../tools/voice-renumber.mjs';
// What Add and the New slide kinds put in: the server's own closed set
import { insertStarter, insertBlock, insertSlideOfKind, SLIDE_KINDS } from '../tools/starters.mjs';
import { escapeHtml } from '../tools/escape.mjs';

/**
 * Is `src` a path this deck can carry? Relative, and only relative.
 *
 * A scheme is somebody else's server (or, for `javascript:` and `data:`,
 * somebody else's code); a leading slash is the serving root rather than the
 * folder the deck lives in, so it breaks the moment the deck is opened over
 * `file://` or published under a path; and `..` points outside what travels
 * with the file. A deck is one HTML file and what sits beside it
 * (DECK_ANATOMY), and an `<img>` the author cannot send anybody is worse
 * than a refusal. A declaration, not a const: edit.mjs's picture transforms
 * call it across the deliberate static cycle between the two modules.
 */
export function relativeSrc(s) {
  return typeof s === 'string' && !!s.trim()
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)
    && !/^[/\\]/.test(s)
    && !s.split(/[/\\]/).includes('..');
}

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
export function registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath, quiet = () => {}, broadcast = () => {} }) {
  function notesRoute({ body, json }) {
    const { slide, text, from } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string') throw new Error('bad payload');
    // `changed` says whether a byte was written: an edit that normalises to
    // the same notes writes nothing, so no reload follows — the page must
    // not sit waiting for one (#646)
    const aside = notesTextToAside(text);
    const changed = applyEdit((html) => setSlideNotes(html, slide, aside));
    if (changed) {
      // Saved IN PLACE, never by a reload: the notes came from the page, so
      // the page already shows them. The write is quiet (the watcher skips
      // its reload), and every open view of the deck (another tab, the
      // speaker view's deck) is sent the slide's new notes instead, so none
      // keeps the old ones. Anything else that changes the file still reloads.
      quiet(readDeck());
      // `from` is the saving page's own id, echoed so that page leaves its
      // box as the author typed it rather than as the file normalised it
      broadcast('notes', { slide, aside, from: typeof from === 'string' ? from.slice(0, 64) : null });
      console.log(`  notes saved: slide ${slide} (${text.length} chars), updated in place`);
    }
    return json(200, { ok: true, changed: !!changed, inPlace: !!changed, ...history.counts() });
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
    const { slide, layout, quiet: inPlace, from } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof layout !== 'string') throw new Error('bad payload');
    const changed = applyEdit((html) => setSlideLayout(html, slide, layout));
    if (changed) {
      console.log(`  layout saved: slide ${slide} → ${layout}`);
      // The page that asked already shows the pick: an L press applies it
      // before the write. Asked for IN PLACE, the write is quiet (the
      // watcher skips its reload) and every page is sent the pick to put on
      // the slide itself — the notes save's shape, for the same reason.
      if (inPlace === true) {
        quiet(readDeck());
        broadcast('layout', { slide, layout, from: typeof from === 'string' ? from.slice(0, 64) : null });
      }
    }
    return json(200, { ok: true, changed, inPlace: changed && inPlace === true, ...history.counts() });
  }

  /**
   * A layout of one of THIS deck's design systems, as the server resolves it
   * (SPEC DESIGN_SYSTEMS) — `{ ref, id, slots }`, or a sentence saying why not.
   * Read from the package on disk through the same resolver and check every
   * server uses, never from the page that asked.
   */
  function deckTemplate(html, value) {
    const want = parseTemplateRef(value);
    if (!want) return { error: `"${value}" is not a slide template (name/template)` };
    const ref = designSystemRefs(html).find((r) => r.name === want.system);
    if (!ref) return { error: `the deck does not use a design system called "${want.system}" — Design systems… adds one` };
    const hit = resolveDesignSystemRef(ref, undefined, { source: markedSources(html)[ref.marketplace] ?? null });
    if (!hit.dir) return { error: `${ref.ref} — ${hit.missing}` };
    const verdict = packageVerdict(hit.dir);
    if (!verdict.ok) return { error: `${ref.ref} — ${verdict.why}` };
    const layout = verdict.summary.templates.find((l) => l.id === want.template);
    if (!layout) return { error: `${ref.ref} has no template "${want.template}" — it has ${verdict.summary.templates.map((l) => l.id).join(', ')}` };
    return { layout: { ref: `${want.system}/${want.template}`, id: layout.id, slots: layout.slots } };
  }

  /**
   * Put a slide into a slide template, move it to another, take it out,
   * or insert a new slide in one (SPEC DESIGN_SYSTEMS) — one edit, one undo,
   * and what went where, said back.
   *   { slide, layout: "acme/divider" }              convert or switch slide N
   *   { slide, layout: null }                          remove: back to a plain slide
   *   { slide, layout: "acme/divider", insert: true }  a new slide after slide N
   */
  function slideTemplateRoute({ body, json }) {
    const { slide, template, insert } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || !(template === null || typeof template === 'string')) throw new Error('bad payload');
    const html = readDeck();
    let def = null;
    if (template !== null) {
      const r = deckTemplate(html, template);
      if (r.error) return json(409, { ok: false, error: r.error });
      def = r.layout;
    } else if (insert) return json(400, { ok: false, error: 'insert needs a template' });
    let report = null;
    // a slide inserted is every later recording one slide on (#916)
    const voices = insert ? voicePlans(html, 'insert', slide) : { plans: [] };
    if (voices.error) return json(409, { ok: false, error: voices.error });
    try {
      const done = editWithVoices((deck) => {
        if (insert) return insertSlideTemplateSlide(deck, slide, def);
        const out = applySlideTemplate(deck, slide, def);
        report = out;
        return out.html;
      }, html, voices.plans);
      if (done.error) return json(409, { ok: false, error: done.error });
      const { changed } = done;
      const said = insert ? `a new ${def.ref} slide after slide ${slide}` : describeTemplateChange(report, def?.ref ?? '');
      if (changed) console.log(`  slide template: slide ${slide} — ${said}`);
      return json(200, {
        ok: true, changed, said, ...(insert ? { inserted: slide + 1 } : { mode: report.mode, moved: report.moved, lacking: report.lacking }),
        ...history.counts(),
      });
    } catch (e) {
      return json(404, { ok: false, error: oneline(e) });
    }
  }

  function hiddenRoute({ body, json }) {
    const { slide, hidden } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || typeof hidden !== 'boolean') throw new Error('bad payload');
    const changed = applyEdit((html) => setSlideHidden(html, slide, hidden));
    if (changed) console.log(`  slide ${slide} ${hidden ? 'hidden' : 'shown again'}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  // Where the filmed face shows (FACE_LAYOUT), for one slide or several at
  // once: Place my face's "this slide" and "every filmed slide". The value is
  // read back through the one reader the deck and the video share, so the
  // file never holds a placement that reader would not understand.
  function faceRoute({ body, json }) {
    const { slides, face } = JSON.parse(body);
    if (!Array.isArray(slides) || !slides.length || !slides.every((n) => Number.isInteger(n) && n >= 1)
      || typeof face !== 'string' || (face && parseFaceLayout(face).bad.length)) throw new Error('bad payload');
    const changed = applyEdit((html) => slides.reduce((h, n) => setSlideFace(h, n, face), html));
    if (changed) console.log(`  face ${face || 'corner'} on slide${slides.length === 1 ? '' : 's'} ${slides.join(', ')}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  // Whether a track folder plays by beats is a fact about the FOLDER, not
  // about the take that just finished (#926): one slide re-recorded with no
  // ⟨CLICK⟩ writes only its whole-slide file, and the client's per-take guess
  // then read as "this track has no segments". Any `slide-NN-KK` file says it
  // does — the same test the tracks route reports.
  const beatsIn = (dir) => {
    try {
      return readdirSync(resolve(dirname(deckPath), dir)).some((f) => /^slide-\d+-\d+\.(wav|m4a|mp3)$/.test(f));
    } catch { return false; }
  };

  function narrationRoute({ body, json }) {
    const { files, ext, segments } = JSON.parse(body || '{}');
    // The same three shapes /deck/edit/narration/record refuses for a folder, refused
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
      // an explicit `false` still turns a track's beats off; silence never does
      ...(segments !== undefined ? { segments } : beatsIn(files.trim()) ? { segments: true } : {}),
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
  // undo/redo stack. A content or label save asked `quiet` is written in
  // place: the page that saved already shows it, so the watcher skips its
  // reload and every other page is sent a `content` event instead.
  // `path` (a node inside the element, the selection inside a diagram) removes
  // that node alone; without it the whole element goes
  function elementRemoveRoute({ body, json }) {
    const { slide, index, path = null, tag = null } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    let changed;
    try {
      changed = applyEdit((html) => (path ? removeNestedElement(html, slide, index, { path, tag }) : removeSlideElement(html, slide, index)));
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  element removed: slide ${slide} #${index}${path ? ` › ${path.join('.')}` : ''}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  function elementContentRoute({ body, json }) {
    const { slide, index, html, quiet: inPlace = false, from = null } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || typeof html !== 'string') {
      throw new Error('bad payload');
    }
    // on a design-system slide an edit changes what an element says, never
    // the slot it fills (SPEC DESIGN_SYSTEMS)
    const dropped = slotWriteProblem(readDeck(), slide, index, html);
    if (dropped) return json(409, { ok: false, error: dropped });
    const changed = applyEdit((deck) => setSlideElementHtml(deck, slide, index, html));
    if (changed) console.log(`  element content saved: slide ${slide} #${index}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/move` — `{ slide, index, to, tag?, path?, quiet?, from? }`
   * (PRESENTING_EDITING, Moving): element `index` to content position `to`
   * on its slide, or, with `path`, the node there to place `to` among its own
   * siblings (a list item). One applyEdit, one undo entry. The answer names
   * where the element is now (`index`, `path`), since everything after it
   * has shifted. On a design-system slide an element moves only within its
   * slot. Asked for in place, the write is quiet and every other page is told.
   */
  function elementMoveRoute({ body, json }) {
    const { slide, index, to, tag = null, path = null, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || !Number.isInteger(to) || to < 0
        || (path !== null && !Array.isArray(path)) || (tag !== null && typeof tag !== 'string')) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    if (!path?.length) {
      const problem = slotMoveProblem(readDeck(), slide, index, to);
      if (problem) return json(409, { ok: false, error: problem });
    }
    let moved = null;
    let changed;
    try {
      changed = applyEdit((html) => { moved = moveSlideElement(html, slide, index, { to, path, tag }); return moved.html; });
    } catch (e) {
      if (e.code !== 'STALE' && e.code !== 'REFUSED') throw e;
      return json(409, { ok: false, error: oneline(e), ...(e.code === 'STALE' ? { stale: true } : {}) });
    }
    if (changed) console.log(`  element moved: slide ${slide} #${index}${path?.length ? ` › ${path.join('.')}` : ''} → ${to}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index: moved.index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, index: moved.index, path: moved.path, inPlace: !!changed && inPlace === true, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/duplicate` — `{ slide, index, tag?, path?, quiet?,
   * from? }` (PRESENTING_EDITING, Duplicate): element `index`, or the node at
   * `path` below it, copied right after itself (duplicateSlideElement). One
   * applyEdit, one undo entry. The answer is the copy's markup and where it
   * is (`index`, `path`), so the page puts the very same thing on the slide.
   * Asked for in place, the write is quiet and every other page is told.
   */
  function elementDuplicateRoute({ body, json }) {
    const { slide, index, tag = null, path = null, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0
        || (path !== null && !Array.isArray(path)) || (tag !== null && typeof tag !== 'string')) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    let done = null;
    try {
      applyEdit((html) => { done = duplicateSlideElement(html, slide, index, { path, tag }); return done.html; });
    } catch (e) {
      if (e.code === 'STALE' || e.code === 'REFUSED') return json(409, { ok: false, error: oneline(e), ...(e.code === 'STALE' ? { stale: true } : {}) });
      if (/^no slide \d|no element at index/.test(e.message)) return json(404, { ok: false, error: oneline(e) });
      return json(400, { ok: false, error: oneline(e) });
    }
    console.log(`  element duplicated: slide ${slide} #${index}${path?.length ? ` › ${path.join('.')}` : ''} → #${done.index}${done.path.length ? ` › ${done.path.join('.')}` : ''}`);
    if (inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index: done.index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed: true, index: done.index, path: done.path, html: done.markup, inPlace: inPlace === true, ...history.counts() });
  }

  function elementEffectRoute({ body, json }) {
    const { slide, index, effect, path = [], tag = null } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0
        || (effect !== null && typeof effect !== 'string') || (tag !== null && typeof tag !== 'string')) {
      throw new Error('bad payload');
    }
    let changed;
    try {
      changed = applyEdit((html) => setSlideElementBuild(html, slide, index, effect, { path, tag }));
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  element effect saved: slide ${slide} #${index}${path.length ? ` › ${path.join('.')}` : ''} → ${effect ?? '(removed)'}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/style` — `{ slide, index, edits, concept? }`: the
   * colour picker's save (element edit mode → Colors…). One applyEdit for a
   * shape's fill and its text together, so `Z` takes the pair back in one
   * press. A pasted style (Paste style) can carry the shape's concept too,
   * `concept: { path, tag, value }` (value null takes it off), written in the
   * same edit: a style that is a concept is that concept, not its colour.
   * Asked to `echo`, the answer carries the markup of each node it styled
   * (`nodes: [{ path, html }]`): a line restyled to dashes is put back on the
   * page as the file has it, since a drawn stroke is the engine's to rebuild.
   */
  function elementStyleRoute({ body, json }) {
    const { slide, index, edits = [], concept = null, quiet: inPlace, from, echo = false } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    if (concept !== null && (typeof concept !== 'object' || !(concept.value === null || typeof concept.value === 'string'))) throw new Error('bad payload');
    if (!concept && (!Array.isArray(edits) || !edits.length)) throw new Error('bad edits');
    let changed; let nodes = null;
    try {
      changed = applyEdit((html) => {
        const styled = Array.isArray(edits) && edits.length ? setElementStyles(html, slide, index, edits) : html;
        const out = concept ? setElementAttr(styled, slide, index,
          { path: concept.path ?? [], tag: concept.tag ?? null, name: 'data-concept', value: concept.value }) : styled;
        if (echo === true) nodes = editedNodes(out, slide, index, edits);
        return out;
      });
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    // Asked for IN PLACE (the inspector's Colors and Type tabs), the write is
    // quiet: the page that picked already shows it, and a reload would close
    // the panel it was picked in. Every other page is told, and reloads.
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('styles', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    if (changed) {
      const said = [...(edits ?? []).map((e) => `${e.prop} ${e.value}`), ...(concept ? [`concept ${concept.value ?? '(detached)'}`] : [])];
      console.log(`  element colours saved: slide ${slide} #${index} → ${said.join(', ')}`);
    }
    return json(200, { ok: true, changed, ...(nodes ? { nodes } : {}), ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/text` — `{ slide, index, path, tag, was, text }`:
   * a diagram label edited in place (SVG_DIAGRAMS). The words between one
   * `<text>`/`<tspan>`'s tags change and nothing else in the diagram does; a
   * label the file no longer says is a 409.
   */
  function elementTextRoute({ body, json }) {
    const { slide, index, path = [], tag = null, was, text, quiet: inPlace = false, from = null } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    let changed;
    try { changed = applyEdit((html) => setElementText(html, slide, index, { path, tag, was, text })); }
    catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  diagram label saved: slide ${slide} #${index} → ${JSON.stringify(text).slice(0, 60)}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/geometry` — `{ slide, index, edits: [{ path, tag,
   * attr, value }], quiet?, from? }`: nodes of a diagram moved or resized in
   * write mode (SVG_DIAGRAMS), every edit of one drag in ONE applyEdit, so `Z`
   * takes a box and the label that moved with it back in one press. The
   * attributes are a closed set and a move is `transform: translate(x y)`,
   * merged with what the transform says (setElementGeometry). A path the file
   * no longer has is a 409. Asked in place, the page that dragged already
   * shows it: quiet here, every other page sent `content` (it reloads).
   */
  function elementGeometryRoute({ body, json }) {
    const { slide, index, edits, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
    let changed;
    try { changed = applyEdit((html) => setElementGeometry(html, slide, index, edits)); }
    catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  diagram moved: slide ${slide} #${index} → ${edits.map((e) => `${e.attr} ${e.value}`).join(', ').slice(0, 120)}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/shape` — `{ slide, index, path, tag, op, kind?,
   * at?, by?, quiet?, from? }`: a shape added to a diagram (`op: 'add'`, `path`
   * the `<svg>`, `kind` box | ellipse | label | line, `at` where in the svg's
   * coordinates) or a node duplicated (`op: 'duplicate'`, `path` the node).
   * The server owns the markup (addDiagramShape, duplicateDiagramNode) and
   * answers with it, `added: { path, html }` (and `defs` when an arrowhead
   * had to be defined), so the page puts the very node the file got on the
   * slide. One undo entry; a stale path is a 409.
   */
  function elementShapeRoute({ body, json }) {
    const { slide, index, path, tag = null, op, kind = null, at = null, by = null, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || !['add', 'duplicate'].includes(op)) throw new Error('bad payload');
    let out = null;
    let changed;
    try {
      changed = applyEdit((html) => {
        out = op === 'add' ? addDiagramShape(html, slide, index, { path, tag: tag ?? 'svg', kind, at }) : duplicateDiagramNode(html, slide, index, { path, tag, by });
        return out.html;
      });
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  diagram ${op === 'add' ? `${kind} added` : 'node duplicated'}: slide ${slide} #${index} › ${out.added.path.join('.')}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, added: out.added, defs: out.defs ?? null, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/connector` — `{ slide, index, op, …, quiet?,
   * from? }`: a connector added between two nodes of a diagram, an end
   * reconnected or let go, its route, its arrowheads, its direction
   * (SVG_DIAGRAMS; editConnector says each op's fields). The page sends the
   * geometry it routed, since only it can measure a label; the server checks
   * every value and writes the markup: the nodes' `data-node` names, the
   * wire, an arrowhead's definition. It answers with what it wrote (`wire`,
   * `added`, `defs`, `named`), so the page puts the very same markup on the
   * slide. One undo entry; a stale path is a 409.
   */
  function elementConnectorRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const { slide, index, op, quiet: inPlace = false, from = null } = req;
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || !CONNECTOR_OPS.includes(op)) throw new Error('bad payload');
    let out = null;
    let changed;
    try {
      changed = applyEdit((html) => {
        out = editConnector(html, slide, index, req);
        return out.html;
      });
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  connector ${op}: slide ${slide} #${index} › ${out.wire.path.join('.')}`);
    if (changed && inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, wire: out.wire, added: out.added ?? null, defs: out.defs, named: out.named, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/concept` — `{ slide, index, path, tag, concept }`:
   * the shape's `data-concept` (SVG_DIAGRAMS, #718), set from the right-click
   * menu or taken off by the colour card's "Detach from concept". The engine
   * recolours on the reload this write brings.
   */
  function elementConceptRoute({ body, json }) {
    const { slide, index, path = [], tag = null, concept } = JSON.parse(body);
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || !(concept === null || typeof concept === 'string')) throw new Error('bad payload');
    let changed;
    try { changed = applyEdit((html) => setElementAttr(html, slide, index, { path, tag, name: 'data-concept', value: concept })); }
    catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) console.log(`  element concept saved: slide ${slide} #${index} → ${concept ?? '(detached)'}`);
    return json(200, { ok: true, changed, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/concepts` — `{ items: [{ slide, index, path, tag }],
   * concept, quiet?, from? }`: many shapes into one concept (or out of theirs,
   * `concept: null`) in ONE applyEdit, so `Z` takes the whole batch back in
   * one press: the look-alikes offered after an attach, a pick-mode click, a
   * Check deck… suggestion accepted. Asked for in place (`quiet`), the page
   * that asked already shows it; every other page is sent `styles` and
   * reloads. Every item is checked before any is written: one the file no
   * longer has is a 409 and nothing changes.
   */
  function elementConceptsRoute({ body, json }) {
    const { items, concept, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Array.isArray(items) || !items.length || items.length > 500 || !(concept === null || typeof concept === 'string')
        || items.some((t) => !t || !Number.isInteger(t.slide) || t.slide < 1 || !Number.isInteger(t.index) || t.index < 0)) {
      throw new Error('bad payload');
    }
    let changed;
    try {
      changed = applyEdit((html) => items.reduce((out, t) => setElementAttr(out, t.slide, t.index,
        { path: t.path ?? [], tag: t.tag ?? null, name: 'data-concept', value: concept }), html));
    } catch (e) { if (e.code !== 'STALE') throw e; return json(409, { ok: false, error: oneline(e) }); }
    if (changed) {
      const slides = [...new Set(items.map((t) => t.slide))].sort((a, b) => a - b);
      console.log(`  element concepts saved: ${items.length} shape${items.length === 1 ? '' : 's'} on slide${slides.length === 1 ? '' : 's'} ${slides.join(', ')} → ${concept ?? '(detached)'}`);
      if (inPlace === true) {
        quiet(readDeck());
        broadcast('styles', { slide: slides[0], index: items[0].index, from: typeof from === 'string' ? from.slice(0, 64) : null });
      }
    }
    return json(200, { ok: true, changed, count: items.length, inPlace: changed && inPlace === true, ...history.counts() });
  }

  /**
   * `POST /deck/edit/concepts` — `{ concepts, quiet?, from? }`: the deck's
   * concept map, `{ name: slot | colour }`, written the way the deck carries
   * its configuration (`setDeckConcepts`). Quiet and in place like a theme
   * pick: the page that chose already shows it, every other page is sent a
   * `concepts` event and recolours without a reload.
   */
  function conceptsRoute({ body, json }) {
    const { concepts, quiet: inPlace, from } = JSON.parse(body || '{}');
    if (!concepts || typeof concepts !== 'object' || Array.isArray(concepts)) throw new Error('bad payload');
    let unwritable = false;
    const changed = applyEdit((html) => { const next = setDeckConcepts(html, concepts); if (next === null) unwritable = true; return next ?? html; });
    if (unwritable) return json(409, { ok: false, error: 'the deck carries its configuration in a way this server cannot write — a configuration block, or a Decklight.init call that is data' });
    if (changed) {
      console.log(`  concepts saved: ${Object.entries(concepts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
      if (inPlace === true) { quiet(readDeck()); broadcast('concepts', { concepts, from: typeof from === 'string' ? from.slice(0, 64) : null }); }
    }
    return json(200, { ok: true, changed, inPlace: changed && inPlace === true, ...history.counts() });
  }

  // ── whole slides: the slide bar's new · duplicate · delete · reorder ──────

  /**
   * The deck's voice folders, each planned for one slide op (#916): manifest
   * entry n is slide n and its files are slide-NN…, so a slide inserted at 30
   * would otherwise leave every later recording one slide off — out of step
   * though not a word of it changed. `{ plans }` to carry out with the deck,
   * or `{ error }` when a rename would overwrite a file outside the plan, in
   * which case NOTHING is done: not the folders, not the deck.
   */
  function voicePlans(html, op, slide, to) {
    const steps = voiceFolders(deckPath, configuredTrackDirs(html))
      .map((dir) => ({ dir, op, slide, ...(to === undefined ? {} : { to }) }));
    const r = planSteps(dirname(deckPath), steps);
    return r.error ? { error: `${r.error} — nothing was changed` } : r;
  }

  /**
   * Write the deck and move its recordings as ONE undo entry: the steps that
   * undo the moves ride into the history beside the deck, so Z puts both
   * back. The folders move FIRST — a folder that cannot is put back as it was
   * and the op refused before the deck is touched — and are put back again if
   * the deck then cannot be written. `{ changed }` or `{ error }`.
   */
  function editWithVoices(change, before, plans) {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before || !plans.length) return { changed: applyEdit(next, before) };
    const deckDir = dirname(deckPath);
    let moved;
    try { ({ moved } = applyPlans(deckDir, plans)); } catch (e) {
      return { error: `the recordings could not follow the slides — ${oneline(e)} — nothing was changed` };
    }
    try {
      applyEdit(next, before, { voices: plans.map((p) => p.inverse) });
    } catch (e) {
      try { applyPlans(deckDir, planSteps(deckDir, plans.map((p) => p.inverse)).plans, { aside: true }); } catch { /* the deck error below is the one to say */ }
      throw e;
    }
    console.log(`  recordings followed their slides: ${moved} file${moved === 1 ? '' : 's'} in ${plans.map((p) => `${p.dir}/`).join(', ')}`);
    return { changed: true };
  }

  const SLIDE_OPS = new Set(['new', 'duplicate', 'delete', 'up', 'down', 'move']);

  /**
   * Slide `from` moved so that it ends up at position `to` — what a drag in
   * the overview asks for. One swap per step, each the same reindenting swap
   * `up` and `down` make, so the moved section and every one it passes keep
   * their indentation; the whole thing is still ONE applyEdit for the caller.
   */
  function moveSlide(html, from, to) {
    let out = html;
    for (let at = from; at < to; at++) out = swapSlides(out, at, at + 1);
    for (let at = from; at > to; at--) out = swapSlides(out, at - 1, at);
    return out;
  }

  /**
   * `POST /deck/edit/slide` — `{ op, slide }` (`{ op: 'move', slide, to }` for a
   * drag), one section moved, copied, made or taken away.
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
   *
   * The deck's recordings are numbered the same way, so they move in the same
   * step (#916): a new or duplicated slide has nothing recorded, a deleted
   * one's files go to its folder's `.trash/`, and the same undo entry holds
   * the moves.
   */
  function slideRoute({ body, json }) {
    const { op, slide, to, kind = null, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!SLIDE_OPS.has(op) || !Number.isInteger(slide) || slide < 1) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    // a new slide of a kind (PRESENTING_EDITING): one of a closed set, and
    // only a new slide has one; no kind is the blank slide it always was
    if (kind !== null && (op !== 'new' || !SLIDE_KINDS.includes(kind))) {
      return json(400, { ok: false, error: op !== 'new' ? 'only a new slide has a kind' : `no slide kind "${String(kind).slice(0, 40)}" (one of: ${SLIDE_KINDS.join(', ')})` });
    }
    if (op === 'move' && (!Number.isInteger(to) || to < 1)) return json(400, { ok: false, error: 'bad payload' });
    const before = readDeck();
    const total = sectionBodies(before).length;
    if (slide > total) return json(404, { ok: false, error: `no slide ${slide} (deck has ${total})` });
    // The three refusals, said as sentences: a deck with no slides is not a
    // deck, and the ends of the list are the ends of the list.
    if (op === 'delete' && total === 1) return json(409, { ok: false, error: 'a deck needs at least one slide' });
    if (op === 'up' && slide === 1) return json(409, { ok: false, error: 'already the first slide' });
    if (op === 'down' && slide === total) return json(409, { ok: false, error: 'already the last slide' });
    if (op === 'move' && to > total) return json(404, { ok: false, error: `no position ${to} (deck has ${total})` });
    if (op === 'move' && to === slide) return json(409, { ok: false, error: `slide ${slide} is already there` });

    const after = op === 'delete' ? total - 1 : (op === 'up' || op === 'down' || op === 'move') ? total : total + 1;
    const show = {
      new: slide + 1,
      duplicate: slide + 1,
      delete: Math.min(slide, after),   // deleting the last slide leaves you on the new last
      up: slide - 1,
      down: slide + 1,
      move: to,
    }[op];
    // every recording goes where its slide goes, in the same step (#916)
    const voices = voicePlans(before, op, slide, to);
    if (voices.error) return json(409, { ok: false, error: voices.error });
    const done = editWithVoices((html) => {
      switch (op) {
        case 'new': return kind ? insertSlideOfKind(html, slide, kind) : insertBlankSlide(html, slide);
        case 'duplicate': return duplicateSlide(html, slide);
        case 'delete': return deleteSlide(html, slide);
        case 'up': return swapSlides(html, slide - 1, slide);
        case 'move': return moveSlide(html, slide, to);
        default: return swapSlides(html, slide, slide + 1);
      }
    }, before, voices.plans);
    if (done.error) return json(409, { ok: false, error: done.error });
    console.log(`  slide ${op}${kind ? ` (${kind})` : ''}: ${slide}${op === 'move' ? ` → ${to}` : ''} → ${after} slide${after === 1 ? '' : 's'}`);
    // Asked for IN PLACE (PRESENTING_EDITING), and no recording moved with
    // it: the page that asked makes the same change itself, so the write is
    // quiet (no reload there, its selection and scroll kept) and every other
    // page hears it as content changed elsewhere. A new slide's own markup
    // goes back with the answer, so the page puts in exactly what the file
    // has. Recordings that moved need the voice reloaded with them: that
    // stays a reload.
    const quietly = inPlace && done.changed && !voices.plans.length;
    let section;
    if (quietly) {
      const now = readDeck();
      quiet(now);
      broadcast('content', { from: typeof from === 'string' ? from.slice(0, 64) : null, slide: show });
      if (op === 'new') {
        const b = sectionBodies(now)[slide] ?? '';
        const end = b.lastIndexOf('</section>');
        if (end >= 0) section = `<section${b.slice(0, end + '</section>'.length)}`;
      }
    }
    return json(200, { ok: true, slide: show, total: after, inPlace: quietly, ...(section ? { section } : {}), ...history.counts() });
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
   * leading dot that would hide the file from the no-trust mode's dotfile rule. The
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
   * `POST /deck/edit/asset` — the raw bytes of an image dropped onto the stage,
   * saved into `assets/` beside the deck. Answers the `src` the caller then
   * hands to `POST /deck/edit/element/image`.
   *
   * Ahead of the shared body read (`BEFORE_BODY` in cli/edit.mjs) for the same
   * reason `/deck/edit/narration/record` is: the body is BINARY and megabytes of it, so the
   * string concat and its 1 MB ceiling are both wrong. The size limit is
   * enforced on the way IN — `content-length` first when the browser declared
   * one, then the stream itself — because a limit that buffers 2 GB before
   * announcing it is a limit that costs more than it saves.
   *
   * SVG is accepted and NOTHING is stripped from it. A saved file is the
   * author's bytes, and an editor that silently rewrote them would be lying
   * about what is on the slide; if that SVG is ever inlined into the deck,
   * `decklight --no-trust --audit` names its scripts like any other block, which
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
   * `POST /deck/edit/element/image` — `{ slide, index, path?, src, alt }`, an
   * `<img>` onto a slide, addressed by the same top-level child index every
   * element route uses (`sectionChildRanges`), and placed by the rule every
   * add follows (`whereNewBlockLands`): a picture dropped on a column, or
   * added with one selected, goes inside it.
   *
   * `index: null` means "wherever it belongs on this slide": after the last
   * content child and before the asides, so a picture dropped on a slide that
   * has speaker notes lands on the slide instead of inside the notes, where
   * the audience would never see it.
   *
   * The answer names the new element's index (and its `path` below it, when
   * it went inside a column), because everything after the insertion has
   * just shifted and the caller's next act is usually to open element edit
   * mode on what it just made.
   */
  /** An optional `path` below an element: null, or up to 16 child indices. */
  const pathShape = (path) => path === null
    || (Array.isArray(path) && path.length <= 16 && path.every((n) => Number.isInteger(n) && n >= 0));

  function imageRoute({ body, json }) {
    // `more: true` — another picture of the same drop follows: no reload yet,
    // or the reload this write causes cut the drop off after its first file
    const { slide, index = null, path = null, src, alt, more = false } = JSON.parse(body || '{}');
    const text = alt == null ? '' : alt;
    if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string'
        || (index !== null && (!Number.isInteger(index) || index < 0)) || !pathShape(path)) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    if (!relativeSrc(src)) {
      return json(400, { ok: false, error: 'an image src must be a relative path beside the deck' });
    }
    let at = null;
    try {
      applyEdit((html) => {
        at = insertBlock(html, slide, index, `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}">`, { path });
        return at.html;
      });
    } catch (e) { return json(404, { ok: false, error: oneline(e) }); }
    if (more) quiet(readDeck());
    console.log(`  image added: slide ${slide} #${at.index}${at.path.length ? ` › ${at.path.join('.')}` : ''} → ${src}${more ? ' (more to come)' : ''}`);
    return json(200, { ok: true, index: at.index, path: at.path, ...history.counts() });
  }

  /**
   * `POST /deck/edit/element/insert` — `{ slide, index, path?, kind, quiet?,
   * from? }`: a starter of `kind` (heading, text, bullets, numbered, quote,
   * table, code, columns, diagram, chart) onto a slide, after top-level child
   * `index` (or the node at `path` below it), or with `index: null` after the
   * last content child and before the asides, the way a dropped picture lands
   * (PRESENTING_EDITING). Where it lands is the server's one rule
   * (`whereNewBlockLands`): with a column selected, inside that column. The markup is the
   * server's (tools/starters.mjs): a kind outside the set is a 400, a slide
   * that follows a slide template, or two columns with content before them,
   * a 409 that says why.
   *
   * One applyEdit, so one undo entry, two columns' layout (or a bare
   * column's new wrapper) included. The answer names the new element's index
   * and `path` below it, and carries the markup the file got, so the page that asked shows exactly that IN PLACE: asked `quiet`,
   * the watcher skips the reload and every other page is sent `content`.
   */
  function elementInsertRoute({ body, json }) {
    const { slide, index = null, path = null, kind, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || typeof kind !== 'string'
        || (index !== null && (!Number.isInteger(index) || index < 0)) || !pathShape(path)) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    let done = null;
    try {
      applyEdit((html) => {
        done = insertStarter(html, slide, index, kind, { path });
        return done.html;
      });
    } catch (e) {
      return json(e.status ?? 404, { ok: false, error: oneline(e) });
    }
    console.log(`  element added: slide ${slide} #${done.index}${done.path.length ? ` › ${done.path.join('.')}` : ''} (${kind}${done.wrapped ? ', its column wrapped' : ''})`);
    if (inPlace === true) {
      quiet(readDeck());
      broadcast('content', { slide, index: done.index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, {
      ok: true, index: done.index, path: done.path, ...(done.wrapped ? { wrapped: true } : {}), count: done.count, kind, html: done.markup,
      ...(done.layout ? { layout: done.layout } : {}), inPlace: inPlace === true, ...history.counts(),
    });
  }

  // ── pictures after the drop (PRESENTING_EDITING) ───────────────────────
  // A refusal is said in the transform's own words: a shape it does not take
  // is a 400, a slide or element the file does not have a 404, and a path
  // that lands on something else the 409 every element route answers.
  const refusal = (e, json) => {
    if (e.code === 'STALE') return json(409, { ok: false, error: oneline(e) });
    if (/^no slide \d|no element at index/.test(e.message)) return json(404, { ok: false, error: oneline(e) });
    return json(400, { ok: false, error: oneline(e) });
  };
  /** A write the page already shows: no reload there, every other page told. */
  const inPlaceWrite = (changed, inPlace, slide, index, from) => {
    if (!changed || inPlace !== true) return false;
    quiet(readDeck());
    broadcast('content', { slide, index, from: typeof from === 'string' ? from.slice(0, 64) : null });
    return true;
  };

  /**
   * `POST /deck/edit/element/picture` — `{ slide, index, path?, tag?, width?,
   * alt?, src?, caption? }`: one picture's size, alt text, file, or a caption
   * around it (setElementPicture), each field a closed shape and one undo
   * entry for the lot. `path` addresses a picture inside the element (a
   * figure's, a column's); `[]` or none is the element itself. A caption
   * answers where the new `<figcaption>` is, for the page to edit it there.
   */
  function elementPictureRoute({ body, json }) {
    const b = JSON.parse(body || '{}');
    const { slide, index, path = [], tag = 'img', quiet: inPlace = false, from = null } = b;
    if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || (tag !== null && typeof tag !== 'string')) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    const fields = {};
    for (const k of ['width', 'alt', 'src', 'caption']) if (Object.hasOwn(b, k)) fields[k] = b[k];
    let changed;
    try { changed = applyEdit((html) => setElementPicture(html, slide, index, { path, tag, ...fields })); }
    catch (e) { return refusal(e, json); }
    const said = Object.entries(fields).map(([k, v]) => `${k} ${v === null ? '(removed)' : JSON.stringify(v).slice(0, 60)}`).join(', ');
    if (changed) console.log(`  picture changed: slide ${slide} #${index}${path.length ? ` › ${path.join('.')}` : ''} → ${said}`);
    const placed = inPlaceWrite(changed, inPlace, slide, index, from);
    const caption = Object.hasOwn(fields, 'caption') && changed ? { figure: path, img: [...path, 0], figcaption: [...path, 1] } : undefined;
    return json(200, { ok: true, changed, inPlace: placed, ...(caption ? { caption } : {}), ...history.counts() });
  }

  /**
   * `POST /deck/edit/slide/background` — `{ slide, src }`: slide N's
   * background picture (`data-background-image`, DECK_ANATOMY), a relative
   * path beside the deck, or null to take it off. With `take: { index, path?,
   * tag? }` the picture there becomes it: it leaves the slide's content and
   * its file is the background, in the same one edit (`src` is then the
   * file's, whatever the body said).
   */
  function slideBackgroundRoute({ body, json }) {
    const { slide, src = null, take = null, quiet: inPlace = false, from = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || (take !== null && (typeof take !== 'object' || !Number.isInteger(take.index) || take.index < 0))) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    if (!take && src !== null && !relativeSrc(src)) {
      return json(400, { ok: false, error: 'a background src must be a relative path beside the deck' });
    }
    let changed;
    let out = { src, removed: null };
    try {
      changed = applyEdit((html) => {
        if (!take) return setSlideBackground(html, slide, src);
        const moved = pictureToBackground(html, slide, take.index, { path: take.path ?? [], tag: take.tag ?? 'img' });
        out = { src: moved.src, removed: moved.removed };
        return moved.html;
      });
    } catch (e) { return refusal(e, json); }
    if (changed) console.log(`  slide background: slide ${slide} → ${out.src ?? '(removed)'}${take ? ` (the picture at #${take.index} moved there)` : ''}`);
    const placed = inPlaceWrite(changed, inPlace, slide, take?.index ?? null, from);
    return json(200, { ok: true, changed, inPlace: placed, src: out.src, ...(take ? { removed: out.removed } : {}), ...history.counts() });
  }

  /**
   * `POST /deck/edit/slide/attr` — `{ slide, set: { name: value } }`: slide
   * N's own settings (the inspector's Slide tab, PRESENTING_EDITING), each a
   * `<section>` attribute written in its place (setSlideAttrs): a string its
   * value, `true` bare, null off. `edits: [{ slide, set }]` writes more than
   * one slide in the same one edit (a morph is this slide's and the one
   * before's). Quiet, the page that asked already shows it and every other
   * page is sent the edits to put on its slides.
   */
  function slideAttrRoute({ body, json }) {
    const b = JSON.parse(body || '{}');
    const { quiet: inPlace = false, from = null } = b;
    const edits = Array.isArray(b.edits) ? b.edits : [{ slide: b.slide, set: b.set }];
    if (!edits.length || edits.length > 4 || !edits.every((e) => Number.isInteger(e?.slide) && e.slide >= 1 && e.set && typeof e.set === 'object')) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    let changed;
    try { changed = applyEdit((html) => edits.reduce((h, e) => setSlideAttrs(h, e.slide, e.set), html)); }
    catch (e) { return refusal(e, json); }
    if (changed) {
      const said = edits.map((e) => `slide ${e.slide}: ${Object.entries(e.set).map(([k, v]) => `${k}${v === null ? ' (removed)' : v === true ? '' : `=${JSON.stringify(v).slice(0, 60)}`}`).join(', ')}`);
      console.log(`  slide settings: ${said.join('; ')}`);
    }
    const placed = !!changed && inPlace === true;
    if (placed) {
      quiet(readDeck());
      broadcast('slide-attrs', { edits: edits.map((e) => ({ slide: e.slide, set: e.set })), from: typeof from === 'string' ? from.slice(0, 64) : null });
    }
    return json(200, { ok: true, changed, inPlace: placed, ...history.counts() });
  }

  routes.set('POST /deck/edit/slide/notes', notesRoute);
  routes.set('POST /deck/edit/slide/sources', sourcesRoute);
  routes.set('POST /deck/edit/timings', timingsRoute);
  routes.set('POST /deck/edit/slide/layout', layoutRoute);
  routes.set('POST /deck/edit/slide/template', slideTemplateRoute);
  routes.set('POST /deck/edit/slide/hidden', hiddenRoute);
  routes.set('POST /deck/edit/slide/attr', slideAttrRoute);
  routes.set('POST /deck/edit/slide/face', faceRoute);
  routes.set('POST /deck/edit/narration', narrationRoute);
  routes.set('GET /deck/edit/element/source', elementSourceRoute);
  routes.set('POST /deck/edit/element/remove', elementRemoveRoute);
  routes.set('POST /deck/edit/element/content', elementContentRoute);
  routes.set('POST /deck/edit/element/effect', elementEffectRoute);
  routes.set('POST /deck/edit/element/move', elementMoveRoute);
  routes.set('POST /deck/edit/element/duplicate', elementDuplicateRoute);
  routes.set('POST /deck/edit/element/style', elementStyleRoute);
  routes.set('POST /deck/edit/element/concept', elementConceptRoute);
  routes.set('POST /deck/edit/element/concepts', elementConceptsRoute);
  routes.set('POST /deck/edit/element/text', elementTextRoute);
  routes.set('POST /deck/edit/element/geometry', elementGeometryRoute);
  routes.set('POST /deck/edit/element/shape', elementShapeRoute);
  routes.set('POST /deck/edit/element/connector', elementConnectorRoute);
  routes.set('POST /deck/edit/concepts', conceptsRoute);
  routes.set('POST /deck/edit/slide', slideRoute);
  routes.set('POST /deck/edit/asset', assetRoute);
  routes.set('POST /deck/edit/element/image', imageRoute);
  routes.set('POST /deck/edit/element/insert', elementInsertRoute);
  routes.set('POST /deck/edit/element/picture', elementPictureRoute);
  routes.set('POST /deck/edit/slide/background', slideBackgroundRoute);
  return routes;
}
