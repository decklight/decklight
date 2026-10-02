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

  decklight design-system add <name@marketplace> <deck.html> [--no-recommended] [--apply|--no-apply]
    reference a design system from a deck — after the package passes check;
    the deck gains one entry in its configuration block, never the package.
    The themes and fonts it recommends come with it, in the same edit, each
    through its own gate (--no-recommended: the design system alone). Then
    it offers to APPLY its look — the deck's theme and font — asking on a
    terminal, suggesting --apply otherwise; --apply / --no-apply decide.
    EXAMPLE: decklight design-system add acme@acme-mkt talk.html

  decklight design-system apply <name@marketplace> <deck.html>
    give a deck the look a design system it uses was drawn for: its first
    recommended theme and font (bringing any that are missing)

  decklight design-system remove <name@marketplace> <deck.html>
    drop the reference; the package stays in its marketplace, and so do the
    themes and fonts it brought — other slides may use them (it lists them)

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
      // what it brought stays: other slides, or another design system, may use it
      const r = resolveDesignSystemRef(hit);
      const manifest = r.dir ? checkDir(r.dir).manifest : null;
      if (manifest) {
        const { planRecommended } = await import('./design-system-deps.mjs');
        const kept = planRecommended(out.html, { manifest, local: r.local }).items.filter((it) => it.status === 'already');
        if (kept.length) {
          console.log('  still in the deck — the themes and fonts it brought (the deck\'s theme and font are unchanged):');
          for (const it of kept) console.log(`    ${it.kind} ${it.ref}  — decklight ${it.kind} remove ${it.ref} ${deck}`);
        }
      }
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
    // its themes and fonts, in the SAME string — one write, one edit
    const recommended = !args.includes('--no-recommended');
    const deps = await import('./design-system-deps.mjs');
    const plan = deps.planRecommended(out.html, { manifest: verdict.manifest, local: r.local });
    let html = recommended ? deps.writePlan(out.html, plan) : out.html;
    let look = deps.lookOf(html, recommended ? plan : { ...plan, items: plan.items.filter((it) => it.status === 'already' || it.status === 'stack') });
    const decide = args.includes('--apply') ? true : args.includes('--no-apply') || !recommended ? false : null;
    if (decide && look.differs) html = deps.applyLook(html, look);
    if (html !== d.html) writeFileAtomic(d.path, html);
    const commit = loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null;
    recordInstall({ type: 'design-system', name: r.name, marketplace: r.local, version: r.entry.version ?? null, commit });
    if (recommended) for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
    const v = verdict.summary.version ? ` ${verdict.summary.version}` : '';
    console.log(out.changed
      ? `${deck} now uses ${deckRef}${v} — ${verdict.summary.title}; every server links it from the marketplace on this machine`
      : `${deck} already uses ${deckRef} — recorded${v} as the version you have`);
    if (recommended) for (const line of deps.planLines(plan)) console.log(line);
    else if (plan.items.some((it) => it.status === 'add')) {
      console.log('  --no-recommended: not added — what it recommends:');
      for (const it of plan.items.filter((x) => x.status === 'add')) console.log(`    ${it.kind} ${it.ref}  — decklight ${it.kind} add ${it.ref} ${deck}`);
    }
    if (look.differs) {
      const phrase = deps.lookPhrase(look, plan);
      if (decide) console.log(`applied ${look.title}'s look — ${phrase}`);
      else if (decide === null && process.stdin.isTTY && process.stdout.isTTY) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`Apply ${look.title}'s look — ${phrase}? [Y/n] `)).trim().toLowerCase();
        rl.close();
        if (answer === '' || answer === 'y' || answer === 'yes') {
          writeFileAtomic(d.path, deps.applyLook(readFileSync(d.path, 'utf8'), look));
          console.log(`applied — ${phrase}`);
        } else console.log(`kept the deck's look — decklight design-system apply ${deckRef} ${deck} applies it later`);
      } else if (decide === null) {
        console.log(`${look.title} was drawn for ${phrase} — add --apply to switch, or: decklight design-system apply ${deckRef} ${deck}`);
      }
    }
    // a recommendation that could not come is a warning, never a failure: the layouts work without it
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

/**
 * `design-system apply`: the look a design system the deck already uses was
 * drawn for — its recommended theme and font, bringing any that are missing,
 * in one edit. Idempotent: a deck already wearing it is left as it is.
 */
async function applyMain(args) {
  const [ref, deck] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight design-system apply: needs a design system and a deck\n\n${USAGE}`); return 1; }
  const d = readDeckArg('apply', deck);
  if (!d) return 1;
  const { designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
  const { markedSources } = await import('./theme-refs.mjs');
  const { writeFileAtomic } = await import('../tools/atomic-write.mjs');
  const { recordInstall } = await import('./marketplace.mjs');
  const hit = designSystemRefs(d.html).find((r) => r.ref === ref || r.name === ref);
  if (!hit) { console.error(`decklight design-system apply: ${deck} does not use ${ref} — decklight design-system add ${ref} ${deck}`); return 1; }
  const r = resolveDesignSystemRef(hit, undefined, { source: markedSources(d.html)[hit.marketplace] ?? null });
  if (!r.dir) { console.error(`decklight design-system apply: ${hit.ref} — ${r.missing}`); return 1; }
  const verdict = checkDir(r.dir);
  if (!verdict.ok) { console.error(`decklight design-system apply: ${hit.ref} no longer passes its check — decklight design-system check ${r.dir}`); return 1; }
  const deps = await import('./design-system-deps.mjs');
  const plan = deps.planRecommended(d.html, { manifest: verdict.manifest, local: r.local });
  let html = deps.writePlan(d.html, plan);
  const look = deps.lookOf(html, plan);
  if (!look.theme && !look.font) { console.log(`${hit.ref} recommends no theme or font this deck can apply`); return 0; }
  if (!look.differs && html === d.html) { console.log(`${deck} already wears ${look.title}'s look`); return 0; }
  html = deps.applyLook(html, look);
  writeFileAtomic(d.path, html);
  for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
  for (const line of deps.planLines(plan).filter((l) => !/^\s+=/.test(l))) console.log(line);
  console.log(look.differs ? `applied ${look.title}'s look — ${deps.lookPhrase(look, plan)}` : `${deck} already wore ${look.title}'s look`);
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
  if (sub === 'apply') return applyMain(rest);
  console.error(`decklight design-system: unknown subcommand "${sub}" — add, remove, apply, list, layouts, check\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await designSystemMain(process.argv.slice(2)));
