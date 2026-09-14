// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The routes that CHANGE A SLIDE: notes, sources, rehearsed timings, layout,
// hidden, the four element-edit ones, and the narration track the recorder
// points the deck at (SPEC PRESENTING author mode).
//
// They came out of cli/edit.mjs because they are the one group in that server
// that needs almost nothing FROM it. Each is the same three steps — read the
// deck, run one pure `(html, …) → html` transform over it, put the result
// through `applyEdit` so `Z` takes it back — and between them they want three
// bindings, not the fifty editMain has in scope. Naming those three in a
// parameter list is what lets a handler be called from a test with a temp file
// and no socket at all, which is how the ones here are covered.
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

import {
  notesTextToAside, setSlideNotes,
  sourcesToAside, setSlideSources,
  setSlideTiming, setSlideLayout, setSlideHidden,
  upsertNarrationTrack,
  locateElement, removeSlideElement, setSlideElementHtml, setSlideElementBuild,
} from './edit.mjs';
import { oneline } from './git.mjs';

/**
 * Put the slide-mutation routes into `routes`, the table cli/edit.mjs
 * dispatches on, and hand it back.
 *
 * `ctx` is the whole of what these handlers may touch, written out rather than
 * closed over: `readDeck()` for the current file, `applyEdit()` for the one
 * door every mutation goes through (snapshot, then write), and `history` for
 * the undo/redo counts every one of them reports back.
 */
export function registerSlideRoutes(routes, { readDeck, applyEdit, history }) {
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
  return routes;
}
