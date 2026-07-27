// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Engine — init, navigation, transitions, overview/blackout/help, hash,
// scaling, print. SPEC §2.2, §4.1, §8, §9.

import { scanSlide, applyBuildState, stepLabels, registerProvider } from './builds.js';
import { namespaceSvgIds, applyConcepts } from './svg.js';
import { initCharts } from './charts.js';
import { runAutoAnimate } from './autoanimate.js';
import { initMarkdown } from '../md/markdown.js';
import { initMath } from '../math/math.js';
import { initCode } from '../code/code.js';
import { openSpeakerView } from './speaker.js';
import { closeOnBackdrop, selectInList, createOverlays } from './overlay.js';
import { createThemes } from './themes.js';
import { createNarration } from './narration.js';
import { buildPrintPages } from './print.js';
import { createAnnotator } from './annotate.js';
import { setupMedia } from './media.js';
import { needsDevMode } from './devmode.js';

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
/**
 * Out of the flow, so it sits nowhere above the title and cannot be the reason
 * the title is not at the top.
 *
 * Position ONLY, deliberately. Testing `display === 'none'` here looks like the
 * same idea and is a trap: every inactive slide is display:none, and Blink
 * reports that for its descendants too — so the heading itself read as
 * out-of-flow and got skipped, disabling pinning on every slide but the one on
 * screen. `position` resolves to its computed value in an unrendered subtree,
 * which is what makes it safe to ask here.
 *
 * `visibility:hidden` deliberately does not count either: it still takes up its
 * space, and a title below that space really is not leading.
 */
function outOfFlow(el) {
  const pos = getComputedStyle(el).position;
  return pos === 'absolute' || pos === 'fixed';
}

