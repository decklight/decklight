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

import { buildRows, beatsLine, firstWords } from './buildlist.js';
import { stepShowing } from './builds.js';
import { authoredIndex } from './design-system.js';

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
  return { label: whatIs(st.el), effect: st.el.getAttribute('data-build-style') || 'fade', owner: null, el: st.el };
}

/**
 * The Builds tab, for `inspector.addTab`. `select(node)` selects a node on the
 * slide (the bar's selection), or is null where nothing selects.
 */
export function createBuildsPanel({ instance, select = null }) {
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
    return { ...buildRows({ steps, groups: rec.groups, start, notes }), steps };
  }

  function pane({ slide }) {
    const el = document.createElement('div');
    el.className = 'ins-builds';
    const paint = () => {
      const m = modelOf(slide);
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
      for (const row of m.rows) {
        const li = document.createElement('li');
        li.className = 'bl-row';
        li.value = row.click;   // the list's own number: the click it is
        if (row.click === at) li.classList.add('bl-on');
        else if (row.click < at) li.classList.add('bl-past');
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
        b.append(n, what, beat);
        b.addEventListener('click', (e) => { e.stopPropagation(); go(slide, row.click, m, row); });
        li.append(b);
        list.append(li);
      }
      if (m.rows.length) el.append(list);
      for (const x of m.extra) {
        const extra = line('bl-extra', `beat ${x.beat}`, x.text);
        extra.title = 'a beat after the last click: nothing arrives with it';
        el.append(extra);
      }
      el.append(Object.assign(document.createElement('div'), { className: 'bl-foot', textContent: beatsLine(m) }));
    };
    paint();
    // the step moves (the keys, a row), the slide is scanned again (an edit): read it again
    const onBuild = (e) => { if (!e || e.slide === undefined || e.slide === slide) paint(); };
    inst().on?.('build', onBuild);
    inst().on?.('rescan', onBuild);
    return { el, destroy() { inst().off?.('build', onBuild); inst().off?.('rescan', onBuild); } };
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
    key: (ctx) => ctx.slide,
    pane,
    foot: 'click a row to go there · esc closes',
  };
  return { tab, modelOf };
}
