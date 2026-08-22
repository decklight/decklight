// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Engine — init, navigation, transitions, overview/blackout/help, hash,
// scaling, print. SPEC BUILD_SEMANTICS, SLIDE_TRANSITIONS, PRESENTING, JS_API.

import { scanSlide, applyBuildState, stepLabels, registerProvider } from './builds.js';
import { namespaceSvgIds, applyConcepts } from './svg.js';
import { initCharts } from './charts.js';
import { runAutoAnimate } from './autoanimate.js';
import { cssDurationMs, transitionClasses, transitionName } from './motion.js';
import { initMath } from '../math/math.js';
import { initCode } from '../code/code.js';
import { openSpeakerView } from './speaker.js';
import { closeOnBackdrop, selectInList, createOverlays, typeaheadKeydown } from './overlay.js';
import { createThemes } from './themes.js';
import { createNarration } from './narration.js';
import { buildPrintPages } from './print.js';
import { createHud } from './hud.js';
import { setupMedia } from './media.js';
import { createEditMode } from './editmode.js';
import { createOnboarding, TIPS } from './onboarding.js';
import { needsDevMode } from './devmode.js';
import { createOverflowWatch } from './overflow.js';
import { createPlaylist } from './playlist.js';
import { buildIndex, rankMatches } from './finder.js';
import { createDebugLog } from './debuglog.js';
import { createLayoutCycler } from './layout.js';
import { paletteRows } from './palette.js';

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
// for the feature (SPEC PRESENTING).
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
 * Pinned titles (SPEC PRESENTING): keep slide titles at one vertical position instead
 * of drifting with content height. The leading h1/h2 of each pinnable section
 * is absolutely positioned at --pin-y; --pin-space (pin Y + measured title
 * height + gap) becomes the section's padding-top so the remaining content
 * centers below the title and can never slide under it.
 *
 * Pinnable heuristic: a leading h1/h2 AND real content (list/svg/pre/table/
 * terminal/img/columns) outside the notes — title cards and quote/statement
 * slides stay centered. Per-slide overrides: data-pin (force), data-pin="none"
 * (opt out), data-pin="<number>" (custom Y). data-layout (PRESENTING layout cycling)
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
 * Subtitle (SPEC DECK_ANATOMY/PRESENTING): the <p> immediately following a section's leading
 * heading is the slide's subtitle — one canonical look whether the slide is
 * pinned or centered. Opt out per slide with
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
 * Split layouts (SPEC PRESENTING): a slide's content blocks — everything after the
 * title + subtitle header — lay out in two sides, first block left and the
 * second right ("split-flip" mirrors). A slide whose ONLY content block is a
 * list can't take sides; the engine marks it .split-columns instead and the
 * list itself splits across two CSS columns.
 *
 * A THIRD block is a footer, not a third column. The shape that asks for this
 * is the comparison slide — two columns and a note that applies to both — and
 * "first block left, everything else right" put that note inside the right
 * column, hanging under one side of a comparison it was about equally. Blocks
 * past the second span the full width and centre, below the columns.
 *
 * Three columns are deliberately NOT a shape here: grouping three items onto
 * one slide multiplies content-per-slide, which is the density problem the
 * authoring contract exists to discourage. Two and a footer, or another slide.
 */
function splitContent(sec) {
  return [...sec.children].filter((el) =>
    !el.matches('h1, h2, .subtitle, aside, script, style, .decklight-hero-logo, .slide-bg'));
}

function setupSplit(sections) {
  sections.forEach((sec, i) => {
    sec.querySelectorAll(':scope > .split-columns, :scope > .split-footer')
      .forEach((el) => el.classList.remove('split-columns', 'split-footer'));
    if (!/^split/.test(sec.getAttribute('data-layout') || '')) {
      sec.removeAttribute('data-split-conflict');
      return;
    }
    const content = splitContent(sec);
    checkSplitConflict(sec, content, i + 1);
    if (content.length === 1 && content[0].matches('ul, ol')) {
      content[0].classList.add('split-columns');
      return;
    }
    for (const el of content.slice(2)) el.classList.add('split-footer');
  });
}

/**
 * The split trap (SPEC COMPARISON_SLIDES): a section carrying data-layout="split"
 * while a content block brings its OWN row flexbox has two layout systems
 * arguing — the split row's alignment defeats the pinned title's reserved
 * space, the columns shrink, the footer is pushed off the bottom. The overflow
 * guardrail catches the symptom; this names the cause. Mark (data-split-conflict,
 * assertable headlessly like data-overflow) and warn once, on the way in —
 * a computed display, so an inline style and a stylesheet class both count.
 * Column-direction flex is fine: it stacks, it does not take sides.
 */
