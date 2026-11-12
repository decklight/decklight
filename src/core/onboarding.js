// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Teaching the product, twice and no more: the first deck a browser opens,
// and the first time it opens one in write mode.
//
// A newcomer opens a deck and sees a slide. The three things they cannot guess
// are the three things that make Decklight — the deck is one HTML file an agent
// can author, `/` is the way into everything, and write mode turns the player
// into an editor. So the FIRST load a browser ever gives us gets a card that
// says exactly that (WELCOME), and the first write-mode load gets the editing
// tour. Nothing else: a rotation of twelve one-line tips used to follow, one
// per load, with three palette rows to turn it off, on and back to the start.
// The palette already answers "how do I…" for anyone who types the word, and
// `?` lists every key; a tip a load was teaching what both of those say.
//
// Both flags are GLOBAL (`decklight-onboarded`, `decklight-onboarded-tour`),
// not path-scoped like theme/font/clock. Those remember what a DECK should
// look like; these remember what a PERSON has already been told, and being
// told twice by a second deck is the whole thing they exist to prevent.
//
// Nothing here may ever appear over a live audience: no card in `?print`,
// `?embedded` or `?capture`, none when the URL deep-links past the first build
// of the first slide (a link into the middle of a talk is not a first run),
// and the first advance — key, click, swipe, chevron or a programmatic next()
// — retires the card for good.

import { closeOnBackdrop } from './overlay.js';
import { readPref, writePref } from './prefs.js';
import { IS_MAC, UNDO_CHORD } from './undo-chord.js';

// ⌃T reaches the page only on a Mac: elsewhere the browser owns Ctrl+T (a new
// tab), so the card does not teach a key that opens a tab instead.
const GENERATE = IS_MAC;

const SEEN_KEY = 'decklight-onboarded';   // the welcome card, once per browser
const TOUR_SEEN_KEY = 'decklight-onboarded-tour';   // the editing tour, once per browser

/** A card is a dialog to a screen reader, named by its heading, and takes the focus so its keys are heard. */
function markDialog(el) {
  const card = el.querySelector?.('.wel-card');
  const h = card?.querySelector?.('h3');
  if (!card) return;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  if (h) { h.id = h.id || `dl-card-${Math.random().toString(36).slice(2, 8)}`; card.setAttribute('aria-labelledby', h.id); }
  card.tabIndex = -1;
  setTimeout(() => { try { card.focus({ preventScroll: true }); } catch { /* not focusable here */ } }, 0);
}

// Storage is advisory here, never load-bearing: `file://` and private mode both
// throw, and a deck that cannot remember what it has taught must still play.
const read = (key) => readPref(key);
const write = (key, value) => { writePref(key, value); };

/**
 * Wire the first-run welcome and the editing tour to a deck.
 *
 * `start()` is the one entry point the engine calls, after `ready` — by then
 * the deck knows where the hash sent it, which is what decides whether this
 * load is a first run or somebody's link into slide 12.
 *
 * Built BEFORE the instance exists (`deck` is an accessor, as the theme picker
 * takes one) for the sake of one line: registering here makes the welcome the
 * first overlay in the registry, and registration order is priority. Nothing
 * else can be up on a fresh load, but the rule that settles a tie should be
 * the obvious one rather than an accident of construction order.
 */
