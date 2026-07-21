#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight upgrade — bring a self-contained deck's inlined runtime up to the
 * installed version, touching nothing the author wrote.
 *
 *   decklight upgrade <deck.html> [--dry-run]
 *
 * What gets swapped (by exact string surgery — the author's sections, notes,
 * Decklight.init config, inlined casts and whitespace survive byte-for-byte):
 *   - the runtime <style> + <script> blocks → the installed dist/ builds,
 *     re-marked data-decklight-runtime="css|js" so the next upgrade finds
 *     them trivially. Unmarked decks (everything init and bundle wrote before
 *     the marker existed) are recognized too: the runtime style is the first
 *     head <style> carrying the structural css, the runtime script is the one
 *     defining Decklight before the <script>Decklight.init call.
 *   - <style data-theme="name"> blocks → the installed themes/<name>.css,
 *     preserving which one is active (the media="not all" pattern). A theme
 *     that no longer ships upstream is kept as-is with a warning.
 *
 * In place, with <deck>.html.bak written first; --dry-run prints what would
 * change and touches nothing; a second run reports "already current". A file
 * with no Decklight.init call, and a merged multi-module bundle
 * (bundle --all), are refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFail, scriptSafe } from './util.mjs';
import { isMain } from '../tools/args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

const fail = makeFail('upgrade');

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;

/** Every <style> block inside <head>, with its offsets. Head-bounded on
 *  purpose: the inlined runtime SCRIPT in the body contains "<style" and
 *  "</style" as strings, which would corrupt a whole-document scan. (The
 *  runtime also contains "</head" — but the real head end comes first.) */
function headStyles(html) {
  const headEnd = html.search(/<\/head>/i);
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (headEnd !== -1 && m.index >= headEnd) break;
    out.push({ start: m.index, end: m.index + m[0].length, tag: m[0], attrs: m[1], inner: m[2] });
  }
  return out;
}

/** Every <script> block, with its offsets. Safe to scan whole-document: the
 *  runtime payload is scriptSafe-escaped (init, bundle, and this command all
 *  guarantee it), so the first literal "</script>" after an opening tag is
 *  that tag's own closer. */
function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length, tag: m[0], attrs: m[1], inner: m[2] }));
}

