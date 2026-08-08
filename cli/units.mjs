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
 * HTML and a skill is Markdown, so both are just files. An import adapter and
 * a build-time transform are both **Node code**, and executing either is one
 * shared capability rather than two copies of resolve-fetch-validate-load —
 * `cli/loader.mjs` (`EXTENSIONS#LOADER`) is that shared loader. `bundle
 * --transform <name>` calls it once a transform is installed by the seam
 * below, and `cli/import.mjs` calls the same loader's `runImporter` the
 * moment an installed adapter matches the extension in hand
 * (`EXTENSIONS#ADAPTEREXEC`, SPEC `EXTENSIONS_ADAPTERS`).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    example: 'startup-pitch',
    required: [],
  },
  skill: {
    dir: 'skills',
    files: ['SKILL.md'],
    optional: ['reference.md'],
    label: 'agent skill',
    use: 'decklight skills add <name>',
    example: 'conference-cfp',
    required: [],
  },
  // `pinned` marks the kinds that are Node code the loader runs unsandboxed
  // at author privilege (EXTENSIONS#LOADER): their `source` resolves against
  // a moving ref (`resolveSource` deliberately fetches HEAD), so an entry
  // installs only against the `sha256` its catalog admitted — refused before
  // any fetch without one, refused before any write on a mismatch (SPEC
  // UNIT_PINNING). Data kinds stay unpinned: a theme re-passes its whole
  // contract at `theme add`, and nothing in a template or skill executes.
  importer: {
    dir: 'importers',
    files: ['importer.mjs'],
    label: 'import adapter',
    use: 'decklight import <file>',
    example: 'marp-import',
    required: ['extensions'],
    pinned: true,
  },
  // Node code, like an importer — but this one DOES run (EXTENSIONS#LOADER):
  // `bundle --transform <name>` loads it through cli/loader.mjs. `apiVersion`
  // is not persisted onto the installed file (there is nowhere on an .mjs to
  // put it); the loader re-reads it from the catalog cache at run time, the
  // same way `adapterFor` re-reads an importer's `extensions` rather than
  // duplicating it into the library.
  transform: {
    dir: 'transforms',
    single: 'mjs',
    label: 'build-time transform',
    use: 'decklight bundle --transform <name>',
    example: 'grammar-check',
    required: ['apiVersion'],
    pinned: true,
  },
  // Node code that runs at AUTHOR time like a transform, and pinned for the
  // same reason — but it is the first unit whose module is a FACTORY rather
  // than a `(input) → string` pass (SPEC ENGINE_UNITS). What it returns is
  // spoken with, so a malformed one has to be caught on the way out of the
  // import rather than at the first sentence, mid-talk. Like a transform,
  // `apiVersion` is not persisted onto the installed .mjs — the loader
  // re-reads it, and `capability`, from the catalog cache.
  engine: {
    dir: 'engines',
    single: 'mjs',
    label: 'speech engine',
    use: 'decklight tts --engine <name>, then the N picker',
    example: 'azure-tts',
    required: ['apiVersion', 'capability'],
    pinned: true,
  },
  // The one kind that carries NOTHING. `reference: true` means the install is
  // the catalog entry itself, written to disk as a pointer — no source to
  // resolve, no bytes to fetch (SPEC VOICE_UNITS). Two consequences fall out
  // of that and both are the point: `voice add` is the only add that works
  // OFFLINE, and there is no code path by which a voice model could land in
  // the library, because the fetch is not skipped conditionally — it is not
  // reachable.
  voice: {
    dir: 'voices',
    single: 'json',
    reference: true,
    label: 'voice',
    use: 'the N picker, author mode',
    example: 'narrator-anna',
    note: 'A voice is a REFERENCE — which engine, which of its voices. Installing\n  one writes a pointer and fetches nothing, so this is the one add that works\n  offline; speaking through it still needs that engine and your own credential.',
    required: ['engine', 'voiceId'],
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

/**
 * Installed voice references for one engine (SPEC VOICE_UNITS).
 *
 * Filtered by engine because a reference is only an answer on the engine it
 * names: an ElevenLabs voice id means nothing to piper, and offering it while
 * piper is live would put a row in the picker that can only fail. Unreadable
 * or half-written files are skipped rather than thrown — one bad pointer must
 * not cost the roster the bridge is otherwise able to report.
 */
export function installedVoices(engine, home = configHome()) {
  const want = String(engine ?? '').toLowerCase();
  if (!want) return [];
  const out = [];
  for (const { name, path } of listUnits('voice', home)) {
    let ref;
    try { ref = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (String(ref?.engine ?? '').toLowerCase() !== want) continue;
    if (!ref.voiceId) continue;
    out.push({ name, voiceId: String(ref.voiceId), label: ref.label || name, marketplace: ref.marketplace });
  }
  return out;
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

  // A reference-only kind is fully installed by the catalog entry it resolved
  // to: write the pointer and return, before anything can be fetched.
  if (t.reference) {
    const dest = unitPath(type, hit.entry.name, home);
    const { name, type: _t, source: _s, ...rest } = hit.entry;
    mkdirSync(unitDir(type, home), { recursive: true });
    writeFileSync(dest, `${JSON.stringify({ name, ...rest, marketplace: hit.marketplace }, null, 2)}\n`);
    return { name, qualified: hit.qualified, entry: hit.entry, path: dest, files: [] };
  }

  // A pinned kind with no pin is refused HERE, before the network is touched:
  // its source resolves against a moving ref, so without a digest there is no
  // fact to hold the fetched bytes to (SPEC UNIT_PINNING).
  if (t.pinned && !hit.entry.sha256) {
    throw new UnitError(`${hit.qualified} carries no sha256 — a ${t.label} is Node code decklight`
      + ` runs unsandboxed, so it installs only pinned to the digest its catalog admitted`
      + ` (SPEC UNIT_PINNING). Ask the marketplace to pin the entry; decklight extension check`
      + ` prints the digest to use`);
  }

  // Same placement, same reason: an `engine` entry may legitimately carry
  // neither field, because the type is also how a catalog declares a wizard
  // for an engine decklight already SHIPS (ENGINES#WIZARD) — no module, no
  // contract version, nothing installed. Only an entry actually being
  // installed as a unit has to answer for both (SPEC ENGINE_UNITS).
  for (const field of t.required ?? []) {
    if (t.reference || hit.entry[field] !== undefined) continue;
    throw new UnitError(`${hit.qualified} declares no ${field}, which installing a ${t.label} needs`
      + (type === 'engine'
        ? ' (SPEC ENGINE_UNITS). An entry that only declares a wizard for an engine decklight'
          + ' already ships carries neither field, and is not installed this way — the wizard'
          + ' reaches it through the palette instead'
        : ''));
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

  // The pin covers the MODULE — the file the loader will import() — and it is
  // checked between fetch and write, so a mismatch leaves the library exactly
  // as it was, like every other refusal here.
  if (hit.entry.sha256) {
    const moduleFile = t.single ? '' : t.files[0];
    const got = createHash('sha256').update(fetched.find(([f]) => f === moduleFile)[1]).digest('hex');
    const want = String(hit.entry.sha256).toLowerCase();
    if (got !== want) {
      throw new UnitError(`${hit.qualified}: the fetched ${t.single ? `.${t.single} file` : t.files[0]}`
        + ` does not match the catalog's pin (SPEC UNIT_PINNING)\n`
        + `  pinned  sha256 ${want}\n`
        + `  fetched sha256 ${got}\n`
        + `  the file changed since this catalog was cached — nothing was installed. If the`
        + ` marketplace re-pinned it, decklight marketplace update ${hit.marketplace} and try again`);
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
    EXAMPLE: decklight ${type} add ${t.example}${t.note ? `\n\n  ${t.note}` : ''}

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
