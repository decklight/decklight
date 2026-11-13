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
import { createEditCommit } from './edit-commit.js';
import { pathFrom } from './colorpicker.js';
import { innerPath } from './editbar.js';
import { boundedFetch } from './devmode.js';
import { videoFiles } from './authoring.js';

/** The largest video the edit server takes (cli/edit-slides.mjs MAX_VIDEO_BYTES), said before anything is sent. */
export const MAX_VIDEO_BYTES = 200e6;

/** What Add offers, in its order: the server's kinds, then the picture the bar always had. */
export const ADD_KINDS = [
  ['heading', 'Heading'], ['text', 'Text'], ['bullets', 'Bullets'], ['numbered', 'Numbered list'],
  ['quote', 'Quote'], ['table', 'Table'], ['code', 'Code'], ['formula', 'Formula'], ['columns', 'Two columns'],
  ['diagram', 'Diagram'], ['chart', 'Chart'], ['picture', 'Picture'], ['video', 'Video'], ['terminal', 'Terminal recording'],
];
const SAID = {
  heading: 'a heading', text: 'text', bullets: 'a bullet list', numbered: 'a numbered list', quote: 'a quote',
  table: 'a table', code: 'a code block', formula: 'a formula', columns: 'two columns', diagram: 'a diagram', chart: 'a chart', video: 'a video', terminal: 'a terminal',
};

/** The node a new element's words are typed into, or null for a kind that is not words (a diagram, a chart). */
export function typingTarget(kind, el) {
  switch (kind) {
    case 'heading': case 'text': case 'quote': case 'formula': return el;
    case 'bullets': case 'numbered': return el.querySelector('li');
    case 'table': return el.querySelector('th, td');
    case 'columns': return el.querySelector('h3, li');
    case 'code': return el.querySelector('code');
    default: return null;
  }
}

