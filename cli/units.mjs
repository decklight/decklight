// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The unit library — one install seam for everything a marketplace
 * distributes that is not a theme or a plugin (MARKETPLACE.md `UNITS`).
 *
 * `MARKETPLACES#CORE` registers catalogs and resolves a name to an entry;
 * `THEME_BROWSE#UI` and `PRESENT#PLUGINS` each installed one kind of thing on
 * top of it. This is the rest — deck templates, agent skills, import adapters
 * — and it is deliberately ONE implementation with a type table rather than
 * three commands that each grew their own copy of resolve-fetch-validate-write.
 * `decklight template add` and `decklight importer add` are the same function
 * with a different row.
 *
 * THE INVARIANT THAT OUTRANKS CONVENIENCE (SPEC MARKETPLACE_REGISTRY):
 * registering is not fetching. Everything here reads the catalog CACHE; the
 * only network call is `fetchArtifact`, reached only from an explicit `add`.
 * `unitFor` and `listUnits` — the lookups on the `init` and `import` paths —
 * cannot reach the network at all, so a deck on a plane behaves exactly like a
 * deck at a desk.
 *
 * WHAT IS DELIBERATELY NOT HERE: running an installed unit. A template is
 * HTML and a skill is Markdown, so both are just files. An import adapter is
 * **Node code**, and executing one is the same capability — and the same
 * unanswered compat-range question (`OPEN` 2) — as `EXTENSIONS#TRANSFORMS`.
 * Shipping a loader here would answer that in a second place, so this installs
 * an adapter and stops. `cli/import.mjs` says so out loud rather than failing
 * in a way that reads like a bug.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configHome, loadRegistry, loadCatalog, resolveEntry, MarketplaceError } from './marketplace.mjs';

/** A failure with a message for a human — the mains print it, never a stack. */
export class UnitError extends Error {}

/**
 * The unit types this decklight installs, and the shape each one takes.
 *
 * `files` is what an entry's `source` must yield. A single-file unit names its
 * one file and `source` points straight at it; a multi-file unit's `source` is
 * a DIRECTORY and each name is fetched from inside it. `required` names the
 * catalog fields beyond the universal `{name, type, source}` — `extensions`
 * for an importer is not decoration: it is what lets `decklight import` find
 * the adapter for a `.marp` file **offline**, from the cache alone.
 */
export const UNIT_TYPES = {
  template: {
    dir: 'templates',
    single: 'html',
    label: 'deck template',
    use: 'decklight init --from <name>',
    required: [],
  },
  skill: {
    dir: 'skills',
    files: ['SKILL.md'],
    optional: ['reference.md'],
    label: 'agent skill',
    use: 'decklight skills add <name>',
    required: [],
  },
  importer: {
    dir: 'importers',
    files: ['importer.mjs'],
    label: 'import adapter',
    use: 'decklight import <file>',
    required: ['extensions'],
  },
};

const typeOf = (type) => {
  const t = UNIT_TYPES[type];
  if (!t) throw new UnitError(`"${type}" is not a unit type this decklight installs`);
  return t;
};

/** Where a type's units live: `~/.decklight/templates/`, `…/skills/`, … */
export const unitDir = (type, home = configHome()) => join(home, typeOf(type).dir);

/** Where ONE unit lives — a file for a single-file type, a directory otherwise. */
export const unitPath = (type, name, home = configHome()) => {
  const t = typeOf(type);
  return join(unitDir(type, home), t.single ? `${name}.${t.single}` : name);
};

// ── reading the library, always offline ────────────────────────────────────

/** Installed units of a type, by name. Never touches the network. */
export function listUnits(type, home = configHome()) {
  const t = typeOf(type);
  const dir = unitDir(type, home);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (t.single) {
      const suffix = `.${t.single}`;
      if (!entry.endsWith(suffix) || !statSync(full).isFile()) continue;
      out.push({ name: entry.slice(0, -suffix.length), path: full });
    } else {
      if (!statSync(full).isDirectory()) continue;
      out.push({ name: entry, path: full });
    }
  }
  return out;
}

/** One installed unit, or null. Never touches the network. */
export function findUnit(type, name, home = configHome()) {
  const p = unitPath(type, name, home);
  return existsSync(p) ? { name, path: p } : null;
}

/**
 * Every entry in every CACHED catalog, flattened. The lookup that `init` and
 * `import` use to name something they cannot find installed — reading a JSON
 * file that is already on disk, which is exactly as offline-identical as not
 * reading it at all.
 */
