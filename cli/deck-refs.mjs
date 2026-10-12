// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a deck can REFERENCE from a marketplace, as one table.
 *
 * A theme, a design system and a font are each named in the deck's
 * configuration block and served into it, never copied (SPEC
 * THEME_DISTRIBUTION, DESIGN_SYSTEMS, FONTS). Each kind keeps its own module
 * for what is different about it (theme-refs.mjs, design-system-refs.mjs,
 * font-refs.mjs: how a reference resolves, what a package holds). What is the
 * SAME was written three times, once at each place a deck is served: the
 * chain of three link calls (the deck server, the edit server's audited deck,
 * a history preview) and the three asset lookups in the static file server.
 * A fourth kind would have been a fourth edit in each (ROADMAP section 4).
 * This table is that wiring, written once, like UNIT_TYPES is for the units.
 *
 * ORDER IS THE CHAIN: themes, then design systems, then fonts, the order the
 * three calls were nested in, so the served bytes are unchanged.
 *
 * `namespace` says whose URLs a kind owns. A design system's and a font's
 * files live under their own prefix, TERMINAL: answered from the package or a
 * plain 404, never from the deck's directory. A referenced theme has no
 * prefix of its own and is the FALLBACK for a path the deck's directory does
 * not have.
 */

import { linkAddedThemes, themeRefAsset } from './theme-refs.mjs';
import { linkDesignSystems, designSystemAsset, inDesignSystemNamespace } from './design-system-refs.mjs';
import { linkFonts, fontAsset, inFontNamespace } from './font-refs.mjs';

export const REFERENCE_KINDS = [
  { kind: 'theme', link: linkAddedThemes, asset: themeRefAsset, namespace: null },
  { kind: 'design-system', link: linkDesignSystems, asset: designSystemAsset, namespace: inDesignSystemNamespace },
  { kind: 'font', link: linkFonts, asset: fontAsset, namespace: inFontNamespace },
];

/** Every reference kind linked into a served page, in the chain's order. */
export function linkReferences(html, kinds = REFERENCE_KINDS) {
  return kinds.reduce((out, k) => k.link(out), html);
}

/**
 * The kind whose namespace a path is in, or null: such a path is that kind's
 * alone (terminal), and the static server answers it from the package or 404s.
 */
export function namespacedKind(rel, kinds = REFERENCE_KINDS) {
  return kinds.find((k) => k.namespace?.(rel)) ?? null;
}

/** The fallback kinds' asset for a path the deck's directory lacks, or null. */
export function fallbackReferenceAsset(rel, kinds = REFERENCE_KINDS) {
  for (const k of kinds) {
    if (k.namespace) continue;
    const asset = k.asset(rel);
    if (asset) return asset;
  }
  return null;
}
