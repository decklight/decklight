// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Lists and tables while typing (PRESENTING_EDITING): the page's half.
 *
 * A double-click on a bullet starts a SESSION on its whole list. Enter cuts
 * the point at the caret into a new one, Backspace at the start of a point
 * joins it to the one above, Tab and Shift-Tab nest it and take it out
 * again; Enter on an empty last point removes it and ends the session, as a
 * document does. In a table Tab and Shift-Tab walk the cells, and Tab in
 * the last one adds a row. However many of those a session made, it ends in
 * ONE write of the top-level element through the content route, so one
 * undo takes the session back, and Esc puts the whole of it back unwritten.
 *
 * Every change is made on the list's SOURCE (list-edit.js) and the slide is
 * laid out from it, so what the file gets is the author's own markup, never
 * what contenteditable made of it. The live list keeps its own elements
 * where it can (an item the engine has made a build step stays one), which
 * is also how Esc can give back the very nodes that were there.
 */

import {
  listDoc, listShape, listHtml, itemFacts, splitItem, mergeItem, removeItem, indentItem, outdentItem, moveItem,
  setItemWords, cleanInline, tableOp, tableEdit, tableShape, elementAt,
} from './list-edit.js';
import { slideClickMatch } from './narration.js';
import { clickMismatchText } from '../../tools/click-match.mjs';

const isList = (n) => n?.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL');
const isCell = (n) => n?.nodeType === 1 && (n.tagName === 'TD' || n.tagName === 'TH');
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
const KEEP = IS_MAC ? '⌘⏎' : 'Ctrl+⏎';
/** The chord that moves a point up or down its list: Control-Shift on every platform. */
const MOVE = IS_MAC ? '⌃⇧↑↓' : 'Ctrl+Shift+↑↓';

/** The table menu's six rows: what each says, and the change it asks of the file. */
export const TABLE_ROWS = [
  ['Add row above', 'row-above', 'a row added above'],
  ['Add row below', 'row-below', 'a row added below'],
  ['Add column left', 'col-left', 'a column added on the left'],
  ['Add column right', 'col-right', 'a column added on the right'],
  ['Delete row', 'row-delete', 'the row deleted'],
  ['Delete column', 'col-delete', 'the column deleted'],
];

// ── the live list ──────────────────────────────────────────────────────────

/** An item's words as the page shows them: everything before its sublist. */
function liveWords(li) {
  const box = document.createElement('div');
  for (const n of li.childNodes) { if (isList(n)) break; box.appendChild(n.cloneNode(true)); }
  return box.innerHTML;
}
/** An item's words replaced, its sublist (the same nodes) kept; an empty item keeps a line the caret can stand on. */
function setLiveWords(li, html, { exact = false } = {}) {
  const sub = [...li.childNodes].find(isList) ?? null;
  for (const n of [...li.childNodes]) { if (n === sub) break; n.remove(); }
  const tpl = document.createElement('template');
  tpl.innerHTML = html || (exact ? '' : '<br>');
  li.insertBefore(tpl.content, sub);
}
const fromOpen = (open, tag) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = `${open}</${tag}>`;
  return tpl.content.firstElementChild;
};
/** The caret in `el`'s own words: the characters before it (a sublist's not counted), and whether nothing is selected. */
function caretIn(el) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const frag = pre.cloneContents();
  frag.querySelectorAll('ul, ol').forEach((n) => n.remove());
  return { offset: frag.textContent.length, collapsed: r.collapsed };
}
/** The caret put `offset` characters into `el`'s own words (null: at their end). */
function placeCaret(el, offset) {
  const r = document.createRange();
  let left = offset ?? Infinity;
  let placed = false;
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (placed) return true;
      if (node === el && isList(n)) return true;
      if (n.nodeType === 3) {
        if (left <= n.data.length) { r.setStart(n, left); placed = true; return true; }
        left -= n.data.length;
      } else if (n.nodeType === 1 && walk(n)) return true;
    }
    return false;
  };
  walk(el);
  if (!placed) {
    // the end of the words: before the sublist, or the line break holding an empty item open
    const stop = [...el.childNodes].find((n) => isList(n) || (n.nodeType === 1 && n.tagName === 'BR' && !n.nextSibling));
    if (stop) r.setStartBefore(stop);
    else { r.selectNodeContents(el); r.collapse(false); }
  }
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
/** A sublist of the item being typed in takes no caret: the keys are about the item's own words. */
function lockSubs(li, on) {
  for (const n of li.children) if (isList(n)) { if (on) n.setAttribute('contenteditable', 'false'); else n.removeAttribute('contenteditable'); }
}

