// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The loader (MARKETPLACE.md `EXTENSIONS#LOADER`) — runs an installed
 * build-time transform against a deck's own source.
 *
 * A transform is Node code, installed by `cli/units.mjs` like any other unit,
 * but running one is a different capability from installing one (SPEC
 * `EXTENSIONS_TRANSFORMS`): dynamic `import()`, in the SAME process as
 * `bundle` — no subprocess, no VM sandbox. That is not a gap; MARKETPLACE.md
 * `EXTENSIONS` already decided the trust model for build-time code (the
 * installer is the risk-bearer, same as Claude's own plugin marketplace), so
 * isolating a transform from the process that invoked it would defend
 * against a threat this design already accepted.
 *
 * `apiVersion` compat is a LOADER question, not an install-time one (SPEC
 * `UNIT_COMPAT`): the shape check in `marketplace.mjs` only proves the field
 * is a positive integer, never against what this decklight implements — a
 * catalog may be written against a newer contract than the one reading it.
 * Whether a given transform can actually RUN here is settled the moment it
 * is about to be, by comparing its declared `apiVersion` against
 * `TRANSFORM_API_VERSION`. That number is not persisted onto the installed
 * `.mjs` file — there is nowhere on a single file to put it — so it is
 * re-read from the catalog cache, exactly the way `adapterFor` re-reads an
 * importer's `extensions` rather than duplicating it into the library.
 */

import { pathToFileURL } from 'node:url';
import { findUnit, catalogEntriesOfType } from './units.mjs';
import { configHome, TRANSFORM_API_VERSION } from './marketplace.mjs';

/** A failure with a message for a human — always names the transform, never a stack. */
export class LoaderError extends Error {}

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
  const unit = findUnit('transform', name, home);
  if (!unit) {
    throw new LoaderError(`no transform "${name}" installed`
      + ` (decklight transform add ${name}, decklight transform list)`);
  }
  const entry = catalogEntriesOfType('transform', home).find((e) => e.name === name);
  if (entry && entry.apiVersion > TRANSFORM_API_VERSION) {
    throw new LoaderError(`transform "${name}" needs apiVersion ${entry.apiVersion},`
      + ` this decklight only implements up to ${TRANSFORM_API_VERSION} — upgrade decklight to use it`);
  }
  return { name, path: unit.path, checked: !!entry };
}

/**
 * Run a transform module at a given path against `html`, collapsing every
 * failure shape into one clean, `label`-naming `LoaderError` (SPEC
 * `EXTENSIONS_TRANSFORMS`) — no default export, an export that is not a
 * function, a thrown/rejected value, a non-string return, never a raw stack
 * trace. Split out from `runTransform` so `tools/extension-check.mjs` can run
 * a bare FILE the same way, without an installed unit or a catalog behind it.
 */
export async function runTransformAt(modulePath, html, label) {
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (e) {
    throw new LoaderError(`transform "${label}" failed to load — ${e.message}`);
  }
  if (typeof mod.default !== 'function') {
    throw new LoaderError(`transform "${label}" has no default export function`
      + ' (SPEC EXTENSIONS_TRANSFORMS: export default async function transform(html, opts))');
  }
  let out;
  try {
    out = await mod.default(html, {});
  } catch (e) {
    throw new LoaderError(`transform "${label}" threw: ${e.message}`);
  }
  if (typeof out !== 'string') {
    throw new LoaderError(`transform "${label}" must return a string (returned ${typeof out})`);
  }
  return out;
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
