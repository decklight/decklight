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
export const version = '0.6.0';
export { registerBuildProvider };

export function init(config = {}) {
  const instance = engineInit(config);
  const register = terminal.registerTerminals || terminal.default?.registerTerminals;
  if (typeof register === 'function') {
    Promise.resolve(register({ registerBuildProvider }, document))
      .catch((err) => console.error('Decklight: terminal subsystem failed to initialize', err));
  }
  return instance;
}

/** Docs-page use (SPEC TERMINAL_PLAYER): activate .terminal elements WITHOUT a deck —
 *  play mode is fully interactive standalone; step mode renders complete. */
export function initTerminals(root = document) {
  const register = terminal.registerTerminals || terminal.default?.registerTerminals;
  return typeof register === 'function'
    ? Promise.resolve(register({ registerBuildProvider }, root))
    : Promise.resolve();
}
