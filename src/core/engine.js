// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Engine — init, navigation, transitions, overview/blackout/help, hash,
// scaling, print. SPEC BUILD_SEMANTICS, SLIDE_TRANSITIONS, PRESENTING, JS_API.

import { scanSlide, applyBuildState, stepLabels, registerProvider } from './builds.js';
import { namespaceSvgIds, applyConcepts, applyNesting, conceptFill, setFillRoles, fillRolesOf } from './svg.js';
import { initCharts } from './charts.js';
import { runAutoAnimate } from './autoanimate.js';
import { cssDurationMs, transitionClasses, transitionName } from './motion.js';
import { initMath } from '../math/math.js';
import { initCode } from '../code/code.js';
import { openSpeakerView } from './speaker.js';
import { closeOnBackdrop, selectInList, createOverlays, typeaheadKeydown } from './overlay.js';
import { createThemes } from './themes.js';
import { createNarration, narrationTracks, slideClickMatch } from './narration.js';
import { stampClickMismatch } from '../../tools/click-match.mjs';
import { buildPrintPages } from './print.js';
import { createHud } from './hud.js';
import { setupMedia } from './media.js';
import { createEditMode } from './editmode.js';
import { createAuthoring } from './authoring.js';
import { createEditBar } from './editbar.js';
import { createSources } from './sources.js';
import { createInspector } from './inspector.js';
import { createOnboarding } from './onboarding.js';
import { createOverflowWatch } from './overflow.js';
import { createPlaylist } from './playlist.js';
import { createRangePicker } from './ranges.js';
import { createChoiceCard } from './choice.js';
import { createConceptTools } from './concept-tools.js';
import { createStyleClip } from './style-clip.js';
import { brandSnapper } from './colorpicker.js';
import { VIDEO_FORMATS, VIDEO_QUALITIES, VIDEO_SUBTITLES, VIDEO_FACE } from '../../tools/video-options.mjs';
import { buildIndex, rankMatches, slideTitle, slideBody } from './finder.js';
import { createReview } from './review.js';
import { createDebugLog, stashDebug, unstashDebug } from './debuglog.js';
import { createLayoutCycler } from './layout.js';
import { paletteRows } from './palette.js';
import { createPreview } from './preview.js';
import { createDesignSystemsPicker, createSlideTemplatePicker, createLookOffer } from './design-systems.js';
import { createMarketplaces, autoCheckToastText } from './marketplaces.js';
import { createConceptsEditor, conceptsOn, conceptSuggestions, markConceptHints } from './concepts.js';
import { setupSlideTemplates, isTemplateRef, pageDesignSystems } from './design-system.js';
import { createFonts } from './fonts.js';
import { createBleed } from './bleed.js';
import { readPref, readJson, writePref, writeJson } from './prefs.js';
import { markDensity } from './density.js';
import { createDeckCheck } from './deckcheck.js';
import { IS_MAC, UNDO_CHORD, REDO_CHORD } from './undo-chord.js';

// The chords the palette names beside a row (and beside its letter, when it
// has one too), spelled the way this machine spells them, as undo is.
const COMMIT_CHORD = IS_MAC ? '⌘K' : 'Ctrl+K';
const PRESENT_CHORD = IS_MAC ? '⌘⏎' : 'Ctrl+Enter';
const SPEAKER_CHORD = IS_MAC ? '⌥⏎' : 'Alt+Enter';
const MESSAGES_CHORD = IS_MAC ? '⌃`' : 'Ctrl+`';

/**
 * ⌘Z on a Mac, Ctrl+Z everywhere else — and ⇧ with it for redo: the undo
 * every editor has trained, and the only one since bare Z stopped undoing
 * (undo-chord.js). One platform's chord only, so Ctrl+Z on a Mac stays
 * whatever the Mac makes it, as ⌘Z on Windows does.
 */
const isUndoChord = (e) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
  && !e.altKey && (e.key === 'z' || e.key === 'Z');


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

/**
 * For `decklight check`, which reads the print view's DOM the way it reads
 * `data-overflow`: `data-click-mismatch="<markers> <clicks> <cause>"` on a
 * slide whose [click] markers and build clicks disagree, counted by the
 * engine, so a provider's steps are in it (#929).
 */
