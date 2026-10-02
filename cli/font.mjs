#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight font — the font unit (SPEC FONTS).
//
//   decklight font check <dir>
//   decklight font add|remove <name@marketplace> <deck.html> [--use]
//   decklight font list [<deck.html>]
//
// `check` is the admission gate a catalog's CI runs: a valid package prints
// what it holds and exits 0; anything else names the file and the rule and
// exits 1. Every rule lives in tools/font-format.mjs, which is pure — this file
// only reads a directory into the shape it takes.
//
// A deck depends on a font by REFERENCE (cli/font-refs.mjs): `add` writes
// `fonts` (and the shared `themeSources`) into its configuration block after
// the package passes `check`, and `--use` makes it the deck's default font.
// Every server serves the faces from the marketplace checkout; `bundle`
// carries them. Nothing is installed into ~/.decklight/.

import { existsSync, lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { checkFontPackage, FONT_API_VERSION, FACE_EXTENSIONS, FACE_WARN_BYTES } from '../tools/font-format.mjs';

const USAGE = `usage: decklight font <add|remove|list|check> …

  decklight font add <name@marketplace> <deck.html> [--use]
    reference a font from a deck — after the package passes check; the deck
    gains one entry in its configuration block, never the files. --use also
    makes it the font the deck opens in (its "font" default)
    EXAMPLE: decklight font add inter@type-mkt talk.html --use

  decklight font remove <name@marketplace> <deck.html>
    drop the reference (and the default, if it was the default)

  decklight font list [<deck.html>]
    what a deck references; with no deck, every font the registered
    marketplaces offer — from the cache alone, works on a plane

  decklight font check <dir>
    the marketplace admission gate for a font package (SPEC FONTS). Prints
    what the package holds and exits 0, or names the file and the rule for
    every problem and exits 1.
    EXAMPLE: decklight font check fonts/inter

  A font is a directory:
    font.json   apiVersion (${FONT_API_VERSION}), name, version (semver), title,
                family (the CSS name a theme writes), fallback ("system-ui, sans-serif"),
                license ("OFL.txt"), faces [{ file, weight, style }]
                + description, role (body · heading · mono · any)
    faces       ${FACE_EXTENSIONS.join(' · ')} — over ${FACE_WARN_BYTES / 1024} KB a face is a warning
    licence     the file "license" names — required: a deck that carries a font redistributes it

  A theme names a family in --font-body; a font package supplies its faces.`;

/** The first bytes of a file, as latin1 — enough for a font's magic. */
function head(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return buf.subarray(0, n).toString('latin1');
  } finally { closeSync(fd); }
}

/**
 * A package directory as `checkFontPackage` takes it: every file by its
 * /-separated path, with its size and first bytes. A symlink that resolves
 * outside the package is a problem of its own.
 */
export function readFontPackage(dir) {
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
      files.set(rel, { size: st.size, head: head(target), ...(name === 'font.json' ? { text: readFileSync(target, 'utf8') } : {}) });
    }
  };
  walk(root);
  return { manifest: files.get('font.json')?.text ?? null, files, escapes };
}

/** A package, checked — the gate's whole verdict, with symlink escapes folded in and the manifest parsed. */
export function checkFontDir(dir) {
  const { manifest, files, escapes } = readFontPackage(dir);
  if (manifest === null) {
    return { ok: false, problems: [{ file: 'font.json', rule: 'file-missing', msg: 'no font.json at the package root — this is not a font package' }], warnings: [], summary: {} };
  }
  const r = checkFontPackage({ manifest, files });
  for (const rel of escapes) r.problems.push({ file: rel, rule: 'file-outside', msg: 'a symlink that resolves outside the package — a font reaches only its own files' });
  r.ok = r.problems.length === 0;
  try { r.manifest = JSON.parse(manifest); } catch { r.manifest = null; }
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
    out.push(`✔ ${s.name} — font ${s.version}, api ${s.apiVersion}`);
    out.push(`  family     '${s.family}', ${s.fallback}  (${s.role})`);
    out.push(`  faces      ${s.faces.map((f) => `${f.weight}${f.style === 'italic' ? 'i' : ''}`).join(' · ')} — ${s.faces.length} file${s.faces.length === 1 ? '' : 's'}, ${kb(s.bytes)}`);
    out.push(`  licence    ${s.license}`);
  }
  for (const w of r.warnings ?? []) out.push(`  ⚠ ${where(w)}: ${w.msg}`);
  return out;
}

async function checkMain(args) {
  const [dir] = args.filter((a) => !a.startsWith('-'));
  if (!dir) { console.error(`decklight font check: needs a package directory\n\n${USAGE}`); return 1; }
  if (!existsSync(dir)) { console.error(`decklight font check: no such directory: ${dir}`); return 1; }
  if (!statSync(dir).isDirectory()) { console.error(`decklight font check: ${dir} is a file — a font is a directory holding font.json`); return 1; }
  const r = checkFontDir(dir);
  for (const line of reportLines(dir, r)) console.log(line);
  return r.ok ? 0 : 1;
}

