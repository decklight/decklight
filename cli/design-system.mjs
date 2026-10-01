#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight design-system — the design-system unit (SPEC DESIGN_SYSTEMS).
//
//   decklight design-system check <dir>
//
// `check` is the admission gate a catalog's own CI runs, in the mould of
// `decklight extension check` and `decklight theme check`: a valid package
// prints what it holds and exits 0; a broken or unsafe one names the file,
// the line and the rule for every problem, and exits 1. Every rule lives in
// tools/design-system-format.mjs, which is pure — this file only reads a
// directory into the shape it takes.
//
// Nothing here installs, references or serves a design system: a deck depends
// on one by reference, from the marketplace checkout, like a marked theme.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { checkPackage, DESIGN_SYSTEM_API_VERSION, ASSET_EXTENSIONS } from '../tools/design-system-format.mjs';

const USAGE = `usage: decklight design-system <check> …

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

  A deck references a design system rather than copying it; that, and the
  slide syntax that fills a layout's slots, arrive with the rest of the series.`;

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

export async function designSystemMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  argReader(rest);
  if (sub === 'check') return checkMain(rest);
  console.error(`decklight design-system: unknown subcommand "${sub}" — this decklight has: check\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await designSystemMain(process.argv.slice(2)));
