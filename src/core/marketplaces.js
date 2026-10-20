// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Marketplaces…" — every registered marketplace on one screen, write mode
// only (SPEC MARKETPLACES_SCREEN, PLATFORM MARKETPLACE_REGISTRY).
//
// One card, three views. The LIST is read from the cache alone (GET
// /deck/edit/marketplaces): where each catalog comes from, at which ref and
// commit, what it offers. Whether a source has moved since is a question the
// list never asks by itself — C asks it (`decklight marketplace outdated`,
// which reads where each ref points and fetches nothing), and each row then
// says up to date, behind, or why it could not tell. ⏎ updates the selected
// marketplace and U every one found behind (`decklight marketplace update`),
// and an update opens WHAT'S NEW: the entries the catalog added, dropped or
// moved to a new version, and which of your installs it now has newer, with
// the command that takes each — and, when the update left the open deck
// behind one of its design systems, the sentence `check` says and M to
// migrate it, in the agent panel. W reopens it for the last update. ADD is the
// registration that used to be a card of its own: what `decklight
// marketplace add` takes, a first ⏎ that only says what it would clone or
// read, a second that does it. After an add or an update the pickers that
// list marketplace units are told to ask again (`onChanged`), so a new
// catalog's design systems, themes and fonts are there without a reload.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';

const KINDS = [['design-system', 'design system', 'design systems'], ['theme', 'theme', 'themes'], ['font', 'font', 'fonts']];

/** "1 design system, 2 themes" — what the pickers will now show, or ''. */
/**
 * The forms the add field takes, one example of each — the CLI's own
 * `--help` examples, so the field and the command agree.
 */
export const ADD_EXAMPLES = [
  ['owner/repo', 'decklight/decklight-plugins-official', ''],
  ['a git URL', 'git@github.com:acme/brand-kit.git', ''],
  ['a branch or tag', 'acme/themes --branch v2.1.0', ''],
  ['a path', '../my-marketplace', 'read from the deck\'s folder'],
];

/**
 * What was typed, split the way `decklight marketplace add` reads it: the
 * source, and the one option it takes, `--branch <ref>`, from anywhere on the
 * line. `{ spec, ref }`, `ref` null when none was given — and '' when
 * `--branch` was written with nothing after it, which the server refuses by
 * name rather than quietly cloning the default branch.
 */
export function parseAddSpec(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const i = words.indexOf('--branch');
  if (i < 0) return { spec: words.join(' '), ref: null };
  const ref = words[i + 1] ?? '';
  return { spec: [...words.slice(0, i), ...words.slice(i + 2)].join(' '), ref };
}

