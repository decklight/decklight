// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The layout picker (SPEC PRESENTING_EDITING): the edit bar's Layout button.
//
// One place to choose how a slide is arranged. A row of small pictures of THIS
// slide, one per choice, each laid out by the engine as choosing it would lay
// it out. In a deck on a design system its templates come first (the brand is
// what to reach for), and the built-in layouts sit behind More layouts. In a
// deck without one, the row is the built-in layouts the ring offers.
//
// THREE RULES WORTH TESTING, WHICH IS WHY THE MODEL IS PURE AND SEPARATE:
//
//   A PREVIEW IS NEVER A WRITE. Moving over a cell shows it on the slide;
//   only ⏎ or a click writes, once. Escape, a click away or a slide change
//   puts the slide back, and nothing leaves a preview the file does not have.
//
//   LEAVING A TEMPLATE ASKS FIRST. A slide that follows a template and takes
//   a built-in layout loses the design system's background, artwork and
//   placeholder text for that slide. The words and their slot names stay, so
//   the template can take it back, but the author is told before it happens.
//
//   THE CURRENT CHOICE IS ALWAYS IN SIGHT. The built-in layouts start hidden
//   in a design-system deck, unless the slide already uses one of them.
//
// Everything the page does is injected: building a variant of the slide,
// laying it out, showing it on the stage, and the two writes. So the model is
// checked without a browser, and the engine keeps its layout code to itself.

/** The slide's current choice: the template it follows, or its built-in layout. */
export function currentChoice(sec) {
  const template = sec?.getAttribute('data-template') || '';
  return { template: template.includes('/') ? template : '', layout: sec?.getAttribute('data-layout') || 'auto' };
}

/**
 * The cells, in the order they are shown.
 *   ring     the built-in layouts the (plain) slide can take, skips applied
 *   systems  [{ name, title, templates: [{ id, title? }] }]
 *   current  currentChoice(sec)
 * A built-in cell on a templated slide `leaves` the template.
 */
export function pickerCells({ ring, systems, current }) {
  const templates = [];
  for (const s of systems) {
    for (const t of s.templates) {
      const ref = `${s.name}/${t.id}`;
      templates.push({ kind: 'template', key: `t:${ref}`, ref, name: t.title || t.id, system: s.name, systemTitle: s.title || s.name, current: ref === current.template });
    }
  }
  const builtins = ring.map((name) => ({
    kind: 'layout', key: `l:${name}`, name, leaves: !!current.template,
    current: !current.template && name === current.layout,
  }));
  return { templates, builtins };
}

/** Whether the built-in cells start shown: always without a design system, and whenever the slide uses one of them. */
export function builtinsShownAtOpen({ systems, current }) {
  if (!systems.length) return true;
  return !current.template && current.layout !== 'auto';
}

/**
 * The items the arrow keys move through, in order: the template cells, the
 * More layouts toggle (only with a design system), then the built-in cells
 * when they are shown.
 */
export function pickerItems({ templates, builtins }, { hasSystems, shown }) {
  const items = [...templates];
  if (hasSystems) items.push({ kind: 'more', key: 'more', shown });
  if (shown) items.push(...builtins);
  return items;
}

/** Where focus starts: the current cell when it is in sight, else the first cell. */
export function initialFocus(items) {
  const at = items.findIndex((c) => c.current);
  if (at >= 0) return at;
  const first = items.findIndex((c) => c.kind !== 'more');
  return first >= 0 ? first : 0;
}

/**
 * What choosing `cell` writes, or null for nothing:
 *   { kind: 'layout', name }                        a plain slide takes a built-in layout
 *   { kind: 'template', body: { template } }        into a template, or to another
 *   { kind: 'leave', body: { template: null, layout }, confirm: true }
 *                                                   out of its template, into a layout
 */
export function writeFor(cell, current) {
  if (!cell || cell.kind === 'more' || cell.current) return null;
  if (cell.kind === 'template') return { kind: 'template', body: { template: cell.ref } };
  if (current.template) return { kind: 'leave', body: { template: null, layout: cell.name }, confirm: true };
  return { kind: 'layout', name: cell.name };
}

