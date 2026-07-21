// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The mechanics every overlay in the engine repeats: dismiss on a backdrop
// click, and move a wrap-around selection through a list of rows. Nine overlays
// wired the first by hand and five the second; this is the shared core so the
// next one is a call, not a copy. The overlays keep their own state and their
// own key handling — only the row mechanics live here.

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
