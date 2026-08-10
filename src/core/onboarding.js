// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Teaching the product, on the two occasions a deck can afford it: the very
// first one, and every quiet one after.
//
// A newcomer opens a deck and sees a slide. The three things they cannot guess
// are the three things that make Decklight — the deck is one HTML file an agent
// can author, `/` is the way into everything, and author mode turns the player
// into an editor. So the FIRST load a browser ever gives us gets a card that
// says exactly that (WELCOME), and every load after it gets at most one line
// through the message facility (TIPS) until the deck has taught its shortcuts
// and then goes quiet forever.
//
// The two never share a load. A welcome that has just explained `/` should not
// be followed by a toast explaining `/`, and a load that shows the card is by
// definition the load with the most to read already on screen.
//
// Both flags are GLOBAL — `decklight-onboarded`, `decklight-tips*` — not
// path-scoped like theme/font/clock. Those remember what a DECK should look
// like; these remember what a PERSON has already been told, and being told
// twice by a second deck is the whole thing they exist to prevent. Same
// reasoning as `decklight-custom-themes`.
//
// Nothing here may ever appear over a live audience: no card and no tip in
// `?print` or `?embedded`, none when the URL deep-links past the first build of
// the first slide (a link into the middle of a talk is not a first run), and
// the first advance — key, click, swipe, chevron or a programmatic next() —
// retires the card for good.

import { closeOnBackdrop } from './overlay.js';

/**
 * The tips, most basic first. Order IS the curriculum: a reader who opens ten
 * decks gets `/` before `T`, and the palette makes every later tip findable
 * without being told. Each id is the persisted seen-token, so ids are permanent
 * — renaming one re-teaches a tip somebody already read.
 */
export const TIPS = [
  { id: 'palette', text: 'press / for the command palette — every command, type to filter' },
  { id: 'help', text: 'press ? for the keyboard shortcuts' },
  { id: 'goto', text: 'press G to jump to any slide by name' },
  { id: 'theme', text: 'press T to browse themes — the deck restyles live' },
  { id: 'overview', text: 'press O for the slide overview grid' },
  { id: 'speaker', text: 'press S for speaker view — notes, next slide and a timer' },
  { id: 'narrate', text: 'press V to have the deck narrate itself from its speaker notes' },
  { id: 'messages', text: 'press ` (left of 1) for the message log — every message the deck has shown' },
  { id: 'fullscreen', text: 'press F for fullscreen, B to black out the screen mid-talk' },
  { id: 'author', text: 'author mode (decklight author <deck.html>) turns this player into an editor — A asks an AI agent' },
];

const SEEN_KEY = 'decklight-onboarded';   // the welcome card, once per browser
const TIPS_SEEN_KEY = 'decklight-tips-seen';
const TIPS_OFF_KEY = 'decklight-tips-off';

// Storage is advisory here, never load-bearing: `file://` and private mode both
// throw, and a deck that cannot remember what it has taught must still play.
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* file:// or private mode */ }
}

/**
 * Wire the first-run welcome and the tip rotation to a deck.
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
export function createOnboarding({ root, printMode, params, toast, debugLog, overlays, deck }) {
  const embedded = params.has('embedded');
  const quiet = printMode || embedded;   // a preview and a printout teach nobody

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
    cardEl.innerHTML = `<div class="wel-card">
      <h3>Welcome to Decklight</h3>
      <p class="wel-lead">This deck is a single HTML file — no build step, authored by you or an AI agent, and provable by a headless render.</p>
      <table>
        <tr><td>/</td><td><b>Command palette</b> — every command, type to filter. Start here.</td></tr>
        <tr><td>?</td><td>All keyboard shortcuts.</td></tr>
        <tr><td>T · ⌃T</td><td>Browse themes with a live preview; <b>⌃T</b> generates a brand-new one.</td></tr>
        <tr><td>S · V</td><td>Speaker view with notes &amp; timer; <b>V</b> narrates the deck aloud.</td></tr>
        <tr><td>A · E · Z</td><td><b>Author mode</b> (<code>decklight author &lt;deck.html&gt;</code>): live-reload editing — ask an AI agent to change the deck, edit an element, undo.</td></tr>
      </table>
      <div class="wel-foot">
        <span>Press any key to dismiss — reopen anytime from the <code>/</code> palette.</span>
        <button type="button" class="wel-go">Got it</button>
      </div>
    </div>`;
    // Dismissing must not also advance: a bare click on the deck is "next", so
    // the overlay swallows its own clicks on the way up. The backdrop closes
    // it, and so does the card itself — every part of a card that says "press
    // any key" should answer a click too.
    cardEl.addEventListener('click', (e) => { e.stopPropagation(); dismissWelcome(); });
    closeOnBackdrop(cardEl, dismissWelcome);
    root.appendChild(cardEl);
    debugLog?.('nav', 'welcome shown');
  }

  // The card owns the keyboard while it is up, and spends it on one job: the
  // first key clears the card and does NOTHING else. A newcomer reaching for →
  // dismisses, then advances on the next press — no surprise navigation out
  // from under a card they were still reading.
  overlays.register({
    isOpen: () => !!cardEl,
    close: dismissWelcome,
    keydown: () => (dismissWelcome(), true),
  });

  // ----- the tips ----------------------------------------------------------
  function tipsEnabled() { return read(TIPS_OFF_KEY) !== '1'; }

  function seenTips() {
    try {
      const raw = JSON.parse(read(TIPS_SEEN_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch { return new Set(); }   // hand-edited or truncated: start over
  }

  /** The next tip this browser has not read, or null once they are all read. */
  function nextTip() {
    const seen = seenTips();
    return TIPS.find((t) => !seen.has(t.id)) || null;
  }

  function showTip() {
    const tip = nextTip();
    if (!tip) return null;   // every tip read: silence, not a "no more tips"
    const seen = seenTips();
    seen.add(tip.id);
    write(TIPS_SEEN_KEY, JSON.stringify([...seen]));
    toast(`tip · ${tip.text}`, 5200);   // longer than a status toast: this one is read, not glanced at
    return tip.id;
  }

  function setTips(on) {
    write(TIPS_OFF_KEY, on ? '0' : '1');
    toast(on ? 'tips on — one per deck you open' : 'tips off');
  }

  function resetTips() {
    write(TIPS_SEEN_KEY, '[]');
    toast(`tips reset — all ${TIPS.length} will show again, one per deck`);
  }

  /**
   * The load's one teaching moment, spent on whichever of the two is due.
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
    deck().on('slide', dismissWelcome);
    deck().on('build', dismissWelcome);
    if (target.slide !== 1 || target.step !== 0) return;
    if (read(SEEN_KEY) !== '1') { showWelcome(); return; }
    if (tipsEnabled()) showTip();
  }

  return {
    start,
    showWelcome,
    dismissWelcome,
    showTip,
    setTips,
    resetTips,
    /** Palette labels ask what is currently on, and what is left to teach. */
    status: () => ({ tipsOn: tipsEnabled(), tipsLeft: nextTip() ? TIPS.length - seenTips().size : 0 }),
  };
}