export function createAddContent({ root, instance, editmode, authoring, editbar, toast, debugLog = () => {} }) {
  const commit = createEditCommit(editmode);
  const HANDOFF = 'decklight-add-select:' + location.pathname;
  const current = () => ({ slide: instance.state.slide, sec: instance._sections[instance.state.slide - 1] });
  const templatedSay = (slide) => `slide ${slide} follows a slide template: its content goes in the template's slots, so nothing is added beside them. Edit a slot's words, or take the slide out of the template (Use slide template…) to add freely`;

  /** The live child that the file's top-level child `index` is, or null. */
  const liveChild = (sec, index) => [...sec.children].find((c) => authoredIndex(sec, c) === index) ?? null;
  /** A live node's children as the file counts them (pathFrom's way). */
  const authoredKids = (el) => [...el.children].filter((c) => { const p = pathFrom(el, c); return p && p.length === 1; });
  /** The live node at `path` below `top`, the inverse of pathFrom, or null. */
  const nodeAtPath = (top, path) => path.reduce((n, i) => (n ? authoredKids(n)[i] ?? null : null), top);

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
    if (kind === 'video') { chooseVideo(); return; }
    if (kind === 'terminal') { chooseRecording(); return; }
    return insert(kind);
  }

  /**
   * Words pasted from another app, outside typing (clipboard.js): a paragraph
   * of one line or a list of several (`pastedWords`), added where Add would
   * add one, and selected, not opened for typing: they are the author's
   * words already, not a placeholder.
   */
  async function pasteWords(kind, words) {
    if (!editmode.elementEditOn()) return;
    const { slide, sec } = current();
    if (!sec) return;
    if (sec.hasAttribute('data-template')) { toast(templatedSay(slide), 5200); return; }
    return insert(kind, { words });
  }

  /** One element onto the slide on screen, after the selection: a starter of `kind`, or with `words`, a paste of them. */
  async function insert(kind, { words = null } = {}) {
    const pasted = words !== null;
    const { slide, sec } = current();
    if (!sec) return;
    const sel = editbar.selected();
    const index = sel && sel.sec === sec && Number.isInteger(sel.index) ? sel.index : null;
    // where it lands is the server's rule (a column selected: inside it); the
    // page says what is selected, down to the block picked inside a column
    const path = index !== null ? innerPath(sel) : null;
    const job = (async () => {
      let j;
      try { j = await commit.send('/deck/edit/element/insert', { slide, index, kind, ...(path?.length ? { path } : {}), ...(pasted ? { words } : {}) }); } catch (e) {
        toast(`could not ${pasted ? 'paste' : 'add'} ${SAID[kind] ?? kind}: ${commit.why(e)}`, 6000);
        return;
      }
      let els;
      try { els = place(sec, j); } catch (e) {
        // the file has it and this page cannot show it: the page reloads onto it
        debugLog('edit', `add ${kind} in place failed (${String(e.message || e)}) — reloading`);
        handOff({ slide, index: j.index, path: j.path ?? [], kind: pasted ? 'pasted' : kind });
        commit.reload(`${SAID[kind] ?? kind} added — the page could not show it in place`, { slide });
        return;
      }
      // the slide's own attributes the write gave it (a formula's data-math)
      for (const [name, v] of Object.entries(j.section ?? {})) if (/^data-[a-z-]+$/.test(name)) sec.setAttribute(name, v === true ? '' : String(v));
      // what the engine does to content at load, done to it now: a chart
      // drawn, a formula typeset, a diagram's ids namespaced, code highlighted
      // and lined, the split two columns ask for, and the slide rescanned and
      // laid out again
      instance.refreshSlide?.(sec, {
        charts: true, math: true, svgs: els, code: els.filter((el) => el.matches('pre') || el.querySelector('pre > code')), layout: j.layout ?? null, paint: sec,
      });
      editbar.refresh();
      reveal(slide, els);
      settle(pasted ? 'pasted' : kind, els[0]);
      toast(pasted ? `pasted as ${SAID[kind] ?? kind}${words.length > 1 ? ` of ${words.length} points` : ''}`
        : `${SAID[kind] ?? kind} added${typingTarget(kind, els[0]) ? ' — type to replace the placeholder' : ''}`, 2200);
    })();
    await commit.track(job);   // Z waits for it, as for every write
  }

  // ── a video: chosen or dropped, copied beside the deck, then placed ─────
  /** Add ▾ › Video: a chooser for mp4 or webm, placed after the selection as Add places anything. */
  function chooseVideo() {
    const pick = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/mp4,video/webm', hidden: true });
    pick.addEventListener('change', () => {
      const files = videoFiles(pick.files);
      const picked = pick.files?.length ?? 0;
      pick.remove();
      if (picked && !files.length) { toast('a slide takes an mp4 or a webm video', 3200); return; }
      const { slide, sec } = current();
      const sel = editbar.selected();
      const index = sel && sel.sec === sec && Number.isInteger(sel.index) ? sel.index : null;
      if (files.length && sec) addVideos(files, { slide, sec, index, path: index !== null ? innerPath(sel) : null });
    });
    root.append(pick);
    pick.click();
  }

  /**
   * Upload each video into assets/ beside the deck (POST /deck/edit/asset,
   * streamed there) and put a `<video controls>` for it on slide `slide`
   * after element `index` (or the block at `path` inside it), in place and
   * selected. One over the server's cap is refused before a byte is sent,
   * with the cap in the sentence.
   */
  async function addVideos(files, { slide, sec, index = null, path = null }) {
    if (!editmode.elementEditOn()) { toast(editmode.cannot('adding to a slide'), 3200); return; }
    if (sec.hasAttribute('data-template')) { toast(templatedSay(slide), 5200); return; }
    const job = (async () => {
      for (const file of files) {
        if (file.size > MAX_VIDEO_BYTES) {
          toast(`${file.name} was not added: a video on a slide is at most ${Math.round(MAX_VIDEO_BYTES / 1e6)} MB, and it is ${Math.round(file.size / 1e6)} MB`, 6000);
          continue;
        }
        let up;
        try {
          const res = await boundedFetch((editmode.base?.() ?? '') + '/deck/edit/asset', {
            method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file,
          }, { ms: 600000 });
          up = await res.json().catch(() => ({}));
          if (!res.ok || !up.src) throw new Error(up.error || `the edit server answered ${res.status}`);
        } catch (e) { toast(`could not add ${file.name}: ${commit.why(e)}`, 6000); continue; }
        let j;
        try {
          j = await commit.send('/deck/edit/element/insert', { slide, index, kind: 'video', with: { src: up.src }, ...(path?.length ? { path } : {}) });
        } catch (e) { toast(`${file.name} is in ${up.src}, but could not go on the slide: ${commit.why(e)}`, 7000); continue; }
        let els;
        try { els = place(sec, j); } catch (e) {
          debugLog('edit', `add video in place failed (${String(e.message || e)}) — reloading`);
          handOff({ slide, index: j.index, path: j.path ?? [], kind: 'video' });
          commit.reload(`${file.name} added — the page could not show it in place`, { slide });
          return;
        }
        instance.refreshSlide?.(sec, { scan: sec });
        editbar.refresh();
        settle('video', els[0]);
        // the next one goes after this one
        index = j.index; path = j.path?.length ? j.path : null;
        toast(`${file.name} is on slide ${slide} as ${up.src}${up.committed === false ? ' (the deck’s automatic commits carry the deck alone: commit the video yourself)' : ''}`, 5200);
      }
    })();
    await commit.track(job);
  }
  authoring.setVideoDrop?.((files, where) => addVideos(files, where));
  // ── a terminal: one of the recordings beside the deck ───────────────────
  /** What a deck with no recording is told: how one is made, since recording is the CLI's (RECORDER_CLI). */
  const NO_CASTS = 'there is no terminal recording beside the deck yet: write the commands in a .term.yaml script, record it with decklight cast, then add it here';
  /**
   * Add ▾ › Terminal recording: the recordings found beside the deck
   * (`GET /deck/edit/casts`), one row each; the one picked is placed after
   * the selection, a command a click. With none, nothing is added and the
   * toast says how one is made. A terminal is set up when the deck loads, so
   * the page reloads onto it, selected.
   */
  async function chooseRecording() {
    const { slide, sec } = current();
    if (!sec) return;
    const sel = editbar.selected();
    const index = sel && sel.sec === sec && Number.isInteger(sel.index) ? sel.index : null;
    const path = index !== null ? innerPath(sel) : null;
    let casts;
    try {
      const res = await boundedFetch(`${editmode.base?.() ?? ''}/deck/edit/casts`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(j.casts)) throw new Error(j.error || `the edit server answered ${res.status}`);
      casts = j.casts;
    } catch (e) { toast(`could not list the recordings: ${commit.why(e)}`, 6000); return; }
    if (!casts.length) { toast(NO_CASTS, 7000); return; }
    const r = (editbar.addButton() ?? root).getBoundingClientRect();
    const target = { sec, slide, index: null, top: null, clicked: null, fromBar: true };
    const rows = () => casts.map((c) => ({ label: c.path, run: () => { editmode.closeMenu?.(); placeRecording(c.path, { slide, index, path }); } }));
    editmode.openElementMenuAt(r.left, r.top - 8, target, 'rows', { above: true, rows, label: 'Terminal recording' });
  }
  async function placeRecording(cast, { slide, index, path }) {
    const job = (async () => {
      let j;
      try {
        j = await commit.send('/deck/edit/element/insert', { slide, index, kind: 'terminal', with: { cast }, ...(path?.length ? { path } : {}) });
      } catch (e) { toast(`could not add ${cast}: ${commit.why(e)}`, 6000); return; }
      handOff({ slide, index: j.index, path: j.path ?? [], kind: 'terminal' });
      commit.reload(`${cast} added — the deck reloads to set the terminal up`, { slide });
    })();
    await commit.track(job);
  }

  /**
   * An element from the clipboard (PRESENTING_EDITING, the clipboard): `markup`
   * as a copy took it from a deck's file, put where a new block lands (after
   * the selection, inside its column; last on the slide with nothing
   * selected) by the server, which cleans it first and answers what it left
   * out and which pictures this deck's folder does not have. Shown in place
   * as Add's new block is, selected; one write, one undo.
   */
  async function paste(markup) {
    const { slide, sec } = current();
    if (!sec) return false;
    const sel = editbar.selected();
    const index = sel && sel.sec === sec && Number.isInteger(sel.index) ? sel.index : null;
    const path = index !== null ? innerPath(sel) : null;
    let ok = false;
    const job = (async () => {
      let j;
      try { j = await commit.send('/deck/edit/element/paste', { slide, index, html: markup, ...(path?.length ? { path } : {}) }); } catch (e) {
        toast(`not pasted: ${commit.why(e)}`, 6000);
        return;
      }
      ok = true;
      const said = [
        j.dropped?.length ? `${j.dropped.join(', ')} left out` : '',
        j.missing?.length ? `${j.missing.join(', ')} ${j.missing.length === 1 ? 'is' : 'are'} not in this deck's folder: the picture is empty until it is` : '',
      ].filter(Boolean).join('; ');
      let els;
      try { els = place(sec, j); } catch (e) {
        debugLog('edit', `paste in place failed (${String(e.message || e)}) — reloading`);
        handOff({ slide, index: j.index, path: j.path ?? [], kind: null });
        commit.reload(`pasted${said ? `. ${said}` : ''}`, { slide });
        return;
      }
      instance.refreshSlide?.(sec, { charts: true, svgs: els, code: els.filter((el) => el.matches('pre') || el.querySelector('pre > code')), paint: sec });
      editbar.refresh();
      reveal(slide, els);
      settle(null, els[0]);
      toast(said ? `Pasted. ${said[0].toUpperCase()}${said.slice(1)}.` : 'pasted', said ? 6000 : 1800);
    })();
    await commit.track(job);
    return ok;
  }

  /**
   * Duplicate what `target` selects (PRESENTING_EDITING, Duplicate): the
   * element, or the node picked inside it (a picture in a figure), copied
   * right after itself by the server, which answers with the copy's markup.
   * The page puts that very markup where the file has it, refreshes the slide
   * as Add does and selects the copy. One write, one undo. A diagram's shapes
   * are shapes.js's (their copy is moved off the original and wired anew).
   */
  async function duplicate(target) {
    if (!editmode.elementEditOn()) { toast(editmode.cannot('duplicating'), 3200); return; }
    const { slide, sec, top } = target ?? {};
    if (!sec || !top || !Number.isInteger(target.index)) { toast('select an element to duplicate it', 2200); return; }
    const node = target.node && target.node !== top ? target.node : null;
    const path = node ? pathFrom(top, node) : null;
    if (node && !path) { toast('that is the engine’s, not the file’s: nothing to duplicate', 2600); return; }
    const job = (async () => {
      let j;
      try {
        j = await commit.send('/deck/edit/element/duplicate', { slide, index: target.index, tag: (node ?? top).tagName.toLowerCase(), ...(path ? { path } : {}) });
      } catch (e) {
        toast(`not duplicated: ${commit.why(e)}`, 6000);
        return;
      }
      let els;
      try {
        if (node) {
          const tpl = document.createElement('template');
          tpl.innerHTML = j.html;
          els = [...tpl.content.children];
          if (els.length !== 1) throw new Error('no element in the markup');
          node.after(els[0]);
        } else els = place(sec, j);
      } catch (e) {
        debugLog('edit', `duplicate in place failed (${String(e.message || e)}) — reloading`);
        if (!node) handOff({ slide, index: j.index, kind: 'duplicate' });
        commit.reload('duplicated — the page could not show it in place', { slide });
        return;
      }
      instance.refreshSlide?.(sec, {
        charts: true, svgs: els, code: els.filter((el) => el.matches('pre') || el.querySelector('pre > code')), paint: sec,
      });
      editbar.refresh();
      reveal(slide, els);
      if (node) editbar.selectNode(els[0], { exact: true }); else editbar.selectNode(els[0]);
      toast('duplicated', 1600);
    })();
    await commit.track(job);
  }

  /**
   * Put the file's new markup into the live slide where the file has it: after
   * top-level child `index - 1`, or with a `path` inside top-level child
   * `index` (a column), at that position among its children. Throws when it
   * cannot, a column the server had to wrap included: the page reloads then.
   */
  function place(sec, j) {
    if (typeof j.html !== 'string' || !Number.isInteger(j.index)) throw new Error('no markup came back');
    if (j.wrapped) throw new Error('its column was wrapped to take it');
    const tpl = document.createElement('template');
    tpl.innerHTML = j.html;
    const els = [...tpl.content.children];
    if (!els.length) throw new Error('no element in the markup');
    if (Array.isArray(j.path) && j.path.length) {
      const top = liveChild(sec, j.index);
      const holder = top && nodeAtPath(top, j.path.slice(0, -1));
      if (!holder) throw new Error(`no element ${j.index} › ${j.path.join('.')} on the page`);
      const before = authoredKids(holder)[j.path.at(-1)];
      if (before) before.before(...els); else holder.append(...els);
      if (pathFrom(top, els[0])?.join('.') !== j.path.join('.')) { els.forEach((el) => el.remove()); throw new Error('the page and the file disagree on where it went'); }
      return els;
    }
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

  /** Select the new element (itself, inside a column) and, for words, start typing them with the placeholder selected. */
  function settle(kind, el) {
    if (!el?.isConnected) return;
    editbar.selectNode(el, { exact: !el.parentElement?.matches('section') });
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
  editmode.onSlideAdded?.(({ slide, placed, typeTitle = true }) => {
    // added from the overview, the slide stays one cell among the others: nothing is typed under it
    if (typeTitle === false) return;
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
    const top = Number.isInteger(what.index) ? liveChild(sec, what.index) : null;
    const el = top && Array.isArray(what.path) ? nodeAtPath(top, what.path) : top;
    if (!el) return;
    reveal(what.slide, [el]);
    settle(what.kind, el);
  }
  const resumeWhenOn = (on) => { if (on) resume(); };
  editmode.onElementEditChange(resumeWhenOn);
  if (editmode.elementEditOn()) resume();

  return { open, add, pasteWords, paste, duplicate, addVideos, kinds: () => ADD_KINDS.map(([kind, label]) => ({ kind, label })) };
}