export function catalogEntries(home = configHome()) {
  const reg = loadRegistry(home);
  const out = [];
  for (const marketplace of Object.keys(reg.marketplaces).sort()) {
    const cached = loadCatalog(marketplace, home);
    if (!cached?.ok) continue;
    for (const entry of cached.manifest.entries) {
      out.push({ ...entry, marketplace, qualified: `${entry.name}@${marketplace}` });
    }
  }
  return out;
}

/** Catalog entries of one type, cache-only — "what templates could I install?" */
export const catalogEntriesOfType = (type, home = configHome()) =>
  catalogEntries(home).filter((e) => e.type === type);

/**
 * The import adapter a file extension would need, from the cache alone.
 *
 * This is what makes the offer at the point of failure possible without a
 * setup step nobody performs in advance (the ENGINES pattern): `import
 * talk.marp` can name `marp-import` because the catalog it already fetched
 * said which extensions that adapter handles. With no catalog cached it
 * returns nothing and `import` says what it always said — never a hang, never
 * a fetch.
 */
export function adapterFor(ext, home = configHome()) {
  const want = String(ext ?? '').toLowerCase();
  if (!want) return null;
  return catalogEntriesOfType('importer', home).find((e) =>
    (e.extensions ?? []).some((x) => String(x).toLowerCase().replace(/^\.?/, '.') === want)) ?? null;
}

// ── installing, the one place that reaches the network ─────────────────────

