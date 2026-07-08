// Decklight entry point. Bundled by esbuild as an IIFE with globalName
// "Decklight" — the module namespace becomes the public API (SPEC §9).
//
// Terminal subsystem contract: src/terminal/player.mjs, when present, exports
// `registerTerminals(Decklight, root)` — async (casts are fetched); providers
// registered after init are picked up by the engine's late-registration
// rescan. The build resolves 'virtual:terminal' to it (or to a stub when
// absent) so the core builds and runs before/without the terminal subsystem.

import { init as engineInit, registerBuildProvider } from './core/engine.js';
import * as terminal from 'virtual:terminal';

export const version = '0.1.0';
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
