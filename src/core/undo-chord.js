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