/** Read one artifact file from a resolved source (a URL or a local path). */
async function fetchArtifact(at, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (/^https?:\/\//i.test(at)) {
    let r;
    try { r = await fetchImpl(at, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' }); } catch (e) {
      const why = e.name === 'TimeoutError' || e.code === 'ABORT_ERR'
        ? `no response after ${timeoutMs / 1000}s` : String(e.cause?.code ?? e.message);
      throw new UnitError(`could not fetch ${at} — ${why}`);
    }
    if (!r.ok) throw new UnitError(`${at} — HTTP ${r.status}`);
    return await r.text();
  }
  if (!existsSync(at)) throw new UnitError(`no such file: ${at}`);
  return readFileSync(at, 'utf8');
}

const joinSource = (base, file) => (/^https?:\/\//i.test(base)
  ? `${base.replace(/\/$/, '')}/${file}`
  : join(resolve(base), file));

/**
 * Install one unit by catalog reference (`name` or `name@marketplace`).
 *
 * Everything is fetched and checked BEFORE anything is written, so a refusal
 * or a dropped connection leaves the library exactly as it was — the rule
 * `theme add` keeps, for the same reason: a half-installed unit is worse than
 * an uninstalled one, because it looks present.
 */
export async function installUnit(type, ref, home = configHome(), { fetchImpl = fetch } = {}) {
  const t = typeOf(type);
  const reg = loadRegistry(home);
  const catalogs = {};
  for (const name of Object.keys(reg.marketplaces)) {
    const c = loadCatalog(name, home);
    if (c?.ok) catalogs[name] = c.manifest;
  }
  if (!Object.keys(catalogs).length) {
    throw new UnitError('no marketplace has been fetched yet'
      + ' — decklight marketplace update <name> (registering is not fetching)');
  }

  let hit;
  try { hit = resolveEntry(ref, catalogs); } catch (e) {
    if (e instanceof MarketplaceError) throw new UnitError(e.message);
    throw e;
  }
  if (hit.entry.type !== type) {
    throw new UnitError(`${hit.qualified} is a ${hit.entry.type}, not a ${type}`
      + `${UNIT_TYPES[hit.entry.type] ? ` — try: decklight ${hit.entry.type} add ${ref}` : ''}`);
  }

  const { resolveSource } = await import('./theme.mjs');
  const base = resolveSource(hit.entry.source, reg.marketplaces[hit.marketplace]?.source);

  // Fetch first, write second.
  const fetched = [];
  if (t.single) {
    fetched.push(['', await fetchArtifact(base, { fetchImpl })]);
  } else {
    for (const file of t.files) fetched.push([file, await fetchArtifact(joinSource(base, file), { fetchImpl })]);
    for (const file of t.optional ?? []) {
      try { fetched.push([file, await fetchArtifact(joinSource(base, file), { fetchImpl })]); } catch { /* optional */ }
    }
  }

  const dest = unitPath(type, hit.entry.name, home);
  if (t.single) {
    mkdirSync(unitDir(type, home), { recursive: true });
    writeFileSync(dest, fetched[0][1]);
  } else {
    mkdirSync(dest, { recursive: true });
    for (const [file, text] of fetched) writeFileSync(join(dest, file), text);
  }
  return { name: hit.entry.name, qualified: hit.qualified, entry: hit.entry, path: dest, files: fetched.map(([f]) => f).filter(Boolean) };
}

/** Delete an installed unit. */
export function removeUnit(type, name, home = configHome()) {
  const p = unitPath(type, name, home);
  if (!existsSync(p)) throw new UnitError(`no ${type} "${name}" installed (decklight ${type} list)`);
  rmSync(p, { recursive: true, force: true });
  return p;
}

// ── the command every unit type shares ─────────────────────────────────────

export const unitUsage = (type) => {
  const t = typeOf(type);
  return `usage: decklight ${type} <add|list|remove> …

  decklight ${type} add <name[@marketplace]>
    install a ${t.label} from a registered marketplace into ~/.decklight/${t.dir}/
    EXAMPLE: decklight ${type} add ${type === 'importer' ? 'marp-import' : 'startup-pitch'}

  decklight ${type} list
    what is installed, and what the registered catalogs offer that is not

  decklight ${type} remove <name>
    delete it from your library

  used by: ${t.use}

  Registering a marketplace is not fetching it (SPEC MARKETPLACE_REGISTRY):
  \`list\` reads only the cache and works on a plane, and the network is touched
  only by an explicit \`add\`. DECKLIGHT_HOME overrides ~/.decklight/.`;
};

async function addMain(type, args, home) {
  const [ref] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight ${type} add: needs a name\n\n${unitUsage(type)}`); return 1; }
  let done;
  try { done = await installUnit(type, ref, home); } catch (e) {
    if (!(e instanceof UnitError)) throw e;
    console.error(`decklight ${type} add: ${e.message}`);
    return 1;
  }
  console.log(`installed ${done.name} from ${done.qualified} — ${UNIT_TYPES[type].use}`);
  if (done.entry.description) console.log(`  ${done.entry.description}`);
  return 0;
}

function listMain(type, home) {
  const t = UNIT_TYPES[type];
  const installed = listUnits(type, home);
  const offered = catalogEntriesOfType(type, home);
  const have = new Set(installed.map((u) => u.name));

  if (!installed.length && !offered.length) {
    console.log(`no ${t.label}s installed, and no registered marketplace offers one`);
    console.log('  decklight marketplace add <owner/repo>, then decklight marketplace update <name>');
    return 0;
  }
  for (const u of installed) {
    const from = offered.find((e) => e.name === u.name);
    console.log(`${u.name}${from ? `  ${from.qualified}` : ''}${from?.description ? ` — ${from.description}` : ''}`);
  }
  const rest = offered.filter((e) => !have.has(e.name));
  if (rest.length) {
    console.log(installed.length ? `\navailable (decklight ${type} add <name>):` : `available (decklight ${type} add <name>):`);
    for (const e of rest) console.log(`  ${e.qualified}${e.description ? ` — ${e.description}` : ''}`);
  }
  return 0;
}

function removeMain(type, args, home) {
  const [name] = args.filter((a) => !a.startsWith('-'));
  if (!name) { console.error(`decklight ${type} remove: which one?\n\n${unitUsage(type)}`); return 1; }
  try { removeUnit(type, name, home); } catch (e) {
    if (!(e instanceof UnitError)) throw e;
    console.error(`decklight ${type} remove: ${e.message}`);
    return 1;
  }
  console.log(`removed ${name}`);
  return 0;
}

/** `decklight <type> <add|list|remove>` — one implementation, three commands. */
export async function unitMain(type, args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(unitUsage(type)); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(unitUsage(type)); return 0; }
  const home = configHome();
  try {
    if (sub === 'add') return await addMain(type, rest, home);
    if (sub === 'list') return listMain(type, home);
    if (sub === 'remove') return removeMain(type, rest, home);
  } catch (e) {
    if (e instanceof UnitError || e instanceof MarketplaceError) {
      console.error(`decklight ${type} ${sub}: ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.error(`decklight ${type}: unknown subcommand "${sub}"\n\n${unitUsage(type)}`);
  return 1;
}
