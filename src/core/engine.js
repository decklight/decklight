// Engine — init, navigation, transitions, overview/blackout/help, hash,
// scaling, print. SPEC §2.2, §4.1, §8, §9.

import { scanSlide, applyBuildState, stepLabels, registerProvider, providerRegistry } from './builds.js';
import { namespaceSvgIds, applyConcepts } from './svg.js';
import { runAutoAnimate } from './autoanimate.js';
import { initMarkdown } from '../md/markdown.js';
import { initCode } from '../code/code.js';
import { openSpeakerView, notesSegments } from './speaker.js';
import { generateTheme, tokensToCss, luminance } from './themegen.js';

const DEFAULTS = {
  transition: 'fade',
  hash: true,
  controls: true,
  slideNumber: false,
  width: 1280,
  height: 720,
  pinTitles: false,
};

// Pinned-title default Y (design px from the stage top). Measured from the
// course's "The Single-Agent Limit" slide — the reference position chosen
// for the feature (SPEC §8).
const PIN_DEFAULT_Y = 99;
const PIN_GAP = 18; // breathing room between a pinned title and the content
const PIN_SUB_GAP = 6; // breathing room between a pinned title and its subtitle
const PINNABLE_CONTENT = 'ul, ol, svg, pre, table, .terminal, img, .columns';

let activeInstance = null;

export function registerBuildProvider(el, provider) {
  registerProvider(el, provider);
  // Post-init registration (async widgets, e.g. terminal casts): rescan the
  // owning slide and re-apply the current state.
  if (activeInstance) activeInstance._rescanFor(el);
}

/**
 * Pinned titles (SPEC §8): keep slide titles at one vertical position instead
 * of drifting with content height. The leading h1/h2 of each pinnable section
 * is absolutely positioned at --pin-y; --pin-space (pin Y + measured title
 * height + gap) becomes the section's padding-top so the remaining content
 * centers below the title and can never slide under it.
 *
 * Pinnable heuristic: a leading h1/h2 AND real content (list/svg/pre/table/
 * terminal/img/columns) outside the notes — title cards and quote/statement
 * slides stay centered. Per-slide overrides: data-pin (force), data-pin="none"
 * (opt out), data-pin="<number>" (custom Y).
 */
function leadingHeading(section) {
  for (const el of section.children) {
    if (el.matches('aside, script, style, .decklight-hero-logo')) continue;
    return el.matches('h1, h2') ? el : null;
  }
  return null;
}

/**
 * Subtitle (SPEC §1/§8): the <p> immediately following a section's leading
 * heading is the slide's subtitle — one canonical look whether the slide is
 * markdown- or HTML-authored, pinned or centered. Opt out per slide with
 * data-subtitle="none"; an author-placed class="subtitle" is respected as-is.
 */
function detectSubtitle(section, heading) {
  if (!heading || section.getAttribute('data-subtitle') === 'none') return null;
  const next = heading.nextElementSibling;
  if (next && next.matches('p') && !next.hasAttribute('data-build')) {
    next.classList.add('subtitle');
    return next;
  }
  return section.querySelector(':scope > p.subtitle');
}

function setupPinnedTitles(sections, config) {
  const deckY = config.pinTitles === true ? PIN_DEFAULT_Y
    : (typeof config.pinTitles === 'number' && isFinite(config.pinTitles)) ? config.pinTitles
    : null;
  sections.forEach((sec) => {
    const heading = leadingHeading(sec);
    const attr = sec.getAttribute('data-pin');
    let y = null;
    if (attr === 'none') {
      y = null;
    } else if (attr !== null && attr !== '') {
      const n = parseFloat(attr);
      y = isFinite(n) ? n : (deckY ?? PIN_DEFAULT_Y);
    } else if (attr === '') {
      y = deckY ?? PIN_DEFAULT_Y; // bare data-pin forces even when config is off
    } else if (deckY !== null) {
      const hasContent = [...sec.querySelectorAll(PINNABLE_CONTENT)]
        .some((el) => !el.closest('aside') && !el.closest('.decklight-hero-logo'));
      if (hasContent) y = deckY;
    }
    const subtitle = detectSubtitle(sec, heading);
    sec.querySelector(':scope > .pin-title')?.classList.remove('pin-title');
    sec.querySelector(':scope > .pin-subtitle')?.classList.remove('pin-subtitle');
    if (y === null || !heading) {
      sec.removeAttribute('data-pinned');
      sec.style.removeProperty('--pin-y');
      sec.style.removeProperty('--pin-sub-y');
      sec.style.removeProperty('--pin-space');
      return;
    }
    heading.classList.add('pin-title');
    sec.setAttribute('data-pinned', '');
    sec.style.setProperty('--pin-y', y + 'px');
    // Inactive sections are display:none — measure under a momentary
    // display:flex + visibility:hidden (no paint happens within this task).
    sec.classList.add('pin-measure');
    const h = heading.offsetHeight || 0;
    let headerBottom = y + h;
    if (subtitle) {
      // The subtitle joins the pinned header block, directly under the title.
      subtitle.classList.add('pin-subtitle');
      sec.style.setProperty('--pin-sub-y', Math.round(headerBottom + PIN_SUB_GAP) + 'px');
      headerBottom += PIN_SUB_GAP + (subtitle.offsetHeight || 0);
    }
    sec.classList.remove('pin-measure');
    sec.style.setProperty('--pin-space', Math.round(headerBottom + PIN_GAP) + 'px');
  });
}

/**
 * Authoring guardrail: content that exceeds the slide silently flex-shrinks
 * into an overflow:auto box and reads as clipped. Warn (console) and mark
 * (data-overflow attribute) so both humans and headless probes can catch it.
 */
function checkOverflow(section, slideNo) {
  if (!section) return;
  // Terminals scroll internally by design (SPEC §7.3 scrollback viewport);
  // any other intentional scroller can opt out with data-scroll-ok.
  const clipped = [section, ...section.querySelectorAll('pre, table, svg, ul, ol, blockquote')]
    .some((el) => el.scrollHeight > el.clientHeight + 2 &&
                  getComputedStyle(el).overflowY !== 'visible' &&
                  !el.closest('.terminal') && !el.hasAttribute('data-scroll-ok'));
  section.toggleAttribute('data-overflow', clipped);
  if (clipped) console.warn(`Decklight: slide ${slideNo} content overflows and is clipped — reduce content or font size`);
}

