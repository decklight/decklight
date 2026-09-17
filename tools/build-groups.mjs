// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * How build steps become clicks (SPEC BUILD_SEMANTICS): every step on a slide
 * sorts by its order key — the explicit `data-build-order`, or its document
 * position — and only EXPLICIT steps sharing a key advance together.
 *
 * Pure, and here rather than in src/core/builds.js so `decklight check` can
 * count a slide's clicks from the file by the same rule the runtime applies
 * to the DOM (#526): cli/ and tools/ never import src/, which the package
 * does not ship, while src/ may import a tool.
 *
 * `items` = [{ key, explicit }] in document/emission order; returns groups of
 * item indices, one group per click.
 */
export function computeGroups(items) {
  const indexed = items.map((it, i) => ({ ...it, i }));
  indexed.sort((a, b) => a.key - b.key || a.i - b.i);
  const groups = [];
  let cur = null;
  let curKey = null;
  let curExplicit = false;
  for (const it of indexed) {
    if (cur && it.explicit && curExplicit && it.key === curKey) {
      cur.push(it.i);
      continue;
    }
    cur = [it.i];
    curKey = it.key;
    curExplicit = it.explicit;
    groups.push(cur);
  }
  return groups;
}

/** The order item for a step: `orderAttr` explicit when present, else the auto position `auto`. */
export function orderItem(orderAttr, auto) {
  const explicit = orderAttr != null && orderAttr !== '';
  const key = explicit ? parseInt(orderAttr, 10) : auto;
  return { key: Number.isFinite(key) ? key : auto, explicit };
}
