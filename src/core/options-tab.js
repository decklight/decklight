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
/** A video the author put on a slide (not the engine's background clip). */
const isSlideVideo = (n) => !!n?.matches?.('video') && !n.closest('.slide-bg, .terminal, aside');

/** The video the selection is: itself, or the only one in the element selected. */
export function videoOf(target) {
  const top = target?.top;
  if (!top) return null;
  for (const n of [target.node, target.clicked]) {
    const v = n?.isConnected ? n.closest?.('video') : null;
    if (v && top.contains(v) && isSlideVideo(v)) return v;
  }
  const all = [...(isSlideVideo(top) ? [top] : []), ...[...top.querySelectorAll('video')].filter(isSlideVideo)];
  return all.length === 1 ? all[0] : null;
}

/** The terminal the selection is in (TERMINAL_PLAYER), or the only one in the element selected. */
export function terminalOf(target) {
  const top = target?.top;
  if (!top) return null;
  for (const n of [target.node, target.clicked]) {
    const t = n?.isConnected ? n.closest?.('.terminal') : null;
    if (t && top.contains(t) && t.matches('div')) return t;
  }
  const all = [...(top.matches?.('div.terminal') ? [top] : []), ...top.querySelectorAll('div.terminal')];
  return all.length === 1 ? all[0] : null;
}

