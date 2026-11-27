// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck in several languages, in the page (SPEC TRANSLATE_PANEL,
// TRANSLATION_SWITCH).
//
// THE SWITCH needs no server: a source says its languages in its
// configuration (`"languages": ["fr"]`), and a translation carries
// `<link rel="alternate" hreflang>` to its source and its siblings, written by
// `decklight translate`. Choosing one opens that file at the same slide and
// step, which is the same place because the structure is the same. It is a
// link to a sibling file: nothing is fetched, merged or translated here.
//
// LANGUAGES… is write mode's, a second door to `decklight translate`: the list
// is the edit server's (GET /deck/edit/translations, what `--status` reads), a
// run is the command as a child process (POST /deck/edit/translate), its lines
// arriving as `translate` events. Before a run it says what goes to the agent.
// On a translation it lists the slides nobody has read, shows the slide's
// source beside its translation, and R marks the slide read.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop } from './overlay.js';
import { sharedEventSource } from './shared-events.js';

/** A language's name in its own language (`Français`), else the tag. */
export function nativeName(tag) {
  try {
    const n = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return n ? n[0].toLocaleUpperCase(tag) + n.slice(1) : tag;
  } catch { return tag; }
}

/** `talk.html` → [`talk`, `.html`]. */
const splitName = (name) => { const m = /^(.*?)(\.html?)$/i.exec(name); return m ? [m[1], m[2]] : [name, '.html']; };

/**
 * The deck's languages as the switch lists them: `[{ lang, name, href, here }]`,
 * the language on screen marked `here`, or [] for a deck in one language.
 * From a translation's `<link rel="alternate" hreflang>`, else from the
 * source's configured `languages`. Pure over the document it is given.
 */
export function languageRows(doc, pathname) {
  const file = decodeURIComponent(String(pathname ?? '').split('/').pop() || '');
  const own = (doc.documentElement.getAttribute('lang') || '').trim();
  const rows = [];
  const links = [...doc.querySelectorAll('link[rel="alternate"][hreflang][href]')];
  if (links.length) {
    for (const l of links) rows.push({ lang: l.getAttribute('hreflang'), href: l.getAttribute('href') });
  } else {
    let cfg = null;
    try { cfg = JSON.parse(doc.querySelector('script[data-decklight-config]')?.textContent || 'null'); } catch { cfg = null; }
    const langs = Array.isArray(cfg?.languages) ? cfg.languages.filter((x) => typeof x === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(x)) : [];
    if (!langs.length || !file) return [];
    const [stem, ext] = splitName(file);
    for (const lang of langs) rows.push({ lang, href: `${stem}.${lang}${ext}` });
  }
  if (!rows.length) return [];
  if (own && !rows.some((r) => r.lang.toLowerCase() === own.toLowerCase())) rows.unshift({ lang: own, href: file });
  return rows.map((r) => ({ ...r, name: nativeName(r.lang), here: !!own && r.lang.toLowerCase() === own.toLowerCase() }));
}

/** Where a language's row goes: its file, at the same slide and step. */
export const languageHref = (row, { slide, step }, search = '') => `${row.href}${search}#/${slide}/${step}`;

/** A hint's keys drawn as keycaps: "⏎ update · A all" → <kbd>⏎</kbd> update · <kbd>A</kbd> all. */
const keys = (hint) => escapeHtml(hint).replace(/(^|· )(↑\/↓|⏎|Esc|[A-Z])(?= )/g, '$1<kbd>$2</kbd>');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a language's row says: one mark, the state, and the detail. Pure. */
export function languageStatus(l) {
  if (l.error) return { mark: '⚠', cls: 'mk-warn', text: `its record cannot be read — ${l.error}` };
  if (!l.exists) return { mark: '○', cls: 'mk-behind', text: 'not translated yet — ⏎ translates it' };
  if (l.structure) return { mark: '⚠', cls: 'mk-warn', text: 'changed in more than its words — decklight check says where' };
  const read = `${l.reviewed} of ${l.total} reviewed`;
  if (l.up) return { mark: '✓', cls: 'mk-current', text: `up to date — ${read}` };
  const parts = [l.changed && `${l.changed} changed`, l.missing && `${l.missing} missing`].filter(Boolean).join(', ');
  return { mark: "↑", cls: "mk-behind", text: `behind: ${parts} — ${l.behindPhrase || "in the title"} · ${read}` };
}

