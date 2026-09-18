// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Decklight entry point. Bundled by esbuild as an IIFE with globalName
// "Decklight" — the module namespace becomes the public API (SPEC JS_API).
//
// Terminal subsystem contract: src/terminal/player.mjs, when present, exports
// `registerTerminals(Decklight, root)` — async (casts are fetched); providers
// registered after init are picked up by the engine's late-registration
// rescan. The build resolves 'virtual:terminal' to it (or to a stub when
// absent) so the core builds and runs before/without the terminal subsystem.

import { init as engineInit, registerBuildProvider } from './core/engine.js';
import * as terminal from 'virtual:terminal';

// The runtime's version, and it must equal package.json's — build.mjs refuses
// to build otherwise. It is a literal rather than a read of package.json
// because this file is browser code with no filesystem, and the build stamps
// it into the banner (`/*! Decklight vX.Y.Z`) that every tool reads back out of
// a bundled deck. A release bumps both, and the build is what makes sure of it.
export const version = '0.8.1';
export { registerBuildProvider };

/**
 * The terminal subsystem's entry point, or null when there is not one.
 *
 * The contract above is a NAMED export, and both things `virtual:terminal` can
 * resolve to honour it: player.mjs exports `registerTerminals` as a function,
 * and the stub the build substitutes when src/terminal/ is absent exports it as
 * `null`. Neither has a default export — so a `|| terminal.default?.…` fallback,
 * which used to be here twice, could never have produced a function. esbuild
 * said so on every build: "Import 'default' will always be undefined".
 */
const terminalRegistrar = () =>
  (typeof terminal.registerTerminals === 'function' ? terminal.registerTerminals : null);

/**
 * The deck's configuration block (SPEC DECK_ANATOMY): one
 * `<script type="application/json" data-decklight-config>` holding what
 * `init` takes, as data. `decklight` (the version the deck was written for) is
 * the file's key, not an option. `theme` is both: the server links it into a
 * deck that has no theme of its own, and the runtime opens on it — among a
 * deck's inline theme blocks, it is the one selected when nothing else (a
 * `?theme=`, a saved pick) says otherwise (#547).
 * Null when the deck has no block; a block that is not JSON is reported and
 * treated as empty rather than silently booting nothing.
 */
export function deckConfig() {
  const el = document.querySelector('script[type="application/json"][data-decklight-config]');
  if (!el) return null;
  try {
    const { decklight: _version, theme, ...config } = JSON.parse(el.textContent);
    return typeof theme === 'string' && /^[\w-]+$/.test(theme) ? { ...config, theme } : config;
  } catch (err) {
    console.error('Decklight: the data-decklight-config block is not valid JSON — booting with defaults', err);
    return {};
  }
}

/**
 * Boot the deck. With no argument the options come from the configuration
 * block, which is how a deck that is only data boots; an argument is the JS
 * API's escape hatch for a deck that scripts against the engine.
 */
export function init(config) {
  const instance = engineInit(config ?? deckConfig() ?? {});
  const register = terminalRegistrar();
  if (register) {
    Promise.resolve(register({ registerBuildProvider }, document))
      .catch((err) => console.error('Decklight: terminal subsystem failed to initialize', err));
  }
  return instance;
}

/** Docs-page use (SPEC TERMINAL_PLAYER): activate .terminal elements WITHOUT a deck —
 *  play mode is fully interactive standalone; step mode renders complete. */
export function initTerminals(root = document) {
  const register = terminalRegistrar();
  return register
    ? Promise.resolve(register({ registerBuildProvider }, root))
    : Promise.resolve();
}

// A deck that calls no `init` boots itself once the document is parsed — a
// deck as data (#520) is slides and a configuration block, and the server that
// linked this engine into it is not going to add a boot call too. Guarded
// three ways so a deck that DOES boot itself is never booted twice: the
// engine's own re-init guard (`root.__decklight`), the block — a deck with one
// never calls init — and, absent a block, any inline script that names
// `Decklight.init`, which is the deck saying it will do it. That last is a
// heuristic over the document's own text; a deck booting from an external
// script is the one shape it cannot see, and that deck's late `init` is
// answered with the running instance and a console warning.
function autoBoot() {
  const root = document.querySelector('.decklight');
  if (!root || root.__decklight) return;
  const hasBlock = !!document.querySelector('script[type="application/json"][data-decklight-config]');
  if (!hasBlock && [...document.scripts].some((s) => !s.src && /Decklight\s*\.\s*init\s*\(/.test(s.textContent))) return;
  try { init(); } catch (err) { console.error('Decklight: the deck did not boot', err); }
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBoot);
  else autoBoot();
}