/** The framed web page the selection is, or the only one in the element selected. */
export function frameOf(target) {
  const top = target?.top;
  if (!top) return null;
  if (top.matches?.('iframe')) return top;
  const all = [...top.querySelectorAll('iframe')];
  return all.length === 1 ? all[0] : null;
}
/** Where a framed page is blank, said in its Options and by Check deck. */
export const FRAME_BLANK = 'blank in no-trust mode, in a video export and offline: the page is someone else’s, fetched as the slide shows';

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
    const b = terminalOf(t) ?? codeBlockOf(t) ?? videoOf(t) ?? frameOf(t);
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

  // ── a video's settings (DECK_ANATOMY) ───────────────────────────────────
  /** Choose a file of `accept` and upload it beside the deck (POST /deck/edit/asset): its path, or null. */
  function upload(accept, label) {
    return new Promise((done) => {
      const pick = Object.assign(document.createElement('input'), { type: 'file', accept, hidden: true });
      pick.addEventListener('change', async () => {
        const file = pick.files?.[0] ?? null;
        pick.remove();
        if (!file) { done(null); return; }
        try {
          const res = await boundedFetch(`${em().base()}/deck/edit/asset`, {
            method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file,
          }, { ms: 600000 });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.src) throw new Error(j.error || String(res.status));
          done(j.src);
        } catch (e) { toast(`could not use ${file.name} as the ${label}: ${String(e.message || e)}`, 6000); done(null); }
      });
      document.body.append(pick);
      pick.click();
    });
  }

  /**
   * The pane for video `video` of `target`: its file (Replace…), controls,
   * loop, muted, play on arrival (which needs muted, and says so) and its
   * poster. Shown on the slide at once and written after a pause, as the
   * code block's are.
   */
  function videoPane(target, video) {
    const commit = createEditCommit(em());
    const { slide, index } = target;
    const path = target.top === video ? [] : pathFrom(target.top, video);
    const media = () => instance()._slideMedia;
    const el = h('div', 'ins-options');
    const TOGGLES = [['controls', 'Controls', 'the player’s own play, pause and timeline'], ['loop', 'Loop', 'starts again when it ends'],
      ['muted', 'Muted', 'no sound'], ['autoplay', 'Play when the slide arrives', 'it starts as its slide comes on, muted']];
    let saved = null;
    let state = null;
    let problem = null;
    const dirty = new Set();
    let timer = 0;
    let saving = 0;
    let queue = Promise.resolve();
    let note = '';
    const letGo = holdDraft(() => (dirty.size || saving ? `the video’s settings on slide ${slide}` : null));
    const read = (node) => ({
      src: node.getAttribute('src') ?? '', poster: node.getAttribute('poster'),
      ...Object.fromEntries(TOGGLES.map(([k]) => [k, node.hasAttribute(k)])),
    });
    async function load() {
      try {
        if (!path) throw new Error('the video is not where the file has it');
        const res = await boundedFetch(`${em().base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || String(res.status));
        const tpl = document.createElement('template');
        tpl.innerHTML = j.html;
        const node = nodeAtPath(tpl.content.firstElementChild, path);
        if (!node?.matches?.('video')) throw new Error('the file has no video where the page has it');
        saved = read(node);
        state = { ...saved };
      } catch (e) { problem = `could not read the video from the file: ${String(e.message || e)}`; }
      paint();
    }
    function show() {
      if (!video.isConnected) return;
      if (video.getAttribute('src') !== state.src) video.setAttribute('src', state.src);
      if (state.poster) video.setAttribute('poster', state.poster); else video.removeAttribute('poster');
      for (const k of ['controls', 'loop', 'muted']) video.toggleAttribute(k, state[k]);
      video.muted = state.muted;
      // play on arrival is the runtime's to keep (slide-media.js), never a live autoplay
      media()?.setPlaysOnArrival?.(video, state.autoplay);
    }
    const NAMES = { src: 'src', poster: 'poster', controls: 'controls', loop: 'loop', muted: 'muted', autoplay: 'autoplay' };
    function change(k) { dirty.add(k); show(); clearTimeout(timer); timer = setTimeout(() => flush(), QUIET_MS); paint(); }
    function flush() {
      clearTimeout(timer);
      if (!dirty.size || !saved) return queue;
      const set = {};
      for (const k of dirty) {
        const v = state[k];
        set[NAMES[k]] = k === 'src' ? v : k === 'poster' ? (v || null) : (v ? true : null);
      }
      dirty.clear();
      saving++;
      const was = { ...saved };
      const next = { ...state };
      const p = queue.then(() => commit.send('/deck/edit/element/options', { slide, index, path, tag: 'video', set }))
        .then(() => { saved = { ...saved, ...Object.fromEntries(Object.keys(set).map((k) => [k, next[k]])) }; },
          (e) => { state = { ...was }; show(); toast(commit.notSaved('the video’s settings', e), 6000); paint(); })
        .finally(() => { saving--; });
      queue = p;
      return commit.track(p);
    }
    const leaf = (p) => (p ? String(p).split('/').pop() : 'none');
    function paint() {
      el.textContent = '';
      if (problem) { el.append(h('div', 'ins-none', problem)); return; }
      if (!state) { el.append(h('div', 'ins-none', 'reading the video from the file…')); return; }
      const grid = h('dl', 'ins-rows ins-settings');
      const row = (key, label, title, ...nodes) => {
        const dt = h('dt', null, label);
        if (title) dt.title = title;
        const dd = h('dd');
        dd.dataset.key = key;
        dd.append(...nodes);
        grid.append(dt, dd);
      };
      const btn = (cls, text, title, run) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: `ins-btn ${cls}`, textContent: text, title });
        b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
        return b;
      };
      const file = h('span', 'ins-value ins-file', leaf(state.src));
      file.title = state.src;
      const line = h('span', 'ins-line');
      line.append(file, btn('ins-replace', 'Replace…', 'another mp4 or webm, copied beside the deck', async () => {
        const src = await upload('video/mp4,video/webm', 'video');
        if (src) { state.src = src; change('src'); }
      }));
      row('file', 'File', 'the video beside the deck', line);
      for (const [k, label, title] of TOGGLES) {
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'ins-check', checked: state[k] });
        box.setAttribute('aria-label', label);
        box.addEventListener('keydown', (e) => e.stopPropagation());
        box.addEventListener('change', () => {
          state[k] = box.checked;
          note = '';
          // a browser will not start a video with sound: arriving needs muted, and says so
          if (k === 'autoplay' && box.checked && !state.muted) { state.muted = true; dirty.add('muted'); note = 'muted with it: a browser will not start a video with sound'; }
          if (k === 'muted' && !box.checked && state.autoplay) { state.autoplay = false; dirty.add('autoplay'); note = 'it no longer plays when the slide arrives: a browser will not start a video with sound'; }
          change(k);
        });
        row(k, label, title, box);
      }
      if (note) grid.append(h('div', 'ins-opt-note', note));
      const pline = h('span', 'ins-line');
      const pfile = h('span', 'ins-value ins-file', leaf(state.poster));
      pfile.title = state.poster ?? '';
      pline.append(pfile, btn('ins-poster', state.poster ? 'Replace…' : 'Choose…', 'the picture shown before it plays, and in print', async () => {
        const src = await upload('image/*', 'poster');
        if (src) { state.poster = src; change('poster'); }
      }));
      if (state.poster) pline.append(btn('ins-poster-off', 'Remove', 'no poster: its first frame instead', () => { state.poster = null; change('poster'); }));
      row('poster', 'Poster', 'the picture shown before it plays, and in print', pline);
      el.append(grid);
    }
    paint();
    load();
    return { el, video, destroy() { const p = flush(); p.finally(letGo); return p; } };
  }

  // ── a framed web page's settings ─────────────────────────────────────────
  /**
   * The pane for frame `frame`: its address and title, each written as it is
   * entered (⏎, or leaving the field; Esc puts it back), and where it is blank.
   */
  function framePane(target, frame) {
    const commit = createEditCommit(em());
    const { slide, index } = target;
    const path = target.top === frame ? [] : pathFrom(target.top, frame);
    const el = h('div', 'ins-options');
    const grid = h('dl', 'ins-rows ins-settings');
    const field = (key, label, placeholder) => {
      const input = Object.assign(document.createElement('input'), { type: key === 'src' ? 'url' : 'text', className: 'ins-field', value: frame.getAttribute(key) ?? '', placeholder, spellcheck: false });
      input.setAttribute('aria-label', label);
      let was = input.value;
      const commitIt = async () => {
        const v = input.value.trim();
        if (v === was) return;
        try {
          await commit.post('/deck/edit/element/options', { slide, index, path, tag: 'iframe', set: { [key]: v } });
          frame.setAttribute(key, v);
          was = v;
        } catch (e) { toast(commit.notSaved(`the web page’s ${label.toLowerCase()}`, e), 6000); input.value = was; }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitIt(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.value = was; input.blur(); }
      });
      input.addEventListener('blur', () => commitIt());
      grid.append(h('dt', null, label));
      const dd = h('dd');
      dd.dataset.key = key;
      dd.append(input);
      grid.append(dd);
    };
    field('src', 'Address', 'https://…');
    field('title', 'Title', 'what a screen reader says it is');
    grid.append(h('div', 'ins-opt-note', `It is ${FRAME_BLANK}.`));
    el.append(grid);
    return { el, frame, destroy() {} };
  }

  // ── a terminal's settings (TERMINAL_PLAYER) ─────────────────────────────
  /** The fields, as the player reads them; '' is the player's default (the attribute off). */
  const TERMINAL_FIELDS = [
    ['data-mode', 'Plays', 'choice', [['step', 'a command a click'], ['play', 'by itself']], 'step'],
    ['data-title', 'Title', 'text', null, ''],
    ['data-rows', 'Rows', 'number', [4, 60], ''],
    ['data-type-speed', 'Typing speed', 'choice', [['', 'the player’s (5)'], ...Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)])], ''],
    ['data-type-sound', 'Typing sound', 'choice', [['', 'the player’s (thocky)'], ['thocky', 'thocky'], ['creamy', 'creamy'], ['clacky', 'clacky'], ['off', 'off']], ''],
    ['data-poster', 'Poster', 'number', [0, 99], ''],
  ];
  /**
   * The pane for terminal `term`: which recording, how it plays, its title,
   * rows, typing speed and sound, its poster. A terminal is set up when the
   * deck loads, so the changes are gathered and written with one button, and
   * the deck reloads to show them.
   */
  function terminalPane(target, term) {
    const commit = createEditCommit(em());
    const { slide, index } = target;
    const path = target.top === term ? [] : pathFrom(target.top, term);
    const el = h('div', 'ins-options');
    let saved = null;
    let state = null;
    let casts = [];
    let problem = null;
    let busy = false;
    const letGo = holdDraft(() => (state && saved && changed().length ? `the terminal’s settings on slide ${slide}` : null));
    const changed = () => ['data-cast', ...TERMINAL_FIELDS.map(([k]) => k)].filter((k) => (state[k] ?? '') !== (saved[k] ?? ''));
    async function load() {
      try {
        if (!path) throw new Error('the terminal is not where the file has it');
        const [src, list] = await Promise.all([
          boundedFetch(`${em().base()}/deck/edit/element/source?slide=${slide}&index=${index}`).then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || r.status))))),
          boundedFetch(`${em().base()}/deck/edit/casts`).then((r) => r.json()).catch(() => ({ casts: [] })),
        ]);
        const tpl = document.createElement('template');
        tpl.innerHTML = src.html;
        const node = nodeAtPath(tpl.content.firstElementChild, path);
        if (!node?.matches?.('div.terminal')) throw new Error('the file has no terminal where the page has it');
        saved = Object.fromEntries(['data-cast', ...TERMINAL_FIELDS.map(([k]) => k)].map((k) => [k, node.getAttribute(k) ?? '']));
        if (!saved['data-mode']) saved['data-mode'] = 'step';
        state = { ...saved };
        casts = (list.casts ?? []).map((c) => c.path);
        if (saved['data-cast'] && !casts.includes(saved['data-cast'])) casts.unshift(saved['data-cast']);
      } catch (e) { problem = `could not read the terminal from the file: ${String(e.message || e)}`; }
      paint();
    }
    async function save() {
      const keys = changed();
      if (!keys.length || busy) return;
      const set = Object.fromEntries(keys.map((k) => [k, state[k] === '' ? null : state[k]]));
      busy = true;
      paint();
      try {
        await commit.post('/deck/edit/element/options', { slide, index, path, tag: 'div', set });
        saved = { ...state };
        letGo();
        commit.reload('the terminal’s settings saved — the deck reloads to set it up again', { slide });
      } catch (e) { toast(commit.notSaved('the terminal’s settings', e), 6000); }
      busy = false;
      paint();
    }
    function paint() {
      el.textContent = '';
      if (problem) { el.append(h('div', 'ins-none', problem)); return; }
      if (!state) { el.append(h('div', 'ins-none', 'reading the terminal from the file…')); return; }
      const grid = h('dl', 'ins-rows ins-settings');
      const row = (key, label, ...nodes) => {
        grid.append(h('dt', null, label));
        const dd = h('dd');
        dd.dataset.key = key;
        dd.append(...nodes);
        grid.append(dd);
      };
      const select = (key, options) => {
        const pick = Object.assign(document.createElement('select'), { className: 'ins-field ins-select' });
        for (const [v, label] of options) pick.append(Object.assign(document.createElement('option'), { value: v, textContent: label }));
        pick.value = state[key] ?? '';
        pick.addEventListener('keydown', (e) => e.stopPropagation());
        pick.addEventListener('change', () => { state[key] = pick.value; paint(); });
        return pick;
      };
      row('data-cast', 'Recording', select('data-cast', casts.map((c) => [c, c])));
      for (const [key, label, kind, opts] of TERMINAL_FIELDS) {
        if (kind === 'choice') { row(key, label, select(key, opts)); continue; }
        const input = Object.assign(document.createElement('input'), { type: kind === 'number' ? 'number' : 'text', className: 'ins-field', value: state[key] ?? '' });
        if (kind === 'number') { input.min = String(opts[0]); input.max = String(opts[1]); input.placeholder = 'the player’s'; }
        else input.placeholder = 'none';
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } });
        input.addEventListener('input', () => { state[key] = input.value.trim(); apply.disabled = busy || !changed().length; });
        row(key, label, input);
      }
      el.append(grid);
      const apply = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn ins-apply', textContent: busy ? 'saving…' : 'Save and reload' });
      apply.title = 'a terminal is set up when the deck loads: the deck reloads to show these';
      apply.disabled = busy || !changed().length;
      apply.addEventListener('click', (e) => { e.stopPropagation(); save(); });
      const foot = h('div', 'ins-options-status', 'a terminal is set up when the deck loads, so these are saved together and the deck reloads');
      el.append(apply, foot);
    }
    paint();
    load();
    return { el, term, destroy() { letGo(); } };
  }

  const tab = {
    id: 'options', label: 'Options', title: 'this block’s settings',
    enabled: (ctx) => (blockFor(ctx.target) ? true : 'no settings here'),
    shows: (ctx) => editing() && !!blockFor(ctx.target),
    key: (ctx) => blockFor(ctx.target),
    keeps: true,
    pane: (ctx) => {
      const b = blockFor(ctx.target);
      if (b.matches('iframe')) return framePane(ctx.target, b);
      return b.matches('.terminal') ? terminalPane(ctx.target, b) : b.matches('video') ? videoPane(ctx.target, b) : codePane(ctx.target, b);
    },
    foot: 'esc lets go of it',
  };
  return { tab };
}
