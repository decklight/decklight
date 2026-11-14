// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The undo chord, spelled the way this machine spells it.
//
// Bare Z used to undo a deck edit, and every "takes it back" message named
// it. A stray Z while presenting changed the file, so the deck now undoes on
// ⌘Z / Ctrl+Z only (ROADMAP, section 2), and the messages name the chord. One
// module so a toast in concepts.js and the edit bar cannot spell it apart.

/**
 * Is this platform string an Apple one? Case-insensitive, because the two
 * sources spell it differently: `navigator.platform` says `MacIntel`, and
 * Chrome's `navigator.userAgentData.platform`, read first, says `macOS`. The
 * old test was `/Mac|iPhone|iPad/`, which `macOS` fails, so Chrome on a Mac
 * was taken for Windows: undo wanted Ctrl+Z, ⌘Z did nothing, and every hint
 * said Ctrl.
 */
export const isApplePlatform = (platform) => /mac|iphone|ipad/i.test(String(platform ?? ''));

export const IS_MAC = typeof navigator !== 'undefined'
  && isApplePlatform(navigator.userAgentData?.platform ?? navigator.platform);
export const UNDO_CHORD = IS_MAC ? '⌘Z' : 'Ctrl+Z';
export const REDO_CHORD = IS_MAC ? '⌘⇧Z' : 'Ctrl+⇧Z';
/** Duplicate the selection (PRESENTING_EDITING): the browser's bookmark chord, taken in write mode with something selected, as Keynote and Slides do. */
export const DUPLICATE_CHORD = IS_MAC ? '⌘D' : 'Ctrl+D';
/** Group and Ungroup a diagram's shapes (SVG_DIAGRAMS): the chords Keynote, Slides and PowerPoint use. */
export const GROUP_CHORD = IS_MAC ? '⌘G' : 'Ctrl+G';
export const UNGROUP_CHORD = IS_MAC ? '⇧⌘G' : 'Ctrl+Shift+G';

/**
 * What the page says for an undo or redo, from what the server said the step
 * was (`{ what, slide }`): "Undid: notes on slide 7". A server too old to say
 * gets the plain words.
 */
export function undoSaid(dir, meta) {
  const verb = dir === 'redo' ? 'Redid' : 'Undid';
  if (!meta?.what) return `${verb} the last edit`;
  return `${verb}: ${meta.what}${Number.isInteger(meta.slide) ? ` on slide ${meta.slide}` : ''}`;
}
