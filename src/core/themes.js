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
import { createPreview } from './preview.js';
import { readPref, readJson, writePref, writeJson } from './prefs.js';

/**
 * Wire the theme system to a deck.
 *
 * `ctx` is the engine's shared furniture: `root` (the .decklight element),
 * `config`, `params` (the query string), `toast`, `debugLog`, `overlays` (the
 * keyboard registry) and `deck()` — a LATE accessor for the deck instance,
 * because themes are set up before the instance exists but only ever read it
 * from a click or a keystroke. `editmode()` is late for the same reason and
 * more so: edit mode is built after this and only ever consulted from the open
 * picker. It is what makes the marketplace listing authoring-only.
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
  // A theme from a marketplace is an ADDED theme, marked by
  // `data-theme-added`. A theme the deck marks (`addedThemes` in its config,
  // SPEC THEME_DISTRIBUTION) arrives as a <link data-theme-added> the server
  // put in; a bundle carries its copy as a <style data-theme-added> block; and
  // older decks carry one that `theme add` used to paste in. All three are held
  // apart from the deck's OWN themes deliberately: a link-mode deck that gained
  // one would otherwise flip to inline mode and its entire theme list would
  // collapse to that one added file. They behave like saved customs instead —
  // extra entries that apply by winning the cascade, in either mode.
  const themeStyles = [...document.querySelectorAll('style[data-theme]:not([data-theme-added])')];
  const addedStyles = [...document.querySelectorAll('style[data-theme][data-theme-added], link[data-theme][data-theme-added]')];
  const addedThemes = new Set(addedStyles.map((s) => s.dataset.theme).filter(Boolean));
  // The themes this deck MARKS — linked by the server because the deck's
  // config lists them. The one set the mark toggle reads.
  const marked = new Set(addedStyles.filter((el) => el.tagName === 'LINK').map((el) => el.dataset.theme));
  // Where each installed theme came from, read off the deck's own blocks —
  // never looked up. A bundled deck opened on another machine has no registry
  // to consult, so provenance either travelled in the file or is not available
  // at all (SPEC THEME_DISTRIBUTION).
  //
  // `pack` is the marketplace's kebab name, which is the identity; `label` is
  // the catalog's own title when it supplied one, and the kebab name when it
  // did not. Nothing is derived: guessing "Confluent" out of
  // "decklight-confluent" breaks for `acme-themes` and puts decklight in the
  // business of naming other people's catalogs.
  const themeSource = new Map();
  for (const st of addedStyles) {
    const mkt = st.dataset.themeMarketplace;
    if (st.dataset.theme && mkt) {
      themeSource.set(st.dataset.theme, { pack: `mkt:${mkt}`, label: st.dataset.themeSource || mkt });
    }
  }
  // While authoring: the themes every registered marketplace offers that this
  // page does not carry, by name → { name, marketplace, title, qualified,
  // description, remote }. Listed and applicable, never marked until asked.
  const offered = new Map();
  const inlineThemes = themeStyles.length > 0;
  const themeLink = inlineThemes ? null
    : document.querySelector('link[rel="stylesheet"][href*="themes/"]:not([data-theme-added])');
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
  customThemes = readJson(CUSTOM_KEY, {}) || {};
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
  for (const el of addedStyles) if (el.tagName === 'LINK') el.addEventListener('load', updateCanvas);

  /**
   * Link a marketplace theme this page does not carry yet — one the author is
   * looking at in the overlay, or a picker preview was told about. The same
   * element the server writes for a marked theme, at the same relative path,
   * so the server answers it from the marketplace on disk (never the network)
   * and everything downstream treats it as any other added theme. Marking is
   * a separate, deliberate act: this changes what is on screen, not the deck.
   */
  function adoptAdded({ name, marketplace, title = null }) {
    if (!/^[\w-]+$/.test(name ?? '') || !/^[\w-]+$/.test(marketplace ?? '')) return null;
    const had = addedStyles.find((el) => el.dataset.theme === name);
    if (had) return had;
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = `decklight-theme/${marketplace}/${name}.css`;
    el.media = 'not all';
    el.dataset.theme = name;
    el.dataset.themeAdded = '';
    el.dataset.themeMarketplace = marketplace;
    if (title) el.dataset.themeSource = title;
    el.addEventListener('load', updateCanvas);
    document.head.appendChild(el);
    addedStyles.push(el);
    addedThemes.add(name);
    themeSource.set(name, { pack: `mkt:${marketplace}`, label: title || marketplace });
    return el;
  }

  /**
   * Switch to `name`. True when it took, false for a name this deck cannot
   * show. `persist: false` applies without remembering — the deck's configured
   * default is where it opens, not a pick somebody made, and saving it would
   * freeze today's default in over tomorrow's.
   */
  function applyTheme(name, silent = false, { persist = true } = {}) {
    if (!name || !/^[\w-]+$/.test(name)) return false;
    let unsavedGen = false;
    if (genTheme && genStyle && name === genTheme.name) {
      genStyle.media = 'all';
      deactivateTokenStyles(genStyle);
      unsavedGen = !customThemes[name];
    } else if (customThemes[name]) {
      const el = ensureTokenStyle(name, customThemes[name], 'custom');
      el.media = 'all';
      deactivateTokenStyles(el);
    } else if (addedThemes.has(name) || offered.has(name)) {
      const o = offered.get(name);
      // An https-sourced entry has no bytes on this machine until it is
      // marked — marking is the explicit act that reads it.
      if (!addedThemes.has(name) && o.remote) return false;
      const el = addedStyles.find((s) => s.dataset.theme === name) ?? adoptAdded(o);
      el.media = 'all';
      deactivateTokenStyles(el);
    } else {
      if (!hasThemes) return false;
      if (inlineThemes && !themeStyles.some((s) => s.dataset.theme === name)) return false; // not embedded in this bundle
      deactivateTokenStyles(null); // stock theme takes over
      if (inlineThemes) {
        const target = themeStyles.find((s) => s.dataset.theme === name);
        themeStyles.forEach((s) => { s.media = s === target ? 'all' : 'not all'; });
      } else {
        themeLink.href = themeLink.href.replace(/themes\/[\w-]+\.css(\?.*)?$/, `themes/${name}.css`);
      }
    }
    // Embedded instances (e.g. picker preview iframes) must not persist, nor a
    // render (`?capture`), nor the configured default (above); nor can an
    // unsaved generated autoname (it wouldn't resolve after reload).
    if (persist && !params.has('embedded') && !params.has('capture') && !unsavedGen) {
      writePref(themeKey, name);
    }
    if (!silent) toast(name);
    debugLog('theme', name);
    updateCanvas(); // inline/generated swaps take effect synchronously
    return true;
  }
  // ── theme packs (SPEC PRESENTING) — baked from themes/packs.json at build time ────
  const PACKS = typeof __DECKLIGHT_PACKS__ !== 'undefined' ? __DECKLIGHT_PACKS__ : null;
  // the dynamic packs are not in packs.json — they exist only when a deck has
  // something in them, so they carry their labels here
  const DYNAMIC_LABELS = { added: 'Added', custom: 'Custom', generated: 'Generated' };
  // A marketplace pack's label comes from the deck (or, while authoring, from
  // the catalog), so it is looked up by pack id rather than living in a constant.
  const mktLabel = (p) => [...themeSource.values()].find((v) => v.pack === p)?.label;
  const packLabel = (p) => mktLabel(p) ?? PACKS?.labels?.[p] ?? DYNAMIC_LABELS[p] ?? p;
  function packOf(name) {
    if (customThemes[name]) return 'custom';
    if (genTheme && name === genTheme.name) return 'generated';
    // Provenance first: `Added` stops being the catch-all and becomes what it
    // was always meant to be — the fallback for a theme that came from a raw
    // URL, a local file, or a hand-authored block.
    if (themeSource.has(name)) return themeSource.get(name).pack;
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
    const extras = [...addedThemes, ...offered.keys(), ...Object.keys(customThemes)];
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
    // Marketplace packs are discovered from the deck rather than declared, so
    // they are listed before the fallbacks: a theme that knows where it came
    // from should not sit under a heading that means "we do not know".
    for (const pack of new Set([...themeSource.values()].map((v) => v.pack))) {
      const names = list.filter((n) => packOf(n) === pack);
      if (names.length) out.push([pack, names]);
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
    writeJson(CUSTOM_KEY, customThemes);
    const el = ensureTokenStyle(name, customThemes[name], 'custom');
    el.media = 'all';
    genStyle?.remove(); genStyle = null; genTheme = null;
    deactivateTokenStyles(el);
    if (!params.has('embedded')) {
      writePref(themeKey, name);
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
      else if (m.theme) {
        // a marketplace theme the preview's own page was not served with
        if (m.from && !addedThemes.has(m.theme)) adoptAdded({ name: m.theme, marketplace: m.from });
        applyTheme(m.theme, true);
      }
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
   * that have no file. Otherwise the first of these this deck can show:
   * `?theme=`, the saved choice (which may name a custom theme, materialized
   * from localStorage), then the deck's configured `theme` — and failing all
   * three, whatever the markup already selects (the first inline block).
   *
   * The configured theme used to be missing from this chain (#547): a deck
   * whose themes are inline blocks — every `upgrade --link` deck — is never
   * given a theme link, so `"theme": "confluent"` in its config block did
   * nothing and the deck opened on its first block. In link mode it is skipped
   * for a stock theme: the server already linked it, and the link is the
   * deck's own statement of the same thing.
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
    const requested = params.get('theme');
    // `from` names the marketplace of a theme this page was not served with —
    // what the picker's preview asks for while an author looks at one
    const from = params.get('from');
    if (requested && from && !addedThemes.has(requested)) adoptAdded({ name: requested, marketplace: from });
    if (requested && applyTheme(requested, true)) return;
    const saved = readPref(themeKey);
    if (saved && applyTheme(saved, true)) return;
    const configured = config.theme;
    if (configured && (inlineThemes || addedThemes.has(configured))) applyTheme(configured, true, { persist: false });
  }

  /**
   * A theme the deck marks that this machine cannot show — its marketplace
   * not registered, or never fetched. The server says which, in a meta tag,
   * instead of linking it; this says it to the person looking, once, with
   * what brings it. Not in a preview or a render: those have no one to tell.
   */
  function reportMissing() {
    if (params.has('embedded') || params.has('capture')) return;
    const missing = [...document.querySelectorAll('meta[name="decklight-theme-missing"]')].map((m) => m.content);
    if (!missing.length) return;
    toast(`${missing.length === 1 ? 'theme' : 'themes'} not on this machine: ${missing.join('; ')}`, 7000);
    for (const m of missing) debugLog('theme', `missing ${m}`);
  }

  // ----- theme picker: list + live minified preview of the current slide ----
  // First row is "✨ Generate new…": selecting it rolls a candidate theme and
  // previews it live; ⌃T re-rolls; Enter/click applies it. Printable keys
  // type into the quick filter (which hides the gen row while active).
  const GEN_ROW = '\u0000generate';
  // pack navigation rows (control-char sentinels can't collide with theme
  // names). Views: 'packs' (pack list) · 'pack:<name>' (drilled in, ← goes
  // back) · 'all' (flattened). An active filter searches every listed theme.
  const PACK_ROW = '\u0001pack:';
  const BACK_ROW = '\u0001back';
  const ALL_ROW = '\u0001all';
  /** Any row that is not a theme this deck can already apply. */
  const nonTheme = (n) => n.charCodeAt(0) < 32;
  let pickerEl = null, pickerSel = 0, pickerDebounce, pickerEntries = [], pickerCandidate = null, pickerFilter = '';
  let pickerView = 'packs';
  const homeView = () => (PACKS ? 'packs' : 'all');

  // ── marketplace themes, and marking (MARKETPLACE.md THEME_BROWSE#UI) ──
  // While AUTHORING, the overlay lists every theme of every registered
  // marketplace under that marketplace's heading — no separate Browse step.
  // Any of them can be previewed and applied: the author server answers its
  // CSS from the marketplace's files on this machine. A theme only travels
  // with the deck once it is MARKED (Space on its row): the deck's config
  // gains a reference, and `bundle` carries every marked theme.
  //
  // Presenting, none of this exists: a presented deck lists the themes it
  // marks and nothing else, so everyone who opens it sees the same list, and
  // it never reaches for a catalog — that is the invariant.
  //
  // Listing is served from the author server's catalog CACHE. Offline, on a
  // plane, air-gapped: it lists what has been fetched and NAMES the
  // marketplaces it could not read, rather than looking short.
  const authoring = () => editmode?.()?.available() === true;
  const authorBase = () => editmode?.()?.base() ?? '';
  let catalogs = null; // null · { loading } · { stale } · { error }
  const shipped = () => (typeof __DECKLIGHT_THEMES__ !== 'undefined' ? __DECKLIGHT_THEMES__ : []);

  async function loadOffered() {
    if (!authoring() || catalogs) return;
    catalogs = { loading: true };
    let next;
    try {
      const r = await fetch(authorBase() + '/edit/theme/browse');
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        for (const t of j.themes ?? []) {
          // One row per NAME: a name the deck already shows (shipped, its own,
          // a custom, or another marketplace's theme met first) is not offered
          // twice under two headings the picker could not tell apart.
          if (addedThemes.has(t.name) || offered.has(t.name) || customThemes[t.name]
            || shipped().includes(t.name) || themeStyles.some((st) => st.dataset.theme === t.name)) continue;
          offered.set(t.name, t);
          themeSource.set(t.name, { pack: `mkt:${t.marketplace}`, label: t.title || t.marketplace });
        }
        next = { stale: j.stale ?? [] };
      } else next = { error: j.error || `the author server said ${r.status}` };
    } catch {
      // Fails instantly, no spinner to sit through: the author server is on
      // loopback, so not answering means it is gone, not that the link is slow.
      next = { error: 'the author server did not answer' };
    }
    catalogs = next;
    if (pickerEl) setPickerView(pickerView);
  }

  /** `name@marketplace` for a theme row that came from a marketplace, else null. */
  function refOf(name) {
    const pack = themeSource.get(name)?.pack;
    return pack?.startsWith('mkt:') ? `${name}@${pack.slice(4)}` : null;
  }
  /**
   * Space on a marketplace theme's row: mark it for the deck, or unmark it.
   * The write is the author server's — one line in the config block, one undo
   * entry — and the watcher's reload brings the deck back with the list as
   * the file now says it is.
   */
  function toggleMark(name) {
    if (!authoring() || !refOf(name)) return false;
    markRequest(name);
    return true;
  }
  async function markRequest(name) {
    const ref = refOf(name);
    // A theme an older `theme add` pasted into the deck is carried in the
    // file itself; there is no reference to add or take away.
    if (addedThemes.has(name) && !marked.has(name) && !offered.has(name)) {
      toast(`${name} is carried inside the deck — decklight theme add ${ref} to mark it instead`, 4200);
      return;
    }
    const on = !marked.has(name);
    const caption = pickerEl?.querySelector('.tp-caption');
    if (caption) caption.textContent = `${on ? 'marking' : 'unmarking'} ${ref}…`;
    try {
      const r = await fetch(authorBase() + '/edit/theme/mark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref, marked: on }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const why = [j.error, ...(j.problems ?? [])].filter(Boolean).join(' · ');
        if (caption) caption.textContent = why || `the author server said ${r.status}`;
        toast(`${ref}: ${j.error || 'refused'}`, 3600);
        return;
      }
      toast(on ? `${name} marked — it travels with the deck · Z takes it back` : `${name} unmarked`, 2800);
      debugLog('theme', `${ref} ${on ? 'marked' : 'unmarked'}`);
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
    const o = !addedThemes.has(name) && offered.get(name);
    return location.pathname + '?embedded&theme=' + encodeURIComponent(name)
      + (o ? '&from=' + encodeURIComponent(o.marketplace) : '') + hash;
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
    if (pickerFilter) {
      pickerEntries = list.filter((n) => n.includes(pickerFilter));
    } else if (!PACKS || pickerView === 'all') {
      pickerEntries = PACKS ? [GEN_ROW, BACK_ROW, ...list] : [GEN_ROW, ...list];
    } else if (pickerView === 'packs') {
      pickerEntries = [GEN_ROW, ...packEntries(list).map(([p]) => PACK_ROW + p), ALL_ROW];
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
        // While authoring, a marketplace theme's tag says whether the deck
        // carries it: ● marked (it travels), ○ not (it is only on screen).
        const mark = authoring() && refOf(name) ? (marked.has(name) ? '● ' : '○ ') : '';
        if (mark) row.classList.add(marked.has(name) ? 'tp-marked' : 'tp-unmarked');
        const extra = customThemes[name] ? 'custom'
          : (genTheme && name === genTheme.name) ? 'generated'
          : themeSource.has(name) ? mark + themeSource.get(name).label
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
    // The honesty line, authoring only: a list short of a marketplace must
    // never look the same as a marketplace with nothing in it.
    const note = !authoring() || !catalogs ? null
      : catalogs.loading ? 'reading the marketplaces…'
      : catalogs.error ? catalogs.error
      : catalogs.stale?.length ? `not listed: ${catalogs.stale.join(', ')} — decklight marketplace update`
      : null;
    if (note && !pickerView.startsWith('pack:')) {
      const el = document.createElement('div');
      el.className = 'tp-none';
      el.textContent = note;
      listBox.appendChild(el);
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
    overlays.opening(overlay);
    const list = themeList();
    if (!hasThemes && !list.length) return;
    pickerFilter = '';
    pickerView = homeView();
    loadOffered(); // authoring: list what the marketplaces offer (once per page)
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
      : name === ALL_ROW ? `all ${list.length} themes, flattened`
      : name.startsWith(PACK_ROW)
        ? `${packLabel(name.slice(PACK_ROW.length))} · ${packEntries(list).find(([q]) => q === name.slice(PACK_ROW.length))?.[1].length ?? 0} themes`
      : authoring() && refOf(name) ? markCaption(name)
      : PACKS ? `${packLabel(packOf(name))} · ${name}` : name;
    const captionEl = pickerEl.querySelector('.tp-caption');
    captionEl.textContent = caption;
    // a reference and a sentence, not a theme name to title-case
    captionEl.classList.toggle('tp-plain', authoring() && !!refOf(name));
    clearTimeout(pickerDebounce);
    // Navigation rows keep the current preview; only theme/gen rows swap it.
    // So does a marketplace theme whose bytes are not on this machine yet.
    if (name !== GEN_ROW && nonTheme(name)) return;
    if (offered.get(name)?.remote) return;
    const frame = pickerEl.querySelector('iframe');
    if (immediate) previewSwap(frame, name);
    else pickerDebounce = setTimeout(() => previewSwap(frame, name), 60);
  }
  function markCaption(name) {
    const o = offered.get(name);
    return [refOf(name), o?.description,
      marked.has(name) ? 'marked — travels with the deck · Space unmarks'
        : o?.remote ? 'lives at a URL — Space marks it, which reads it once'
        : 'not marked — Space marks it so the deck carries it',
    ].filter(Boolean).join(' · ');
  }
  // Lazy preview: the embedded deck loads ONCE per picker session; theme
  // changes are postMessage'd into it (silent applyTheme/adoptGenerated on
  // the embedded instance) instead of swapping src — instant, and no ~600 KB
  // re-parse per candidate inside bundles. Generated/custom rows travel as
  // tokens; stock rows as names.
  function previewMessage(name) {
    if (name === GEN_ROW || customThemes[name] || (genTheme && name === genTheme.name)) {
      const cand = name === GEN_ROW ? pickerCandidate
        : customThemes[name] ? { name, tokens: customThemes[name] } : genTheme;
      return { gen: cand };
    }
    const o = !addedThemes.has(name) && offered.get(name);
    return o ? { theme: name, from: o.marketplace } : { theme: name };
  }
  // one document per picker session: the first row loads it, every row after
  // that is a message into it
  const preview = createPreview({
    docOf: () => 'picker',
    srcFor: previewSrc,
    messageFor: (name) => ({ __decklightPreview: previewMessage(name) }),
  });
  const previewSwap = (frame, name) => preview.show(frame, name);
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
    if (name.startsWith(PACK_ROW)) { setPickerView('pack:' + name.slice(PACK_ROW.length), true); return; }
    // the one row that cannot be shown until it is marked: its bytes live at a
    // URL, and marking is the explicit act that reads them
    if (!addedThemes.has(name) && offered.get(name)?.remote) {
      toast(`${name} is not on this machine yet — Space marks it, which reads it`, 3200);
      return;
    }
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
    transient: true,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectPickerRow(pickerSel + 1, false); break;
        case 'ArrowUp': selectPickerRow(pickerSel - 1, false); break;
        case 'Enter': commitPicker(); break;
        // Space marks: the filter types [a-z0-9-] only, so it is free, and a
        // letter here would be a letter the filter could not type
        case ' ': if (!toggleMark(pickerEntries[pickerSel])) return false; break;
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
    /**
     * The theme on screen, as an export should ask for it (#547): `{ theme }`
     * when a fresh load of this deck can show it — one of its own blocks, an
     * added one, a file — and `{ gen }` for one that lives only in this browser
     * (a saved custom theme, an unsaved roll): its tokens, in the `?gen=` form
     * the picker's previews already load, since a render on a clean profile
     * has no localStorage to find them in.
     */
    renderTheme() {
      const name = currentTheme();
      if (!name) return {};
      if (customThemes[name]) return { gen: b64uEncode({ name, tokens: customThemes[name] }) };
      if (genTheme && name === genTheme.name) return { gen: b64uEncode(genTheme) };
      return { theme: name };
    },
    themeList,
    cycleTheme,
    cancelCyclePending,
    rollTheme,
    saveGeneratedTheme,
    adoptGenerated,
    updateCanvas,
    restoreSaved,
    reportMissing,
    previewQuery,
    openPicker: openThemePicker,
    closePicker: closeThemePicker,
    /**
     * The palette's route to the marketplace themes. They are packs in the
     * picker like any other — one list, one set of keys, one place a theme is
     * chosen — so this opens it, on the packs view where their headings are.
     */
    browse() {
      if (!pickerEl) openThemePicker();
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