export async function upgradeMain(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`decklight upgrade — bring a self-contained deck's runtime up to the installed version

Usage:
  decklight upgrade <deck.html> [--dry-run]

Replaces the deck's inlined runtime css + js blocks with the installed
package's dist/ builds and refreshes its embedded <style data-theme> blocks
from the installed themes/ (the active theme stays active; a theme that no
longer ships is kept as-is with a warning). Everything the author wrote —
sections, notes, the Decklight.init config, inlined casts, custom styles —
survives byte-for-byte.

In place, with <deck>.html.bak written first. Both the marked blocks this
tool (and init) writes and older unmarked init/bundle output are recognized.

Options:
  --dry-run   print what would change; write nothing
`);
    process.exit(0);
  }

  let file = null, dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--all') fail('--all is bundle\'s merge flag — upgrade works on single decks; upgrade the source modules, then re-merge');
    else if (!a.startsWith('-')) file = file ?? a;
    else fail(`unknown argument: ${a}`);
  }
  if (!file) fail('no deck given');
  const deckPath = path.resolve(file);
  if (!fs.existsSync(deckPath)) fail(`deck not found: ${deckPath}`);
  const html = fs.readFileSync(deckPath, 'utf8');
  const rel = path.relative('.', deckPath) || file;

  if (!/Decklight\.init\s*\(/.test(html)) {
    fail(`${rel} is not a Decklight deck (no Decklight.init call found) — nothing to upgrade`);
  }
  // "data-module" alone also appears inside the runtime js; requiring the
  // literal "<section" prefix (absent from the runtime) keeps this precise.
  if (/<section\b[^>]*\bdata-module\s*=/i.test(html)) {
    fail(`${rel} is a merged multi-module bundle (bundle --all) — upgrade works on single decks; upgrade the source modules, then re-merge`);
  }

  // ------------------------------------------------------ runtime js block

  const allScripts = scripts(html);
  let jsBlock = allScripts.find((s) => /\bdata-decklight-runtime\b/i.test(s.attrs)) ?? null;
  if (!jsBlock) {
    // Unmarked deck: the runtime is the <script> defining Decklight, before
    // the <script>Decklight.init(...) call (init and bundle both write them
    // adjacent; scanning back tolerates an author script slipped between).
    const definesRuntime = (s) => /(?:\bvar\s+|\bwindow\.)Decklight\s*=/.test(s.inner);
    const initAt = allScripts.findIndex((s) =>
      !/\bsrc\s*=/i.test(s.attrs) && /Decklight\.init\s*\(/.test(s.inner) && !definesRuntime(s));
    for (let i = initAt - 1; i >= 0; i--) {
      const s = allScripts[i];
      if (!/\bsrc\s*=/i.test(s.attrs) && definesRuntime(s)) { jsBlock = s; break; }
    }
    if (!jsBlock) {
      if (allScripts.some((s) => /\bsrc\s*=\s*["'][^"']*decklight[^"']*\.js["']/i.test(s.attrs))) {
        fail(`${rel} references the runtime by src= — it is not self-contained, so there is nothing inlined to upgrade (its decklight.{js,css} files are the thing to update; decklight bundle produces a self-contained file)`);
      }
      fail(`${rel}: could not find the inlined runtime (no <script> defining Decklight before the Decklight.init call)`);
    }
  }

  // ----------------------------------------------------- runtime css block

  const styles = headStyles(html);
  const cssBlock =
    styles.find((s) => /\bdata-decklight-runtime\b/i.test(s.attrs))
    // unmarked: the first head style that is not a theme block and carries
    // the structural css (every version of it styles .decklight itself)
    ?? styles.find((s) => !/\bdata-theme\b/i.test(s.attrs) && /\.decklight\b/.test(s.inner))
    ?? null;

  // ------------------------------------------------------------ new blocks

  const distCss = fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.css'), 'utf8');
  const distJs = scriptSafe(
    fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.js'), 'utf8')
      .replace(/\/\/# sourceMappingURL=.*$/m, ''));

  const edits = [];   // { start, end, text }
  const changed = [];
  const warnings = [];

  edits.push({ start: jsBlock.start, end: jsBlock.end,
    text: `<script data-decklight-runtime="js">${distJs}</script>` });
  if (edits[0].text !== jsBlock.tag) changed.push(`runtime js (${kb(jsBlock.inner)} → ${kb(distJs)})`);

  if (cssBlock) {
    // Keep the closing tag's own indentation so a marked, current deck
    // round-trips byte-identical (init writes "\n<css>\n  </style>").
    const closeIndent = (cssBlock.inner.match(/\n([ \t]*)$/) || [, ''])[1];
    const text = `<style data-decklight-runtime="css">\n${distCss}\n${closeIndent}</style>`;
    edits.push({ start: cssBlock.start, end: cssBlock.end, text });
    if (text !== cssBlock.tag) changed.push(`runtime css (${kb(cssBlock.inner)} → ${kb(distCss)})`);
  } else {
    warnings.push('no runtime <style> block found in <head> — css left alone');
  }

  // ----------------------------------------------------------- theme blocks

  let themesRefreshed = 0, themesCurrent = 0;
  for (const s of styles) {
    if (s === cssBlock) continue;
    const nameM = s.attrs.match(/\bdata-theme\s*=\s*["']([\w-]+)["']/i);
    if (!nameM) continue; // generated blocks (valueless data-theme) stay the author's
    const name = nameM[1];
    const cssPath = path.join(PKG_ROOT, 'themes', `${name}.css`);
    if (!fs.existsSync(cssPath)) {
      warnings.push(`theme "${name}" no longer ships upstream — kept as-is`);
      continue;
    }
    const fresh = fs.readFileSync(cssPath, 'utf8');
    if (s.inner.trim() === fresh.trim()) { themesCurrent++; continue; }
    // Swap only the css between the tags: the opening tag (media="not all"
    // or active, plus any author attrs) and surrounding whitespace survive.
    const lead = s.inner.match(/^\s*/)[0];
    const trail = s.inner.match(/\s*$/)[0];
    edits.push({ start: s.start, end: s.end,
      text: `<style${s.attrs}>${lead}${fresh.trim()}${trail}</style>` });
    themesRefreshed++;
  }
  if (themesRefreshed) changed.push(`${themesRefreshed} theme${themesRefreshed > 1 ? 's' : ''} refreshed`);

  // --------------------------------------------------------------- assemble

  let next = html;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  }

  for (const w of warnings) process.stdout.write(`warning: ${w}\n`);

  if (next === html) {
    process.stdout.write(`${rel} is already current (decklight ${PKG.version})\n`);
    return;
  }

  if (dryRun) {
    process.stdout.write(`${rel} → decklight ${PKG.version} (dry run — nothing written):\n`);
    for (const c of changed) process.stdout.write(`  would update ${c.replace(' refreshed', '')}\n`);
    if (themesCurrent) process.stdout.write(`  ${themesCurrent} theme${themesCurrent > 1 ? 's' : ''} already current\n`);
    process.stdout.write(`  would back up first: ${rel}.bak\n`);
    return;
  }

  fs.writeFileSync(`${deckPath}.bak`, html);
  fs.writeFileSync(deckPath, next);
  process.stdout.write(`upgraded ${rel} to decklight ${PKG.version} (${changed.join(', ')}; backup: ${rel}.bak)\n`);
}

if (isMain(import.meta.url)) await upgradeMain();