/** A cell's accessible name. */
export function cellLabel(cell) {
  if (cell.kind === 'more') return cell.shown ? 'Fewer layouts' : 'More layouts';
  const what = cell.kind === 'template' ? `${cell.systemTitle} template ${cell.name}` : `layout ${cell.name}`;
  return `${what}${cell.current ? ', current' : ''}${cell.leaves ? ', leaves the template' : ''}`;
}

/** How many dry runs the picker has in flight at once: a deck of ten templates does not need ten free sockets. */
export const PLAN_CONCURRENCY = 2;

/**
 * Run `jobs` (functions returning promises) at most `limit` at a time, in
 * order. Resolves when all have settled; a failure is the job's own to handle.
 */
export function runQueued(jobs, limit = PLAN_CONCURRENCY) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { await job(); } catch { /* the job's own */ }
    }
  };
  return Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker)).then(() => {});
}

/**
 * The picker's status line once dry runs failed: said once for the panel, not on
 * every tile. `failed` is the template cells whose preview could not be made.
 */
export function failureLine(failed) {
  if (!failed.length) return '';
  const reasons = [...new Set(failed.map((c) => c.error).filter(Boolean))];
  const what = failed.length === 1 ? `no preview for ${failed[0].name}` : `no preview for ${failed.length} templates`;
  return reasons.length ? `${what}: ${reasons.join('; ')}` : what;
}

/**
 * What is wrong with a cell, on its tile: clipped, fights its columns, has no
 * slot for some content. A failed dry run is said in the status line instead.
 */
export function cellWarning(cell) {
  if (!cell || cell.error) return '';
  if (cell.lacking?.length) return `${cell.lacking.length} part${cell.lacking.length === 1 ? ' has' : 's have'} no slot`;
  if (cell.conflict) return 'fights its columns';
  if (cell.clip) return 'clips';
  return '';
}

/** The tile's note in full, for the large preview: the parts without a slot named. */
export function cellDetail(cell) {
  const warn = cellWarning(cell);
  if (!warn || !cell.lacking?.length) return warn;
  return `${warn}: ${cell.lacking.map((s) => `"${s}"`).join(', ')}`;
}

/**
 * The large preview's slide (#1241): the largest box at the deck's aspect
 * ratio that fits the window less `margin` on every side and `chrome` (the
 * panel's title and key line) below it, and the scale that takes a slide there.
 */
