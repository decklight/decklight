// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The inspector's Options tab (PRESENTING_EDITING): a selected block's
 * settings as plain fields, the way a chart has its Data tab. For a code
 * block (CODE_AND_MATH): its language, line numbers, fit to its space, and its
 * line steps, a row each, filled by typing or by clicking lines in the block.
 *
 * It works as the Data tab does: the block's source is read from the file once,
 * a change shows on the slide at once (the block set up again from its source,
 * highlighted and lined, its steps counted again), and what changed is written
 * after a pause, a burst of changes as ONE write through
 * `POST /deck/edit/element/options`, so one undo takes the burst back. A step
 * the block cannot take (a line past its end) is refused in its row, with a
 * sentence, and nothing of the steps is written until every row is one the
 * block can take.
 */

import { boundedFetch } from './devmode.js';
import { holdDraft } from './drafts.js';
import { createEditCommit } from './edit-commit.js';
import { pathFrom } from './colorpicker.js';
import { nodeAtPath } from './authoring.js';
import { UNDO_CHORD } from './undo-chord.js';
import { CODE_LANGUAGES, languageOf, lineCount, specOf, stepError, stepsOf, toggleLine } from '../../tools/code-options.mjs';

/** How long the fields rest before what they say is written: the chart grid's. */
const QUIET_MS = 700;

/** A code block the runtime lines: a `<pre>` holding a `<code>`, not a terminal's. */
const isCodeBlock = (n) => !!n?.matches?.('pre') && !!n.querySelector(':scope > code') && !n.closest('.terminal, aside');

/**
 * The code block the selection is: the one the click landed in, else the only
 * one in the element selected, else null.
 */
export function codeBlockOf(target) {
  const top = target?.top;
  if (!top) return null;
  for (const n of [target.node, target.clicked]) {
    const pre = n?.isConnected ? n.closest?.('pre') : null;
    if (pre && top.contains(pre) && isCodeBlock(pre)) return pre;
  }
  const all = [...(isCodeBlock(top) ? [top] : []), ...[...top.querySelectorAll('pre')].filter(isCodeBlock)];
  return all.length === 1 ? all[0] : null;
}

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

