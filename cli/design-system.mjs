#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight design-system — the design-system unit (SPEC DESIGN_SYSTEMS).
//
//   decklight design-system check <dir>
//   decklight design-system add|remove <name@marketplace> <deck.html>
//   decklight design-system list [<deck.html>]
//   decklight design-system layouts <name@marketplace>
//
// `check` is the admission gate a catalog's own CI runs, in the mould of
// `decklight extension check` and `decklight theme check`: a valid package
// prints what it holds and exits 0; a broken or unsafe one names the file,
// the line and the rule for every problem, and exits 1. Every rule lives in
// tools/design-system-format.mjs, which is pure — this file only reads a
// directory into the shape it takes.
//
// A deck depends on a design system by REFERENCE (cli/design-system-refs.mjs):
// `add` writes `designSystems` (and the shared `themeSources`) into its
// configuration block, after the package passes `check`; every server serves
// it from the marketplace checkout. Nothing is ever installed into
// ~/.decklight/ — the ledger only remembers which version a deck took.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { checkPackage, DESIGN_SYSTEM_API_VERSION, ASSET_EXTENSIONS } from '../tools/design-system-format.mjs';

const USAGE = `usage: decklight design-system <add|remove|list|layouts|check> …

  decklight design-system add <name@marketplace> <deck.html>
    reference a design system from a deck — after the package passes check;
    the deck gains one entry in its configuration block, never the package
    EXAMPLE: decklight design-system add acme@acme-mkt talk.html

  decklight design-system remove <name@marketplace> <deck.html>
    drop the reference; the package stays in its marketplace

  decklight design-system list [<deck.html>]
    what a deck references (and the version it took against the catalog's);
    with no deck, every design system the registered marketplaces offer —
    from the cache alone, works on a plane

  decklight design-system layouts <name@marketplace>
    the package's layouts and their slots — the names a slide writes

  decklight design-system check <dir>
    the marketplace admission gate for a design-system package — its manifest,
    stylesheet, layouts and assets, held to the format's rules (SPEC
    DESIGN_SYSTEMS). Prints what the package holds and exits 0, or names the
    file, the line and the rule for every problem and exits 1.
    EXAMPLE: decklight design-system check systems/acme

  A design system is a directory:
    design-system.json   apiVersion (${DESIGN_SYSTEM_API_VERSION}), name, version (semver), title,
                         styles ("design-system.css"), layouts ("layouts.html")
                         + description, tokenPrefix (default "--<name>-"),
                           palette [{ group, label, token }], recommendedThemes
    design-system.css    prefixed tokens and per-layout rules; url()s relative to it
    layouts.html         inert <template data-layout="…"> blocks, with data-slot containers
    assets/…             ${ASSET_EXTENSIONS.join(' · ')}

  A deck references a design system rather than copying it; every server
  serves it from the marketplace on this machine, never the network.`;

/** Files whose TEXT the rules read; everything else is checked by extension and size. */
const TEXT = /\.(json|css|html|svg)$/i;

/**
 * A package directory as `checkPackage` takes it. Every file under `dir`,
 * by its /-separated relative path. A symlink that resolves outside the
 * package is a problem of its own — nothing a deck is served may come from
 * outside the directory it was admitted as.
 */
export function readPackage(dir) {
  const root = realpathSync(resolve(dir));
  const files = new Map();
  const escapes = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === '.git') continue;
      const full = join(abs, name);
      const rel = relative(root, full).split(sep).join('/');
      let target = full;
      if (lstatSync(full).isSymbolicLink()) {
        try { target = realpathSync(full); } catch { escapes.push(rel); continue; }
        if (target !== root && !target.startsWith(root + sep)) { escapes.push(rel); continue; }
      }
      const st = statSync(target);
      if (st.isDirectory()) { walk(full); continue; }
      files.set(rel, { size: st.size, ...(TEXT.test(name) ? { text: readFileSync(target, 'utf8') } : {}) });
    }
  };
  walk(root);
  const manifest = files.get('design-system.json')?.text ?? null;
  return { manifest, files, escapes };
}