function leadingHeading(section) {
  for (const el of section.children) {
    if (el.matches('aside, script, style, .decklight-hero-logo, .slide-bg')) continue;
    // Heading first, BEFORE any position test: pinning is what makes a title
    // absolute, so asking "is this out of flow?" about the heading unpins it on
    // the next sync() and the whole thing oscillates.
    if (el.matches('h1, h2')) return el;
    // A decorative corner badge or watermark used to end the scan here,
    // silently dropping the slide out of pinned layout — so a deck's titles
    // jumped between the slides that had one and the slides that did not.
    // `.slide-bg` above is skipped for precisely this reason; this generalizes
    // it. What makes a heading "leading" is that it leads the FLOW, not that it
    // happens to be child zero.
    if (outOfFlow(el)) continue;
    return null; // real in-flow content before the title: not a leading heading
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
    !el.matches('h1, h2, .subtitle, aside, script, style, .decklight-hero-logo, .slide-bg'));
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
  const printVariant = params.get('print') || ''; // '' (plain) | 'handout' | 'notes'

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

  // Which dialog owns the keyboard right now. Filled in below the features, in
  // priority order; consulted by onKey before the deck's own shortcuts.
  const overlays = createOverlays();

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

  // ----- theme switching (themes.js) ----------------------------------------
  // What the deck looks like, and every way of changing it — stock, inlined,
  // generated, saved-custom, the packs, the picker. Constructed here, before
  // the instance exists, because restoring the saved theme is one of the first
  // things init does; `deck` hands it the instance later, when a preview or a
  // postMessage finally needs one.
  const themes = createThemes({ root, config, params, toast, debugLog, overlays, deck: () => instance });
  const { applyTheme, currentTheme, cycleTheme, cancelCyclePending, rollTheme, saveGeneratedTheme } = themes;

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
      frame.src = doc + themes.previewQuery() + '#/' + slide + '/0';
      return;
    }
    if (!finderFrameReady) { finderPending = entry; return; }
    frame.contentWindow?.postMessage({ __decklightPreview: { goto: [slide, 0] } }, '*');
  }
  function selectFinderRow(i, immediate) {
    if (!finderMatches.length) return;
    finderSel = selectInList(finderEl.querySelectorAll('.tp-row'), i, 'tp-selected');
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
    themes.closePicker();
    if (restoreEl) closeRestore();
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
    closeOnBackdrop(finderEl, closeSlideFinder);
    root.appendChild(finderEl);
    selectFinderRow(Math.max(0, finderMatches.findIndex((m) => m.slide === instance.state.slide)), true);
  }
  function closeSlideFinder() {
    clearTimeout(finderDebounce);
    finderEl?.remove();
    finderEl = null;
  }

  // ----- restore overlay (R) — SPEC §8 ---------------------------------------
  // The git-level sibling of Z/⇧Z: Z takes back a keystroke, R takes back a
  // session. Rows are the deck's commits (from `decklight restore`'s own
  // helper, over the edit server); the preview is that commit's deck rendered
  // for real, because a hash and a subject are not enough to recognise the
  // version you actually want.
  let restoreEl = null, restoreRows = [], restoreSel = 0, restoreDebounce = null;

  function restorePreview(frame, entry) {
    if (entry) frame.src = `${editBase}/edit/at?ref=${encodeURIComponent(entry.hash)}&embedded`;
  }
  function selectRestoreRow(i, immediate) {
    const rows = [...restoreEl.querySelectorAll('.tp-row')];
    if (!rows.length) return;
    restoreSel = selectInList(rows, i, 'tp-selected');
    const entry = restoreRows[restoreSel];
    restoreEl.querySelector('.tp-caption').textContent =
      entry ? `${entry.hash} · ${entry.when} · ${entry.subject}` : '';
    const frame = restoreEl.querySelector('iframe');
    clearTimeout(restoreDebounce);
    // debounced like the finder: holding ↓ must not fire a page load per row
    if (immediate) restorePreview(frame, entry);
    else restoreDebounce = setTimeout(() => restorePreview(frame, entry), 60);
  }
  async function openRestore() {
    if (restoreEl) return closeRestore();
    if (!editAvailable) return toast(needsDevMode('restoring a version', location), 3200);
    let entries = [];
    try {
      const r = await fetch(editBase + '/edit/history');
      const j = await r.json();
      if (!j.ok) return toast(`restore: ${j.error}`, 3000);
      entries = j.entries || [];
    } catch { return toast('restore: could not read the deck history', 3000); }
    if (!entries.length) return toast('restore: git has no record of this deck yet', 3000);
    themes.closePicker();
    if (finderEl) closeSlideFinder();
    if (palEl) closePalette();
    restoreRows = entries;
    restoreEl = document.createElement('div');
    restoreEl.className = 'decklight-theme-picker decklight-finder decklight-restore';
    restoreEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter">Restore a version — ↑↓ to browse, ⏎ to restore</div>' +
        '<div class="tp-list" role="listbox" aria-label="Deck history"></div></div>' +
        '<div class="tp-preview"><iframe title="Version preview"></iframe>' +
        '<div class="tp-caption"></div></div></div>';
    // Built as nodes, not innerHTML: a commit subject is somebody else's text
    // and may contain anything — textContent escapes it by construction.
    const list = restoreEl.querySelector('.tp-list');
    restoreRows.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.setAttribute('role', 'option');
      const hash = document.createElement('span');
      hash.className = 'rs-hash';
      hash.textContent = e.hash;
      const when = document.createElement('span');
      when.className = 'rs-when';
      when.textContent = e.when;
      row.append(hash, ` ${e.subject} `, when);
      row.addEventListener('click', () => { selectRestoreRow(i, true); commitRestore(); });
      list.appendChild(row);
    });
    closeOnBackdrop(restoreEl, closeRestore);
    root.appendChild(restoreEl);
    selectRestoreRow(0, true);
  }
  function closeRestore() {
    clearTimeout(restoreDebounce);
    restoreEl?.remove();
    restoreEl = null;
  }
  async function commitRestore() {
    const entry = restoreRows[restoreSel];
    if (!entry) return;
    closeRestore();
    try {
      const r = await fetch(editBase + '/edit/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: entry.hash }),
      });
      const j = await r.json();
      if (!j.ok) return toast(`restore failed: ${j.error}`, 3000);
      if (!j.changed) return toast(`already at ${entry.hash}`, 2000);
      // the write lands on disk; the watcher's reload brings the deck back up
      toast(`restored ${entry.hash} — Z takes it back`, 2600);
    } catch { toast('restore failed: the edit server did not answer', 3000); }
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
      { label: 'Restore a version…', hint: 'R', alias: 'history git rollback undo revert commit', run: () => openRestore() },
      { label: 'Go to slide…', hint: '#', alias: 'goto', keepOpen: true, run: () => { palQuery = 'goto '; renderPalette(); } },
      { label: 'Theme…', hint: 'T', run: themes.openPicker },
      { label: 'Cycle theme', hint: ', · .', run: () => cycleTheme(1) },
      { label: 'Generate a theme', hint: '⌃T', run: rollTheme },
      themes.hasGenerated() && { label: 'Save the generated theme…', hint: '⌃⇧T', run: () => saveGeneratedTheme() },
      { label: 'Font…', hint: '[ · ]', run: openFontPicker },
      { label: 'Cycle slide layout (dev)', hint: 'L', alias: 'pin pinned centered top auto split columns two sides arrange', run: () => cycleLayout(1) },
      { label: 'Undo deck edit (dev)', hint: 'Z', alias: 'revert back history', run: () => deckHistory('undo') },
      { label: 'Redo deck edit (dev)', hint: '⇧Z', alias: 'forward history repeat', run: () => deckHistory('redo') },
      { label: 'Ask agent… (dev)', hint: 'A', alias: 'ai claude codex bob gemini prompt edit', run: toggleAgentAsk },
      { label: 'Messages', hint: '`', alias: 'log toast notifications warnings why voice stopped history', run: toggleMessages },
      { label: `Narration ${narration.status().narrating ? 'off' : 'on'}`, hint: 'V', run: toggleNarration },
      { label: 'Narration track…', hint: 'N', alias: 'voice audio', run: () => openNarrPicker('tracks') },
      { label: 'Live voice…', alias: 'tts synthesize tone gemini', run: () => openNarrPicker('voices') },
      { label: 'Character…', alias: 'avatar lipsync face talking head visemes', run: () => openNarrPicker('character') },
      { label: `Character solo ${character.solo ? 'off' : 'on'}`, alias: 'centre center stage narrator only fullscreen avatar', run: () => narration.applySolo(!character.solo) },
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
      { label: `Pen ${annotator?.tool === 'pen' ? 'off' : 'on'} — draw on the slide`, hint: 'W', alias: 'ink annotate draw scribble marker highlight', run: () => toggleInk('pen') },
      { label: `Laser pointer ${annotator?.tool === 'laser' ? 'off' : 'on'}`, hint: '⇧W', alias: 'ink dot glow point at', run: () => toggleInk('laser') },
      { label: 'Debug log', hint: 'D', alias: 'console events state', run: toggleDebug },
      { label: `Captions ${narration.status().captionsOn ? 'off' : 'on'}`, hint: 'C', alias: 'cc subtitles closed caption', run: toggleCaptions },
      { label: `Clock ${clockOn ? 'off' : 'on'}`, hint: 'K', alias: 'time elapsed timer talk wall watch', run: toggleClock },
      { label: `Progress bar ${progressOn ? 'off' : 'on'}`, hint: 'H', alias: 'bar bottom edge position how far through shape of the talk', run: toggleProgress },
      { label: 'Transcript…', alias: 'notes script export text markdown spoken', run: toggleTranscript },
      { label: `Narration ${narration.status().paused ? 'resume' : 'pause'}`, hint: 'P', alias: 'pause resume voice', run: toggleNarrPause },
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
    palSel = selectInList(palEl.querySelectorAll('.pal-row'), i, 'narr-sel');
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
    if (restoreEl) closeRestore();
    palQuery = '';
    palEl = document.createElement('div');
    palEl.className = 'decklight-narr decklight-palette';
    palEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Commands"></div>';
    closeOnBackdrop(palEl, closePalette);
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
    closeOnBackdrop(fontPickEl, closeFontPicker);
    root.appendChild(fontPickEl);
    selectFontRow(fontIdx);
  }
  function selectFontRow(i) {
    fontPickSel = selectInList(fontPickEl.querySelectorAll('.narr-row'), i, 'narr-sel');
  }
  function closeFontPicker() {
    fontPickEl?.remove();
    fontPickEl = null;
  }
  themes.restoreSaved();

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
  // the applied theme decides the canvas polarity the logo variants key off
  themes.updateCanvas();

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
      toast(needsDevMode('layout', location), 3200);
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
      setupMedia(this._sections, { printMode }); // backgrounds first — .slide-bg must not read as content
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
    const on = narration.status().narrating;
    soundBtn.innerHTML = on ? TC_ICON.sound : TC_ICON.mute;
    soundBtn.setAttribute('aria-label', on ? 'Mute narration' : 'Play narration');
    soundBtn.setAttribute('aria-pressed', String(on));
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
    const n = narration.status();
    const narrWhat = n.live
      ? `⚡ ${n.voice} · ${n.tone}`
      : (n.track ? `🔊 ${n.track.label}` : 'none');
    return `slide ${instance.state.slide}/${instance.state.totalSlides}`
      + ` · step ${instance.state.step}/${rec ? rec.groups.length : 0}`
      + ` · theme ${currentTheme() ?? '—'}`
      + ` · narration ${n.narrating ? (n.paused ? 'paused' : 'on') : 'off'} (${narrWhat})`
      + (n.rate !== 1 ? ` · ${n.rate}×` : '')
      + (n.spend > 0 ? ` · tts ~$${n.spend.toFixed(4)}` : '');
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
      <tr><td>W</td><td>pen — draw on the slide (⌫ clears)</td></tr>
      <tr><td>⇧W</td><td>laser pointer</td></tr>
      <tr><td>K</td><td>clock — wall time + elapsed talk</td></tr>
      <tr><td>H</td><td>progress bar — position in the deck, bottom edge</td></tr>
      <tr><td>P</td><td>pause / resume narration</td></tr>
      <tr><td>F</td><td>fullscreen</td></tr>
      <tr><td>T</td><td>theme picker (type to filter)</td></tr>
      <tr><td>/</td><td>command palette (find, themes, everything)</td></tr>
      <tr><td>G</td><td>slide finder (live preview)</td></tr>
      <tr><td>R</td><td>restore a version (dev mode — git history, live preview)</td></tr>
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
  // Every overlay's keyboard, in one readable priority list. Each entry says
  // when it is up, how to dismiss it, and what it does with a key — `true` for
  // "consumed" (the deck calls preventDefault), `false` for "dropped". Either
  // way the key never reaches the deck's own shortcuts below: an overlay that
  // is up owns the keyboard.
  //
  // Registration order is priority, and it decides a tie that should not
  // happen: opening an overlay dismisses whatever else is up, so at most one
  // answers isOpen(). A feature that has moved to its own module registers
  // there instead — the theme picker (createThemes, so first) and the two
  // narration dialogs (createNarration, so after this list) have.
  overlays.register({
    isOpen: () => !!palEl,
    close: closePalette,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectPalRow(palSel + 1); break;
        case 'ArrowUp': selectPalRow(palSel - 1); break;
        case 'Enter': commitPalRow(); break;
        case 'Backspace': palQuery = palQuery.slice(0, -1); renderPalette(); break;
        case 'Escape': if (palQuery) { palQuery = ''; renderPalette(); } else closePalette(); break;
        default:
          if (e.key.length === 1) { palQuery += e.key; renderPalette(); break; }
          return false;
      }
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!fontPickEl,
    close: closeFontPicker,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectFontRow(fontPickSel + 1); break;
        case 'ArrowUp': selectFontRow(fontPickSel - 1); break;
        case 'Enter': applyFont(fontPickSel); closeFontPicker(); break;
        case 'Escape': closeFontPicker(); break;
        default: return false;
      }
      return true;
    },
  });
  // a reading surface — it traps navigation while it is up
  overlays.register({
    isOpen: () => !!transcriptEl,
    close: toggleTranscript,
    keydown: (e) => e.key === 'Escape' && (toggleTranscript(), true),
  });
  // typing surfaces — the textarea handles its own keys
  overlays.register({
    isOpen: () => !!editEl,
    close: toggleEditor,
    keydown: (e) => e.key === 'Escape' && (toggleEditor(), true),
  });
  overlays.register({
    isOpen: () => !!agentEl,
    close: toggleAgentAsk,
    keydown: (e) => e.key === 'Escape' && (toggleAgentAsk(), true),
  });
  overlays.register({
    isOpen: () => !!finderEl,
    close: closeSlideFinder,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectFinderRow(finderSel + 1, false); break;
        case 'ArrowUp': selectFinderRow(finderSel - 1, false); break;
        case 'Enter': commitFinder(); break;
        case 'Backspace': setFinderQuery(finderQuery.slice(0, -1)); break;
        case 'Escape': if (finderQuery) setFinderQuery(''); else closeSlideFinder(); break;
        default:
          if (e.key.length === 1) { setFinderQuery(finderQuery + e.key); break; }
          return false;
      }
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!restoreEl,
    close: closeRestore,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectRestoreRow(restoreSel + 1, false); break;
        case 'ArrowUp': selectRestoreRow(restoreSel - 1, false); break;
        case 'Enter': commitRestore(); break;
        case 'Escape': closeRestore(); break;
        default: return false;
      }
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!overviewEl,
    close: toggleOverview,
    keydown(e) {
      switch (e.key) {
        case 'ArrowRight': ovSelect(ovSel + 1); break;
        case 'ArrowLeft': ovSelect(ovSel - 1); break;
        case 'ArrowDown': ovSelect(ovSel + ovColumns()); break;
        case 'ArrowUp': ovSelect(ovSel - ovColumns()); break;
        case 'Enter': case ' ': ovCommit(); break;
        case 'o': case 'O': case 'Escape': toggleOverview(); break;
        default: return false;
      }
      return true;
    },
  });

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
      else if (!themes.rollFromPicker()) rollTheme();
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // An overlay that is up owns the keyboard — whether or not it wants this
    // particular key. Registration order (see `overlays.register` calls) is the
    // priority order the long if-chain here used to encode.
    const top = overlays.active();
    if (top) {
      if (top.keydown(e)) e.preventDefault();
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
      case 'r': case 'R': openRestore(); break;
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
      case 't': case 'T': themes.openPicker(); break;
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
      case 'w': case 'W': toggleInk(e.shiftKey ? 'laser' : 'pen'); break;
      case 'Backspace':
        if (!annotator?.active) return; // no ink tool on — leave the key alone
        annotator.clear();
        break;
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

  // Background videos (SPEC §1): driven from the slide event, because CSS
  // `section.active` gating alone only hides the element — a display:none
  // <video> keeps decoding. Play the active slide's clip, pause the rest for
  // real. Print mode never creates a <video>, so there is nothing to drive.
  if (!printMode) {
    const syncBgVideos = () => {
      instance._sections.forEach((s, i) => {
        const v = s.querySelector(':scope > .slide-bg > video');
        if (!v) return;
        if (i === instance.state.slide - 1) v.play()?.catch?.(() => {});
        else if (!v.paused) v.pause();
      });
    };
    instance.on('slide', syncBgVideos);
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
  instance.themePicker = { open: themes.openPicker, close: themes.closePicker };
  instance.generateTheme = rollTheme;                       // ⌃T, programmatic
  instance.cycleFont = cycleFont;                           // [ / ], programmatic (±1)
  instance.cycleLayout = cycleLayout;                       // L / ⇧L, programmatic (±1); dev mode only
  instance.layoutRing = layoutRing;                         // the ring a slide would cycle (skips applied)
  instance.toggleMessages = toggleMessages;                 // I, programmatic
  instance.messages = messages;                             // [{ at, text }] — every message shown

  // ── narration (narration.js) ─────────────────────────────────────────────
  // The deck's voice and everything that hangs off it: recorded and live
  // tracks, the sentence pipeline, captions, the lip-synced character, the N
  // picker and the ⇧V offline recorder. It reaches back into two pieces of
  // chrome the engine owns and it invalidates — the mute button and the D
  // panel's status line — and the engine reads its playback state back
  // through status().
  const narration = createNarration({
    root, stage, config, printMode, toast, debugLog, overlays, instance,
    syncSoundBtn, updateDebugState, downloadFromUrl,
  });
  const {
    character, toggleNarration, toggleNarrPause, changeNarrRate, toggleCaptions,
    openRecordDialog, notesSegs,
  } = narration;
  const openNarrPicker = narration.openPicker;
  instance.toggleNarration = toggleNarration;               // V, programmatic

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
  // R programmatically — and what the headless overlay harness drives, since
  // it cannot reach a git server to populate the real list.
  instance.restore = {
    open: openRestore,
    close: closeRestore,
    list: () => restoreRows.slice(),
  };
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

  // ── ink annotations (W pen / ⇧W laser) — SPEC §8 ──────────────────────────
  // Ephemeral presenter ink on a canvas over the slides: strokes live in
  // design coordinates and redraw at the current scale; every slide change
  // clears them. Never in ?print — like the clock, exclusion is by
  // construction: the annotator is simply never created there.
  let annotator = null;
  if (!printMode) {
    annotator = createAnnotator(instance, root);
    instance.annotate = annotator; // W/⇧W programmatically (headless harness)
  }
  function toggleInk(kind) {
    if (!annotator) return;
    const t = kind === 'laser' ? annotator.laser() : annotator.toggle();
    toast(t === 'pen' ? 'pen on — drag to draw · ⌫ clears · W off'
      : t === 'laser' ? 'laser on — ⇧W off' : 'ink off');
    debugLog('nav', `ink ${t ?? 'off'}`);
  }

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
  // Hand the browser a URL and a filename. Shared with the ⇧V recorder, which
  // drives its wav blobs straight into downloads the same way.
  function downloadFromUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
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
    closeOnBackdrop(transcriptEl, toggleTranscript);
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
          // With --remote on there is a LAN URL worth scanning, so the speaker
          // view can offer its QR (#39). editBase is '' when the deck is served
          // by the edit server itself, hence the origin fallback.
          instance.__remoteQr = j.remote ? `${editBase || location.origin}/remote/qr.svg` : null;
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          const es = new EventSource(base + '/edit/events');
          es.onmessage = () => location.reload();
          // the phone remote (#39): a tap on the controller arrives here as a
          // named event on the stream we are already subscribed to, and moves
          // the deck exactly as the arrow keys would
          es.addEventListener('remote', (ev) => {
            try {
              const { key } = JSON.parse(ev.data);
              if (key === 'next') instance.next();
              else if (key === 'prev') instance.prev();
            } catch { /* malformed event */ }
          });
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
          // …and report back where the deck is, so the phone's readout tracks
          // the deck however it moved — the remote, the keyboard, or a click.
          // Fire-and-forget: a readout that misses a beat must never be able to
          // stall the deck.
          const postPos = () => {
            fetch(editBase + '/remote/pos', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ i: instance.state.slide, n: instance.state.totalSlides }),
            }).catch(() => {});
          };
          instance.on('slide', postPos);
          instance.on('build', postPos);
          postPos();
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
      toast(needsDevMode(dir, location), 3200);
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
      toast(needsDevMode('asking an agent', location), 3200);
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
    closeOnBackdrop(agentEl, toggleAgentAsk);
    root.appendChild(agentEl);
    setTimeout(() => ta.focus(), 0);
  }
  let editEl = null;
  function toggleEditor() {
    if (editEl) { editEl.remove(); editEl = null; return; }
    const sl = instance.state.slide;
    if (!editAvailable) {
      toast(needsDevMode('editing notes', location), 3200);
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
    closeOnBackdrop(editEl, toggleEditor);
    root.appendChild(editEl);
    setTimeout(() => ta.focus(), 0);
  }
  if (params.has('voiceover') && narration.status().track && !printMode) {
    // whichever gesture fires first must disarm the OTHER listener too, or
    // the survivor re-arms narration on the next key/click after V stops it
    const arm = () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      if (!narration.status().narrating) toggleNarration();
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
  }

  // ----- touch controls (mount) -------------------------------------------
  // Everything they need (toggleFullscreen, narration) is now in scope.
  // Fullscreen always; sound only when narration is available.
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
    if (narration.status().hasTracks) {
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

  instance.saveGeneratedTheme = (name) => saveGeneratedTheme(name); // ⌃⇧T; name skips the prompt

  if (printMode) {
    root.classList.add('decklight-print');
    instance._sections.forEach((s, i) => {
      s.classList.add('active');
      applyBuildState(instance._records[i], instance._records[i].groups.length);
    });
    // Handout/notes variants restructure the DOM — sections wrapped into
    // .print-page slots — strictly AFTER sync() and applyBuildState above:
    // sync() selects `:scope > section` and must never run again once the
    // sections are wrapped. Print is static, so it never does.
    if (printVariant === 'handout' || printVariant === 'notes') {
      root.classList.add('decklight-print-' + printVariant);
      buildPrintPages(stage, instance._sections, printVariant);
    }
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