function readDeckArg(cmd, deck) {
  if (!deck) { console.error(`decklight font ${cmd}: needs a deck\n\n${USAGE}`); return null; }
  const path = resolve(deck);
  if (!existsSync(path)) { console.error(`decklight font ${cmd}: no such deck: ${deck}`); return null; }
  return { path, html: readFileSync(path, 'utf8') };
}

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
  const use = args.includes('--use');
  const [ref, deck] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight font ${cmd}: needs a font and a deck\n\n${USAGE}`); return 1; }
  const d = readDeckArg(cmd, deck);
  if (!d) return 1;
  const { MarketplaceError, resolveEntry, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
  const { resolveFontRef, setFont, fontRefs } = await import('./font-refs.mjs');
  const { refForDeck } = await import('./theme-refs.mjs');
  const { writeFileAtomic } = await import('../tools/atomic-write.mjs');
  try {
    if (!on) {
      const hit = fontRefs(d.html).find((r) => r.ref === ref || r.name === ref);
      if (!hit) {
        const has = fontRefs(d.html).map((r) => r.ref);
        console.error(`decklight font remove: ${ref} is not referenced by ${deck}${has.length ? ` — it uses ${has.join(', ')}` : ' — it uses no font'}`);
        return 1;
      }
      const out = setFont(d.html, hit.ref, false);
      if (out.changed) writeFileAtomic(d.path, out.html);
      console.log(out.changed ? `dropped ${hit.ref} from ${deck} — the faces stay in their marketplace` : `${hit.ref} was not referenced by ${deck}`);
      return 0;
    }
    let qualified = ref;
    try { qualified = resolveEntry(ref, await catalogs()).qualified; } catch (e) { if (!(e instanceof MarketplaceError)) throw e; console.error(`decklight font add: ${e.message}`); return 1; }
    const r = resolveFontRef(qualified);
    if (!r.dir) { console.error(`decklight font add: ${r.ref} — ${r.missing}`); return 1; }
    const verdict = checkFontDir(r.dir);
    if (!verdict.ok) {
      for (const line of reportLines(r.dir, verdict)) console.error(line);
      console.error(`\ndecklight font add: ${r.ref} was NOT referenced — the package fails the check above`);
      return 1;
    }
    const deckRef = refForDeck(d.html, r.name, r.local, r.source ?? null);
    const out = setFont(d.html, deckRef, true, { source: r.source ?? null, use });
    if (out.changed) writeFileAtomic(d.path, out.html);
    const commit = loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null;
    recordInstall({ type: 'font', name: r.name, marketplace: r.local, version: r.entry.version ?? null, commit });
    const s = verdict.summary;
    console.log(out.changed
      ? `${deck} now uses ${deckRef} ${s.version} — '${s.family}', ${s.faces.length} face${s.faces.length === 1 ? '' : 's'}${use ? ', and opens in it' : '; pick it under / → Font…, or add --use to open in it'}`
      : `${deck} already uses ${deckRef}`);
    return 0;
  } catch (e) {
    if (e instanceof MarketplaceError) { console.error(`decklight font ${cmd}: ${e.message}`); return 1; }
    throw e;
  }
}

async function listMain(args) {
  const [deck] = args.filter((a) => !a.startsWith('-'));
  const { marketplaceFonts, fontRefs, resolveFontRef } = await import('./font-refs.mjs');
  const { markedSources } = await import('./theme-refs.mjs');
  if (deck) {
    const d = readDeckArg('list', deck);
    if (!d) return 1;
    const refs = fontRefs(d.html);
    if (!refs.length) { console.log(`${deck} uses no font package — decklight font add <name@marketplace> ${deck}`); return 0; }
    const sources = markedSources(d.html);
    for (const ref of refs) {
      const r = resolveFontRef(ref, undefined, { source: sources[ref.marketplace] ?? null });
      console.log(`${ref.ref}${r.entry?.version ? `  ${r.entry.version}` : ''}${r.missing ? `  — missing: ${r.missing}` : r.title ? `  — ${r.title}` : ''}`);
    }
    return 0;
  }
  const { fonts, stale, unfetched } = marketplaceFonts();
  if (!fonts.length) console.log('no registered marketplace offers a font');
  for (const f of fonts) {
    console.log(`${f.qualified}${f.version ? `  ${f.version}` : ''}${f.family ? `  '${f.family}'` : ''}${f.description ? ` — ${f.description}` : ''}${f.missing ? `  (${f.missing})` : ''}`);
  }
  for (const m of unfetched) console.log(`  ${m} has not been fetched yet — decklight marketplace update ${m}`);
  for (const m of stale) console.log(`  ${m}'s cached catalog could not be read — decklight marketplace update ${m}`);
  return 0;
}

export async function fontMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  argReader(rest);
  if (sub === 'check') return checkMain(rest);
  if (sub === 'add') return addMain(rest, true);
  if (sub === 'remove') return addMain(rest, false);
  if (sub === 'list') return listMain(rest);
  console.error(`decklight font: unknown subcommand "${sub}" — add, remove, list, check\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await fontMain(process.argv.slice(2)));