export function createOptionsTab({ instance, editmode, toast }) {
  const em = () => editmode();
  const editing = () => !!(em()?.available?.() && em()?.elementEditOn?.());
  // the block last shown: a change sets its lines up again, so the line that
  // was clicked to select it is gone, and the block is still the one selected
  let last = null;
  const blockFor = (t) => {
    const b = codeBlockOf(t);
    if (b) return (last = b);
    return last?.isConnected && t?.top?.contains(last) && !t.clicked?.isConnected ? last : null;
  };

  /** The pane for the code block `pre` of `target`, kept while the block is selected. */
  function codePane(target, pre) {
    const commit = createEditCommit(em());
    const { slide, index } = target;
    const path = target.top === pre ? [] : pathFrom(target.top, pre);
    const el = h('div', 'ins-options');
    // what the file has: the block's code, and its settings as last written
    let text = null;
    let total = 0;
    let saved = null;     // { language, raw, numbers, fit, steps }
    let state = null;     // what the slide shows now
    let srcStyle = null;  // the block's own style attribute in the file
    let problem = null;
    let dirty = new Set();
    let timer = 0;
    let saving = 0;
    let queue = Promise.resolve();
    let failed = null;
    let lastRow = null;   // the step a click on a line goes into
    const letGo = holdDraft(() => (dirty.size || saving ? `the code block’s settings on slide ${slide}` : null));

    const settingsOf = (node) => {
      const code = node.querySelector(':scope > code');
      const raw = [...(code?.classList ?? [])].find((c) => c.startsWith('language-'))?.slice(9) ?? '';
      return {
        raw, language: languageOf(raw),
        numbers: node.hasAttribute('data-lines-numbers'),
        fit: node.hasAttribute('data-fit'),
        steps: stepsOf(node.getAttribute('data-lines')),
      };
    };
    async function load() {
      try {
        if (!path) throw new Error('the block is not where the file has it');
        const res = await boundedFetch(`${em().base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || String(res.status));
        const tpl = document.createElement('template');
        tpl.innerHTML = j.html;
        const node = nodeAtPath(tpl.content.firstElementChild, path);
        if (!isCodeBlock(node)) throw new Error('the file has no code block where the page has it');
        text = node.querySelector(':scope > code').textContent;
        total = lineCount(text);
        srcStyle = node.getAttribute('style');
        saved = settingsOf(node);
        state = { ...saved, steps: [...saved.steps] };
      } catch (e) {
        problem = `could not read the block from the file: ${String(e.message || e)}`;
      }
      paint();
    }

    // ── on the slide at once ───────────────────────────────────────────────
    const validSteps = () => state.steps.every((s) => stepError(s, total) === null);
    function show() {
      if (!pre.isConnected) return;
      const code = pre.querySelector(':scope > code');
      const lang = state.language === null ? state.raw : state.language;
      for (const c of [...code.classList]) if (c.startsWith('language-') || c === 'hljs') code.classList.remove(c);
      if (lang) code.classList.add(`language-${lang}`);
      pre.toggleAttribute('data-lines-numbers', state.numbers);
      pre.toggleAttribute('data-fit', state.fit);
      if (!state.fit) {
        // the size data-fit set goes with it: the block's own style is the file's
        pre.removeAttribute('data-fit-scale');
        if (srcStyle === null) pre.removeAttribute('style'); else pre.setAttribute('style', srcStyle);
      }
      if (validSteps()) { const spec = specOf(state.steps); if (spec) pre.setAttribute('data-lines', spec); else pre.removeAttribute('data-lines'); }
      // set up again from its source: highlighted, lined and stepped as at load
      code.textContent = text;
      const sec = pre.closest('section');
      instance().refreshSlide?.(sec, { code: [pre], scan: pre });
    }
    function change(name) {
      dirty.add(name);
      failed = null;
      show();
      later();
      status();
    }

    // ── to the file, after a pause ────────────────────────────────────────
    function later() { clearTimeout(timer); timer = setTimeout(() => flush(), QUIET_MS); }
    function wanted() {
      const set = {};
      if (dirty.has('language') && state.language !== null) set.language = state.language;
      if (dirty.has('numbers')) set['data-lines-numbers'] = state.numbers ? true : null;
      if (dirty.has('fit')) set['data-fit'] = state.fit ? true : null;
      if (dirty.has('steps') && validSteps()) set['data-lines'] = specOf(state.steps);
      return set;
    }
    function flush() {
      clearTimeout(timer);
      if (!dirty.size || !saved) return queue;
      const set = wanted();
      // steps a row refuses wait in the field; the rest of the burst goes
      for (const k of ['language', 'numbers', 'fit']) dirty.delete(k);
      if (Object.hasOwn(set, 'data-lines')) dirty.delete('steps');
      if (!Object.keys(set).length) { status(); return queue; }
      saving++;
      status();
      const was = { ...saved, steps: [...saved.steps] };
      const next = { ...state, steps: [...state.steps] };
      const p = queue.then(() => commit.send('/deck/edit/element/options', { slide, index, path, tag: 'pre', set }))
        .then(() => {
          if (Object.hasOwn(set, 'language')) { saved.language = next.language; saved.raw = next.language; }
          if (Object.hasOwn(set, 'data-lines-numbers')) saved.numbers = next.numbers;
          if (Object.hasOwn(set, 'data-fit')) saved.fit = next.fit;
          if (Object.hasOwn(set, 'data-lines')) saved.steps = [...next.steps];
        }, (e) => {
          // refused: the slide and the fields go back to what the file has
          failed = commit.notSaved('the code block’s settings', e);
          state = { ...was, steps: [...was.steps] };
          show();
          paint();
          toast(failed, 6000);
        })
        .finally(() => { saving--; status(); });
      queue = p;
      return commit.track(p);
    }

    // ── the fields ─────────────────────────────────────────────────────────
    let statusEl = null;
    function status() {
      if (!statusEl) return;
      statusEl.classList.toggle('ins-failed', !!failed);
      statusEl.textContent = failed ?? (saving ? 'saving…' : `saved as you change it · ${UNDO_CHORD} takes back each burst`);
    }
    const keys = (n) => n.addEventListener('keydown', (e) => e.stopPropagation());
    function row(grid, key, label, title, ...nodes) {
      const dt = h('dt', null, label);
      if (title) dt.title = title;
      const dd = h('dd');
      dd.dataset.key = key;
      dd.append(...nodes);
      grid.append(dt, dd);
    }
    function check(key, label, title, get, set) {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'ins-check' });
      box.setAttribute('aria-label', label);
      box.checked = get();
      keys(box);
      box.addEventListener('change', () => { set(box.checked); change(key); });
      return box;
    }
    function stepRows(list) {
      list.textContent = '';
      state.steps.forEach((step, i) => {
        const line = h('div', 'ins-step');
        const n = h('span', 'ins-step-n', String(i + 1));
        const input = Object.assign(document.createElement('input'), { type: 'text', className: 'ins-field ins-step-lines', value: step, placeholder: '1-2' });
        input.setAttribute('aria-label', `step ${i + 1}: its lines`);
        input.spellcheck = false;
        const why = h('div', 'ins-step-why');
        const judge = () => {
          const w = stepError(input.value, total);
          why.textContent = w ?? '';
          why.hidden = !w;
          input.classList.toggle('ins-invalid', !!w);
          input.setAttribute('aria-invalid', w ? 'true' : 'false');
        };
        judge();
        input.addEventListener('focus', () => { lastRow = i; });
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); flush(); }
        });
        input.addEventListener('input', () => { state.steps[i] = input.value.trim(); judge(); change('steps'); });
        input.addEventListener('blur', () => flush());
        const drop = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn ins-step-drop', textContent: '✕', title: `remove step ${i + 1}` });
        drop.addEventListener('click', (e) => {
          e.stopPropagation();
          state.steps.splice(i, 1);
          if (lastRow !== null && lastRow >= state.steps.length) lastRow = state.steps.length ? state.steps.length - 1 : null;
          stepRows(list);
          change('steps');
          flush();
        });
        line.append(n, input, drop, why);
        list.append(line);
      });
    }
    function paint() {
      el.textContent = '';
      if (problem) { el.append(h('div', 'ins-none', problem)); return; }
      if (!state) { el.append(h('div', 'ins-none', 'reading the block from the file…')); return; }
      const grid = h('dl', 'ins-rows ins-settings');
      // language: the highlighter's list, and plain; a name it does not know is shown as it is
      const pick = Object.assign(document.createElement('select'), { className: 'ins-field ins-select' });
      pick.setAttribute('aria-label', 'Language');
      pick.append(Object.assign(document.createElement('option'), { value: '', textContent: 'plain text' }));
      for (const [v, label] of CODE_LANGUAGES) pick.append(Object.assign(document.createElement('option'), { value: v, textContent: label }));
      if (state.language === null) pick.append(Object.assign(document.createElement('option'), { value: `?${state.raw}`, textContent: `${state.raw} (not highlighted)` }));
      pick.value = state.language === null ? `?${state.raw}` : state.language;
      keys(pick);
      pick.addEventListener('change', () => {
        if (pick.value.startsWith('?')) return;
        state.language = pick.value;
        state.raw = pick.value;
        change('language');
      });
      row(grid, 'language', 'Language', 'how its words are coloured', pick);
      row(grid, 'numbers', 'Line numbers', 'a number in front of every line',
        check('numbers', 'Line numbers', null, () => state.numbers, (v) => { state.numbers = v; }));
      row(grid, 'fit', 'Fit to its space', 'as large as the slide has room for, never larger than its own size',
        check('fit', 'Fit to its space', null, () => state.fit, (v) => { state.fit = v; }));
      grid.append(h('div', 'ins-group', 'Light up lines, one click each'));
      const list = h('div', 'ins-steps');
      stepRows(list);
      const add = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn ins-step-add', textContent: '+ a step', title: 'one more click that lights lines up' });
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        state.steps.push(state.steps.length ? 'all' : '1');
        lastRow = state.steps.length - 1;
        stepRows(list);
        change('steps');
        list.lastElementChild?.querySelector('input')?.focus();
      });
      const hint = h('div', 'ins-step-hint', `or click lines in the block: they go into the step you were last in · the block has ${total} line${total === 1 ? '' : 's'}`);
      const box = h('dd', 'ins-steps-box');
      box.dataset.key = 'steps';
      box.append(list, add, hint);
      grid.append(box);
      el.append(grid);
      statusEl = h('div', 'ins-options-status');
      el.append(statusEl);
      status();
    }

    // a click on a line of the block puts that line into the step last typed in
    const onLine = (e) => {
      if (!state || lastRow === null || lastRow >= state.steps.length) return;
      const line = e.target?.closest?.('.code-line');
      if (!line || !pre.contains(line)) return;
      const n = [...pre.querySelectorAll(':scope > code > .code-line')].indexOf(line) + 1;
      if (n < 1) return;
      // the click is the step's: the block stays selected, and its lines are
      // set up again below, so nothing else may act on the line clicked
      e.stopPropagation();
      e.preventDefault();
      state.steps[lastRow] = toggleLine(state.steps[lastRow], n);
      paint();
      change('steps');
    };
    document.addEventListener('click', onLine, true);

    paint();
    load();
    return {
      el,
      pre,
      destroy() {
        document.removeEventListener('click', onLine, true);
        const p = flush();
        p.finally(letGo);
        return p;
      },
    };
  }

  const tab = {
    id: 'options', label: 'Options', title: 'this block’s settings',
    enabled: (ctx) => (blockFor(ctx.target) ? true : 'no settings here'),
    shows: (ctx) => editing() && !!blockFor(ctx.target),
    key: (ctx) => blockFor(ctx.target),
    keeps: true,
    pane: (ctx) => codePane(ctx.target, blockFor(ctx.target)),
    foot: 'esc lets go of it',
  };
  return { tab };
}
