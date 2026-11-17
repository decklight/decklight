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
 * A step marked `with` (`data-build-with`, and no explicit key of its own)
 * arrives on the click of the step emitted just before it: it takes that
 * step's key and joins its group, wherever the order puts it.
 *
 * `items` = [{ key, explicit, with? }] in document/emission order; returns
 * groups of item indices, one group per click.
 */
export function computeGroups(items) {
  const indexed = [];
  items.forEach((it, i) => {
    const prev = indexed[i - 1];
    indexed.push(it.with && !it.explicit && prev ? { key: prev.key, explicit: prev.explicit, i, joins: prev.joins ?? prev.i } : { ...it, i, joins: undefined });
  });
  const sorted = [...indexed].sort((a, b) => a.key - b.key || (a.joins ?? a.i) - (b.joins ?? b.i) || a.i - b.i);
  const groups = [];
  const groupOf = new Map();
  let cur = null;
  let curKey = null;
  let curExplicit = false;
  for (const it of sorted) {
    if (it.joins !== undefined && groupOf.has(it.joins)) {
      groupOf.get(it.joins).push(it.i);
      groupOf.set(it.i, groupOf.get(it.joins));
      continue;
    }
    if (cur && it.explicit && curExplicit && it.key === curKey) {
      cur.push(it.i);
      groupOf.set(it.i, cur);
      continue;
    }
    cur = [it.i];
    groupOf.set(it.i, cur);
    curKey = it.key;
    curExplicit = it.explicit;
    groups.push(cur);
  }
  return groups;
}

/**
 * The order item for a step: `orderAttr` explicit when present, else the auto
 * position `auto`; `withPrev` (its `data-build-with`) to arrive with the step
 * before it, when it has no explicit key.
 */
export function orderItem(orderAttr, auto, withPrev = false) {
  const explicit = orderAttr != null && orderAttr !== '';
  const key = explicit ? parseInt(orderAttr, 10) : auto;
  return { key: Number.isFinite(key) ? key : auto, explicit, ...(withPrev && !explicit ? { with: true } : {}) };
}