/** A package, checked — the gate's whole verdict, with symlink escapes folded in. */
export function checkDir(dir) {
  const { manifest, files, escapes } = readPackage(dir);
  if (manifest === null) {
    return { ok: false, problems: [{ file: 'design-system.json', rule: 'file-missing', msg: 'no design-system.json at the package root — this is not a design system' }], warnings: [], summary: {} };
  }
  const r = checkPackage({ manifest, files });
  for (const rel of escapes) {
    r.problems.push({ file: rel, rule: 'file-outside', msg: 'a symlink that resolves outside the package — a design system reaches only its own files' });
  }
  r.ok = r.problems.length === 0;
  // what a server needs from a passing package, read once here: the parsed
  // manifest, and the layouts text it inlines into the page
  try { r.manifest = JSON.parse(manifest); } catch { r.manifest = null; }
  r.layoutsHtml = typeof r.manifest?.layouts === 'string' ? files.get(r.manifest.layouts)?.text ?? null : null;
  return r;
}

const where = (p) => `${p.file}${p.line ? ` line ${p.line}` : ''}`;
const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The report, as the lines to print. */
export function reportLines(dir, r) {
  const s = r.summary ?? {};
  const out = [];
  if (!r.ok) {
    out.push(`✘ ${s.name ?? dir} — ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}, not admitted`);
    for (const p of r.problems) out.push(`  ${where(p)}: ${p.msg}  [${p.rule}]`);
  } else {
    out.push(`✔ ${s.name} — design system ${s.version}, api ${s.apiVersion}`);
    out.push(`  design-system.json   ${s.title}${s.palette ? ` — palette of ${s.palette}` : ''}`
      + `${s.recommendedThemes?.length ? ` · recommends ${s.recommendedThemes.join(', ')}` : ''}`);
    out.push(`  stylesheet           ${s.tokens.length} token${s.tokens.length === 1 ? '' : 's'} (${s.prefix}…)`);
    const layouts = s.layouts ?? [];
    out.push(`  layouts              ${layouts.length} layout${layouts.length === 1 ? '' : 's'}${layouts.length ? ':' : ''}`);
    for (const l of layouts) {
      const slots = l.slots.map((x) => `${x.name}${x.required ? '*' : ''}${x.default ? '†' : ''}`).join(', ');
      out.push(`                         ${l.id} (${slots || 'no slots'})`);
    }
    if (layouts.some((l) => l.slots.length)) out.push('                         * required · † takes unslotted content');
    const assets = s.assets ?? [];
    const byExt = {};
    for (const a of assets) byExt[a.ext] = (byExt[a.ext] ?? 0) + 1;
    out.push(`  assets               ${assets.length} file${assets.length === 1 ? '' : 's'}`
      + `${assets.length ? ` — ${Object.entries(byExt).map(([e, n]) => `${n} ${e}`).join(', ')} · ${kb(assets.reduce((t, a) => t + a.size, 0))}` : ''}`);
  }
  // declared overrides of the theme contract, printed on every run — the way a
  // theme's rule-exception: is — so they stay reviewable
  for (const e of r.summary?.exceptions ?? []) out.push(`  ds-exception ${e.token}: ${e.reason}`);
  for (const w of r.warnings ?? []) out.push(`  ⚠ ${where(w)}: ${w.msg}`);
  return out;
}

async function checkMain(args) {
  const [dir] = args.filter((a) => !a.startsWith('-'));
  if (!dir) { console.error(`decklight design-system check: needs a package directory\n\n${USAGE}`); return 1; }
  if (!existsSync(dir)) { console.error(`decklight design-system check: no such directory: ${dir}`); return 1; }
  if (!statSync(dir).isDirectory()) {
    console.error(`decklight design-system check: ${dir} is a file — a design system is a directory holding design-system.json`);
    return 1;
  }
  const r = checkDir(dir);
  for (const line of reportLines(dir, r)) console.log(line);
  return r.ok ? 0 : 1;
}

