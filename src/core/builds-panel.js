// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The inspector's Builds tab (PRESENTING_EDITING): a slide's builds, to read
// and to move around. One row a click, in the order they play, naming what
// arrives and how; what is there from the start is one row above them. A row
// shows the notes' beat that goes with its click, or says there is none, and
// beats past the last click follow. A click on a row steps the slide to it
// and selects what it brings.
//
// This module reads the slide and says what each step is in words; the rows
// themselves are buildlist.js's, pure. Nothing here writes the file.

import { buildRows, beatsLine, firstWords, moveClick, mergeClick, splitClick, orderGroups, evenStops, stagesOf } from './buildlist.js';
import { stepShowing, buildsPerItem } from './builds.js';
import { authoredIndex } from './design-system.js';

/** The entrance effects a step can have: Build ▸'s list, `none` last (a real step that arrives at once). */
export const EFFECTS = ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight', 'none'];

/** What a stroke is, in a diagram that draws. */
const STROKES = 'path, line, polyline, polygon, circle, ellipse, rect';
/** The paces a stroke is offered: the default (by its length when it draws in stages), slower, faster. */
const PACES = [['', 'default'], ['150', 'slow'], ['600', 'fast']];

/** Not what a slide shows: its notes and the like, and what the engine put there. */
const NOT_SHOWN = 'aside, script, style, template';

/** A slide element (or a node in one) in a few words: its first words, or what kind of thing it is. */
export function whatIs(el) {
  if (!el?.tagName) return 'step';
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return `picture${el.getAttribute('alt') ? `: ${firstWords(el.getAttribute('alt'), 4)}` : ''}`;
  if (el.matches('[data-chart]') || el.querySelector?.(':scope > [data-chart]')) return 'chart';
  if (tag === 'svg') {
    const strokes = el.querySelectorAll('.draw-stroke').length;
    return strokes ? `diagram · ${strokes} stroke${strokes === 1 ? '' : 's'}` : 'diagram';
  }
  if (tag === 'pre') return 'code';
  const words = firstWords(el.textContent);
  if (words) return words;
  if (el.querySelector?.('img')) return 'picture';
  if (el.closest?.('svg')) return 'a shape';
  return tag;
}

/** What one step of a slide's record is, for its row. */
function describe(st) {
  if (st.kind === 'provider') {
    const code = st.el?.matches?.('pre');
    const said = st.provider?.label ? st.provider.label(st.sub + 1) : `stage ${st.sub + 1}`;
    return { label: code ? said : said.replace(/^draw /, ''), effect: code ? 'lines' : 'draw', owner: code ? 'code' : 'stroke', el: st.el };
  }
  return { label: whatIs(st.el), effect: st.el.getAttribute('data-build-style') || 'fade', owner: null, el: st.el, container: st.container ?? null };
}

/**
 * The Builds tab, for `inspector.addTab`. `select(node)` selects a node on the
 * slide (the bar's selection), or is null where nothing selects; `edit` is
 * build-edit.js's, and `writable()` says whether this page may write now
 * (without it, the tab is to read and move around).
 */
