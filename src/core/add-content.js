// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Adding content from the editing bar (SPEC PRESENTING_EDITING).
//
// Until this, the one thing a person could add to a slide in write mode was a
// picture, and a new slide was always the same empty section: a heading, a
// list or a diagram meant opening the HTML. The bar's Add ▾ (and the
// palette's Add to slide…) offers the kinds a slide is made of. The server
// owns each one's starter markup (tools/starters.mjs) and answers with it, so
// this page puts in exactly what the file got, where the file got it: after
// the selected element, or after the slide's last content and before its
// notes. Nothing reloads: the new element is shown, selected and, when it is
// words, already being typed, its placeholder selected so the first key
// replaces it. A new slide of a kind gets its title typed the same way.
//
// Where the page cannot follow the file in place, it reloads onto the slide,
// and the element is selected (and its words opened) on the page that comes.

import { authoredIndex } from './design-system.js';
import { boundedFetch } from './devmode.js';

/** What Add offers, in its order: the server's kinds, then the picture the bar always had. */
export const ADD_KINDS = [
  ['heading', 'Heading'], ['text', 'Text'], ['bullets', 'Bullets'], ['numbered', 'Numbered list'],
  ['quote', 'Quote'], ['table', 'Table'], ['code', 'Code'], ['columns', 'Two columns'],
  ['diagram', 'Diagram'], ['chart', 'Chart'], ['picture', 'Picture'],
];
const SAID = {
  heading: 'a heading', text: 'text', bullets: 'a bullet list', numbered: 'a numbered list', quote: 'a quote',
  table: 'a table', code: 'a code block', columns: 'two columns', diagram: 'a diagram', chart: 'a chart',
};

/** The node a new element's words are typed into, or null for a kind that is not words (a diagram, a chart). */
export function typingTarget(kind, el) {
  switch (kind) {
    case 'heading': case 'text': case 'quote': return el;
    case 'bullets': case 'numbered': return el.querySelector('li');
    case 'table': return el.querySelector('th, td');
    case 'columns': return el.querySelector('h3, li');
    case 'code': return el.querySelector('code');
    default: return null;
  }
}

