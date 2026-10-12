// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The undo chord, spelled the way this machine spells it.
//
// Bare Z used to undo a deck edit, and every "takes it back" message named
// it. A stray Z while presenting changed the file, so the deck now undoes on
// ⌘Z / Ctrl+Z only (ROADMAP, section 2), and the messages name the chord. One
// module so a toast in concepts.js and the edit bar cannot spell it apart.

export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
export const UNDO_CHORD = IS_MAC ? '⌘Z' : 'Ctrl+Z';
export const REDO_CHORD = IS_MAC ? '⌘⇧Z' : 'Ctrl+⇧Z';