/** The deck path and its text, or a refusal printed as-is. */
function readDeckArg(cmd, deck) {
  if (!deck) { console.error(`decklight design-system ${cmd}: needs a deck\n\n${USAGE}`); return null; }
  const path = resolve(deck);
  if (!existsSync(path)) { console.error(`decklight design-system ${cmd}: no such deck: ${deck}`); return null; }
  return { path, html: readFileSync(path, 'utf8') };
}

/** The catalogs this machine has fetched, for resolving a bare or qualified name. */
async function catalogs() {
  const { configHome, loadRegistry, loadCatalog } = await import('./marketplace.mjs');
  const out = {};
  for (const name of Object.keys(loadRegistry(configHome()).marketplaces ?? {})) {
    const c = loadCatalog(name);
    if (c?.ok) out[name] = c.manifest;
  }
  return out;
}

async function addMain(args, on) {
  const cmd = on ? 'add' : 'remove';
  const [ref, deck] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight design-system ${cmd}: needs a design system and a deck\n\n${USAGE}`); return 1; }
  const d = readDeckArg(cmd, deck);
  if (!d) return 1;
  const { MarketplaceError, resolveEntry, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
  const { resolveDesignSystemRef, setDesignSystem, designSystemRefs } = await import('./design-system-refs.mjs');
  const { refForDeck, writeFileAtomic } = { ...(await import('./theme-refs.mjs')), ...(await import('../tools/atomic-write.mjs')) };
  try {
    if (!on) {
      // the deck's own spelling of the reference wins, whatever this machine calls it
      const hit = designSystemRefs(d.html).find((r) => r.ref === ref || r.name === ref);
      if (!hit) {
        const has = designSystemRefs(d.html).map((r) => r.ref);
        console.error(`decklight design-system remove: ${ref} is not referenced by ${deck}${has.length ? ` — it uses ${has.join(', ')}` : ' — it uses no design system'}`);
        return 1;
      }
      const out = setDesignSystem(d.html, hit.ref, false);
      if (out.changed) writeFileAtomic(d.path, out.html);
      console.log(out.changed ? `dropped ${hit.ref} from ${deck} — the package stays in its marketplace` : `${hit.ref} was not referenced by ${deck}`);
      return 0;
    }
    let qualified = ref;
    try { qualified = resolveEntry(ref, await catalogs()).qualified; } catch (e) { if (!(e instanceof MarketplaceError)) throw e; console.error(`decklight design-system add: ${e.message}`); return 1; }
    const r = resolveDesignSystemRef(qualified);
    if (!r.dir) { console.error(`decklight design-system add: ${r.ref} — ${r.missing}`); return 1; }
    // the gate first: a package that fails leaves the deck byte-for-byte as it was
    const verdict = checkDir(r.dir);
    if (!verdict.ok) {
      for (const line of reportLines(r.dir, verdict)) console.error(line);
      console.error(`\ndecklight design-system add: ${r.ref} was NOT referenced — the package fails the check above`);
      return 1;
    }
    const deckRef = refForDeck(d.html, r.name, r.local, r.source ?? null);
    const out = setDesignSystem(d.html, deckRef, true, { source: r.source ?? null });
    if (out.changed) writeFileAtomic(d.path, out.html);
    const commit = loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null;
    recordInstall({ type: 'design-system', name: r.name, marketplace: r.local, version: r.entry.version ?? null, commit });
    const v = verdict.summary.version ? ` ${verdict.summary.version}` : '';
    console.log(out.changed
      ? `${deck} now uses ${deckRef}${v} — ${verdict.summary.title}; every server links it from the marketplace on this machine`
      : `${deck} already uses ${deckRef} — recorded${v} as the version you have`);
    return 0;
  } catch (e) {
    if (e instanceof MarketplaceError) { console.error(`decklight design-system ${cmd}: ${e.message}`); return 1; }
    throw e;
  }
}

async function listMain(args) {
  const [deck] = args.filter((a) => !a.startsWith('-'));
  const { marketplaceDesignSystems, designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
  const { loadLedger, semverCompare } = await import('./marketplace.mjs');
  const { markedSources } = await import('./theme-refs.mjs');
  const installs = loadLedger().installs;
  if (deck) {
    const d = readDeckArg('list', deck);
    if (!d) return 1;
    const refs = designSystemRefs(d.html);
    if (!refs.length) { console.log(`${deck} uses no design system — decklight design-system add <name@marketplace> ${deck}`); return 0; }
    const sources = markedSources(d.html);
    for (const ref of refs) {
      const r = resolveDesignSystemRef(ref, undefined, { source: sources[ref.marketplace] ?? null });
      const had = installs[`design-system:${ref.name}@${r.local ?? ref.marketplace}`]?.version ?? null;
      const now = r.entry?.version ?? null;
      const ver = had && now && semverCompare(now, had) > 0 ? `  ${had} → ${now}` : now ? `  ${now}` : '';
      console.log(`${ref.ref}${ver}${r.missing ? `  — missing: ${r.missing}` : r.title ? `  — ${r.title}` : ''}`);
    }
    return 0;
  }
  const { systems, stale, unfetched } = marketplaceDesignSystems();
  if (!systems.length) console.log('no registered marketplace offers a design system');
  for (const s of systems) {
    console.log(`${s.qualified}${s.version ? `  ${s.version}` : ''}${s.description ? ` — ${s.description}` : ''}${s.missing ? `  (${s.missing})` : ''}`);
  }
  for (const m of unfetched) console.log(`  ${m} has not been fetched yet — decklight marketplace update ${m}`);
  for (const m of stale) console.log(`  ${m}'s cached catalog could not be read — decklight marketplace update ${m}`);
  return 0;
}

