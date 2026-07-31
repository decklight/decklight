// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The loader (MARKETPLACE.md `EXTENSIONS#LOADER`) — runs an installed
 * build-time transform against a deck's own source, or an installed import
 * adapter against a source file's bytes (`EXTENSIONS#ADAPTEREXEC`).
 *
 * Both are Node code, installed by `cli/units.mjs` like any other unit, but
 * running one is a different capability from installing one (SPEC
 * `EXTENSIONS_TRANSFORMS`, `EXTENSIONS_ADAPTERS`): dynamic `import()`, in the
 * SAME process as `bundle`/`import` — no subprocess, no VM sandbox. That is
 * not a gap; MARKETPLACE.md `EXTENSIONS` already decided the trust model for
 * build-time code (the installer is the risk-bearer, same as Claude's own
 * plugin marketplace), so isolating either from the process that invoked it
 * would defend against a threat this design already accepted.
 *
 * `apiVersion` compat is a LOADER question, not an install-time one (SPEC
 * `UNIT_COMPAT`): the shape check in `marketplace.mjs` only proves the field
 * is a positive integer, never against what this decklight implements — a
 * catalog may be written against a newer contract than the one reading it.
 * Whether a given unit can actually RUN here is settled the moment it is
 * about to be, by comparing its declared `apiVersion` against that unit
 * KIND's own ceiling — `TRANSFORM_API_VERSION` for a transform,
 * `IMPORTER_API_VERSION` for an adapter, two separate counters because the
 * two calling conventions move on their own schedules (SPEC
 * `EXTENSIONS_ADAPTERS`). That number is not persisted onto the installed
 * `.mjs` file — there is nowhere on a single file to put it — so it is
 * re-read from the catalog cache, exactly the way `adapterFor` re-reads an
 * importer's `extensions` rather than duplicating it into the library.
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { findUnit, catalogEntriesOfType, UNIT_TYPES } from './units.mjs';
import { configHome, TRANSFORM_API_VERSION, IMPORTER_API_VERSION } from './marketplace.mjs';

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
