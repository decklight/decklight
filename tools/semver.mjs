// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Semantic Versioning, as decklight reads it (SPEC UNIT_VERSIONS): the pattern
// a catalog entry's or a design system's `version` must match, and precedence
// between two of them. Pure and dependency-free, so a module the runtime may
// one day bundle can share it with the CLI.

/** Semantic Versioning 2.0.0, exactly — no leading `v`, no two-part `1.1`. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Semver precedence: < 0 when `a` is older than `b`, 0 when equal, > 0 when
 * newer. Build metadata is ignored; a prerelease sorts before its release,
 * its dot-separated identifiers compared numerically where both are numbers.
 * Null when either is not semver.
 */
export function semverCompare(a, b) {
  const pa = SEMVER_RE.exec(String(a ?? ''));
  const pb = SEMVER_RE.exec(String(b ?? ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  const ra = pa[4], rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;    // 1.0.0 > 1.0.0-rc.1
  if (rb === undefined) return -1;
  const xa = ra.split('.'), xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return Math.sign(d); }
    else if (na !== nb) return na ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}
