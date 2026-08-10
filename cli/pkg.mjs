// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where the installed package is, and the one way its build artifacts become
// deck bytes.
//
// WHY THIS IS ONE MODULE AND NOT FIVE CONSTANTS. Four commands write a deck
// that carries the runtime inline — `init` scaffolds one, `import` converts
// one, `upgrade` refreshes one, `bundle` inlines a referenced one — and
// `audit` recomputes what they SHOULD have produced, so that `present` can
// say whether the runtime in a file is this install's build (PRESENT#AUDIT).
// That makes the inlining transform a contract between five files, and it was
// copied into each of them. `import` copied it slightly wrong: its local
// escape covered `</script` and `</style` but not `<!--`, so an imported deck
// audited as
//
//     runtime 0.3.0 — DIFFERS from this install's build of 0.3.0
//
// which is the label's alarm, raised on a deck decklight had just written
// itself. The transform lives here now, and the auditor's model of it is the
// same function the producers call, so the two cannot drift again.
//
// The package root is `fileURLToPath`, never a URL `.pathname` — see the
// sweep test in test/cli.test.mjs for what that costs (#275).
//
// ONE ROOT STAYS OUTSIDE THIS FILE ON PURPOSE. tools/extension-check.mjs
// keeps its own, because tools/ does not import from cli/ — it ships so that
// a marketplace's own CI can run the admission gate from the installed
// package, and a dependency pointing the wrong way up the layering would
// drag the whole command surface into that runtime. Two definitions is the
// price of that direction; it is not an oversight to tidy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptSafe } from './util.mjs';

/** The installed package's root — the directory holding dist/, themes/, SPEC.md. */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** package.json, parsed once. `PKG.version` is the version every command prints. */
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

/** The shipped theme set — the graded and compat themes that stay in core. */
export const THEMES_DIR = path.join(PKG_ROOT, 'themes');

/** One shipped theme's CSS. Throws ENOENT for a name that is not shipped. */
export const themeCss = (name) => fs.readFileSync(path.join(THEMES_DIR, `${name}.css`), 'utf8');

/**
 * Turn runtime JavaScript into the exact text that goes inside a deck's
 * `<script>` — the sourceMappingURL comment dropped (it points at a .map that
 * does not travel), then `scriptSafe` (whose docblock in util.mjs carries the
 * reasoning for both sequences it rewrites).
 *
 * Callers that already hold the text — `bundle`, inlining whatever a deck's
 * own `<script src>` pointed at — pass it in; the rest read the installed
 * build through `runtimeJs()`.
 */
export const inlineRuntime = (js) => scriptSafe(js.replace(/\/\/# sourceMappingURL=.*$/m, ''));

/** The installed runtime, ready to inline. Null when dist/ has not been built. */
export function runtimeJs() {
  const file = path.join(PKG_ROOT, 'dist/decklight.js');
  return fs.existsSync(file) ? inlineRuntime(fs.readFileSync(file, 'utf8')) : null;
}

/** The installed runtime stylesheet. */
export const runtimeCss = () => fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.css'), 'utf8');
