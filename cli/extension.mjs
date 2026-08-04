#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight extension` — the marketplace admission gate for build-time code
 * (MARKETPLACE.md `EXTENSIONS#CHECK`, SPEC `EXTENSIONS_CHECK`).
 *
 *   decklight extension check <file> [--type transform]
 *
 * Validates a bare source FILE, not an installed, catalog-backed unit —
 * `bundle`, `import` and `publish` run an already-installed transform and
 * never re-check it (`EXTENSIONS#LOADER` already settled that). This is what
 * a marketplace repo's own CI runs on every PR that adds or updates a
 * `transform` entry; a failing check blocks that PR from merging — the
 * extension's admission to a catalog, never `decklight publish`ing a deck.
 *
 * Named `extension`, not `transform`: `decklight plugin check` already gates
 * presenter-library plugins (a different risk — a stranger's code on the
 * presenter's own machine). This is the gate for build-time code
 * specifically, and `--type` leaves room for `EXTENSIONS#ADAPTEREXEC`'s
 * import adapters later, once their own calling convention is frozen.
 */

import { existsSync } from 'node:fs';
import { isMain, argReader } from '../tools/args.mjs';
import { checkExtension, TYPES } from '../tools/extension-check.mjs';

const USAGE = `usage: decklight extension check <file> [--type transform]

  decklight extension check <file>
    lints the source — refuses fetch(), eval(), XMLHttpRequest or a dynamic
    import() anywhere in it — then runs it against a small fixture and
    headlessly loads the OUTPUT, refusing any <script> block in it. Exits
    non-zero on a refusal, so a marketplace's own CI can gate admission on it.
    On a pass it prints the file's sha256 — the pin the catalog entry carries,
    which installs are held to (SPEC UNIT_PINNING)
    EXAMPLE: decklight extension check grammar-check.mjs

  --type transform   what kind of extension this is (default, and in v1 the
                     only kind implemented — EXTENSIONS#ADAPTEREXEC will add
                     "importer" once import adapters have their own contract)

  This is not part of bundle, import or publish — those run an
  already-installed unit and never re-check it (EXTENSIONS#LOADER). It is
  the gate a marketplace's own CI runs before admitting an entry to a
  catalog: "failure blocks publish" means blocking that admission, not
  decklight's own publish command.

  The lint is not a friendlier echo of a runtime failure the way
  \`decklight plugin check\`'s is — a transform runs as trusted, unsandboxed
  Node, so nothing else stops fetch or eval from working; this lint is the
  enforcement. Needs a real Chrome to run the headless phase, the same way
  \`npm run verify\`'s render harnesses do.`;

/** The validation report, as the lines to print. */
export function reportLines(name, result) {
  if (result.ok) {
    return [`✔ ${name} — lints clean, output carries no <script>`,
      // The pin the entry carries once admitted (SPEC UNIT_PINNING):
      // `transform add` refuses to install without it, or past a mismatch.
      `  sha256: ${result.sha256} — the catalog entry pins the file to this digest`];
  }
  if (result.phase === 'lint') {
    return [`✘ ${name}`, ...result.lint.map((l) => `    line ${l.line}: ${l.why}\n      ${l.text}`)];
  }
  return [`✘ ${name}`, `    ${result.error}`];
}

async function checkMain(args) {
  const { opt } = argReader(args);
  const [file] = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--type');
  if (!file) { console.error(`decklight extension check: needs a file\n\n${USAGE}`); return 1; }
  if (!existsSync(file)) { console.error(`decklight extension check: no such file: ${file}`); return 1; }

  const type = opt('--type') ?? 'transform';
  if (!TYPES.includes(type)) {
    console.error(`decklight extension check: --type ${type} is not implemented`
      + ` — this decklight only checks: ${TYPES.join(', ')}`);
    return 1;
  }

  const result = await checkExtension(file, { type });
  for (const line of reportLines(file, result)) console.log(line);
  return result.ok ? 0 : 1;
}

export async function extensionMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  if (sub === 'check') return checkMain(rest);
  console.error(`decklight extension: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await extensionMain(process.argv.slice(2)));
