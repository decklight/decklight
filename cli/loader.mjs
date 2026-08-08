// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The loader (MARKETPLACE.md `EXTENSIONS#LOADER`) — runs an installed
 * build-time transform against a deck's own source, an installed import
 * adapter against a source file's bytes (`EXTENSIONS#ADAPTEREXEC`), or an
 * installed speech engine's factory (`ENGINES#TTS`).
 *
 * All three are Node code, installed by `cli/units.mjs` like any other unit,
 * but running one is a different capability from installing one (SPEC
 * `EXTENSIONS_TRANSFORMS`, `EXTENSIONS_ADAPTERS`, `ENGINE_UNITS`): dynamic
 * `import()`, in the SAME process as `bundle`/`import`/the bridge — no
 * subprocess, no VM sandbox. That is not a gap; MARKETPLACE.md `EXTENSIONS`
 * already decided the trust model for build-time code (the installer is the
 * risk-bearer, same as Claude's own plugin marketplace), so isolating any of
 * them from the process that invoked it would defend against a threat this
 * design already accepted.
 *
 * The engine is the odd one of the three and is kept deliberately separate
 * below rather than folded into `runCodeModuleAt`: a transform and an adapter
 * are both `(input, opts) → string`, while an engine is a FACTORY whose
 * return value is an object the bridge then calls repeatedly. Sharing a
 * runner would have meant a `kind` flag choosing between two unrelated
 * validations, which is two functions wearing one name.
 *
 * `apiVersion` compat is a LOADER question, not an install-time one (SPEC
 * `UNIT_COMPAT`): the shape check in `marketplace.mjs` only proves the field
 * is a positive integer, never against what this decklight implements — a
 * catalog may be written against a newer contract than the one reading it.
 * Whether a given unit can actually RUN here is settled the moment it is
 * about to be, by comparing its declared `apiVersion` against that unit
 * KIND's own ceiling — `TRANSFORM_API_VERSION` for a transform,
 * `IMPORTER_API_VERSION` for an adapter, `ENGINE_API_VERSION` for an engine,
 * three separate counters because the three calling conventions move on their
 * own schedules (SPEC `EXTENSIONS_ADAPTERS`, `ENGINE_UNITS`). That number is
 * not persisted onto the installed
 * `.mjs` file — there is nowhere on a single file to put it — so it is
 * re-read from the catalog cache, exactly the way `adapterFor` re-reads an
 * importer's `extensions` rather than duplicating it into the library.
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { findUnit, catalogEntriesOfType, UNIT_TYPES } from './units.mjs';
import {
  configHome, TRANSFORM_API_VERSION, IMPORTER_API_VERSION,
  ENGINE_API_VERSION, ENGINE_CAPABILITIES,
} from './marketplace.mjs';

/** A failure with a message for a human — always names the unit, never a stack. */
export class LoaderError extends Error {}

/**
 * Find an installed unit of `type` and check its cached `apiVersion` against
 * `ceiling`, naming `type` in every refusal — the shared half of
 * `resolveTransform`/`resolveImporter`.
 *
 * `unit.path` is a single `.mjs` file for a `single`-shaped type (a
 * transform) but a DIRECTORY for a multi-`files` one (an importer, whose
 * install seam also fetches an optional `README`, say) — `UNIT_TYPES` is
 * what tells the two apart, so `path` here is always the actual module to
 * `import()`, never a directory dynamic `import()` refuses outright.
 */
function resolveCodeUnit(type, name, ceiling, home) {
  const unit = findUnit(type, name, home);
  if (!unit) {
    throw new LoaderError(`no ${type} "${name}" installed`
      + ` (decklight ${type} add ${name}, decklight ${type} list)`);
  }
  const t = UNIT_TYPES[type];
  const modulePath = t.single ? unit.path : join(unit.path, t.files[0]);
  const entry = catalogEntriesOfType(type, home).find((e) => e.name === name);
  if (entry && entry.apiVersion > ceiling) {
    throw new LoaderError(`${type} "${name}" needs apiVersion ${entry.apiVersion},`
      + ` this decklight only implements up to ${ceiling} — upgrade decklight to use it`);
  }
  return { name, path: modulePath, checked: !!entry };
}

/**
 * Find an installed transform and check what the catalog cache says about
 * its `apiVersion`. Returns `{ name, path }`; throws `LoaderError` when the
 * transform is not installed, or when a cached catalog entry names an
 * `apiVersion` this decklight does not implement.
 *
 * A transform with no matching cached catalog entry (the marketplace it came
 * from was since removed, or it was dropped into the library by hand) has no
 * `apiVersion` to check against — it is still run, since refusing an
 * explicitly-named, already-installed transform over metadata that merely
 * went missing would be a surprise this design's trust model does not ask
 * for; `runTransform` reports that in `checked` for the caller to note.
 */
export function resolveTransform(name, home = configHome()) {
  return resolveCodeUnit('transform', name, TRANSFORM_API_VERSION, home);
}

/** The same resolution as `resolveTransform`, for an installed import adapter
 *  against `IMPORTER_API_VERSION` (SPEC `EXTENSIONS_ADAPTERS`). */
export function resolveImporter(name, home = configHome()) {
  return resolveCodeUnit('importer', name, IMPORTER_API_VERSION, home);
}

/**
 * The same resolution again for an installed speech engine, against
 * `ENGINE_API_VERSION` — plus the one check the other two kinds have no
 * equivalent of: `capability`.
 *
 * A catalog may legitimately declare an engine for an affordance this
 * decklight does not run yet (`marketplace.mjs` accepts the field on shape
 * alone, deliberately), so the refusal has to happen here, where it can name
 * the single engine and what it claimed rather than invalidating the catalog
 * it arrived in. An engine with no cached entry is run unchecked, exactly as
 * a transform in that position is.
 */
export function resolveEngine(name, home = configHome()) {
  const unit = resolveCodeUnit('engine', name, ENGINE_API_VERSION, home);
  const entry = catalogEntriesOfType('engine', home).find((e) => e.name === name);
  if (entry?.capability && !ENGINE_CAPABILITIES.includes(entry.capability)) {
    throw new LoaderError(`engine "${name}" is a ${entry.capability} engine,`
      + ` and this decklight only runs: ${ENGINE_CAPABILITIES.join(', ')}`);
  }
  return unit;
}

/**
 * Run a code-carrying unit's module at a given path against `input`,
 * collapsing every failure shape into one clean, `label`-naming
 * `LoaderError` — no default export, an export that is not a function, a
 * thrown/rejected value, a non-string return, never a raw stack trace. The
 * shared half of `runTransformAt`/`runImporterAt`, since the mechanics (a
 * default-export function taking `(input, opts)` and returning a string) are
 * identical whether `input` is HTML or a source file's bytes — only the
 * vocabulary a refusal names differs.
 */
async function runCodeModuleAt(modulePath, input, label, { kind, hint }) {
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (e) {
    throw new LoaderError(`${kind} "${label}" failed to load — ${e.message}`);
  }
  if (typeof mod.default !== 'function') {
    throw new LoaderError(`${kind} "${label}" has no default export function (${hint})`);
  }
  let out;
  try {
    out = await mod.default(input, {});
  } catch (e) {
    throw new LoaderError(`${kind} "${label}" threw: ${e.message}`);
  }
  if (typeof out !== 'string') {
    throw new LoaderError(`${kind} "${label}" must return a string (returned ${typeof out})`);
  }
  return out;
}

/**
 * Run a transform module at a given path against `html` (SPEC
 * `EXTENSIONS_TRANSFORMS`). Split out from `runTransform` so
 * `tools/extension-check.mjs` can run a bare FILE the same way, without an
 * installed unit or a catalog behind it.
 */
export async function runTransformAt(modulePath, html, label) {
  return runCodeModuleAt(modulePath, html, label, {
    kind: 'transform',
    hint: 'SPEC EXTENSIONS_TRANSFORMS: export default async function transform(html, opts)',
  });
}

/** Run an import adapter module at a given path against `bytes` (SPEC
 *  `EXTENSIONS_ADAPTERS`) — the adapter half of `runTransformAt`. */
export async function runImporterAt(modulePath, bytes, label) {
  return runCodeModuleAt(modulePath, bytes, label, {
    kind: 'importer',
    hint: 'SPEC EXTENSIONS_ADAPTERS: export default async function importAdapter(bytes, opts)',
  });
}

/**
 * Run one installed transform against `html` (SPEC `EXTENSIONS_TRANSFORMS`).
 * `opts` is reserved and empty in v1 — nothing populates it yet.
 */
export async function runTransform(name, html, home = configHome()) {
  const unit = resolveTransform(name, home);
  const out = await runTransformAt(unit.path, html, name);
  return { html: out, checked: unit.checked };
}

/**
 * Run one installed import adapter against a source file's `bytes` (SPEC
 * `EXTENSIONS_ADAPTERS`) — the adapter half of `runTransform`, called from
 * `cli/import.mjs` once `sourceKind` finds no built-in reader for a file but
 * a cached catalog entry names an installed adapter for its extension.
 */
export async function runImporter(name, bytes, home = configHome()) {
  const unit = resolveImporter(name, home);
  const html = await runImporterAt(unit.path, bytes, name);
  return { html, checked: unit.checked };
}

/**
 * Load a speech-engine module at a given path and call its factory (SPEC
 * `ENGINE_UNITS`). Split from `loadEngine` the way `runTransformAt` is split
 * from `runTransform`, so a bare file can be checked without an install
 * behind it.
 *
 * Unlike a transform, what comes back is not a string but the object the
 * bridge will SPEAK with, so the shape is checked here, once, at load — the
 * alternative is a missing `synth` surfacing as a crash on the first sentence
 * of a talk. Only the fields the bridge actually requires are mandatory:
 * `name`, a `voices` array, and a callable `synth`. `stylable` defaults to
 * false because a plugin that has no delivery-instruction channel and forgets
 * to say so must not have the tone step offered for it (the picker skips it
 * on `stylable: false`, and a roster the bridge cannot pronounce is exactly
 * the silent lie SPEC `PRESENTING` refuses).
 */
export async function loadEngineAt(modulePath, label, opts = {}) {
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (e) {
    throw new LoaderError(`engine "${label}" failed to load — ${e.message}`);
  }
  if (typeof mod.default !== 'function') {
    throw new LoaderError(`engine "${label}" has no default export function`
      + ' (SPEC ENGINE_UNITS: export default function createEngine(opts))');
  }
  let engine;
  try {
    engine = await mod.default(opts);
  } catch (e) {
    throw new LoaderError(`engine "${label}" threw while starting: ${e.message}`);
  }
  if (!engine || typeof engine !== 'object') {
    throw new LoaderError(`engine "${label}" must return an engine object (returned ${typeof engine})`);
  }
  if (typeof engine.synth !== 'function') {
    throw new LoaderError(`engine "${label}" returned no synth() — there is nothing to speak with`);
  }
  if (!Array.isArray(engine.voices) && typeof engine.listVoices !== 'function') {
    throw new LoaderError(`engine "${label}" returned neither a voices array nor listVoices()`
      + ' — the picker would have no roster to offer');
  }
  return {
    ...engine,
    name: typeof engine.name === 'string' && engine.name ? engine.name : label,
    voices: Array.isArray(engine.voices) ? engine.voices : [],
    stylable: engine.stylable === true,
  };
}

/**
 * Load one installed speech engine, ready for the bridge to speak with.
 * `opts` is the same option bag `tools/tts-engines.mjs`'s own `createEngine`
 * takes, passed through untouched — an installed engine reads what it needs
 * (`voice`, `model`, `lang`) and ignores the rest, exactly as the built-ins do.
 */
export async function loadEngine(name, opts = {}, home = configHome()) {
  const unit = resolveEngine(name, home);
  const engine = await loadEngineAt(unit.path, name, opts);
  return { ...engine, installed: true, checked: unit.checked };
}