export function offeredPhrase(counts = {}) {
  return KINDS.filter(([k]) => counts[k] > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`).join(', ');
}

/** "2 new, 1 gone, 3 new versions" — an update's changes in a phrase, '' for none. */
export function changesPhrase(c) {
  if (!c || c.first) return '';
  return [[c.added, 'new', 'new'], [c.removed, 'gone', 'gone'], [c.changed, 'new version', 'new versions']]
    .filter(([l]) => l?.length).map(([l, one, many]) => `${l.length} ${l.length === 1 ? one : many}`).join(', ');
}

/** "just now", "4 min ago", "3 h ago", "2 days ago" — for a time this machine wrote. */
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const short = (c) => (c ? `@${c.slice(0, 7)}` : '');

/** A hint's keys drawn as keycaps: "⏎ update · C check" → <kbd>⏎</kbd> update · <kbd>C</kbd> check. */
const keys = (hint) => escapeHtml(hint).replace(/(^|· )(↑\/↓|⏎|Esc|[A-Z])(?= )/g, '$1<kbd>$2</kbd>');

/**
 * What a row says about its marketplace: one mark, and the words beside it.
 * The listing's own state comes first (never fetched, unreadable), then the
 * last check's answer, and a marketplace nobody has checked says exactly that.
 */
export function marketplaceStatus(m, check = null) {
  if (m.state === 'unfetched') return { mark: '○', cls: 'mk-behind', text: 'not fetched yet — ⏎ fetches it' };
  if (m.state === 'unreadable') return { mark: '⚠', cls: 'mk-behind', text: 'its cached catalog no longer reads — ⏎ fetches it again' };
  if (!check) return { mark: '·', cls: '', text: 'not checked — C asks its source' };
  if (check.state === 'current') return { mark: '✓', cls: 'mk-current', text: 'up to date' };
  if (check.state === 'behind') {
    return { mark: '↑', cls: 'mk-behind', text: m.local ? 'changed on disk — ⏎ reads it again' : `update available ${short(check.commit)} → ${short(check.remote)}` };
  }
  if (check.state === 'unknown') return { mark: '?', cls: '', text: 'no commit recorded to compare — ⏎ updates it and records one' };
  if (check.state === 'unfetched') return { mark: '○', cls: 'mk-behind', text: 'not fetched yet — ⏎ fetches it' };
  return { mark: '?', cls: 'mk-warn', text: `could not check — ${check.error ?? 'no answer'}` };
}

/** Is this marketplace one U would update? */
const isBehind = (m, check) => m.state !== 'fetched' || check?.state === 'behind';

/**
 * `base()` is the edit server's URL, null when there is none (`''` is the
 * commonest server: same-origin). `onChanged(result)` runs after an add or an
 * update, with the route's answer; `then` (given to `open`) is where the
 * person came from, reopened when the add they came for is done.
 */
export function createMarketplaces({ root, base, toast, onChanged = () => {}, migrate = null, debugLog = () => {} }) {
  let el = null, view = 'list', then = null, busy = null;
  // the list
  let list = null, listError = null, sel = 0, rows = [];
  const checks = new Map();   // name → the last check's answer, kept while the page lives
  let checkedAt = null;
  // the add view
  let step = 'ask', spec = '', plan = null, addError = null;
  // what's new
  let news = null;
  const behindAfter = new Map();   // name → the design systems the open deck was behind after its update

  const card = () => el?.querySelector('.narr-card');

  async function call(method, path, body) {
    const r = await fetch(`${base()}${path}`, method === 'GET' ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error ?? `the edit server answered ${r.status}`);
    return j;
  }

  // ── rendering ──────────────────────────────────────────────────────────

  function render() {
    const c = card();
    if (!c) return;
    if (view === 'add') renderAdd(c);
    else if (view === 'news') renderNews(c);
    else renderList(c);
  }

  function renderList(c) {
    let html = '<div class="narr-head">marketplaces</div>';
    if (listError) {
      c.innerHTML = `${html}<div class="rec-line rec-warn">${escapeHtml(listError)}</div><div class="rec-hint">Esc closes</div>`;
      return;
    }
    if (!list) { c.innerHTML = `${html}<div class="rec-line">asking the edit server…</div>`; return; }
    rows = [];
    for (const m of list) {
      const st = busy?.name === m.name ? { mark: '…', cls: '', text: m.state === 'unfetched' ? 'fetching…' : 'updating…' } : marketplaceStatus(m, checks.get(m.name));
      // the state is a word or two in a pill; what to do about it, if the
      // text says, is the dimmer sentence after the dash
      const [label, hint] = st.text.split(' — ');
      const offers = offeredPhrase(m.counts);
      const newer = m.newer?.length ? `${m.newer.length} of your installs ${m.newer.length === 1 ? 'has a' : 'have'} newer version${m.newer.length === 1 ? '' : 's'}` : '';
      const act = [
        st.cls === 'mk-current' ? '⏎ updates it anyway' : m.local ? '⏎ reads it again' : `⏎ ${m.state === 'unfetched' ? 'fetches' : 'updates'} it — a clone with your git credentials`,
        (m.changes || m.newer?.length) && 'W what\'s new',
      ].filter(Boolean).join(' · ');
      html += `<div class="narr-row mk-row ${st.cls}" data-i="${rows.length}">`
        + `<span class="mk-mark" aria-hidden="true">${st.mark}</span>`
        + '<span class="narr-row-label">'
        + '<span class="mk-head">'
        + `<span class="mk-name">${escapeHtml(m.name)}</span>`
        + `${m.firstParty ? '<span class="mk-tag">first-party</span>' : ''}`
        + `<span class="mk-state"><span class="mk-pill">${escapeHtml(label)}</span>${hint ? `<span class="mk-hint">${escapeHtml(hint)}</span>` : ''}</span>`
        + '</span>'
        + '<span class="mk-meta">'
        + `<span class="mk-src">${escapeHtml(m.source)}${m.ref ? ` <span class="mk-ref">#${escapeHtml(m.ref)}</span>` : ''}${m.commit ? ` <span class="mk-ref">${short(m.commit)}</span>` : ''}</span>`
        + `${offers ? `<span class="mk-offers">offers ${escapeHtml(offers)}</span>` : ''}`
        + `${newer ? `<span class="mk-offers mk-newer-count">${escapeHtml(newer)}</span>` : ''}`
        + '</span>'
        + `<span class="mk-act">${keys(act)}</span>`
        + '</span></div>';
      rows.push({ m });
    }
    if (!list.length) html += '<div class="rec-line">No marketplace is registered.</div>';
    rows.push({ add: true });
    html += `<div class="narr-row mk-row mk-add" data-i="${rows.length - 1}"><span class="mk-mark" aria-hidden="true">+</span>`
      + '<span class="narr-row-label"><span class="mk-head"><span class="mk-name">Add a marketplace…</span><span class="narr-flavor">owner/repo, a git URL, or a path</span></span></span></div>';
    const behind = list.filter((m) => isBehind(m, checks.get(m.name))).length;
    html += '<div class="mk-foot">'
      + `<div class="rec-line mk-summary${checkedAt && behind ? ' mk-summary-behind' : ''}">${busy?.check ? 'asking each source where it is now…'
        : checkedAt ? `checked ${ago(checkedAt)}: ${behind ? `${behind} of ${list.length} out of date` : 'all up to date'}`
          : 'C asks each source whether it has moved — nothing is fetched'}</div>`
      + `<div class="rec-hint">${keys(`↑/↓ · ⏎ update · C check for updates${behind ? ' · U update all out of date' : ''} · A add · Esc closes`)}</div>`
      + '</div>';
    c.innerHTML = html;
    c.querySelectorAll('.mk-row').forEach((r) => {
      r.addEventListener('mouseenter', () => select(Number(r.dataset.i)));
      r.addEventListener('click', () => { select(Number(r.dataset.i)); activate(); });
    });
    select(Math.min(sel, rows.length - 1));
  }

  function renderNews(c) {
    const { name, changes: ch, newer = [], behind = [] } = news;
    let html = `<div class="narr-head">what's new in ${escapeHtml(name)}</div>`;
    if (!ch) {
      html += '<div class="rec-line">No update recorded yet — ⏎ on its row updates it.</div>';
    } else {
      html += `<div class="rec-line mk-when">${escapeHtml(`updated ${ago(ch.at)}${ch.from || ch.to ? ` · ${short(ch.from) || 'unrecorded'} → ${short(ch.to) || 'unrecorded'}` : ''}`)}</div>`;
      const item = (sign, e, rest = '') => `<div class="rec-line mk-change"><span class="mk-sign">${sign}</span> `
        + `<span class="mk-name">${escapeHtml(`${e.name}@${name}`)}</span> <span class="mk-ver">${escapeHtml(rest)}</span> <span class="mk-tag">${escapeHtml(e.type)}</span></div>`;
      if (ch.first) html += `<div class="rec-line">The first fetch: ${ch.added.length} ${ch.added.length === 1 ? 'entry' : 'entries'}, with nothing before to compare.</div>`;
      else if (!ch.added.length && !ch.removed.length && !ch.changed.length) html += '<div class="rec-line">Nothing in the catalog changed.</div>';
      if (!ch.first) {
        if (ch.added.length) html += '<div class="narr-group">new</div>' + ch.added.map((e) => item('+', e, e.version ?? '')).join('');
        if (ch.changed.length) html += '<div class="narr-group">new versions</div>' + ch.changed.map((e) => item('↑', e, `${e.from ?? 'unversioned'} → ${e.to ?? 'unversioned'}`)).join('');
        if (ch.removed.length) html += '<div class="narr-group">no longer offered</div>' + ch.removed.map((e) => item('−', e)).join('');
      }
    }
    if (newer.length) {
      // an update refreshes the catalog; taking a newer version stays a command
      html += '<div class="narr-group">newer than what you installed</div>'
        + newer.map((n) => `<div class="rec-line mk-change mk-newer"><span class="mk-sign">↑</span> `
          + `<span class="mk-name">${escapeHtml(n.qualified)}</span> <span class="mk-ver">${escapeHtml(`${n.from ?? 'unversioned'} → ${n.to}${n.note ? ` (${n.note})` : ''}`)}</span>`
          + `${n.how ? `<div class="narr-fix">${escapeHtml(n.how)}</div>` : ''}</div>`).join('');
    }
    if (behind.length) {
      // the deck that is open, after this update: the sentence `check` says,
      // and Migrate, which runs in the agent panel (DESIGN_SYSTEM_MIGRATIONS)
      html += '<div class="narr-group">this deck is now behind</div>'
        + behind.map((b, i) => `<div class="rec-line mk-change mk-deck-behind"><span class="mk-sign">⚠</span> `
          + `<span class="mk-name">${escapeHtml(b.title)}</span>`
          + `<div class="narr-fix">${escapeHtml(b.message)}</div>`
          + `${migrate ? `<button type="button" class="narr-prev-btn mk-migrate" data-i="${i}">Migrate</button>` : ''}</div>`).join('');
    }
    html += `<div class="rec-hint">${keys(`${behind.length && migrate ? 'M migrate · ' : ''}Esc back to the marketplaces`)}</div>`;
    c.innerHTML = html;
    c.querySelectorAll('.mk-migrate').forEach((b) => b.addEventListener('click', () => migrateBehind(Number(b.dataset.i))));
  }

  /** M, or a Migrate button: the card closes so the agent panel it runs in is in view. */
  function migrateBehind(i = 0) {
    const b = news?.behind?.[i];
    if (!b || !migrate) return;
    debugLog('marketplace', `migrate ${b.ref} after updating ${news.name}`);
    close();
    migrate(b.ref);
  }

  function renderAdd(c) {
    let html = '<div class="narr-head">add a marketplace</div>';
    if (step === 'ask') {
      html += `<input class="narr-input mk-spec" type="text" placeholder="owner/repo, a git URL, or a path" aria-label="Marketplace source" spellcheck="false" autocomplete="off" value="${escapeHtml(spec)}">`;
      if (addError) html += `<div class="rec-line rec-warn mk-error">${escapeHtml(addError)}</div>`;
      // one example of each form, and a click puts it in the field to start from
      html += '<div class="mk-examples"><div class="mk-examples-head">for example</div>'
        + ADD_EXAMPLES.map(([form, example, note]) => `<div class="mk-example"><span class="mk-form">${escapeHtml(form)}</span>`
          + `<code title="click to use it">${escapeHtml(example)}</code>${note ? `<span class="narr-flavor">${escapeHtml(note)}</span>` : ''}</div>`).join('')
        + '</div>';
      html += `<div class="rec-hint">${keys('⏎ next · Esc back')}</div>`;
    } else if (step === 'confirm') {
      html += `<div class="rec-line mk-does">${escapeHtml(plan.does[0].toUpperCase() + plan.does.slice(1))}</div>`;
      if (plan.registered) html += `<div class="rec-line">already registered as ${escapeHtml(plan.registered)} — this refreshes it</div>`;
      html += `<div class="rec-hint">${keys(`⏎ ${plan.url ? 'clone it' : 'register it'} · Esc back`)}</div>`;
    } else {
      html += `<div class="rec-line">${plan?.url ? `cloning ${escapeHtml(plan.url)}…` : 'registering…'}</div>`;
    }
    c.innerHTML = html;
    const input = c.querySelector('.mk-spec');
    if (input) {
      input.addEventListener('input', () => { spec = input.value; });
      input.addEventListener('keydown', (e) => {
        // the field holds the keyboard: nothing typed here reaches the deck
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); ask(); } else if (e.key === 'Escape') { e.preventDefault(); back(); }
      });
      setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
      c.querySelectorAll('.mk-example code').forEach((ex) => ex.addEventListener('click', () => {
        spec = input.value = ex.textContent;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }));
    }
  }

  function select(i) {
    if (!rows.length) return;
    sel = selectInList([...(card()?.querySelectorAll('.mk-row') ?? [])], i, 'narr-sel');
  }

  // ── the list ───────────────────────────────────────────────────────────

  async function load() {
    try {
      list = (await call('GET', '/deck/edit/marketplaces')).marketplaces ?? [];
      listError = null;
    } catch (e) {
      listError = `could not list the marketplaces — ${e.message ?? e}`;
    }
    // an add opened straight away is not redrawn under the person typing in it
    if (view === 'list') render();
  }

  /** C: ask every source where it is now. Nothing is fetched, nothing changes. */
  async function check() {
    if (busy || !list) return;
    busy = { check: true };
    render();
    try {
      const j = await call('POST', '/deck/edit/marketplace/check', {});
      for (const r of j.marketplaces ?? []) checks.set(r.name, r);
      checkedAt = new Date().toISOString();
      const behind = (j.marketplaces ?? []).filter((r) => r.state === 'behind' || r.state === 'unfetched').map((r) => r.name);
      debugLog('marketplace', `checked ${j.marketplaces?.length ?? 0}: ${behind.length ? `behind ${behind.join(', ')}` : 'all current'}`);
    } catch (e) {
      toast(`could not check the marketplaces — ${e.message ?? e}`, 6000);
    } finally { busy = null; }
    render();
  }

  /** ⏎ on a marketplace: `decklight marketplace update`, then what's new. */
  async function update(m, { show = true } = {}) {
    if (busy && !busy.all) return false;
    busy = { ...busy, name: m.name };
    render();
    try {
      const j = await call('POST', '/deck/edit/marketplace/update', { name: m.name });
      debugLog('marketplace', `updated ${m.name}${j.commit ? ` to ${j.commit.slice(0, 7)}` : ''}`);
      checks.set(m.name, { name: m.name, state: 'current', commit: j.commit, local: m.local });
      behindAfter.set(m.name, j.behind ?? []);
      for (const b of j.behind ?? []) debugLog('marketplace', `the deck is now behind ${b.ref}: ${b.message}`);
      busy = busy?.all ? { all: true } : null;
      await load();
      onChanged(j);
      if (show) {
        const what = changesPhrase(j.changes);
        toast(`updated ${m.name}${what ? ` — ${what}` : j.changes?.first ? ` — ${offeredPhrase(j.counts) || 'fetched'}` : ' — nothing in the catalog changed'}`, 5000);
        news = { name: m.name, changes: j.changes, newer: j.newer ?? [], behind: j.behind ?? [] };
        view = 'news';
        render();
      }
      return true;
    } catch (e) {
      busy = busy?.all ? { all: true } : null;
      toast(`${m.name} was not updated — ${e.message ?? e}`, 8000);
      render();
      return false;
    }
  }

  /** U: update every marketplace found out of date, one after another. */
  async function updateAll() {
    if (busy || !list) return;
    const due = list.filter((m) => isBehind(m, checks.get(m.name)));
    if (!due.length) { toast(checkedAt ? 'every marketplace is up to date' : 'C first: nothing has been checked yet', 3200); return; }
    busy = { all: true };
    let done = 0;
    for (const m of due) if (await update(m, { show: false })) done++;
    busy = null;
    render();
    toast(`updated ${done} of ${due.length} marketplace${due.length === 1 ? '' : 's'}${done ? ' — W on a row says what\'s new' : ''}`, 5000);
  }

  function whatsNew() {
    const m = rows[sel]?.m;
    if (!m) return;
    news = { name: m.name, changes: m.changes, newer: m.newer ?? [], behind: behindAfter.get(m.name) ?? [] };
    view = 'news';
    render();
  }

  function activate() {
    const r = rows[sel];
    if (!r || busy) return;
    if (r.add) openAdd();
    else update(r.m);
  }

  // ── the add view ───────────────────────────────────────────────────────

  function openAdd() {
    view = 'add'; step = 'ask'; spec = ''; plan = null; addError = null;
    render();
  }

  /** The first ⏎: what would this do? Nothing is fetched to answer it. */
  async function ask() {
    if (busy) return;
    const asked = parseAddSpec(spec);
    if (!asked.spec) { addError = 'which marketplace? — owner/repo, a git URL, or a path'; return render(); }
    if (asked.ref === '') { addError = '--branch takes a branch or tag name'; return render(); }
    busy = { add: true };
    try {
      plan = (await call('POST', '/deck/edit/marketplace/add', asked)).plan;
      addError = null;
      step = 'confirm';
    } catch (e) {
      addError = String(e.message ?? e);
    } finally { busy = null; }
    render();
  }

  /** The second ⏎: run `decklight marketplace add`. */
  async function confirm() {
    if (busy) return;
    busy = { add: true };
    step = 'working';
    render();
    try {
      const j = await call('POST', '/deck/edit/marketplace/add', { spec: plan.spec, ref: plan.ref ?? null, confirm: true });
      debugLog('marketplace', `${j.refreshed ? 'refreshed' : 'registered'} ${j.name} from ${j.spec}`);
      const offers = offeredPhrase(j.counts);
      toast(`${j.refreshed ? 'refreshed' : 'registered'} ${j.name ?? j.spec}${offers ? ` — ${offers}` : ' — it offers no design system, theme or font'}`, 6000);
      busy = null;
      if (j.name) checks.set(j.name, { name: j.name, state: 'current' });
      const backTo = then;
      if (backTo) { close(); onChanged(j); backTo(); return; }
      onChanged(j);
      view = 'list';
      await load();
      const i = rows.findIndex((r) => r.m?.name === j.name);
      if (i >= 0) select(i);
    } catch (e) {
      // said in the card, where it can be read whole, and the source kept to fix
      busy = null;
      addError = String(e.message ?? e);
      step = 'ask';
      render();
    }
  }

  /** Esc: one view back, and out from the list (or from an add opened on its own). */
  function back() {
    if (view === 'add' && step === 'confirm') { step = 'ask'; return render(); }
    if (view === 'add' && then) return close();
    if (view !== 'list') { view = 'list'; return render(); }
    close();
  }

  // ── the card ───────────────────────────────────────────────────────────

  function open({ view: start = 'list', then: backTo = null } = {}) {
    if (el) return;
    if (base() === null) { toast('marketplaces are managed in write mode — or decklight marketplace list', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-marketplaces';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Marketplaces"></div>';
    closeOnBackdrop(el, () => { if (!busy) close(); });
    root.appendChild(el);
    then = backTo; list = null; listError = null; sel = 0; busy = null;
    view = 'list';
    if (start === 'add') openAdd(); else render();
    load();
  }

  function close() {
    el?.remove();
    el = null;
    then = null;
    rows = [];
  }

  function keydown(e) {
    // a clone or an update finishes, or fails, either way — and says so
    if (busy) return true;
    if (e.key === 'Escape') { back(); return true; }
    if (view === 'add') {
      if (e.key === 'Enter') { if (step === 'confirm') confirm(); else ask(); }
      return true;
    }
    if (view === 'news') {
      if (e.key === 'm' || e.key === 'M') migrateBehind(0);
      return true;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowDown') select(sel + 1);
    else if (k === 'ArrowUp') select(sel - 1);
    else if (k === 'Enter') activate();
    else if (k === 'c') check();
    else if (k === 'u') updateAll();
    else if (k === 'w') whatsNew();
    else if (k === 'a') openAdd();
    return true;   // the card holds the keyboard while it is open
  }

  return { open, close, keydown, isOpen: () => !!el };
}