export function lookSize({ vw, vh, width, height, margin = 48, chrome = 64 }) {
  const room = { w: Math.max(1, vw - 2 * margin), h: Math.max(1, vh - 2 * margin - chrome) };
  const scale = Math.min(room.w / width, room.h / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/** The item the large preview moves to from `at` by `step`: a cell, never the More layouts toggle. */
export function lookStep(items, at, step) {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((at + step * k) % n) + n) % n;
    if (items[i]?.kind !== 'more') return i;
  }
  return at;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Wire the picker for a deck. `page` is the engine's side:
 *   variant(idx, cell, plan)   a section showing slide idx as `cell` would (detached)
 *   settle(section, idx)       lay out an attached variant; → { clip, conflict }
 *   show(idx, section)         put a variant on the stage over the slide; → restore()
 *   ring(idx)                  the built-in ring of slide idx as a plain slide
 *   systems()                  the deck's design systems and their templates
 *   plan(idx, ref)             → Promise of the server's dry run for `ref`
 *   pick(name, idx)            write a built-in layout on a plain slide (quiet, in place)
 *   sendTemplate(body)         → Promise of { said } for POST /deck/edit/slide/template
 *   slideSize()                { width, height } of a slide
 */
export function createLayoutPicker({
  root, slideOf, sectionAt, available, unavailableMessage, page,
  anchor = () => null, toast = () => {}, debugLog = () => {}, opening = () => {},
}) {
  let el = null;
  let look = null;   // the large preview (#1241), over the stage while it is open
  let st = null;  // { idx, current, cells, items, focus, shown, plans, restore, previewKey, confirm, thumbs }
  let previewTimer = null;
  let reloadGuard = null;

  const isOpen = () => !!el;

  function open() {
    if (el) { close(); return; }
    if (!available()) { toast(unavailableMessage(), 3200); return; }
    const idx = slideOf();
    const sec = sectionAt(idx);
    if (!sec) return;
    opening();
    const systems = page.systems();
    const current = currentChoice(sec);
    const cells = pickerCells({ ring: page.ring(idx), systems, current });
    const shown = builtinsShownAtOpen({ systems, current });
    st = {
      idx, current, cells, systems, shown, focus: 0, items: [], plans: new Map(),
      restore: null, previewKey: null, confirm: null, thumbs: new Map(),
    };
    st.items = pickerItems(cells, { hasSystems: systems.length > 0, shown });
    st.focus = initialFocus(st.items);
    el = document.createElement('div');
    el.className = 'decklight-layout-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Layout for slide ${idx}`);
    el.tabIndex = -1;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.appendChild(el);
    render();
    place();
    el.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
    askPlans();
    debugLog('layout', `picker open on slide ${idx}: ${st.items.length} items`);
  }

  /** A press anywhere else cancels: the Layout button's own click toggles instead. */
  function outside(e) {
    if (!el || el.contains(e.target) || look?.contains(e.target)) return;
    if (anchor()?.contains(e.target)) return;
    close();
  }

  /** Close, putting the slide back as the file has it. `keepPreview` when a write is on its way. */
  function close({ keepPreview = false } = {}) {
    if (!el) return;
    clearTimeout(previewTimer);
    document.removeEventListener('pointerdown', outside, true);
    closeLook({ refocus: false });
    if (!keepPreview) unpreview();
    el.remove();
    el = null;
    st = null;
    anchor()?.focus?.({ preventScroll: true });
  }

  /**
   * The server's dry run for every template still without one: what a cell
   * shows is what choosing it writes. Queued, a few at a time, so the picker
   * never needs one free connection per template; asked again by Retry.
   */
  function askPlans() {
    if (!st) return;
    const mine = st;
    const todo = mine.cells.templates.filter((t) => !t.plan && !mine.plans.has(t.ref));
    for (const t of todo) { delete t.error; drawThumb(t); paintCell(t); }
    paintStatus();
    if (look) paintLook();
    runQueued(todo.map((t) => () => {
      if (st !== mine) return undefined;   // closed, or opened again: nothing to ask for
      const p = page.plan(mine.idx, t.ref).then(
        (plan) => { t.plan = plan; t.lacking = plan?.lacking ?? []; },
        (e) => { t.error = String(e?.message ?? e); },
      ).then(() => {
        mine.plans.delete(t.ref);
        if (st === mine && el) { drawThumb(t); paintCell(t); paintStatus(); if (mine.items[mine.focus] === t) { foot(describeFocus()); preview(t); if (look) paintLook(); } }
      });
      mine.plans.set(t.ref, p);
      return p;
    }));
  }

  /** The one line that says why previews are missing, with a retry; empty while none failed. */
  function paintStatus() {
    const box = el?.querySelector('.dl-lp-status');
    if (!box || !st) return;
    const failed = st.cells.templates.filter((t) => t.error);
    const line = failureLine(failed);
    box.hidden = !line;
    if (!line) { box.replaceChildren(); return; }
    const text = document.createElement('span');
    text.textContent = line;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'dl-lp-retry';
    retry.textContent = 'Retry';
    retry.title = 'ask for the missing previews again (R)';
    retry.addEventListener('click', () => { askPlans(); el?.focus({ preventScroll: true }); });
    box.replaceChildren(text, retry);
  }

  function unpreview() {
    if (!st?.restore) return;
    st.restore();
    st.restore = null;
    st.previewKey = null;
  }

  /** Show `cell` on the slide, or the slide as it is for the current cell and the toggle. */
  function preview(cell) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => previewNow(cell), 40);
  }
  function previewNow(cell) {
    if (!st || !el) return;
    if (!cell || cell.kind === 'more' || cell.current) { unpreview(); return; }
    if (st.previewKey === cell.key) return;
    if (cell.kind === 'template' && !cell.plan) return;   // its dry run has not come back yet
    const section = page.variant(st.idx, cell, cell.plan);
    if (!section) return;
    unpreview();
    st.restore = page.show(st.idx, section);
    st.previewKey = cell.key;
  }

  function render() {
    if (!el || !st) return;
    if (st.confirm) { renderConfirm(); return; }
    const { cells, items } = st;
    const byKey = new Map(items.map((c, i) => [c.key, i]));
    const cellHtml = (c) => `<div class="dl-lp-cell${c.current ? ' dl-lp-current' : ''}" role="option" id="dl-lp-${byKey.get(c.key)}"`
      + ` data-i="${byKey.get(c.key)}" aria-selected="${c.current ? 'true' : 'false'}" aria-label="${esc(cellLabel(c))}">`
      + `<div class="dl-lp-thumb" data-key="${esc(c.key)}"></div>`
      + `<span class="dl-lp-name">${esc(c.name)}${c.current ? ' <span class="dl-lp-dot" aria-hidden="true">●</span>' : ''}</span>`
      + `${c.leaves ? '<span class="dl-lp-leaves" title="leaves the template" aria-hidden="true">↗</span>' : ''}`
      + '<span class="dl-lp-warn" aria-hidden="true"></span></div>';
    let html = `<div class="dl-lp-row" role="listbox" aria-orientation="horizontal" aria-label="Layouts for slide ${st.idx}">`;
    let group = null;
    for (const c of cells.templates) {
      if (c.system !== group) {
        if (group !== null) html += '</div></div>';
        group = c.system;
        html += `<div class="dl-lp-group"><div class="dl-lp-head">${esc(c.systemTitle)}</div><div class="dl-lp-cells">`;
      }
      html += cellHtml(c);
    }
    if (group !== null) html += '</div></div>';
    const missing = st.systems.filter((s) => !s.templates.length);
    for (const s of missing) html += `<div class="dl-lp-group"><div class="dl-lp-head">${esc(s.title || s.name)}</div><div class="dl-lp-note">${esc(s.why || 'no templates on this page')}</div></div>`;
    if (st.systems.length) {
      const i = byKey.get('more');
      html += `<div class="dl-lp-more" role="option" id="dl-lp-${i}" data-i="${i}" aria-expanded="${st.shown}" aria-selected="false">${st.shown ? '◂ Fewer' : 'More layouts ▸'}</div>`;
    }
    if (st.shown && cells.builtins.length) {
      html += `<div class="dl-lp-group dl-lp-builtin">${st.systems.length ? '<div class="dl-lp-head">Built-in</div>' : ''}<div class="dl-lp-cells">`;
      for (const c of cells.builtins) html += cellHtml(c);
      html += '</div></div>';
    }
    html += '</div><div class="dl-lp-status" role="status" hidden></div><div class="dl-lp-foot" aria-live="polite"></div>';
    el.innerHTML = html;
    el.querySelectorAll('[data-i]').forEach((n) => {
      const i = Number(n.dataset.i);
      n.addEventListener('mouseenter', () => focusAt(i, { scroll: false }));
      n.addEventListener('click', () => { focusAt(i, { scroll: false }); choose(); });
    });
    for (const c of [...cells.templates, ...(st.shown ? cells.builtins : [])]) { drawThumb(c); paintCell(c); }
    paintStatus();
    focusAt(st.focus, { preview: false });
  }

  /** Draw a cell's picture: the variant, laid out at slide size, scaled into the cell. */
  function drawThumb(cell) {
    const box = el?.querySelector(`.dl-lp-thumb[data-key="${CSS.escape(cell.key)}"]`);
    if (!box) return;
    if (cell.kind === 'template' && !cell.plan) {
      box.classList.toggle('dl-lp-pending', !cell.error);
      box.textContent = cell.error ? '—' : '';
      return;
    }
    box.classList.remove('dl-lp-pending');
    if (box.firstChild && st.thumbs.get(cell.key) === box.firstChild) return;
    const section = page.variant(st.idx, cell, cell.plan);
    if (!section) return;
    const { width, height } = page.slideSize();
    const k = box.clientWidth / width || 0.0875;
    const stage = document.createElement('div');
    stage.className = 'decklight-stage dl-lp-stage';
    stage.setAttribute('aria-hidden', 'true');
    stage.style.width = width + 'px';
    stage.style.height = height + 'px';
    stage.style.transform = `scale(${k})`;
    stage.appendChild(section);
    box.replaceChildren(stage);
    st.thumbs.set(cell.key, stage);
    const fit = page.settle(section, st.idx);
    cell.clip = fit?.clip || null;
    cell.conflict = !!fit?.conflict;
  }

  /** The marks a cell carries: clipped, fights its columns, has no slot for some content. */
  function paintCell(cell) {
    const node = el?.querySelector(`.dl-lp-thumb[data-key="${CSS.escape(cell.key)}"]`)?.parentElement;
    if (!node) return;
    // a failed dry run is said once, in the status line; the tile only shows its dash
    const warn = cellWarning(cell);
    node.querySelector('.dl-lp-warn').textContent = warn;
    node.classList.toggle('dl-lp-warned', !!warn);
    node.classList.toggle('dl-lp-failed', !!cell.error);
    node.title = [cell.name, warn || (cell.error ? 'no preview' : '')].filter(Boolean).join(' · ');
  }

  function foot(text) { const f = el?.querySelector('.dl-lp-foot'); if (f) f.textContent = text; }

  function describeFocus() {
    const c = st.items[st.focus];
    const keep = st.current.template || st.current.layout;
    if (!c) return '';
    if (c.kind === 'more') return c.shown ? '⏎ hides the built-in layouts · Esc closes' : '⏎ shows the built-in layouts · Esc closes';
    if (c.current) return `${c.name} is this slide's ${c.kind === 'template' ? 'template' : 'layout'} · space: larger preview · Esc closes`;
    if (c.kind === 'template' && c.error) return `${c.name}: no preview · R retries · space: larger preview · Esc closes`;
    return `previewing ${c.name}${c.leaves ? ' (leaves the template)' : ''} · ⏎ apply · space: larger preview · Esc keep ${keep}`;
  }

  function focusAt(i, { scroll = true, preview: show = true } = {}) {
    if (!st || !st.items.length) return;
    st.focus = (i + st.items.length) % st.items.length;
    const nodes = [...el.querySelectorAll('[data-i]')];
    for (const n of nodes) n.classList.toggle('dl-lp-focus', Number(n.dataset.i) === st.focus);
    const node = el.querySelector(`[data-i="${st.focus}"]`);
    if (node) {
      el.setAttribute('aria-activedescendant', node.id);
      if (scroll) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    foot(describeFocus());
    if (show) preview(st.items[st.focus]);
  }

  function toggleBuiltins() {
    st.shown = !st.shown;
    const before = st.items[st.focus]?.key;
    st.items = pickerItems(st.cells, { hasSystems: st.systems.length > 0, shown: st.shown });
    st.focus = Math.max(0, st.items.findIndex((c) => c.key === before));
    render();
    place();
  }

  function choose() {
    if (!st) return;
    const cell = st.items[st.focus];
    if (cell?.kind === 'more') { toggleBuiltins(); return; }
    const w = writeFor(cell, st.current);
    if (!w) { close(); return; }
    if (w.confirm) { st.confirm = { cell, w }; previewNow(cell); render(); return; }
    commit(cell, w);
  }

  function commit(cell, w) {
    const idx = st.idx;
    if (w.kind === 'layout') {
      close();
      page.pick(w.name, idx);
      return;
    }
    // the write reloads every page (a template is laid out at load): the
    // slide keeps showing the choice until it does, and goes back if it fails
    const restore = st.restore;
    close({ keepPreview: true });
    clearTimeout(reloadGuard);
    reloadGuard = setTimeout(() => restore?.(), 6000);
    page.sendTemplate({ slide: idx, ...w.body }).then(
      (j) => { toast(j?.said ? `slide ${idx}: ${j.said}` : `slide ${idx}: ${cell.name}`, 6000); debugLog('layout', `slide ${idx}: ${j?.said ?? cell.name}`); },
      (e) => { clearTimeout(reloadGuard); restore?.(); toast(`could not lay slide ${idx} out as ${cell.name}: ${e?.message ?? e}`, 7000); },
    );
  }

  function renderConfirm() {
    const { cell } = st.confirm;
    el.innerHTML = '<div class="dl-lp-confirm" role="alertdialog" aria-labelledby="dl-lp-confirm-what">'
      + `<p id="dl-lp-confirm-what"><b>⚠ Slide ${st.idx} leaves the ${esc(st.current.template)} template and takes ${esc(cell.name)}.</b></p>`
      + '<p>Its words and pictures stay. The design system\'s background, artwork and placeholder text for this slide go.'
      + ` Choosing ${esc(st.current.template)} again puts everything back.</p>`
      + `<div class="dl-lp-actions"><button type="button" class="dl-lp-leave">Leave template and use ${esc(cell.name)}</button>`
      + '<button type="button" class="dl-lp-cancel">Cancel</button></div></div>';
    el.querySelector('.dl-lp-leave').addEventListener('click', () => commit(cell, st.confirm.w));
    el.querySelector('.dl-lp-cancel').addEventListener('click', () => { st.confirm = null; render(); place(); });
    el.querySelector('.dl-lp-leave').focus({ preventScroll: true });
    place();
  }

  // ── the large preview (#1241) ─────────────────────────────────────────────
  // Space on a tile: the same variant the tile shows, as large as the window
  // allows, at the deck's aspect ratio. Quick Look's gesture: space or Esc
  // goes back to the row, the arrows move to the next tile (the row's focus
  // moves with it), ⏎ chooses. Like the tile, it never writes.

  function openLook() {
    const c = st?.items[st.focus];
    if (!c || c.kind === 'more' || look) return;
    look = document.createElement('div');
    look.className = 'decklight-layout-look';
    look.setAttribute('role', 'dialog');
    look.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target === look) closeLook();   // the backdrop: back to the row
    });
    root.appendChild(look);
    paintLook();
    window.addEventListener('resize', paintLook);
    debugLog('layout', `large preview of ${c.name}`);
  }

  function closeLook({ refocus = true } = {}) {
    if (!look) return;
    window.removeEventListener('resize', paintLook);
    look.remove();
    look = null;
    if (refocus && el) { el.focus({ preventScroll: true }); foot(describeFocus()); }
  }

  function paintLook() {
    if (!look || !st) return;
    const c = st.items[st.focus];
    if (!c || c.kind === 'more') { closeLook(); return; }
    const { width, height } = page.slideSize();
    const size = lookSize({ vw: window.innerWidth, vh: window.innerHeight, width, height });
    const what = c.kind === 'template' ? `${c.systemTitle} · ${c.name}` : `${st.systems.length ? 'Built-in · ' : 'Layout · '}${c.name}`;
    const marks = [c.current ? 'current' : '', c.leaves ? 'leaves the template' : ''].filter(Boolean).join(' · ');
    const others = st.items.filter((x) => x.kind !== 'more').length > 1;
    look.setAttribute('aria-label', `Large preview: ${cellLabel(c)}`);
    look.innerHTML = `<div class="dl-ll-panel" style="width:${size.width}px">`
      + `<div class="dl-ll-head"><b class="dl-ll-name">${esc(what)}</b>${marks ? `<span class="dl-ll-marks">${esc(marks)}</span>` : ''}<span class="dl-ll-note"></span></div>`
      + `<div class="dl-ll-slide" style="width:${size.width}px;height:${size.height}px"></div>`
      + `<div class="dl-ll-keys">${others ? '← → other layouts · ' : ''}⏎ ${c.current ? 'keep' : 'apply'} · space or Esc back to the row</div></div>`;
    const box = look.querySelector('.dl-ll-slide');
    const note = look.querySelector('.dl-ll-note');
    if (c.kind === 'template' && !c.plan) {
      if (c.error) {
        box.classList.add('dl-ll-failed');
        const why = document.createElement('p');
        why.textContent = `No preview of ${c.name}: ${c.error}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'dl-lp-retry';
        retry.textContent = 'Retry';
        retry.title = 'ask for the preview again (R)';
        retry.addEventListener('click', () => askPlans());
        box.replaceChildren(why, retry);
      } else {
        box.classList.add('dl-ll-pending');
        box.textContent = 'making the preview…';
      }
      return;
    }
    const section = page.variant(st.idx, c, c.plan);
    if (!section) return;
    const stage = document.createElement('div');
    stage.className = 'decklight-stage dl-lp-stage';
    stage.setAttribute('aria-hidden', 'true');
    stage.style.width = width + 'px';
    stage.style.height = height + 'px';
    stage.style.transform = `scale(${size.scale})`;
    stage.appendChild(section);
    box.replaceChildren(stage);
    const fit = page.settle(section, st.idx);
    // a built-in cell hidden behind More layouts was never drawn: its marks come from here
    if (c.clip === undefined) { c.clip = fit?.clip || null; c.conflict = !!fit?.conflict; }
    const detail = cellDetail(c);
    note.textContent = detail;
    note.hidden = !detail;
  }

  /** ←/→ in the large preview: the next tile, skipping the More layouts toggle; the row's focus follows. */
  function lookMove(step) {
    const i = lookStep(st.items, st.focus, step);
    if (i === st.focus) return;
    focusAt(i);
    paintLook();
  }

  function lookKeydown(e) {
    switch (e.key) {
      case ' ': case 'Escape': closeLook(); return true;
      case 'ArrowRight': case 'ArrowDown': lookMove(1); return true;
      case 'ArrowLeft': case 'ArrowUp': lookMove(-1); return true;
      case 'Enter': closeLook({ refocus: false }); choose(); return true;
      case 'r': case 'R': if (!e.metaKey && !e.ctrlKey && !e.altKey && st.cells.templates.some((t) => t.error)) askPlans(); return true;
      default: return true;   // the preview is up: nothing moves behind it, narration included
    }
  }

  /** Just above the Layout button, kept inside the window; centred low on the stage without one. */
  function place() {
    if (!el) return;
    const a = anchor();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth;
    if (a) {
      const r = a.getBoundingClientRect();
      el.style.left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      el.style.bottom = Math.max(8, vh - r.top + 8) + 'px';
    } else {
      el.style.left = Math.max(8, (vw - w) / 2) + 'px';
      el.style.bottom = '72px';
    }
  }

  function keydown(e) {
    if (!st) return false;
    if (st.confirm) {
      if (e.key === 'Escape') { st.confirm = null; render(); place(); return true; }
      if (e.key === 'Enter') { commit(st.confirm.cell, st.confirm.w); return true; }
      if (e.key === 'Tab') { const b = [...el.querySelectorAll('button')]; const i = b.indexOf(document.activeElement); b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length]?.focus(); return true; }
      return true;
    }
    if (look) return lookKeydown(e);
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': focusAt(st.focus + 1); return true;
      case 'ArrowLeft': case 'ArrowUp': focusAt(st.focus - 1); return true;
      case 'Home': focusAt(0); return true;
      case 'End': focusAt(st.items.length - 1); return true;
      case 'Enter': choose(); return true;
      // space is Quick Look's while the picker is up, never narration's (#1241)
      case ' ': if (st.items[st.focus]?.kind === 'more') toggleBuiltins(); else openLook(); return true;
      case 'Escape': close(); return true;
      case 'r': case 'R': if (!e.metaKey && !e.ctrlKey && !e.altKey && st.cells.templates.some((t) => t.error)) askPlans(); return true;
      default: return true;   // the picker is up: the deck does not move behind it
    }
  }

  /** The page is about to show something else as the slide (another page's pick, a slide change). */
  function cancel() { if (el) close(); }

  return { open, close: () => close(), cancel, isOpen, keydown, transient: true };
}
