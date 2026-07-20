// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The small argv/entry-point helpers every Node script here reached for and
// re-rolled — nine byte-identical copies of `opt` alone. Lives under tools/
// because both the CLI and the tools are Node-only and the CLI already imports
// from tools/, so the dependency only ever flows one way.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A reader over one argv array. Keeps the familiar call shape so a site swaps
 * its hand-rolled one-liner for `const { opt } = argReader(args)` and every
 * `opt('--flag', dflt)` below it stays exactly as written.
 *
 *   opt('--flag', dflt) → the token after the first --flag, or dflt
 *   opts('--flag')      → the token after every --flag (a repeatable flag)
 */
export function argReader(argv) {
  const opt = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
  const opts = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  return { opt, opts };
}

/**
 * True when this module file was run directly (`node tools/x.mjs`), false when
 * imported. Path-resolved so it survives relative paths, symlinks and Windows —
 * the bare `import.meta.url === \`file://${process.argv[1]}\`` form does not.
 */
export const isMain = (metaUrl) =>
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