export function createAddContent({ root, instance, editmode, authoring, editbar, toast, debugLog = () => {} }) {
  const HANDOFF = 'decklight-add-select:' + location.pathname;
  const current = () => ({ slide: instance.state.slide, sec: instance._sections[instance.state.slide - 1] });
  const templatedSay = (slide) => `slide ${slide} follows a slide template: its content goes in the template's slots, so nothing is added beside them. Edit a slot's words, or take the slide out of the template (Use slide template…) to add freely`;

  /** The live child that the file's top-level child `index` is, or null. */
  const liveChild = (sec, index) => [...sec.children].find((c) => authoredIndex(sec, c) === index) ?? null;

  /** Open the Add menu: above the bar's button when it is on screen, else in the middle of the stage. */
  function open(btn = editbar.addButton()) {
    if (!editmode.elementEditOn()) { toast(editmode.cannot('adding to a slide'), 3200); return; }
    const { slide, sec } = current();
    if (!sec) return;
    if (sec.hasAttribute('data-template')) { toast(templatedSay(slide), 5200); return; }
    const r = (btn ?? root).getBoundingClientRect();
    const target = { sec, slide, index: null, top: null, clicked: null, fromBar: true };
    const rows = () => ADD_KINDS.map(([kind, label]) => ({ label, run: () => { editmode.closeMenu?.(); add(kind); } }));
    if (btn) editmode.openElementMenuAt(r.left, r.top - 8, target, 'rows', { above: true, rows, label: 'Add to slide' });
    else editmode.openElementMenuAt(r.left + r.width / 2 - 90, r.top + r.height / 3, target, 'rows', { rows, label: 'Add to slide' });
  }

  /** Add a starter of `kind` to the slide on screen, after the selected element (or last on the slide). */
  async function add(kind) {
    if (kind === 'picture') { editbar.choosePicture(); return; }
    const { slide, sec } = current();
    if (!sec) return;
    const sel = editbar.selected();
    const index = sel && sel.sec === sec && Number.isInteger(sel.index) ? sel.index : null;
    const job = (async () => {
      let j;
      try {
        const res = await boundedFetch(editmode.base() + '/deck/edit/element/insert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide, index, kind, quiet: true, from: editmode.pageId() }),
        });
        j = await res.json().catch(() => ({}));
        editmode.noteHistory?.(j);
        if (!res.ok) throw new Error(j.error || String(res.status));
      } catch (e) {
        toast(`could not add ${SAID[kind] ?? kind}: ${String(e.message || e)}`, 6000);
        return;
      }
      let els;
      try { els = place(sec, j); } catch (e) {
        // the file has it and this page cannot show it: the page reloads onto it
        debugLog('edit', `add ${kind} in place failed (${String(e.message || e)}) — reloading`);
        handOff({ slide, index: j.index, kind });
        location.hash = `#/${slide}/0`;
        editmode.reloadWhenSafe?.(`${SAID[kind] ?? kind} added — the page could not show it in place`);
        return;
      }
      root.dispatchEvent(new CustomEvent('decklight:inserted', { detail: { slide, els, layout: j.layout ?? null } }));
      editbar.refresh();
      reveal(slide, els);
      settle(kind, els[0]);
      toast(`${SAID[kind] ?? kind} added${typingTarget(kind, els[0]) ? ' — type to replace the placeholder' : ''}`, 2200);
    })();
    editmode.trackWrite?.(job);   // Z waits for it, as for every write
    await job;
  }

  /** Put the file's new markup into the live slide where the file has it. Throws when it cannot. */
  function place(sec, j) {
    if (typeof j.html !== 'string' || !Number.isInteger(j.index)) throw new Error('no markup came back');
    const tpl = document.createElement('template');
    tpl.innerHTML = j.html;
    const els = [...tpl.content.children];
    if (!els.length) throw new Error('no element in the markup');
    if (j.index === 0) sec.prepend(...els);
    else {
      const anchor = liveChild(sec, j.index - 1);
      if (!anchor) throw new Error(`no element ${j.index - 1} on the page`);
      anchor.after(...els);
    }
    // the page and the file must agree on where it went, or every later edit misses
    if (authoredIndex(sec, els[0]) !== j.index) { els.forEach((el) => el.remove()); throw new Error('the page and the file disagree on where it went'); }
    return els;
  }

  /** A new element that builds (a diagram arrives in parts) is shown whole: the slide steps to its end. */
  function reveal(slide, els) {
    if (!els.some((el) => el.matches('[data-build]') || el.querySelector('[data-build]'))) return;
    const steps = instance._records?.[slide - 1]?.groups.length ?? 0;
    if (steps > instance.state.step) instance.goto(slide, steps, { force: true });
  }

  /** Select the new element and, for words, start typing them with the placeholder selected. */
  function settle(kind, el) {
    if (!el?.isConnected) return;
    editbar.selectNode(el);
    const words = typingTarget(kind, el);
    if (words) authoring.editInline(words, { selectAll: true });
  }

  // ── a new slide of a kind: its title is typed next ──────────────────────
  function editTitle(slide) {
    const sec = instance._sections[slide - 1];
    const title = sec?.querySelector(':scope > h1, :scope > h2');
    if (!title) return;
    // once the slide change has run, or the focus lands on a slide still coming in
    setTimeout(() => { if (title.isConnected) authoring.editInline(title, { selectAll: true }); }, 0);
  }
  editmode.onSlideAdded?.(({ slide, placed }) => {
    if (placed) editTitle(slide);
    else handOff({ slide, title: true });
  });

  // ── across a reload ─────────────────────────────────────────────────────
  // The page the reload brings selects what was added (and opens its words),
  // as this one would have.
  function handOff(what) {
    try { sessionStorage.setItem(HANDOFF, JSON.stringify(what)); } catch { /* no storage: the reload lands on the slide, nothing selected */ }
  }
  function resume() {
    let what = null;
    try { what = JSON.parse(sessionStorage.getItem(HANDOFF) ?? 'null'); sessionStorage.removeItem(HANDOFF); } catch { /* nothing kept */ }
    if (!what || !Number.isInteger(what.slide)) return;
    const sec = instance._sections[what.slide - 1];
    if (!sec) return;
    if (instance.state.slide !== what.slide) instance.goto(what.slide, 0);
    if (what.title) { editTitle(what.slide); return; }
    const el = Number.isInteger(what.index) ? liveChild(sec, what.index) : null;
    if (!el) return;
    reveal(what.slide, [el]);
    settle(what.kind, el);
  }
  const resumeWhenOn = (on) => { if (on) resume(); };
  editmode.onElementEditChange(resumeWhenOn);
  if (editmode.elementEditOn()) resume();

  return { open, add, kinds: () => ADD_KINDS.map(([kind, label]) => ({ kind, label })) };
}