function checkSplitConflict(sec, content, slideNo) {
  const conflict = content.some((el) => {
    const cs = getComputedStyle(el);
    return /flex$/.test(cs.display) && cs.flexDirection.startsWith('row');
  });
  const was = sec.hasAttribute('data-split-conflict');
  sec.toggleAttribute('data-split-conflict', conflict);
  if (conflict && !was) {
    console.warn(`Decklight: slide ${slideNo} combines data-layout="split" with its own column flexbox — `
      + 'two layout systems fight; drop the data-layout or the flex shell (SPEC COMPARISON_SLIDES)');
  }
}

/**
 * Authoring guardrail: content that exceeds the slide silently flex-shrinks
 * into an overflow:auto box and reads as clipped. Warn (console) and mark
 * (data-overflow attribute) so both humans and headless probes can catch it.
 */
function checkOverflow(section, slideNo) {
  if (!section) return;
  // Terminals scroll internally by design (SPEC TERMINAL_PLAYER scrollback viewport);
  // any other intentional scroller can opt out with data-scroll-ok.
  const clipped = [section, ...section.querySelectorAll('pre, table, svg, ul, ol, blockquote')]
    .some((el) => el.scrollHeight > el.clientHeight + 2 &&
                  getComputedStyle(el).overflowY !== 'visible' &&
                  !el.closest('.terminal') && !el.hasAttribute('data-scroll-ok'));
  const was = section.hasAttribute('data-overflow');
  section.toggleAttribute('data-overflow', clipped);
  // Only on the way IN. The check re-runs whenever the slide's content changes
  // size (watchOverflow), so warning on every pass would turn one clipped slide
  // into a console full of the same line.
  if (clipped && !was) console.warn(`Decklight: slide ${slideNo} content overflows and is clipped — reduce content or font size`);
}

/**
 * Markdown slides were removed. Say so, per slide, instead of going blank.
 *
 * A `data-markdown` section kept its content in `<script type="text/template">`,
 * which no browser renders — so with the parser gone such a slide comes up
 * EMPTY, on stage, with nothing anywhere to explain it. That is the one failure
 * this removal could not be allowed to have, so the attribute is still
 * recognised for exactly long enough to name the slide and refuse quietly:
 * `data-markdown-removed` for a headless probe to assert on, one console line
 * for the author. Nothing here parses anything.
 */
function reportMarkdownSlides(root) {
  root.querySelectorAll('section[data-markdown]').forEach((section, i) => {
    section.setAttribute('data-markdown-removed', '');
    const n = [...root.children].indexOf(section) + 1 || i + 1;
    console.warn(`Decklight: slide ${n} uses data-markdown, which was removed in 0.3.0 — `
      + 'its content is in a <script type="text/template"> the browser will not render. '
      + 'Author the slide in HTML (SPEC DECK_ANATOMY).');
  });
}

