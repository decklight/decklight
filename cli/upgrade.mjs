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
 * with no Decklight.init call is refused. A multi-module deck (the kind
 * bundle --all writes) is upgraded like any other deck, with a note that a later
 * re-merge would overwrite it (#483).
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeFail, runMain } from './util.mjs';
import { PKG, PKG_ROOT, runtimeCss, runtimeJs } from './pkg.mjs';
import { bootCall, configBlock, configBlockHtml, configVersion, hasEmbeddedRuntime, isDeck, lineSpan, parseLiteral, withConfigVersion } from './runtime-link.mjs';
import { isMain } from '../tools/args.mjs';


const fail = makeFail('upgrade');

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;

/** Every <style> block inside <head>, with its offsets. Head-bounded on
 *  purpose: the inlined runtime SCRIPT in the body contains "<style" and
 *  "</style" as strings, which would corrupt a whole-document scan. (The
 *  runtime also contains "</head" — but the real head end comes first.) */
/**
 * Blank the inside of every HTML comment, preserving length and line breaks.
 *
 * A comment that *talks about* markup is still markup to a regex: smoke.html's
 * slide-15 comment says "its text lives inside a <script>", and a raw scan
 * pairs that mention with the real `</script>` several lines below, inventing a
 * block that spans the gap. Masking rather than deleting keeps every offset
 * exact, so the ranges these scanners return still index the original file —
 * and since the mask only ever rewrites characters inside comments, any match
 * found outside one is byte-identical in both strings.
 */
const maskComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

// Exported because the ingredients label (cli/audit.mjs, PRESENT#AUDIT) has to
// enumerate exactly the blocks this command knows how to find. Two scanners
// that drift apart would mean upgrade rewriting a block the audit calls
// unaccounted, or the reverse — so there is one of each.
export function headStyles(html) {
  const masked = maskComments(html);
  // The boundary comes from the MASKED copy too: read from the raw html, a
  // `</head>` mentioned in a comment ended the head early and dropped every
  // real style below it — upgrade then warned "no runtime <style> block" and
  // left the css at the old version while reporting the js upgraded.
  const headEnd = masked.search(/<\/head>/i);
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(masked))) {
    if (headEnd !== -1 && m.index >= headEnd) break;
    out.push({ start: m.index, end: m.index + m[0].length, tag: m[0], attrs: m[1], inner: m[2] });
  }
  return out;
}

/** Every <script> block, with its offsets. Safe to scan whole-document: the
 *  runtime payload is scriptSafe-escaped (init, bundle, and this command all
 *  guarantee it), so the first literal "</script>" after an opening tag is
 *  that tag's own closer. */