function markClickMismatch(section, record) {
  const m = slideClickMatch(section, record);
  if (m) section.setAttribute('data-click-mismatch', stampClickMismatch(m));
  else section.removeAttribute('data-click-mismatch');
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

/** The pin Y a section resolves to under its data-layout, or null for none. */
function pinYFor(sec, config) {
  const layout = sec.getAttribute('data-layout');
  // a slide template owns the slide's geometry (SPEC DESIGN_SYSTEMS):
  // no pin, not even the auto one an unknown value used to fall into
  if (sec.hasAttribute('data-template')) return null;
  if (layout === 'pinned') {
    const n = parseFloat(sec.getAttribute('data-pin'));
    return isFinite(n) ? n : (deckPinY(config) ?? PIN_DEFAULT_Y);
  }
  if (layout === 'centered' || layout === 'top') return null;
  return autoPinY(sec, config); // auto and the split layouts keep the deck's pin
}

function setupPinnedTitles(sections, config) {
  // Three passes, not one loop. Measuring forces layout, and a read that
  // follows a write on ANOTHER section flushes style for the whole page — so
  // one loop that wrote, read, wrote, read cost up to two synchronous reflows
  // per slide, on every sync(), every font change and every L press. Writes
  // first, then every read, then the writes that depend on them: the browser
  // lays out once. Sections are absolutely positioned over the stage, so
  // measuring them all at once under .pin-measure changes nothing about any
  // one of them.
  const toMeasure = [];
  for (const sec of sections) {
    const heading = leadingHeading(sec);
    const y = pinYFor(sec, config);
    const subtitle = detectSubtitle(sec, heading);
    sec.querySelector(':scope > .pin-title')?.classList.remove('pin-title');
    sec.querySelector(':scope > .pin-subtitle')?.classList.remove('pin-subtitle');
    if (y === null || !heading) {
      sec.removeAttribute('data-pinned');
      sec.style.removeProperty('--pin-y');
      sec.style.removeProperty('--pin-sub-y');
      sec.style.removeProperty('--pin-space');
      continue;
    }
    heading.classList.add('pin-title');
    // The subtitle joins the pinned header block, directly under the title.
    subtitle?.classList.add('pin-subtitle');
    sec.setAttribute('data-pinned', '');
    sec.style.setProperty('--pin-y', y + 'px');
    // Inactive sections are display:none — measure under a momentary
    // display:flex + visibility:hidden (no paint happens within this task).
    sec.classList.add('pin-measure');
    toMeasure.push({ sec, heading, subtitle, y });
  }
  for (const m of toMeasure) {
    m.titleH = m.heading.offsetHeight || 0;
    m.subH = m.subtitle ? (m.subtitle.offsetHeight || 0) : 0;
  }
  for (const { sec, subtitle, y, titleH, subH } of toMeasure) {
    let headerBottom = y + titleH;
    if (subtitle) {
      sec.style.setProperty('--pin-sub-y', Math.round(headerBottom + PIN_SUB_GAP) + 'px');
      headerBottom += PIN_SUB_GAP + subH;
    }
    sec.classList.remove('pin-measure');
    sec.style.setProperty('--pin-space', Math.round(headerBottom + PIN_GAP) + 'px');
  }
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

function setupSplit(sections, slideNumber = (i) => i + 1) {
  sections.forEach((sec, i) => {
    sec.querySelectorAll(':scope > .split-columns, :scope > .split-footer')
      .forEach((el) => el.classList.remove('split-columns', 'split-footer'));
    const layoutName = sec.getAttribute('data-layout') || '';
    if (!/^split/.test(layoutName) || sec.hasAttribute('data-template')) {
      sec.removeAttribute('data-split-conflict');
      return;
    }
    const content = splitContent(sec);
    checkSplitConflict(sec, content, slideNumber(i));
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

/**
 * The deep-link grammar, at module scope so it can be a unit test.
 *
 * `#/12/3` is slide 12, build step 3 — the only URL shape every shared link
 * depends on. It lived inside init() reading location.hash directly, which
 * made it testable only by loading a deck; it now takes the hash and stays
 * silent about where it came from.
 */
export function hashOf(h) {
  return (h || '').replace(/^#/, '');
}

/** `#/12/3` → { slide: 12, step: 3 }; `#/7` → step 0; anything else → null. */
export function parseHash(hash) {
  const m = hashOf(hash).match(/^\/(\d+)(?:\/(\d+))?/);
  if (!m) return null;
  return { slide: parseInt(m[1], 10), step: m[2] ? parseInt(m[2], 10) : 0 };
}

export function init(userConfig = {}) {
  const params = new URLSearchParams(location.search);
  const config = { ...DEFAULTS, ...userConfig };
  if (params.has('embedded')) config.controls = false;
  const printMode = params.has('print');
  // `?capture` — a render, not a live session (#548). `decklight video`, the
  // pptx export and a plain `shot` load each frame as a one-shot headless
  // Chrome, and everything that exists to talk to a person in the room —
  // toasts, the voice-over hint, the welcome card, the chevrons —
  // would otherwise be photographed into the artifact. Not `?embedded`: that
  // is the picker previews' mode and brings their postMessage and pref rules
  // with it; not `?print`: that reveals every build and changes the layout.
  const captureMode = params.has('capture');
  if (captureMode) config.controls = false;
  // `?all` presents the hidden slides too — the author checking one, or a
  // reviewer who needs to see everything. Never the default: a hidden slide is
  // hidden from the AUDIENCE, and the default is the audience (DECK_ANATOMY).
  const showHidden = params.has('all');
  const printVariant = params.get('print') || ''; // '' (plain) | 'handout' | 'notes'

  // ----- debug log (palette) -----------------------------------------------
  // The ring buffer (debuglog.js) records from init, whether or not the window
  // is open — by the time a presenter notices something went wrong, the reason
  // is already in the past. Built this early because theme restoration logs
  // during init, before there is any chrome to log into. D pops the window,
  // which then attaches itself as the buffer's sink.
  // A reload keeps the log: the page before stashed its buffer and the
  // reason it was told (debuglog.js), and this one starts from it, the
  // reason first — "↻ reloaded — notes saved · this tab" (PRESENTING).
  let stashed = null;
  try { stashed = unstashDebug(sessionStorage, location.pathname); } catch { /* no storage: a fresh log */ }
  const debug = createDebugLog({
    seed: stashed?.entries ?? [],
    first: stashed && { kind: 'reload', msg: `↻ reloaded — ${stashed.reason ?? 'by the browser (⌘R, or a navigation)'}` },
  });
  let debugEl = null;
  const debugLog = (kind, msg) => debug.log(kind, msg);
  // …and this page stashes on its way out: told why (the server's reload
  // message, through editmode) or not (⌘R, a navigation).
  let reloadReason = null;
  const stashDebugLog = () => { try { stashDebug(sessionStorage, location.pathname, debug.entries, reloadReason); } catch { /* no storage: the next page starts fresh */ } };
  const debugReload = (why) => { reloadReason = why; stashDebugLog(); };
  window.addEventListener('pagehide', stashDebugLog);

  const root = document.querySelector('.decklight');
  if (!root) throw new Error('Decklight: no .decklight element found');
  // A second init() on a running deck used to build a second engine over the
  // first: two keydown handlers, two hashchange listeners, two ResizeObservers
  // — one arrow press advanced two decks. Nothing here has a teardown, so the
  // honest answer is the instance that already exists.
  if (root.__decklight) {
    console.warn('Decklight: init() called again on a running deck — returning the existing instance');
    return root.__decklight;
  }

  // Which dialog owns the keyboard right now. Filled in below the features, in
  // priority order; consulted by onKey before the deck's own shortcuts.
  const overlays = createOverlays();

  // ----- playlist (multi-deck navigation) ------------------------------------
  // Two shapes, one vocabulary: chained FILES (config.playlist) and one
  // multi-module deck's data-module chapters. playlist.js holds the difference so that the
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
  // Beyond MSG_STACK the oldest goes early — never a toast that asks, which
  // stays until it is answered.
  function trimStack() {
    const passing = [...msgEl.children].filter((c) => !c.classList.contains('decklight-toast-ask'));
    while (passing.length && msgEl.children.length > MSG_STACK) passing.shift().remove();
  }
  function toast(msg, ms = 3200) {
    logOnly(msg);
    if (printMode || captureMode) return;
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
    trimStack();
    const drop = () => {
      row.classList.remove('show');
      setTimeout(() => row.remove(), 260); // after the fade
    };
    setTimeout(drop, ms);
  }

  /**
   * A toast that STAYS until it is answered: `actions` are `[label, run]`
   * buttons, and a × dismisses it. For what the author is asked to act on
   * (a deck behind its design system) rather than told in passing — gone
   * in nine seconds, it was read, never acted on. `run` returning false
   * keeps it up (the action failed and said why). `onDismiss` runs on the
   * Dismiss button alone, for an offer that remembers being turned down.
   * Returns `{ close }`.
   */
  function actionToast(msg, actions = [], { onDismiss = null } = {}) {
    logOnly(msg);
    if (printMode || captureMode) return { close() {} };
    if (!msgEl) {
      msgEl = document.createElement('div');
      msgEl.className = 'decklight-messages';
      root.appendChild(msgEl);
    }
    const row = document.createElement('div');
    row.className = 'decklight-toast decklight-toast-ask';
    row.setAttribute('role', 'alert');
    const text = document.createElement('div');
    text.className = 'toast-text';
    text.textContent = msg;
    const bar = document.createElement('div');
    bar.className = 'toast-actions';
    const close = () => {
      row.classList.remove('show');
      setTimeout(() => row.remove(), 260); // after the fade
    };
    for (const [label, run] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-act';
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        if ((await run()) === false) b.disabled = false; else close();
      });
      bar.appendChild(b);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-act toast-dismiss';
    x.textContent = 'Dismiss';
    x.addEventListener('click', () => { close(); onDismiss?.(); });
    bar.appendChild(x);
    row.append(text, bar);
    msgEl.appendChild(row);
    requestAnimationFrame(() => row.classList.add('show'));
    return { close };
  }

  /**
   * A problem said as a POINTER to Check deck… (PRESENTING_EDITING): one
   * line, and a button that opens the panel on the row for it — where the
   * whole sentence and the fix are — instead of a toast carrying the message
   * and expiring unread. `select` is the row: `{ rule, ref }`.
   */
  function problemToast(msg, select) {
    return actionToast(msg, [['Check deck…', () => { deckCheck.open(select); }]]);
  }

  /**
   * A toast that STAYS, and rewrites itself — `{ update, done }`.
   *
   * For work long enough that a fixed sentence stops being true halfway
   * through: an export rendering slide 7 of 12. One row, rewritten in place,
   * because a toast per slide would push everything else off the screen and
   * leave twelve near-identical lines in the message log, of which only the
   * first and the last are worth remembering — so those two are the only ones
   * logged.
   */
  function progressToast(msg) {
    logOnly(msg);
    if (printMode || captureMode) return { update() {}, done() {} };
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
    trimStack();
    let over = false;
    return {
      update(text) { if (!over) row.textContent = text; },
      done(text, ms = 3600) {
        over = true;
        if (text) { row.textContent = text; logOnly(text); }
        setTimeout(() => {
          row.classList.remove('show');
          setTimeout(() => row.remove(), 260); // after the fade
        }, ms);
      },
    };
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
    // a theme off the brand is a row in Check deck…, with its fix: the toast points there
    problem: (msg, rule) => problemToast(msg, { rule }),
  });
  const { applyTheme, currentTheme, cycleTheme, cancelCyclePending, rollTheme, saveGeneratedTheme } = themes;

  // Where a slide got what it says (SLIDE_SOURCES). Not author-only and not
  // presenter-only: notes are for the person talking, and where to read more is
  // for the person listening — so this ships in the deck a reader is handed.
  // ⌥⏎ — the speaker view: first press opens it, the next toggles speak ⇄ rehearse
  function speakerView() {
    const w = instance.__speakerWin;
    if (w && !w.closed) w.__decklightSpeakerToggle?.();
    else instance.__speakerWin = openSpeakerView(instance);
  }
  const sources = createSources({
    root, overlays, toast,
    reflow: () => instance._reflow?.(),
    // the same two accessors the layout cycler takes, for the same reason:
    // this is built before `instance` exists and only ever reads it from a
    // keystroke
    slideOf: () => instance.state.slide,
    sectionAt: (idx) => instance._sections[idx - 1],
    editmode: () => editmode,
  });
  // The inspector (I): built once the selection exists (after the editbar,
  // far below) and registered last among the overlays, so a docked inspector
  // never takes keys from a picker opened over it. Declared here because the
  // chrome update that keeps it on the right slide can run before then.
  let inspector = null;

  // Design systems… (SPEC DESIGN_SYSTEMS): the registered marketplaces'
  // design systems, toggled for this deck through the edit server
  // Marketplaces… (SPEC MARKETPLACES_SCREEN): every registered catalog, which
  // ones are behind their source, update and what's new, and `decklight
  // marketplace add` without leaving the deck; after an add or an update
  // every picker that lists what the marketplaces offer asks again, so the
  // catalog as it now is is in them at once
  const marketplaces = createMarketplaces({
    root, toast,
    base: () => (editmode?.available() ? editmode.base() : null),
    onChanged: () => { themes.refreshOffered(); fonts.refreshOffered(); },
    // a deck the update left behind its design system: Migrate, in the agent panel
    migrate: (ref) => editmode?.migrateDesignSystem(ref),
    debugLog: (...a) => debugLog(...a),
  });
  overlays.register({ isOpen: marketplaces.isOpen, close: marketplaces.close, keydown: marketplaces.keydown });
  const designSystems = createDesignSystemsPicker({
    root, toast,
    base: () => (editmode?.available() ? editmode.base() : null),
    addMarketplace: (opts) => marketplaces.open({ ...opts, view: 'add' }),
    // how many slides stand on its templates — what stopping using it takes from
    slidesUsing: (name) => (instance?._sections ?? []).filter((s) => s.getAttribute('data-template')?.startsWith(`${name}/`)).length,
    debugLog: (...a) => debugLog(...a),
  });
  overlays.register({ isOpen: designSystems.isOpen, close: designSystems.close, keydown: designSystems.keydown });
  // Concept colors… (SPEC SVG_DIAGRAMS, #718): every concept the deck's
  // diagrams name, pinned to a slot through the edit server, repainted live
  let conceptTools = null;   // made once editmode is (createConceptTools, below)
  let reviewOpenWanted = false;  // Review deck with agent… asked here: open Check deck… when it lands
  const conceptsEditor = createConceptsEditor({
    root, toast, stage: () => stage,
    base: () => (editmode?.available() ? editmode.base() : null),
    concepts: () => config.concepts ?? {},
    // a pin repaints the slides and the inspector's swatches with them
    apply: (map) => { config.concepts = map; applyConcepts(stage, config.concepts); inspector?.refresh?.(); },
    pageId: () => editmode?.pageId?.() ?? '',
    debugLog: (...a) => debugLog(...a),
    // pick mode attaches through the concept tools; ←/→ visit the slides a concept is on
    tools: () => conceptTools,
    slide: () => instance?.state.slide ?? 1,
    goto: (n) => instance.goto(n, 0),
  });
  // modal except in pick mode, where the arrows go on to the deck to walk the slides
  overlays.register({ isOpen: conceptsEditor.isOpen, close: conceptsEditor.close, keydown: conceptsEditor.keydown, modal: conceptsEditor.modal });
  // Use slide template…: this slide into a layout, to another, out of
  // one, or a new slide in one — written by the edit server
  // The look a design system was drawn for (SPEC DESIGN_SYSTEMS): offered
  // after an add, previewed live on the slide — the theme and the font
  // applied without being kept — and written only on ⏎.
  const lookOffer = createLookOffer({
    root, toast,
    base: () => (editmode?.available() ? editmode.base() : ''),
    debugLog: (...a) => debugLog(...a),
    preview: (look) => {
      const was = { theme: themes.currentTheme(), font: fonts.current() };
      if (look.themeChanges && look.theme) themes.applyTheme(look.theme, true, { persist: false });
      if (look.fontChanges && look.font) fonts.apply(look.font, { silent: true, persist: false });
      return was;
    },
    restore: (was) => {
      if (was?.theme) themes.applyTheme(was.theme, true, { persist: false });
      if (was?.font) fonts.apply(was.font, { silent: true, persist: false });
    },
    keep: (look) => {
      if (look.themeChanges && look.theme) themes.applyTheme(look.theme, true);
      if (look.fontChanges && look.font) fonts.apply(look.font, { silent: true });
    },
  });
  overlays.register({ isOpen: lookOffer.isOpen, close: lookOffer.close, keydown: lookOffer.keydown });
  /** A design system the deck uses whose look the deck does not wear — the layout picker's one-line offer. */
  function lookHint() {
    const themeNames = themes.themeList();
    const fontIds = fonts.list().map((f) => f.id);
    for (const sys of pageDesignSystems().values()) {
      const theme = (sys.recommendedThemes ?? []).map((t) => t.split('@')[0]).find((t) => themeNames.includes(t)) ?? null;
      const fontRow = (sys.recommendedFonts ?? []).map((t) => t.split('@')[0]).map((id) => fonts.list().find((f) => f.id === id))
        .find(Boolean) ?? null;
      const font = fontRow && fontIds.includes(fontRow.id) ? fontRow.id : null;
      const themeChanges = !!theme && config.theme !== theme;
      const fontChanges = !!font && config.font !== font;
      if (themeChanges || fontChanges) {
        return { ref: sys.name, title: sys.title || sys.name, theme, font, fontLabel: fontRow?.label, themeChanges, fontChanges };
      }
    }
    return null;
  }
  const slideTemplates = createSlideTemplatePicker({
    root, toast, deck: () => instance,
    base: () => (editmode?.available() ? editmode.base() : null),
    lookHint, offerLook: (o) => lookOffer.show(o),
    debugLog: (...a) => debugLog(...a),
  });
  overlays.register({ isOpen: slideTemplates.isOpen, close: slideTemplates.close, keydown: slideTemplates.keydown });

  // ----- slide finder: / opens find-a-slide with live preview ---------------
  // Same panel anatomy and lazy-preview mechanism as the theme picker: the
  // embedded deck boots once, then selections postMessage a goto into it.
  // Matching is word-AND over the slide's text; title hits rank above
  // body-only hits, and each match is listed by its title.
  let finderEl = null, finderSel = 0, finderQuery = '', finderMatches = [], finderDebounce;
  // `entry` is a finder row: a slide of THIS deck, or a module — another file,
  // which the iframe has to actually load rather than postMessage a goto into.
  // Faithful preview: the src carries the active theme (generated/custom
  // travel as tokens).
  const finderPreview = createPreview({
    docOf: (entry) => entry.href ?? location.pathname,
    srcFor: (entry) => (entry.href ?? location.pathname) + themes.previewQuery() + '#/' + (entry.slide ?? 1) + '/0',
    messageFor: (entry) => ({ __decklightPreview: { goto: [entry.slide ?? 1, 0] } }),
  });
  function finderIndex() {
    const rows = buildIndex({
      sections: instance._sections,
      modules: playlist?.modules ?? [],
      skipModule: playlistIndex,
    });
    // A multi-module deck's chapters get rows of their own, ahead of the slide list.
    // `buildIndex` used to hold that in-file chapters "need nothing special —
    // they are already indexed as ordinary slides", which is true of FINDING
    // one and false of seeing that the deck has any: in a 100-slide merge the
    // chapter headings are five rows scattered through ninety-five others,
    // indistinguishable unless you already know their titles (#479).
    //
    // Only for the in-file shape. The two never coexist — `playlist.js` gives
    // markers precedence — so this is an `else`, not a second list.
    if (!hasMarkersDOM || playlist) return rows;
    const chapters = moduleNav.markers().map((m) => ({
      slide: m.slide,
      title: m.title,
      chapter: true,
      haystack: (m.title || '').toLowerCase(),
    }));
    return [...chapters, ...rows];
  }
  // ── the outline (#489) ────────────────────────────────────────────────────
  // With chapters and nothing typed, the finder is the deck's OUTLINE: each
  // chapter folds its own slides underneath it. #479 made chapters visible as
  // rows ahead of the slides; in a 150-slide merge that was ten useful rows
  // bolted onto a dump of everything. Typing drops the fold and shows the flat
  // ranked list, because a query's answer is sorted by relevance and a tree
  // would hide half of it — folding is a BROWSING aid, not a search one.
  let finderOpen = new Set();        // chapter slide numbers currently unfolded
  const finderOutlined = () => hasMarkersDOM && !playlist && !finderQuery;
  /** The chapter a slide belongs to — the last marker at or before it — or null. */
  const chapterOf = (slide) => {
    let at = null;
    for (const m of moduleNav.markers()) if (m.slide <= slide) at = m.slide;
    return at;
  };
  function finderOutline() {
    const slides = finderEl.__index.filter((m) => !m.chapter && !m.href);
    const marks = moduleNav.markers();
    const out = [];
    // slides before the first chapter belong to none, and stay top-level
    for (const sl of slides) if (!marks.length || sl.slide < marks[0].slide) out.push(sl);
    marks.forEach((mk, i) => {
      const end = marks[i + 1]?.slide ?? Infinity;
      const kids = slides.filter((sl) => sl.slide >= mk.slide && sl.slide < end);
      const open = finderOpen.has(mk.slide);
      out.push({ slide: mk.slide, title: mk.title, chapter: true, count: kids.length, open });
      if (open) for (const k of kids) out.push({ ...k, child: true, parent: mk.slide });
    });
    return out;
  }
  /** Re-render the outline keeping the cursor on `pick`, a row predicate. */
  function refold(pick) {
    renderFinderList();
    const i = finderMatches.findIndex(pick);
    if (i >= 0) selectFinderRow(i, false);
  }
  /** ← and → over the outline: unfold, step in, fold, climb out. */
  function finderFold(right) {
    const m = finderMatches[finderSel];
    if (!m) return true;
    if (right) {
      if (m.chapter && !m.open) {
        finderOpen.add(m.slide);
        refold((r) => r.chapter && r.slide === m.slide);
      } else if (m.chapter && finderMatches[finderSel + 1]?.child) {
        selectFinderRow(finderSel + 1, false);
      }
      return true;
    }
    const at = m.chapter ? m.slide : m.parent;
    if (at == null) return true;     // a slide before the first chapter: no parent
    finderOpen.delete(at);
    refold((r) => r.chapter && r.slide === at);
    return true;
  }
  function renderFinderList() {
    const listBox = finderEl.querySelector('.tp-list');
    finderMatches = finderOutlined() ? finderOutline() : rankMatches(finderEl.__index, finderQuery);
    listBox.textContent = '';
    finderMatches.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'tp-row' + (m.slide === instance.state.slide && !m.chapter ? ' tp-current' : '')
        + (m.href || m.chapter ? ' tp-module' : '') + (m.child ? ' tp-child' : '');
      // Both shapes read the same, because they mean the same thing to the
      // person looking for one (`playlist.js`: two shapes, one vocabulary).
      // What differs is what happens on ⏎ — a page load or a goto — and the
      // caption is where that is said.
      if (m.chapter && m.count != null) {
        // In the outline the glyph is a real control: clicking it folds, and
        // clicking the rest of the row still goes there, as every row does.
        const fold = document.createElement('span');
        fold.className = 'tp-fold';
        fold.textContent = m.open ? '▾' : '▸';
        fold.title = m.open ? 'fold (←)' : 'unfold (→)';
        fold.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (m.open) finderOpen.delete(m.slide); else finderOpen.add(m.slide);
          refold((r) => r.chapter && r.slide === m.slide);
        });
        row.append(fold, ` ${m.title} — module`);
        const count = document.createElement('span');
        count.className = 'tp-count';
        count.textContent = ` · ${m.count} slide${m.count === 1 ? '' : 's'}`;
        row.append(count);
      } else {
        row.textContent = m.href || m.chapter ? `▸ ${m.title} — module` : `${m.slide} · ${m.title}`;
      }
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
    bar.textContent = finderQuery
      || (playlist || hasMarkersDOM ? 'type to find a slide or module…' : 'type to find a slide…');
    bar.classList.toggle('tp-active', !!finderQuery);
  }
  const finderPreviewSwap = (frame, entry) => finderPreview.show(frame, entry);
  function selectFinderRow(i, immediate) {
    if (!finderMatches.length) return;
    finderSel = selectInList(finderEl.querySelectorAll('.tp-row'), i, 'tp-selected');
    const m = finderMatches[finderSel];
    finderEl.querySelector('.tp-caption').textContent = m.href
      ? `module — ${m.title} (${m.href})`
      : m.chapter ? `module — ${m.title} (slide ${m.slide} of this deck)`
        : `slide ${m.slide} — ${m.title}`;
    clearTimeout(finderDebounce);
    const frame = finderEl.querySelector('iframe');
    if (immediate) finderPreviewSwap(frame, m);
    else finderDebounce = setTimeout(() => finderPreviewSwap(frame, m), 60);
  }
  function setFinderQuery(q) {
    const had = finderMatches[finderSel];
    const prevQuery = finderQuery;
    finderQuery = q;
    if (finderOutlined() && had && !had.href) {
      // back to the outline: unfold the chapter of whatever the query had found,
      // and land on it, rather than dropping you at the top of a folded tree
      const ch = had.chapter ? had.slide : chapterOf(had.slide);
      if (ch != null) finderOpen.add(ch);
      renderFinderList();
      const i = finderMatches.findIndex((r) => r.slide === had.slide && !!r.chapter === !!had.chapter);
      selectFinderRow(Math.max(0, i), false);
      return;
    }
    const widening = q.length < prevQuery.length && prevQuery.startsWith(q);
    renderFinderList();
    if (!finderMatches.length) {
      finderEl.querySelector('.tp-caption').textContent = 'no match';
      return;
    }
    // Backspacing WIDENS the query, and every row you could see is still there:
    // keep the one you had rather than snapping to the top on each keystroke —
    // otherwise, by the time the query is empty, "where you were" is whatever
    // `t` happened to rank first. Typing narrows, so it picks the best hit.
    const kept = widening && had
      ? finderMatches.findIndex((r) => r.slide === had.slide && !!r.chapter === !!had.chapter && r.href === had.href)
      : -1;
    selectFinderRow(Math.max(0, kept), false);
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
    overlays.opening();
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
    // the outline opens folded, except where you are standing
    finderOpen = new Set();
    const here = hasMarkersDOM && !playlist ? chapterOf(instance.state.slide) : null;
    if (here != null) finderOpen.add(here);
    renderFinderList();
    closeOnBackdrop(finderEl, closeSlideFinder);
    root.appendChild(finderEl);
    selectFinderRow(Math.max(0, finderMatches.findIndex((m) => !m.chapter && m.slide === instance.state.slide)), true);
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
  let palEl = null, palSel = 0, palQuery = '', palRows = [], palCommands = [];
  // ── HIDDEN_SLIDES from the palette ──────────────────────────────────────
  const hasHiddenSlides = () => (instance._sections ?? []).some((s) => s.hasAttribute('data-hidden'));
  const currentHidden = () => !!instance._sections?.[instance.state.slide - 1]?.hasAttribute('data-hidden');
  // `?all` is a URL mode, not a runtime switch (the print filter and the
  // navigation predicate both read it at load), so showing hidden slides is a
  // reload with the flag flipped — same slide, same step.
  function toggleShowHidden() {
    const u = new URL(location.href);
    if (showHidden) u.searchParams.delete('all'); else u.searchParams.set('all', '');
    location.href = u.href;
  }
  // Hide (or unhide) a slide in the FILE — the same door as layout picks:
  // one POST, one undo entry — and mirror it in the DOM at once so the
  // author sees the change before the reload, stepping off the slide that
  // just disappeared from the talk.
  async function setHidden(slide, hidden) {
    const sec = instance._sections?.[slide - 1];
    if (!sec) return;
    try {
      const r = await fetch(editmode.base() + '/deck/edit/slide/hidden', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slide, hidden }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch (e) { toast(`could not ${hidden ? 'hide' : 'unhide'} slide ${slide} — ${e.message}`); return; }
    sec.toggleAttribute('data-hidden', hidden);
    toast(hidden ? `slide ${slide} hidden — the audience will not see it (?all shows it)` : `slide ${slide} shown again`);
    if (hidden && !showHidden && instance.state.slide === slide) {
      const to = instance._visibleFrom(slide + 1, +1) ?? instance._visibleFrom(slide - 1, -1);
      if (to != null) instance.goto(to, 0);
    }
  }
  // The speaker popup, opened if it is not already — for the palette rows
  // that drive something inside it.
  function speakerWindow() {
    const w = instance.__speakerWin;
    if (w && !w.closed) return w;
    return (instance.__speakerWin = openSpeakerView(instance));
  }

  /**
   * The order categories are listed in when nothing is typed: where a
   * presenter goes first, then the slide in hand, then everything else. Every
   * command names one (`cat`) and the palette shows it as a prefix, the way
   * VS Code's command palette reads: `Voice: Live voice…`, `Share: Export to
   * PDF…`. All of them sit at the root; typing the category narrows to it.
   */
  const PALETTE_CATEGORIES = ['Running', 'Go to', 'Slide', 'Edit', 'Look', 'Voice', 'Present', 'Review', 'Git', 'Share', 'Help', 'Preferences'];

  function paletteCommands() {
    const has = (fn) => typeof fn === 'function';
    // ONE rule for write mode: a row that changes the file, or needs the edit
    // server to run, exists only while the deck can be written, and carries
    // the write tag. Before, some such rows were tagged "(dev)" without being
    // gated, so they showed in a read-only deck, and some were gated without
    // the tag, so they sat among the presenter's rows untagged.
    const write = (row) => editmode.available() && { ...row, write: true };
    const stoppable = editmode.running();
    const all = [
      // ── Running: only while a long job is, so it is the first row ───────
      // a video, a PDF, an agent's edit — stopped without stopping the server
      stoppable && { label: stoppable.label, cat: 'Running',
        alias: 'stop cancel abort halt kill interrupt quit end export render video agent running job',
        run: () => editmode.stopRunning() },
      // ── Go to ───────────────────────────────────────────────────────────
      { label: 'Find slide…', cat: 'Go to', hint: 'G', alias: 'search grep goto module chapter jump', run: () => { openSlideFinder(); if (palQuery) setFinderQuery(palQuery); } },
      { label: 'Go to slide…', cat: 'Go to', hint: '#', alias: 'goto jump number', keepOpen: true, run: () => { palQuery = 'goto '; renderPalette(); } },
      { label: 'Overview', cat: 'Go to', hint: 'O', alias: 'grid thumbnails all slides rearrange', run: toggleOverview },
      { label: 'First slide', cat: 'Go to', hint: 'Home', run: () => instance.goto(1, 0) },
      { label: 'Last slide', cat: 'Go to', hint: 'End', run: () => instance.goto(instance.state.totalSlides, 0) },
      // ── Slide: the one on screen ────────────────────────────────────────
      { label: editmode.available() ? 'Edit speaker notes…' : 'Speaker notes (read-only)…', cat: 'Slide', hint: 'S', alias: 'edit mode notes write script read right-click background', run: toggleEditor },
      { label: 'Inspector', cat: 'Slide', hint: 'I',
        alias: 'inspect info information properties details facts sources references links provenance citation contrast box font',
        run: () => inspector?.open() },
      sources.canEdit() && {
        label: sources.has() ? 'Edit sources on this slide…' : 'Add sources to this slide…', cat: 'Slide', write: true,
        alias: 'sources references links reading provenance where citation cite',
        run: () => sources.edit() },
      write({ label: 'New slide after this one', cat: 'Slide', alias: 'add slide insert blank create page', run: () => editmode.slideOp('new') }),
      write({ label: 'Duplicate this slide', cat: 'Slide', alias: 'copy slide clone', run: () => editmode.slideOp('duplicate') }),
      write({ label: 'Move slide up', cat: 'Slide', alias: 'reorder earlier before swap', run: () => editmode.slideOp('up') }),
      write({ label: 'Move slide down', cat: 'Slide', alias: 'reorder later after swap', run: () => editmode.slideOp('down') }),
      write({ label: 'Delete this slide', cat: 'Slide', alias: 'remove slide drop', run: () => editmode.slideOp('delete') }),
      write({ label: `${currentHidden() ? 'Unhide' : 'Hide'} this slide`, cat: 'Slide', alias: 'hidden hide skip cut backup keep out of the talk unhide show', run: () => setHidden(instance.state.slide, !currentHidden()) }),
      write({ label: 'Cycle slide layout', cat: 'Slide', alias: 'pin pinned centered top auto split columns two sides arrange', run: () => cycleLayout(1) }),
      // Two rows, not one row with a mode in it: one adds a slide, the other
      // rewrites one you wrote, and ⏎ should not depend on a keystroke you
      // may not have pressed.
      write({ label: 'Use slide template…', cat: 'Slide',
        alias: 'slide template slots convert switch insert slide divider section structure design system',
        run: () => slideTemplates.open() }),
      // ── Edit ────────────────────────────────────────────────────────────
      write({ label: 'Undo deck edit', cat: 'Edit', hint: UNDO_CHORD, alias: 'revert back history', run: () => deckHistory('undo') }),
      write({ label: 'Redo deck edit', cat: 'Edit', hint: REDO_CHORD, alias: 'forward history repeat', run: () => deckHistory('redo') }),
      write({ label: 'Ask agent…', cat: 'Edit', hint: 'A', alias: 'ai claude codex bob gemini prompt edit', run: toggleAgentAsk }),
      // the format painter, on whatever is selected while editing (style-clip.js)
      editmode.elementEditOn() && editbar.selected() && write({ label: 'Copy style', cat: 'Edit', hint: styleClip.keys.copy,
        alias: 'format painter copy formatting colours colors fill border font look match',
        run: () => styleClip.copy(editbar.selected()) }),
      editmode.elementEditOn() && editbar.selected() && styleClip.has() && write({ label: 'Paste style', cat: 'Edit', hint: styleClip.keys.paste,
        alias: 'format painter paste formatting apply colours colors fill border font look match same as',
        run: () => styleClip.paste(editbar.selected()) }),
      write({ label: 'Concept colors…', cat: 'Edit',
        alias: 'concept colours colors semantic diagram fill slot pin data-concept recurring same colour everywhere colour by meaning color by meaning legend idea shapes boxes attach group',
        run: () => conceptsEditor.open() }),
      write({ label: editbar.hidden() ? 'Show the bar' : 'Hide the bar', cat: 'Edit',
        alias: 'editing bar toolbar hide show toggle chrome buttons', run: () => editbar.toggleHidden() }),
      // The lock is the one write row that stays while the deck is locked:
      // it is how you unlock it. So it asks served/no-trust, not available().
      editmode.served() && !editmode.noTrust() && { label: editmode.locked() ? 'Unlock deck' : 'Lock deck — nothing changes the file until you unlock it', cat: 'Edit', write: true,
        alias: 'lock unlock read only readonly protect freeze avoid changes by mistake editing off', run: () => editmode.toggleLock() },
      // ── Look ────────────────────────────────────────────────────────────
      { label: 'Theme…', cat: 'Look', hint: 'T', alias: 'colours colors palette', run: themes.openPicker },
      { label: 'Cycle theme', cat: 'Look', hint: ', · .', run: () => cycleTheme(1) },
      !themes.brandLocked() && { label: 'Generate a theme', cat: 'Look', hint: '⌃T', run: rollTheme },
      themes.hasGenerated() && { label: 'Save the generated theme…', cat: 'Look', hint: '⌃⇧T', run: () => saveGeneratedTheme() },
      // marketplace themes are listed only while authoring (THEME_BROWSE#UI)
      write({ label: 'Marketplace themes…', cat: 'Look', alias: 'browse marketplace install add mark third-party catalog', run: themes.browse }),
      { label: 'Font…', cat: 'Look', hint: '[ · ]', run: openFontPicker },
      write({ label: 'Design systems…', cat: 'Look',
        alias: 'design system brand kit company tokens layouts slots marketplace corporate identity style guide',
        run: () => designSystems.open() }),
      // never under --no-trust: write() needs a deck that can be written, and
      // the route sits behind the server's mode gate besides
      write({ label: 'Marketplaces…', cat: 'Look',
        alias: 'marketplace marketplaces catalogs add register update upgrade refresh outdated out of date check whats new what\'s new changes changelog repo repository git clone owner design systems themes fonts install source',
        run: () => marketplaces.open() }),
      // ── Voice ───────────────────────────────────────────────────────────
      // ⎵ is the verb and V the panel. The rows below the panel row open it
      // on one of its views, so they are found by what they are called; only
      // the panel row carries V, since V opens the panel, not those views.
      { label: `Narration ${narration.status().paused ? 'resume' : narration.status().narrating ? 'pause' : 'play'}`, cat: 'Voice',
        hint: '⎵', alias: 'play pause resume voice narration speak start stop', run: () => narration.playPause() },
      { label: 'Narration…', cat: 'Voice', hint: 'V', alias: 'voice audio track picker panel', run: () => openNarrPicker('tracks') },
      { label: 'Live voice…', cat: 'Voice', alias: 'tts synthesize tone gemini elevenlabs engine', run: () => openNarrPicker('voices') },
      { label: 'Character…', cat: 'Voice', alias: 'avatar lipsync face talking head visemes', run: () => openNarrPicker('character') },
      { label: `Character solo ${character.solo ? 'off' : 'on'}`, cat: 'Voice', alias: 'centre center stage narrator only fullscreen avatar', run: () => narration.applySolo(!character.solo) },
      { label: 'Record this deck…', cat: 'Voice', alias: 'record narrate microphone mic voice wav offline batch teleprompter',
        run: () => openNarrPicker('record') },
      { label: `Captions ${narration.status().captionsOn ? 'off' : 'on'}`, cat: 'Voice', hint: 'C', alias: 'cc subtitles closed caption', run: toggleCaptions },
      { label: 'Voice faster', cat: 'Voice', hint: '>', alias: 'speed rate playback', run: () => changeNarrRate(+0.25) },
      { label: 'Voice slower', cat: 'Voice', hint: '<', alias: 'speed rate playback', run: () => changeNarrRate(-0.25) },
      // each engine a registered marketplace declares a wizard for (ENGINES#WIZARD)
      ...editmode.wizards().map((w) => write({
        label: `Configure ${w.title}…`, cat: 'Voice',
        alias: 'engine wizard setup api key credential token marketplace',
        run: () => editmode.wizard(w.qualified),
      })),
      // the writing tools (src/core/writing.js): one picker asks which tool
      // and which slides; a tool's own row opens it on the slides step. The
      // agent drafts, decklight checks, the review decides (cli/enhance.mjs)
      write({ label: 'Writing tools…', cat: 'Voice',
        alias: 'writing rewrite enhance script notes voiceover agent tools picker',
        run: () => editmode.openWriting() }),
      write({ label: 'Add audio tags to the script…', cat: 'Voice',
        alias: 'enhance elevenlabs v4 audio tags expressive emotion notes narration voice script improve direction this slide module every',
        run: () => editmode.openWriting({ tool: 'tags' }) }),
      write({ label: 'Write the script for the ear…', cat: 'Voice',
        alias: 'spoken conversational natural sentences rewrite notes voiceover script say aloud human speakable ear this slide module every',
        run: () => editmode.openWriting({ tool: 'spoken' }) }),
      // ── Present ─────────────────────────────────────────────────────────
      { label: 'Speaker view — second window', cat: 'Present', hint: SPEAKER_CHORD, alias: 'presenter view display timer next slide rehearse popup', run: speakerView },
      { label: 'Fullscreen', cat: 'Present', hint: 'F · ' + PRESENT_CHORD, run: () => toggleFullscreen() },
      { label: `${fsChromeHidden() ? 'Show' : 'Hide'} arrows and slide number in fullscreen`, cat: 'Present', hint: '⇧F',
        alias: 'chevrons controls prev next counter page number chrome clean distraction free', run: () => setFsChrome(!fsChromeHidden()) },
      { label: 'Blackout', cat: 'Present', hint: 'B', run: toggleBlackout },
      { label: `Pen ${hud.annotator?.tool === 'pen' ? 'off' : 'on'} — draw on the slide`, cat: 'Present', hint: 'W', alias: 'ink annotate draw scribble marker highlight', run: () => toggleInk('pen') },
      { label: `Laser pointer ${hud.annotator?.tool === 'laser' ? 'off' : 'on'}`, cat: 'Present', hint: '⇧W', alias: 'ink dot glow point at', run: () => toggleInk('laser') },
      // The clock lost K to the commit window and lives here, with no key.
      { label: `Clock ${hud.status().clockOn ? 'off' : 'on'}`, cat: 'Present', alias: 'time elapsed timer talk wall watch clock', run: toggleClock },
      { label: `Progress bar ${hud.status().progressOn ? 'off' : 'on'}`, cat: 'Present', alias: 'bar bottom edge position how far through shape of the talk', run: toggleProgress },
      // REHEARSAL_TIMINGS: the recorder lives in the speaker view; this opens
      // it (if it is not already) and starts the clock in one step.
      { label: 'Rehearse timings… (speaker view)', cat: 'Present', alias: 'rehearsal timing time each slide record pace plan stopwatch',
        run: () => { const w = speakerWindow(); w?.__decklightSpeakerRec?.(true); } },
      // HIDDEN_SLIDES: contextual, since a deck with nothing hidden has nothing to show
      (showHidden || hasHiddenSlides()) && { label: `Hidden slides ${showHidden ? 'skip' : 'show'}`, cat: 'Present',
        alias: 'all cut backup skipped unhide reveal present hidden ⊘', run: toggleShowHidden },
      { label: 'Transcript… (speaker view)', cat: 'Present', alias: 'notes script whole deck text spoken read', run: () => openTranscript() },
      { label: 'Download the transcript (.md)', cat: 'Share', alias: 'transcript notes script markdown download spoken text', run: () => instance.transcript.download('md') },
      { label: 'Download the transcript (.txt)', cat: 'Share', alias: 'transcript notes script text download spoken plain', run: () => instance.transcript.download('txt') },
      // ── Review ──────────────────────────────────────────────────────────
      { label: 'Comments…', cat: 'Review', hint: 'M', alias: 'feedback remarks reviewer notes critique review read', run: () => review.open() },
      { label: 'Leave a comment…', cat: 'Review', hint: '⇧M', alias: 'comment note remark feedback add write say', run: () => review.compose() },
      { label: 'Submit review…', cat: 'Review', alias: 'send review push comments submit feedback', run: () => review.submit() },
      { label: 'Check deck…', cat: 'Review', alias: 'lint check issues problems errors warnings crowded dense density overflow clipped validate verify report health fix',
        run: () => deckCheck.toggle() },
      // the agent reads the deck, read-only, and Check deck… lists what it found (cli/agent-review.mjs)
      write({ label: 'Review deck with agent…', cat: 'Review',
        alias: 'review improve critique feedback agent ai suggestions sources figures numbers voiceover notes titles diagram table better',
        run: () => { reviewOpenWanted = true; editmode.reviewDeck(); } }),
      // ── Git ─────────────────────────────────────────────────────────────
      // Not "version": that word is what somebody types to find out WHICH
      // decklight this is (Settings), and it landed here first.
      write({ label: 'History…', cat: 'Git', hint: 'H', alias: 'restore previous earlier rollback revert back git log commits unpushed push remote when changed', run: () => editmode.history.open() }),
      write({ label: 'Commit…', cat: 'Git', hint: 'K · ' + COMMIT_CHORD, alias: 'git save commit message history', run: () => editmode.commit.open() }),
      // ── Share ───────────────────────────────────────────────────────────
      // The print rows open a print VIEW in a tab: the same pages, not a file
      // anybody can be sent. The export rows write the file, by asking the
      // edit server to run the command, hence write mode only.
      write({ label: 'Export to PowerPoint…', cat: 'Share',
        alias: 'pptx powerpoint keynote google slides export file office send share hand over',
        run: () => editmode.exportDeck('pptx') }),
      write({ label: 'Export to PDF…', cat: 'Share',
        alias: 'pdf export file save send share hand over slides acrobat',
        run: () => editmode.exportDeck('pdf') }),
      write({ label: 'Export a PDF with notes…', cat: 'Share',
        alias: 'pdf notes script speaker one slide per page export file send rehearse',
        run: () => editmode.exportDeck('pdf-notes') }),
      write({ label: 'Export a PDF handout…', cat: 'Share',
        alias: 'pdf handout three per page audience note-taking export file send print',
        run: () => editmode.exportDeck('pdf-handout') }),
      // the file most often sent: the deck and everything it needs, in one HTML file
      write({ label: 'Bundle into one file…', cat: 'Share',
        alias: 'bundle standalone single file offline html send share email attach hand over export audio voice narration recorded track sound compressed small aac opus module chapter part',
        run: () => openBundle() }),
      // minutes rather than seconds, and usually of PART of the deck, so it asks which slides first
      write({ label: 'Export a video…', cat: 'Share',
        alias: 'video mp4 movie film render narrated voiceover export range chapter share upload youtube',
        run: () => openVideoExport() }),
      // a URL rather than a file, so it asks first: one press shows where it would go
      write({ label: 'Publish this deck…', cat: 'Share',
        alias: 'publish share url link web site pages gh-pages github deploy send hand over',
        run: () => editmode.publishDeck() }),
      { label: 'Print view (all slides, new tab)', cat: 'Share', alias: 'print pdf pages', run: () => window.open(location.pathname + '?print') },
      { label: 'Print with notes (one slide per page, new tab)', cat: 'Share', alias: 'pdf print speaker notes script handout pages', run: () => window.open(location.pathname + '?print=notes') },
      { label: 'Print handout (three per page, new tab)', cat: 'Share', alias: 'pdf print handout thumbnails audience note-taking lines', run: () => window.open(location.pathname + '?print=handout') },
      // ── Help ────────────────────────────────────────────────────────────
      { label: 'Keyboard help', cat: 'Help', hint: '?', alias: 'keys keyboard shortcuts', run: toggleHelp },
      { label: 'Messages', cat: 'Help', hint: '` · ' + MESSAGES_CHORD, alias: 'log toast notifications warnings why voice stopped history', run: toggleMessages },
      { label: 'Debug log', cat: 'Help', alias: 'console events state', run: toggleDebug },
      { label: 'Welcome to Decklight', cat: 'Help', alias: 'onboarding intro getting started first run tour what is this help me', run: onboarding.showWelcome },
      write({ label: 'Editing tour', cat: 'Help', alias: 'onboarding intro getting started first run tour how do I edit write mode gestures', run: onboarding.showEditingTour }),
      // ── Preferences ─────────────────────────────────────────────────────
      // `config` and `version` find it too; `version` is what somebody is
      // usually after in here.
      { label: 'Settings…', cat: 'Preferences', alias: 'config configuration preferences options about version build release which version',
        run: openSettings },
    ].filter(Boolean).filter((c) => has(c.run));
    return all;
  }
  function renderPalette() {
    const card = palEl.querySelector('.narr-card');
    card.textContent = '';
    // Which rows a query leaves, the inline "goto 27" argument and the
    // search fallback all live in palette.js; the commands themselves stay
    // here, where each one closes over what it runs.
    const rows = paletteRows({
      commands: palCommands,
      query: palQuery,
      categories: PALETTE_CATEGORIES,
      totalSlides: instance.state.totalSlides,
      makeGotoRow: (n, total) => ({
        label: `Go to slide ${n} / ${total}`, hint: '⏎', run: () => instance.goto(n, 0),
      }),
      makeSearchRow: (text) => ({
        label: `Search slides for “${text}”`, hint: '',
        run: () => { openSlideFinder(); setFinderQuery(text); },
      }),
    });
    palRows = rows;
    const bar = document.createElement('div');
    bar.className = 'pal-input' + (palQuery ? ' tp-active' : '');
    bar.textContent = palQuery || 'type a command…';
    card.appendChild(bar);
    let i = 0;
    for (const c of rows) {
      const at = i++;
      const el = document.createElement('div');
      el.className = 'narr-row pal-row';
      const label = document.createElement('span');
      // the category as a dimmer prefix, so the eye runs down the names
      if (c.cat) {
        const cat = document.createElement('span');
        cat.className = 'pal-cat';
        cat.textContent = `${c.cat}: `;
        label.appendChild(cat);
      }
      label.appendChild(document.createTextNode(c.label));
      el.appendChild(label);
      const right = document.createElement('span');
      right.className = 'pal-right';
      if (c.write) {
        const tag = document.createElement('span');
        tag.className = 'pal-tag';
        tag.textContent = 'write';
        right.appendChild(tag);
      }
      if (c.hint) {
        const kbd = document.createElement('span');
        kbd.className = 'pal-kbd';
        kbd.textContent = c.hint;
        right.appendChild(kbd);
      }
      if (right.childNodes.length) el.appendChild(right);
      el.addEventListener('mouseenter', () => selectPalRow(at));
      el.addEventListener('click', () => { selectPalRow(at); commitPalRow(); });
      card.appendChild(el);
    }
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
    overlays.opening();
    palQuery = '';
    // built once per open, not once per keystroke: the list consults a dozen
    // modules for their state and scans the deck for hidden slides, and none
    // of that changes while the palette is up
    palCommands = paletteCommands();
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

  // settings (palette drill-in): facts about what this deck is running, and a
  // home for the knobs that will never be worth a key of their own. One row
  // today — the runtime version, which is the first thing a bug report asks
  // for and which nothing in the player could previously tell you (the banner
  // is a comment in a file you would have to go open). Later settings join
  // THIS panel rather than growing the palette a row at a time.
  //
  // Baked in by the build (__DECKLIGHT_VERSION__), guarded the way themes.js
  // guards its own baked constants so importing this module in a unit test
  // does not throw on a define that only exists in a bundle.
  const RUNTIME_VERSION = typeof __DECKLIGHT_VERSION__ !== 'undefined' ? __DECKLIGHT_VERSION__ : '';
  let setEl = null, setSel = 0, setRows = [];
  /** The rows the panel shows. Exposed on the instance so a headless probe can
   *  assert the version without opening an overlay. A row with no `run` is a
   *  FACT, not a disabled command: it is shown plainly, never greyed out. */
  // Voice speed in Settings walks these; `<` and `>` still step by 0.25.
  const VOICE_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  function settingsRows() {
    return [
      // ⏎ copies it: the version goes into a bug report, and a number you
      // have to retype is a number that arrives with a typo in it
      { label: 'Decklight version', value: RUNTIME_VERSION || 'unknown — not a built bundle',
        ...(RUNTIME_VERSION ? { hint: '⏎ copies', run: () => copyText(RUNTIME_VERSION) } : {}) },
      // a knob, not a fact: ⏎ switches it and says which it is now. A knob
      // `stays`: the panel is redrawn around it rather than closed, so the
      // row reads the new value and a second ⏎ switches back — closing on
      // every press made a two-way switch cost three keys a turn.
      ...(printMode ? [] : [{ label: 'Display', value: displayFill ? 'fill screen' : deckRatio(),
        hint: '⏎ switches', stays: true, run: () => setDisplay(!displayFill) }]),
      // The presenter's knobs, here as well as in the palette: the palette is
      // where you DO a thing, Settings is where you see how the deck is set
      // up and change it in one place. Each is remembered per deck already;
      // this is the view of what is remembered.
      ...(printMode ? [] : [
        { label: 'Arrows and slide number in fullscreen', value: fsChromeHidden() ? 'hidden' : 'shown', hint: '⏎ switches · ⇧F', stays: true, run: () => setFsChrome(!fsChromeHidden()) },
        { label: 'Clock', value: hud.status().clockOn ? 'on' : 'off', hint: '⏎ switches', stays: true, run: () => toggleClock() },
        { label: 'Progress bar', value: hud.status().progressOn ? 'on' : 'off', hint: '⏎ switches', stays: true, run: () => toggleProgress() },
        { label: 'Captions', value: narration.status().captionsOn ? 'on' : 'off', hint: '⏎ switches', stays: true, run: () => toggleCaptions() },
        { label: 'Voice speed', value: `${narration.status().rate}×`, hint: '⏎ cycles', stays: true, run: () => {
          const rate = narration.status().rate;
          const next = VOICE_SPEEDS.find((v) => v > rate + 1e-6) ?? VOICE_SPEEDS[0];
          changeNarrRate(next - rate);
        } },
      ]),
      // write mode only: the bar is editing's face, hidden or shown per deck
      ...(editmode?.available() ? [{ label: 'Editing bar', value: editbar.hidden() ? 'hidden' : 'shown',
        hint: '⏎ switches', stays: true, run: () => editbar.toggleHidden() }] : []),
      // write mode only: Push lives in the commit window, which only an edit
      // server has
      ...(editmode?.available() ? [{ label: 'Push tags', value: editmode.pushTags() ? 'with the branch' : 'off',
        hint: '⏎ switches', stays: true, run: () => editmode.setPushTags(!editmode.pushTags()) }] : []),
      // write mode only: a quick fix from Check deck… is reviewed side by side
      // before it lands, unless this is off (#907)
      ...(editmode?.available() ? [{ label: 'Review quick fixes', value: editmode.reviewFixes() ? 'before they land' : 'off — they land at once',
        hint: '⏎ switches', stays: true, run: () => editmode.toggleFixReview() }] : []),
      // …and an A ask the same way; a script rewrite always is
      ...(editmode?.available() ? [{ label: 'Review agent asks', value: editmode.reviewAsks() ? 'before they land' : 'off — they land at once',
        hint: '⏎ switches', stays: true, run: () => editmode.toggleAskReview() }] : []),
      // write mode only: the notes card writes itself this long after the
      // typing stops; ⏎ walks the steps, off last
      ...(editmode?.available() ? [{ label: 'Notes autosave', value: editmode.notesQuietLabel(),
        hint: '⏎ cycles', stays: true, run: () => editmode.cycleNotesQuiet() }] : []),
    ];
  }
  /**
   * Put `text` on the clipboard and say so. The async clipboard needs a secure
   * context, which a deck opened from file:// is not everywhere — so the old
   * select-and-copy is the fallback, and if both are refused the toast carries
   * the text itself, which is at least something to select.
   */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`copied ${text}`, 2200);
      return true;
    } catch { /* not allowed here — try the old way */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* refused */ }
    ta.remove();
    toast(ok ? `copied ${text}` : `could not copy — ${text}`, ok ? 2200 : 6000);
    return ok;
  }
  function openSettings() {
    if (setEl) return closeSettings();
    overlays.opening();
    setEl = document.createElement('div');
    setEl.className = 'decklight-narr decklight-settings';
    setEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Settings"></div>';
    closeOnBackdrop(setEl, closeSettings);
    root.appendChild(setEl);
    paintSettings(0);
  }
  /** ⏎ or a click on row `i`: a knob switches and the panel is painted again
   *  around it, the same row selected; anything else (the copy) is done once
   *  the row has run, and the panel goes. A fact has nothing to run, so ⏎ on
   *  one is an acknowledgement: it closes, rather than sitting there looking
   *  broken. */
  function runSetRow(i) {
    const r = setRows[i];
    r?.run?.();
    if (r?.run && r.stays) paintSettings(i);
    else closeSettings();
  }
  function paintSettings(sel) {
    const card = setEl.querySelector('.narr-card');
    card.replaceChildren();
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = 'settings';
    card.appendChild(head);
    setRows = settingsRows();
    setRows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'narr-row' + (r.run ? '' : ' narr-fact');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      label.textContent = r.label;
      el.appendChild(label);
      if (r.value !== undefined) {
        const val = document.createElement('span');
        val.className = 'narr-flavor';
        val.textContent = r.value;
        el.appendChild(val);
      }
      if (r.hint) {
        const hint = document.createElement('span');
        hint.className = 'narr-flavor narr-hint';
        hint.textContent = r.hint;
        el.appendChild(hint);
      }
      el.addEventListener('mouseenter', () => selectSetRow(i));
      if (r.run) el.addEventListener('click', () => runSetRow(i));
      card.appendChild(el);
    });
    selectSetRow(Math.min(sel, setRows.length - 1));
  }
  function selectSetRow(i) {
    setSel = selectInList(setEl.querySelectorAll('.narr-row'), i, 'narr-sel');
  }
  function closeSettings() {
    setEl?.remove();
    setEl = null;
  }
  themes.restoreSaved();
  themes.reportMissing();

  // ----- fonts ([ / ], Font…) — SPEC PRESENTING, FONTS --------------------------------
  // The nine curated stacks (offline-safe, the same rule as theme fonts), the
  // deck's font packages, and — authoring — what the marketplaces offer, all
  // applied as inline custom properties on the root so they override any
  // theme and survive theme switching. src/core/fonts.js holds the list, the
  // previewing picker and the per-deck pick.
  const fonts = createFonts({
    root, config, params, toast,
    debugLog: (...a) => debugLog(...a),
    overlays,
    editmode: () => editmode,
    // type metrics changed: pinned titles and the overflow guardrail
    // re-derive from real measurements (once there is a deck to measure)
    remeasure: () => {
      if (!instance?._sections) return;
      setupPinnedTitles(instance._sections, config);
      checkOverflow(instance._sections[instance.state.slide - 1], instance.state.slide);
    },
  });
  const cycleFont = (dir) => fonts.cycle(dir);
  const openFontPicker = () => fonts.open();
  // restore BEFORE the first sync so pinned titles measure the real font
  try { fonts.restore(); } catch { /* ignore */ }

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

  // ----- display ratio (Settings) — SPEC PRESENTING --------------------------
  // The deck's own ratio (16:9 by default) letterboxes on any other screen.
  // "Fill screen" instead GROWS the stage to the screen's shape: the deck's
  // height on a wider screen, its width on a taller one, so the slides lay out
  // into the extra room and nothing that fits at 16:9 is squeezed. A browser's
  // choice per deck, like a dock: how this screen shows it, never the file —
  // print, PDF and every export keep the deck's ratio.
  const DISPLAY_KEY = 'decklight-display:' + location.pathname;
  let displayFill = !printMode && readPref(DISPLAY_KEY) === 'fill';
  // past these a fill is no longer a slide: an ultrawide or a phone held upright
  // letterboxes again rather than stretching the deck into a ribbon
  const FILL_ASPECT = [1, 2.4];
  let remeasureTimer = null;
  /** Size the stage for the space it gets; true when it changed. */
  function sizeStage(availW, availH) {
    let w = config.width, h = config.height;
    if (displayFill && availW > 0 && availH > 0) {
      const aspect = Math.min(FILL_ASPECT[1], Math.max(FILL_ASPECT[0], availW / availH));
      if (aspect > w / h) w = Math.round(h * aspect);
      else h = Math.round(w / aspect);
    }
    if (stage.style.width === w + 'px' && stage.style.height === h + 'px') return false;
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    return true;
  }
  /** A new stage size re-wraps the text: pinned titles and the overflow
   *  guardrail measure again, once the resize has stopped. */
  function remeasureSoon() {
    clearTimeout(remeasureTimer);
    remeasureTimer = setTimeout(() => {
      if (!instance?._sections) return;
      setupPinnedTitles(instance._sections, config);
      checkOverflow(instance._sections[instance.state.slide - 1], instance.state.slide);
    }, 150);
  }
  /** `16:9` for the deck's own ratio — what the setting switches back to. */
  function deckRatio() {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(config.width, config.height) || 1;
    return `${config.width / g}:${config.height / g}`;
  }
  function setDisplay(fill) {
    displayFill = !!fill;
    writePref(DISPLAY_KEY, displayFill ? 'fill' : null);
    root.toggleAttribute('data-display-fill', displayFill);
    instance._reflow?.();
    toast(displayFill ? 'display: fills the screen' : `display: ${deckRatio()}`, 2200);
  }
  root.toggleAttribute('data-display-fill', displayFill);

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
  // what stays here is the deck's answers to its questions. Write mode only:
  // the pick is a persisted deck edit (data-layout, written back through the
  // edit server), so without that server the key explains itself and changes
  // nothing rather than forking the deck from what is on disk.
  function applyLayout(sec, name) {
    if (name === 'auto') sec.removeAttribute('data-layout');
    else sec.setAttribute('data-layout', name);
  }
  function relayoutSlide(sec, idx) {
    // the one slide that changed, not the whole deck: pinning measures, and
    // measuring every slide for an L press on one was most of its cost
    setupPinnedTitles([sec], config);
    setupSplit([sec], () => idx);
    checkOverflow(sec, idx);
    return sec.hasAttribute('data-split-conflict');
  }
  // the deck's theme, picked on another page of this deck (editmode.js relays the event)
  root.addEventListener('decklight:theme', (e) => { const name = e.detail?.theme; if (typeof name === 'string') themes.applyTheme(name, true); });
  // the deck's concept colours pinned on another page (editmode.js relays the event): repaint, no reload
  root.addEventListener('decklight:concepts', (e) => {
    const map = e.detail?.concepts;
    if (!map || typeof map !== 'object') return;
    config.concepts = map;
    applyConcepts(stage, config.concepts);
    conceptsEditor.refresh();
    inspector?.refresh?.();
  });
  // a layout picked on another page of this deck (editmode.js relays the event)
  root.addEventListener('decklight:layout', (e) => {
    const { slide, layout: name } = e.detail ?? {};
    const sec = instance._sections?.[slide - 1];
    if (!sec || typeof name !== 'string') return;
    applyLayout(sec, name);
    relayoutSlide(sec, slide);
  });
  // text, code or a label saved in place on this page (authoring.js): the
  // page already shows it; a code block is rendered again from its new
  // source, and the slide is rescanned and laid out again, as a reload would
  // have done. Another page's save reloads this one (editmode.js).
  root.addEventListener('decklight:content', (e) => {
    const { slide, el, code } = e.detail ?? {};
    const sec = instance._sections?.[slide - 1];
    if (!sec) return;
    if (code && el?.isConnected) initCode(el, registerBuildProvider);
    instance._rescanFor(el?.isConnected ? el : sec);
    relayoutSlide(sec, slide);
  });
  const layout = createLayoutCycler({
    slideOf: () => instance.state.slide,
    sectionAt: (idx) => instance._sections[idx - 1],
    describe: (sec) => ({
      autoPins: autoPinY(sec, config) !== null,
      hasSplitPair: splitContent(sec).length > 1,
    }),
    available: () => editmode.available(),
    unavailableMessage: () => editmode.cannot('picking a layout'),
    apply: applyLayout,
    relayout: relayoutSlide,
    // in place: this page already shows the pick, and the write is quiet —
    // every other page is sent the pick instead of a reload
    post: (body) => fetch(editmode.base() + '/deck/edit/slide/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, quiet: true, from: editmode.pageId() }),
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
    off(type, fn) {
      this._listeners.get(type)?.delete(fn);
      return this;
    },
    _emit(type, detail) {
      (this._listeners.get(type) || []).forEach((fn) => fn(detail));
      root.dispatchEvent(new CustomEvent('decklight:' + type, { detail }));
    },

    sync() {
      this._sections = [...stage.querySelectorAll(':scope > section')];
      this._sections.forEach((s, i) => s.setAttribute('data-slide-index', String(i + 1)));
      // FIRST: a slide naming a slide template gets its structure before
      // any pass below measures, pins, splits or scans it (SPEC DESIGN_SYSTEMS)
      setupSlideTemplates(this._sections, { warn: (m) => { console.warn(`decklight: ${m}`); debugLog('design-system', m); } });
      // a design system's fill roles are its diagram slots, before concepts and nesting paint any (SPEC DESIGN_SYSTEM_ROLES)
      setFillRoles(fillRolesOf(pageDesignSystems().values()));
      applyConcepts(stage, config.concepts); // idempotent; covers dynamic slides
      setupHeroLogos(this._sections);        // idempotent; before pin measurement
      setupMedia(this._sections, { printMode }); // backgrounds first — .slide-bg must not read as content
      setupPinnedTitles(this._sections, config);
      setupSplit(this._sections);            // after pins — .subtitle is marked there
      markDensity(this._sections);           // after split — it counts per column (SLIDE_DENSITY)
      if (printMode) markConceptHints(root, stage);   // for decklight check: labels that recur in two colours
      this._records = this._sections.map((s) => scanSlide(s));
      if (printMode) this._sections.forEach((s, i) => markClickMismatch(s, this._records[i]));
      this.state.totalSlides = this._sections.length;
      this.state.slide = Math.min(this.state.slide, this.state.totalSlides || 1);
      const rec = this._records[this.state.slide - 1];
      if (rec) this.state.step = Math.min(this.state.step, rec.groups.length);
      // an edit can replace the very elements being watched (dev mode re-renders
      // a slide in place), so re-aim at whatever is on stage now
      watchOverflow(printMode ? this._sections : [this._sections[this.state.slide - 1]]);
      this._afterSync?.();
    },

    _rescanFor(el) {
      const section = el.closest('section');
      const idx = this._sections.indexOf(section);
      if (idx === -1) return;
      this._records[idx] = scanSlide(section);
      if (printMode) {
        markClickMismatch(section, this._records[idx]);   // a provider registered late: its steps count now
        applyBuildState(this._records[idx], this._records[idx].groups.length);
        return;
      }
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

    /**
     * Is slide `n` hidden from this showing? `data-hidden` (DECK_ANATOMY), and
     * `?all` overrides. A hidden slide KEEPS ITS NUMBER — as it does in
     * PowerPoint — so everything that numbers slides file-side (comments,
     * review anchors, history) stays in step; it is simply stepped over.
     */
    _hidden(n) {
      return !showHidden && !!this._sections[n - 1]?.hasAttribute('data-hidden');
    },
    /** The nearest slide that is not hidden, walking from `n` in `dir` (±1); null past the end. */
    _visibleFrom(n, dir) {
      for (let i = n; i >= 1 && i <= this.state.totalSlides; i += dir) if (!this._hidden(i)) return i;
      return null;
    },
    next() {
      const rec = this._records[this.state.slide - 1];
      if (rec && this.state.step < rec.groups.length) {
        this.goto(this.state.slide, this.state.step + 1, { direction: 'fwd' });
        return;
      }
      const to = this._visibleFrom(this.state.slide + 1, +1);
      if (to) this.goto(to, 0, { direction: 'fwd' });
      else gotoModule(1); // playlist chaining; no-op on the last module
    },
    prev() {
      if (this.state.step > 0) {
        this.goto(this.state.slide, this.state.step - 1, { direction: 'back' });
        return;
      }
      const to = this._visibleFrom(this.state.slide - 1, -1);
      if (to) this.goto(to, this._records[to - 1].groups.length, { direction: 'back' });
      else gotoModule(-1); // playlist chaining; no-op on the first module
    },

    goto(slide, step = 0, opts = {}) {
      slide = Math.max(1, Math.min(slide, this.state.totalSlides));
      // a deep link or a jump onto a hidden slide lands on its nearest shown
      // neighbour in the direction of travel — never on the hidden one
      if (this._hidden(slide)) {
        const dir = opts.direction === 'back' ? -1 : +1;
        const near = this._visibleFrom(slide, dir) ?? this._visibleFrom(slide, -dir);
        if (near == null) return;
        slide = near; step = dir < 0 ? (this._records[slide - 1]?.groups.length ?? 0) : 0;
      }
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
      if (from === to) { to.classList.add('active'); applyNesting(to); return; }
      const initial = !from || !from.classList.contains('active');

      const autoAnim = from && to && !initial &&
        from.hasAttribute('data-auto-animate') && to.hasAttribute('data-auto-animate') &&
        Math.abs(this._sections.indexOf(to) - this._sections.indexOf(from)) === 1;

      this._sections.forEach((s) => s.classList.remove(
        'active', 'entering', 'leaving', 'dir-fwd', 'dir-back',
        'tr-none', 'tr-fade', 'tr-slide', 'tr-scale', 'tr-flip'));
      to.classList.add('active');
      // nested diagram fills need the slide laid out (bboxes), so the pass
      // runs here, once the slide is displayed, rather than in sync()
      applyNesting(to);

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
      // One timer, for the pair on stage now. A second navigation inside the
      // window used to leave the first timer live, and it fired against
      // sections that had since become the NEW pair — stripping the shared
      // `tr-*` class off a slide mid-transition on a fast arrow run.
      clearTimeout(this._transitionTimer);
      this._transitionTimer = setTimeout(() => {
        from.classList.remove(...cls.leaving);
        to.classList.remove(...cls.entering);
      }, ms + 60);
    },

    _updateChrome() {
      // a docked inspector is a reference open beside the talk, so it follows
      // the slide (and the build step) rather than showing the one you left
      inspector?.onSlide();
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
      this._reportToParent?.();
    },
  };

  // ----- helpers -----------------------------------------------------------
  // Hand the browser a URL and a filename. The transcript export, the the synthesized recorder
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


  // ----- chrome ------------------------------------------------------------
  let progressBar = null; // mounted by the progress bar toggle (palette), below
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
  // The arrows and the slide number, in fullscreen (⇧F, Settings, palette).
  // Shown by default, as they always were; hidden, a fullscreen talk is the
  // slides and nothing else. Remembered per deck, like the clock. Only
  // fullscreen is affected: out of it the arrows are how a mouse moves the
  // deck, and the number is how an author knows where they are.
  const FS_CHROME_KEY = 'decklight-fs-chrome:' + location.pathname;
  const fsChromeHidden = () => root.classList.contains('fs-chrome-hidden');
  function setFsChrome(hidden, { quiet = false } = {}) {
    root.classList.toggle('fs-chrome-hidden', hidden);
    writePref(FS_CHROME_KEY, hidden ? 'hidden' : null);
    if (!quiet) toast(hidden ? 'arrows and slide number hidden in fullscreen' : 'arrows and slide number shown in fullscreen');
    debugLog('nav', `fullscreen chrome ${hidden ? 'hidden' : 'shown'}`);
  }
  if (readPref(FS_CHROME_KEY) === 'hidden') setFsChrome(true, { quiet: true });
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
  // The overview is where a deck is REARRANGED (PRESENTING, write mode): a
  // cell drags to a new place, and each cell carries new / duplicate / delete.
  // Every one is the same `POST /deck/edit/slide` the palette's rows and the
  // element menu's Slide ▸ make, through editmode.slideOp, so one undo entry
  // each. The write reloads the page; the overview reopens on the slide the
  // server named, so a second drag follows the first without pressing O again.
  const OVERVIEW_OPEN_KEY = 'decklight-overview-open:' + location.pathname;
  let ovDrag = null;   // the index of the cell being dragged
  function ovOp(op, i, to = null) {
    if (!editmode.available()) return;
    try { sessionStorage.setItem(OVERVIEW_OPEN_KEY, '1'); } catch { /* no storage: the overview closes on reload, as before */ }
    editmode.slideOp(op, { slide: i + 1, to }).catch(() => {
      try { sessionStorage.removeItem(OVERVIEW_OPEN_KEY); } catch { /* nothing to clear */ }
    });
  }
  /** Where a drop over cell `i` would put the dragged slide: before it on the left half, after it on the right. */
  function ovDropAt(cell, i, e) {
    const r = cell.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    return { before, to: before ? i + 1 : i + 2 };
  }
  function ovClearDrop() {
    overviewEl?.querySelectorAll('.ov-drop-before, .ov-drop-after').forEach((c) => c.classList.remove('ov-drop-before', 'ov-drop-after'));
  }
  function ovEditable(cell, i) {
    const tools = document.createElement('div');
    tools.className = 'ov-tools';
    for (const [op, glyph, title] of [['new', '+', 'new slide after this one'], ['duplicate', '⧉', 'duplicate this slide'], ['delete', '🗑', `delete this slide (${UNDO_CHORD} takes it back)`]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ov-tool ov-${op}`;
      b.title = title;
      b.textContent = glyph;
      b.addEventListener('click', (e) => { e.stopPropagation(); ovOp(op, i); });
      tools.appendChild(b);
    }
    cell.appendChild(tools);
    cell.draggable = true;
    cell.addEventListener('dragstart', (e) => {
      ovDrag = i;
      cell.classList.add('ov-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i + 1)); } catch { /* a synthetic drag */ }
    });
    cell.addEventListener('dragend', () => { ovDrag = null; cell.classList.remove('ov-dragging'); ovClearDrop(); });
    cell.addEventListener('dragover', (e) => {
      if (ovDrag === null || ovDrag === i) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch { /* a synthetic drag */ }
      const { before } = ovDropAt(cell, i, e);
      ovClearDrop();
      cell.classList.add(before ? 'ov-drop-before' : 'ov-drop-after');
    });
    cell.addEventListener('drop', (e) => {
      if (ovDrag === null || ovDrag === i) return;
      e.preventDefault();
      const from = ovDrag;
      const { to } = ovDropAt(cell, i, e);
      ovClearDrop();
      // the slot after a later cell, or before an earlier one, counts the moved slide's own hole
      const dest = from + 1 < to ? to - 1 : to;
      if (dest !== from + 1) ovOp('move', from, dest);
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
    const editable = editmode.available();
    overviewEl.classList.toggle('ov-editable', editable);
    instance._sections.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'ov-cell' + (i === instance.state.slide - 1 ? ' ov-current' : '')
        + (s.hasAttribute('data-hidden') ? ' ov-hidden' : '');   // dimmed and badged, still there to unhide
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
      applyNesting(clone);   // a clone of a slide never shown has not had its fills nested yet
      cell.appendChild(frame);
      const num = document.createElement('span');
      num.className = 'ov-num';
      num.textContent = String(i + 1);
      cell.appendChild(num);
      cell.addEventListener('click', () => { toggleOverview(); instance.goto(i + 1, 0, { force: true }); });
      if (editable) ovEditable(cell, i);
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
    row.className = 'dbg-row dbg-' + e.kind + (e.prev ? ' dbg-prev' : '');
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
  // ONE log panel, two tabs (ROADMAP section 2): Messages (what the deck told
  // you, `) and Events (the debug stream, the palette's Help: Debug log). They
  // were two panels in two corners, either or both open, and a newcomer could
  // not tell which one explained "why the voice stopped". The element keeps
  // each view's old class (`decklight-msglog`, `decklight-debug`) and inner
  // markup, so the code that fills a view, and everything that reads one, is
  // unchanged; `msgListEl` and `debugEl` point at the panel while it shows them.
  let logEl = null;
  let logView = null;   // 'messages' | 'events'
  function closeLog() {
    if (!logEl) return;
    if (logView === 'events') debug.onEntry(null);
    logEl.remove();
    logEl = null; logView = null; debugEl = null; msgListEl = null;
  }
  function openLog(view) {
    if (logEl && logView === view) { closeLog(); return; }
    closeLog();
    logEl = document.createElement('div');
    logView = view;
    logEl.className = 'decklight-log ' + (view === 'events' ? 'decklight-debug' : 'decklight-msglog');
    const tabs = document.createElement('div');
    tabs.className = 'log-tabs';
    for (const [v, label] of [['messages', 'messages'], ['events', 'events']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'log-tab' + (v === view ? ' log-tab-on' : '');
      b.textContent = label;
      if (v !== view) b.addEventListener('click', (e) => { e.stopPropagation(); openLog(v); });
      tabs.appendChild(b);
    }
    const hint = document.createElement('span');
    hint.className = 'log-hint';
    hint.innerHTML = '<kbd title="the tilde key">&#96;</kbd> · Esc closes';
    tabs.appendChild(hint);
    logEl.appendChild(tabs);
    if (view === 'events') {
      debugEl = logEl;
      logEl.insertAdjacentHTML('beforeend', '<div class="dbg-state"></div><div class="dbg-log"></div>');
      root.appendChild(logEl);
      debug.entries.forEach(appendDebugRow);
      updateDebugState();
      const log = logEl.querySelector('.dbg-log');
      log.scrollTop = log.scrollHeight;
      // From here the buffer feeds the panel directly; closing detaches it.
      debug.onEntry((entry) => {
        appendDebugRow(entry);
        updateDebugState();
        const box = debugEl.querySelector('.dbg-log');
        box.scrollTop = box.scrollHeight;
      });
    } else {
      msgListEl = logEl;
      logEl.insertAdjacentHTML('beforeend', '<div class="msg-log"></div>');
      root.appendChild(logEl);
      renderMsgList();
    }
  }
  function toggleDebug() { openLog('events'); }
  // The message LOG (`). Messages fade after a few seconds — which is exactly
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
  function toggleMessages() { openLog('messages'); }

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
      <tr><td>→ / PageDown</td><td>next build / slide (← and → also while a panel beside the slide has the keyboard; a text field keeps them)</td></tr>
      <tr><td>⎵</td><td>pause / resume the voice while it is speaking — otherwise it advances</td></tr>
      <tr><td>← / PageUp</td><td>previous</td></tr>
      <tr><td>Home / End</td><td>first / last slide</td></tr>
      <tr><td>O</td><td>overview</td></tr>
      <tr><td>S</td><td>this slide's speaker notes — editable in write mode, read-only elsewhere</td></tr>
      <tr><td>⌥⏎ / Alt+Enter</td><td>speaker view — a second window with notes, next slide, timer (again: rehearse mode)</td></tr>
      <tr><td>V</td><td>narration — track, voice, character, recording, captions, speed</td></tr>
      <tr><td>I</td><td>inspector — all about this slide, or the element selected on it: layout, builds, notes, fit, contrast, sources; its colours and type; ⬚ picks an element</td></tr>
      <tr><td>&lt; / &gt;</td><td>voice speed (0.25× steps)</td></tr>
      <tr><td>B</td><td>blackout</td></tr>
      <tr><td>pinch · 0</td><td>zoom the slide (trackpad pinch, or two fingers; scroll pans) · 0, Esc or a slide change fits it again</td></tr>
      <tr><td>&#96;</td><td>the log, on its messages tab (the events tab beside it is the debug stream) — the tilde key; ⌃&#96; / ⌥&#96; also works while editing notes</td></tr>
      <tr><td>C</td><td>captions (follow the voice)</td></tr>
      <tr><td>W</td><td>pen — draw on the slide (⌫ clears)</td></tr>
      <tr><td>⇧W</td><td>laser pointer</td></tr>
      <tr><td>K</td><td>commit — what changed, and what to call it (⌘K / ⌃K also works while typing)</td></tr>
      <tr><td>H</td><td>history — commits, slides and diff per version, ⏎ restores one (write mode)</td></tr>
      <tr><td>M</td><td>comments — yours and every review's, grouped by who said them, ⏎ jumps</td></tr>
      <tr><td>⇧M</td><td>leave a comment on the slide you are looking at</td></tr>
      <tr><td>F / ⌘⏎ / Ctrl+Enter</td><td>fullscreen (⌘⏎ is the present chord; the bar and the commit chip leave with it)</td></tr>
      <tr><td>⇧F</td><td>show / hide the arrows and the slide number in fullscreen</td></tr>
      <tr><td>T</td><td>theme picker (type to filter)</td></tr>
      <tr><td>/</td><td>command palette — find, themes, everything (“Welcome to Decklight” reopens the intro)</td></tr>
      <tr><td>G</td><td>slide finder (live preview)</td></tr>
      <tr><td>, / .</td><td>cycle theme</td></tr>
      <tr><td>[ / ]</td><td>cycle font</td></tr>
      <tr><td>${IS_MAC ? '⌥⌘C / ⌥⌘V' : 'Ctrl+Alt+C / V'}</td><td>copy / paste a selected shape's style: colours, border, type (write mode)</td></tr>
      <tr><td>${UNDO_CHORD} / ${REDO_CHORD}</td><td>undo / redo deck edits (write mode)</td></tr>
      <tr><td>A</td><td>ask an AI agent to edit the deck (write mode)</td></tr>
      <tr><td>⌃T</td><td>generate a theme (repeat to re-roll)</td></tr>
      <tr><td>⌃⇧T</td><td>save the generated theme</td></tr>
      <tr><td>?</td><td>this help</td></tr></table>
      <h3>Write mode, in context</h3><table>
      <tr class="help-ctx"><td>⏎ · ⌫ · Esc</td><td>on a selected element: edit its text (or open its menu) · remove it · let it go</td></tr>
      <tr class="help-ctx"><td>⏎ · ⇧⏎ · Esc</td><td>while editing text: save · new line · cancel</td></tr>
      <tr class="help-ctx"><td>${IS_MAC ? '⌘B · ⌘I · ⌘E' : 'Ctrl+B · Ctrl+I · Ctrl+E'}</td><td>while editing text: bold · italic · code</td></tr>
      <tr class="help-ctx"><td>N · D · ⌫</td><td>in the overview: new slide · duplicate · delete</td></tr>
      <tr class="help-ctx"><td>E</td><td>in the inspector: edit this slide's sources</td></tr>
      <tr class="help-ctx"><td>⇧-click Layout</td><td>on the bar: cycle the layout backwards</td></tr></table></div>`;
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
  // happen: a dialog calls overlays.opening() as it opens, which takes every
  // picker off the stage (overlay.js says which ones count), so at most one
  // answers isOpen(). A feature that has moved to its own module registers
  // there instead — the theme picker (createThemes, so first) and the two
  // narration dialogs (createNarration, so after this list) have.
  overlays.register({
    isOpen: () => !!palEl,
    close: closePalette,
    transient: true,
    keydown: (e) => typeaheadKeydown(e, {
      query: palQuery,
      onMove: (d) => selectPalRow(palSel + d),
      onCommit: commitPalRow,
      onType: (ch) => { palQuery += ch; renderPalette(); },
      // ⌫ on an empty query leaves the group, the way the back row does
      onBackspace: () => { palQuery = palQuery.slice(0, -1); renderPalette(); },
      onClear: () => { palQuery = ''; renderPalette(); },
      onClose: closePalette,
    }),
  });
  overlays.register({ isOpen: fonts.isOpen, close: fonts.close, transient: true, keydown: fonts.keydown });
  overlays.register({
    isOpen: () => !!setEl,
    close: closeSettings,
    transient: true,
    keydown: (e) => typeaheadKeydown(e, {
      onMove: (d) => selectSetRow(setSel + d),
      onCommit: () => runSetRow(setSel),
      onClose: closeSettings,
    }),
  });
  overlays.register({
    isOpen: () => !!finderEl,
    close: closeSlideFinder,
    transient: true,
    keydown: (e) => ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && finderOutlined()
      ? finderFold(e.key === 'ArrowRight')
      : typeaheadKeydown(e, {
      query: finderQuery,
      onMove: (d) => selectFinderRow(finderSel + d, false),
      onCommit: commitFinder,
      onType: (ch) => setFinderQuery(finderQuery + ch),
      onBackspace: () => setFinderQuery(finderQuery.slice(0, -1)),
      onClear: () => setFinderQuery(''),
      onClose: closeSlideFinder,
    })),
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
        // the selected cell, rearranged from the keyboard (write mode)
        case 'Backspace': case 'Delete': if (editmode.available()) ovOp('delete', ovSel); break;
        case 'n': case 'N': if (editmode.available()) ovOp('new', ovSel); break;
        case 'd': case 'D': if (editmode.available()) ovOp('duplicate', ovSel); break;
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
    // ⌘K / ⌃K — commit. The alias for the bare K below, and it earns its place
    // ABOVE the typing guard for the same reason the messages key does: the
    // moment you most want to commit is the moment you have just finished
    // typing, and a notes editor swallowing the shortcut would send you hunting
    // for the mouse. Inside the commit window's own box it toggles the window,
    // which is what K does everywhere else.
    //
    // ⌘K is the shortcut JetBrains has meant by "commit" for twenty years, and
    // the browser's own ⌘K (focus the search bar) is exactly what preventDefault
    // is for. Shift is excluded rather than ignored: ⌘⇧K is the web console in
    // Firefox, and taking a devtools key from someone debugging a deck would be
    // a poor trade for an alias.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      editmode.commit.open();
      e.preventDefault();
      return;
    }
    // a READ-ONLY box is not typing — the notes card under present/review lets → move the deck
    if ((/^(input|textarea|select)$/i.test(e.target.tagName) && !e.target.readOnly) || e.target.isContentEditable || authoring.editing()) return;
    // ⌃T generates, ⌃⇧T saves — both must precede the modifier early-return
    // (macOS tab shortcuts are ⌘-based, so Ctrl reaches the page; on
    // Windows/Linux the browser owns Ctrl+T and these can't be intercepted).
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'T' || e.key === 't')) {
      if (e.shiftKey) saveGeneratedTheme();
      else if (!themes.rollFromPicker()) rollTheme();
      e.preventDefault();
      return;
    }
    // ⌘⏎ / ⌃⏎ saves the open card that can save — the speaker notes card —
    // wherever the focus is: a button in it, its background, or (docked) the
    // slide beside it (#646). Below the typing guard, so a box's own ⌘⏎ (the
    // agent ask, the commit window, the content editor) is the one you get,
    // and before the modifier early-return below, which swallowed it.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'Enter' && overlays.active()?.save?.()) {
      e.preventDefault();
      return;
    }
    // ⌘⏎ / Ctrl+Enter — fullscreen: the present chord Google Slides taught a
    // Mac, and the one a browser leaves free (F5 is reload). Below the save
    // above, so a card that is open keeps its ⌘⏎; the deck gets it otherwise.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    // The undo chord is the one modifier combination that goes on: BELOW the
    // typing guard on purpose, so in a text box the browser's own undo is the
    // one you get, and past the overlays below, so an open dialog still owns it.
    const undoChord = isUndoChord(e);
    // ⌥⏎ / Alt+Enter — the speaker view: PowerPoint's presenter-view chord,
    // one that reads the same on every OS without reaching for an F-key.
    const speakerChord = e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter';
    // ⌥⌘C / ⌥⌘V (Ctrl+Alt elsewhere) — copy and paste a style, Keynote's and
    // PowerPoint's chords. By code, not key: ⌥ turns the C into a ç.
    const styleChord = e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV')
      && editmode.elementEditOn() ? e.code : null;
    if (!undoChord && !speakerChord && !styleChord && (e.metaKey || e.ctrlKey || e.altKey)) return;
    // An overlay that is up owns the keyboard — whether or not it wants this
    // particular key. Registration order (see `overlays.register` calls) is the
    // priority order the long if-chain here used to encode.
    const top = overlays.active();
    // ←/→ always move the deck while a docked panel (the notes, the inspector,
    // the sources, the comments, the agent, the HTML editor) holds the keyboard:
    // a panel beside the slide is there to be used WHILE presenting, and what
    // the arrows did used to depend on which panel it was and how it was docked
    // (ROADMAP section 3). A text field keeps them for its caret: the typing
    // guard above has already returned for one.
    if (top?.panel && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (e.key === 'ArrowRight') instance.next(); else instance.prev();
      e.preventDefault();
      return;
    }
    if (top) {
      // never offered to an overlay as a `z` — a filter would type it
      if (!undoChord && top.keydown(e)) { e.preventDefault(); return; }
      // Esc closes whatever is up, whether or not its keydown thought to say
      // so: a panel that cannot be closed from the keyboard is a trap, and
      // this is the one place every panel's keys pass through
      if (e.key === 'Escape') { top.close(); e.preventDefault(); return; }
      // A modal overlay swallows even the keys it did not want — that is what
      // stops `o` opening the overview behind an open dialog. A NON-modal one
      // lets the rest fall through to the deck, so you can arrow through slides
      // while the panel stays up beside them. `modal` may be a predicate: the
      // docked review is modal only while you are working IN it, transparent
      // while your last click was on the deck.
      const modal = typeof top.modal === 'function' ? top.modal() : top.modal;
      if (modal !== false) return;
    }
    if (speakerChord) { speakerView(); e.preventDefault(); return; }
    if (styleChord) {
      const sel = editbar.selected();
      if (!sel) toast(`select a shape first, then ${styleChord === 'KeyC' ? `${styleClip.keys.copy} copies` : `${styleClip.keys.paste} pastes`} its style`, 2600);
      else if (styleChord === 'KeyC') styleClip?.copy(sel);
      else styleClip?.paste(sel).then((ok) => { if (ok) editbar.refresh?.(); });
      e.preventDefault();
      return;
    }
    if (undoChord) {
      deckHistory(e.shiftKey ? 'redo' : 'undo');
      e.preventDefault();   // ⌘Z / Ctrl+Z has no page default worth keeping here
      return;
    }
    // positional, so it cannot be a `case` in a switch over e.key
    if (isMsgKey(e)) { toggleMessages(); e.preventDefault(); return; }
    // something selected on the slide answers ⏎, ⌫ and Esc first (editbar.js)
    if (editbar.keydown(e)) { e.preventDefault(); return; }
    // One key per action, and no bare letter that writes the file (ROADMAP,
    // section 2). R (history's second key), P (⎵'s alias), J (progress bar)
    // and D (debug log) went: the first two duplicated a key, the last two
    // are palette rows. L (cycle layout) and Z / ⇧Z (undo, redo) went because
    // a stray press while presenting changed the file; the bar's buttons, the
    // palette and the undo chord (⌘Z / Ctrl+Z, above) do those now.
    switch (e.key) {
      // ⎵ belongs to the voice only WHILE THE VOICE IS IN PLAY — pausing it,
      // resuming it — and to the deck at every other moment, including on a
      // deck that carries a track nobody has started. It can therefore never
      // start the narration, which is the point: presenting a narrated deck by
      // hand is ordinary, and a ⎵ that began talking over the presenter would
      // be a derailment in front of an audience rather than a stumble.
      //
      // Nothing is lost by the narrowing. A playing track advances the deck
      // itself, so ⎵ is free exactly when the voice wants it — and CHOOSING is
      // what makes the voice want it: narration is off until somebody picks a
      // track in V's panel, so a deck that merely ships audio still gets ⎵ for
      // the deck (see voiceInPlay, and the 🔇 Off row that hands it back).
      case ' ':
        if (narration.status().voiceInPlay) narration.playPause();
        else instance.next();
        break;
      case 'ArrowRight': case 'PageDown': instance.next(); break;
      case 'ArrowLeft': case 'PageUp': instance.prev(); break;
      case 'Home': instance.goto(1, 0); break;
      case 'End': instance.goto(instance.state.totalSlides, 0); break;
      case 'o': case 'O': toggleOverview(); break;
      case 'b': case 'B': toggleBlackout(); break;
      case 'c': case 'C': toggleCaptions(); break;
      case 'k': case 'K': editmode.commit.open(); break;
      case 'h': case 'H': editmode.history.open(); break;
      // G = go/grep — a direct slide-finder key. Deliberately NOT ⌘F:
      // browser find is sacred, and / already belongs to the palette.
      case 'g': case 'G': openSlideFinder(); break;
      // M is free because the module menu that held it was removed — the
      // finder does both of its jobs (see the `modules` harness mode).
      // M reads what people said; ⇧M says something — the same split every
      // other shift-variant here makes (the your-voice recorder records, the synthesized recorder the record dialog).
      case 'm': case 'M': if (e.shiftKey) review.compose(); else review.open(); break;
      case 'f': case 'F': if (e.shiftKey) setFsChrome(!fsChromeHidden()); else toggleFullscreen(); break;
      case 'v': case 'V': narration.openPicker(); break;   // everything about the voice
      case 'i': case 'I': inspector?.open(); break;        // (I)nspector: all about this slide, or the selection
      // S — this slide's speaker notes, in the notes editor (write mode); the
      // speaker view, a second window for presenting, is ⌥⏎ above
      case 's': case 'S': toggleEditor(); break;
      case 't': case 'T': themes.openPicker(); break;
      case '/': openPalette(); break;
      case '.': cycleTheme(1); break;
      case ',': cycleTheme(-1); break;
      case '>': changeNarrRate(+0.25); break;  // youtube's ⇧>
      case '<': changeNarrRate(-0.25); break;  // youtube's ⇧<
      case ']': cycleFont(1); break;
      case '[': cycleFont(-1); break;
      // L right after a write lands while the reloaded page is still asking
      // its server: wait for the answer, then do what was asked
      case 'a': case 'A': toggleAgentAsk(); break;
      case 'w': case 'W': toggleInk(e.shiftKey ? 'laser' : 'pen'); break;
      case 'Backspace':
        if (!hud.annotator?.active) return; // no ink tool on — leave the key alone
        hud.annotator.clear();
        break;
      case '?': toggleHelp(); break;
      case 'Escape':
        if (cancelCyclePending()) break;
        if (zoom.k !== 1 && !overlays.active()) { resetZoom(); break; }
        if (overviewEl) toggleOverview();
        // the two panels that are not overlays (they take no keys of their
        // own) still close on Esc, like every other panel
        else if (helpEl) toggleHelp();
        else if (logEl) closeLog();   // the log panel, on either tab
        break;
      case '0': if (zoom.k !== 1) resetZoom(); else return; break;
      default: return;
    }
    e.preventDefault();
  }
  if (!printMode) document.addEventListener('keydown', onKey);

  let touchX = null;
  root.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (touchX == null || zoom.k !== 1) return;   // a zoomed slide is panned, not turned
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) (dx < 0 ? instance.next() : instance.prev());
    touchX = null;
  }, { passive: true });

  // ----- scaling -----------------------------------------------------------
  // A docked panel (the review, so far) reserves a gutter by setting
  // `--dock-left/right/bottom` on the root, in px. The stage then fits into what
  // is LEFT and re-centres there: the fit divides by the reduced area, and the
  // extra translate shifts the stage by half the asymmetry so it sits centred in
  // the visible region rather than behind the panel. Zero when nothing is docked.
  const dockPx = (name) => parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
  function rescale() {
    const box = root.getBoundingClientRect();
    const dl = dockPx('--dock-left'), dr = dockPx('--dock-right'), db = dockPx('--dock-bottom');
    const availW = box.width - dl - dr, availH = box.height - db;
    if (sizeStage(availW, availH)) remeasureSoon();
    const s = Math.min(availW / parseFloat(stage.style.width),
                       availH / parseFloat(stage.style.height)) || 1;
    instance._scale = s;
    // Published for the chrome that sits OUTSIDE the scaled stage: captions are
    // sized in px on the root, so in a preview iframe they stayed full-size over
    // a thumbnail of the slide (#490). A var, not a second copy of this maths.
    // The FIT scale, not the zoomed one: the chrome never zooms.
    root.style.setProperty('--stage-scale', String(s));
    // The zoom (pinch, below) multiplies the fit and pans the stage; the
    // chrome lives on the root, outside this transform, and keeps its size.
    stage.style.transform =
      `translate(-50%, -50%) translate(${(dl - dr) / 2 + zoom.x}px, ${-db / 2 + zoom.y}px) scale(${s * zoom.k})`;
  }

  // ----- pinch zoom (PRESENTING) -----------------------------------------
  // A pinch zooms the SLIDE, not the page: the stage is the one element the
  // fit transform scales, so a factor on top of it zooms the content and
  // nothing else on screen — panels, bars, captions and the editing chrome
  // all sit on the root, outside the transform. On a trackpad a pinch is a
  // wheel event with ctrlKey (every browser, every platform); on a touch
  // screen it is two fingers. Both are taken here, preventDefault and all,
  // which is what stops the browser zooming the whole page instead.
  // A zoom is "look closer at this", not a setting: it does not persist,
  // and a slide change, Esc, 0 or pinching back below 1 snap it to fit.
  // Two-finger scroll (a plain wheel) pans while zoomed; at 1 it is left
  // to whatever it did before, which is nothing.
  const ZOOM_MAX = 4;
  const zoom = { k: 1, x: 0, y: 0 };
  function applyZoom(k, { at = null, dx = 0, dy = 0 } = {}) {
    const next = Math.min(ZOOM_MAX, Math.max(1, k));
    if (at && next !== zoom.k) {
      // zoom about the point under the fingers: keep that content point still
      const box = root.getBoundingClientRect();
      const cx = at.x - (box.left + box.width / 2) - zoom.x;
      const cy = at.y - (box.top + box.height / 2) - zoom.y;
      const r = next / zoom.k;
      zoom.x += cx - cx * r;
      zoom.y += cy - cy * r;
    }
    zoom.k = next;
    zoom.x += dx; zoom.y += dy;
    if (zoom.k === 1) { zoom.x = 0; zoom.y = 0; }
    else {
      // the stage never leaves the window: the pan is bounded by how much
      // of the zoomed stage overhangs it
      const box = root.getBoundingClientRect();
      const w = parseFloat(stage.style.width) * instance._scale * zoom.k, h = parseFloat(stage.style.height) * instance._scale * zoom.k;
      const mx = Math.max(0, (w - box.width) / 2), my = Math.max(0, (h - box.height) / 2);
      zoom.x = Math.min(mx, Math.max(-mx, zoom.x));
      zoom.y = Math.min(my, Math.max(-my, zoom.y));
    }
    root.classList.toggle('is-zoomed', zoom.k !== 1);
    rescale();
    paintZoomChip();
  }
  const resetZoom = () => { if (zoom.k !== 1) applyZoom(1); };
  // The percentage, top right, for as long as the slide is not at fit: a
  // zoomed slide looks like a slide, and the one thing that tells you why
  // the edges are missing is this. On the slide number's row, to its left,
  // while editing is on (under it sat on the commit chip); measured from
  // the badge's own width, since "1 / 9" and "12 / 120" are not the same.
  // A click on it fits, like 0.
  let zoomChip = null;
  function paintZoomChip() {
    if (zoom.k === 1) { zoomChip?.remove(); zoomChip = null; return; }
    if (!zoomChip) {
      zoomChip = document.createElement('button');
      zoomChip.type = 'button';
      zoomChip.className = 'decklight-zoom';
      zoomChip.title = 'zoomed — click, 0 or Esc fits the slide again';
      zoomChip.addEventListener('click', resetZoom);
      root.appendChild(zoomChip);
    }
    zoomChip.textContent = `${Math.round(zoom.k * 100)}%`;
    const badge = root.querySelector('.decklight-slide-num');
    zoomChip.style.right = badge ? `${16 + badge.offsetWidth + 8}px` : '';
  }
  // the badge comes and goes with editing and the lock: the chip follows it
  new MutationObserver(() => { if (zoomChip) paintZoomChip(); }).observe(root, { childList: true });
  /** The deck's zoom as the harness and the debug line read it: factor and pan. */
  instance.zoom = () => ({ k: zoom.k, x: zoom.x, y: zoom.y });
  instance.setZoom = (k, opts) => applyZoom(k, opts);
  if (!printMode && !params.has('embedded')) {
    // Over the slide, or the letterbox around it — not over a panel beside
    // it (the notes card, the inspector), nor a picker or the overview, which
    // cover the stage with their own element: the gesture there belongs to
    // whatever is under the fingers. A docked panel being open is no reason
    // not to zoom the slide next to it.
    const onStage = (t) => !overviewEl && (t === root || stage.contains(t));
    root.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        // a pinch on a trackpad: never the page's zoom, wherever it lands…
        e.preventDefault();
        if (!onStage(e.target)) return;
        // …and the slide's over the slide; deltaY is small and signed, so a
        // smooth exponential step per event tracks the fingers
        applyZoom(zoom.k * Math.exp(-e.deltaY * 0.01), { at: { x: e.clientX, y: e.clientY } });
      } else if (zoom.k !== 1 && onStage(e.target)) {
        e.preventDefault();
        applyZoom(zoom.k, { dx: -e.deltaX, dy: -e.deltaY });
      }
    }, { passive: false });
    // two fingers on a touch screen: the distance between them is the zoom,
    // their midpoint's movement the pan
    let pinch = null;
    const span = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    root.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && onStage(e.target)) pinch = { d: span(e.touches), k: zoom.k, m: mid(e.touches) };
    }, { passive: true });
    root.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      applyZoom(pinch.k * (span(e.touches) / pinch.d), { at: m, dx: m.x - pinch.m.x, dy: m.y - pinch.m.y });
      pinch.m = m;
    }, { passive: false });
    root.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });
    instance.on('slide', resetZoom);
  }
  // Docked overlays call this after changing a `--dock-*` var: it is the same
  // refit the ResizeObserver runs, but a var change is not a resize.
  instance._reflow = () => { if (!printMode) rescale(); };
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
      const t = parseHash(location.hash);
      if (t) instance.goto(t.slide, t.step, { force: true });
    });
  }

  // Background videos (SPEC DECK_ANATOMY): driven from the slide event, because CSS
  // `section.active` gating alone only hides the element — a display:none
  // <video> keeps decoding. Play the active slide's clip, pause the rest for
  // real. Print mode never creates a <video>, so there is nothing to drive.
  // ----- bleed (SPEC DECK_ANATOMY, #643) ---------------------------------------
  // The current slide's background art on a layer behind the stage, at
  // screen size — so a 16:9 deck's art fills a 16:10 or 4:3 screen. Never in
  // print or an embedded preview, and not when the deck says "bleed": false.
  const bleed = createBleed({ root, enabled: !printMode && !params.has('embedded') && config.bleed !== false });
  const bleedNow = (ms = 0) => bleed.update(instance._sections[instance.state.slide - 1], { ms });
  instance.on('slide', () => {
    const to = instance._sections[instance.state.slide - 1];
    const name = transitionName(to?.getAttribute('data-transition'), instance.config.transition);
    bleedNow(name === 'none' ? 0 : cssDurationMs(getComputedStyle(root).getPropertyValue('--transition-duration'), 350));
  });
  instance._afterSync = () => bleedNow(0);   // a re-sync may have changed the art (a live edit)

  if (!printMode) {
    const syncBgVideos = () => {
      instance._sections.forEach((s, i) => {
        const v = s.querySelector(':scope > .slide-bg > video');
        if (!v) return;
        // a bled slide's clip plays on the bleed layer: the on-stage copy is hidden, and paused for real
        if (i === instance.state.slide - 1 && !s.hasAttribute('data-bled')) v.play()?.catch?.(() => {});
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
  instance.currentTheme = () => currentTheme();              // the theme on screen, by name
  instance.themePicker = { open: themes.openPicker, close: themes.closePicker };
  instance.generateTheme = rollTheme;                       // ⌃T, programmatic
  instance.cycleFont = cycleFont;                           // [ / ], programmatic (±1)
  instance.cycleLayout = cycleLayout;                       // L / ⇧L, programmatic (±1); write mode only
  instance.layoutRing = layoutRing;                         // the ring a slide would cycle (skips applied)
  instance.toggleMessages = toggleMessages;                 // I, programmatic
  instance.messages = messages;                             // [{ at, text }] — every message shown
  instance.showWelcome = onboarding.showWelcome;            // first-run card, palette / programmatic
  instance.showEditingTour = onboarding.showEditingTour; // the editing tour, palette / programmatic
  instance.settings = {                                     // palette → Settings…, programmatic
    open: openSettings,
    close: closeSettings,
    rows: settingsRows,                                     // [{ label, value?, run? }]
  };

  // ── narration (narration.js) ─────────────────────────────────────────────
  // The deck's voice and everything that hangs off it: recorded and live
  // tracks, the sentence pipeline, captions, the lip-synced character, the N
  // picker and the the synthesized recorder offline recorder. It reaches back into two pieces of
  // chrome the engine owns and it invalidates — the mute button and the D
  // panel's status line — and the engine reads its playback state back
  // through status().
  // Registered before the narration panel: a range picked FROM that panel opens
  // on top of it, and overlapping overlays give the keyboard to the one
  // registered first.
  const rangePicker = createRangePicker({ root, overlays });
  const choiceCard = createChoiceCard({ root, overlays });
  const narration = createNarration({
    root, stage, config, params, printMode, toast, logOnly, debugLog, overlays, instance,
    // where the hash sends this load: past the first build of the first slide
    // is a talk in progress, not a first view — the same rule onboarding keeps
    openedMidTalk: (() => {
      const t = config.hash && parseHash(location.hash);
      return !!t && (t.slide !== 1 || t.step !== 0);
    })(),
    rangePicker, chapters: () => moduleNav.markers(),
    syncSoundBtn, updateDebugState, downloadFromUrl,
    // the synthesized recorder writes its slide-NN.wav next to the deck when there is a server that
    // owns the deck file; a thunk because editmode is built below this, and its
    // probe has not answered yet either way.
    editBase: () => (editmode?.available() ? editmode.base() : null),
    // …and the thing that makes reading it safe: false means "no server" only
    // AFTER this resolves. The recorder awaits it rather than guessing early.
    editReady: () => editmode?.settled?.() ?? Promise.resolve(),
    // V → Enhance the script…: write mode only, like every row that writes the deck
    openWriting: () => (editmode?.available() ? editmode.openWriting : null),
    // the recorder's Fix the notes: the notes card, write mode only (#929)
    editNotes: () => (editmode?.available() ? editmode.notesFor : null),
    // the data-module chapter a slide is in, for the rewrite scopes
  });
  const {
    character, toggleNarration, toggleNarrPause, changeNarrRate, toggleCaptions,
    openRecordDialog, openMicRecorder, notesSegs, notesDraftOf,
  } = narration;
  const openNarrPicker = narration.openPicker;
  instance.toggleNarration = toggleNarration;               // programmatic start/stop
  // The voice, for API callers and the render harnesses — a curated surface
  // like `instance.settings` and `instance.restore`, not the whole module.
  instance.narration = {
    playPause: () => narration.playPause(),
    openPicker: (view) => narration.openPicker(view),
    status: () => narration.status(),
  };
  // `decklight narrate --mic deck.html` opens the deck HERE — the whole point of that
  // command being that a microphone needs a secure context and file:// is not
  // one. Deferred a beat so the first slide has landed and the welcome card (a
  // first run is exactly when someone tries this) has had its say; skipped
  // entirely if anything else already owns the keyboard.
  if (params.has('record') && !printMode) {
    setTimeout(() => { if (!overlays.active()) openMicRecorder(); }, 700);
  }

  // ── review comments (review.js) — SPEC REVIEW ────────────────────────────
  // Somebody else's remarks on this deck, anchored to slides and carried by
  // git. What M can do depends on which server answered: a no-trust mode takes
  // a new comment, an edit server resolves one, and with neither the list
  // still reads and says where comments come from.
  const review = createReview({
    root,
    params,
    overlays,
    instance,
    toast,
    debugLog,
    sections: () => instance._sections ?? [],
    // the finder's own helpers, so a comment remembers a slide by the name the
    // finder would give it and the two can never disagree
    titleOf: slideTitle,
    bodyOf: slideBody,
    editBase: () => (editmode?.available() ? editmode.base() : null),
    editReady: () => editmode?.settled?.() ?? Promise.resolve(),
  });

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
  const { toggleClock, toggleProgress, toggleInk } = hud;
  // The transcript is read in the speaker view's script view (speaker.js),
  // opened here, and exported from the palette without a second window.
  function openTranscript() {
    const w = speakerWindow();
    if (!w) { toast('the speaker view could not open: allow pop-ups for this page, then try again', 4200); return; }
    w.__decklightSpeakerScript?.(true);
  }
  instance.transcript.setOpener(openTranscript);
  instance.toggleClock = toggleClock;       // the palette's Clock row, and API callers
  instance.toggleProgress = toggleProgress; // the palette's Progress bar row, and API callers

  // ── dev-server features (editmode.js) ────────────────────────────────────
  // Live reload, the notes editor, the phone remote, asking an agent, undo/redo
  // and the R restore dialog — everything that needs the edit server serving
  // the deck. Built here, last, because it wants the instance and narration's
  // notes segmentation; it registers its own three overlays.
  const editmode = createEditMode({
    root, config, params, printMode, toast, progress: progressToast, debugLog, debugReload, overlays, instance,
    notesSegs, notesDraft: notesDraftOf,
    // a migration's skill the agent does not have yet: where it goes (#893)
    choiceCard,
    // what an export renders in — the theme on screen, not the deck's default (#547)
    renderTheme: () => themes.renderTheme(),
    // what a preview frame looks like — the history's included — the same
    previewQuery: () => themes.previewQuery(),
    // the deck's captions, which the history's preview follows (C there flips them)
    captionsOn: () => narration.status().captionsOn, toggleCaptions,
    // a reviewed script, heard in the live voice (fixreview.js)
    speak: (text, btn) => narration.hear(text, btn),
    // the names the menu's Concept ▸ offers: the deck's, as its diagrams and its configuration know them (#718)
    knownConcepts: () => conceptsOn(stage, config.concepts ?? {}).map((c) => c.name),
  });
  // Putting shapes into a concept, from anywhere (SVG_DIAGRAMS): one write for
  // any number of shapes, in place, and the look-alikes offered after one
  conceptTools = createConceptTools({
    stage: () => stage, editmode: () => editmode, choiceCard, toast,
    repaint: () => { applyConcepts(stage, config.concepts ?? {}); conceptsEditor.refresh(); inspector?.refresh?.(); },
    debugLog: (...a) => debugLog(...a),
  });
  editmode.setConceptTools(conceptTools);
  // copy style / paste style (style-clip.js): the menu's rows and ⌥⌘C / ⌥⌘V on a selection
  const styleClip = createStyleClip({
    save: (body) => editmode.saveStyles(body), toast,
    repaint: () => { applyConcepts(stage, config.concepts ?? {}); conceptsEditor.refresh(); inspector?.refresh?.(); },
    // a deck held to its brand takes no literal colour: the nearest swatch instead (SPEC BRAND_PALETTE)
    snap: () => (themes.brandLocked() ? brandSnapper([...pageDesignSystems().values()], themes.currentTheme()) : null),
    debugLog: (...a) => debugLog(...a),
  });
  editmode.setStyleClip(styleClip);
  editmode.setEditConcepts((name) => conceptsEditor.open({ select: name }));
  instance._concepts = { tools: conceptTools, editor: conceptsEditor };
  // an add left a look to offer, before the reload it caused (SPEC
  // DESIGN_SYSTEMS): offered once the page knows it is authoring
  editmode.settled().then(() => { if (editmode.available()) lookOffer.resume(); });
  // the overview an edit reloaded out from under: back, on the slide the server named
  editmode.settled().then(() => {
    let again = false;
    try { again = sessionStorage.getItem(OVERVIEW_OPEN_KEY) === '1'; sessionStorage.removeItem(OVERVIEW_OPEN_KEY); } catch { /* no storage */ }
    if (again && editmode.available() && !overviewEl) toggleOverview();
  });
  const { deckHistory, toggleEditor, toggleAgentAsk } = editmode;

  // A design-system slide that could not be expanded, or a design system the
  // page could not have (SPEC DESIGN_SYSTEMS): badged on the slide and said
  // once — while AUTHORING only. Presenting falls back to the plain content
  // silently; a render or a preview has no one to tell.
  editmode.settled?.().then(() => {
    if (!editmode.available() || printMode || params.has('embedded') || params.has('capture')) return;
    root.classList.add('decklight-authoring');
    const systems = [...document.querySelectorAll('meta[name="decklight-design-system-missing"]')].map((m) => m.content);
    const slides = instance._sections.map((s, i) => [i + 1, s.getAttribute('data-ds-missing')]).filter(([, why]) => why);
    if (!systems.length && !slides.length) return;
    if (systems.length) {
      // the row in Check deck… says the same, with the fix when a registered marketplace holds the update
      problemToast(`design ${systems.length === 1 ? 'system' : 'systems'} not on this machine: ${systems.map((x) => x.split(' — ')[0]).join('; ')}`
        + ` — ${systems.length === 1 ? '1 problem' : `${systems.length} problems`}`, { rule: 'ds-unresolved' });
    } else {
      toast(`slide ${slides[0][0]}: ${slides[0][1]}${slides.length > 1 ? ` (and ${slides.length - 1} more)` : ''} — shown as plain content`, 7000);
    }
    for (const m of systems) debugLog('design-system', `missing ${m}`);
    for (const [n, why] of slides) debugLog('design-system', `slide ${n}: ${why}`);
  });
  // A deck written for an older major of its design system (SPEC
  // DESIGN_SYSTEM_MIGRATIONS): the server says so in a meta, with the renames
  // and what moves them; said once a session while authoring, like the
  // off-brand theme, because the slides only lose colours and say nothing.
  // The toast is a POINTER (PRESENTING_EDITING): the whole sentence, and
  // Migrate, are Check deck…'s row for it, where every other problem is too,
  // so it says there is one with a fix and opens the panel on that row. It
  // stays up until the author dismisses it or goes; once migrated the deck
  // records the version, the meta is gone, and so is the toast.
  editmode.settled?.().then(() => {
    if (!editmode.available() || printMode || params.has('embedded') || params.has('capture')) return;
    for (const m of document.querySelectorAll('meta[name="decklight-design-system-behind"]')) {
      debugLog('design-system', `behind: ${m.content}`);
      const key = `decklight-design-system-behind:${location.pathname}:${m.content}`;
      try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, '1'); } catch { /* no storage: say it each load */ }
      const ref = m.getAttribute('data-ref');
      const title = m.content.split(':')[0];
      problemToast(`${title}: this deck is behind the version this machine serves — 1 problem with a fix`, { rule: 'ds-behind', ref });
    }
    offerMarketplaceUpdates();
  });
  // The marketplace auto-check (SPEC MARKETPLACES_SCREEN), when the author
  // turned it on: what it found behind, offered in ONE toast that stays.
  // Update is ⏎ on that row of Marketplaces… (the update, then what's new
  // and any Migrate it brings); Dismiss is remembered by the server at that
  // commit, so the same update is not offered again. Once a session per
  // offer, because every write reloads the page. Asked on load and again
  // when a starting server's check lands; it never updates anything itself.
  let offerToast = null;
  async function offerMarketplaceUpdates() {
    if (!editmode.available() || printMode || params.has('embedded') || params.has('capture')) return;
    let offers = [];
    try {
      const j = await (await fetch(`${editmode.base()}/deck/edit/marketplace/auto-check`)).json();
      offers = j?.ok ? j.offers ?? [] : [];
    } catch { return; }
    const key = `decklight-marketplace-offer:${offers.map((o) => `${o.name}@${o.remote}`).join(',')}`;
    try { if (!offers.length || sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { if (!offers.length) return; }
    for (const o of offers) debugLog('marketplace', `offered: ${o.text}`);
    offerToast?.close();
    const dismiss = () => Promise.all(offers.map((o) => fetch(`${editmode.base()}/deck/edit/marketplace/auto-check`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dismiss: o.name, remote: o.remote }),
    }).catch(() => {})));
    offerToast = actionToast(autoCheckToastText(offers), [
      ...(offers.length === 1 ? [['Update', () => { marketplaces.open({ update: offers[0].name }); }]] : []),
      ['Marketplaces…', () => { marketplaces.open(); }],
    ], { onDismiss: dismiss });
  }
  editmode.onMarketplaces?.(() => { offerMarketplaceUpdates(); });

  // The video export (PRESENTING): which slides, and how — voice, format,
  // quality, subtitles — on one card, then the door every export uses. A range
  // chosen is only chosen: the Export button runs it, as Start runs the
  // recorder. Each setting starts on the answer already chosen, so the common
  // case is one Enter: the voice V speaks with, and the format, quality and
  // subtitles this browser picked last time. ← → turn them.
  const VIDEO_PREFS = 'decklight:video-export';
  function videoPrefs() {
    return readJson(VIDEO_PREFS, {});
  }
  async function openVideoExport() {
    const voice = await narration.exportSources();
    const prefs = videoPrefs();
    const at = (list, value, fallback) => Math.max(0, list.findIndex((o) => o.value === (value ?? fallback)));
    rangePicker.open({
      title: 'export a video',
      action: 'Export video',
      total: instance.state.totalSlides, slide: instance.state.slide, chapters: moduleNav.markers(),
      settings: [
        { key: 'voice', name: 'Voice', ...voice },
        { key: 'format', name: 'Format', options: VIDEO_FORMATS, index: at(VIDEO_FORMATS, prefs.format, 'mp4') },
        { key: 'quality', name: 'Quality', options: VIDEO_QUALITIES, index: at(VIDEO_QUALITIES, prefs.quality, 'standard') },
        { key: 'subtitles', name: 'Subtitles', options: VIDEO_SUBTITLES, index: at(VIDEO_SUBTITLES, prefs.subtitles, 'none') },
        { key: 'face', name: 'Face', options: VIDEO_FACE, index: at(VIDEO_FACE, prefs.face, 'on') },
      ],
      onPick: (slides, { voice: v, format, quality, subtitles, face }) => {
        // Remembered here and not per deck: a format is a habit of the person
        // exporting, and the voice is not remembered at all — it follows V.
        writeJson(VIDEO_PREFS, { format, quality, subtitles, face });   // private mode: not remembered
        editmode.exportDeck('video', { slides, voice: v, format, quality, subtitles, face });
      },
    });
  }


  // The bundle (DECK_ANATOMY): a deck in chapters is asked first what goes in,
  // the whole deck or one chapter of it, as `decklight bundle --module` bundles
  // one (#840). The card opens on the chapter of the slide on screen, which is
  // the one a presenter about to ship "this module" means; a slide before the
  // first chapter opens it on the whole deck. The chapter goes to the server
  // as its number, never its title: --module takes both, but the number is the
  // one thing the card and the bundler count the same way.
  //
  // Then a deck with a recorded voice is asked what the file carries of it,
  // each answer with the size the file would come out at, so "small enough to
  // email?" is answered before anything is written. The answer is remembered
  // here, not per deck: it is a habit of the person sending. A deck with no
  // chapters and no recorded audio bundles straight away.
  const BUNDLE_AUDIO = 'decklight:bundle-audio';
  const slidesLabel = (n) => (n === 1 ? '1 slide' : `${n} slides`);
  const spanLabel = (from, to) => (from === to ? `slide ${from}` : `slides ${from}–${to}`);
  function openBundle() {
    const chapters = moduleNav.hasMarkers ? moduleNav.markers() : [];
    if (!chapters.length) return bundleAudio(null);
    const total = instance.state.totalSlides;
    const at = moduleNav.currentMarkerIndex(chapters);
    choiceCard.open({
      title: 'bundle into one file — the whole deck, or one module?',
      rows: [
        { value: 0, label: 'Whole deck', note: spanLabel(1, total), figure: slidesLabel(total) },
        ...chapters.map((c, i) => {
          const last = (chapters[i + 1]?.slide ?? total + 1) - 1;
          return { value: i + 1, label: c.title, note: `module ${i + 1} · ${spanLabel(c.slide, last)}`, figure: slidesLabel(last - c.slide + 1) };
        }),
      ],
      current: at >= 0 ? at + 1 : 0,
      onPick: (n) => bundleAudio(n || null),
    });
  }
  /** The bundle of `module` (a chapter's number, or null for the whole deck), and its audio. */
  async function bundleAudio(module) {
    const opts = module != null ? { module } : {};
    if (!narrationTracks(config.narration).length) return editmode.exportDeck('bundle', opts);
    const est = await editmode.bundleEstimate(opts);
    if (!est) return;
    if (!est.audio) return editmode.exportDeck('bundle', opts);
    const { base, audio: a } = est;
    const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
    const mins = a.seconds == null ? null : `${Math.floor(a.seconds / 60)}:${String(Math.round(a.seconds % 60)).padStart(2, '0')}`;
    const last = readPref(BUNDLE_AUDIO);
    choiceCard.open({
      title: `bundle ${module != null ? `module ${module} ` : ''}into one file — and the narration audio?`,
      lines: [`${a.files} recorded file${a.files === 1 ? '' : 's'}${mins ? `, ${mins} of voice` : ''}, ${mb(a.bytes)} in ${a.folders}`],
      rows: [
        { value: 'none', label: 'Leave it beside the deck', note: 'send the folder with the file', figure: mb(base) },
        { value: 'original', label: 'As recorded', note: 'nothing lost', figure: mb(base + a.original) },
        { value: 'aac', label: 'AAC, mono 32 kbps', note: 'plays in every browser', figure: a.aac == null ? '' : `≈ ${mb(base + a.aac)}`, blocked: a.aac == null ? a.why.aac : null },
        { value: 'opus', label: 'Opus, mono 24 kbps', note: 'smallest, Safari from 17', figure: a.opus == null ? '' : `≈ ${mb(base + a.opus)}`, blocked: a.opus == null ? a.why.opus : null },
      ],
      current: last ?? 'aac',
      onPick: (how) => {
        writePref(BUNDLE_AUDIO, how);   // private mode: not remembered
        editmode.exportDeck('bundle', how === 'none' ? opts : { ...opts, audio: how });
      },
    });
  }

  // R programmatically — and what the headless overlay harness drives, since
  // it cannot reach a git server to populate the real list.
  instance.restore = editmode.restore;
  // The engine wizard (ENGINES#WIZARD), for drivers that cannot click the
  // palette's Configure rows. Same write-mode gate either way.
  instance.wizard = editmode.wizard;
  // Double-click text to edit it, drop a picture to add it (authoring.js):
  // the two gestures every editor teaches, on top of the routes above.
  const authoring = createAuthoring({ root, instance, toast, editmode, debugLog });
  // Editing's face (editbar.js): the bar E opens, and click-to-select on the
  // slide. A surface over the gestures and keys above, never a second path.
  const editbar = createEditBar({
    root, instance, editmode, authoring, toast, debugLog,
    toggleEditor, cycleLayout, deckHistory,
    enabled: () => !printMode && !params.has('embedded') && !captureMode,
  });
  inspector = createInspector({
    root, overlays, toast, copyText,
    // the Colors tab's Concept row: the deck's concepts, and an attach in place
    concepts: () => (conceptTools ? {
      names: () => conceptsOn(stage, config.concepts ?? {}).map((c) => c.name),
      fill: (name) => conceptFill(name, config.concepts ?? {}),
      set: (el, name) => {
        if (name !== null && !/^[a-z][a-z0-9-]{0,40}$/i.test(name)) { toast('a concept is a name: letters, digits and dashes, starting with a letter', 3200); return null; }
        return conceptTools.attach([el], name);
      },
      // Concept colors…, at `name`'s row: the inspector's way into the deck's concepts
      edit: (name) => conceptsEditor.open({ select: name }),
    } : null),
    instance: () => instance, stage: () => stage,
    editmode: () => editmode, editbar: () => editbar,
    review: () => review, narration: () => narration, sources: () => sources,
    // the deck's brand (SPEC BRAND_PALETTE): held to it or not, and the theme on screen
    brand: () => ({ locked: themes.brandLocked(), theme: themes.currentTheme() }),
  });
  // the content editor's way back to the inspector (its HTML tab's other end)
  editmode.setInspectorOpener?.(() => inspector?.open());
  // Check deck… (palette, SPEC PRESENTING): the open deck's own lint, slide by
  // slide. An inactive slide is display:none, so overflow is measured under
  // the same momentary .pin-measure the pinned titles use.
  function measureOverflow(sec, n) {
    const hidden = getComputedStyle(sec).display === 'none';
    if (hidden) sec.classList.add('pin-measure');
    checkOverflow(sec, n);
    if (hidden) sec.classList.remove('pin-measure');
    return sec.hasAttribute('data-overflow');
  }
  const deckCheck = createDeckCheck({
    root, overlays, toast, instance: () => instance,
    goto: (n) => instance.goto(n, 0),
    measureOverflow,
    slideTitle: (sec, i) => slideTitle(sec, i, slideBody(sec)),
    // labels that recur in different colours: worth a concept, and its fix makes it one in write mode
    suggestions: () => conceptSuggestions(stage),
    accept: () => (editmode?.available() && conceptTools ? (s) => conceptTools.accept(s) : null),
    // the agent review's findings (cli/agent-review.mjs)
    agentFindings: () => editmode?.reviewFindings?.() ?? [],
    // the file's half of the check, and the two kinds of fix (PRESENTING_EDITING):
    // the server's own, and an ask to the A agent when this machine has one
    editmode: () => editmode,
    quickFix: () => (editmode?.available() ? (q) => editmode.fixProblem(q) : null),
    askAgent: () => (editmode?.available() && editmode.agents().length ? (a) => editmode.askAgent(a) : null),
  });
  // a review just finished: show what it found; what the panel lists changed under it: read again
  editmode.onReview?.((r) => { if (r.findings.length && reviewOpenWanted) { reviewOpenWanted = false; deckCheck.open(); } else deckCheck.refresh(); });
  editmode.onWrite?.(() => deckCheck.refresh());
  for (const ev of ['decklight:theme', 'decklight:concepts', 'decklight:layout']) root.addEventListener(ev, () => deckCheck.refresh());
  instance.check = () => deckCheck.check();
  instance._deckCheck = deckCheck;
  // the review a quick fix opens (#907): its candidate, stops and decisions, for a headless probe
  instance._fixReview = editmode.fixReview;

  // the element menu's Inspect, Colors… and Type… (PRESENTING): select what
  // the menu was opened on, then show it in the inspector on that tab
  instance._selection = () => editbar.selected();   // what is selected, for the render harnesses
  editmode.setInspect((t, tab) => {
    if (t?.node) editbar.selectNode(t.node, { exact: true });
    inspector.open({ tab });
  });

  // `hasTracks`, not `track`: narration is OFF until somebody picks, so a deck
  // that ships audio has no chosen track to test for — and `?voiceover` is
  // itself the choosing (narration.playVoiceoverParam).
  if (params.has('voiceover') && narration.status().hasTracks && !printMode) {
    // whichever gesture fires first must disarm the OTHER listener too, or
    // the survivor re-arms narration on the next key/click after V stops it
    const arm = () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      if (!narration.status().narrating) narration.playDefault();
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
      // playDefault, not toggleNarration: narration is off until chosen, and
      // a tap on a speaker icon IS the choosing — a phone has no V key to be
      // sent to (narration.playDefault)
      soundBtn.addEventListener('click', () => narration.playDefault());
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
      applyNesting(s);   // every slide is laid out in print
    });
    // Handout/notes variants restructure the DOM — sections wrapped into
    // .print-page slots — strictly AFTER sync() and applyBuildState above:
    // sync() selects `:scope > section` and must never run again once the
    // sections are wrapped. Print is static, so it never does.
    if (showHidden) root.classList.add('decklight-show-hidden');
    if (printVariant === 'handout' || printVariant === 'notes') {
      root.classList.add('decklight-print-' + printVariant);
      buildPrintPages(stage, instance._sections.filter((s) => showHidden || !s.hasAttribute('data-hidden')), printVariant);
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

  // An embedded preview says where it is, after every move and every rescan:
  // the panel around it steps the builds (the history's ◀ ▶), and only the
  // deck knows how many a slide has — a late build provider can still grow it.
  if (params.has('embedded') && window.parent !== window) {
    instance._reportToParent = () => {
      const { slide, step, totalSlides: total } = instance.state;
      const steps = instance._records[slide - 1]?.groups.length ?? 0;
      window.parent.postMessage({ __decklightPreviewState: { slide, step, steps, total } }, '*');
    };
  }

  const target = (config.hash && parseHash(location.hash)) || { slide: 1, step: 0 };
  instance._sections.forEach((s, i) => {
    if (i !== target.slide - 1) applyBuildState(instance._records[i], 0);
  });
  instance.goto(target.slide, target.step, { force: true });

  root.__decklight = instance;
  activeInstance = instance;
  instance._emit('ready', { slides: instance.state.totalSlides });
  // Last, and after `ready`: the welcome card is the only chrome
  // that reads where the hash SENT the deck, and a load that landed on slide 12
  // is a talk in progress, not a first run.
  onboarding.start(target);
  // …and write mode's own, once the edit server has answered (one card a load)
  editmode.settled?.().then(() => { if (editmode.available()) onboarding.startEditingTour(target); });
  return instance;
}