export function init(userConfig = {}) {
  const params = new URLSearchParams(location.search);
  const config = { ...DEFAULTS, ...userConfig };
  if (params.has('embedded')) config.controls = false;
  const printMode = params.has('print');

  // ----- debug log (D) -------------------------------------------------------
  // Ring buffer lives from init so events are captured even while the panel
  // is closed; D pops the window over the deck. Declared this early because
  // theme restoration logs during init, before the chrome exists.
  const debugT0 = Date.now();
  const debugBuf = [];
  let debugEl = null;
  function debugLog(kind, msg) {
    debugBuf.push({ t: ((Date.now() - debugT0) / 1000).toFixed(3), kind, msg });
    if (debugBuf.length > 200) debugBuf.shift();
    if (debugEl) {
      appendDebugRow(debugBuf[debugBuf.length - 1]);
      updateDebugState();
      const log = debugEl.querySelector('.dbg-log');
      log.scrollTop = log.scrollHeight;
    }
  }

  const root = document.querySelector('.decklight');
  if (!root) throw new Error('Decklight: no .decklight element found');

  // ----- playlist (multi-deck navigation) ------------------------------------
  // config.playlist = { modules: [{title, href}…], index: n }. Advancing past
  // the deck's end chains to the next module; reversing before the start goes
  // to the previous module's last slide (the oversized hash clamps there).
  // Embedded instances (previews) never chain.
  const playlist = (!params.has('embedded') && config.playlist?.modules?.length)
    ? config.playlist : null;
  const playlistIndex = playlist ? (playlist.index ?? 0) : 0;
  function gotoModule(delta) {
    if (!playlist) return false;
    const mod = playlist.modules[playlistIndex + delta];
    if (!mod) return false;
    location.href = mod.href + (delta > 0 ? '#/1/0' : '#/999/999');
    return true;
  }
  function navigateToModule(i) {
    const mod = playlist?.modules[i];
    if (mod) location.href = mod.href + '#/1/0';
  }

  // In-file module markers (merged single-file decks, SPEC §8): sections
  // carrying data-module mark chapter starts. When markers exist they take
  // precedence over config.playlist — module navigation becomes goto(), no
  // page loads.
  const hasMarkersDOM = !!root.querySelector('section[data-module]');
  function inFileMarkers() {
    const out = [];
    (instance._sections || []).forEach((s, i) => {
      if (s.hasAttribute('data-module')) out.push({ title: s.getAttribute('data-module'), slide: i + 1 });
    });
    return out;
  }
  function currentMarkerIndex(markers) {
    let idx = -1;
    markers.forEach((m, i) => { if (m.slide <= instance.state.slide) idx = i; });
    return idx;
  }

  // ----- theme switching -----------------------------------------------------
  // Two modes. Link mode: the theme is the stylesheet link pointing into
  // themes/, and applyTheme swaps its href. Inline mode (bundled single-file
  // decks): themes are embedded as <style data-theme="name"> blocks and
  // applyTheme toggles which one applies. Toggling uses media="not all" —
  // the HTML `disabled` attribute on <style> is non-functional per spec (only
  // the IDL property works), so media is the declarative mechanism; both
  // forms are normalized here for tolerant authoring.
  const themeStyles = [...document.querySelectorAll('style[data-theme]')];
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

  // ── generated & saved-custom themes (SPEC §8) ──────────────────────────
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
  function deactivateTokenStyles(exceptEl) {
    for (const el of [genStyle, ...Object.values(customStyles)]) {
      if (el && el !== exceptEl) el.media = 'not all';
    }
  }
  const activeTokenStyle = () =>
    [genStyle, ...Object.values(customStyles)].find((el) => el && el.media !== 'not all') || null;

  const currentTheme = () => {
    const tokenStyle = activeTokenStyle();
    if (tokenStyle) return tokenStyle.dataset.theme;
    return inlineThemes
      ? themeStyles.find((s) => s.media !== 'not all')?.dataset.theme
      : (themeLink ? themeOf(themeLink.href) : undefined);
  };
  let toastEl, toastTimer;
  function toast(msg, ms = 1200) {
    if (printMode) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'decklight-toast';
      root.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
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
    updateCanvas(); // hoisted; inline/generated swaps take effect synchronously
  }
  // ── theme packs (SPEC §8) — baked from themes/packs.json at build time ────
  const PACKS = typeof __DECKLIGHT_PACKS__ !== 'undefined' ? __DECKLIGHT_PACKS__ : null;
  const packLabel = (p) => PACKS?.labels?.[p] ?? p;
  function packOf(name) {
    if (customThemes[name]) return 'custom';
    if (genTheme && name === genTheme.name) return 'generated';
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
    const extras = Object.keys(customThemes);
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
    for (const extra of ['custom', 'generated']) {
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
      else if (m.goto) instance.goto(m.goto[0], m.goto[1] ?? 0);
    });
  }

  // ----- theme picker: list + live minified preview of the current slide ----
  // First row is "✨ Generate new…": selecting it rolls a candidate theme and
  // previews it live; ⌃T re-rolls; Enter/click applies it. Printable keys
  // type into the quick filter (which hides the gen row while active).
  // Generated and saved-custom themes have no file, so their previews carry
  // the tokens in the URL (?gen=<base64url JSON>) — stateless, works on file://.
  const GEN_ROW = '\u0000generate';
  // pack navigation rows (control-char sentinels can't collide with theme
  // names). Views: 'packs' (pack list) · 'pack:<name>' (drilled in, ← goes
  // back) · 'all' (flattened). An active filter always searches globally.
  const PACK_ROW = '\u0001pack:';
  const BACK_ROW = '\u0001back';
  const ALL_ROW = '\u0001all';
  let pickerEl = null, pickerSel = 0, pickerDebounce, pickerEntries = [], pickerCandidate = null, pickerFilter = '';
  let pickerView = 'packs';
  function previewSrc(name) {
    const st = instance.state;
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
        row.textContent = '← packs';
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
    const list = themeList();
    if (!hasThemes && !list.length) return;
    pickerFilter = '';
    pickerView = PACKS ? 'packs' : 'all';
    pickerEl = document.createElement('div');
    pickerEl.className = 'decklight-theme-picker';
    pickerEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter"></div>' +
        '<div class="tp-list" role="listbox" aria-label="Themes"></div></div>' +
        '<div class="tp-preview"><iframe title="Theme preview"></iframe>' +
        '<div class="tp-caption"></div></div></div>';
    renderPickerList();
    pickerEl.addEventListener('click', (e) => { if (e.target === pickerEl) closeThemePicker(); });
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
    const rows = pickerEl.querySelectorAll('.tp-row');
    rows.forEach((r, j) => r.classList.toggle('tp-selected', j === pickerSel));
    rows[pickerSel]?.scrollIntoView({ block: 'nearest' });
    const list = themeList();
    const caption = name === GEN_ROW ? (pickerCandidate ? `✨ ${pickerCandidate.name}` : 'generate new')
      : name === BACK_ROW ? 'back to packs'
      : name === ALL_ROW ? `all ${list.length} themes, flattened`
      : name.startsWith(PACK_ROW)
        ? `${packLabel(name.slice(PACK_ROW.length))} · ${packEntries(list).find(([q]) => q === name.slice(PACK_ROW.length))?.[1].length ?? 0} themes`
      : PACKS ? `${packLabel(packOf(name))} · ${name}` : name;
    pickerEl.querySelector('.tp-caption').textContent = caption;
    clearTimeout(pickerDebounce);
    // navigation rows keep the current preview; only theme/gen rows swap it
    if (name !== GEN_ROW && name.charCodeAt(0) === 1) return;
    const frame = pickerEl.querySelector('iframe');
    if (immediate) previewSwap(frame, name);
    else pickerDebounce = setTimeout(() => previewSwap(frame, name), 60);
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
    if (name === BACK_ROW) { setPickerView('packs'); return; }
    if (name === ALL_ROW) { setPickerView('all'); return; }
    if (name.startsWith(PACK_ROW)) { setPickerView('pack:' + name.slice(PACK_ROW.length), true); return; }
    applyTheme(name);
    closeThemePicker();
  }
  function closeThemePicker() {
    clearTimeout(pickerDebounce);
    pickerEl?.remove();
    pickerEl = null;
  }

  // ----- slide finder: / opens find-a-slide with live preview ---------------
  // Same panel anatomy and lazy-preview mechanism as the theme picker: the
  // embedded deck boots once, then selections postMessage a goto into it.
  // Matching is word-AND over the slide's text; title hits rank above
  // body-only hits, and each match is listed by its title.
  let finderEl = null, finderSel = 0, finderQuery = '', finderMatches = [], finderDebounce;
  let finderFrameReady = false, finderPending = null;
  function finderIndex() {
    return instance._sections.map((sec, i) => {
      const contentEls = [...sec.children].filter((el) => !el.matches('aside, script, style'));
      const heading = sec.querySelector('h1, h2, h3');
      const body = contentEls.map((el) => el.textContent).join(' ').replace(/\s+/g, ' ').trim();
      const title = (heading?.textContent || '').replace(/\s+/g, ' ').trim()
        || (body.slice(0, 60) || `slide ${i + 1}`);
      return { slide: i + 1, title, haystack: body.toLowerCase() };
    });
  }
  function renderFinderList() {
    const listBox = finderEl.querySelector('.tp-list');
    const words = finderQuery.split(/\s+/).filter(Boolean);
    const titleHits = [], bodyHits = [];
    for (const entry of finderEl.__index) {
      const tl = entry.title.toLowerCase();
      if (words.every((w) => tl.includes(w))) titleHits.push(entry);
      else if (words.every((w) => entry.haystack.includes(w))) bodyHits.push(entry);
    }
    finderMatches = [...titleHits, ...bodyHits];
    listBox.textContent = '';
    finderMatches.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'tp-row' + (m.slide === instance.state.slide ? ' tp-current' : '');
      row.textContent = `${m.slide} · ${m.title}`;
      row.addEventListener('mouseenter', () => selectFinderRow(i, false));
      row.addEventListener('click', () => { selectFinderRow(i, true); commitFinder(); });
      listBox.appendChild(row);
    });
    if (!finderMatches.length) {
      const none = document.createElement('div');
      none.className = 'tp-none';
      none.textContent = 'no slides match';
      listBox.appendChild(none);
    }
    const bar = finderEl.querySelector('.tp-filter');
    bar.textContent = finderQuery || 'type to find a slide…';
    bar.classList.toggle('tp-active', !!finderQuery);
  }
  function finderPreviewSwap(frame, slide) {
    if (!frame.dataset.booted) {
      frame.dataset.booted = '1';
      finderFrameReady = false;
      frame.addEventListener('load', () => {
        finderFrameReady = true;
        if (finderPending !== null && finderEl) {
          const p = finderPending;
          finderPending = null;
          finderPreviewSwap(frame, p);
        }
      }, { once: true });
      // faithful preview: carry the active theme (generated/custom travel as tokens)
      const name = currentTheme();
      const hash = '#/' + slide + '/0';
      const cand = customThemes[name] ? { name, tokens: customThemes[name] }
        : (genTheme && name === genTheme.name) ? genTheme : null;
      frame.src = location.pathname + (cand
        ? '?embedded&gen=' + b64uEncode(cand)
        : name ? '?embedded&theme=' + encodeURIComponent(name) : '?embedded') + hash;
      return;
    }
    if (!finderFrameReady) { finderPending = slide; return; }
    frame.contentWindow?.postMessage({ __decklightPreview: { goto: [slide, 0] } }, '*');
  }
  function selectFinderRow(i, immediate) {
    if (!finderMatches.length) return;
    finderSel = (i + finderMatches.length) % finderMatches.length;
    const rows = finderEl.querySelectorAll('.tp-row');
    rows.forEach((r, j) => r.classList.toggle('tp-selected', j === finderSel));
    rows[finderSel]?.scrollIntoView({ block: 'nearest' });
    const m = finderMatches[finderSel];
    finderEl.querySelector('.tp-caption').textContent = `slide ${m.slide} — ${m.title}`;
    clearTimeout(finderDebounce);
    const frame = finderEl.querySelector('iframe');
    if (immediate) finderPreviewSwap(frame, m.slide);
    else finderDebounce = setTimeout(() => finderPreviewSwap(frame, m.slide), 60);
  }
  function setFinderQuery(q) {
    finderQuery = q;
    renderFinderList();
    if (finderMatches.length) selectFinderRow(0, false);
    else finderEl.querySelector('.tp-caption').textContent = 'no match';
  }
  function commitFinder() {
    const m = finderMatches[finderSel];
    closeSlideFinder();
    if (m) instance.goto(m.slide, 0);
  }
  function openSlideFinder() {
    if (finderEl) return closeSlideFinder();
    if (pickerEl) closeThemePicker();
    finderQuery = '';
    finderEl = document.createElement('div');
    finderEl.className = 'decklight-theme-picker decklight-finder';
    finderEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter"></div>' +
        '<div class="tp-list" role="listbox" aria-label="Slides"></div></div>' +
        '<div class="tp-preview"><iframe title="Slide preview"></iframe>' +
        '<div class="tp-caption"></div></div></div>';
    finderEl.__index = finderIndex();
    renderFinderList();
    finderEl.addEventListener('click', (e) => { if (e.target === finderEl) closeSlideFinder(); });
    root.appendChild(finderEl);
    selectFinderRow(Math.max(0, finderMatches.findIndex((m) => m.slide === instance.state.slide)), true);
  }
  function closeSlideFinder() {
    clearTimeout(finderDebounce);
    finderEl?.remove();
    finderEl = null;
  }

  // ----- command palette (/) — SPEC §8 ---------------------------------------
  // A Claude-style palette: / lists every command with its shortcut, typing
  // filters, Enter runs. Commands with arguments drill into their own pickers
  // (theme, font, narration, module, slide finder). Text that matches no
  // command falls back to a "search slides for …" row.
  let palEl = null, palSel = 0, palQuery = '', palRows = [];
  function paletteCommands() {
    const has = (fn) => typeof fn === 'function';
    const all = [
      { label: 'Find slide…', hint: '/', alias: 'search', run: () => { openSlideFinder(); if (palQuery) setFinderQuery(palQuery); } },
      { label: 'Go to slide…', hint: '#', alias: 'goto', keepOpen: true, run: () => { palQuery = 'goto '; renderPalette(); } },
      { label: 'Theme…', hint: 'T', run: openThemePicker },
      { label: 'Cycle theme', hint: ', · .', run: () => cycleTheme(1) },
      { label: 'Generate a theme', hint: '⌃T', run: rollTheme },
      genTheme && { label: 'Save the generated theme…', hint: '⌃⇧T', run: () => saveGeneratedTheme() },
      { label: 'Font…', hint: '[ · ]', run: openFontPicker },
      { label: `Narration ${narrating ? 'off' : 'on'}`, hint: 'V', run: toggleNarration },
      { label: 'Narration track…', hint: 'N', alias: 'voice audio', run: () => openNarrPicker('tracks') },
      { label: 'Live voice…', alias: 'tts synthesize tone gemini', run: () => openNarrPicker('voices') },
      { label: 'Record offline narration…', hint: '⇧V', alias: 'export download batch wav tts', run: openRecordDialog },
      { label: 'Speaker view', hint: 'S', run: () => {
        const w = instance.__speakerWin;
        if (w && !w.closed) w.__decklightSpeakerToggle?.();
        else instance.__speakerWin = openSpeakerView(instance);
      } },
      { label: 'Overview', hint: 'O', run: toggleOverview },
      (playlist || hasMarkersDOM) && { label: 'Module…', hint: 'M', run: toggleModuleMenu },
      { label: 'Blackout', hint: 'B', run: toggleBlackout },
      { label: 'Debug log', hint: 'D', alias: 'console events state', run: toggleDebug },
      { label: 'Fullscreen', hint: 'F', run: () => document.documentElement.requestFullscreen?.() },
      { label: 'Print view (all slides, new tab)', hint: '', run: () => window.open(location.pathname + '?print') },
      { label: 'First slide', hint: 'Home', run: () => instance.goto(1, 0) },
      { label: 'Last slide', hint: 'End', run: () => instance.goto(instance.state.totalSlides, 0) },
      { label: 'Keyboard help', hint: '?', run: toggleHelp },
    ].filter(Boolean).filter((c) => has(c.run));
    return all;
  }
  function renderPalette() {
    const card = palEl.querySelector('.narr-card');
    card.textContent = '';
    const q = palQuery.toLowerCase();
    palRows = paletteCommands().filter((c) => !q || (c.label + ' ' + (c.alias ?? '')).toLowerCase().includes(q));
    // /goto with an inline argument: "goto 27" — or just "27" — jumps there
    const g = palQuery.trim().match(/^(?:goto\s*)?(\d+)$/i);
    if (g) {
      const n = Math.max(1, Math.min(parseInt(g[1], 10), instance.state.totalSlides));
      palRows.unshift({ label: `Go to slide ${n} / ${instance.state.totalSlides}`, hint: '⏎', run: () => instance.goto(n, 0) });
    }
    if (q && !g && !palRows.some((c) => c.label.toLowerCase().startsWith(q))) {
      // fallback: treat the text as a slide search
      palRows.push({ label: `Search slides for “${palQuery}”`, hint: '', run: () => { openSlideFinder(); setFinderQuery(palQuery); } });
    }
    const bar = document.createElement('div');
    bar.className = 'pal-input' + (palQuery ? ' tp-active' : '');
    bar.textContent = palQuery || 'type a command…';
    card.appendChild(bar);
    palRows.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'narr-row pal-row';
      const label = document.createElement('span');
      label.textContent = c.label;
      el.appendChild(label);
      if (c.hint) {
        const kbd = document.createElement('span');
        kbd.className = 'pal-kbd';
        kbd.textContent = c.hint;
        el.appendChild(kbd);
      }
      el.addEventListener('mouseenter', () => selectPalRow(i));
      el.addEventListener('click', () => { selectPalRow(i); commitPalRow(); });
      card.appendChild(el);
    });
    if (!palRows.length) {
      const none = document.createElement('div');
      none.className = 'tp-none';
      none.textContent = 'no matching command';
      card.appendChild(none);
    }
    selectPalRow(0);
  }
  function selectPalRow(i) {
    if (!palRows.length) return;
    palSel = (i + palRows.length) % palRows.length;
    palEl.querySelectorAll('.pal-row').forEach((r, j) => r.classList.toggle('narr-sel', j === palSel));
    palEl.querySelectorAll('.pal-row')[palSel]?.scrollIntoView({ block: 'nearest' });
  }
  function commitPalRow() {
    const cmd = palRows[palSel];
    if (!cmd) return;
    if (!cmd.keepOpen) closePalette();
    cmd.run();
  }
  function openPalette() {
    if (palEl) return closePalette();
    if (finderEl) closeSlideFinder();
    palQuery = '';
    palEl = document.createElement('div');
    palEl.className = 'decklight-narr decklight-palette';
    palEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Commands"></div>';
    palEl.addEventListener('click', (e) => { if (e.target === palEl) closePalette(); });
    root.appendChild(palEl);
    renderPalette();
  }
  function closePalette() {
    palEl?.remove();
    palEl = null;
  }

  // font picker (palette drill-in): the [ / ] stacks as a list
  let fontPickEl = null, fontPickSel = 0;
  function openFontPicker() {
    if (fontPickEl) return closeFontPicker();
    fontPickEl = document.createElement('div');
    fontPickEl.className = 'decklight-narr decklight-font-picker';
    fontPickEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Fonts"></div>';
    const card = fontPickEl.querySelector('.narr-card');
    FONTS.forEach(([name], i) => {
      const el = document.createElement('div');
      el.className = 'narr-row' + (i === fontIdx ? ' narr-cur' : '');
      el.textContent = name;
      if (i > 0) el.style.fontFamily = FONTS[i][1];
      el.addEventListener('mouseenter', () => selectFontRow(i));
      el.addEventListener('click', () => { applyFont(i); closeFontPicker(); });
      card.appendChild(el);
    });
    fontPickEl.addEventListener('click', (e) => { if (e.target === fontPickEl) closeFontPicker(); });
    root.appendChild(fontPickEl);
    selectFontRow(fontIdx);
  }
  function selectFontRow(i) {
    fontPickSel = (i + FONTS.length) % FONTS.length;
    fontPickEl.querySelectorAll('.narr-row').forEach((r, j) => r.classList.toggle('narr-sel', j === fontPickSel));
    fontPickEl.querySelectorAll('.narr-row')[fontPickSel]?.scrollIntoView({ block: 'nearest' });
  }
  function closeFontPicker() {
    fontPickEl?.remove();
    fontPickEl = null;
  }
  {
    // ?gen=<base64url {name, tokens}> applies a generated theme statelessly —
    // the picker's preview mechanism for themes that have no file. Otherwise
    // ?theme=/saved choice as usual (saved may name a custom theme, which
    // applyTheme materializes from localStorage).
    const genParam = params.get('gen');
    let adopted = false;
    if (genParam) {
      try {
        const cand = b64uDecode(genParam);
        if (cand && cand.tokens) { adoptGenerated({ name: cand.name || 'gen-preview', tokens: cand.tokens }, true); adopted = true; }
      } catch { /* malformed param — fall through to normal theme resolution */ }
    }
    if (!adopted) {
      let saved = null;
      try { saved = localStorage.getItem(themeKey); } catch { /* ignore */ }
      const requested = params.get('theme') || saved;
      if (requested) applyTheme(requested, true);
    }
  }

  // ----- font cycling ([ / ]) — SPEC §8 -------------------------------------
  // Curated system stacks (offline-safe, same rule as theme fonts §5), applied
  // as inline custom properties on the root so they override any theme — link,
  // inline, or generated — and survive theme switching. Entry 0 restores the
  // theme's own type. The choice persists per deck path.
  const FONTS = [
    ['theme default', null],
    ['system sans', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"],
    ['rounded', "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, 'Arial Rounded MT Bold', Calibri, sans-serif"],
    ['humanist', "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif"],
    ['geometric', "'Avenir Next', Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif"],
    ['classical serif', "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif"],
    ['transitional serif', "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif"],
    ['slab serif', "Rockwell, 'Rockwell Nova', 'Roboto Slab', 'DejaVu Serif', 'Sitka Small', serif"],
    ['monospace', "'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"],
  ];
  const fontKey = 'decklight-font:' + location.pathname;
  let fontIdx = 0;
  function applyFont(i, { silent = false, remeasure = true } = {}) {
    fontIdx = ((i % FONTS.length) + FONTS.length) % FONTS.length;
    const [name, stack] = FONTS[fontIdx];
    if (stack) {
      root.style.setProperty('--font-body', stack);
      root.style.setProperty('--font-heading', stack);
    } else {
      root.style.removeProperty('--font-body');
      root.style.removeProperty('--font-heading');
    }
    if (!params.has('embedded')) {
      try {
        if (stack) localStorage.setItem(fontKey, String(fontIdx));
        else localStorage.removeItem(fontKey);
      } catch { /* private mode */ }
    }
    if (remeasure) {
      // type metrics changed: pinned titles and the overflow guardrail
      // re-derive from real measurements
      setupPinnedTitles(instance._sections, config);
      checkOverflow(instance._sections[instance.state.slide - 1], instance.state.slide);
    }
    if (!silent) toast(`font: ${name}`);
    debugLog('font', name);
  }
  function cycleFont(dir) { applyFont(fontIdx + dir); }
  try {
    // restore BEFORE the first sync so pinned titles measure the real font
    // (remeasure would touch the not-yet-created instance)
    const savedFont = parseInt(localStorage.getItem(fontKey), 10);
    if (savedFont > 0 && savedFont < FONTS.length) applyFont(savedFont, { silent: true, remeasure: false });
  } catch { /* ignore */ }

  // ----- brand logo (SPEC §8) ------------------------------------------------
  // config.logo = { onLight, onDark, src?, height?, position? }: a mark shown
  // as chrome on every slide. onLight/onDark are the variants for light/dark
  // canvases — the engine reads the applied theme's real background luminance
  // and sets data-canvas on the root, so the right variant follows every
  // theme switch, generated themes included. Refs: '#id' clones an inline
  // element (bundle- and file://-safe), '<svg…' is raw markup, anything else
  // is an <img> URL.
  function logoNode(ref) {
    if (!ref) return null;
    if (ref.startsWith('#')) {
      const src = document.querySelector(ref);
      if (!src) return null;
      const clone = src.cloneNode(true);
      clone.removeAttribute('id');
      clone.style.removeProperty('display');
      return clone;
    }
    if (ref.trim().startsWith('<')) {
      const tpl = document.createElement('div');
      tpl.innerHTML = ref;
      return tpl.firstElementChild;
    }
    const img = document.createElement('img');
    img.src = ref;
    img.alt = '';
    return img;
  }
  let logoEl = null; // built after stage setup — root children move into the stage
  // canvas polarity: luminance of the painted background (first gradient stop
  // for gradient canvases — computed styles serialize colors to rgb())
  function updateCanvas() {
    const cs = getComputedStyle(root);
    const rgb = (s) => s?.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+))?\)/);
    let m = rgb(cs.backgroundColor);
    if (!m || (m[4] !== undefined && +m[4] === 0)) m = rgb(cs.backgroundImage);
    const dark = m ? luminance([+m[1], +m[2], +m[3]]) < 0.5 : false;
    root.setAttribute('data-canvas', dark ? 'dark' : 'light');
  }
  updateCanvas();
  // link-mode theme swaps load a stylesheet asynchronously — re-read then
  themeLink?.addEventListener('load', updateCanvas);

  // ----- stage & structure -------------------------------------------------
  let stage = root.querySelector(':scope > .decklight-stage');
  if (!stage) {
    stage = document.createElement('div');
    stage.className = 'decklight-stage';
    while (root.firstChild) stage.appendChild(root.firstChild);
    root.appendChild(stage);
  }
  stage.style.width = config.width + 'px';
  stage.style.height = config.height + 'px';

  // brand logo: chrome on the root (unscaled), so it must attach AFTER the
  // stage swallowed the deck's original children
  if (config.logo && (config.logo.src || config.logo.onLight || config.logo.onDark)) {
    logoEl = document.createElement('div');
    logoEl.className = 'decklight-logo';
    logoEl.setAttribute('data-pos', config.logo.position || 'bottom-left');
    if (config.logo.height) logoEl.style.setProperty('--logo-h', config.logo.height + 'px');
    for (const [key, cls] of [['src', 'on-any'], ['onLight', 'on-light'], ['onDark', 'on-dark']]) {
      const node = logoNode(config.logo[key]);
      if (!node) continue;
      const wrap = document.createElement('span');
      wrap.className = cls;
      wrap.appendChild(node);
      logoEl.appendChild(wrap);
    }
    root.appendChild(logoEl);
  }

  // hero logo: data-logo on a section prepends a larger in-flow copy of the
  // mark above the slide's content (module openers, cover slides). Optional
  // value = height in design px (default 96). Same on-light/on-dark variants,
  // toggled by the root's data-canvas like the corner chrome.
  function setupHeroLogos(sections) {
    if (!logoEl) return;
    sections.forEach((sec) => {
      if (!sec.hasAttribute('data-logo') || sec.querySelector(':scope > .decklight-hero-logo')) return;
      const hero = document.createElement('div');
      hero.className = 'decklight-hero-logo';
      const h = parseFloat(sec.getAttribute('data-logo'));
      if (h) hero.style.setProperty('--hero-logo-h', h + 'px');
      hero.innerHTML = logoEl.innerHTML;
      sec.prepend(hero);
    });
  }

  // ----- content pipeline --------------------------------------------------
  initMarkdown(stage);
  namespaceSvgIds(stage);
  initCode(stage, registerBuildProvider);

  const instance = {
    root, stage, config,
    _sections: [],
    _records: [],
    state: { slide: 1, step: 0, totalSlides: 0 },
    _listeners: new Map(),
    _scale: 1,

    on(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
      return this;
    },
    _emit(type, detail) {
      (this._listeners.get(type) || []).forEach((fn) => fn(detail));
      root.dispatchEvent(new CustomEvent('decklight:' + type, { detail }));
    },

    sync() {
      this._sections = [...stage.querySelectorAll(':scope > section')];
      this._sections.forEach((s, i) => s.setAttribute('data-slide-index', String(i + 1)));
      applyConcepts(stage, config.concepts); // idempotent; covers dynamic slides
      setupHeroLogos(this._sections);        // idempotent; before pin measurement
      setupPinnedTitles(this._sections, config);
      this._records = this._sections.map((s) => scanSlide(s));
      this.state.totalSlides = this._sections.length;
      this.state.slide = Math.min(this.state.slide, this.state.totalSlides || 1);
      const rec = this._records[this.state.slide - 1];
      if (rec) this.state.step = Math.min(this.state.step, rec.groups.length);
    },

    _rescanFor(el) {
      const section = el.closest('section');
      const idx = this._sections.indexOf(section);
      if (idx === -1) return;
      this._records[idx] = scanSlide(section);
      if (printMode) { applyBuildState(this._records[idx], this._records[idx].groups.length); return; }
      if (idx === this.state.slide - 1) {
        // a late-registering provider grew this slide's step count: honor the
        // originally requested (deep-linked) step, then retire the request
        this.state.step = Math.min(this._requestedStep ?? this.state.step, this._records[idx].groups.length);
        this._requestedStep = null;
        withoutAnim(() => applyBuildState(this._records[idx], this.state.step));
        this._updateHash(false);
      } else {
        withoutAnim(() => applyBuildState(this._records[idx], 0));
      }
      this._notify();
    },

    _stepLabels(idx) {
      const rec = this._records[idx];
      return rec ? stepLabels(rec) : [];
    },

    next() {
      const rec = this._records[this.state.slide - 1];
      if (rec && this.state.step < rec.groups.length) {
        this.goto(this.state.slide, this.state.step + 1, { direction: 'fwd' });
      } else if (this.state.slide < this.state.totalSlides) {
        this.goto(this.state.slide + 1, 0, { direction: 'fwd' });
      } else {
        gotoModule(1); // playlist chaining; no-op on the last module
      }
    },
    prev() {
      if (this.state.step > 0) {
        this.goto(this.state.slide, this.state.step - 1, { direction: 'back' });
      } else if (this.state.slide > 1) {
        const prevRec = this._records[this.state.slide - 2];
        this.goto(this.state.slide - 1, prevRec.groups.length, { direction: 'back' });
      } else {
        gotoModule(-1); // playlist chaining; no-op on the first module
      }
    },

    goto(slide, step = 0, opts = {}) {
      slide = Math.max(1, Math.min(slide, this.state.totalSlides));
      const rec = this._records[slide - 1];
      // Remember the PRE-clamp request: build providers (terminal casts)
      // register asynchronously after init, and a deep-linked step on their
      // slide would otherwise be clamped to 0 before they exist and lost.
      // _rescanFor re-clamps from this once the provider lands.
      this._requestedStep = step;
      step = Math.max(0, Math.min(step, rec ? rec.groups.length : 0));
      const sameSlide = slide === this.state.slide;
      if (sameSlide && step === this.state.step && !opts.force) return;

      const direction = opts.direction || (slide > this.state.slide ||
        (sameSlide && step > this.state.step) ? 'fwd' : 'back');

      if (!sameSlide || opts.force) {
        this._activateSlide(slide, direction, opts);
        this.state.slide = slide;
        this.state.step = step;
        withoutAnim(() => applyBuildState(rec, step));
        this._emit('slide', { slide, total: this.state.totalSlides, direction });
        requestAnimationFrame(() => checkOverflow(this._sections[slide - 1], slide));
      } else {
        this.state.step = step;
        applyBuildState(rec, step);
        this._emit('build', { slide, index: step, total: rec.groups.length, direction });
      }
      this._updateChrome();
      this._updateHash(!sameSlide);
      this._notify();
    },

    _activateSlide(slide, direction, opts = {}) {
      const from = this._sections[this.state.slide - 1];
      const to = this._sections[slide - 1];
      // hero-logo slides carry their own large mark — hide the corner chrome
      root.classList.toggle('has-hero-logo', to?.hasAttribute('data-logo') ?? false);
      if (from === to) { to.classList.add('active'); return; }
      const initial = !from || !from.classList.contains('active');

      const autoAnim = from && to && !initial &&
        from.hasAttribute('data-auto-animate') && to.hasAttribute('data-auto-animate') &&
        Math.abs(this._sections.indexOf(to) - this._sections.indexOf(from)) === 1;

      this._sections.forEach((s) => s.classList.remove(
        'active', 'entering', 'leaving', 'dir-fwd', 'dir-back',
        'tr-none', 'tr-fade', 'tr-slide', 'tr-scale', 'tr-flip'));
      to.classList.add('active');

      if (initial || printMode) return;

      if (autoAnim) {
        // runAutoAnimate's contract: BOTH sections laid out while it measures.
        // The class sweep above display:none'd the outgoing slide, which made
        // every "from" rect 0×0 — the FLIP started from a singular scale(0)
        // matrix (no visible move, degenerate interpolation). Keep `from`
        // laid out but unpainted for the synchronous measurement, and measure
        // the destination before it paints.
        from.classList.add('leaving');
        from.style.visibility = 'hidden';
        to.style.visibility = 'hidden';
        void to.offsetWidth;
        to.style.visibility = '';
        runAutoAnimate(from, to, this._scale);
        from.classList.remove('leaving');
        from.style.visibility = '';
        return;
      }

      const name = to.getAttribute('data-transition') || this.config.transition;
      if (name === 'none') return;
      const dir = 'dir-' + direction;
      to.classList.add('entering', 'tr-' + name, dir);
      from.classList.add('leaving', 'tr-' + name, dir, 'active-out');
      const ms = parseFloat(getComputedStyle(to).getPropertyValue('--transition-duration')) * 1000 || 350;
      setTimeout(() => {
        from.classList.remove('leaving', 'tr-' + name, dir, 'active-out');
        to.classList.remove('entering', 'tr-' + name, dir);
      }, ms + 60);
    },

    _updateChrome() {
      if (progressBar) {
        const rec = this._records[this.state.slide - 1];
        const stepsTotal = rec ? rec.groups.length : 0;
        const frac = this.state.totalSlides <= 1 ? 1 :
          ((this.state.slide - 1) + (stepsTotal ? this.state.step / (stepsTotal + 1) : 0)) /
          (this.state.totalSlides - 1);
        progressBar.style.width = (Math.min(frac, 1) * 100).toFixed(2) + '%';
      }
      if (slideNumEl) {
        const num = !this.config.slideNumber ? ''
          : this.config.slideNumber === 'n/N'
            ? `${this.state.slide} / ${this.state.totalSlides}` : String(this.state.slide);
        slideNumEl.textContent = num;
        if (hasMarkersDOM || playlist) {
          const markers = hasMarkersDOM ? inFileMarkers() : null;
          const title = markers
            ? (markers[currentMarkerIndex(markers)]?.title || '')
            : (playlist.modules[playlistIndex]?.title || '');
          const mod = document.createElement('span');
          mod.className = 'mod';
          mod.textContent = title;
          slideNumEl.prepend(mod);
        }
      }
    },

    _updateHash(pushSlide) {
      if (!this.config.hash || printMode) return;
      const h = `#/${this.state.slide}/${this.state.step}`;
      if (('#' + hashOf(location.hash)) === h) return;
      suppressHashChange = true;
      if (pushSlide) history.pushState(null, '', h);
      else history.replaceState(null, '', h);
      setTimeout(() => { suppressHashChange = false; });
    },

    _notify() {
      if (this.__notifySpeaker) this.__notifySpeaker();
    },
  };

  // ----- helpers -----------------------------------------------------------
  function withoutAnim(fn) {
    root.classList.add('decklight-no-anim');
    fn();
    void root.offsetWidth;
    root.classList.remove('decklight-no-anim');
  }

  function hashOf(h) {
    return (h || '').replace(/^#/, '');
  }

  function parseHash() {
    const m = hashOf(location.hash).match(/^\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    return { slide: parseInt(m[1], 10), step: m[2] ? parseInt(m[2], 10) : 0 };
  }

  // ----- chrome ------------------------------------------------------------
  let progressBar = null;
  let slideNumEl = null;
  if (config.controls && !printMode) {
    const controls = document.createElement('div');
    controls.className = 'decklight-controls';
    controls.innerHTML = `
      <button class="decklight-arrow prev" aria-label="Previous">‹</button>
      <button class="decklight-arrow next" aria-label="Next">›</button>`;
    root.appendChild(controls);
    controls.querySelector('.prev').addEventListener('click', () => instance.prev());
    controls.querySelector('.next').addEventListener('click', () => instance.next());
    const progress = document.createElement('div');
    progress.className = 'decklight-progress';
    progress.innerHTML = '<div class="bar"></div>';
    root.appendChild(progress);
    progressBar = progress.querySelector('.bar');
  }
  if ((config.slideNumber || playlist || hasMarkersDOM) && !printMode) {
    slideNumEl = document.createElement('div');
    slideNumEl.className = 'decklight-slide-number';
    if (playlist || hasMarkersDOM) {
      slideNumEl.title = 'M — module menu';
      slideNumEl.style.cursor = 'pointer';
      slideNumEl.addEventListener('click', () => toggleModuleMenu());
    }
    root.appendChild(slideNumEl);
  }

  // ----- overview / blackout / help ---------------------------------------
  let overviewEl = null, ovSel = 0;
  function ovColumns() {
    return getComputedStyle(overviewEl).gridTemplateColumns.split(' ').length || 1;
  }
  function ovSelect(i) {
    const cells = overviewEl.querySelectorAll('.ov-cell');
    ovSel = Math.max(0, Math.min(i, cells.length - 1));
    cells.forEach((c, j) => c.classList.toggle('ov-selected', j === ovSel));
    cells[ovSel]?.scrollIntoView({ block: 'nearest' });
  }
  function ovCommit() {
    const target = ovSel + 1;
    toggleOverview();
    instance.goto(target, 0, { force: true });
  }
  function layoutOverview() {
    // Minify each design-resolution frame to fit its grid cell. Rows are set
    // here from the resolved column width (16:9): CSS-only intrinsic sizing
    // (aspect-ratio, %-padding) contributes nothing to auto rows and collapses.
    if (!overviewEl) return;
    const cell = overviewEl.querySelector('.ov-cell');
    if (!cell) return;
    overviewEl.style.gridAutoRows = Math.round(cell.clientWidth * config.height / config.width) + 'px';
    const scale = cell.clientWidth / config.width;
    overviewEl.querySelectorAll('.ov-frame').forEach((f) => {
      f.style.transform = `scale(${scale})`;
    });
  }
  function toggleOverview() {
    if (overviewEl) {
      window.removeEventListener('resize', layoutOverview);
      overviewEl.remove(); overviewEl = null;
      root.classList.remove('decklight-overview');
      return;
    }
    overviewEl = document.createElement('div');
    overviewEl.className = 'decklight-overview-grid';
    instance._sections.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'ov-cell' + (i === instance.state.slide - 1 ? ' ov-current' : '');
      const frame = document.createElement('div');
      frame.className = 'ov-frame';
      frame.style.width = config.width + 'px';
      frame.style.height = config.height + 'px';
      const clone = s.cloneNode(true);
      clone.classList.add('active', 'ov-clone');
      clone.querySelectorAll('aside.notes, aside.rehearse').forEach((a) => a.remove());
      // Cloned radios share the original's group (same name, same document):
      // inserting a checked clone UNCHECKS the live slide's input. Detach
      // and inert them — the overview is a picture, not a form.
      clone.querySelectorAll('input, button, select, textarea').forEach((inp) => {
        inp.removeAttribute('name');
        inp.disabled = true;
      });
      frame.appendChild(clone);
      cell.appendChild(frame);
      const num = document.createElement('span');
      num.className = 'ov-num';
      num.textContent = String(i + 1);
      cell.appendChild(num);
      cell.addEventListener('click', () => { toggleOverview(); instance.goto(i + 1, 0, { force: true }); });
      overviewEl.appendChild(cell);
    });
    root.classList.add('decklight-overview');
    root.appendChild(overviewEl);
    layoutOverview();
    ovSelect(instance.state.slide - 1);
    window.addEventListener('resize', layoutOverview);
  }

  // ----- module menu (playlist or in-file markers) ---------------------------
  let moduleMenuEl = null, mmSel = 0, mmMode = null;
  function mmSelect(i) {
    const rows = moduleMenuEl.querySelectorAll('.mm-row');
    mmSel = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach((r, j) => r.classList.toggle('mm-selected', j === mmSel));
    rows[mmSel]?.scrollIntoView({ block: 'nearest' });
  }
  function mmCommit(i) {
    if (mmMode.useMarkers) {
      const target = mmMode.markers[i];
      toggleModuleMenu();
      if (target) instance.goto(target.slide, 0, { force: true });
    } else if (i === playlistIndex) {
      toggleModuleMenu();
    } else {
      navigateToModule(i);
    }
  }
  function toggleModuleMenu() {
    if (moduleMenuEl) { moduleMenuEl.remove(); moduleMenuEl = null; mmMode = null; return; }
    const markers = inFileMarkers();
    const useMarkers = markers.length > 0; // in-file mode wins over playlist
    if (!useMarkers && !playlist) return;
    mmMode = { useMarkers, markers };
    const entries = useMarkers ? markers : playlist.modules;
    const curIdx = useMarkers ? Math.max(0, currentMarkerIndex(markers)) : playlistIndex;
    moduleMenuEl = document.createElement('div');
    moduleMenuEl.className = 'decklight-module-menu';
    moduleMenuEl.innerHTML =
      '<div class="mm-panel"><div class="mm-title">Modules</div>' +
      '<div class="mm-list" role="listbox" aria-label="Modules"></div></div>';
    const listBox = moduleMenuEl.querySelector('.mm-list');
    entries.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'mm-row' + (i === curIdx ? ' mm-current' : '');
      row.setAttribute('role', 'option');
      row.textContent = m.title;
      row.addEventListener('mouseenter', () => mmSelect(i));
      row.addEventListener('click', () => mmCommit(i));
      listBox.appendChild(row);
    });
    moduleMenuEl.addEventListener('click', (e) => { if (e.target === moduleMenuEl) toggleModuleMenu(); });
    root.appendChild(moduleMenuEl);
    mmSelect(curIdx);
  }

  let blackoutEl = null;
  function toggleBlackout() {
    if (blackoutEl) { blackoutEl.remove(); blackoutEl = null; return; }
    blackoutEl = document.createElement('div');
    blackoutEl.className = 'decklight-blackout';
    root.appendChild(blackoutEl);
  }

  let helpEl = null;
  // ----- debug log window (D) — UI over the ring buffer declared up top -----
  function debugStateLine() {
    const rec = instance._records?.[instance.state.slide - 1];
    return `slide ${instance.state.slide}/${instance.state.totalSlides}`
      + ` · step ${instance.state.step}/${rec ? rec.groups.length : 0}`
      + ` · theme ${currentTheme() ?? '—'}`
      + ` · narration ${narrating ? 'on' : 'off'}`;
  }
  function appendDebugRow(e) {
    const row = document.createElement('div');
    row.className = 'dbg-row dbg-' + e.kind;
    for (const [cls, text] of [['dbg-t', e.t], ['dbg-k', e.kind], ['dbg-m', e.msg]]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      row.appendChild(span);
    }
    debugEl.querySelector('.dbg-log').appendChild(row);
  }
  function updateDebugState() {
    const el = debugEl?.querySelector('.dbg-state');
    if (el) el.textContent = debugStateLine();
  }
  function toggleDebug() {
    if (debugEl) { debugEl.remove(); debugEl = null; return; }
    debugEl = document.createElement('div');
    debugEl.className = 'decklight-debug';
    debugEl.innerHTML = '<div class="dbg-head">debug log — D closes</div><div class="dbg-state"></div><div class="dbg-log"></div>';
    root.appendChild(debugEl);
    debugBuf.forEach(appendDebugRow);
    updateDebugState();
    const log = debugEl.querySelector('.dbg-log');
    log.scrollTop = log.scrollHeight;
  }
  // feed the log: engine events + page errors (theme/font/narration log at
  // their call sites). The panel is passive chrome — keys keep driving the
  // deck while it's open, so you can watch events land as you navigate.
  instance.on('ready', (e) => debugLog('ready', `${e.slides} slides${e.print ? ' · print' : ''}`));
  instance.on('slide', (e) => { debugLog('slide', `→ ${e.slide}/${e.total} (${e.direction})`); updateDebugState(); });
  instance.on('build', (e) => { debugLog('build', `slide ${e.slide} step ${e.index}/${e.total} (${e.direction})`); updateDebugState(); });
  window.addEventListener('error', (e) => debugLog('error', String(e.message)));

  function toggleHelp() {
    if (helpEl) { helpEl.remove(); helpEl = null; return; }
    helpEl = document.createElement('div');
    helpEl.className = 'decklight-help';
    helpEl.innerHTML = `<div class="help-card"><h3>Keyboard</h3><table>
      <tr><td>→ / Space</td><td>next build / slide</td></tr>
      <tr><td>←</td><td>previous</td></tr>
      <tr><td>Home / End</td><td>first / last slide</td></tr>
      <tr><td>O</td><td>overview</td></tr>
      <tr><td>S</td><td>speaker view (again: rehearse mode)</td></tr>
      <tr><td>V</td><td>narration on/off</td></tr>
      <tr><td>N</td><td>narration track</td></tr>
      <tr><td>⇧V</td><td>record offline narration (live voice)</td></tr>
      <tr><td>B</td><td>blackout</td></tr>
      <tr><td>D</td><td>debug log</td></tr>
      <tr><td>F</td><td>fullscreen</td></tr>
      <tr><td>T</td><td>theme picker (type to filter)</td></tr>
      <tr><td>/</td><td>command palette (find, themes, everything)</td></tr>
      <tr><td>, / .</td><td>cycle theme</td></tr>
      <tr><td>[ / ]</td><td>cycle font</td></tr>
      <tr><td>⌃T</td><td>generate a theme (repeat to re-roll)</td></tr>
      <tr><td>⌃⇧T</td><td>save the generated theme</td></tr>
      ${(playlist || hasMarkersDOM) ? '<tr><td>M</td><td>module menu</td></tr>' : ''}
      <tr><td>?</td><td>this help</td></tr></table></div>`;
    helpEl.addEventListener('click', toggleHelp);
    root.appendChild(helpEl);
  }

  // ----- input -------------------------------------------------------------
  function onKey(e) {
    if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
    // ⌃T generates, ⌃⇧T saves — both must precede the modifier early-return
    // (macOS tab shortcuts are ⌘-based, so Ctrl reaches the page; on
    // Windows/Linux the browser owns Ctrl+T and these can't be intercepted).
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'T' || e.key === 't')) {
      if (e.shiftKey) saveGeneratedTheme();
      else if (pickerEl && pickerEntries[pickerSel] === GEN_ROW) rollPickerCandidate();
      else rollTheme();
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (pickerEl) {
      switch (e.key) {
        case 'ArrowDown': selectPickerRow(pickerSel + 1, false); break;
        case 'ArrowUp': selectPickerRow(pickerSel - 1, false); break;
        case 'Enter': commitPicker(); break;
        case 'Backspace': setPickerFilter(pickerFilter.slice(0, -1)); break;
        case 'Escape':
          if (pickerFilter) setPickerFilter('');
          else if (PACKS && pickerView !== 'packs') setPickerView('packs');
          else closeThemePicker();
          break;
        default:
          // quick filter: printable keys type into it — which is why there
          // are no letter shortcuts in here (⌃T re-rolls, Esc closes)
          if (e.key.length === 1 && /[a-z0-9-]/i.test(e.key)) { setPickerFilter(pickerFilter + e.key); break; }
          return;
      }
      e.preventDefault();
      return;
    }
    if (palEl) {
      switch (e.key) {
        case 'ArrowDown': selectPalRow(palSel + 1); break;
        case 'ArrowUp': selectPalRow(palSel - 1); break;
        case 'Enter': commitPalRow(); break;
        case 'Backspace': palQuery = palQuery.slice(0, -1); renderPalette(); break;
        case 'Escape': if (palQuery) { palQuery = ''; renderPalette(); } else closePalette(); break;
        default:
          if (e.key.length === 1) { palQuery += e.key; renderPalette(); break; }
          return;
      }
      e.preventDefault();
      return;
    }
    if (fontPickEl) {
      switch (e.key) {
        case 'ArrowDown': selectFontRow(fontPickSel + 1); break;
        case 'ArrowUp': selectFontRow(fontPickSel - 1); break;
        case 'Enter': applyFont(fontPickSel); closeFontPicker(); break;
        case 'Escape': closeFontPicker(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (recEl) {
      if (e.key === 'Escape') closeRecordDialog();
      else if (e.key === 'Enter') {
        if (recView === 'confirm') startRecording();
        else if (recView !== 'progress') closeRecordDialog();
      } else return;
      e.preventDefault();
      return;
    }
    if (narrEl) {
      if (narrView === 'custom') {
        if (e.key === 'Enter') { commitCustomTone(); e.preventDefault(); }
        else if (e.key === 'Escape') { narrBack(); e.preventDefault(); }
        return; // everything else types into the input
      }
      switch (e.key) {
        case 'ArrowDown': selectNarrRow(narrSel + 1); break;
        case 'ArrowUp': selectNarrRow(narrSel - 1); break;
        case 'Enter': commitNarrRow(); break;
        case 'Escape': narrBack(); break;
        case 'n': case 'N': closeNarrPicker(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (finderEl) {
      switch (e.key) {
        case 'ArrowDown': selectFinderRow(finderSel + 1, false); break;
        case 'ArrowUp': selectFinderRow(finderSel - 1, false); break;
        case 'Enter': commitFinder(); break;
        case 'Backspace': setFinderQuery(finderQuery.slice(0, -1)); break;
        case 'Escape': if (finderQuery) setFinderQuery(''); else closeSlideFinder(); break;
        default:
          if (e.key.length === 1) { setFinderQuery(finderQuery + e.key); break; }
          return;
      }
      e.preventDefault();
      return;
    }
    if (moduleMenuEl) {
      switch (e.key) {
        case 'ArrowDown': mmSelect(mmSel + 1); break;
        case 'ArrowUp': mmSelect(mmSel - 1); break;
        case 'Enter': mmCommit(mmSel); break;
        case 'Escape': case 'm': case 'M': toggleModuleMenu(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if (overviewEl) {
      switch (e.key) {
        case 'ArrowRight': ovSelect(ovSel + 1); break;
        case 'ArrowLeft': ovSelect(ovSel - 1); break;
        case 'ArrowDown': ovSelect(ovSel + ovColumns()); break;
        case 'ArrowUp': ovSelect(ovSel - ovColumns()); break;
        case 'Enter': case ' ': ovCommit(); break;
        case 'o': case 'O': case 'Escape': toggleOverview(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowRight': case ' ': case 'PageDown': instance.next(); break;
      case 'ArrowLeft': case 'PageUp': instance.prev(); break;
      case 'Home': instance.goto(1, 0); break;
      case 'End': instance.goto(instance.state.totalSlides, 0); break;
      case 'o': case 'O': toggleOverview(); break;
      case 'b': case 'B': toggleBlackout(); break;
      case 'd': case 'D': toggleDebug(); break;
      case 'f': case 'F': document.documentElement.requestFullscreen?.(); break;
      case 'v': case 'V': if (e.shiftKey) openRecordDialog(); else toggleNarration(); break;
      case 'n': case 'N': openNarrPicker(); break;
      case 's': case 'S': {
        // first S opens the speaker view; S again toggles speak ⇄ rehearse
        const w = instance.__speakerWin;
        if (w && !w.closed) w.__decklightSpeakerToggle?.();
        else instance.__speakerWin = openSpeakerView(instance);
        break;
      }
      case 't': case 'T': openThemePicker(); break;
      case '/': openPalette(); break;
      case '.': case '>': cycleTheme(1); break;
      case ',': case '<': cycleTheme(-1); break;
      case ']': cycleFont(1); break;
      case '[': cycleFont(-1); break;
      case 'm': case 'M': if (!playlist && !hasMarkersDOM) return; toggleModuleMenu(); break;
      case '?': toggleHelp(); break;
      case 'Escape':
        if (cancelCyclePending()) break;
        if (overviewEl) toggleOverview();
        break;
      default: return;
    }
    e.preventDefault();
  }
  if (!printMode) document.addEventListener('keydown', onKey);

  let touchX = null;
  root.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) (dx < 0 ? instance.next() : instance.prev());
    touchX = null;
  }, { passive: true });

  // ----- scaling -----------------------------------------------------------
  function rescale() {
    const box = root.getBoundingClientRect();
    const s = Math.min(box.width / config.width, box.height / config.height) || 1;
    instance._scale = s;
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  if (!printMode) {
    new ResizeObserver(rescale).observe(root);
    rescale();
  }

  // ----- hash --------------------------------------------------------------
  let suppressHashChange = false;
  if (config.hash && !printMode) {
    window.addEventListener('hashchange', () => {
      if (suppressHashChange) return;
      const t = parseHash();
      if (t) instance.goto(t.slide, t.step, { force: true });
    });
  }

  // ----- go ----------------------------------------------------------------
  instance.sync();

  // Print stacks slides as pages; root-level chrome would appear once. Give
  // every printed slide its own copy of the brand mark (hero slides already
  // carry a large one — no doubling).
  if (printMode && logoEl) {
    instance._sections.forEach((s) => {
      if (!s.hasAttribute('data-logo')) s.appendChild(logoEl.cloneNode(true));
    });
    logoEl.remove();
  }

  // Webfonts can change a pinned title's wrap/height after the first
  // measurement — re-measure once the font set settles.
  document.fonts?.ready?.then(() => {
    if (activeInstance === instance || !activeInstance) {
      setupPinnedTitles(instance._sections, config);
    }
  });

  instance.theme = (name) => applyTheme(name);
  instance.themePicker = { open: openThemePicker, close: closeThemePicker };
  instance.generateTheme = rollTheme;                       // ⌃T, programmatic
  instance.cycleFont = cycleFont;                           // [ / ], programmatic (±1)
  instance.toggleNarration = toggleNarration;               // V, programmatic

  // ── narration (V) + picker (N) — SPEC §8 ────────────────────────────────
  // Two sources, one V toggle. RECORDED: pre-rendered per-slide audio
  // (tools/voiceover.mjs, or ⇧V below; config.narration.files = '<dir>' or
  // [{ label, dir, ext }, …] — ext defaults to 'm4a', ⇧V recordings are
  // 'wav'). LIVE: synthesized on the fly per slide through the local bridge
  // (`decklight tts`) — pick a Gemini voice and a delivery tone in the
  // picker; responses are cached per (slide, voice, style) and the next
  // slide is prefetched while the current one plays. N opens the picker
  // (tracks → voices → tones → custom-tone input); choice persists per deck.
  // ⇧V, live voice only: batch-synthesizes every slide's notes with the
  // current voice/tone and downloads them as slide-NN.wav, so the deck can
  // later run RECORDED with that set instead of depending on the bridge.
  const narrKey = 'decklight-narration:' + location.pathname;
  const LIVE_URL = config.narration?.liveUrl ?? 'http://127.0.0.1:8787/tts';
  // keep in sync with tools/gemini-tts.mjs GEMINI_VOICES
  const GEMINI_VOICES = [
    ['Zephyr', 'bright'], ['Puck', 'upbeat'], ['Charon', 'informative'],
    ['Kore', 'firm'], ['Fenrir', 'excitable'], ['Leda', 'youthful'],
    ['Orus', 'firm'], ['Aoede', 'breezy'], ['Callirrhoe', 'easy-going'],
    ['Autonoe', 'bright'], ['Enceladus', 'breathy'], ['Iapetus', 'clear'],
    ['Umbriel', 'easy-going'], ['Algieba', 'smooth'], ['Despina', 'smooth'],
    ['Erinome', 'clear'], ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'],
    ['Laomedeia', 'upbeat'], ['Achernar', 'soft'], ['Alnilam', 'firm'],
    ['Schedar', 'even'], ['Gacrux', 'mature'], ['Pulcherrima', 'forward'],
    ['Achird', 'friendly'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'],
    ['Sadachbia', 'lively'], ['Sadaltager', 'knowledgeable'], ['Sulafat', 'warm'],
  ];
  const TONES = [
    ['Warm senior engineer', "Read in a warm, welcoming tone. You're a friendly and battle-hardened senior engineer, still curious and savvy about new technologies."],
    ['Professional', 'Read in a clear, professional tone — measured, confident, and articulate.'],
    ['Too serious', 'Read in an extremely grave, deadly serious tone, as if announcing news of the utmost importance.'],
    ['Joyful', 'Read in a joyful, light-hearted tone, smiling through every sentence.'],
    ['Super excited', 'Read in a super-excited, high-energy tone, barely containing your enthusiasm.'],
    ['Sad', 'Read in a somber, melancholic tone, on the verge of a sigh.'],
  ];
  const narrSets = (() => {
    const f = config.narration?.files;
    if (!f) return [];
    return Array.isArray(f) ? f : [{ label: 'Narration', dir: f }];
  })();
  const LIVE_TRACK = { live: true };
  let liveCfg = { voice: 'Alnilam', tone: TONES[0][0], style: TONES[0][1] };
  let narrSet = narrSets[0] ?? null;
  try {
    const saved = JSON.parse(localStorage.getItem(narrKey));
    if (saved?.live?.voice) { liveCfg = saved.live; narrSet = LIVE_TRACK; }
    else { const hit = narrSets.find((t) => t.dir === saved?.dir); if (hit) narrSet = hit; }
  } catch { /* ignore */ }
  let narrating = false, narrAudio = null, liveWarned = false;
  // slide|voice|style → PROMISE of a blob URL. Caching the promise (not the
  // resolved URL) dedups concurrent misses: the prefetch and a play (or a
  // ⇧V recording pass) for the same slide share one POST instead of racing
  // two and leaking the loser's blob URL. Failures evict themselves so a
  // bridge hiccup isn't cached forever.
  const liveCache = new Map();
  function notesText(sl) {
    const t = instance._sections?.[sl - 1]?.querySelector('aside.notes')?.textContent ?? '';
    return t.replace(/⟨CLICK⟩/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function fetchLive(sl) {
    const text = notesText(sl);
    if (!text) return Promise.resolve(null);
    const key = `${sl}|${liveCfg.voice}|${liveCfg.style}`;
    if (!liveCache.has(key)) {
      const p = (async () => {
        const res = await fetch(LIVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice: liveCfg.voice, style: liveCfg.style }),
        });
        if (!res.ok) throw new Error(String(res.status));
        return URL.createObjectURL(await res.blob());
      })();
      p.catch(() => { if (liveCache.get(key) === p) liveCache.delete(key); });
      liveCache.set(key, p);
    }
    return liveCache.get(key);
  }
  // Live voice narrates a whole slide as one clip (SPEC: builds aren't
  // step-synced to audio), so "done talking" means "done with this slide" —
  // auto-advance jumps straight to the next slide, not the next build step.
  function autoAdvance(sl) {
    if (!narrating || !narrSet?.live || instance.state.slide !== sl) return;
    if (sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
  }
  async function playLive() {
    const sl = instance.state.slide;
    try {
      const url = await fetchLive(sl);
      // stale guard: synthesis takes seconds — only play if still on this slide
      if (!narrating || instance.state.slide !== sl) return;
      if (!url) { autoAdvance(sl); return; } // nothing to narrate — don't stall
      narrAudio ??= new Audio();
      narrAudio.src = url;
      narrAudio.onended = () => autoAdvance(sl);
      narrAudio.play().catch(() => { /* autoplay policy */ });
      if (sl < instance.state.totalSlides) fetchLive(sl + 1).catch(() => { /* prefetch only */ });
    } catch {
      if (!liveWarned) { toast('live voice bridge unreachable — run: decklight tts'); liveWarned = true; }
      debugLog('narr', `live synth failed (slide ${sl})`);
    }
  }
  function playSlideFile() {
    if (!narrSet) return;
    if (narrSet.live) return playLive();
    narrAudio ??= new Audio();
    // state.slide and the files are BOTH 1-based (slide-01 = first section).
    // ext defaults to the pre-render tool's .m4a; ⇧V-recorded sets are .wav.
    narrAudio.src = `${narrSet.dir}/slide-${String(instance.state.slide).padStart(2, '0')}.${narrSet.ext ?? 'm4a'}`;
    narrAudio.play().catch(() => { /* no file for this slide */ });
  }
  function toggleNarration() {
    if (!narrSet) { openNarrPicker(narrSets.length ? 'tracks' : 'voices'); return; }
    narrating = !narrating;
    if (narrating) {
      const what = narrSet.live ? `⚡ ${liveCfg.voice} · ${liveCfg.tone}` : narrSet.label;
      toast(`🔊 ${what} — V stops · N picks`);
      debugLog('narr', `on — ${what}`);
      playSlideFile();
    } else {
      narrAudio?.pause();
      toast('narration off');
      debugLog('narr', 'off');
    }
  }
  instance.on('slide', () => { if (narrating) playSlideFile(); });
  if (params.has('voiceover') && narrSet && !printMode) {
    // whichever gesture fires first must disarm the OTHER listener too, or
    // the survivor re-arms narration on the next key/click after V stops it
    const arm = () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      if (!narrating) toggleNarration();
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
  }

  // N: narration picker — tracks → live voices → tones → custom tone
  let narrEl = null, narrSel = 0, narrView = 'tracks', narrRows = [], liveDraft = null;
  function persistNarr() {
    try {
      localStorage.setItem(narrKey, JSON.stringify(narrSet?.live ? { live: liveCfg } : { dir: narrSet?.dir }));
    } catch { /* ignore */ }
  }
  function applyLive(toneLabel, styleText) {
    liveCfg = { voice: liveDraft ?? liveCfg.voice, tone: toneLabel, style: styleText };
    narrSet = LIVE_TRACK;
    liveWarned = false;
    persistNarr();
    closeNarrPicker();
    if (!narrating) narrating = true;
    toast(`⚡ live voice: ${liveCfg.voice} · ${liveCfg.tone} — V stops`);
    playSlideFile();
  }
  function selectNarrRow(i) {
    if (!narrRows.length) return;
    narrSel = (i + narrRows.length) % narrRows.length;
    narrEl.querySelectorAll('.narr-row').forEach((r, j) => r.classList.toggle('narr-sel', j === narrSel));
  }
  function commitNarrRow() { narrRows[narrSel]?.commit(); }
  function narrBack() {
    if (narrView === 'custom') renderNarr('tones');
    else if (narrView === 'tones') renderNarr('voices');
    else if (narrView === 'voices' && narrSets.length) renderNarr('tracks');
    else closeNarrPicker();
  }
  function renderNarr(view) {
    narrView = view;
    const card = narrEl.querySelector('.narr-card');
    card.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'narr-head';
    card.appendChild(head);
    narrRows = [];
    if (view === 'tracks') {
      head.textContent = 'narration';
      narrSets.forEach((t) => narrRows.push({
        text: `🔊 ${t.label} (${t.dir}/)`,
        cur: t === narrSet,
        commit: () => { narrSet = t; persistNarr(); closeNarrPicker(); toast(`🔊 track: ${t.label}`); if (narrating) playSlideFile(); },
      }));
      narrRows.push({
        text: '⚡ Live voice — synthesize on the fly…',
        cur: narrSet?.live,
        commit: () => renderNarr('voices'),
      });
    } else if (view === 'voices') {
      head.textContent = 'live voice — pick a voice';
      GEMINI_VOICES.forEach(([name, flavor]) => narrRows.push({
        text: `${name} <span class="narr-flavor">${flavor}</span>`,
        html: true,
        cur: narrSet?.live && liveCfg.voice === name,
        commit: () => { liveDraft = name; renderNarr('tones'); },
      }));
    } else if (view === 'tones') {
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — pick a tone`;
      TONES.forEach(([label, styleText]) => narrRows.push({
        text: label,
        cur: narrSet?.live && liveCfg.tone === label,
        commit: () => applyLive(label, styleText),
      }));
      narrRows.push({ text: 'Custom…', cur: narrSet?.live && liveCfg.tone === 'Custom', commit: () => renderNarr('custom') });
    } else { // custom tone input
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — type the delivery instruction`;
      const input = document.createElement('input');
      input.className = 'narr-input';
      input.value = liveCfg.style;
      input.placeholder = 'Read in a …';
      // onKey ignores events targeting inputs — commit/back live on the field
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commitCustomTone(); e.preventDefault(); }
        else if (e.key === 'Escape') { narrBack(); e.preventDefault(); }
        e.stopPropagation();
      });
      card.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      narrRows = [];
      narrSel = 0;
      return;
    }
    narrRows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'narr-row' + (row.cur ? ' narr-cur' : '');
      if (row.html) el.innerHTML = row.text; else el.textContent = row.text;
      el.addEventListener('mouseenter', () => selectNarrRow(i));
      el.addEventListener('click', () => { selectNarrRow(i); commitNarrRow(); });
      card.appendChild(el);
    });
    const cur = narrRows.findIndex((r) => r.cur);
    selectNarrRow(Math.max(0, cur));
    narrEl.querySelector('.narr-sel')?.scrollIntoView({ block: 'nearest' });
  }
  function commitCustomTone() {
    const v = narrEl?.querySelector('.narr-input')?.value.trim();
    if (v) applyLive('Custom', v);
  }
  function openNarrPicker(view) {
    if (narrEl && view === undefined) return closeNarrPicker(); // N toggles
    if (!narrEl) {
      narrEl = document.createElement('div');
      narrEl.className = 'decklight-narr';
      narrEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Narration"></div>';
      narrEl.addEventListener('click', (e) => { if (e.target === narrEl) closeNarrPicker(); });
      root.appendChild(narrEl);
    }
    renderNarr(view ?? (narrSets.length ? 'tracks' : 'voices'));
  }
  function closeNarrPicker() {
    narrEl?.remove();
    narrEl = null;
  }

  // ⇧V: batch-record the whole deck offline with the current live voice/tone.
  // Reuses fetchLive/liveCache (so the recorded slides also warm live
  // playback) and drives each blob straight into a browser download —
  // no server-side write, no zip dependency. The progress card's ETA is a
  // running average: elapsed ÷ slides-done × slides-left.
  // recRun is a generation counter, not a boolean: closing the dialog bumps
  // it, and a loop only acts while its own run is still current — a cancel
  // followed by an immediate re-record can't resurrect the old loop.
  let recEl = null, recView = 'confirm', recRun = 0;
  function slidesWithNotes() {
    const out = [];
    for (let sl = 1; sl <= instance.state.totalSlides; sl++) if (notesText(sl)) out.push(sl);
    return out;
  }
  function fmtTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }
  function downloadFromUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function renderRecordCard(view, data = {}) {
    recView = view;
    const card = recEl.querySelector('.narr-card');
    if (view === 'confirm') {
      const n = data.total;
      card.innerHTML = `<div class="narr-head">record offline narration</div>
        <div class="rec-line">⚡ ${liveCfg.voice} · ${liveCfg.tone}</div>
        <div class="rec-line">${n} slide${n === 1 ? '' : 's'} with notes will be synthesized and downloaded</div>
        <div class="narr-row narr-sel">Start recording</div>
        <div class="rec-hint">Enter to start · Esc to cancel</div>`;
      card.querySelector('.narr-row').addEventListener('click', startRecording);
    } else if (view === 'progress') {
      const { done, total, elapsedMs } = data;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const eta = done ? fmtTime((elapsedMs / done) * (total - done)) : '…';
      card.innerHTML = `<div class="narr-head">recording…</div>
        <div class="rec-bar"><div class="rec-bar-fill" style="width:${pct}%"></div></div>
        <div class="rec-line">${done} / ${total} slides · ${fmtTime(elapsedMs)} elapsed · ~${eta} left</div>
        <div class="rec-hint">Esc to cancel</div>`;
    } else {
      const { saved, total, cancelled } = data;
      card.innerHTML = `<div class="narr-head">${cancelled ? 'recording cancelled' : 'recording done'}</div>
        <div class="rec-line">${saved} / ${total} slide${total === 1 ? '' : 's'} saved as slide-NN.wav to your downloads</div>
        <div class="rec-line">Point <code>narration.files</code> at that folder with <code>ext: 'wav'</code> to play them back without the bridge.</div>
        <div class="rec-hint">Enter or Esc to close</div>`;
    }
  }
  async function startRecording() {
    const list = slidesWithNotes();
    const run = ++recRun;
    const t0 = Date.now();
    let done = 0, saved = 0;
    renderRecordCard('progress', { done, total: list.length, elapsedMs: 0 });
    for (const sl of list) {
      if (run !== recRun) return;
      try {
        const url = await fetchLive(sl);
        if (run !== recRun) return; // cancelled mid-synthesis — don't download
        if (url) { downloadFromUrl(url, `slide-${String(sl).padStart(2, '0')}.wav`); saved++; }
      } catch {
        toast(`slide ${sl}: recording failed`);
      }
      done++;
      if (run === recRun) renderRecordCard('progress', { done, total: list.length, elapsedMs: Date.now() - t0 });
    }
    if (run === recRun) renderRecordCard('done', { saved, total: list.length });
  }
  function openRecordDialog() {
    if (!narrSet?.live) { toast('live voice only — pick a voice with N first'); return; }
    if (recEl) return;
    recEl = document.createElement('div');
    recEl.className = 'decklight-narr decklight-record';
    recEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Record offline narration"></div>';
    recEl.addEventListener('click', (e) => { if (e.target === recEl) closeRecordDialog(); });
    root.appendChild(recEl);
    renderRecordCard('confirm', { total: slidesWithNotes().length });
  }
  function closeRecordDialog() {
    recRun++; // invalidate any in-flight recording loop
    recEl?.remove();
    recEl = null;
  }
  instance.saveGeneratedTheme = (name) => saveGeneratedTheme(name); // ⌃⇧T; name skips the prompt

  if (printMode) {
    root.classList.add('decklight-print');
    instance._sections.forEach((s, i) => {
      s.classList.add('active');
      applyBuildState(instance._records[i], instance._records[i].groups.length);
    });
    // All slides are visible in print — audit the whole deck for clipping.
    requestAnimationFrame(() => instance._sections.forEach((s, i) => checkOverflow(s, i + 1)));
    root.__decklight = instance;
    activeInstance = instance;
    instance._emit('ready', { slides: instance.state.totalSlides, print: true });
    return instance;
  }

  const target = (config.hash && parseHash()) || { slide: 1, step: 0 };
  instance._sections.forEach((s, i) => {
    if (i !== target.slide - 1) applyBuildState(instance._records[i], 0);
  });
  instance.goto(target.slide, target.step, { force: true });

  root.__decklight = instance;
  activeInstance = instance;
  instance._emit('ready', { slides: instance.state.totalSlides });
  return instance;
}
