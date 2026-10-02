// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The font picker's stacks (SPEC PRESENTING, FONTS): families every machine
// already has, by kind. Here, not in src/core/fonts.js, because the CLI names
// them too — a design system may recommend `humanist`, and `design-system
// add` applies it — and cli/ never imports from src/.

/** The stacks, in cycle order. Their ORDER is the old pref's meaning (an index) — append, never reorder. */
export const STACKS = [
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


/** The stack labels — what a deck's `font` default or a recommendation may name. */
export const STACK_LABELS = STACKS.map(([label]) => label);
