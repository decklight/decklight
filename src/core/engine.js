// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Engine — init, navigation, transitions, overview/blackout/help, hash,
// scaling, print. SPEC §2.2, §4.1, §8, §9.

import { scanSlide, applyBuildState, stepLabels, registerProvider, providerRegistry } from './builds.js';
import { namespaceSvgIds, applyConcepts } from './svg.js';
import { initCharts } from './charts.js';
import { runAutoAnimate } from './autoanimate.js';
import { initMarkdown } from '../md/markdown.js';
import { initMath } from '../math/math.js';
import { initCode } from '../code/code.js';
import { openSpeakerView, notesSegments } from './speaker.js';
import { generateTheme, tokensToCss, luminance } from './themegen.js';
import { createCharacter, concatTimelines } from './character.js';

const DEFAULTS = {
  transition: 'fade',
  hash: true,
  controls: true,
  slideNumber: false,
  width: 1280,
  height: 720,
  pinTitles: true,
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
 * (opt out), data-pin="<number>" (custom Y). data-layout (§8 layout cycling)
 * wins over data-pin: "pinned" forces the pin (a numeric data-pin still sets
 * the Y), "centered" and "top" lay out in flow; the split layouts keep the
 * deck's auto pin resolution for their header.
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

function deckPinY(config) {
  return config.pinTitles === true ? PIN_DEFAULT_Y
    : (typeof config.pinTitles === 'number' && isFinite(config.pinTitles)) ? config.pinTitles
    : null;
}

// The pin Y a section resolves to under AUTO layout (no data-layout override):
// data-pin first, then the deck config + pinnable heuristic. null = no pin.
function autoPinY(sec, config) {
  const deckY = deckPinY(config);
  const attr = sec.getAttribute('data-pin');
  if (attr === 'none') return null;
  if (attr !== null && attr !== '') {
    const n = parseFloat(attr);
    return isFinite(n) ? n : (deckY ?? PIN_DEFAULT_Y);
  }
  if (attr === '') return deckY ?? PIN_DEFAULT_Y; // bare data-pin forces even when config is off
  if (deckY === null) return null;
  const hasContent = [...sec.querySelectorAll(PINNABLE_CONTENT)]
    .some((el) => !el.closest('aside') && !el.closest('.decklight-hero-logo'));
  return hasContent ? deckY : null;
}

function setupPinnedTitles(sections, config) {
  sections.forEach((sec) => {
    const heading = leadingHeading(sec);
    const layout = sec.getAttribute('data-layout');
    let y;
    if (layout === 'pinned') {
      const n = parseFloat(sec.getAttribute('data-pin'));
      y = isFinite(n) ? n : (deckPinY(config) ?? PIN_DEFAULT_Y);
    } else if (layout === 'centered' || layout === 'top') {
      y = null;
    } else {
      y = autoPinY(sec, config); // auto and the split layouts keep the deck's pin
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
 * Split layouts (SPEC §8): a slide's content blocks — everything after the
 * title + subtitle header — lay out in two sides, first block left and the
 * rest right ("split-flip" mirrors). A slide whose ONLY content block is a
 * list can't take sides; the engine marks it .split-columns instead and the
 * list itself splits across two CSS columns.
 */
function splitContent(sec) {
  return [...sec.children].filter((el) =>
    !el.matches('h1, h2, .subtitle, aside, script, style, .decklight-hero-logo'));
}

function setupSplit(sections) {
  sections.forEach((sec) => {
    sec.querySelectorAll(':scope > .split-columns').forEach((el) => el.classList.remove('split-columns'));
    if (!/^split/.test(sec.getAttribute('data-layout') || '')) return;
    const content = splitContent(sec);
    if (content.length === 1 && content[0].matches('ul, ol')) content[0].classList.add('split-columns');
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
  let ttsSpend = 0; // estimated $ across live-bridge calls (x-tts-cost header)
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
  // Messages (SPEC §8): the deck talks back in the top-left corner — big enough
  // to read from the back of a room, gone a few seconds later. Every one is also
  // KEPT: a message that explains why the voice stopped is worthless if it faded
  // while you were looking at the slide. `I` shows the log (see toggleMessages).
  const MSG_KEEP = 200;   // ring buffer
  const MSG_STACK = 4;    // visible at once — beyond that the oldest goes early
  const msgLog = [];
  let msgEl = null;
  let msgListEl = null;
  function messages() { return msgLog; }
  function toast(msg, ms = 3200) {
    msgLog.push({ at: new Date(), text: String(msg) });
    if (msgLog.length > MSG_KEEP) msgLog.shift();
    if (msgListEl) renderMsgList();   // the log is open — keep it live
    if (printMode) return;
    if (!msgEl) {
      msgEl = document.createElement('div');
      msgEl.className = 'decklight-messages';
      root.appendChild(msgEl);
    }
    const row = document.createElement('div');
    row.className = 'decklight-toast';
    row.textContent = msg;
    msgEl.appendChild(row);
    requestAnimationFrame(() => row.classList.add('show'));
    while (msgEl.children.length > MSG_STACK) msgEl.firstChild.remove();
    const drop = () => {
      row.classList.remove('show');
      setTimeout(() => row.remove(), 260); // after the fade
    };
    setTimeout(drop, ms);
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
    const slides = instance._sections.map((sec, i) => {
      const contentEls = [...sec.children].filter((el) => !el.matches('aside, script, style'));
      const heading = sec.querySelector('h1, h2, h3');
      const body = contentEls.map((el) => el.textContent).join(' ').replace(/\s+/g, ' ').trim();
      const title = (heading?.textContent || '').replace(/\s+/g, ' ').trim()
        || (body.slice(0, 60) || `slide ${i + 1}`);
      return { slide: i + 1, title, haystack: body.toLowerCase() };
    });
    // A playlist's other modules are separate FILES — the one thing the old
    // module menu could do that this finder could not, since the index only ever
    // saw the current document's sections. They belong here: "go somewhere" is
    // one question, and it should have one answer. (In-file data-module markers
    // need nothing: they are ordinary slides, already indexed above.)
    const modules = (playlist?.modules ?? [])
      .map((m, i) => ({ module: i, title: m.title, href: m.href, haystack: (m.title || '').toLowerCase() }))
      .filter((m) => m.module !== playlistIndex);
    return [...slides, ...modules];
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
      row.className = 'tp-row' + (m.slide === instance.state.slide ? ' tp-current' : '')
        + (m.href ? ' tp-module' : '');
      // a module leaves this file, so it says so — it is not slide N of here
      row.textContent = m.href ? `▸ ${m.title} — module` : `${m.slide} · ${m.title}`;
      row.addEventListener('mouseenter', () => selectFinderRow(i, false));
      row.addEventListener('click', () => { selectFinderRow(i, true); commitFinder(); });
      listBox.appendChild(row);
    });
    if (!finderMatches.length) {
      const none = document.createElement('div');
      none.className = 'tp-none';
      none.textContent = 'no matches';
      listBox.appendChild(none);
    }
    const bar = finderEl.querySelector('.tp-filter');
    bar.textContent = finderQuery || (playlist ? 'type to find a slide or module…' : 'type to find a slide…');
    bar.classList.toggle('tp-active', !!finderQuery);
  }
  // `entry` is a finder row: a slide of THIS deck, or a module — another file,
  // which the iframe has to actually load rather than postMessage a goto into
  function finderPreviewSwap(frame, entry) {
    const doc = entry.href ?? location.pathname;
    const slide = entry.slide ?? 1;
    if (frame.dataset.doc !== doc) {
      frame.dataset.doc = doc;
      finderFrameReady = false;
      frame.addEventListener('load', () => {
        finderFrameReady = true;
        if (finderPending && finderEl) {
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
      frame.src = doc + (cand
        ? '?embedded&gen=' + b64uEncode(cand)
        : name ? '?embedded&theme=' + encodeURIComponent(name) : '?embedded') + hash;
      return;
    }
    if (!finderFrameReady) { finderPending = entry; return; }
    frame.contentWindow?.postMessage({ __decklightPreview: { goto: [slide, 0] } }, '*');
  }
  function selectFinderRow(i, immediate) {
    if (!finderMatches.length) return;
    finderSel = (i + finderMatches.length) % finderMatches.length;
    const rows = finderEl.querySelectorAll('.tp-row');
    rows.forEach((r, j) => r.classList.toggle('tp-selected', j === finderSel));
    rows[finderSel]?.scrollIntoView({ block: 'nearest' });
    const m = finderMatches[finderSel];
    finderEl.querySelector('.tp-caption').textContent = m.href
      ? `module — ${m.title} (${m.href})`
      : `slide ${m.slide} — ${m.title}`;
    clearTimeout(finderDebounce);
    const frame = finderEl.querySelector('iframe');
    if (immediate) finderPreviewSwap(frame, m);
    else finderDebounce = setTimeout(() => finderPreviewSwap(frame, m), 60);
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
    if (!m) return;
    if (m.href) return navigateToModule(m.module); // another file — a page load
    instance.goto(m.slide, 0);
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
      { label: 'Find slide…', hint: 'G', alias: 'search grep goto module chapter jump', run: () => { openSlideFinder(); if (palQuery) setFinderQuery(palQuery); } },
      { label: 'Go to slide…', hint: '#', alias: 'goto', keepOpen: true, run: () => { palQuery = 'goto '; renderPalette(); } },
      { label: 'Theme…', hint: 'T', run: openThemePicker },
      { label: 'Cycle theme', hint: ', · .', run: () => cycleTheme(1) },
      { label: 'Generate a theme', hint: '⌃T', run: rollTheme },
      genTheme && { label: 'Save the generated theme…', hint: '⌃⇧T', run: () => saveGeneratedTheme() },
      { label: 'Font…', hint: '[ · ]', run: openFontPicker },
      { label: 'Cycle slide layout (dev)', hint: 'L', alias: 'pin pinned centered top auto split columns two sides arrange', run: () => cycleLayout(1) },
      { label: 'Undo deck edit (dev)', hint: 'Z', alias: 'revert back history', run: () => deckHistory('undo') },
      { label: 'Redo deck edit (dev)', hint: '⇧Z', alias: 'forward history repeat', run: () => deckHistory('redo') },
      { label: 'Ask agent… (dev)', hint: 'A', alias: 'ai claude codex bob gemini prompt edit', run: toggleAgentAsk },
      { label: 'Messages', hint: '`', alias: 'log toast notifications warnings why voice stopped history', run: toggleMessages },
      { label: `Narration ${narrating ? 'off' : 'on'}`, hint: 'V', run: toggleNarration },
      { label: 'Narration track…', hint: 'N', alias: 'voice audio', run: () => openNarrPicker('tracks') },
      { label: 'Live voice…', alias: 'tts synthesize tone gemini', run: () => openNarrPicker('voices') },
      { label: 'Character…', alias: 'avatar lipsync face talking head visemes', run: () => openNarrPicker('character') },
      { label: `Character solo ${character.solo ? 'off' : 'on'}`, alias: 'centre center stage narrator only fullscreen avatar', run: () => applySolo(!character.solo) },
      { label: 'Record offline narration…', hint: '⇧V', alias: 'export download batch wav tts', run: openRecordDialog },
      { label: 'Voice faster', hint: '>', alias: 'speed rate playback', run: () => changeNarrRate(+0.25) },
      { label: 'Voice slower', hint: '<', alias: 'speed rate playback', run: () => changeNarrRate(-0.25) },
      { label: 'Speaker view', hint: 'S', run: () => {
        const w = instance.__speakerWin;
        if (w && !w.closed) w.__decklightSpeakerToggle?.();
        else instance.__speakerWin = openSpeakerView(instance);
      } },
      { label: 'Overview', hint: 'O', run: toggleOverview },
      { label: 'Blackout', hint: 'B', run: toggleBlackout },
      { label: 'Debug log', hint: 'D', alias: 'console events state', run: toggleDebug },
      { label: `Captions ${captionsOn ? 'off' : 'on'}`, hint: 'C', alias: 'cc subtitles closed caption', run: toggleCaptions },
      { label: `Clock ${clockOn ? 'off' : 'on'}`, hint: 'K', alias: 'time elapsed timer talk wall watch', run: toggleClock },
      { label: `Progress bar ${progressOn ? 'off' : 'on'}`, hint: 'H', alias: 'bar bottom edge position how far through shape of the talk', run: toggleProgress },
      { label: 'Transcript…', alias: 'notes script export text markdown spoken', run: toggleTranscript },
      { label: `Narration ${narrPaused ? 'resume' : 'pause'}`, hint: 'P', alias: 'pause resume voice', run: toggleNarrPause },
      { label: 'Edit speaker notes…', hint: 'E', alias: 'edit mode notes write', run: toggleEditor },
      { label: 'Fullscreen', hint: 'F', run: () => toggleFullscreen() },
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
  initCharts(stage); // synchronous, so the SVGs get namespaced and build-scanned below
  initMath(stage); // after initMarkdown: md math renders inside the md pipeline
  namespaceSvgIds(stage);
  initCode(stage, registerBuildProvider);

  // ----- slide layout cycling (L / ⇧L) — SPEC §8 -----------------------------
  // Walk the CURRENT slide through the layout ring. Dev-mode ONLY: the pick
  // is a persisted deck edit — it lands on the section as data-layout AND is
  // written back into the file through the edit server (the same attribute
  // an author writes by hand; 'auto' removes it). It wins over data-pin:
  // 'pinned' forces the pin, 'centered'/'top' lay out in flow ('top'
  // additionally top-aligns via CSS), the split pair lays the content out
  // in two sides. Without the server the key explains itself and changes
  // nothing — a presenter can't silently fork the deck from what's on disk.
  const LAYOUTS = ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'];
  // Write-through is debounced: the pick applies to the DOM instantly, and
  // the FINAL pick of a cycling burst goes to the server (each write makes
  // the watcher reload every browser — one reload per decision, not per L).
  let layoutPending = null; // { slide, name }
  let layoutTimer = null;
  function saveLayout() {
    clearTimeout(layoutTimer);
    const p = layoutPending;
    layoutPending = null;
    if (!p) return;
    fetch(editBase + '/edit/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide: p.slide, layout: p.name }),
    }).then((r) => { if (!r.ok) throw new Error(r.status); debugLog('layout', `slide ${p.slide}: ${p.name} → saved to file`); })
      .catch(() => toast('layout save failed — is the dev server still up?', 2200));
  }
  // The ring for one slide, entries that cannot change its look SKIPPED so
  // every press shows something new: 'pinned' when auto already pins,
  // 'split-flip' when there aren't two content blocks to swap sides.
  // Public (instance.layoutRing) so headless verification can assert the
  // skip logic without a dev server to cycle through.
  function layoutRing(idx = instance.state.slide) {
    const sec = instance._sections[idx - 1];
    if (!sec) return [];
    return LAYOUTS.filter((n) =>
      (n !== 'pinned' || autoPinY(sec, config) === null) &&
      (n !== 'split-flip' || splitContent(sec).length > 1));
  }
  function cycleLayout(dir) {
    if (!editAvailable) {
      toast('layout is a deck edit — it needs dev mode: decklight dev <deck.html>', 2600);
      return;
    }
    const idx = instance.state.slide;
    const sec = instance._sections[idx - 1];
    if (!sec) return;
    const ring = layoutRing(idx);
    const cur = sec.getAttribute('data-layout') || 'auto';
    const at = Math.max(0, ring.indexOf(cur));
    const name = ring[(at + dir + ring.length) % ring.length];
    if (name === 'auto') sec.removeAttribute('data-layout');
    else sec.setAttribute('data-layout', name);
    if (layoutPending && layoutPending.slide !== idx) saveLayout(); // a different slide's pick must not be dropped
    layoutPending = { slide: idx, name };
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(saveLayout, 600);
    // geometry changed: pinned titles and the overflow guardrail re-derive
    setupPinnedTitles(instance._sections, config);
    setupSplit(instance._sections);
    checkOverflow(sec, idx);
    toast(`layout: ${name}`);
    debugLog('layout', `slide ${idx}: ${name}`);
  }

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
      setupSplit(this._sections);            // after pins — .subtitle is marked there
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
  let progressBar = null; // mounted by the progress bar toggle (H), below
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
  }

  // Touch chrome (mounted after narration is set up, below): phones and
  // tablets have no keyboard, so surface the two controls a presenter needs
  // there — fullscreen and sound (narration on/off). CSS shows the cluster
  // only on pointer:coarse; desktop keeps F and V.
  const TC_ICON = {
    full: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    unfull: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    sound: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M17 10l5 4M22 10l-5 4"/></svg>',
  };
  let fsBtn = null, soundBtn = null;
  function toggleFullscreen() {
    const el = root || document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.()?.catch?.(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    if (fsBtn) fsBtn.innerHTML = document.fullscreenElement ? TC_ICON.unfull : TC_ICON.full;
  });
  function syncSoundBtn() {
    if (!soundBtn) return;
    soundBtn.innerHTML = narrating ? TC_ICON.sound : TC_ICON.mute;
    soundBtn.setAttribute('aria-label', narrating ? 'Mute narration' : 'Play narration');
    soundBtn.setAttribute('aria-pressed', String(narrating));
  }

  if ((config.slideNumber || playlist || hasMarkersDOM) && !printMode) {
    slideNumEl = document.createElement('div');
    slideNumEl.className = 'decklight-slide-number';
    if (playlist || hasMarkersDOM) {
      slideNumEl.title = 'G — find a slide or module';
      slideNumEl.style.cursor = 'pointer';
      slideNumEl.addEventListener('click', () => openSlideFinder());
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

  // ----- blackout (B) --------------------------------------------------------
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
    const narrWhat = narrSet?.live
      ? `⚡ ${liveCfg.voice} · ${liveCfg.tone}`
      : (narrSet ? `🔊 ${narrSet.label}` : 'none');
    return `slide ${instance.state.slide}/${instance.state.totalSlides}`
      + ` · step ${instance.state.step}/${rec ? rec.groups.length : 0}`
      + ` · theme ${currentTheme() ?? '—'}`
      + ` · narration ${narrating ? (narrPaused ? 'paused' : 'on') : 'off'} (${narrWhat})`
      + (narrRate !== 1 ? ` · ${narrRate}×` : '')
      + (ttsSpend > 0 ? ` · tts ~$${ttsSpend.toFixed(4)}` : '');
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
  // The message LOG (I). Messages fade after a few seconds — which is exactly
  // when you were looking at the slide, not the corner — so every one is kept
  // and can be read back. Reachable while presenting AND while editing notes:
  // the reason the voice died is the one thing you always need to see.
  // The message LOG (I). Messages fade after a few seconds — which is exactly
  // when you were looking at the slide, not the corner — so every one is kept
  // and can be read back. Reachable while presenting AND while editing notes:
  // the reason the voice died is the one thing you always need to see.
  function renderMsgList() {
    const log = msgListEl?.querySelector('.msg-log');
    if (!log) return;
    log.innerHTML = '';
    if (!msgLog.length) {
      const empty = document.createElement('div');
      empty.className = 'msg-empty';
      empty.textContent = 'no messages yet';
      log.appendChild(empty);
      return;
    }
    msgLog.forEach(({ at, text }) => {
      const row = document.createElement('div');
      row.className = 'msg-row';
      const t = document.createElement('span');
      t.className = 'msg-time';
      t.textContent = at.toLocaleTimeString([], { hour12: false });
      const m = document.createElement('span');
      m.className = 'msg-text';
      m.textContent = text;
      row.append(t, m);
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;
  }
  function toggleMessages() {
    if (msgListEl) { msgListEl.remove(); msgListEl = null; return; }
    msgListEl = document.createElement('div');
    msgListEl.className = 'decklight-msglog';
    msgListEl.innerHTML = '<div class="msg-head">messages — the key left of 1 closes</div><div class="msg-log"></div>';
    root.appendChild(msgListEl);
    renderMsgList();
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
      <tr><td>&lt; / &gt;</td><td>voice speed (0.25× steps)</td></tr>
      <tr><td>B</td><td>blackout</td></tr>
      <tr><td>D</td><td>debug log</td></tr>
      <tr><td>&#96;</td><td>messages — the key left of 1 (⌃&#96; / ⌥&#96; also works while editing notes)</td></tr>
      <tr><td>C</td><td>captions (follow the voice)</td></tr>
      <tr><td>K</td><td>clock — wall time + elapsed talk</td></tr>
      <tr><td>H</td><td>progress bar — position in the deck, bottom edge</td></tr>
      <tr><td>P</td><td>pause / resume narration</td></tr>
      <tr><td>F</td><td>fullscreen</td></tr>
      <tr><td>T</td><td>theme picker (type to filter)</td></tr>
      <tr><td>/</td><td>command palette (find, themes, everything)</td></tr>
      <tr><td>G</td><td>slide finder (live preview)</td></tr>
      <tr><td>E</td><td>edit speaker notes (dev mode)</td></tr>
      <tr><td>, / .</td><td>cycle theme</td></tr>
      <tr><td>[ / ]</td><td>cycle font</td></tr>
      <tr><td>L / ⇧L</td><td>slide layout — writes the file (dev mode)</td></tr>
      <tr><td>Z / ⇧Z</td><td>undo / redo deck edits (dev mode)</td></tr>
      <tr><td>A</td><td>ask an AI agent to edit the deck (dev mode)</td></tr>
      <tr><td>⌃T</td><td>generate a theme (repeat to re-roll)</td></tr>
      <tr><td>⌃⇧T</td><td>save the generated theme</td></tr>
      <tr><td>?</td><td>this help</td></tr></table></div>`;
    helpEl.addEventListener('click', toggleHelp);
    root.appendChild(helpEl);
  }

  // ----- input -------------------------------------------------------------
  // The messages key: physically the one left of "1". `code` is the layout-
  // independent name for that position; the `key` fallbacks cover browsers or
  // remappings that report no code (` and ~ on US/UK, ² on AZERTY).
  const isMsgKey = (e) => e.code === 'Backquote'
    || e.key === '`' || e.key === '~' || e.key === '²';
  function onKey(e) {
    // Messages (`) — the ONE shortcut that must reach you wherever you are.
    // Every guard below this line drops keys: the notes editor swallows them
    // (a textarea owns its typing), pickers trap them, the finder eats letters
    // into its query. But the message that explains why the voice died has to
    // be readable while presenting AND while editing, so the modifier form is
    // handled first, before any of that — and the bare key falls through to the
    // main table, where a typing surface has already claimed it.
    //
    // Matched on e.code, not e.key: this is the key LEFT OF "1", and what it
    // prints depends on the layout (` on a US keyboard, ² on a French one).
    // The position is the shortcut; the character is an accident.
    if (isMsgKey(e) && (e.metaKey || e.ctrlKey || e.altKey)) {
      toggleMessages();
      e.preventDefault();
      return;
    }
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
    if (transcriptEl) {
      if (e.key === 'Escape') { toggleTranscript(); e.preventDefault(); }
      return; // a reading surface — trap navigation while it's up
    }
    if (editEl) {
      if (e.key === 'Escape') { toggleEditor(); e.preventDefault(); }
      return; // typing surface — the textarea handles its own keys
    }
    if (agentEl) {
      if (e.key === 'Escape') { toggleAgentAsk(); e.preventDefault(); }
      return; // typing surface — the textarea handles its own keys
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
    // positional, so it cannot be a `case` in a switch over e.key
    if (isMsgKey(e)) { toggleMessages(); e.preventDefault(); return; }
    switch (e.key) {
      case 'ArrowRight': case ' ': case 'PageDown': instance.next(); break;
      case 'ArrowLeft': case 'PageUp': instance.prev(); break;
      case 'Home': instance.goto(1, 0); break;
      case 'End': instance.goto(instance.state.totalSlides, 0); break;
      case 'o': case 'O': toggleOverview(); break;
      case 'b': case 'B': toggleBlackout(); break;
      case 'd': case 'D': toggleDebug(); break;
      case 'c': case 'C': toggleCaptions(); break;
      case 'k': case 'K': toggleClock(); break;
      case 'h': case 'H': toggleProgress(); break;
      case 'p': case 'P': toggleNarrPause(); break;
      // G = go/grep — a direct slide-finder key. Deliberately NOT ⌘F:
      // browser find is sacred, and / already belongs to the palette.
      case 'g': case 'G': openSlideFinder(); break;
      case 'e': case 'E': toggleEditor(); break;
      case 'f': case 'F': toggleFullscreen(); break;
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
      case '.': cycleTheme(1); break;
      case ',': cycleTheme(-1); break;
      case '>': changeNarrRate(+0.25); break;  // youtube's ⇧>
      case '<': changeNarrRate(-0.25); break;  // youtube's ⇧<
      case ']': cycleFont(1); break;
      case '[': cycleFont(-1); break;
      case 'l': case 'L': cycleLayout(e.shiftKey ? -1 : 1); break;
      case 'z': case 'Z': deckHistory(e.shiftKey ? 'redo' : 'undo'); break;
      case 'a': case 'A': toggleAgentAsk(); break;
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
  instance.cycleLayout = cycleLayout;                       // L / ⇧L, programmatic (±1); dev mode only
  instance.layoutRing = layoutRing;                         // the ring a slide would cycle (skips applied)
  instance.toggleNarration = toggleNarration;               // V, programmatic
  instance.toggleMessages = toggleMessages;                 // I, programmatic
  instance.messages = messages;                             // [{ at, text }] — every message shown

  // ── narration (V) + picker (N) — SPEC §8 ────────────────────────────────
  // Two sources, one V toggle. RECORDED: pre-rendered per-slide audio
  // (tools/voiceover.mjs, or ⇧V below; config.narration.files = '<dir>' or
  // [{ label, dir, ext }, …] — ext defaults to 'm4a', ⇧V recordings are
  // 'wav'). LIVE: synthesized on the fly per slide through the local bridge
  // (`decklight tts`) — pick a Gemini voice and a delivery tone in the
  // picker; responses are cached per (slide, voice, style) and the next
  // slide is prefetched while the current one plays. N opens the picker
  // (tracks → voices → tones → custom-tone input); choice persists per deck.
  // ⇧V, live voice only: downloads every slide's narration as slide-NN.wav
  // STITCHED FROM THE SENTENCE CACHE (already-heard clips are free; only
  // unheard sentences synthesize), so the deck can later run RECORDED with
  // that set instead of depending on the bridge.
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
  // What the bridge can ACTUALLY speak. We ship the Gemini roster because it is
  // also Chirp's, but the bridge may be running piper — one local model, not
  // thirty star names — and a picker offering 29 voices that silently do nothing
  // is a lie. /ping tells us; until it answers, the built-in roster stands.
  const PING_URL = LIVE_URL.replace(/\/tts\/?$/, '/ping');
  let liveVoices = GEMINI_VOICES;
  let liveStylable = true;  // only gemini takes a delivery instruction
  let liveEngine = null;
  let livePing = null;
  function probeLive() {
    livePing ??= fetch(PING_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p) return null;
        liveEngine = p.engine ?? null;
        if (Array.isArray(p.voices) && p.voices.length) liveVoices = p.voices;
        liveStylable = p.stylable !== false;
        debugLog('tts', `bridge: ${p.engine} · ${p.model} · ${liveVoices.length} voice(s)`
          + (liveStylable ? '' : ' · no style'));
        return p;
      })
      .catch(() => null); // no bridge — the picker still works, V just warns
    return livePing;
  }
  const TONES = [
    // single directive clauses: instruction-shaped text steers; persona
    // sentences ("You're a…") can stochastically be read aloud
    ['Warm senior engineer', 'Read in a warm, welcoming tone, like a friendly battle-hardened senior engineer who is still curious about new technology.'],
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
  // voice speed — YouTube's ⇧< / ⇧> in 0.25× steps, clamped 0.25–2×,
  // persisted per deck; applies to live and recorded narration alike
  const narrRateKey = 'decklight-narr-rate:' + location.pathname;
  let narrRate = 1;
  try {
    const v = parseFloat(localStorage.getItem(narrRateKey) ?? '');
    if (v >= 0.25 && v <= 2) narrRate = v;
  } catch { /* ignore */ }
  function changeNarrRate(delta) {
    narrRate = Math.round(Math.min(2, Math.max(0.25, narrRate + delta)) * 100) / 100;
    try { localStorage.setItem(narrRateKey, String(narrRate)); } catch { /* ignore */ }
    if (narrAudio) narrAudio.playbackRate = narrRate;
    toast(`voice speed ${narrRate}×`);
    debugLog('narr', `rate ${narrRate}×`);
    updateDebugState();
  }
  // Animated lip-synced character (SPEC §8): an overlay whose mouth follows
  // the narration. Live mode rides the sentence pipeline below (prefetch in
  // the lookahead worker, beginSentence per clip); recorded mode loads
  // slide-NN sidecar files. Configured in the N picker ("Character…").
  const character = createCharacter({ root, config, debugLog, toast });
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
  // Build-synced narration: the ⟨CLICK⟩ markers that already segment the
  // notes for the speaker view segment the AUDIO too — segment k narrates
  // build step k (0 = arrival, before any build), exactly like a presenter
  // reading the notes and clicking between segments.
  function notesSegs(sl) {
    const t = instance._sections?.[sl - 1]?.querySelector('aside.notes')?.textContent ?? '';
    return t.split('⟨CLICK⟩').map((s) => s.replace(/\s+/g, ' ').trim());
  }
  // resolves { url, blob }: playback needs the object URL, the ⇧V stitcher
  // needs the raw bytes — one cache serves both
  function synthLive(text, key, label) {
    if (!text) return Promise.resolve(null);
    if (!liveCache.has(key)) {
      const p = (async () => {
        const t0 = Date.now();
        try {
          const res = await fetch(LIVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, voice: liveCfg.voice, style: liveCfg.style }),
          });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const cost = parseFloat(res.headers?.get?.('x-tts-cost') ?? '') || 0;
          if (cost) ttsSpend += cost;
          debugLog('tts', `${label} · ${liveCfg.voice} · ${text.length} chars → ${((Date.now() - t0) / 1000).toFixed(1)}s`
            + (cost ? ` · ~$${cost.toFixed(4)}` : ''));
          return { url: URL.createObjectURL(blob), blob };
        } catch (e) {
          debugLog('tts', `${label} · ${liveCfg.voice} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s (${String(e.message || e)})`);
          throw e;
        }
      })();
      p.catch(() => { if (liveCache.get(key) === p) liveCache.delete(key); });
      liveCache.set(key, p);
    }
    return liveCache.get(key);
  }
  // The live player's unit is a SENTENCE: each ⟨CLICK⟩ segment splits into
  // sentences and every sentence is its own TTS call and cache entry — so
  // the first audio of a beat arrives after one short synthesis, not after
  // the whole paragraph renders.
  function splitSentences(text) {
    return ((text ?? '').match(/[^.!?…]+[.!?…]+[”’"')\]]*|[^.!?…]+$/g) ?? [])
      .map((s) => s.trim()).filter(Boolean);
  }
  const sentenceKey = (sl, step, i) => `${sl}|s${step}|n${i}|${liveCfg.voice}|${liveCfg.style}`;
  function fetchLiveSentence(sl, step, i) {
    const sentence = splitSentences(notesSegs(sl)[step])[i] ?? '';
    return synthLive(sentence, sentenceKey(sl, step, i), `slide ${sl} seg ${step} #${i + 1}`);
  }
  // data-narration="hold": an interactive slide (quiz, exercise, live
  // demo) — narration plays whatever notes it has and builds still sync,
  // but the deck NEVER auto-advances off it; the presenter moves on
  // manually and narration resumes on the next slide.
  const narrationHolds = (sl) => instance._sections[sl - 1]?.dataset.narration === 'hold';
  // ── lookahead buffer ──────────────────────────────────────────────────
  // While live narration is ON, keep the next LIVE_LOOKAHEAD segments
  // synthesized in the background. Low priority by construction: ONE
  // buffer request in flight at a time (plus a small yield between calls),
  // so a foreground play never waits behind a burst — and since buffer and
  // playback share the promise cache, reaching a segment mid-synthesis
  // just awaits the same promise. The loop re-derives its window from the
  // CURRENT position each iteration, so navigation, voice/tone changes
  // (new cache keys) and toggling V off all just work; results land in the
  // (voice, tone) cache and the loop moves on to the next hole.
  const LIVE_LOOKAHEAD = 10; // sentences ahead of the playhead
  const BUFFER_WORKERS = 3;  // parallel low-priority synths
  let bufferGen = 0;
  // the next `count` sentences from the current position, inclusive of the
  // current segment (its unspoken sentences matter), across slide boundaries
  function upcomingSentences(count) {
    const out = [];
    let sl = instance.state.slide;
    let step = instance.state.step;
    while (out.length < count && sl <= instance.state.totalSlides) {
      const segs = notesSegs(sl);
      const max = instance._records[sl - 1] ? instance._records[sl - 1].groups.length : 0;
      for (; step <= max && out.length < count; step++) {
        const n = splitSentences(segs[step]).length;
        for (let i = 0; i < n && out.length < count; i++) out.push([sl, step, i]);
      }
      sl += 1;
      step = 0;
    }
    return out;
  }
  async function fillLiveBuffer() {
    const gen = ++bufferGen; // newest fill wins; stale workers exit
    const worker = async () => {
      while (gen === bufferGen && narrating && narrSet?.live) {
        // find+start is synchronous within a worker's turn, and synthLive
        // registers the promise before awaiting — workers never double-fetch
        const hole = upcomingSentences(LIVE_LOOKAHEAD)
          .find(([sl, step, i]) => !liveCache.has(sentenceKey(sl, step, i)));
        if (!hole) return; // window full — the next slide/build event re-arms
        try {
          await fetchLiveSentence(hole[0], hole[1], hole[2]);
          // the character's lip-sync data prefetches through the SAME
          // window: hand the sentence's audio promise to the controller so
          // visemes/video for the next 10 sentences warm alongside the voice
          if (character.mode !== 'off') {
            const [sl, step, i] = hole;
            character.prefetchSentence(sentenceKey(sl, step, i),
              liveCache.get(sentenceKey(sl, step, i)),
              splitSentences(notesSegs(sl)[step])[i] ?? '');
          }
        } catch {
          return; // bridge unreachable — stop; the next event retries
        }
        await new Promise((r) => setTimeout(r, 30)); // yield to foreground
      }
    };
    await Promise.all(Array.from({ length: BUFFER_WORKERS }, worker));
  }

  // When a segment finishes, reveal the next build; after the last step,
  // move to the next slide. Guarded on (slide, step) so any manual
  // navigation mid-clip silently wins over the pending advance.
  let liveSegGen = 0; // cancels pending silent-beat timers and stale onended
  let narrPaused = false;     // P — freezes audio, captions and auto-advance
  let liveChainActive = false; // a sentence chain is running for liveChainGen
  let liveChainGen = 0;
  function toggleNarrPause() {
    if (!narrating) { toast('narration is off — V starts it'); return; }
    narrPaused = !narrPaused;
    if (narrPaused) {
      narrAudio?.pause();
    } else if (narrAudio?.src && narrAudio.paused && !narrAudio.ended && narrAudio.currentTime > 0) {
      narrAudio.play().catch(() => { /* autoplay policy */ }); // resume mid-sentence
    } else if (!liveChainActive) {
      playLive(); // nothing parked (e.g. paused on a silent beat) — re-arm
    } // else: the parked chain's pause-gate resumes on its own
    toast(narrPaused ? '⏸ narration paused — P resumes' : '▶ narration resumed');
    debugLog('narr', narrPaused ? 'paused' : 'resumed');
    updateDebugState();
  }
  function advanceFrom(sl, step) {
    if (!narrating || narrPaused || !narrSet?.live) return;
    if (instance.state.slide !== sl || instance.state.step !== step) return;
    const rec = instance._records[sl - 1];
    if (step < (rec ? rec.groups.length : 0)) instance.next();
    else if (!narrationHolds(sl) && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
  }
  async function playLive() {
    const sl = instance.state.slide, step = instance.state.step;
    const gen = ++liveSegGen;
    fillLiveBuffer(); // (re-)arm the lookahead from the new position
    if (!notesText(sl)) {
      if (narrationHolds(sl)) { debugLog('narr', `hold on slide ${sl} — manual advance`); return; }
      // nothing to say on this slide at all — skip it after a short beat
      setTimeout(() => {
        if (gen !== liveSegGen || !narrating || !narrSet?.live) return;
        if (instance.state.slide === sl && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
      }, 400);
      return;
    }
    const segs = notesSegs(sl);
    if (!segs[step]) {
      // a build beat with no words — reveal the next step after a pause
      setTimeout(() => { if (gen === liveSegGen) advanceFrom(sl, step); }, 600);
      return;
    }
    // speak the segment SENTENCE BY SENTENCE: each sentence is one cached
    // clip (short time-to-first-audio), the caption follows the spoken
    // sentence, and the build advances only after the segment's last one
    const sentences = splitSentences(segs[step]);
    const stale = () => gen !== liveSegGen || !narrating || instance.state.slide !== sl || instance.state.step !== step;
    liveChainGen = gen;
    liveChainActive = true;
    let spoke = 0;
    try {
      for (let i = 0; i < sentences.length; i++) {
        while (narrPaused) { // P holds the chain between sentences too
          if (stale()) return;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (stale()) return;
        let clip;
        try {
          clip = await fetchLiveSentence(sl, step, i);
        } catch (err) {
          // The VOICE IS THE CLOCK. If it cannot speak, the deck must not keep
          // moving: auto-advancing in silence would walk the talk past slides
          // nobody has heard, and the presenter — watching the slides, not the
          // console — would have no idea why. Stop, and say what happened.
          debugLog('narr', `sentence failed (slide ${sl} seg ${step} #${i + 1}) — narration stopped`);
          stopNarration(liveFailure(err));
          return;
        }
        if (stale()) return;
        if (!clip) continue;
        setCaption(sentences[i]); // captions follow the voice, not the notes
        narrAudio ??= new Audio();
        // character is strictly opt-in: with mode 'off' narration runs with
        // zero lip-sync footprint. When on, begin* is fire-and-forget —
        // audio never waits on lip-sync; a late timeline lands mid-sentence
        // and the fallback animates until it does.
        if (character.mode !== 'off') {
          character.attachAudio(narrAudio);
          character.beginSentence(sentenceKey(sl, step, i), clip, sentences[i]);
        }
        narrAudio.src = clip.url;
        narrAudio.playbackRate = narrRate;
        let blocked = false;
        await new Promise((done) => {
          narrAudio.onended = done;
          narrAudio.play().catch(() => { blocked = true; done(); });
        });
        if (blocked) {
          // the browser refused to play unprompted — the audio exists, so this
          // is one click away, and the deck waits rather than running on mute
          stopNarration('🔇 the browser blocked audio — click the deck once, then V — the slides wait for the voice');
          return;
        }
        spoke++;
      }
      if (stale()) return;
      // Nothing spoken, but words to speak: the audio never played, so the deck
      // must not move on. (A segment with no words at all is a legitimate silent
      // beat and still advances.)
      if (!spoke && sentences.length) {
        stopNarration('🔇 the voice did not play — auto-advance stopped · press the key left of 1 for messages');
        return;
      }
      advanceFrom(sl, step);
    } finally {
      if (liveChainGen === gen) liveChainActive = false;
    }
  }
  // What went wrong, in the presenter's words — and what to do about it. The
  // bridge throws the HTTP status; a dead bridge throws a TypeError from fetch.
  function liveFailure(err) {
    const s = String(err?.message ?? err);
    if (s.startsWith('429')) {
      return '🔇 voice quota exceeded (429) — auto-advance stopped · a free engine: decklight dev --tts-engine chirp';
    }
    if (/^\d{3}/.test(s)) {
      return `🔇 voice bridge error ${s.slice(0, 3)} — auto-advance stopped · press the key left of 1 for messages`;
    }
    return '🔇 voice bridge unreachable — auto-advance stopped · start it with: decklight tts';
  }
  function playSlideFile() {
    if (!narrSet) return;
    if (narrSet.live) return playLive();
    // A slide with nothing to say has no file, and that is NOT a failure: the
    // pre-render tool only emits audio for slides that have notes (the showcase
    // is 30 slides and 20 clips). Warning here would fire ten times on a deck
    // that is behaving perfectly — so only a slide that SHOULD speak can complain.
    if (!notesText(instance.state.slide)) { narrAudio?.pause(); return; }
    narrAudio ??= new Audio();
    // state.slide and the files are BOTH 1-based (slide-01 = first section).
    // ext defaults to the pre-render tool's .m4a; ⇧V-recorded sets are .wav.
    const file = `${narrSet.dir}/slide-${String(instance.state.slide).padStart(2, '0')}.${narrSet.ext ?? 'm4a'}`;
    narrAudio.src = file;
    narrAudio.playbackRate = narrRate;
    if (character.mode !== 'off') {
      character.attachAudio(narrAudio);
      character.beginSlide(narrSet, instance.state.slide);
    }
    // a track with no file for this slide used to fail in total silence — with
    // nothing on screen, an unnarrated slide is indistinguishable from a broken one
    narrAudio.onerror = () => {
      debugLog('narr', `no audio: ${file}`);
      toast(`🔇 no narration for slide ${instance.state.slide} (${file}) · press the key left of 1 for messages`);
    };
    narrAudio.play().catch(() => {
      toast('🔇 the browser blocked audio — click the deck once, then V');
    });
  }
  // the one teardown: V, and the bridge giving up, must leave the same state
  function stopNarration(msg = 'narration off') {
    narrating = false;
    liveSegGen++; // cancel any pending silent-beat advance
    bufferGen++;  // stop the lookahead loop
    narrPaused = false;
    narrAudio?.pause();
    character.stop();
    toast(msg);
    debugLog('narr', msg);
    syncSoundBtn();
  }
  function toggleNarration() {
    if (!narrSet) { openNarrPicker(narrSets.length ? 'tracks' : 'voices'); return; }
    if (narrating) return stopNarration();
    narrating = true;
    liveWarned = false;
    const what = narrSet.live ? `⚡ ${liveCfg.voice} · ${liveCfg.tone}` : narrSet.label;
    toast(`🔊 ${what} — V stops · N picks`);
    debugLog('narr', `on — ${what}`);
    playSlideFile();
    syncSoundBtn();
  }
  instance.on('slide', () => { if (narrating) playSlideFile(); });
  // builds re-sync the live voice too — whether the advance came from the
  // narration itself or from the presenter pressing → mid-sentence
  instance.on('build', () => { if (narrating && narrSet?.live) playLive(); });

  // ── closed captions (C) — SPEC §8 ────────────────────────────────────────
  // YouTube-style captions: the CURRENT notes segment (the same text the
  // live voice speaks) in a bar at the bottom, synced to slide/step. Works
  // with narration on or off — it's the deck's transcript. Persists per deck.
  const captionsKey = 'decklight-captions:' + location.pathname;
  let captionsOn = false;
  try { captionsOn = localStorage.getItem(captionsKey) === '1'; } catch { /* ignore */ }
  let captionEl = null;
  function setCaption(text) {
    if (!captionEl) return;
    captionEl.textContent = text;
    captionEl.classList.toggle('show', !!text);
  }
  function updateCaption() {
    if (!captionEl) return;
    // while the live voice speaks, the sentence chain owns the caption —
    // never flash the whole segment; the next spoken sentence fills it
    if (narrating && narrSet?.live) { setCaption(''); return; }
    setCaption(notesSegs(instance.state.slide)[instance.state.step] ?? '');
  }
  function showCaptions() {
    captionEl = document.createElement('div');
    captionEl.className = 'decklight-captions';
    captionEl.setAttribute('aria-live', 'polite');
    root.appendChild(captionEl);
    updateCaption();
  }
  function toggleCaptions() {
    captionsOn = !captionsOn;
    try { localStorage.setItem(captionsKey, captionsOn ? '1' : '0'); } catch { /* ignore */ }
    if (captionsOn) showCaptions();
    else { captionEl?.remove(); captionEl = null; }
    toast(`captions ${captionsOn ? 'on' : 'off'}`);
    debugLog('narr', `captions ${captionsOn ? 'on' : 'off'}`);
  }
  instance.on('slide', updateCaption);
  instance.on('build', updateCaption);
  if (captionsOn && !printMode) showCaptions();

  // ── presenter clock (K) — SPEC §8 ─────────────────────────────────────────
  // Wall time + elapsed talk time under the slide number — the two numbers a
  // presenter otherwise checks a phone for, and the room notices a phone.
  // Elapsed counts from the deck's FIRST advance, not page load: a deck
  // idling on its title slide while people file in is not a talk yet.
  // Off by default; persists per deck. Never rendered in ?print.
  const clockKey = 'decklight-clock:' + location.pathname;
  let clockOn = false;
  try { clockOn = localStorage.getItem(clockKey) === '1'; } catch { /* ignore */ }
  let clockEl = null, clockTimer = null, talkStart = null, clockArmed = false;
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    return (h ? h + ':' : '') + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    clockEl.querySelector('.clk-time').textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    clockEl.querySelector('.clk-elapsed').textContent =
      '+' + fmtElapsed(talkStart == null ? 0 : Date.now() - talkStart);
  }
  function showClock() {
    clockEl = document.createElement('div');
    clockEl.className = 'decklight-clock';
    clockEl.innerHTML = '<span class="clk-time"></span><span class="clk-elapsed"></span>';
    root.appendChild(clockEl);
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
  }
  function toggleClock() {
    clockOn = !clockOn;
    try { localStorage.setItem(clockKey, clockOn ? '1' : '0'); } catch { /* ignore */ }
    if (clockOn) showClock();
    else { clearInterval(clockTimer); clockTimer = null; clockEl?.remove(); clockEl = null; }
    toast(`clock ${clockOn ? 'on' : 'off'}`);
    debugLog('nav', `clock ${clockOn ? 'on' : 'off'}`);
  }
  // Arm only after init's opening goto (and any deep-link landing): the
  // first navigation AFTER ready is the start of the talk.
  instance.on('ready', () => { clockArmed = true; });
  const startTalk = () => {
    if (!clockArmed || talkStart != null) return;
    talkStart = Date.now();
    updateClock();
  };
  instance.on('slide', startTalk);
  instance.on('build', startTalk);
  instance.toggleClock = toggleClock; // K programmatically
  if (clockOn && !printMode) showClock();

  // ── progress bar (H) — SPEC §8 ────────────────────────────────────────────
  // A hairline along the bottom edge whose width IS the position in the deck —
  // the shape of the talk at a glance, without counting slides. A passive
  // readout of state.slide/step (the fraction _updateChrome computes); it
  // never drives navigation or auto-advance.
  // Off by default; persists per deck. Never rendered in ?print.
  const progressKey = 'decklight-progress:' + location.pathname;
  let progressOn = false;
  try { progressOn = localStorage.getItem(progressKey) === '1'; } catch { /* ignore */ }
  let progressEl = null;
  function showProgress() {
    progressEl = document.createElement('div');
    progressEl.className = 'decklight-progress';
    progressEl.innerHTML = '<div class="bar"></div>';
    root.appendChild(progressEl);
    progressBar = progressEl.querySelector('.bar');
    instance._updateChrome(); // arrive at the current width, not a sweep from 0
  }
  function toggleProgress() {
    progressOn = !progressOn;
    try { localStorage.setItem(progressKey, progressOn ? '1' : '0'); } catch { /* ignore */ }
    if (progressOn) showProgress();
    else { progressEl?.remove(); progressEl = null; progressBar = null; }
    toast(`progress bar ${progressOn ? 'on' : 'off'}`);
    debugLog('nav', `progress bar ${progressOn ? 'on' : 'off'}`);
  }
  instance.toggleProgress = toggleProgress; // H programmatically
  if (progressOn && !printMode) showProgress();

  // ── transcript (palette command) — SPEC §8 ───────────────────────────────
  // The deck's full spoken script: every slide's notes segments, in order,
  // in a scrollable overlay (titles jump to their slide) with .txt and .md
  // export — the same segmentation narration and captions use.
  function transcriptData() {
    return (instance._sections || []).map((s, i) => ({
      n: i + 1,
      title: s.querySelector('h1, h2, h3')?.textContent.trim() || `Slide ${i + 1}`,
      segs: notesSegs(i + 1).filter(Boolean),
    }));
  }
  function transcriptString(md) {
    const title = (document.title || 'Deck').trim();
    const out = md ? [`# ${title} — transcript`, ''] : [`${title} — transcript`, ''];
    for (const { n, title: t, segs } of transcriptData()) {
      if (!segs.length) continue;
      out.push(md ? `## ${n}. ${t}` : `${n}. ${t}`, '');
      for (const seg of segs) out.push(seg, '');
    }
    return out.join('\n');
  }
  function downloadTranscript(kind) {
    const md = kind === 'md';
    const url = URL.createObjectURL(new Blob([transcriptString(md)], { type: md ? 'text/markdown' : 'text/plain' }));
    const base = (location.pathname.split('/').pop() || 'deck').replace(/\.html?$/i, '');
    downloadFromUrl(url, `${base}-transcript.${md ? 'md' : 'txt'}`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    debugLog('narr', `transcript exported (.${md ? 'md' : 'txt'})`);
  }
  let transcriptEl = null;
  function toggleTranscript() {
    if (transcriptEl) { transcriptEl.remove(); transcriptEl = null; return; }
    transcriptEl = document.createElement('div');
    transcriptEl.className = 'decklight-narr decklight-transcript';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = 'transcript — the deck’s spoken notes · Esc closes';
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    for (const [label, kind] of [['⬇ export .txt', 'txt'], ['⬇ export .md', 'md']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'narr-prev-btn';
      b.textContent = label;
      b.addEventListener('click', () => downloadTranscript(kind));
      actions.appendChild(b);
    }
    card.append(head, actions);
    for (const { n, title, segs } of transcriptData()) {
      if (!segs.length) continue;
      const sec = document.createElement('div');
      sec.className = 'tr-slide';
      const t = document.createElement('div');
      t.className = 'tr-title';
      t.textContent = `${n} · ${title}`;
      t.title = 'jump to this slide';
      t.addEventListener('click', () => { toggleTranscript(); instance.goto(n, 0, { force: true }); });
      sec.appendChild(t);
      for (const seg of segs) {
        const p = document.createElement('p');
        p.className = 'tr-seg';
        p.textContent = seg;
        sec.appendChild(p);
      }
      card.appendChild(sec);
    }
    transcriptEl.appendChild(card);
    transcriptEl.addEventListener('click', (e) => { if (e.target === transcriptEl) toggleTranscript(); });
    root.appendChild(transcriptEl);
  }
  instance.transcript = { open: toggleTranscript, text: () => transcriptString(false), markdown: () => transcriptString(true) };

  // ── edit mode (E) + live reload — SPEC §8 ────────────────────────────────
  // Served by `decklight edit`: the deck subscribes to /edit/events and
  // reloads whenever the file changes on disk (any editor works — the
  // #/slide/step hash restores the position). E opens a notes editor whose
  // Save writes the current slide's aside back through the server. Decks
  // opened via file:// probe the server at its default localhost port
  // (CORS-open, like the tts bridge) — the printed URL and a double-clicked
  // file both work; config.edit.url overrides. A basename guard refuses to
  // wire up against a server that's editing a DIFFERENT deck.
  let editAvailable = false;
  let editBase = '';
  let editAgents = [];   // [{name, label}] the dev machine can run
  let agentBusy = null;  // {agent, prompt, startedAt} while a one-shot runs
  if (!printMode && !params.has('embedded')) {
    const bases = config.edit?.url ? [config.edit.url]
      : /^https?:$/.test(location.protocol) ? [''] : ['http://127.0.0.1:8788'];
    (async () => {
      for (const base of bases) {
        try {
          const r = await fetch(base + '/edit/ping');
          if (!r.ok) continue;
          const j = await r.json();
          if (!j?.ok) continue;
          const here = decodeURIComponent(location.pathname.split('/').pop() || '');
          if (here && j.name && here !== j.name) {
            debugLog('edit', `server edits ${j.name}, this deck is ${here} — not wiring up`);
            continue;
          }
          editBase = base;
          editAvailable = true;
          editAgents = Array.isArray(j.agents) ? j.agents : [];
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          const es = new EventSource(base + '/edit/events');
          es.onmessage = () => location.reload();
          es.addEventListener('agent', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.state === 'start') {
                agentBusy = d;
                toast(`🤖 ${d.agent} is editing the deck…`, 2200);
                debugLog('agent', `${d.agent} start: ${(d.prompt || '').slice(0, 80)}`);
              } else if (d.state === 'done') {
                agentBusy = null;
                const status = d.ok ? '' : d.error ? ` — ${d.error}` : ` (exit ${d.code})`;
                toast(d.changed ? `🤖 ${d.agent} edited the deck — Z undoes${status}`
                  : `🤖 ${d.agent} finished — no changes${status}`, 3000);
                debugLog('agent', `${d.agent} done ok=${d.ok} changed=${d.changed}${status}`);
              }
            } catch { /* malformed event */ }
          });
          debugLog('edit', `live reload connected${base ? ` (${base})` : ''}`
            + (editAgents.length ? ` · agents: ${editAgents.map((a) => a.name).join(', ')}` : ''));
          return;
        } catch { /* not served by decklight edit */ }
      }
    })();
  }

  // undo/redo (Z / ⇧Z) — the dev server's edit history: layout picks, notes
  // saves, and agent runs all snapshot into ONE stack, wholly independent of
  // the git autocommits. The server writes the restored file; its watcher
  // then reloads every browser (the hash keeps the position).
  async function deckHistory(dir) {
    if (!editAvailable) {
      toast(`${dir} needs dev mode — run: decklight dev <deck.html>`, 2600);
      return;
    }
    try {
      const res = await fetch(editBase + '/edit/' + dir, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || `${dir} failed`); return; }
      toast(`${dir} — ${j.undo} back · ${j.redo} forward`);
      debugLog('edit', `${dir} → ${j.undo} back, ${j.redo} forward`);
    } catch {
      toast(`${dir} failed — is the dev server still up?`, 2200);
    }
  }

  // ask an agent (A) — hand an installed coding agent (claude, codex, bob, …)
  // a one-shot editing task; the file watcher reloads the deck when it saves,
  // and the server snapshots first so Z takes the agent's edit back.
  let agentEl = null;
  function toggleAgentAsk() {
    if (agentEl) { agentEl.remove(); agentEl = null; return; }
    if (!editAvailable) {
      toast('asking an agent needs dev mode — run: decklight dev <deck.html>', 2600);
      return;
    }
    if (!editAgents.length) {
      toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600);
      return;
    }
    if (agentBusy) {
      toast(`${agentBusy.agent} is still working on the last ask`, 2200);
      return;
    }
    agentEl = document.createElement('div');
    agentEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `ask an agent — edits the deck file · ⌘⏎ sends · Esc closes`;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    ta.placeholder = `e.g. "make slide ${instance.state.slide} a split layout with the diagram on the left"`;
    ta.spellcheck = false;
    let pickedAgent = editAgents[0].name;
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    if (editAgents.length > 1) {
      const sel = document.createElement('select');
      sel.className = 'narr-prev-btn';
      for (const a of editAgents) {
        const o = document.createElement('option');
        o.value = a.name;
        o.textContent = a.label;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { pickedAgent = sel.value; });
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      actions.appendChild(sel);
    }
    const send = async () => {
      const prompt = ta.value.trim();
      if (!prompt) return;
      try {
        const res = await fetch(editBase + '/edit/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, agent: pickedAgent }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || res.status);
        toggleAgentAsk();
        // progress lands as SSE 'agent' events → toasts; the reload follows the save
      } catch (e) {
        toast(`ask failed: ${String(e.message || e).slice(0, 60)}`, 2200);
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { send(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleAgentAsk(); e.preventDefault(); }
      e.stopPropagation();
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '🤖 send to agent';
    btn.addEventListener('click', send);
    actions.appendChild(btn);
    card.append(head, ta, actions);
    agentEl.appendChild(card);
    agentEl.addEventListener('click', (e) => { if (e.target === agentEl) toggleAgentAsk(); });
    root.appendChild(agentEl);
    setTimeout(() => ta.focus(), 0);
  }
  let editEl = null;
  function toggleEditor() {
    if (editEl) { editEl.remove(); editEl = null; return; }
    const sl = instance.state.slide;
    if (!editAvailable) {
      toast('edit mode needs the server — run: decklight edit <deck.html>', 2200);
      return;
    }
    if (instance._sections[sl - 1]?.hasAttribute('data-was-markdown')) {
      toast('markdown-authored slide — its notes live in the template; edit the file', 2200);
      return;
    }
    editEl = document.createElement('div');
    editEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `edit notes — slide ${sl} · ⌘⏎ saves · Esc closes`;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    ta.value = notesSegs(sl).filter((s, i, a) => s || i < a.length).join('\n\n⟨CLICK⟩\n\n');
    ta.spellcheck = false;
    const save = async () => {
      try {
        const res = await fetch(editBase + '/edit/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide: sl, text: ta.value }),
        });
        if (!res.ok) throw new Error(await res.text());
        debugLog('edit', `notes saved — slide ${sl}`);
        toast('notes saved — reloading');
        // the server's watcher broadcasts the reload; nothing else to do
      } catch (e) {
        toast(`save failed: ${String(e.message || e).slice(0, 60)}`);
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { save(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleEditor(); e.preventDefault(); }
      e.stopPropagation();
    });
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '💾 save to file';
    btn.addEventListener('click', save);
    actions.appendChild(btn);
    card.append(head, ta, actions);
    editEl.appendChild(card);
    editEl.addEventListener('click', (e) => { if (e.target === editEl) toggleEditor(); });
    root.appendChild(editEl);
    setTimeout(() => ta.focus(), 0);
  }
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

  // ----- touch controls (mount) -------------------------------------------
  // Everything they need (toggleFullscreen, toggleNarration, narrSets) is
  // now in scope. Fullscreen always; sound only when narration is available.
  if (!printMode) {
    const tc = document.createElement('div');
    tc.className = 'decklight-touch-controls';
    fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'decklight-touch-btn';
    fsBtn.setAttribute('aria-label', 'Fullscreen');
    fsBtn.innerHTML = TC_ICON.full;
    fsBtn.addEventListener('click', toggleFullscreen);
    tc.appendChild(fsBtn);
    if (narrSets.length) {
      soundBtn = document.createElement('button');
      soundBtn.type = 'button';
      soundBtn.className = 'decklight-touch-btn';
      // swallow pointerdown so the ?voiceover first-gesture arm (on window)
      // doesn't fire on this very tap and immediately undo the toggle
      soundBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      soundBtn.addEventListener('click', () => toggleNarration());
      tc.appendChild(soundBtn);
      syncSoundBtn();
    }
    root.appendChild(tc);
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
    debugLog('narr', `live config — ${liveCfg.voice} · ${liveCfg.tone}`);
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
    else if (narrView === 'charvideo') renderNarr('character');
    else if ((narrView === 'voices' || narrView === 'character') && narrSets.length) renderNarr('tracks');
    else closeNarrPicker();
  }
  let charProbed = false; // one bridge probe per picker open
  function applyCharacter(m, opts) {
    character.setMode(m, opts);
    closeNarrPicker();
    toast(m === 'off' ? 'character off'
      : m === 'viseme' ? `🎭 character on — lips follow the narration${narrating ? '' : ' · V starts it'}`
        : `🎥 character video — ${character.engine} · ${character.portrait}${narrating ? '' : ' · V starts narration'}`);
  }
  // solo: the narrator centre stage, the slide out of the way (SPEC §8)
  function applySolo(v) {
    if (character.mode === 'off') {
      toast('turn the character on first — N · Character…');
      return;
    }
    character.setSolo(v);
    closeNarrPicker();
    toast(v ? '🎭 solo — the narrator has the stage · N brings the slides back'
      : 'solo off — the slides are back');
  }
  // ▶ voice preview: speaks a short test sentence through the live bridge
  // in the row's voice (neutral tone), so voices can be auditioned before
  // committing. TWO caches (voice → promise of a blob URL): the DEFAULT
  // sentence's cache is permanent — once an entry resolves it is never
  // invalidated — while the custom cache holds exactly one sentence and is
  // swapped out (old blobs freed) when the user's text changes. After any
  // preview plays, the remaining 29 voices prefetch sequentially in the
  // background, so auditioning the roster becomes instant.
  const PREVIEW_DEFAULT = 'Hey, this is Decklight';
  let previewText = PREVIEW_DEFAULT;
  let previewAudio = null;
  const previewDefaultCache = new Map();
  let previewCustomCache = new Map();
  let previewCustomText = null;
  const previewPrefetching = new Set(); // texts with a prefetch loop running
  function previewCacheFor(text) {
    if (text === PREVIEW_DEFAULT) return previewDefaultCache;
    if (text !== previewCustomText) {
      // new custom sentence: retire the old bucket and free its audio
      for (const p of previewCustomCache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      previewCustomCache = new Map();
      previewCustomText = text;
    }
    return previewCustomCache;
  }
  const previewKey = (voice, style) => `${voice}|${style || ''}`;
  function ensurePreviewIn(cache, voice, text, style = '') {
    const key = previewKey(voice, style);
    if (!cache.has(key)) {
      const p = (async () => {
        const t0 = Date.now();
        const res = await fetch(LIVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice, style }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const cost = parseFloat(res.headers?.get?.('x-tts-cost') ?? '') || 0;
        if (cost) ttsSpend += cost;
        debugLog('tts', `preview ${voice}${style ? ' (styled)' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
          + (cost ? ` · ~$${cost.toFixed(4)}` : ''));
        return URL.createObjectURL(blob);
      })();
      // failures self-evict so a retry can succeed; resolved entries stay
      p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
      cache.set(key, p);
    }
    return cache.get(key);
  }
  async function prefetchPreviews(text, list, tag) {
    const runKey = `${tag}|${text}`;
    if (previewPrefetching.has(runKey)) return;
    previewPrefetching.add(runKey);
    const isDefault = text === PREVIEW_DEFAULT;
    const cache = isDefault ? previewDefaultCache : previewCustomCache;
    try {
      debugLog('narr', `preview prefetch ${tag} (${isDefault ? 'default' : 'custom'} sentence)`);
      // sequential on purpose: the bridge synthesizes serially and a burst
      // of parallel POSTs would just queue-jump the presenter's own clicks
      for (const { voice, style } of list) {
        if (!isDefault && previewCustomText !== text) return; // superseded
        if (cache.has(previewKey(voice, style))) continue;
        await ensurePreviewIn(cache, voice, text, style).catch(() => { /* background — no toast */ });
      }
      debugLog('narr', `preview prefetch ${tag} complete`);
    } finally {
      previewPrefetching.delete(runKey);
    }
  }
  // spec: { voice, style, prefetch } — voice rows preview neutral delivery
  // and warm the whole roster; tone rows preview the drafted voice in that
  // delivery style and warm the other tones for the same voice.
  function previewClip({ voice, style = '', prefetch }, btn) {
    const text = previewText.trim();
    if (!text) return;
    const cache = previewCacheFor(text);
    if (btn) btn.textContent = '…';
    ensurePreviewIn(cache, voice, text, style).then((url) => {
      if (btn?.isConnected) btn.textContent = '▶';
      previewAudio ??= new Audio();
      previewAudio.src = url;
      previewAudio.play().catch(() => { /* autoplay policy */ });
      debugLog('narr', `preview ${voice}${style ? ' · styled' : ''}`);
      if (prefetch === 'voices') {
        prefetchPreviews(text, GEMINI_VOICES.map(([n]) => ({ voice: n, style: '' })), 'voices');
      } else if (prefetch === 'tones') {
        prefetchPreviews(text, TONES.map(([, s]) => ({ voice, style: s })), `tones:${voice}`);
      }
    }).catch(() => {
      if (btn?.isConnected) btn.textContent = '▶';
      toast('live voice bridge unreachable — run: decklight tts');
      debugLog('narr', `preview ${voice} failed`);
    });
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
      narrRows.push({
        text: '🧑 Character — animated narrator…',
        cur: character.mode !== 'off',
        commit: () => renderNarr('character'),
      });
    } else if (view === 'character') {
      head.textContent = 'character — an animated narrator lip-syncs the voice';
      // availability comes from the lipsync bridge; probe once per picker
      // open and re-render when the answer lands
      if (!charProbed) {
        charProbed = true;
        character.probe().then(() => { if (narrEl && narrView === 'character') renderNarr('character'); });
      }
      const bi = character.bridgeInfo;
      const vids = bi?.engines?.video ?? [];
      narrRows.push({ text: 'Off', cur: character.mode === 'off', commit: () => applyCharacter('off') });
      narrRows.push({
        text: `🎭 2D character — offline visemes${bi?.engines?.viseme ? '' : ' <span class="narr-flavor">bridge offline — amplitude fallback</span>'}`,
        html: true,
        cur: character.mode === 'viseme',
        commit: () => applyCharacter('viseme'),
      });
      narrRows.push({
        text: `🎥 Neural video — local GPU${vids.length ? '…' : ' <span class="narr-flavor">needs the bridge — run: decklight lipsync</span>'}`,
        html: true,
        cur: character.mode === 'video',
        commit: () => {
          if (vids.length) renderNarr('charvideo');
          else toast('video needs wav2lip/sadtalker on the bridge — run: decklight lipsync');
        },
      });
      // a toggle, not a mode: solo works with either look above
      if (character.mode !== 'off') {
        narrRows.push({
          text: `${character.solo ? '◉' : '○'} Solo — the narrator takes the stage <span class="narr-flavor">slide content steps aside</span>`,
          html: true,
          cur: character.solo,
          commit: () => applySolo(!character.solo),
        });
      }
    } else if (view === 'charvideo') {
      head.textContent = 'neural video — pick engine · portrait';
      const bi = character.bridgeInfo;
      for (const eng of bi?.engines?.video ?? []) {
        for (const p of (bi?.portraits?.length ? bi.portraits : ['default'])) {
          narrRows.push({
            text: `🎥 ${eng} · ${p}`,
            cur: character.mode === 'video' && character.engine === eng && character.portrait === p,
            commit: () => applyCharacter('video', { engine: eng, portrait: p }),
          });
        }
      }
    } else if (view === 'voices') {
      head.textContent = 'live voice — pick a voice · ▶ previews';
      const wrap = document.createElement('div');
      wrap.className = 'narr-preview-row';
      const test = document.createElement('input');
      test.className = 'narr-input narr-preview-text';
      test.value = previewText;
      test.placeholder = 'Preview sentence';
      test.setAttribute('aria-label', 'Preview sentence');
      test.addEventListener('input', () => { previewText = test.value; });
      // onKey ignores inputs; only Escape needs wiring (back out of the view)
      test.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { narrBack(); e.preventDefault(); }
        e.stopPropagation();
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'narr-prev-btn narr-reset-btn';
      reset.textContent = '↺';
      reset.title = 'restore the default sentence';
      reset.setAttribute('aria-label', 'restore the default preview sentence');
      reset.addEventListener('click', (e) => {
        e.stopPropagation();
        previewText = PREVIEW_DEFAULT;
        test.value = PREVIEW_DEFAULT;
      });
      wrap.append(test, reset);
      card.appendChild(wrap);
      liveVoices.forEach(([name, flavor]) => narrRows.push({
        text: `${name} <span class="narr-flavor">${flavor}</span>`,
        html: true,
        preview: { voice: name, style: '', prefetch: 'voices' },
        cur: narrSet?.live && liveCfg.voice === name,
        // chirp and piper have no delivery-instruction channel, so there is no
        // tone to pick — committing the voice IS the whole choice
        commit: () => {
          liveDraft = name;
          if (liveStylable) return renderNarr('tones');
          applyLive(liveEngine ?? 'plain', '');
        },
      }));
    } else if (view === 'tones') {
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — pick a tone · ▶ previews`;
      TONES.forEach(([label, styleText]) => narrRows.push({
        text: label,
        preview: { voice: liveDraft ?? liveCfg.voice, style: styleText, prefetch: 'tones' },
        cur: narrSet?.live && liveCfg.tone === label,
        commit: () => applyLive(label, styleText),
      }));
      narrRows.push({ text: 'Custom…', cur: narrSet?.live && liveCfg.tone === 'Custom', commit: () => renderNarr('custom') });
    } else { // custom tone input
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — type the delivery instruction · ▶ previews`;
      const wrap = document.createElement('div');
      wrap.className = 'narr-preview-row';
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
      // audition the typed instruction before committing it with Enter
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'narr-prev-btn narr-reset-btn';
      prev.textContent = '▶';
      prev.title = 'preview this delivery instruction';
      prev.setAttribute('aria-label', 'preview this delivery instruction');
      prev.addEventListener('click', (e) => {
        e.stopPropagation();
        const style = input.value.trim();
        if (style) previewClip({ voice: liveDraft ?? liveCfg.voice, style }, prev);
      });
      wrap.append(input, prev);
      card.appendChild(wrap);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      narrRows = [];
      narrSel = 0;
      return;
    }
    narrRows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'narr-row' + (row.cur ? ' narr-cur' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      if (row.html) label.innerHTML = row.text; else label.textContent = row.text;
      el.appendChild(label);
      if (row.preview) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'narr-prev-btn';
        btn.textContent = '▶';
        btn.title = `preview ${row.preview.voice}`;
        btn.setAttribute('aria-label', `preview ${row.preview.voice}`);
        btn.addEventListener('click', (e) => { e.stopPropagation(); previewClip(row.preview, btn); });
        el.appendChild(btn);
      }
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
    // ask the bridge what it can speak, and repaint if the answer changes the
    // list under the user — but only while they are still looking at it
    probeLive().then((p) => { if (p && narrEl && narrView === 'voices') renderNarr('voices'); });
  }
  function closeNarrPicker() {
    narrEl?.remove();
    narrEl = null;
    charProbed = false; // next open re-probes the lipsync bridge
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
        <div class="rec-line">${n} slide${n === 1 ? '' : 's'} stitched from the sentence cache — only unheard sentences synthesize</div>
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
  // Slide files are STITCHED FROM THE SENTENCE CACHE: every clip already
  // played (or warmed by the lookahead buffer) is reused as-is — only the
  // sentences never spoken get synthesized. Clips are joined with short
  // silences (breath between sentences, a longer beat between builds).
  const SENT_GAP_S = 0.15;
  const SEG_GAP_S = 0.35;
  function stitchWav(chunks, rate) {
    const dataLen = chunks.reduce((n, c) => n + c.length, 0);
    const h = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
    w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    w(36, 'data'); h.setUint32(40, dataLen, true);
    return new Blob([h.buffer, ...chunks], { type: 'audio/wav' });
  }
  const silencePcm = (rate, seconds) => new Uint8Array(2 * Math.round(rate * seconds));
  async function stitchSlideWav(sl, run) {
    const rec = instance._records[sl - 1];
    const max = rec ? rec.groups.length : 0;
    const segs = notesSegs(sl);
    const chunks = [];
    let rate = 24000;
    for (let step = 0; step <= max; step++) {
      const sentences = splitSentences(segs[step]);
      for (let i = 0; i < sentences.length; i++) {
        const clip = await fetchLiveSentence(sl, step, i); // cache-first
        if (run !== recRun) return null;
        if (!clip) continue;
        const buf = await clip.blob.arrayBuffer();
        if (chunks.length === 0) rate = new DataView(buf).getUint32(24, true) || 24000;
        else chunks.push(silencePcm(rate, i === 0 ? SEG_GAP_S : SENT_GAP_S));
        chunks.push(new Uint8Array(buf.slice(44)));
      }
    }
    return chunks.length ? stitchWav(chunks, rate) : null;
  }
  // Viseme counterpart of stitchSlideWav: the SAME sentences, the SAME
  // silence gaps, so the merged timeline lines up with the stitched WAV.
  // Cache-first through the character's own promise cache — sentences whose
  // visemes the lookahead already fetched are free. Any failure (bridge
  // down) just skips the sidecar; the WAV still records.
  async function stitchSlideVisemes(sl, run) {
    if (character.mode !== 'viseme') return null;
    const rec = instance._records[sl - 1];
    const max = rec ? rec.groups.length : 0;
    const segs = notesSegs(sl);
    const parts = [];
    try {
      for (let step = 0; step <= max; step++) {
        const sentences = splitSentences(segs[step]);
        for (let i = 0; i < sentences.length; i++) {
          const tl = await character.ensureTimeline(
            sentenceKey(sl, step, i), fetchLiveSentence(sl, step, i), sentences[i]);
          if (run !== recRun) return null;
          if (!tl) continue;
          parts.push({ timeline: tl, gap: parts.length ? (i === 0 ? SEG_GAP_S : SENT_GAP_S) : 0 });
        }
      }
    } catch {
      debugLog('lipsync', `slide ${sl}: viseme sidecar skipped (bridge unreachable)`);
      return null;
    }
    return parts.length ? concatTimelines(parts) : null;
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
        const wav = await stitchSlideWav(sl, run);
        if (run !== recRun) return; // cancelled mid-synthesis — don't download
        if (wav) {
          const url = URL.createObjectURL(wav);
          downloadFromUrl(url, `slide-${String(sl).padStart(2, '0')}.wav`);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          saved++;
          // character on: the matching viseme sidecar downloads too, so the
          // recorded set plays back lip-synced without the bridge
          const tl = await stitchSlideVisemes(sl, run);
          if (run !== recRun) return;
          if (tl) {
            const jurl = URL.createObjectURL(new Blob([JSON.stringify(tl)], { type: 'application/json' }));
            downloadFromUrl(jurl, `slide-${String(sl).padStart(2, '0')}.visemes.json`);
            setTimeout(() => URL.revokeObjectURL(jurl), 5000);
          }
        }
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