const KIND = { run: 'text', beat: 'notes', attr: 'attribute', label: 'diagram', title: 'title' };

/**
 * `base()` is the edit server's URL, null when there is none; `state()` the
 * deck's place (`{ slide, step }`); `go(href)` opens another file.
 */
export function createLanguages({ root, base, toast, actionToast = null, state, go = (href) => { location.href = href; }, debugLog = () => {} }) {
  let el = null, list = null, listError = null, sel = 0, rows = [];
  let view = 'list', confirm = null, adding = '', here = false;
  let running = null, lines = [], slideUnits = null;
  let cached = null;   // the last list, for the palette's rows
  let es = null;

  const card = () => el?.querySelector('.narr-card');

  async function call(method, path, body) {
    const r = await fetch(`${base()}${path}`, method === 'GET' ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error ?? `the edit server answered ${r.status}`);
    return j;
  }

  /** Follow the server's `translate` events: a run's lines, its end, a source edit that put a language behind. */
  function listen() {
    if (es || base() === null) return;
    try { es = sharedEventSource(`${base()}/deck/events`); } catch { return; }
    es.addEventListener('translate', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.state === 'start') { running = { langs: d.langs }; lines = []; }
      else if (d.state === 'line') { lines.push(d.text); if (lines.length > 6) lines.shift(); }
      else if (d.state === 'done') {
        running = null;
        toast(d.tail || (d.code === 0 ? 'translated' : 'the translation stopped'), 6000);
        debugLog('translate', d.tail ?? `done (${d.code})`);
        refresh();
      } else if (d.state === 'behind') {
        const names = d.langs.map((l) => l.name);
        const n = Math.max(...d.langs.map((l) => l.n));
        toast(`${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are` : `${names[0]} is`} now ${plural(n, 'piece')} behind · / → Languages…`, 6000);
        refresh();
      } else if (d.state === 'reviewed') { refresh(); if (cached?.isTranslation) loadSlide(); }
      else if (d.state === 'refused') {
        // a change to a translation's structure, refused: one button opens the source at this slide
        const ok = typeof d.source === 'string' && /^[^/\\]+\.html?$/i.test(d.source);
        const open = () => go(languageHref({ href: encodeURIComponent(d.source) }, state(), location.search));
        if (ok && actionToast) actionToast(d.error, [[`Open ${d.source}`, open]]);
        else toast(d.error, 8000);
        return;
      }
      render();
    });
  }

  async function refresh() {
    if (base() === null) return;
    try { cached = await call('GET', '/deck/edit/translations'); list = cached; listError = null; if (cached.running) running = running ?? cached.running; }
    catch (e) { listError = String(e.message ?? e); }
    if (el && list?.isTranslation) loadSlide();
    render();
  }

  async function loadSlide() {
    try { slideUnits = (await call('GET', `/deck/edit/translation/slide?slide=${state().slide}`)).units; }
    catch { slideUnits = null; }
    markSlide();
    render();
  }

  /**
   * On a translation, in write mode: each piece of the slide's text that
   * nobody has read yet is marked where it stands (a dotted rule under it),
   * never in a render, a bundle or in front of an audience, which never have
   * an edit server to ask.
   */
  function markSlide() {
    for (const e of root.querySelectorAll('.decklight-unread')) e.classList.remove('decklight-unread');
    const section = [...root.querySelectorAll('section')].filter((s) => !s.parentElement?.closest('section'))[state().slide - 1];
    if (!section || !slideUnits) return;
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    for (const u of slideUnits) {
      if (u.state !== 'machine' || (u.kind !== 'run' && u.kind !== 'label')) continue;
      const want = norm(u.target);
      let best = null;
      for (const el of section.querySelectorAll('*')) {
        if (el.closest('aside.notes, script, style')) continue;
        if (norm(el.textContent) === want && (!best || best.contains(el))) best = el;
      }
      if (best) best.classList.add('decklight-unread');
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────

  function render() {
    const c = card();
    if (!c) return;
    if (view === 'add') return renderAdd(c);
    let html = '<div class="narr-head">languages</div>';
    if (listError) { c.innerHTML = `${html}<div class="rec-line rec-warn">${escapeHtml(listError)}</div><div class="rec-hint">Esc closes</div>`; return; }
    if (!list) { c.innerHTML = `${html}<div class="rec-line">asking the edit server…</div>`; return; }
    rows = [];
    html += '<div class="narr-row mk-row" aria-disabled="true">'
      + '<span class="mk-mark" aria-hidden="true">·</span><span class="narr-row-label"><span class="mk-head">'
      + `<span class="mk-name">${escapeHtml(list.sourceName)} · ${escapeHtml(list.sourceLang ?? '')}</span>`
      + `<span class="mk-state"><span class="mk-pill">source</span><span class="mk-hint">${escapeHtml(list.source)}</span></span>`
      + '</span></span></div>';
    for (const l of list.languages) {
      const busy = running?.langs?.some((x) => x.toLowerCase() === l.lang.toLowerCase());
      const st = busy ? { mark: '…', cls: '', text: `translating — ${lines.at(-1) ?? 'starting'}` } : languageStatus(l);
      const [label, hint] = st.text.split(' — ');
      const act = busy ? 'Esc stops it after the slides in flight'
        : [`⏎ ${l.exists ? 'updates' : 'translates'} it`, l.exists && 'O opens it here', 'N without the agent'].filter(Boolean).join(' · ');
      html += `<div class="narr-row mk-row ${st.cls}" data-i="${rows.length}">`
        + `<span class="mk-mark" aria-hidden="true">${st.mark}</span><span class="narr-row-label"><span class="mk-head">`
        + `<span class="mk-name">${escapeHtml(l.name)} · ${escapeHtml(l.lang)}</span>`
        + `<span class="mk-state"><span class="mk-pill">${escapeHtml(label)}</span>${hint ? `<span class="mk-hint">${escapeHtml(hint)}</span>` : ''}</span>`
        + `</span><span class="mk-meta"><span class="mk-src">${escapeHtml(l.file)}</span>${l.corrected ? `<span class="mk-offers">${plural(l.corrected, 'correction')} of yours, kept at the next run</span>` : ''}`
        + `${l.overflow?.length ? `<span class="mk-offers mk-warn-line">${l.overflow.length === 1 ? 'a slide still overflows' : `${l.overflow.length} slides still overflow`} ${escapeHtml(l.overflowPhrase)}</span>` : ''}`
        + `${l.staleTakes ? `<span class="mk-offers mk-warn-line">recorded takes on ${plural(l.staleTakes.slides.length, 'slide')} no longer match the script ${escapeHtml(l.staleTakes.phrase)}: record or re-voice them</span>` : ''}</span>`
        + `<span class="mk-act">${keys(act)}</span></span></div>`;
      rows.push({ l });
    }
    rows.push({ add: true });
    html += `<div class="narr-row mk-row mk-add" data-i="${rows.length - 1}"><span class="mk-mark" aria-hidden="true">+</span><span class="narr-row-label"><span class="mk-name">Add a language…</span></span></div>`;
    if (confirm) {
      html += `<div class="rec-line">${escapeHtml(confirm.say)}</div><div class="rec-hint">${keys('⏎ starts it · Esc goes back')}</div>`;
    } else if (running && lines.length) {
      html += `<div class="rec-line mk-log">${lines.map(escapeHtml).join('<br>')}</div>`;
    }
    if (list.isTranslation) html += renderReading();
    const allBehind = list.languages.filter((l) => !l.up).length;
    html += `<div class="rec-hint">${keys(['↑/↓ choose', '⏎ update', allBehind > 1 ? 'A every one behind' : '', `S ${here ? 'every slide' : 'this slide only'}`, list.isTranslation ? 'R mark this slide read' : '', 'Esc closes'].filter(Boolean).join(' · '))}</div>`;
    c.innerHTML = html;
    c.querySelectorAll('[data-i]').forEach((r) => {
      r.addEventListener('click', () => { select(Number(r.dataset.i)); activate(); });
    });
    select(sel);
  }

  /** On a translation: the slides nobody has read, and this slide's source beside its translation. */
  function renderReading() {
    const unread = list.unread ?? [];
    let html = `<div class="narr-head">reading ${escapeHtml(list.deck)}</div>`;
    html += unread.length
      ? `<div class="rec-line">not read yet: ${unread.slice(0, 6).map((u) => `${escapeHtml(u.name)} (${u.n})`).join(', ')}${unread.length > 6 ? ` and ${unread.length - 6} more` : ''}</div>`
      : '<div class="rec-line">every slide has been read</div>';
    if (slideUnits?.length) {
      html += '<div class="mk-units">';
      for (const u of slideUnits) {
        html += `<div class="mk-unit ${u.state === 'machine' ? 'mk-unread' : ''}"><span class="mk-kind">${KIND[u.kind] ?? u.kind}</span>`
          + `<span class="mk-from">${escapeHtml(u.source)}</span><span class="mk-to">${escapeHtml(u.target)}</span>`
          + `<span class="mk-pill">${u.state === 'machine' ? 'not read' : u.state === 'pending' ? 'behind' : 'read'}</span></div>`;
      }
      html += '</div>';
    }
    return html;
  }

  function renderAdd(c) {
    const tag = adding.trim();
    const ok = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag);
    const file = list?.source ? list.source.replace(/(\.html?)$/i, `.${tag || '…'}$1`) : '';
    c.innerHTML = '<div class="narr-head">add a language</div>'
      + `<input class="mk-input" type="text" spellcheck="false" placeholder="a language tag: de, es, pt-BR, ja" value="${escapeHtml(adding)}" aria-label="Language tag">`
      + `<div class="rec-line">${ok ? `${escapeHtml(nativeName(tag))} · writes ${escapeHtml(file)}` : 'de · es · it · ja · pt-BR · zh-Hans'}</div>`
      + `<div class="rec-hint">${keys('⏎ adds it and translates it · Esc goes back')}</div>`;
    const input = c.querySelector('input');
    input.addEventListener('input', () => { adding = input.value; renderAdd(c); const i = card()?.querySelector('input'); i?.focus(); i?.setSelectionRange(adding.length, adding.length); });
    input.focus();
  }

  function select(i) {
    if (!rows.length) return;
    sel = Math.max(0, Math.min(rows.length - 1, i));
    card()?.querySelectorAll('[data-i]').forEach((r) => r.classList.toggle('selected', Number(r.dataset.i) === sel));
  }

  // ── acting ─────────────────────────────────────────────────────────────

  /** First ⏎: say what goes to the agent; the second starts it. */
  function ask(langs, { agent = true } = {}) {
    const ls = list.languages.filter((l) => langs.includes(l.lang));
    const slides = here ? [state().slide] : null;
    const behind = ls.reduce((n, l) => n + (l.exists ? (l.changed ?? 0) + (l.missing ?? 0) : 0), 0);
    const names = ls.map((l) => l.name).join(', ') || langs.join(', ');
    const say = agent
      ? `${names}: the ${here ? 'slide\'s' : 'slides\''} text and notes ${behind ? `(${plural(behind, 'piece')} behind)` : ''} go to your coding agent, which is most likely a cloud service. Decklight writes only what passes its check.`
      : `${names}: regenerated without the agent — the structure catches up, the words that need it stay behind.`;
    confirm = { langs, agent, slides, say };
    render();
  }

  async function start() {
    const c = confirm;
    confirm = null;
    try {
      await call('POST', '/deck/edit/translate', { to: c.langs, slides: c.slides, agent: c.agent });
      running = { langs: c.langs }; lines = [];
    } catch (e) { toast(String(e.message ?? e), 6000); }
    render();
  }

  function activate() {
    const r = rows[sel];
    if (!r || running) return;
    if (r.add) { view = 'add'; adding = ''; return render(); }
    ask([r.l.lang]);
  }

  async function markRead() {
    if (!list?.isTranslation) return;
    try { const j = await call('POST', '/deck/edit/translation/reviewed', { slide: state().slide }); toast(j.marked ? `${plural(j.marked, 'piece')} on this slide marked read` : 'this slide was already read', 3000); }
    catch (e) { toast(String(e.message ?? e), 5000); }
    refresh();
  }

  function open() {
    if (el) return;
    if (base() === null) { toast('Languages… is for write mode — or decklight translate <deck> --status', 3600); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-marketplaces decklight-languages';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Languages"></div>';
    closeOnBackdrop(el, () => close());
    root.appendChild(el);
    view = 'list'; confirm = null; sel = 0;
    listen();
    render();
    refresh();
  }

  function close() { el?.remove(); el = null; rows = []; confirm = null; }

  function keydown(e) {
    if (view === 'add') {
      if (e.key === 'Escape') { view = 'list'; render(); return true; }
      if (e.key === 'Enter') {
        const tag = adding.trim();
        if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) { view = 'list'; ask([tag]); }
        return true;
      }
      return false;   // the field types
    }
    if (confirm) {
      if (e.key === 'Enter') start();
      else if (e.key === 'Escape') { confirm = null; render(); }
      return true;
    }
    if (e.key === 'Escape') {
      if (running) { call('POST', '/deck/edit/translate/stop').then(() => toast('stopping after the slides in flight', 3000)).catch(() => {}); return true; }
      close(); return true;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowDown') select(sel + 1);
    else if (k === 'ArrowUp') select(sel - 1);
    else if (k === 'Enter') activate();
    else if (k === 'a' && !running) { const behind = list?.languages.filter((l) => !l.up).map((l) => l.lang) ?? []; if (behind.length) ask(behind); }
    else if (k === 'n' && !running) { const l = rows[sel]?.l; if (l) ask([l.lang], { agent: false }); }
    else if (k === 'o') { const l = rows[sel]?.l; if (l?.exists) { const s = state(); go(languageHref({ href: l.file }, s, location.search)); } }
    else if (k === 's') { here = !here; render(); }
    else if (k === 'r') markRead();
    return true;
  }

  /** The languages behind, from the last list this page read: for the palette's Update row. */
  const behind = () => (cached?.languages ?? []).filter((l) => l.exists && !l.up).map((l) => l.lang);

  /** Write mode came up: read the list once, so the palette knows what is behind, and follow the events. */
  async function warm() {
    if (base() === null) return;
    listen();
    await refresh();
    if (cached?.isTranslation) loadSlide();
  }

  /** Update every language behind, from the palette, after the same confirmation. */
  function updateBehind() { open(); const wait = () => { if (list) { const b = behind(); if (b.length) ask(b); } else setTimeout(wait, 100); }; wait(); }

  return { open, close, keydown, isOpen: () => !!el, behind, warm, updateBehind, slideChanged: () => { if (cached?.isTranslation) loadSlide(); } };
}