export function createOnboarding({ root, printMode, params, toast, debugLog, overlays, deck, openHelp = () => {}, openPalette = () => {} }) {
  const embedded = params.has('embedded');
  // a preview, a printout and a render (`?capture`, #548) teach nobody
  const quiet = printMode || embedded || params.has('capture');

  // ----- the first-run welcome ---------------------------------------------
  let cardEl = null;

  function dismissWelcome() {
    if (!cardEl) return;
    cardEl.remove();
    cardEl = null;
    write(SEEN_KEY, '1');
    debugLog?.('nav', 'welcome dismissed');
  }

  function showWelcome() {
    if (cardEl || printMode) return;
    cardEl = document.createElement('div');
    cardEl.className = 'decklight-welcome';
    // For whoever is WATCHING the deck: how to move through it and where
    // everything else is. Write mode, agents and undo are the author's, and
    // the author gets the editing tour instead (startEditingTour).
    // On a phone or a tablet the same card in gestures: it has no keys to list.
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
    cardEl.innerHTML = touch ? `<div class="wel-card">
      <h3>Welcome to Decklight</h3>
      <p class="wel-lead">A deck in one HTML file. Here is how to get around it.</p>
      <table>
        <tr><td>swipe</td><td><b>Next</b> and back; a tap on the slide is next too.</td></tr>
        <tr><td>⋯</td><td>Top left: the <b>overview</b>, <b>find a slide</b>, the <b>notes</b>, every <b>command</b>.</td></tr>
        <tr><td>pinch</td><td><b>Zoom</b> the slide; pinch back to fit it.</td></tr>
        <tr><td>🔊</td><td><b>The voice</b>: hear the deck read aloud, when it has one.</td></tr>
      </table>
      <div class="wel-foot">
        <span>Tap to start.</span>
        <button type="button" class="wel-go">Got it</button>
      </div>
    </div>` : `<div class="wel-card">
      <h3>Welcome to Decklight</h3>
      <p class="wel-lead">A deck in one HTML file. Here is how to get around it.</p>
      <table>
        <tr><td>→ · click</td><td><b>Next</b> (a swipe or a tap on a phone); <b>←</b> goes back.</td></tr>
        <tr><td>/</td><td><b>Every command</b>, type to filter.</td></tr>
        <tr><td>?</td><td><b>Every key.</b></td></tr>
        <tr><td>V</td><td><b>The voice</b>: hear the deck read aloud, when it has one.</td></tr>
        <tr><td>${GENERATE ? 'T · ⌃T' : 'T'}</td><td><b>Themes</b> with a live preview${GENERATE ? '; <b>⌃T</b> generates a new one' : ''}.</td></tr>
      </table>
      <div class="wel-foot">
        <span><b>?</b> for every key, <b>/</b> for every command, any other key to start.</span>
        <button type="button" class="wel-go">Got it</button>
      </div>
    </div>`;
    // Dismissing must not also advance: a bare click on the deck is "next", so
    // the overlay swallows its own clicks on the way up. The backdrop closes
    // it, and so does the card itself — every part of a card that says "press
    // any key" should answer a click too.
    markDialog(cardEl);
    cardEl.addEventListener('click', (e) => { e.stopPropagation(); dismissWelcome(); });
    closeOnBackdrop(cardEl, dismissWelcome);
    root.appendChild(cardEl);
    debugLog?.('nav', 'welcome shown');
  }

  // ----- the editing tour: write mode's own first run ------------------------
  // The welcome explains presenting and says write mode exists; the first
  // load that IS write mode gets a card of its own, the four gestures and
  // the keys that matter when the file is yours to change. Once per browser,
  // never on top of the welcome (one card a load), and never where no author
  // server answers: the tour is about what this deck can do, not what some
  // other deck could.
  let tourEl = null;
  function dismissEditingTour() {
    if (!tourEl) return;
    tourEl.remove();
    tourEl = null;
    write(TOUR_SEEN_KEY, '1');
    // the tour says where / and ? are too: an author is not welcomed again later
    write(SEEN_KEY, '1');
    debugLog?.('nav', 'editing tour dismissed');
  }
  function showEditingTour() {
    if (tourEl || cardEl || printMode) return;
    tourEl = document.createElement('div');
    tourEl.className = 'decklight-welcome wel-tour';
    tourEl.innerHTML = `<div class="wel-card">
      <h3>Editing this deck</h3>
      <p class="wel-lead">This deck is open in write mode (<code>decklight &lt;deck.html&gt;</code>): what you change here is written to the file, snapshotted, and taken back with <b>${UNDO_CHORD}</b>.</p>
      <table>
        <tr><td>double-click</td><td><b>Edit any text</b> in place; <b>⌘B</b>, <b>⌘I</b>, <b>⌘E</b> emphasise a selection and <b>⌘K</b> links it; in a list <b>⏎</b> starts the next point, <b>⇥</b> nests it, <b>⌃⇧↑ ↓</b> moves it; <b>⌘⏎</b> keeps, <b>Esc</b> gives it up.</td></tr>
        <tr><td>bar</td><td><b>Editing</b> is on: the bar names every door, <b>Add</b> puts a heading, a list, a table, a chart or a diagram on the slide; a click selects an element, <b>⌃⇧↑ ↓</b> moves it, <b>⌘D</b> duplicates it, <b>⌫</b> removes it, a right-click has the rest, <b>Open in your editor</b> among it, at that line of the file; <b>Lock</b> turns changes off.</td></tr>
        <tr><td>drag</td><td><b>Drop a picture</b> onto the slide and drag its corners to size it; in a diagram drag a shape to move it, and from a dot on its side to another shape to <b>connect</b> them.</td></tr>
        <tr><td>S · O</td><td><b>S</b> opens the notes drawer, which saves itself; <b>O</b> is the overview, where slides are dragged, added and deleted.</td></tr>
        <tr><td>A</td><td><b>Describe a change</b> and an AI agent makes it; ${UNDO_CHORD} takes it back too.</td></tr>
        <tr><td>K · /</td><td><b>K</b> commits what changed (the chip at the corner keeps count); <b>/</b> lists everything else.</td></tr>
      </table>
      <div class="wel-foot">
        <span><b>?</b> for every key, <b>/</b> for every command (Editing tour reopens this), any other key to start.</span>
        <button type="button" class="wel-go">Got it</button>
      </div>
    </div>`;
    markDialog(tourEl);
    tourEl.addEventListener('click', (e) => { e.stopPropagation(); dismissEditingTour(); });
    closeOnBackdrop(tourEl, dismissEditingTour);
    root.appendChild(tourEl);
    debugLog?.('nav', 'editing tour shown');
  }
  /**
   * The write-mode load's teaching moment, once the edit server has
   * answered: the tour, the first time, on the deck's first slide, and not
   * over a welcome that is already up. Nothing on a load that teaches nobody.
   */
  /** Both cards, for the advance that retires whichever is up. */
  function dismissCards() { dismissWelcome(); dismissEditingTour(); }
  // The author comes FIRST (PRESENTING): the welcome is about watching a
  // deck and told the author to run the command they had just run, while the
  // tour, the one card about their deck, waited for a second visit. So on a
  // write-mode load the tour takes the welcome's place, even after the welcome
  // went up while the edit server was still being asked.
  function startEditingTour(target) {
    if (quiet || tourEl) return;
    if (target.slide !== 1 || target.step !== 0) return;
    if (read(TOUR_SEEN_KEY) === '1') return;
    if (cardEl) {
      cardEl.remove();
      cardEl = null;
      debugLog?.('nav', 'welcome makes way for the editing tour');
    }
    showEditingTour();
  }
  // ? and / on either card do what they say on it: the card goes, and help or
  // the palette opens. Any other key only clears the card (below).
  const cardKey = (dismiss) => (e) => {
    dismiss();
    if (e?.key === '?') openHelp();
    else if (e?.key === '/') openPalette();
    return true;
  };
  overlays.register({
    isOpen: () => !!tourEl,
    close: dismissEditingTour,
    keydown: cardKey(dismissEditingTour),
  });

  // The card owns the keyboard while it is up, and spends it on one job: the
  // first key clears the card and does NOTHING else. A newcomer reaching for →
  // dismisses, then advances on the next press — no surprise navigation out
  // from under a card they were still reading.
  overlays.register({
    isOpen: () => !!cardEl,
    close: dismissWelcome,
    keydown: cardKey(dismissWelcome),
  });

  /**
   * The first-run welcome, when it is due.
   *
   * `target` is where the hash actually sent the deck: anything past the first
   * build of the first slide is somebody presenting from a link, and a card
   * over their opening slide is the failure this whole module is written to
   * avoid.
   */
  function start(target) {
    if (quiet) return;
    // Any real advance retires the card for good — a touch swipe, the
    // on-screen chevrons and a programmatic next() all land on these events,
    // so it cannot survive into a talk that has already started. Armed here,
    // after the deck's opening goto has already fired its own pair.
    deck().on('slide', dismissCards);
    deck().on('build', dismissCards);
    if (target.slide !== 1 || target.step !== 0) return;
    if (read(SEEN_KEY) !== '1') showWelcome();
  }

  return {
    start,
    startEditingTour,
    showWelcome,
    dismissWelcome,
    showEditingTour,
    dismissEditingTour,
  };
}
