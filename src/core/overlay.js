// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The mechanics every overlay in the engine repeats: dismiss on a backdrop
// click, move a wrap-around selection through a list of rows, and take the
// keyboard while you are up. Nine overlays wired the first by hand and five the
// second; this is the shared core so the next one is a call, not a copy.
//
// Each overlay still writes its OWN key handling — the registry below only
// routes: it knows which overlay is up and hands it the key first. That is what
// lets a feature move to its own module and take its shortcuts with it, instead
// of leaving a branch behind in a keydown handler that knows about everything.

/**
 * Dismiss an overlay when its BACKDROP is clicked — the overlay element itself,
 * `e.target === el`, never a click that bubbled up from a row or control inside
 * it.
 */
export function closeOnBackdrop(el, onClose) {
  el.addEventListener('click', (e) => { if (e.target === el) onClose(); });
}

/**
 * Move a wrap-around selection to row `i` (negative or past-the-end wraps),
 * marking it with `selClass` and scrolling it into view. Returns the resolved
 * index so the caller can store it. `scroll: false` for a list that shouldn't
 * chase the selection. Assumes `rows` is non-empty — callers guard on their own
 * entry list first, exactly as before.
 */
export function selectInList(rows, i, selClass, { scroll = true } = {}) {
  const sel = (i + rows.length) % rows.length;
  rows.forEach((r, j) => r.classList.toggle(selClass, j === sel));
  if (scroll) rows[sel]?.scrollIntoView({ block: 'nearest' });
  return sel;
}

/**
 * The keyboard every typeahead list in the deck has: ↑/↓ to move, Enter to
 * commit, Escape to clear the query and then to close, and printable
 * characters appending to it.
 *
 * The palette, the slide finder and the font picker each wrote this out, and
 * the interesting rule is the one easiest to get subtly different between
 * copies: Escape with a query CLEARS it, and only closes on the second press.
 * Someone who typed four characters into the wrong list wants those four
 * characters gone, not the list gone — and once it is gone they press Escape
 * again without thinking about it.
 *
 * A list with no query (the font picker) leaves `onType`/`onBackspace` out and
 * gets the movement half; a printable key then falls through as unconsumed.
 *
 * Returns true when the key was consumed, matching the overlay contract.
 */
export function typeaheadKeydown(e, { query = '', onMove, onCommit, onType, onBackspace, onClear, onClose }) {
  switch (e.key) {
    case 'ArrowDown': onMove?.(1); return true;
    case 'ArrowUp': onMove?.(-1); return true;
    case 'Enter': onCommit?.(); return true;
    case 'Backspace':
      if (!onBackspace) return false;
      onBackspace();
      return true;
    case 'Escape':
      if (query && onClear) onClear();
      else onClose?.();
      return true;
    default:
      if (e.key.length === 1 && onType) { onType(e.key); return true; }
      return false;
  }
}

/**
 * The registry the deck's keydown handler consults before its own table.
 *
 * Register in PRIORITY ORDER: when overlays somehow overlap, the one
 * registered first is the one the keyboard belongs to.
 *
 * An overlay is `{ isOpen(), close(), keydown(e), modal?, transient? }`.
 * `keydown` returns whether it consumed the key — true means the deck calls
 * preventDefault, false means the key is dropped. By default an overlay that is
 * up owns the keyboard whether or not it wanted this particular key, which is
 * what stops `o` from opening the overview behind an open dialog. An overlay
 * that sets `modal: false` instead lets the keys it did not consume fall
 * through to the deck's own shortcuts — for a panel meant to sit BESIDE the
 * slide (the docked review) rather than over it, so navigation still works
 * while it is open.
 *
 * `transient: true` marks a PICKER — the palette, the finder, the theme and
 * template pickers, the history list, a context menu: a list you choose from
 * and that has no business sitting under whatever opens next. `opening()` is
 * what a dialog calls as it opens, and it clears exactly those. It never
 * touches a typing surface (the notes editor, a compose card, the commit
 * window), because ⌘K reaches the commit window from inside the editor, and
 * the sentence in the editor has to still be there when the commit is done.
 * Four modules used to be handed their own `dismissOthers` closure by the
 * engine, each naming a different subset of the pickers by hand.
 */
export function createOverlays() {
  const entries = [];
  return {
    register(entry) { entries.push(entry); return entry; },
    /** The overlay that currently owns the keyboard, if any. */
    active: () => entries.find((o) => o.isOpen()),
    /** An overlay is opening: take every open picker (but `keep`) off the stage. */
    opening(keep = null) {
      for (const o of entries) if (o !== keep && o.transient && o.isOpen()) o.close();
    },
  };
}