export function scripts(html) {
  return [...maskComments(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
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
  --link      the reverse of bundle: the deck becomes slides plus a JSON
              configuration block (the shape init writes). The embedded — or
              referenced — runtime, stylesheet and shipped themes go; author,
              present and every render add the installed ones as they serve
              it, and the active theme is named in the block. The
              Decklight.init(…) argument becomes the block when it is plain
              data; a call whose argument is code stays, as the JS API's
              escape hatch. Everything the author wrote survives
              byte-for-byte; a theme added from outside decklight stays
              embedded.

A deck that is data, or that links the runtime, is always current — it runs
whatever is installed — so upgrade only refreshes the version it records
itself as written for (the block's "decklight", or data-decklight-version on
the <script src>), which is what present --check compares.
`);
    return 0;
  }

  let file = null, dryRun = false, link = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--link') link = true;
    else if (a === '--all') fail('--all is bundle\'s merge flag, not an upgrade flag — upgrade takes one deck');
    else if (!a.startsWith('-')) file = file ?? a;
    else fail(`unknown argument: ${a}`);
  }
  if (!file) fail('no deck given');
  const deckPath = path.resolve(file);
  if (!fs.existsSync(deckPath)) fail(`deck not found: ${deckPath}`);
  const html = fs.readFileSync(deckPath, 'utf8');
  const rel = path.relative('.', deckPath) || file;

  if (!isDeck(html)) {
    fail(`${rel} is not a Decklight deck (no <div class="decklight"> found) — nothing to upgrade`);
  }
  // A multi-module deck upgrades like any other deck (#483).
  //
  // It used to be refused, and the reasoning was sound as far as it went: the
  // per-module sources are the real deck, so upgrade those and re-merge, or a
  // later `bundle --all` overwrites whatever was done here. What the refusal
  // assumed is that those files still exist. A multi-module deck that has been
  // hand-edited ever since, with the sources long gone, IS the source of
  // truth — and there the refusal protected a workflow nobody had, leaving
  // commenting out this block as the only way through.
  //
  // So it is a note, not a wall. Said once, below, with the other warnings.
  //
  // "data-module" alone also appears inside the runtime js; requiring the
  // literal "<section" prefix (absent from the runtime) keeps this precise.
  const multiModule = /<section\b[^>]*\bdata-module\s*=/i.test(html);

  // ------------------------------------------------------ runtime js block

  const allScripts = scripts(html);
  const styles = headStyles(html);
  const isSrc = (s) => /\bsrc\s*=/i.test(s.attrs);
  const definesRuntime = (s) => /(?:\bvar\s+|\bwindow\.)Decklight\s*=/.test(s.inner);
  const linked = allScripts.find((s) => /\bsrc\s*=\s*["'][^"']*decklight[^"']*\.js["']/i.test(s.attrs)) ?? null;

  // ------------------------------------------------- a deck that is data

  // Slides plus a configuration block, no runtime in the file (#520): it runs
  // whatever is installed, so it is always current. What it can be behind on
  // is its own record of the version it was written for — the block's
  // `decklight` key, which present --check compares — and that is what is
  // refreshed. --link asks for the shape it already has.
  if (!linked && !hasEmbeddedRuntime(html)) {
    const block = configBlock(html);
    if (link) { process.stdout.write(`${rel} is already slides and a configuration block — no runtime in the file\n`); return; }
    if (!block) {
      process.stdout.write(`${rel} carries no runtime and no configuration block — it plays with whatever is installed; nothing to record\n`);
      return;
    }
    if (block.error) fail(`${rel}: ${block.error}`);
    const was = configVersion(html);
    if (was === PKG.version) {
      process.stdout.write(`${rel} is slides and a configuration block, written for decklight ${PKG.version} — already current\n`);
      return;
    }
    const next = withConfigVersion(html, PKG.version);
    if (next === null) fail(`${rel}: could not record the version in the configuration block`);
    if (dryRun) {
      process.stdout.write(`${rel} — would record it as written for decklight ${PKG.version}${was ? ` (was ${was})` : ''}; nothing else changes (dry run)\n`);
      return;
    }
    fs.writeFileSync(`${deckPath}.bak`, html);
    fs.writeFileSync(deckPath, next);
    process.stdout.write(`${rel} — now recorded as written for decklight ${PKG.version}${was ? ` (was ${was})` : ''}; backup: ${rel}.bak\n`);
    return;
  }

  // ------------------------------------------- a deck that links the runtime

  // The referenced shape (#517), always current for the same reason; without
  // --link, only its record on the <script src> is refreshed.
  if (linked && !link) {
    const wasM = /\bdata-decklight-version\s*=\s*["']([^"']*)["']/i.exec(linked.attrs);
    const was = wasM?.[1] ?? null;
    if (was === PKG.version) {
      process.stdout.write(`${rel} links the runtime and is written for decklight ${PKG.version} — already current\n`);
      return;
    }
    const attrs = wasM
      ? linked.attrs.replace(wasM[0], `data-decklight-version="${PKG.version}"`)
      : `${linked.attrs} data-decklight-version="${PKG.version}"`;
    const next = `${html.slice(0, linked.start)}<script${attrs}>${linked.inner}</script>${html.slice(linked.end)}`;
    if (dryRun) {
      process.stdout.write(`${rel} links the runtime — would record it as written for decklight ${PKG.version}${was ? ` (was ${was})` : ''}; nothing else changes (dry run)\n`);
      return;
    }
    fs.writeFileSync(`${deckPath}.bak`, html);
    fs.writeFileSync(deckPath, next);
    process.stdout.write(`${rel} links the runtime — now recorded as written for decklight ${PKG.version}${was ? ` (was ${was})` : ''}; backup: ${rel}.bak\n`);
    return;
  }

  // ------------------------------------------------------ runtime js block

  let jsBlock = linked ? null
    : allScripts.find((s) => /\bdata-decklight-runtime\b/i.test(s.attrs) && !isSrc(s)) ?? null;
  if (!jsBlock && !linked) {
    // Unmarked deck: the runtime is the <script> defining Decklight, before
    // the <script>Decklight.init(...) call (init and bundle both write them
    // adjacent; scanning back tolerates an author script slipped between).
    const initAt = allScripts.findIndex((s) =>
      !isSrc(s) && /Decklight\.init\s*\(/.test(s.inner) && !definesRuntime(s));
    for (let i = initAt - 1; i >= 0; i--) {
      const s = allScripts[i];
      if (!isSrc(s) && definesRuntime(s)) { jsBlock = s; break; }
    }
    // no init call: a bundle of a deck that boots from its configuration block
    if (!jsBlock && initAt === -1) jsBlock = allScripts.find((s) => !isSrc(s) && definesRuntime(s)) ?? null;
    if (!jsBlock) {
      fail(`${rel}: could not find the inlined runtime (no <script> defining Decklight before the Decklight.init call)`);
    }
  }

  // ----------------------------------------------------- runtime css block

  const cssBlock =
    styles.find((s) => /\bdata-decklight-runtime\b/i.test(s.attrs))
    // unmarked: the first head style that is not a theme block and carries
    // the structural css (every version of it styles .decklight itself)
    ?? styles.find((s) => !/\bdata-theme\b/i.test(s.attrs) && /\.decklight\b/.test(s.inner))
    ?? null;

  // ------------------------------------------------------------ new blocks

  const distCss = runtimeCss();
  const distJs = runtimeJs();

  const edits = [];   // { start, end, text }
  const changed = [];
  const warnings = [];
  if (multiModule) {
    warnings.push('this is a multi-module deck (bundle --all). If the per-module'
      + ' sources still exist, upgrading those and re-merging keeps the merge reproducible —'
      + ' a later `bundle --all` overwrites this file');
  }

  if (link) {
    // The reverse of bundle (#520): the deck becomes slides plus a
    // configuration block. The runtime — embedded, or referenced (#517) —
    // and its stylesheet go; the ACTIVE theme becomes the block's `theme`
    // and the other shipped themes go too, since the servers link any of
    // them from the package; a theme that is not decklight's stays embedded.
    // The Decklight.init(…) argument becomes the block when it is data; a
    // call that is code stays, as the JS API's escape hatch, and the servers
    // put the engine in front of it.
    const drop = (s) => { const span = lineSpan(html, s.start, s.end); edits.push({ ...span, text: '' }); };
    const kb_ = (s) => (s.inner ? kb(s.inner) : 'a link');
    const rtTag = linked ?? jsBlock;
    drop(rtTag);
    changed.push(`runtime js (${kb_(rtTag)} → gone; the servers add it)`);
    const cssLink = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["'][^"']*decklight(?:\.min)?\.css(?:[?#][^"']*)?["'][^>]*>/gi)][0];
    if (cssBlock) { drop(cssBlock); changed.push(`runtime css (${kb(cssBlock.inner)} → gone)`); }
    else if (cssLink) { drop({ start: cssLink.index, end: cssLink.index + cssLink[0].length }); changed.push('runtime css (a link → gone)'); }
    let active = null; let dropped = 0; let kept = 0;
    const themeBlocks = styles.filter((s) => s !== cssBlock && /\bdata-theme\s*=\s*["'][\w-]+["']/i.test(s.attrs));
    for (const s of themeBlocks) {
      const name = s.attrs.match(/\bdata-theme\s*=\s*["']([\w-]+)["']/i)[1];
      const shipped = fs.existsSync(path.join(PKG_ROOT, 'themes', `${name}.css`)) && !/\bdata-theme-added\b/i.test(s.attrs);
      if (!shipped) { kept++; continue; }
      const isActive = !/\bmedia\s*=\s*["']not all["']/i.test(s.attrs);
      if (isActive && !active) active = name;
      else dropped++;
      drop(s);
    }
    const themeLink = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["'][^"']*themes\/([\w-]+)\.css(?:[?#][^"']*)?["'][^>]*>/gi)][0];
    if (themeLink && !active) {
      active = themeLink[1];
      drop({ start: themeLink.index, end: themeLink.index + themeLink[0].length });
    }
    if (active) changed.push(`theme ${active} → the configuration block${dropped ? `, ${dropped} embedded theme${dropped === 1 ? '' : 's'} dropped (the picker fetches any shipped theme)` : ''}`);
    if (kept) warnings.push(`${kept} theme${kept === 1 ? '' : 's'} not decklight's stay embedded`);

    // the configuration: the block the deck has, or the init call as data
    const boot = bootCall(html);
    const existing = configBlock(html);
    let config = existing?.config ?? null;
    if (existing?.error) fail(`${rel}: ${existing.error}`);
    if (boot) {
      const parsed = parseLiteral(boot.arg);
      if (parsed) {
        config = { ...(config ?? {}), ...parsed.value };
        drop(boot);
        changed.push('the Decklight.init call → the configuration block');
      } else {
        warnings.push('the Decklight.init argument is code, not data — the call stays as the JS API\'s escape hatch, and the servers put the engine in front of it');
      }
    }
    if (active && !kept) config = { ...(config ?? {}), theme: active };
    if (existing) {
      const inner = `\n${configBlockHtml(config ?? {}).split('\n').slice(1, -1).join('\n')}\n${' '.repeat(2)}`;
      edits.push({ start: existing.innerStart, end: existing.innerEnd, text: inner });
    } else if (config !== null || boot === null) {
      // before </head>, on its own line, where init writes it
      const headEnd = html.search(/<\/head>/i);
      const at = headEnd !== -1 ? headEnd : (boot ? boot.start : html.search(/<body\b/i));
      if (at === -1) fail(`${rel}: no <head> to hold the configuration block`);
      edits.push({ start: at, end: at, text: `${configBlockHtml(config ?? {})}\n` });
      if (!boot) changed.push('a configuration block added');
    }
  } else {
    edits.push({ start: jsBlock.start, end: jsBlock.end,
      text: `<script data-decklight-runtime="js">${distJs}</script>` });
    if (edits[0].text !== jsBlock.tag) changed.push(`runtime js (${kb(jsBlock.inner)} → ${kb(distJs)})`);
  }

  if (cssBlock && !link) {
    // Keep the closing tag's own indentation so a marked, current deck
    // round-trips byte-identical (init writes "\n<css>\n  </style>").
    const closeIndent = (cssBlock.inner.match(/\n([ \t]*)$/) || [, ''])[1];
    const text = `<style data-decklight-runtime="css">\n${distCss}\n${closeIndent}</style>`;
    edits.push({ start: cssBlock.start, end: cssBlock.end, text });
    if (text !== cssBlock.tag) changed.push(`runtime css (${kb(cssBlock.inner)} → ${kb(distCss)})`);
  } else if (!cssBlock) {
    warnings.push('no runtime <style> block found in <head> — css left alone');
  }

  // ----------------------------------------------------------- theme blocks

  let themesRefreshed = 0, themesCurrent = 0;
  for (const s of link ? [] : styles) {
    if (s === cssBlock) continue;
    const nameM = s.attrs.match(/\bdata-theme\s*=\s*["']([\w-]+)["']/i);
    if (!nameM) continue; // generated blocks (valueless data-theme) stay the author's
    const name = nameM[1];
    const cssPath = path.join(PKG_ROOT, 'themes', `${name}.css`);
    if (!fs.existsSync(cssPath)) {
      // Two different situations look identical from here (neither block is
      // in themes/), and MARKETPLACE.md OPEN 1 says they should read
      // differently: `data-theme-added` is theme add/Browse's own marker
      // (SPEC THEME_DISTRIBUTION), so a theme carrying it was never
      // decklight's to begin with — upgrade has nothing "upstream" to refresh
      // it FROM, and never fetches one (MARKETPLACE_REGISTRY's registered-
      // not-fetched invariant extends here too; a theme also carries no
      // version to pin or refuse a stale one against, unlike a transform's
      // apiVersion — THEMING is deliberate about that). Absent the marker,
      // this is a theme decklight itself used to ship and has since dropped.
      const added = /\bdata-theme-added\b/i.test(s.attrs);
      warnings.push(added
        ? `theme "${name}" was added from outside decklight (theme add/Browse) — not decklight's to refresh; kept as-is`
        : `theme "${name}" no longer ships upstream — kept as-is`);
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
  process.stdout.write(link
    ? `${rel} is now slides and a configuration block, written for decklight ${PKG.version} (${changed.join(', ')}; backup: ${rel}.bak)\n`
    : `upgraded ${rel} to decklight ${PKG.version} (${changed.join(', ')}; backup: ${rel}.bak)\n`);
}

if (isMain(import.meta.url)) process.exitCode = await runMain('upgrade', upgradeMain);