export function init(userConfig = {}) {
  const params = new URLSearchParams(location.search);
  const config = { ...DEFAULTS, ...userConfig };
  if (params.has('embedded')) config.controls = false;
  const printMode = params.has('print');
  const printVariant = params.get('print') || ''; // '' (plain) | 'handout' | 'notes'

  // ----- debug log (D) -------------------------------------------------------
  // The ring buffer (debuglog.js) records from init, whether or not the window
  // is open — by the time a presenter notices something went wrong, the reason
  // is already in the past. Built this early because theme restoration logs
  // during init, before there is any chrome to log into. D pops the window,
  // which then attaches itself as the buffer's sink.
  const debug = createDebugLog();
  let debugEl = null;
  const debugLog = (kind, msg) => debug.log(kind, msg);

  const root = document.querySelector('.decklight');
  if (!root) throw new Error('Decklight: no .decklight element found');

  // Which dialog owns the keyboard right now. Filled in below the features, in
  // priority order; consulted by onKey before the deck's own shortcuts.
  const overlays = createOverlays();

  // ----- playlist (multi-deck navigation) ------------------------------------
  // Two shapes, one vocabulary: chained FILES (config.playlist) and one merged
  // file's data-module chapters. playlist.js holds the difference so that the
  // finder, the chrome and the palette can just ask.
  const moduleNav = createPlaylist({
    config, root,
    embedded: params.has('embedded'),
    sectionsOf: () => instance._sections,
    slideOf: () => instance.state.slide,
    navigate: (href) => { location.href = href; },
  });
  const playlist = moduleNav.playlist;
  const playlistIndex = moduleNav.index;
  const hasMarkersDOM = moduleNav.hasMarkers;
  const gotoModule = (delta) => moduleNav.gotoModule(delta);
  const navigateToModule = (i) => moduleNav.navigateToModule(i);

  // Messages (SPEC PRESENTING): the deck talks back in the top-left corner — big enough
  // to read from the back of a room, gone a few seconds later. Every one is also
  // KEPT: a message that explains why the voice stopped is worthless if it faded
  // while you were looking at the slide. `I` shows the log (see toggleMessages).
  const MSG_KEEP = 200;   // ring buffer
  const MSG_STACK = 4;    // visible at once — beyond that the oldest goes early
  const msgLog = [];
  let msgEl = null;
  let msgListEl = null;
  function messages() { return msgLog; }
  // A message the log remembers but never shows. For chrome that IS its own
  // visible surface — the narration hint pill — where a toast on top of it
  // would say the same thing twice, in two places, at once.
  function logOnly(msg) {
    msgLog.push({ at: new Date(), text: String(msg) });
    if (msgLog.length > MSG_KEEP) msgLog.shift();
    if (msgListEl) renderMsgList();   // the log is open — keep it live
  }
  function toast(msg, ms = 3200) {
    logOnly(msg);
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

  // ----- onboarding (onboarding.js) -----------------------------------------
  // The first-run welcome card and the tip rotation that follows it. Built
  // before every other overlay so the welcome is first in the registry —
  // registration order is priority — which is why it takes the instance as an
  // accessor, exactly as the theme picker below does.
  const onboarding = createOnboarding({
    root, printMode, params, toast, debugLog, overlays, deck: () => instance,
  });

  // ----- theme switching (themes.js) ----------------------------------------
  // What the deck looks like, and every way of changing it — stock, inlined,
  // generated, saved-custom, the packs, the picker. Constructed here, before
  // the instance exists, because restoring the saved theme is one of the first
  // things init does; `deck` hands it the instance later, when a preview or a
  // postMessage finally needs one.
  // `editmode` is built ~1300 lines below; the picker only ever consults it
  // from an open dialog, which is why it can be handed over as an accessor.
  // Nothing here reads it during setup.
  const themes = createThemes({
    root, config, params, toast, debugLog, overlays,
    deck: () => instance,
    editmode: () => editmode,
  });
  const { applyTheme, currentTheme, cycleTheme, cancelCyclePending, rollTheme, saveGeneratedTheme } = themes;

  // ----- slide finder: / opens find-a-slide with live preview ---------------
  // Same panel anatomy and lazy-preview mechanism as the theme picker: the
  // embedded deck boots once, then selections postMessage a goto into it.
  // Matching is word-AND over the slide's text; title hits rank above
  // body-only hits, and each match is listed by its title.
  let finderEl = null, finderSel = 0, finderQuery = '', finderMatches = [], finderDebounce;
  let finderFrameReady = false, finderPending = null;
  function finderIndex() {
    return buildIndex({
      sections: instance._sections,
      modules: playlist?.modules ?? [],
      skipModule: playlistIndex,
    });
  }
  function renderFinderList() {
    const listBox = finderEl.querySelector('.tp-list');
    finderMatches = rankMatches(finderEl.__index, finderQuery);
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
    editmode.restore.close();
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


  // ----- command palette (/) — SPEC PRESENTING ---------------------------------------
  // A Claude-style palette: / lists every command with its shortcut, typing
  // filters, Enter runs. Commands with arguments drill into their own pickers
  // (theme, font, narration, module, slide finder). Text that matches no
  // command falls back to a "search slides for …" row.
  let palEl = null, palSel = 0, palQuery = '', palRows = [];
  function paletteCommands() {
    const has = (fn) => typeof fn === 'function';
    const all = [
      { label: 'Find slide…', hint: 'G', alias: 'search grep goto module chapter jump', run: () => { openSlideFinder(); if (palQuery) setFinderQuery(palQuery); } },
      { label: 'History… (dev)', hint: 'H', alias: 'restore version rollback revert back git log commits unpushed push remote when changed', run: () => editmode.history.open() },
      { label: 'Go to slide…', hint: '#', alias: 'goto', keepOpen: true, run: () => { palQuery = 'goto '; renderPalette(); } },
      { label: 'Theme…', hint: 'T', run: themes.openPicker },
      { label: 'Cycle theme', hint: ', · .', run: () => cycleTheme(1) },
      { label: 'Generate a theme', hint: '⌃T', run: rollTheme },
      themes.hasGenerated() && { label: 'Save the generated theme…', hint: '⌃⇧T', run: () => saveGeneratedTheme() },
      // Contextual, like the save row above: without an author server there is
      // nothing to install through, so the row is absent rather than a promise
      // the deck cannot keep (THEME_BROWSE#UI).
      editmode.available() && { label: 'Browse marketplace themes…', alias: 'marketplace install add third-party download catalog', run: themes.browse },
      // Contextual for the same reason as Browse: each engine a registered
      // marketplace declares a wizard for gets its own row (ENGINES#WIZARD).
      // Without an author server the list is empty — there is nowhere to post
      // a credential, so no row makes a promise the deck cannot keep.
      ...editmode.wizards().map((w) => ({
        label: `Configure ${w.title}… (dev)`,
        alias: 'engine wizard setup api key credential token marketplace',
        run: () => editmode.wizard(w.qualified),
      })),
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
      // Named as a PAIR, differing only where it matters: "offline" described
      // how the old one was made, not what you got, and read as the opposite
      // of nothing once a second recorder existed.
      { label: 'Record narration (synthesized voice)…', hint: '⇧V', alias: 'export download batch wav tts offline', run: openRecordDialog },
      { label: 'Record narration (your voice)…', hint: '⇧R', alias: 'microphone mic narrate teleprompter speak record voice', run: openMicRecorder },
      { label: 'Voice faster', hint: '>', alias: 'speed rate playback', run: () => changeNarrRate(+0.25) },
      { label: 'Voice slower', hint: '<', alias: 'speed rate playback', run: () => changeNarrRate(-0.25) },
      { label: 'Speaker view', hint: 'S', run: () => {
        const w = instance.__speakerWin;
        if (w && !w.closed) w.__decklightSpeakerToggle?.();
        else instance.__speakerWin = openSpeakerView(instance);
      } },
      { label: 'Overview', hint: 'O', run: toggleOverview },
      { label: 'Blackout', hint: 'B', run: toggleBlackout },
      { label: `Pen ${hud.annotator?.tool === 'pen' ? 'off' : 'on'} — draw on the slide`, hint: 'W', alias: 'ink annotate draw scribble marker highlight', run: () => toggleInk('pen') },
      { label: `Laser pointer ${hud.annotator?.tool === 'laser' ? 'off' : 'on'}`, hint: '⇧W', alias: 'ink dot glow point at', run: () => toggleInk('laser') },
      { label: 'Debug log', hint: 'D', alias: 'console events state', run: toggleDebug },
      { label: `Captions ${narration.status().captionsOn ? 'off' : 'on'}`, hint: 'C', alias: 'cc subtitles closed caption', run: toggleCaptions },
      { label: `Clock ${hud.status().clockOn ? 'off' : 'on'}`, hint: 'K', alias: 'time elapsed timer talk wall watch', run: toggleClock },
      { label: `Progress bar ${hud.status().progressOn ? 'off' : 'on'}`, hint: 'J', alias: 'bar bottom edge position how far through shape of the talk', run: toggleProgress },
      { label: 'Transcript…', alias: 'notes script export text markdown spoken', run: toggleTranscript },
      { label: `Narration ${narration.status().paused ? 'resume' : 'pause'}`, hint: 'P', alias: 'pause resume voice', run: toggleNarrPause },
      { label: 'Edit speaker notes…', alias: 'edit mode notes write right-click background', run: toggleEditor },
      { label: `Element edit mode ${editmode.elementEditOn() ? 'off' : 'on'} (dev)`, hint: 'E', alias: 'right-click remove delete html content build animation entrance effect context menu', run: toggleElementEdit },
      { label: 'Fullscreen', hint: 'F', run: () => toggleFullscreen() },
      { label: 'Print view (all slides, new tab)', hint: '', run: () => window.open(location.pathname + '?print') },
      { label: 'First slide', hint: 'Home', run: () => instance.goto(1, 0) },
      { label: 'Last slide', hint: 'End', run: () => instance.goto(instance.state.totalSlides, 0) },
      { label: 'Keyboard help', hint: '?', run: toggleHelp },
      { label: 'Welcome to Decklight', alias: 'onboarding intro getting started first run tour what is this help me', run: onboarding.showWelcome },
      { label: `Tips ${onboarding.status().tipsOn ? 'off' : 'on'}`, alias: 'hints teach shortcuts learn stop showing quiet', run: () => onboarding.setTips(!onboarding.status().tipsOn) },
      // Contextual: with every tip read there is nothing to reset to, and a row
      // that does nothing visible is a row that reads as broken.
      onboarding.status().tipsLeft < TIPS.length
        && { label: 'Reset tips', alias: 'hints again start over show all unsee replay', run: onboarding.resetTips },
    ].filter(Boolean).filter((c) => has(c.run));
    return all;
  }
  function renderPalette() {
    const card = palEl.querySelector('.narr-card');
    card.textContent = '';
    // Which rows a query leaves, the inline "goto 27" argument and the
    // search fallback all live in palette.js; the commands themselves stay
    // here, where each one closes over what it runs.
    palRows = paletteRows({
      commands: paletteCommands(),
      query: palQuery,
      totalSlides: instance.state.totalSlides,
      makeGotoRow: (n, total) => ({
        label: `Go to slide ${n} / ${total}`, hint: '⏎', run: () => instance.goto(n, 0),
      }),
      makeSearchRow: (text) => ({
        label: `Search slides for “${text}”`, hint: '',
        run: () => { openSlideFinder(); setFinderQuery(text); },
      }),
    });
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
    editmode.restore.close();
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

  // ----- font cycling ([ / ]) — SPEC PRESENTING -------------------------------------
  // Curated system stacks (offline-safe, same rule as theme fonts THEMING), applied
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

  // ----- brand logo (SPEC PRESENTING) ------------------------------------------------
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
  reportMarkdownSlides(stage);
  initCharts(stage); // synchronous, so the SVGs get namespaced and build-scanned below
  initMath(stage);
  namespaceSvgIds(stage);
  initCode(stage, registerBuildProvider);

  // ----- slide layout cycling (L / ⇧L) — SPEC PRESENTING -----------------------------
  // The ring, the skip rules and the debounced write-through live in layout.js;
  // what stays here is the deck's answers to its questions. Author mode only:
  // the pick is a persisted deck edit (data-layout, written back through the
  // edit server), so without that server the key explains itself and changes
  // nothing rather than forking the deck from what is on disk.
  const layout = createLayoutCycler({
    slideOf: () => instance.state.slide,
    sectionAt: (idx) => instance._sections[idx - 1],
    describe: (sec) => ({
      autoPins: autoPinY(sec, config) !== null,
      hasSplitPair: splitContent(sec).length > 1,
    }),
    available: () => editmode.available(),
    unavailableMessage: () => needsDevMode('layout', location),
    apply: (sec, name) => {
      if (name === 'auto') sec.removeAttribute('data-layout');
      else sec.setAttribute('data-layout', name);
    },
    relayout: (sec, idx) => {
      setupPinnedTitles(instance._sections, config);
      setupSplit(instance._sections);
      checkOverflow(sec, idx);
      return sec.hasAttribute('data-split-conflict');
    },
    post: (body) => fetch(editmode.base() + '/edit/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => { if (!r.ok) throw new Error(r.status); }),
    toast,
    debugLog,
  });
  const cycleLayout = (dir) => layout.cycle(dir);
  const layoutRing = (idx) => layout.ring(idx);

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
      // an edit can replace the very elements being watched (dev mode re-renders
      // a slide in place), so re-aim at whatever is on stage now
      watchOverflow(printMode ? this._sections : [this._sections[this.state.slide - 1]]);
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
        watchOverflow([this._sections[slide - 1]]); // measures, then keeps watching
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

      const name = transitionName(to.getAttribute('data-transition'), this.config.transition);
      const cls = transitionClasses(name, direction);
      if (!cls) return;
      to.classList.add(...cls.entering);
      from.classList.add(...cls.leaving);
      // cssDurationMs, not `parseFloat(…) * 1000`: the shipped default is
      // `350ms`, and multiplying that gave 350 SECONDS — so every section kept
      // its `entering`/`leaving` classes for five minutes and fifty seconds
      // instead of clearing at 410ms, and the deck spent a talk believing it
      // was mid-move (SPEC MOTION).
      const ms = cssDurationMs(getComputedStyle(to).getPropertyValue('--transition-duration'), 350);
      setTimeout(() => {
        from.classList.remove(...cls.leaving);
        to.classList.remove(...cls.entering);
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
        if (moduleNav.any) {
          const title = moduleNav.title();
          const mod = document.createElement('span');
          mod.className = 'mod';
          mod.textContent = title;
          slideNumEl.prepend(mod);
        }
      }
    },

    /**
     * Put the position in the URL — COALESCED, and checked afterwards (#328).
     *
     * WebKit caps history writes at 100 per 10 seconds and counts `pushState`
     * and `replaceState` against the same budget. A deck walked fast — a held
     * arrow key, someone scrubbing for a slide — spends that in seconds: the
     * showcase has 39 slides and about a hundred build steps, and 160 presses
     * left the URL stuck on slide 32 while slide 39 was on screen. PERMANENTLY,
     * because only a further navigation would have resynced it and at the end
     * of a deck there are none left. Chrome and Firefox have no such limit,
     * which is why nothing caught it until a deck ran under WebKit.
     *
     * So writes are coalesced to one per SETTLED position rather than one per
     * keypress. That is both the fix and the thing that stops the budget being
     * spent: a run of a hundred presses is now one write, not a hundred.
     *
     * And the write is verified. It used to be fire-and-forget — when WebKit
     * dropped it, nothing noticed and nothing retried. Now a write that did not
     * land is tried once more, on the next frame, by which time the limiter's
     * window has usually moved on.
     */
    _updateHash(pushSlide) {
      if (!this.config.hash || printMode) return;
      // A slide change PUSHES and a step change REPLACES — the right
      // distinction, and one a coalesced run must not lose: if any navigation
      // in the run crossed a slide, the single write it collapses into is a
      // push.
      hashPushPending = hashPushPending || !!pushSlide;
      if (hashTimer) return;
      hashTimer = setTimeout(() => { hashTimer = null; flushHash(); }, HASH_COALESCE_MS);
    },

    _notify() {
      if (this.__notifySpeaker) this.__notifySpeaker();
    },
  };

  // ----- helpers -----------------------------------------------------------
  // Hand the browser a URL and a filename. The transcript export, the ⇧V
  // recorder and nothing else — but those two live in different modules now,
  // so the seven lines belong to neither.
  function downloadFromUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function withoutAnim(fn) {
    root.classList.add('decklight-no-anim');
    fn();
    void root.offsetWidth;
    root.classList.remove('decklight-no-anim');
  }

  function hashOf(h) {
    return (h || '').replace(/^#/, '');
  }

  // 90ms: long enough that a held arrow key produces one write instead of one
  // per repeat (key repeat is ~30ms once it starts), short enough that a single
  // deliberate press updates the URL before anyone could copy it.
  const HASH_COALESCE_MS = 90;
  let hashTimer = null;
  let hashPushPending = false;

  /**
   * Write the CURRENT position, and check that it took.
   *
   * Reads `instance.state` at flush time rather than closing over the position
   * that scheduled it — the whole point is that the last position wins, and a
   * queued write for slide 12 landing after the deck reached 39 would be the
   * same bug in a new place.
   */
  function flushHash(retry = true) {
    if (!instance || !config.hash || printMode) return;
    const h = `#/${instance.state.slide}/${instance.state.step}`;
    const push = hashPushPending;
    hashPushPending = false;
    if (('#' + hashOf(location.hash)) === h) return;
    suppressHashChange = true;
    try {
      if (push) history.pushState(null, '', h);
      else history.replaceState(null, '', h);
    } catch { /* a limiter throwing is the same as one silently dropping */ }
    setTimeout(() => { suppressHashChange = false; });
    // Verified, because a dropped write is exactly what this bug was. One
    // retry, a frame later: the limiter's window moves on, and a second failure
    // means something other than rate limiting is wrong and retrying forever
    // would spend the budget rather than recover it.
    if (retry && ('#' + hashOf(location.hash)) !== h) {
      hashPushPending = push;
      requestAnimationFrame(() => flushHash(false));
    }
  }

  function parseHash() {
    const m = hashOf(location.hash).match(/^\/(\d+)(?:\/(\d+))?/);
    if (!m) return null;
    return { slide: parseInt(m[1], 10), step: m[2] ? parseInt(m[2], 10) : 0 };
  }

  // ----- chrome ------------------------------------------------------------
  let progressBar = null; // mounted by the progress bar toggle (J), below
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
    if (debugEl) { debugEl.remove(); debugEl = null; debug.onEntry(null); return; }
    debugEl = document.createElement('div');
    debugEl.className = 'decklight-debug';
    debugEl.innerHTML = '<div class="dbg-head">debug log — D closes</div><div class="dbg-state"></div><div class="dbg-log"></div>';
    root.appendChild(debugEl);
    debug.entries.forEach(appendDebugRow);
    updateDebugState();
    const log = debugEl.querySelector('.dbg-log');
    log.scrollTop = log.scrollHeight;
    // From here the buffer feeds the window directly; closing detaches it.
    debug.onEntry((entry) => {
      appendDebugRow(entry);
      updateDebugState();
      const box = debugEl.querySelector('.dbg-log');
      box.scrollTop = box.scrollHeight;
    });
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
      <tr><td>J</td><td>progress bar — position in the deck, bottom edge</td></tr>
      <tr><td>H</td><td>history — commits, slides and diff per version, ⏎ restores one (author mode; R too)</td></tr>
      <tr><td>P</td><td>pause / resume narration</td></tr>
      <tr><td>F</td><td>fullscreen</td></tr>
      <tr><td>T</td><td>theme picker (type to filter)</td></tr>
      <tr><td>/</td><td>command palette (find, themes, everything)</td></tr>
      <tr><td>G</td><td>slide finder (live preview)</td></tr>
      <tr><td>E</td><td>element edit mode — right-click a slide element (author mode)</td></tr>
      <tr><td>, / .</td><td>cycle theme</td></tr>
      <tr><td>[ / ]</td><td>cycle font</td></tr>
      <tr><td>L / ⇧L</td><td>slide layout — writes the file (author mode)</td></tr>
      <tr><td>Z / ⇧Z</td><td>undo / redo deck edits (author mode)</td></tr>
      <tr><td>A</td><td>ask an AI agent to edit the deck (author mode)</td></tr>
      <tr><td>⌃T</td><td>generate a theme (repeat to re-roll)</td></tr>
      <tr><td>⌃⇧T</td><td>save the generated theme</td></tr>
      <tr><td>?</td><td>this help</td></tr>
      <tr><td>/</td><td>command palette — “Welcome to Decklight” reopens the intro</td></tr></table></div>`;
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
    keydown: (e) => typeaheadKeydown(e, {
      query: palQuery,
      onMove: (d) => selectPalRow(palSel + d),
      onCommit: commitPalRow,
      onType: (ch) => { palQuery += ch; renderPalette(); },
      onBackspace: () => { palQuery = palQuery.slice(0, -1); renderPalette(); },
      onClear: () => { palQuery = ''; renderPalette(); },
      onClose: closePalette,
    }),
  });
  overlays.register({
    isOpen: () => !!fontPickEl,
    close: closeFontPicker,
    keydown: (e) => typeaheadKeydown(e, {
      onMove: (d) => selectFontRow(fontPickSel + d),
      onCommit: () => { applyFont(fontPickSel); closeFontPicker(); },
      onClose: closeFontPicker,
    }),
  });
  overlays.register({
    isOpen: () => !!finderEl,
    close: closeSlideFinder,
    keydown: (e) => typeaheadKeydown(e, {
      query: finderQuery,
      onMove: (d) => selectFinderRow(finderSel + d, false),
      onCommit: commitFinder,
      onType: (ch) => setFinderQuery(finderQuery + ch),
      onBackspace: () => setFinderQuery(finderQuery.slice(0, -1)),
      onClear: () => setFinderQuery(''),
      onClose: closeSlideFinder,
    }),
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
      case 'j': case 'J': toggleProgress(); break;
      case 'h': case 'H': editmode.history.open(); break;
      case 'p': case 'P': toggleNarrPause(); break;
      // G = go/grep — a direct slide-finder key. Deliberately NOT ⌘F:
      // browser find is sacred, and / already belongs to the palette.
      case 'g': case 'G': openSlideFinder(); break;
      // R is history's other door — kept because it is in people's fingers.
      // ⇧R records YOUR voice; bare R stays history, which is in people's fingers.
      case 'r': case 'R': if (e.shiftKey) openMicRecorder(); else editmode.history.open(); break;
      case 'e': case 'E': toggleElementEdit(); break;
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
        if (!hud.annotator?.active) return; // no ink tool on — leave the key alone
        hud.annotator.clear();
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

  // ----- overflow watch ----------------------------------------------------
  // The ears live in overflow.js (createOverflowWatch); what "overflowing"
  // means is checkOverflow above. Three observers, a timer rather than a
  // frame, and re-recruitment of nodes that arrive after arming — that file's
  // header carries the reasoning for each.
  const overflowWatch = createOverflowWatch({
    sectionsOf: () => instance._sections,
    checkOverflow,
  });
  const watchOverflow = (sections) => overflowWatch.watch(sections);

  // ----- hash --------------------------------------------------------------
  let suppressHashChange = false;
  if (config.hash && !printMode) {
    window.addEventListener('hashchange', () => {
      if (suppressHashChange) return;
      const t = parseHash();
      if (t) instance.goto(t.slide, t.step, { force: true });
    });
  }

  // Background videos (SPEC DECK_ANATOMY): driven from the slide event, because CSS
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
  instance.cycleLayout = cycleLayout;                       // L / ⇧L, programmatic (±1); author mode only
  instance.layoutRing = layoutRing;                         // the ring a slide would cycle (skips applied)
  instance.toggleMessages = toggleMessages;                 // I, programmatic
  instance.messages = messages;                             // [{ at, text }] — every message shown
  instance.showWelcome = onboarding.showWelcome;            // first-run card, palette / programmatic
  instance.tips = {                                         // the rotation the palette drives
    show: onboarding.showTip,
    reset: onboarding.resetTips,
    set: onboarding.setTips,
    status: onboarding.status,
  };

  // ── narration (narration.js) ─────────────────────────────────────────────
  // The deck's voice and everything that hangs off it: recorded and live
  // tracks, the sentence pipeline, captions, the lip-synced character, the N
  // picker and the ⇧V offline recorder. It reaches back into two pieces of
  // chrome the engine owns and it invalidates — the mute button and the D
  // panel's status line — and the engine reads its playback state back
  // through status().
  const narration = createNarration({
    root, stage, config, params, printMode, toast, logOnly, debugLog, overlays, instance,
    syncSoundBtn, updateDebugState, downloadFromUrl,
    // ⇧V writes its slide-NN.wav next to the deck when there is a server that
    // owns the deck file; a thunk because editmode is built below this, and its
    // probe has not answered yet either way.
    authorBase: () => (editmode?.available() ? editmode.base() : null),
    // …and the thing that makes reading it safe: false means "no server" only
    // AFTER this resolves. The recorder awaits it rather than guessing early.
    authorReady: () => editmode?.settled?.() ?? Promise.resolve(),
  });
  const {
    character, toggleNarration, toggleNarrPause, changeNarrRate, toggleCaptions,
    openRecordDialog, openMicRecorder, notesSegs,
  } = narration;
  const openNarrPicker = narration.openPicker;
  instance.toggleNarration = toggleNarration;               // V, programmatic
  // `decklight record deck.html` opens the deck HERE — the whole point of that
  // command being that a microphone needs a secure context and file:// is not
  // one. Deferred a beat so the first slide has landed and the welcome card (a
  // first run is exactly when someone tries this) has had its say; skipped
  // entirely if anything else already owns the keyboard.
  if (params.has('record') && !printMode) {
    setTimeout(() => { if (!overlays.active()) openMicRecorder(); }, 700);
  }

  // ── presenter overlays (hud.js) ──────────────────────────────────────────
  // Clock, progress hairline, ink and transcript: four things you can layer
  // over the slides while you talk, each an off-by-default toggle that
  // remembers itself per deck. The engine keeps writing the bar's width — the
  // fraction is the one the chrome already computes — so hud hands it the
  // element and takes it back.
  const hud = createHud({
    root, printMode, toast, debugLog, overlays, instance, narration, downloadFromUrl,
    setProgressBar: (el) => { progressBar = el; },
  });
  const { toggleClock, toggleProgress, toggleInk, toggleTranscript } = hud;
  instance.toggleClock = toggleClock;       // K programmatically
  instance.toggleProgress = toggleProgress; // J programmatically

  // ── dev-server features (editmode.js) ────────────────────────────────────
  // Live reload, the notes editor, the phone remote, asking an agent, undo/redo
  // and the R restore dialog — everything that needs the edit server serving
  // the deck. Built here, last, because it wants the instance and narration's
  // notes segmentation; it registers its own three overlays.
  const editmode = createEditMode({
    root, config, params, printMode, toast, debugLog, overlays, instance,
    notesSegs,
    // the R dialog shares the stage with these three; the engine owns two
    dismissOthers: () => {
      themes.closePicker();
      if (finderEl) closeSlideFinder();
      if (palEl) closePalette();
    },
  });
  const { deckHistory, toggleEditor, toggleAgentAsk, toggleElementEdit } = editmode;
  // R programmatically — and what the headless overlay harness drives, since
  // it cannot reach a git server to populate the real list.
  instance.restore = editmode.restore;
  // The engine wizard (ENGINES#WIZARD), for drivers that cannot click the
  // palette's Configure rows. Same author-mode gate either way.
  instance.wizard = editmode.wizard;
  instance.toggleElementEdit = toggleElementEdit;           // E programmatically; author mode only

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
    // (`decklight pdf` reads these attributes back out of this very render, so
    // this is the one that must not depend on another frame ever arriving.)
    watchOverflow(instance._sections);
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
  // Last, and after `ready`: the welcome card and the tips are the only chrome
  // that reads where the hash SENT the deck, and a load that landed on slide 12
  // is a talk in progress, not a first run.
  onboarding.start(target);
  return instance;
}
