// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Everything that decides what the deck LOOKS like: which theme is applied,
// where the applied theme can come from (a stylesheet link, an inlined <style>
// in a bundle, a generated token map, a saved custom), how you move between
// them (, and . cycle · ⌃T rolls · T opens the picker), and the picker itself.
//
// It came out of engine.js whole. The engine keeps a handle and a few
// forwarding calls; nothing else in the engine now knows that a theme can be a
// <style> element, or that packs exist.

import { generateTheme, tokensToCss, luminance } from './themegen.js';
import { closeOnBackdrop, selectInList } from './overlay.js';

/**
 * Wire the theme system to a deck.
 *
 * `ctx` is the engine's shared furniture: `root` (the .decklight element),
 * `config`, `params` (the query string), `toast`, `debugLog`, `overlays` (the
 * keyboard registry) and `deck()` — a LATE accessor for the deck instance,
 * because themes are set up before the instance exists but only ever read it
 * from a click or a keystroke. `editmode()` is late for the same reason and
 * more so: edit mode is built after this and only ever consulted from the open
 * picker. It is what makes Browse authoring-only.
 */
export function createThemes({ root, config, params, toast, debugLog, overlays, deck, editmode }) {
  // ----- theme switching -----------------------------------------------------
  // Two modes. Link mode: the theme is the stylesheet link pointing into
  // themes/, and applyTheme swaps its href. Inline mode (bundled single-file
  // decks): themes are embedded as <style data-theme="name"> blocks and
  // applyTheme toggles which one applies. Toggling uses media="not all" —
  // the HTML `disabled` attribute on <style> is non-functional per spec (only
  // the IDL property works), so media is the declarative mechanism; both
  // forms are normalized here for tolerant authoring.
  // `decklight theme add` installs a third-party theme as a <style data-theme
  // data-theme-added> block. Those are held apart from the deck's OWN theme
  // blocks deliberately: a link-mode deck that gained one would otherwise flip
  // to inline mode and its entire theme list would collapse to that one added
  // file. They behave like saved customs instead — extra entries that apply by
  // winning the cascade, in either mode.
  const themeStyles = [...document.querySelectorAll('style[data-theme]:not([data-theme-added])')];
  const addedStyles = [...document.querySelectorAll('style[data-theme][data-theme-added]')];
  const addedThemes = new Set(addedStyles.map((s) => s.dataset.theme).filter(Boolean));
  const inlineThemes = themeStyles.length > 0;
  const themeLink = inlineThemes ? null
    : document.querySelector('link[rel="stylesheet"][href*="themes/"]');
  if (inlineThemes) {
    let active = themeStyles.find((s) => !s.hasAttribute('disabled') && s.media !== 'not all');
    active = active || themeStyles[0];
    themeStyles.forEach((s) => {
      s.removeAttribute('disabled');
      s.media = s === active ? 'all' : 'not all';
    });
  }
  const hasThemes = inlineThemes || !!themeLink;
  const themeOf = (href) => (href.match(/themes\/([\w-]+)\.css/) || [])[1];
  const themeKey = 'decklight-theme:' + location.pathname;

  // ── generated & saved-custom themes (SPEC PRESENTING) ──────────────────────────
  // Both live as <style data-theme> elements appended LAST in <head>, so an
  // active one wins the cascade over the link/inline base theme (equal
  // specificity, later order). Saved customs persist as token maps in
  // localStorage — per-origin; the .css download is the portable artifact.
  const CUSTOM_KEY = 'decklight-custom-themes';
  let customThemes = {};
  try { customThemes = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}') || {}; } catch { /* ignore */ }
  let genStyle = null;   // <style data-generated> of the current roll
  let genTheme = null;   // { name, tokens } of the current (unsaved) roll
  const customStyles = {};

  function ensureTokenStyle(name, tokens, kind) {
    let el = kind === 'generated' ? genStyle : customStyles[name];
    if (!el) {
      el = document.createElement('style');
      el.media = 'not all';
      if (kind === 'generated') el.dataset.generated = '';
      else el.dataset.custom = '';
    }
    el.dataset.theme = name;
    el.textContent = tokensToCss(name, tokens);
    document.head.appendChild(el); // (re-)append → last in head → wins cascade
    if (kind === 'generated') genStyle = el; else customStyles[name] = el;
    return el;
  }
  // added themes join this set: like a custom, an added theme applies by
  // sitting later in <head> than the deck's own theme, so turning one off is
  // the same act as turning off a custom
  const overrideStyles = () => [genStyle, ...Object.values(customStyles), ...addedStyles];
  function deactivateTokenStyles(exceptEl) {
    for (const el of overrideStyles()) {
      if (el && el !== exceptEl) el.media = 'not all';
    }
  }
  const activeTokenStyle = () =>
    overrideStyles().find((el) => el && el.media !== 'not all') || null;

  const currentTheme = () => {
    const tokenStyle = activeTokenStyle();
    if (tokenStyle) return tokenStyle.dataset.theme;
    return inlineThemes
      ? themeStyles.find((s) => s.media !== 'not all')?.dataset.theme
      : (themeLink ? themeOf(themeLink.href) : undefined);
  };

  // canvas polarity: luminance of the painted background (first gradient stop
  // for gradient canvases — computed styles serialize colors to rgb()). Lives
  // here because it is a READING of the applied theme: every swap re-derives
  // it, and the brand logo picks its light/dark variant off the result.
  function updateCanvas() {
    const cs = getComputedStyle(root);
    const rgb = (s) => s?.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+))?\)/);
    let m = rgb(cs.backgroundColor);
    if (!m || (m[4] !== undefined && +m[4] === 0)) m = rgb(cs.backgroundImage);
    const dark = m ? luminance([+m[1], +m[2], +m[3]]) < 0.5 : false;
    root.setAttribute('data-canvas', dark ? 'dark' : 'light');
  }
  // link-mode theme swaps load a stylesheet asynchronously — re-read then
  themeLink?.addEventListener('load', updateCanvas);

  function applyTheme(name, silent = false) {
    if (!name || !/^[\w-]+$/.test(name)) return;
    let unsavedGen = false;
    if (genTheme && genStyle && name === genTheme.name) {
      genStyle.media = 'all';
      deactivateTokenStyles(genStyle);
      unsavedGen = !customThemes[name];
    } else if (customThemes[name]) {
      const el = ensureTokenStyle(name, customThemes[name], 'custom');
      el.media = 'all';
      deactivateTokenStyles(el);
    } else if (addedThemes.has(name)) {
      const el = addedStyles.find((s) => s.dataset.theme === name);
      el.media = 'all';
      deactivateTokenStyles(el);
    } else {
      if (!hasThemes) return;
      deactivateTokenStyles(null); // stock theme takes over
      if (inlineThemes) {
        const target = themeStyles.find((s) => s.dataset.theme === name);
        if (!target) return; // not embedded in this bundle
        themeStyles.forEach((s) => { s.media = s === target ? 'all' : 'not all'; });
      } else {
        themeLink.href = themeLink.href.replace(/themes\/[\w-]+\.css(\?.*)?$/, `themes/${name}.css`);
      }
    }
    // Embedded instances (e.g. picker preview iframes) must not persist; nor
    // can an unsaved generated autoname (it wouldn't resolve after reload).
    if (!params.has('embedded') && !unsavedGen) {
      try { localStorage.setItem(themeKey, name); } catch { /* file:// or private mode */ }
    }
    if (!silent) toast(name);
    debugLog('theme', name);
    updateCanvas(); // inline/generated swaps take effect synchronously
  }
  // ── theme packs (SPEC PRESENTING) — baked from themes/packs.json at build time ────
  const PACKS = typeof __DECKLIGHT_PACKS__ !== 'undefined' ? __DECKLIGHT_PACKS__ : null;
  // the dynamic packs are not in packs.json — they exist only when a deck has
  // something in them, so they carry their labels here
  const DYNAMIC_LABELS = { added: 'Added', custom: 'Custom', generated: 'Generated' };
  const packLabel = (p) => PACKS?.labels?.[p] ?? DYNAMIC_LABELS[p] ?? p;
  function packOf(name) {
    if (customThemes[name]) return 'custom';
    if (genTheme && name === genTheme.name) return 'generated';
    if (addedThemes.has(name)) return 'added';
    if (PACKS) {
      for (const [p, names] of Object.entries(PACKS.packs)) {
        if (names.includes(name)) return p;
      }
    }
    return 'other';
  }
  const themeList = () => {
    let list;
    if (inlineThemes) {
      const available = themeStyles.map((s) => s.dataset.theme);
      list = config.themes?.length
        ? config.themes.filter((n) => available.includes(n))
        : available;
    } else {
      list = config.themes?.length ? config.themes
        : (typeof __DECKLIGHT_THEMES__ !== 'undefined' ? __DECKLIGHT_THEMES__ : []);
    }
    const extras = [...addedThemes, ...Object.keys(customThemes)];
    if (genTheme && !customThemes[genTheme.name]) extras.push(genTheme.name);
    list = [...list, ...extras.filter((n) => !list.includes(n))];
    if (PACKS) {
      // cycling and the picker walk pack by pack: order by pack, then by the
      // pack's own order; customs/generated keep their relative order at the end
      const rank = new Map();
      let r = 0;
      for (const p of PACKS.order) for (const n of PACKS.packs[p] ?? []) rank.set(n, r++);
      list = [...list].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
    }
    return list;
  };
  // [ [packName, [themes…]] … ] for the available list, dynamic packs last
  function packEntries(list) {
    const out = [];
    for (const p of PACKS.order) {
      const names = (PACKS.packs[p] ?? []).filter((n) => list.includes(n));
      if (names.length) out.push([p, names]);
    }
    for (const extra of ['added', 'custom', 'generated']) {
      const names = list.filter((n) => packOf(n) === extra);
      if (names.length) out.push([extra, names]);
    }
    return out;
  }

  // ── theme generator (⌃T roll · ⌃⇧T save · picker "Generate new…") ─────
  const b64uEncode = (obj) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64uDecode = (s) =>
    JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));

  function adoptGenerated(cand, silent = false) {
    genTheme = { name: cand.name, tokens: cand.tokens };
    const el = ensureTokenStyle(cand.name, cand.tokens, 'generated');
    el.media = 'all';
    deactivateTokenStyles(el);
    if (!silent) toast(`✨ ${cand.name} — ⌃T re-roll · ⌃⇧T save`, 2800);
    updateCanvas();
    return cand.name;
  }
  function rollTheme() {
    return adoptGenerated(generateTheme());
  }
  function saveGeneratedTheme(inputName) {
    if (!genTheme || !genStyle || genStyle.media === 'not all') {
      toast('no generated theme to save — ⌃T to generate one');
      return null;
    }
    let name = inputName ?? (window.prompt?.('Save theme as:', genTheme.name.replace(/^gen-/, '')) || '');
    name = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!name) return null;
    const shipped = typeof __DECKLIGHT_THEMES__ !== 'undefined' ? __DECKLIGHT_THEMES__ : [];
    if (shipped.includes(name) || themeStyles.some((s) => s.dataset.theme === name)) name = 'custom-' + name;
    customThemes[name] = genTheme.tokens;
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customThemes)); } catch { /* private mode */ }
    const el = ensureTokenStyle(name, customThemes[name], 'custom');
    el.media = 'all';
    genStyle?.remove(); genStyle = null; genTheme = null;
    deactivateTokenStyles(el);
    if (!params.has('embedded')) {
      try { localStorage.setItem(themeKey, name); } catch { /* ignore */ }
    }
    // Portable artifact: saved themes live in THIS browser's localStorage;
    // the .css file is what travels (drop it into themes/ and commit).
    try {
      const blob = new Blob([tokensToCss(name, customThemes[name])], { type: 'text/css' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.css`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { /* download denied (headless etc.) — localStorage still has it */ }
    toast(`saved ${name} — ${name}.css downloaded`, 2200);
    return name;
  }
  // Crossing into a different pack while cycling needs a confirmation: the
  // same key again applies, the opposite key or Esc cancels, 4s times out.
  let cyclePending = null;
  function cancelCyclePending(silent = false) {
    if (!cyclePending) return false;
    clearTimeout(cyclePending.timer);
    cyclePending = null;
    if (!silent) toast('theme cycle cancelled');
    return true;
  }
  function cycleTheme(dir) {
    const list = themeList();
    if (!hasThemes || list.length < 2) return;
    if (cyclePending) {
      const p = cyclePending;
      clearTimeout(p.timer);
      cyclePending = null;
      if (p.dir === dir) applyTheme(p.name); // repeat = confirm
      else toast('theme cycle cancelled');   // opposite = cancel
      return;
    }
    const cur = currentTheme();
    const i = Math.max(0, list.indexOf(cur));
    const next = list[(i + dir + list.length) % list.length];
    if (PACKS && packOf(next) !== packOf(cur)) {
      const key = dir > 0 ? '.' : ',';
      const opp = dir > 0 ? ',' : '.';
      cyclePending = { dir, name: next, timer: setTimeout(() => { cyclePending = null; }, 4000) };
      toast(`⤳ ${packLabel(packOf(next))} pack next (${next}) — ${key} confirms · ${opp} or Esc cancels`, 4000);
      return;
    }
    applyTheme(next);
  }

  // Embedded preview decks accept theme swaps from their parent (the picker)
  // so the parent can restyle them without a document reload — in a bundled
  // single-file deck every reload re-parses the whole ~600 KB payload.
  if (params.has('embedded')) {
    window.addEventListener('message', (e) => {
      const m = e.data && e.data.__decklightPreview;
      if (!m || e.source !== window.parent) return;
      if (m.gen) adoptGenerated(m.gen, true);
      else if (m.theme) applyTheme(m.theme, true);
      else if (m.goto) deck().goto(m.goto[0], m.goto[1] ?? 0);
    });
  }

  /**
   * The query string that makes an embedded preview iframe look like THIS deck
   * does right now. Generated and saved-custom themes have no file, so they
   * travel as tokens (?gen=<base64url JSON>) — stateless, works on file://.
   * The slide finder previews with it too.
   */
  function previewQuery() {
    const name = currentTheme();
    const cand = customThemes[name] ? { name, tokens: customThemes[name] }
      : (genTheme && name === genTheme.name) ? genTheme : null;
    if (cand) return '?embedded&gen=' + b64uEncode(cand);
    return name ? '?embedded&theme=' + encodeURIComponent(name) : '?embedded';
  }

  /**
   * The theme this deck opens on. ?gen=<base64url {name, tokens}> applies a
   * generated theme statelessly — the picker's preview mechanism for themes
   * that have no file. Otherwise ?theme=/the saved choice as usual (saved may
   * name a custom theme, which applyTheme materializes from localStorage).
   */
  function restoreSaved() {
    const genParam = params.get('gen');
    if (genParam) {
      try {
        const cand = b64uDecode(genParam);
        if (cand && cand.tokens) {
          adoptGenerated({ name: cand.name || 'gen-preview', tokens: cand.tokens }, true);
          return;
        }
      } catch { /* malformed param — fall through to normal theme resolution */ }
    }
    let saved = null;
    try { saved = localStorage.getItem(themeKey); } catch { /* ignore */ }
    const requested = params.get('theme') || saved;
    if (requested) applyTheme(requested, true);
  }

  // ----- theme picker: list + live minified preview of the current slide ----
  // First row is "✨ Generate new…": selecting it rolls a candidate theme and
  // previews it live; ⌃T re-rolls; Enter/click applies it. Printable keys
  // type into the quick filter (which hides the gen row while active).
  const GEN_ROW = '\u0000generate';
  // pack navigation rows (control-char sentinels can't collide with theme
  // names). Views: 'packs' (pack list) · 'pack:<name>' (drilled in, ← goes
  // back) · 'all' (flattened) · 'browse' (marketplace themes, author
  // mode only). An active filter searches the installed themes globally,
  // except in 'browse', where it narrows the marketplace listing.
  const PACK_ROW = '\u0001pack:';
  const BACK_ROW = '\u0001back';
  const ALL_ROW = '\u0001all';
  const BROWSE_ROW = '\u0001browse';
  // A marketplace theme that is NOT installed yet. Its own sentinel because
  // it is the one row whose text is a qualified ref rather than a theme name,
  // and the one row there is nothing in this deck to preview for.
  const MKT_ROW = '\u0002';
  /** Any row that is not a theme this deck can already apply. */
  const nonTheme = (n) => n.charCodeAt(0) < 32;
  let pickerEl = null, pickerSel = 0, pickerDebounce, pickerEntries = [], pickerCandidate = null, pickerFilter = '';
  let pickerView = 'packs';
  const homeView = () => (PACKS ? 'packs' : 'all');

  // ── Browse: marketplace themes (MARKETPLACE.md THEME_BROWSE#UI) ──────────
  // The fourth affordance beside Generate, the packs and All. Author mode only,
  // and ABSENT rather than disabled: installing is a write to the deck on disk,
  // and a presented deck must never reach the network for a theme — that is the
  // invariant, so there is nothing here to grey out and explain.
  //
  // Listing is served from the author server's catalog CACHE. Offline, on a
  // plane, air-gapped: it lists what has been fetched and NAMES the
  // marketplaces it could not read, rather than looking empty. Only installing
  // touches the network, and it does it on the server side, through the same
  // `theme add` the command line runs.
  const authoring = () => editmode?.()?.available() === true;
  const authorBase = () => editmode?.()?.base() ?? '';
  const browseRow = () => (authoring() ? [BROWSE_ROW] : []);
  let browse = null; // { loading } · { themes, stale, cacheOnly } · { error }
  const browsed = (qualified) => (browse?.themes ?? []).find((t) => t.qualified === qualified);

  async function openBrowse() {
    browse = { loading: true, themes: [], stale: [] };
    setPickerView('browse');
    let next;
    try {
      const r = await fetch(authorBase() + '/edit/theme/browse');
      const j = await r.json().catch(() => ({}));
      next = r.ok && j.ok
        ? { themes: j.themes ?? [], stale: j.stale ?? [], cacheOnly: j.cacheOnly !== false }
        : { themes: [], stale: [], error: j.error || `the author server said ${r.status}` };
    } catch {
      // Fails instantly, no spinner to sit through: the author server is on
      // loopback, so not answering means it is gone, not that the link is slow.
      next = { themes: [], stale: [], error: 'the author server did not answer' };
    }
    if (!pickerEl || pickerView !== 'browse') return; // moved on while we read
    browse = next;
    setPickerView('browse');
  }

  async function installBrowsed(qualified) {
    const caption = pickerEl?.querySelector('.tp-caption');
    if (caption) caption.textContent = `installing ${qualified}…`;
    try {
      const r = await fetch(authorBase() + '/edit/theme/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: qualified }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // `theme add`'s own refusal, carried through with the contract problems
        // it listed. Same validator as the command line, so the same answer —
        // and the deck on disk is untouched.
        const why = [j.error, ...(j.problems ?? [])].filter(Boolean).join(' · ');
        if (caption) caption.textContent = why || `install failed (${r.status})`;
        toast(`${qualified}: ${j.error || 'install refused'}`, 3600);
        return;
      }
      closeThemePicker();
      // The install landed on DISK; the watcher's reload is what brings the
      // deck back with the <style data-theme-added> block in it. From then on
      // it is an Added theme like one from the command line — same cycling,
      // same ?theme=, same carriage through bundle.
      toast(`installed ${j.name}${j.replaced ? ' (replaced)' : ''} — Z takes it back`, 2800);
      debugLog('theme', `${qualified} installed from a marketplace`);
    } catch {
      if (caption) caption.textContent = 'the author server did not answer';
    }
  }
  function previewSrc(name) {
    const st = deck().state;
    const hash = '#/' + st.slide + '/' + st.step;
    if (name === GEN_ROW || customThemes[name] || (genTheme && name === genTheme.name)) {
      const cand = name === GEN_ROW ? pickerCandidate
        : customThemes[name] ? { name, tokens: customThemes[name] } : genTheme;
      return location.pathname + '?embedded&gen=' + b64uEncode(cand) + hash;
    }
    return location.pathname + '?embedded&theme=' + encodeURIComponent(name) + hash;
  }
  function genRowLabel(row) {
    row.textContent = pickerCandidate
      ? `✨ ${pickerCandidate.name} — ⌃T re-rolls` : '✨ Generate new…';
  }
  function rollPickerCandidate() {
    pickerCandidate = generateTheme();
    const gi = pickerEntries.indexOf(GEN_ROW);
    if (gi < 0) return; // gen row hidden by an active quick filter
    genRowLabel(pickerEl.querySelectorAll('.tp-row')[gi]);
    selectPickerRow(gi, true);
  }
  function renderPickerList() {
    const listBox = pickerEl.querySelector('.tp-list');
    const cur = currentTheme();
    const list = themeList();
    if (pickerView === 'browse') {
      // the filter narrows the MARKETPLACE listing here — the two lists are
      // disjoint, and nothing installed is in this one
      const items = (browse?.themes ?? [])
        .filter((t) => !pickerFilter || t.qualified.includes(pickerFilter));
      pickerEntries = [BACK_ROW, ...items.map((t) => MKT_ROW + t.qualified)];
    } else if (pickerFilter) {
      pickerEntries = list.filter((n) => n.includes(pickerFilter));
    } else if (!PACKS || pickerView === 'all') {
      pickerEntries = PACKS ? [GEN_ROW, BACK_ROW, ...list] : [GEN_ROW, ...list, ...browseRow()];
    } else if (pickerView === 'packs') {
      pickerEntries = [GEN_ROW, ...packEntries(list).map(([p]) => PACK_ROW + p), ALL_ROW, ...browseRow()];
    } else {
      const p = pickerView.slice(5);
      pickerEntries = [BACK_ROW, ...(packEntries(list).find(([q]) => q === p)?.[1] ?? [])];
    }
    listBox.textContent = '';
    const tag = (row, text) => {
      const t = document.createElement('span');
      t.className = 'tp-tag';
      t.textContent = text;
      row.appendChild(t);
    };
    pickerEntries.forEach((name, i) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      if (name === GEN_ROW) {
        row.className = 'tp-row tp-gen';
        genRowLabel(row);
      } else if (name === BACK_ROW) {
        row.className = 'tp-row tp-back';
        row.textContent = homeView() === 'packs' ? '← packs' : '← themes';
      } else if (name === BROWSE_ROW) {
        row.className = 'tp-row tp-browse';
        row.textContent = '⌕ Browse marketplaces…';
      } else if (name.startsWith(MKT_ROW)) {
        const t = browsed(name.slice(MKT_ROW.length));
        row.className = 'tp-row tp-mkt';
        row.textContent = t?.name ?? name.slice(MKT_ROW.length);
        const label = addedThemes.has(t?.name) ? 'installed' : t?.marketplace;
        if (label) tag(row, label);
      } else if (name === ALL_ROW) {
        row.className = 'tp-row tp-all';
        row.textContent = '✳ all themes';
        tag(row, String(list.length));
      } else if (name.startsWith(PACK_ROW)) {
        const p = name.slice(PACK_ROW.length);
        const names = packEntries(list).find(([q]) => q === p)?.[1] ?? [];
        row.className = 'tp-row tp-pack' + (names.includes(cur) ? ' tp-current' : '');
        row.textContent = `▸ ${packLabel(p)}`;
        tag(row, String(names.length));
      } else {
        row.className = 'tp-row' + (name === cur ? ' tp-current' : '');
        row.textContent = name;
        const extra = customThemes[name] ? 'custom'
          : (genTheme && name === genTheme.name) ? 'generated'
          : addedThemes.has(name) ? 'added'
          : pickerFilter && PACKS ? packLabel(packOf(name)) : null;
        if (extra) tag(row, extra);
      }
      row.addEventListener('mouseenter', () => selectPickerRow(i, false));
      row.addEventListener('click', () => { selectPickerRow(i, true); commitPicker(); });
      listBox.appendChild(row);
    });
    if (!pickerEntries.length) {
      const none = document.createElement('div');
      none.className = 'tp-none';
      none.textContent = 'no themes match';
      listBox.appendChild(none);
    }
    if (pickerView === 'browse') {
      // The honesty line. An empty Browse must never be indistinguishable from
      // a Browse that could not read a catalog.
      const note = document.createElement('div');
      note.className = 'tp-none';
      note.textContent = browse?.loading ? 'reading the catalogs…'
        : browse?.error ? browse.error
        : !pickerEntries.some((n) => n.startsWith(MKT_ROW))
          ? (pickerFilter ? 'no marketplace theme matches'
            : 'no themes in the marketplaces you have registered')
        : browse.stale?.length
          ? `from the cache · never fetched: ${browse.stale.join(', ')} — marketplace update`
          : 'from the cache — listing never goes to the network';
      listBox.appendChild(note);
    }
    const bar = pickerEl.querySelector('.tp-filter');
    bar.textContent = pickerFilter || 'type to filter…';
    bar.classList.toggle('tp-active', !!pickerFilter);
  }
  // the sensible selection for the current view: the active theme's row when
  // visible, its pack row in the packs view, else the first useful row
  function pickerHomeIndex() {
    const cur = currentTheme();
    const curIdx = pickerEntries.indexOf(cur);
    if (curIdx >= 0) return curIdx;
    const packIdx = pickerEntries.indexOf(PACK_ROW + packOf(cur));
    if (packIdx >= 0) return packIdx;
    return Math.min(1, pickerEntries.length - 1);
  }
  function setPickerView(view, immediate = false) {
    pickerView = view;
    renderPickerList();
    if (pickerEntries.length) selectPickerRow(pickerHomeIndex(), immediate);
  }
  function setPickerFilter(q) {
    pickerFilter = q.toLowerCase();
    renderPickerList();
    if (pickerEntries.length) {
      selectPickerRow(pickerFilter ? 0 : pickerHomeIndex(), false);
    } else {
      pickerEl.querySelector('.tp-caption').textContent = 'no match';
    }
  }
  function openThemePicker() {
    if (pickerEl) return closeThemePicker();
    overlays.closeOthers(overlay);
    const list = themeList();
    if (!hasThemes && !list.length) return;
    pickerFilter = '';
    pickerView = homeView();
    browse = null; // a fresh session re-reads the catalogs
    pickerEl = document.createElement('div');
    pickerEl.className = 'decklight-theme-picker';
    pickerEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter"></div>' +
        '<div class="tp-list" role="listbox" aria-label="Themes"></div></div>' +
        '<div class="tp-preview"><iframe title="Theme preview"></iframe>' +
        '<div class="tp-caption"></div></div></div>';
    renderPickerList();
    closeOnBackdrop(pickerEl, closeThemePicker);
    root.appendChild(pickerEl);
    // boot the preview on the CURRENT theme — pack rows never swap it, so the
    // pane must not open empty in the packs view
    const cur = currentTheme();
    if (cur) previewSwap(pickerEl.querySelector('iframe'), cur);
    selectPickerRow(pickerHomeIndex(), !cur);
  }
  function selectPickerRow(i, immediate) {
    if (!pickerEntries.length) return;
    pickerSel = (i + pickerEntries.length) % pickerEntries.length;
    const name = pickerEntries[pickerSel];
    if (name === GEN_ROW && !pickerCandidate) {
      // first visit to the generate row: roll a candidate so there is
      // something to preview (kept until explicitly re-rolled)
      pickerCandidate = generateTheme();
      genRowLabel(pickerEl.querySelectorAll('.tp-row')[pickerSel]);
    }
    selectInList(pickerEl.querySelectorAll('.tp-row'), pickerSel, 'tp-selected');
    const list = themeList();
    const caption = name === GEN_ROW ? (pickerCandidate ? `✨ ${pickerCandidate.name}` : 'generate new')
      : name === BACK_ROW ? (homeView() === 'packs' ? 'back to packs' : 'back to the theme list')
      : name === BROWSE_ROW ? 'themes from the marketplaces you have registered'
      : name.startsWith(MKT_ROW) ? browseCaption(name.slice(MKT_ROW.length))
      : name === ALL_ROW ? `all ${list.length} themes, flattened`
      : name.startsWith(PACK_ROW)
        ? `${packLabel(name.slice(PACK_ROW.length))} · ${packEntries(list).find(([q]) => q === name.slice(PACK_ROW.length))?.[1].length ?? 0} themes`
      : PACKS ? `${packLabel(packOf(name))} · ${name}` : name;
    pickerEl.querySelector('.tp-caption').textContent = caption;
    clearTimeout(pickerDebounce);
    // Navigation rows keep the current preview; only theme/gen rows swap it.
    // A marketplace row has nothing to preview either — the theme is not in
    // this deck yet, and previewing it would mean fetching it to look at.
    if (name !== GEN_ROW && nonTheme(name)) return;
    const frame = pickerEl.querySelector('iframe');
    if (immediate) previewSwap(frame, name);
    else pickerDebounce = setTimeout(() => previewSwap(frame, name), 60);
  }
  function browseCaption(qualified) {
    const t = browsed(qualified);
    if (!t) return qualified;
    return [t.qualified, t.description,
      addedThemes.has(t.name) ? 'installed — ⏎ re-installs it' : '⏎ installs it',
    ].filter(Boolean).join(' · ');
  }
  // Lazy preview: the embedded deck loads ONCE per picker session; theme
  // changes are postMessage'd into it (silent applyTheme/adoptGenerated on
  // the embedded instance) instead of swapping src — instant, and no ~600 KB
  // re-parse per candidate inside bundles. Generated/custom rows travel as
  // tokens; stock rows as names.
  let pickerFrameReady = false, pickerPendingName = null;
  function previewMessage(name) {
    if (name === GEN_ROW || customThemes[name] || (genTheme && name === genTheme.name)) {
      const cand = name === GEN_ROW ? pickerCandidate
        : customThemes[name] ? { name, tokens: customThemes[name] } : genTheme;
      return { gen: cand };
    }
    return { theme: name };
  }
  function previewSwap(frame, name) {
    if (!frame.dataset.booted) {
      frame.dataset.booted = '1';
      pickerFrameReady = false;
      frame.addEventListener('load', () => {
        pickerFrameReady = true;
        if (pickerPendingName !== null && pickerEl) {
          const pending = pickerPendingName;
          pickerPendingName = null;
          previewSwap(frame, pending);
        }
      }, { once: true });
      frame.src = previewSrc(name);
      return;
    }
    if (!pickerFrameReady) { pickerPendingName = name; return; }
    frame.contentWindow?.postMessage({ __decklightPreview: previewMessage(name) }, '*');
  }
  function commitPicker() {
    const name = pickerEntries[pickerSel];
    if (name === undefined) return;
    if (name === GEN_ROW) {
      if (pickerCandidate) adoptGenerated(pickerCandidate);
      closeThemePicker();
      return;
    }
    if (name === BACK_ROW) { setPickerView(homeView()); return; }
    if (name === ALL_ROW) { setPickerView('all'); return; }
    if (name === BROWSE_ROW) { openBrowse(); return; }
    if (name.startsWith(MKT_ROW)) { installBrowsed(name.slice(MKT_ROW.length)); return; }
    if (name.startsWith(PACK_ROW)) { setPickerView('pack:' + name.slice(PACK_ROW.length), true); return; }
    applyTheme(name);
    closeThemePicker();
  }
  function closeThemePicker() {
    clearTimeout(pickerDebounce);
    pickerEl?.remove();
    pickerEl = null;
  }

  const overlay = overlays.register({
    isOpen: () => !!pickerEl,
    close: closeThemePicker,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectPickerRow(pickerSel + 1, false); break;
        case 'ArrowUp': selectPickerRow(pickerSel - 1, false); break;
        case 'Enter': commitPicker(); break;
        case 'Backspace': setPickerFilter(pickerFilter.slice(0, -1)); break;
        case 'Escape':
          if (pickerFilter) setPickerFilter('');
          else if (pickerView !== homeView()) setPickerView(homeView());
          else closeThemePicker();
          break;
        default:
          // quick filter: printable keys type into it — which is why there
          // are no letter shortcuts in here (⌃T re-rolls, Esc closes)
          if (e.key.length === 1 && /[a-z0-9-]/i.test(e.key)) { setPickerFilter(pickerFilter + e.key); break; }
          return false;
      }
      return true;
    },
  });

  return {
    applyTheme,
    currentTheme,
    themeList,
    cycleTheme,
    cancelCyclePending,
    rollTheme,
    saveGeneratedTheme,
    adoptGenerated,
    updateCanvas,
    restoreSaved,
    previewQuery,
    openPicker: openThemePicker,
    closePicker: closeThemePicker,
    /**
     * The palette's contextual route to Browse. It opens the picker first
     * because Browse is a VIEW of the picker, not a dialog of its own — one
     * list, one set of keys, one place a theme is chosen.
     */
    browse() {
      if (!pickerEl) openThemePicker();
      if (pickerEl) openBrowse();
    },
    /** Is there an unsaved roll to save? (the palette hides the row otherwise) */
    hasGenerated: () => !!genTheme,
    /**
     * ⌃T while the picker sits on "✨ Generate new…" re-rolls the CANDIDATE
     * rather than adopting a new theme behind the open dialog.
     */
    rollFromPicker() {
      if (pickerEl && pickerEntries[pickerSel] === GEN_ROW) { rollPickerCandidate(); return true; }
      return false;
    },
  };
}