// ── the live table ─────────────────────────────────────────────────────────

const liveRows = (table) => [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
const liveCellsOf = (tr) => [...tr.children].filter(isCell);
const liveCells = (table) => liveRows(table).flatMap(liveCellsOf);
/** The cell at row `r`, column `c` of a live table, or null. */
const cellAt = (table, r, c) => { const tr = liveRows(table)[r]; return tr ? liveCellsOf(tr)[c] ?? null : null; };
/** The table shown again from the markup the file now has: the rows it added, the cells as written. */
function showTable(table, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const fresh = tpl.content.firstElementChild;
  if (fresh) table.replaceChildren(...fresh.childNodes);
}

export function createListSessions(ctx) {
  const { instance, toast, editmode } = ctx;

  // The element's SOURCE as the file has it, never the live DOM the engine
  // decorated, and never re-serialised by a parser either: the list or the
  // table is found in it by path (list-edit.js) and only it is rewritten, so
  // every byte around it, a bare `data-build` included, stays as written.
  async function source(slide, index, path, tag) {
    const res = await ctx.fetch(`${ctx.base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || 'no source for this element');
    const at = elementAt(j.html, path, tag);
    if (!at) throw new Error(`the source has no ${tag} where the click landed`);
    return at;
  }
  const clicksOf = (slide) => {
    const sec = instance._sections?.[slide - 1];
    return sec ? slideClickMatch(sec, instance._records?.[slide - 1]) : null;
  };
  const sameClicks = (a, b) => (a?.markers ?? null) === (b?.markers ?? null) && (a?.clicks ?? null) === (b?.clicks ?? null);
  /**
   * After a write shown in place: the slide's builds were scanned again (the
   * content event), so a new point in a list that builds is a step of its
   * own. The point being typed in stays on screen rather than going back to
   * waiting for its click, and when the notes' [click] markers no longer
   * match the steps, that is said once.
   */
  function afterWrite(slide, el, before, said) {
    const rec = instance._records?.[slide - 1];
    if (rec && instance.state?.slide === slide && el?.isConnected) {
      const k = rec.steps.findIndex((st) => st.el && (st.el === el || st.el.contains(el)));
      const g = k < 0 ? -1 : rec.groups.findIndex((grp) => grp.includes(k));
      if (g >= 0 && instance.state.step < g + 1) instance.goto(slide, g + 1);
    }
    const now = clicksOf(slide);
    if (now && !sameClicks(now, before)) toast(`${said}. Slide ${slide}: ${clickMismatchText(now)}`, 7000);
    else toast(said, 1200);
  }

  // ── a list session ───────────────────────────────────────────────────────
  /** The list `li` belongs to, all the way out: a sublist's item edits the whole list, inside `top`. */
  function rootListOf(li, top) {
    let list = li.parentElement;
    if (!isList(list)) return null;
    while (list !== top && list.parentElement?.tagName === 'LI' && isList(list.parentElement.parentElement)
      && top.contains(list.parentElement.parentElement)) list = list.parentElement.parentElement;
    return list === top || top.contains(list) ? list : null;
  }

  function mapLive(s, live, list) {
    s.live.set(list.key, live);
    s.keyOf.set(live, list.key);
    const items = [...live.children].filter((n) => n.tagName === 'LI');
    if (items.length !== list.items.length || live.tagName.toLowerCase() !== list.tag) return false;
    return list.items.every((item, i) => {
      const li = items[i];
      s.live.set(item.key, li);
      s.keyOf.set(li, item.key);
      s.tree.set(li, item.html);
      // what each item showed when the session began: the first one maybe typed in since
      const was = li === s.first ? s.firstWords : liveWords(li);
      s.shown.set(li, was);
      s.orig.set(item.key, was);
      const subs = [...li.children].filter(isList);
      if (subs.length > 1 || !!item.sub !== (subs.length === 1)) return false;
      return !item.sub || mapLive(s, subs[0], item.sub);
    });
  }

  function beginList(cur, top) {
    const root = rootListOf(cur.el, top);
    const listPath = root && ctx.childPath(top, root);
    if (!listPath) return false;
    const s = {
      kind: 'list', root, listPath, doc: undefined, src: null, first: cur.el, firstWords: liveWords(cur.el),
      live: new Map(), keyOf: new Map(), tree: new Map(), shown: new Map(), orig: new Map(),
      dirty: false, structural: false, moving: false, keepStyle: false, before: clicksOf(cur.slide),
    };
    cur.list = s;
    lockSubs(cur.el, true);
    s.ready = (async () => {
      try {
        await ctx.lastSave();   // a save still landing: the source read here must already have it
        const at = await source(cur.slide, cur.index, listPath, root.tagName.toLowerCase());
        const doc = listDoc(at.html);
        if (!doc || !mapLive(s, root, listShape(doc))) throw new Error('not a list of words');
        s.src = at.html;
        s.keepStyle = /\sstyle=/i.test(s.src);
        s.doc = doc;
      } catch {
        s.doc = null;
      }
      // a list this editor cannot cut (an item holding a paragraph, a second
      // sublist): the old edit, one item, Enter keeping its words
      if (!s.doc && cur.list === s) { lockSubs(cur.el, false); cur.list = null; cur.plainItem = true; ctx.syncHint(); }
    })();
    return true;
  }

  /** What was typed into the item, into the source: cleaned of the browser's furniture. */
  function sync(s, li) {
    const raw = liveWords(li);
    if (raw === s.shown.get(li)) return;
    const html = cleanInline(raw, { keepStyle: s.keepStyle });
    setItemWords(s.doc, s.keyOf.get(li), html);
    s.shown.set(li, raw);
    s.tree.set(li, html);
    s.dirty = true;
  }

  function renderList(s, live, list) {
    const want = [];
    for (const item of list.items) {
      let li = s.live.get(item.key);
      if (!li) { li = fromOpen(item.open, 'li'); s.live.set(item.key, li); s.keyOf.set(li, item.key); }
      if (s.tree.get(li) !== item.html) {
        setLiveWords(li, item.html);
        s.tree.set(li, item.html);
        s.shown.set(li, liveWords(li));
      }
      let sub = null;
      if (item.sub) {
        sub = s.live.get(item.sub.key);
        if (!sub) { sub = fromOpen(item.sub.open, item.sub.tag); s.live.set(item.sub.key, sub); s.keyOf.set(sub, item.sub.key); }
        renderList(s, sub, item.sub);
      }
      for (const n of [...li.children]) if (isList(n) && n !== sub) n.remove();
      if (sub && sub.parentNode !== li) li.appendChild(sub);
      want.push(li);
    }
    for (const n of [...live.children]) if (n.tagName === 'LI' && !want.includes(n)) n.remove();
    let ref = live.firstChild;
    for (const li of want) {
      while (ref && ref.nodeType !== 1) ref = ref.nextSibling;
      if (ref === li) { ref = li.nextSibling; continue; }
      live.insertBefore(li, ref);
    }
  }
  function render(s) {
    s.moving = true;
    try { renderList(s, s.root, listShape(s.doc)); } finally { s.moving = false; }
  }

  /** Typing moves to `el` (an item, a cell) in the same session: no save, the caret where it should be. */
  function setHost(s, cur, el, offset) {
    s.moving = true;
    try {
      const old = cur.el;
      if (old !== el) {
        release(old);
        if (s.kind === 'list') lockSubs(old, false);
      }
      cur.el = el;
      el.setAttribute('contenteditable', 'true');
      el.classList.add('dl-editing');
      if (s.kind === 'list') lockSubs(el, true);
      el.focus();
      placeCaret(el, offset);
    } finally { s.moving = false; }
    ctx.placePill();
  }
  /** Typing leaves `el`: nothing of the editing stays on it, not even an emptied class. */
  function release(el) {
    el.removeAttribute('contenteditable');
    el.classList.remove('dl-editing');
    if (!el.classList.length) el.removeAttribute('class');
  }
  function endHost(cur) {
    const s = cur.list ?? cur.table;
    s.moving = true;
    release(cur.el);
    if (s.kind === 'list') lockSubs(cur.el, false);
    s.moving = false;
  }

  function listKey(e, cur) {
    const s = cur.list;
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;
    const enter = e.key === 'Enter' && bare && !e.shiftKey;
    const tab = e.key === 'Tab' && bare;
    let back = false;
    if (e.key === 'Backspace' && bare && !e.shiftKey) {
      const c = caretIn(cur.el);
      back = !!c && c.collapsed && c.offset === 0;
    }
    // Control-Shift-↑ / ↓ moves the point among its own list's points, the
    // same chord on every platform (a document editor's outline move)
    const move = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing
      ? (e.key === 'ArrowUp' ? -1 : 1) : 0;
    if (!enter && !tab && !back && !move) return false;
    e.preventDefault();
    if (enter) {
      const sel = window.getSelection();
      if (sel?.rangeCount && !sel.isCollapsed && cur.el.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.getRangeAt(0).deleteContents();
    }
    const at = caretIn(cur.el)?.offset ?? 0;
    const shift = e.shiftKey;
    const run = () => {
      if (ctx.editing() !== cur) return;
      if (!s.doc || cur.list !== s) { if (enter) ctx.saveInline(); return; }
      const key = s.keyOf.get(cur.el);
      sync(s, cur.el);
      let to = null;
      if (enter) {
        const f = itemFacts(s.doc, key);
        if (f.empty && f.last && !f.top) to = outdentItem(s.doc, key) && { key, offset: 0 };
        else if (f.empty && f.last) {
          // an empty last point ends the list, as a document's does: it goes, and so does the session
          if (!f.only) {
            const items = [...cur.el.parentElement.children].filter((n) => n.tagName === 'LI');
            const prev = items[items.indexOf(cur.el) - 1] ?? null;
            removeItem(s.doc, key);
            s.structural = true;
            render(s);
            if (prev) cur.el = prev;
          }
          ctx.saveInline();
          return;
        } else to = splitItem(s.doc, key, at, { words: liveWords(cur.el), clean: (h) => cleanInline(h, { keepStyle: s.keepStyle }) });
      } else if (back) {
        to = mergeItem(s.doc, key);
      } else if (move) {
        to = moveItem(s.doc, key, move);
        if (to) to.offset = at;
        else toast(move < 0 ? 'already the first point of its list' : 'already the last point of its list', 1600);
      } else {
        to = (shift ? outdentItem : indentItem)(s.doc, key);
        if (to) to.offset = at;
        else if (!shift) toast('the first point has nothing above it to go under', 1800);
      }
      if (!to) return;
      s.structural = true;
      render(s);
      setHost(s, cur, s.live.get(to.key), to.offset);
    };
    if (s.doc !== undefined) run();
    else s.ready.then(run);
    return true;
  }

  async function saveList(cur) {
    const s = cur.list;
    // over at once, as any save is: a second save of the same session is never made
    if (ctx.editing() === cur) ctx.setEditing(null);
    if (s.doc === undefined) await s.ready;
    if (!s.doc) return ctx.saveText(cur);
    sync(s, cur.el);
    endHost(cur);
    if (!s.dirty && !s.structural) { ctx.unstrand(s.root); return; }   // nothing changed: nothing written
    try {
      const at = await source(cur.slide, cur.index, s.listPath, s.root.tagName.toLowerCase());
      if (at.html !== s.src) throw new Error('the list changed in the file while it was edited here (Esc puts it back, then edit it again)');
      await ctx.post('/deck/edit/element/content', { slide: cur.slide, index: cur.index, html: at.replace(listHtml(s.doc)) });
      ctx.unstrand(s.root);
      ctx.announce(cur.slide, s.root);
      afterWrite(cur.slide, cur.el, s.before, 'saved');
    } catch (e) {
      ctx.strand(cur, s.root);
      toast(ctx.notSaved('the list', e), 7000);
    }
  }

  function cancelList(cur) {
    const s = cur.list;
    endHost(cur);
    ctx.unstrand(s.root);
    if (!s.doc) { setLiveWords(cur.el, s.firstWords, { exact: true }); return; }
    // the list as it was: the same source, numbered the same way, so every
    // item finds its own element again; and each item's words as they were shown
    s.doc = listDoc(s.src);
    render(s);
    for (const [key, words] of s.orig) {
      const li = s.live.get(key);
      if (li && liveWords(li) !== words) setLiveWords(li, words, { exact: true });
    }
  }

  // ── a table session ──────────────────────────────────────────────────────
  function beginTable(cur, top) {
    const table = cur.el.closest('table');
    const tablePath = table && top.contains(table) ? ctx.childPath(top, table) : null;
    if (!tablePath && table !== top) return false;
    cur.table = { kind: 'table', table, tablePath: tablePath ?? [], cells: new Map([[cur.el, cur.el.innerHTML]]), added: [], moving: false, before: clicksOf(cur.slide) };
    return true;
  }

  function addLiveRow(s) {
    const rows = liveRows(s.table);
    const last = rows[rows.length - 1];
    const tr = document.createElement('tr');
    for (const c of liveCellsOf(last)) tr.appendChild(document.createElement(c.tagName.toLowerCase())).appendChild(document.createElement('br'));
    last.after(tr);
    s.added.push(tr);
    for (const c of liveCellsOf(tr)) s.cells.set(c, '');
    return liveCellsOf(tr)[0] ?? null;
  }

  function tableKey(e, cur) {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return false;
    e.preventDefault();
    const s = cur.table;
    const cells = liveCells(s.table);
    const i = cells.indexOf(cur.el);
    let next = i < 0 ? null : cells[i + (e.shiftKey ? -1 : 1)];
    if (!next && !e.shiftKey && i >= 0) next = addLiveRow(s);
    if (!next) return true;
    if (!s.cells.has(next)) s.cells.set(next, next.innerHTML);
    setHost(s, cur, next, null);
    // the cell's words are selected, as a spreadsheet or a document's table
    // does on Tab: typing replaces them, and an arrow key keeps them
    if (next.textContent) {
      const r = document.createRange();
      r.selectNodeContents(next);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      ctx.placePill();
    }
    return true;
  }

  async function saveTable(cur) {
    const s = cur.table;
    endHost(cur);
    if (ctx.editing() === cur) ctx.setEditing(null);
    const rows = liveRows(s.table);
    const cells = [];
    for (const [cell, was] of s.cells) {
      if (!cell.isConnected) continue;
      const added = s.added.includes(cell.parentElement);
      if (!added && cell.innerHTML === was) continue;
      const html = cleanInline(cell.innerHTML, { keepStyle: /\sstyle=/i.test(was) });
      if (added && !html) continue;
      cells.push({ row: rows.indexOf(cell.parentElement), col: liveCellsOf(cell.parentElement).indexOf(cell), html });
    }
    if (!cells.length && !s.added.length) { ctx.unstrand(s.table); return; }   // nothing changed: nothing written
    try {
      const at = await source(cur.slide, cur.index, s.tablePath, 'table');
      const shape = rows.filter((r) => !s.added.includes(r)).map((r) => liveCellsOf(r).length);
      if (JSON.stringify(tableShape(at.html)) !== JSON.stringify(shape)) throw new Error('the table in the file is not the one on the slide: reload, then edit it again');
      const html = tableEdit(at.html, { append: s.added.length, cells });
      await ctx.post('/deck/edit/element/content', { slide: cur.slide, index: cur.index, html: at.replace(html) });
      ctx.unstrand(s.table);
      // a row Tab added is shown as the file now has it, its cells' tags and attributes and all
      const at0 = [rows.indexOf(cur.el.parentElement), liveCellsOf(cur.el.parentElement).indexOf(cur.el)];
      if (s.added.length) showTable(s.table, html);
      ctx.announce(cur.slide, s.table);
      // the row last typed in stays on screen, a row that builds included
      afterWrite(cur.slide, cellAt(s.table, ...at0), s.before, 'saved');
    } catch (e) {
      ctx.strand(cur, s.table);
      toast(ctx.notSaved('the table', e), 7000);
    }
  }

  function cancelTable(cur) {
    const s = cur.table;
    endHost(cur);
    ctx.unstrand(s.table);
    for (const [cell, was] of s.cells) if (cell.isConnected && !s.added.includes(cell.parentElement)) cell.innerHTML = was;
    for (const tr of s.added) tr.remove();
  }

  // ── the table menu: rows and columns, one write each ─────────────────────
  async function tableChange(cell, op, said) {
    if (ctx.editing()) await ctx.saveInline();
    const where = ctx.sectionOf(cell);
    const top = where && ctx.topLevelChild(where.sec, cell);
    const table = cell.closest('table');
    if (!top || !table || !(top === table || top.contains(table))) return;
    const index = ctx.authoredIndex(where.sec, top);
    const tablePath = ctx.childPath(top, table);
    const rows = liveRows(table);
    const row = rows.indexOf(cell.parentElement);
    const col = liveCellsOf(cell.parentElement).indexOf(cell);
    const before = clicksOf(where.slide);
    const job = (async () => {
      try {
        const at = await source(where.slide, index, tablePath, 'table');
        if (JSON.stringify(tableShape(at.html)) !== JSON.stringify(rows.map((r) => liveCellsOf(r).length))) {
          throw new Error('the table in the file is not the one on the slide: reload, then try again');
        }
        const html = tableOp(at.html, op, row, col);
        await ctx.post('/deck/edit/element/content', { slide: where.slide, index, html: at.replace(html) });
        showTable(table, html);
        ctx.announce(where.slide, table);
        // a new row in a table that builds is shown, not left waiting for its click
        const shown = op === 'row-above' || op === 'row-below' ? row + 1 : row;
        afterWrite(where.slide, cellAt(table, shown, 0), before, said);
      } catch (e) {
        toast(`table not changed: ${String(e?.message || e)}`, 6000);
      }
    })();
    editmode.trackWrite?.(job);
    return job;
  }

  return {
    /** A session on the list or table `cur.el` is in, when it is in one. */
    begin(cur, top) {
      if (cur.el.tagName === 'LI') return beginList(cur, top);
      if (isCell(cur.el) && !cur.el.closest('[data-chart], aside, .terminal')) return beginTable(cur, top);
      return false;
    },
    /**
     * `el` taken into the session already running, when it is another item
     * of its list or another cell of its table: a click or a double-click
     * there moves the typing, it does not end the session.
     */
    claim(cur, el) {
      const s = cur?.list ?? cur?.table;
      if (!s || el === cur.el) return !!s && el === cur.el;
      if (s.kind === 'list' && s.doc && el.tagName === 'LI' && s.keyOf.has(el) && s.root.contains(el)) {
        sync(s, cur.el);
        setHost(s, cur, el, null);
        return true;
      }
      if (s.kind === 'table' && isCell(el) && el.closest('table') === s.table) {
        if (!s.cells.has(el)) s.cells.set(el, el.innerHTML);
        setHost(s, cur, el, null);
        return true;
      }
      return false;
    },
    /** The session a failed save left on the list or table `el` is in, to pick up again. */
    strandedFor(el, stranded) {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const cur = stranded.get(n);
        if (cur && (cur.list?.root === n || cur.table?.table === n)) return cur;
      }
      return null;
    },
    resume(cur, el) {
      const s = cur.list ?? cur.table;
      if (s.kind === 'table' && !s.cells.has(el)) s.cells.set(el, el.innerHTML);
      setHost(s, cur, el, null);
    },
    /** A key typed in a session: true when it was the session's to answer. */
    key(e, cur) {
      if (cur.list) return listKey(e, cur);
      if (cur.table) return tableKey(e, cur);
      // a list item edited the old way still keeps Tab on the page
      if (cur.plainItem && e.key === 'Tab') { e.preventDefault(); return true; }
      return false;
    },
    save: (cur) => (cur.list ? saveList(cur) : saveTable(cur)),
    cancel: (cur) => (cur.list ? cancelList(cur) : cancelTable(cur)),
    /** Is the session moving the typing from one element to another (a blur that ends nothing)? */
    moving: (cur) => !!(cur?.list?.moving || cur?.table?.moving),
    changed(cur) {
      const s = cur.list ?? cur.table;
      if (s.kind === 'table') return s.added.length > 0 || [...s.cells].some(([cell, was]) => cell.isConnected && cell.innerHTML !== was);
      return s.structural || s.dirty || liveWords(cur.el) !== (s.shown.get(cur.el) ?? s.firstWords);
    },
    /** What the hint sits under in a session: the whole list or table, so it hides no point of it. */
    anchor: (cur) => cur?.list?.root ?? cur?.table?.table ?? null,
    /** The hint under the text, for a session: what Enter and Tab do here. */
    hint(cur) {
      if (cur.list) return `⏎ new point · ⇥ indent · ⇧⇥ outdent · ${MOVE} move · ${KEEP} keep · Esc cancel`;
      if (cur.table) return '⇥ next cell · ⏎ keep · Esc cancel';
      return null;
    },
    /** The element menu's table rows, for a right-click on a cell. */
    tableRows(target, close) {
      const cell = target?.clicked?.closest?.('td, th');
      if (!cell || !target.top || !(target.top === cell || target.top.contains(cell))) return [];
      if (cell.closest('[data-chart], aside, .terminal')) return [];
      return TABLE_ROWS.map(([label, op, said]) => ({ label, run: () => { close(); tableChange(cell, op, said); } }));
    },
  };
}
