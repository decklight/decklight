// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight library — everything installed into YOUR library, one grammar.
 *
 *   decklight library add <kind> <name[@marketplace]>
 *   decklight library remove <kind> <name>
 *   decklight library list [kind]
 *   decklight library check <kind> <path>     (the marketplace admission gate)
 *
 * It used to be seven top-level commands, one per kind (`importer`,
 * `transform`, `engine`, `voice`, `agent`, `plugin`, `extension`) plus the
 * unit half of `skills`, each with its own spelling of add, list and remove
 * (ROADMAP section 4). The implementations stay where they were: the unit
 * kinds are one function over UNIT_TYPES (units.mjs), a plugin is its own
 * module (plugin.mjs), and the transform gate is extension.mjs. This file is
 * only the grammar in front of them.
 *
 * `library` and not a bare `decklight add`: `theme add`, `font add` and
 * `design-system add` put a reference INTO A DECK, and a top-level `add` that
 * installs into the library instead would read as the same act.
 */

import { UNIT_TYPES } from './units.mjs';
import { runMain } from './util.mjs';
import { isMain } from '../tools/args.mjs';

const UNIT_KINDS = Object.keys(UNIT_TYPES);
export const KINDS = [...UNIT_KINDS, 'plugin'];
export const VERBS = ['add', 'remove', 'list', 'check'];
/** The kinds a marketplace can gate admission on before an entry is listed. */
const CHECKABLE = { plugin: 'a plugin directory, or an installed plugin\'s name', transform: 'a build-time transform\'s .mjs file' };

export const USAGE = `usage: decklight library <add|remove|list|check> <kind> …

  Your library: what this machine installs from a marketplace, into
  ~/.decklight/, for your own use. Nothing here travels inside a deck.

  decklight library add <kind> <name[@marketplace]>
    install a unit from a registered marketplace (decklight marketplace add …)
    EXAMPLE: decklight library add plugin timer
    EXAMPLE: decklight library add engine azure-tts
    EXAMPLE: decklight library add voice narrator-anna     (a reference, never a model)

  decklight library remove <kind> <name>
  decklight library list [kind]          every kind when none is named

  decklight library check <kind> <path>
    the admission gate a marketplace's CI runs before listing an entry;
    exits non-zero on a refusal
    EXAMPLE: decklight library check transform grammar-check.mjs
    EXAMPLE: decklight library check plugin plugins/timer

  kinds
    plugin     presenter chrome for your machine; every deck you open shows it
    skill      an agent skill (Markdown)
    importer   an import adapter, for a format decklight cannot read itself
    transform  build-time Node code that runs during bundle, never in a deck
    engine     a speech engine the built-in ones do not cover
    voice      a marketplace voice for the picker
    agent      a descriptor of how to run a coding agent headlessly, for A
`;

/**
 * The library form of a command typed the old way, for "did you mean":
 * `plugin add timer` → `library add plugin timer`, `extension check t.mjs` →
 * `library check transform t.mjs`, `engines` → `library list engine`.
 * Pure, so the suggestion can be tested without running anything.
 */
export function libraryForm(cmd, rest = []) {
  const word = String(cmd ?? '').toLowerCase();
  const kind = word === 'extension' ? 'transform' : word.replace(/s$/, '');
  const [verb, ...more] = rest;
  if (!KINDS.includes(kind)) return ['library', ...rest];
  if (VERBS.includes(verb)) return ['library', verb, kind, ...more];
  return ['library', 'list', kind, ...rest];
}

function refuse(msg) {
  console.error(`decklight library: ${msg}\n\n${USAGE}`);
  return 1;
}

export async function libraryMain(args = []) {
  const [verb, kind, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') { console.log(USAGE); return verb ? 0 : 1; }
  if (!VERBS.includes(verb)) return refuse(`unknown verb "${verb}" — add, remove, list or check`);
  if (args.includes('--help') || args.includes('-h')) {
    // a kind named: that kind's own usage, its examples and what uses it
    if (KINDS.includes(kind)) return kind === 'plugin' ? pluginRun(['--help']) : unitRun(kind, ['--help']);
    console.log(USAGE);
    return 0;
  }

  if (verb === 'list' && !kind) {
    let code = 0;
    for (const k of UNIT_KINDS) code = Math.max(code, await unitRun(k, ['list']) ?? 0);
    code = Math.max(code, await pluginRun(['list']) ?? 0);
    return code;
  }
  if (!kind) return refuse(`${verb} needs a kind: ${KINDS.join(', ')}`);
  if (!KINDS.includes(kind)) return refuse(`unknown kind "${kind}": ${KINDS.join(', ')}`);

  if (verb === 'check') {
    if (!CHECKABLE[kind]) return refuse(`there is no admission gate for a ${kind} — only for ${Object.keys(CHECKABLE).join(' and ')}`);
    if (kind === 'plugin') return pluginRun(['check', ...rest]);
    const { extensionMain } = await import('./extension.mjs');
    return extensionMain(['check', ...rest, '--type', 'transform']);
  }
  return kind === 'plugin' ? pluginRun([verb, ...rest]) : unitRun(kind, [verb, ...rest]);
}

async function unitRun(kind, args) {
  const { unitMain } = await import('./units.mjs');
  return unitMain(kind, args);
}

async function pluginRun(args) {
  const { pluginMain } = await import('./plugin.mjs');
  return pluginMain(args);
}

if (isMain(import.meta.url)) process.exitCode = await runMain('library', libraryMain);