async function layoutsMain(args) {
  const [ref] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight design-system layouts: needs a design system (name@marketplace)\n\n${USAGE}`); return 1; }
  const { resolveEntry, MarketplaceError } = await import('./marketplace.mjs');
  const { resolveDesignSystemRef, packageVerdict } = await import('./design-system-refs.mjs');
  let qualified = ref;
  try { qualified = resolveEntry(ref, await catalogs()).qualified; } catch (e) { if (!(e instanceof MarketplaceError)) throw e; console.error(`decklight design-system layouts: ${e.message}`); return 1; }
  const r = resolveDesignSystemRef(qualified);
  if (!r.dir) { console.error(`decklight design-system layouts: ${r.ref} — ${r.missing}`); return 1; }
  const v = packageVerdict(r.dir);
  if (!v.ok) { console.error(`decklight design-system layouts: ${r.ref} — ${v.why}`); return 1; }
  console.log(`${r.ref} — ${v.manifest.title} ${v.manifest.version}: ${v.summary.layouts.length} layout${v.summary.layouts.length === 1 ? '' : 's'}`);
  for (const l of v.summary.layouts) {
    console.log(`  ${v.manifest.name}/${l.id}${l.title && l.title !== l.id ? ` — ${l.title}` : ''}`);
    for (const slot of l.slots) {
      console.log(`    ${slot.name}${slot.required ? ' (required)' : ''}${slot.default ? ' (takes unslotted content)' : ''}${slot.hint ? `  — ${slot.hint}` : ''}`);
    }
  }
  console.log(`\n  a slide: <section data-layout="${v.manifest.name}/<layout>"> with children carrying data-slot="<slot>"`);
  return 0;
}

export async function designSystemMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  argReader(rest);
  if (sub === 'check') return checkMain(rest);
  if (sub === 'add') return addMain(rest, true);
  if (sub === 'remove') return addMain(rest, false);
  if (sub === 'list') return listMain(rest);
  if (sub === 'layouts') return layoutsMain(rest);
  console.error(`decklight design-system: unknown subcommand "${sub}" — add, remove, list, layouts, check\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await designSystemMain(process.argv.slice(2)));