export function createBuildsPanel({ instance, select = null, edit = null, writable = () => false }) {
  const inst = () => instance();

  /** The slide's rows, read from the slide as it is now. */
  function modelOf(slide) {
    const sec = inst()._sections?.[slide - 1];
    const rec = inst()._records?.[slide - 1] ?? { steps: [], groups: [] };
    const steps = rec.steps.map(describe);
    const start = sec ? [...sec.children]
      .filter((c) => !c.matches(NOT_SHOWN) && authoredIndex(sec, c) >= 0 && stepShowing(rec, c) === 0)
      .map(whatIs) : [];
    const notes = sec?.querySelector(':scope > aside.notes')?.innerHTML ?? '';
    // what carries each step's order: the element, or a code block / stroke for each of its steps
    const nodes = rec.steps.map((st) => ({ node: st.el, count: st.kind === 'provider' ? st.provider?.count ?? 1 : 1 }));
    return { ...buildRows({ steps, groups: rec.groups, start, notes }), steps, groups: rec.groups, nodes, sec };
  }

  function pane({ slide, target }) {
    const el = document.createElement('div');
    el.className = 'ins-builds';
    const chosen = target ? (target.node ?? target.top) : null;
    const paint = () => {
      const m = modelOf(slide);
      const can = !!edit && writable();
      const at = inst().state?.slide === slide ? inst().state.step : 0;
      el.textContent = '';
      if (m.start.length) {
        const start = line('bl-start', 'from the start', m.start.join(' · '));
        start.title = 'there from the start: no click brings it';
        el.append(start);
      }
      if (!m.rows.length) {
        el.append(Object.assign(document.createElement('div'), { className: 'ins-none', textContent: 'no builds on this slide: everything is there from the start' }));
      }
      const list = document.createElement('ol');
      list.className = 'bl-list';
      const ordered = m.nodes.some((x) => x.node?.hasAttribute?.('data-build-order'));
      for (const row of m.rows) {
        const li = document.createElement('li');
        li.className = 'bl-row';
        li.value = row.click;   // the list's own number: the click it is
        if (row.click === at) li.classList.add('bl-on');
        else if (row.click < at) li.classList.add('bl-past');
        if (can) dragRow(li, row, m);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bl-go';
        const n = Object.assign(document.createElement('span'), { className: 'bl-n', textContent: String(row.click) });
        const what = Object.assign(document.createElement('span'), { className: 'bl-what' });
        row.items.forEach((it, i) => {
          if (i) what.append(Object.assign(document.createElement('span'), { className: 'bl-with', textContent: 'with' }));
          const item = Object.assign(document.createElement('span'), { className: 'bl-item' });
          item.append(
            Object.assign(document.createElement('span'), { className: 'bl-fx', textContent: it.owner ?? it.effect }),
            Object.assign(document.createElement('span'), { className: 'bl-label', textContent: it.label }),
          );
          what.append(item);
        });
        const beat = Object.assign(document.createElement('span'), {
          className: `bl-beat${row.beat ? '' : ' bl-nobeat'}`, textContent: row.beat ?? 'no beat',
        });
        beat.title = row.beat ? `the notes' beat for click ${row.click}` : `the notes have no [click] beat for click ${row.click}`;
        b.title = `click ${row.click}: ${row.items.map((it) => it.label).join(' + ')}`;
        // the order was written, and this step came after (a point added to a list): it plays where the slide puts it, said
        if (ordered && row.items.some((it) => it.el && !it.el.hasAttribute('data-build-order'))) {
          li.classList.add('bl-unplaced');
          what.append(Object.assign(document.createElement('span'), {
            className: 'bl-flag', textContent: 'no place in the order',
            title: 'added after the order was written: it plays by its place on the slide; drag it where it goes',
          }));
        }
        b.append(n, what, beat);
        b.addEventListener('click', (e) => { e.stopPropagation(); go(slide, row.click, m, row); });
        li.append(b);
        if (can) li.append(rowTools(row, m));
        list.append(li);
      }
      if (m.rows.length) el.append(list);
      for (const x of m.extra) {
        const extra = line('bl-extra', `beat ${x.beat}`, x.text);
        extra.title = 'a beat after the last click: nothing arrives with it';
        el.append(extra);
      }
      el.append(Object.assign(document.createElement('div'), { className: 'bl-foot', textContent: beatsLine(m) }));
      if (can && chosen?.isConnected) el.append(selectedTools(chosen, slide));
    };
    paint();
    // the step moves (the keys, a row), the slide is scanned again (an edit): read it again
    const onBuild = (e) => { if (!e || e.slide === undefined || e.slide === slide) paint(); };
    inst().on?.('build', onBuild);
    inst().on?.('rescan', onBuild);
    return { el, destroy() { inst().off?.('build', onBuild); inst().off?.('rescan', onBuild); } };
  }

  // ── what can be changed (write mode) ────────────────────────────────────
  const btn = (label, title, run, cls = 'ins-btn') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label, title });
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  };
  /** A row's own settings: each element's effect, picked as Build ▸ picks it, and taking its step away. */
  /** Is this a row of a code block's lines or a stroke's stages: one that keeps with its block? */
  const ownedRow = (row) => row.items.some((it) => it.owner);
  /** The slide's clicks arranged anew, written: one undo, nothing on the slide moves. */
  function arrange(m, groups, said) {
    edit.order(m.sec, orderGroups(groups, m.nodes), said);
  }
  /**
   * A row is dragged by its grip: dropped above or below another row it plays
   * there, dropped onto one it arrives with it. A code line's or a stage's row
   * keeps with its block, so nothing arrives with it and it is not dragged.
   */
  let dragFrom = null;
  function dragRow(li, row, m) {
    const g = row.click - 1;
    const owned = ownedRow(row);
    const grip = Object.assign(document.createElement('span'), { className: 'bl-grip', textContent: '⋮⋮', title: owned ? 'it keeps with its block' : 'drag to reorder · drop on a row to arrive with it' });
    li.prepend(grip);
    if (!owned) {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => { dragFrom = g; e.dataTransfer?.setData('text/plain', String(row.click)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; li.classList.add('bl-dragging'); });
      li.addEventListener('dragend', () => { dragFrom = null; li.classList.remove('bl-dragging'); });
    }
    const zone = (e) => {
      const r = li.getBoundingClientRect();
      const y = (e.clientY - r.top) / (r.height || 1);
      if (y < 0.3) return 'before';
      if (y > 0.7) return 'after';
      return owned ? (y < 0.5 ? 'before' : 'after') : 'onto';
    };
    const mark = (z) => { for (const k of ['before', 'after', 'onto']) li.classList.toggle(`bl-drop-${k}`, z === k); };
    li.addEventListener('dragover', (e) => { if (dragFrom === null || dragFrom === g) return; e.preventDefault(); mark(zone(e)); });
    li.addEventListener('dragleave', () => mark(null));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      mark(null);
      const from = dragFrom;
      dragFrom = null;
      if (from === null || from === g) return;
      const z = zone(e);
      if (z === 'onto') arrange(m, mergeClick(m.groups, from, g), `arrives with click ${row.click}`);
      else arrange(m, moveClick(m.groups, from, z === 'before' ? g : g + 1), 'build order changed');
    });
  }
  function rowTools(row, m) {
    const tools = Object.assign(document.createElement('span'), { className: 'bl-tools' });
    const g = row.click - 1;
    // the same, with no drag: onto the click before it, or apart again
    if (g > 0 && !ownedRow(row) && !ownedRow(m.rows[g - 1])) {
      tools.append(btn('⤒', `with previous: arrives with click ${row.click - 1}`, () => arrange(m, mergeClick(m.groups, g, g - 1), `arrives with click ${row.click - 1}`), 'ins-btn bl-with-prev'));
    }
    if (row.items.length > 1 && !ownedRow(row)) {
      tools.append(btn('split', 'on its own click: each of these arrives on a click of its own', () => arrange(m, splitClick(m.groups, g), 'each on its own click'), 'ins-btn bl-split'));
    }
    for (const it of row.items) {
      if (it.owner || !it.el?.isConnected) continue;   // a code line or a stroke's stage is its block's
      const pick = document.createElement('select');
      pick.className = 'bl-pick';
      pick.title = `how “${it.label}” arrives`;
      for (const fx of EFFECTS) pick.append(new Option(fx === 'none' ? 'none (instant)' : fx, fx, false, fx === it.effect));
      pick.addEventListener('click', (e) => e.stopPropagation());
      pick.addEventListener('change', () => edit.set(it.el, { effect: pick.value }, `click ${row.click}: ${pick.value}`));
      tools.append(pick);
      // a point of a built list leaves its click by being there from the start; an element of its own, by losing its build
      tools.append(it.container
        ? btn('✕', 'there from the start: no click brings it', () => edit.set(it.el, { stay: true }, 'there from the start'), 'ins-btn bl-remove')
        : btn('✕', 'remove this step: it is there from the start', () => edit.set(it.el, { effect: null }, 'step removed'), 'ins-btn bl-remove'));
    }
    return tools;
  }
  /** The selected element's settings: there from the start, one step an item or all at once, a step added or taken away. */
  function selectedTools(node, slide) {
    const rec = inst()._records?.[slide - 1] ?? { steps: [], groups: [] };
    const box = Object.assign(document.createElement('div'), { className: 'bl-selected' });
    box.append(Object.assign(document.createElement('div'), { className: 'bl-head', textContent: `selected: ${whatIs(node)}` }));
    const lineOf = (...kids) => { const d = Object.assign(document.createElement('div'), { className: 'bl-line' }); d.append(...kids); box.append(d); };
    const builtHere = node.hasAttribute('data-build');
    const parentBuilds = !!node.parentElement && rec.steps.some((st) => st.container === node.parentElement);
    const staying = node.hasAttribute('data-build-stay');
    // a list, a table, a group that builds: one step an item, or all of it on one click
    if (builtHere && buildsPerItem(node)) {
      const once = node.hasAttribute('data-build-self');
      const name = `bl-self-${slide}`;
      for (const [value, label] of [[false, 'one step per item'], [true, 'all at once']]) {
        const r = Object.assign(document.createElement('input'), { type: 'radio', name, checked: once === value, className: 'bl-radio' });
        r.value = value ? 'once' : 'each';
        r.addEventListener('change', () => { if (r.checked) edit.set(node, { self: value }, value ? 'the whole of it on one click' : 'one step per item'); });
        const l = document.createElement('label');
        l.append(r, document.createTextNode(` ${label}`));
        lineOf(l);
      }
    }
    // a point of a built list (or one already kept back): there from the start
    if (parentBuilds || staying) {
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: staying, className: 'bl-stay' });
      c.addEventListener('change', () => edit.set(node, { stay: c.checked }, c.checked ? 'there from the start' : 'back on its click'));
      const l = document.createElement('label');
      l.append(c, document.createTextNode(' there from the start'));
      lineOf(l);
    }
    // a stroke in a draw build: drawn in stages, at a pace (data-draw-stops, data-draw-speed)
    if (node.matches?.(STROKES) && (node.getAttribute('data-build') === 'draw' || node.closest('[data-build="draw"]'))) {
      const n = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: '12', step: '1', className: 'bl-stages', value: String(stagesOf(node.getAttribute('data-draw-stops'))) });
      n.title = 'one click a stage, each drawing an even part of the stroke';
      n.addEventListener('change', () => {
        const k = Math.max(1, Math.min(12, Math.round(Number(n.value) || 1)));
        edit.set(node, { drawStops: evenStops(k) }, k > 1 ? `drawn in ${k} stages` : 'drawn at once');
      });
      const l = document.createElement('label');
      l.append(document.createTextNode('Draw in '), n, document.createTextNode(' stages'));
      lineOf(l);
      const pace = document.createElement('select');
      pace.className = 'bl-pace';
      pace.title = 'how fast it draws, in path units a second';
      const now = node.getAttribute('data-draw-speed');
      for (const [v, label] of PACES) pace.append(new Option(label, v, false, v === (now ?? '')));
      if (now && !PACES.some(([v]) => v === now)) pace.append(new Option(`${now} a second`, now, true, true));
      pace.addEventListener('change', () => edit.set(node, { drawSpeed: pace.value ? Number(pace.value) : null }, `pace: ${pace.selectedOptions[0]?.textContent}`));
      const pl = document.createElement('label');
      pl.append(document.createTextNode('Speed '), pace);
      lineOf(pl);
    }
    // its own step: taken away; none, and not inside one: added
    if (builtHere) lineOf(btn('Remove this step', 'take its build off: it is there from the start', () => edit.set(node, { effect: null }, 'step removed'), 'ins-btn bl-drop'));
    else if (!parentBuilds && stepShowing(rec, node) === 0 && !node.closest('[data-build]')) {
      lineOf(btn('Add a step', 'it arrives on a click of its own, faded in', () => edit.set(node, { effect: '' }, 'a step added'), 'ins-btn bl-add'));
    }
    return box;
  }

  function line(cls, head, text) {
    const d = Object.assign(document.createElement('div'), { className: cls });
    d.append(Object.assign(document.createElement('span'), { className: 'bl-head', textContent: head }),
      Object.assign(document.createElement('span'), { className: 'bl-text', textContent: text }));
    return d;
  }

  /** A row clicked: the slide stepped to its click, and what it brings selected (a code line's or a stage's block). */
  function go(slide, click, m, row) {
    if (inst().state?.slide !== slide || inst().state.step !== click) inst().goto(slide, click);
    const node = row.items.find((it) => it.el?.isConnected)?.el;
    if (node && select) select(node);
  }

  const tab = {
    id: 'builds', label: 'Builds', title: 'this slide’s clicks, in the order they play, and the beat that goes with each',
    showsWithoutSelection: true, showsWithSelection: true,
    // the slide, and what is selected on it: the settings below the rows are the selection's
    key: (ctx) => (ctx.target ? (ctx.target.node ?? ctx.target.top) : `slide ${ctx.slide}`),
    pane,
    foot: 'click a row to go there · esc closes',
  };
  return { tab, modelOf };
}
