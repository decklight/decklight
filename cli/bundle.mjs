#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight bundle — flatten Decklight decks into ONE self-contained HTML file
 * (send it to anyone; opens from disk, no server, no sibling files).
 *
 *   decklight bundle <deck.html> [-o out.html] [--themes …]              single deck
 *   decklight bundle <deck.html> --all [-o out.html] [--title "…"]       whole playlist, merged
 *   decklight bundle <a.html> <b.html> … [-o out.html] [--title "…"]     explicit list, merged
 *
 * What gets inlined:
 *   - the runtime  : <script src=…decklight.js>  → <script>…</script>
 *   - structure css: <link …decklight.css>       → <style>…</style>
 *   - themes       : the theme <link> is replaced by <style data-theme="name">
 *                    blocks (inactive ones carry media="not all"; the engine's
 *                    inline-theme mode toggles them — picker/?theme= work).
 *                    Every theme the deck MARKS from a marketplace
 *                    ("markedThemes") is inlined too, from this machine's
 *                    copy of that marketplace (SPEC THEME_DISTRIBUTION).
 *   - terminals    : data-cast="url" casts are embedded and switched to
 *                    data-cast-inline (fetch is blocked on file://).
 *   - images       : <img src>, data-background-image and data-background-poster
 *                    → data: URIs (background VIDEOS stay external, with a notice).
 *   - design systems: every one the deck references ("designSystems") — its
 *                    stylesheet with each relative url() as a data: URI, its
 *                    meta and its layouts, the blocks every server injects
 *                    (SPEC DESIGN_SYSTEMS), so layouts expand from file://.
 *   - audio        : with --audio, every recorded narration file (a track's
 *                    folder, a local manifest's files) as a data: URI the
 *                    runtime plays in place of the path; `--audio aac|opus`
 *                    re-encodes each small first. Off by default.
 *   - fonts        : every font package the deck references ("fonts") — its
 *                    faces as data: URIs in @font-face rules, and its meta
 *                    (SPEC FONTS), so the type is the same from file://.
 *
 * MERGE mode (--all or several inputs): every module's <section>s are
 * concatenated into one deck, in order. Each module's first section gets
 * data-module="<title>" — the engine's module menu (M) and chrome tag then
 * navigate in-file instead of across files, and the per-module playlist
 * config is stripped (it has no meaning inside a single file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeFail, scriptSafe, runMain } from './util.mjs';
import { inlineRuntime, packageAsset, PKG, THEMES_DIR } from './pkg.mjs';
import { configBlock, firstExecutableScript, hasEmbeddedRuntime, hasRuntime, linkRuntime } from './runtime-link.mjs';
import { addedThemeStyle, markedRefs, markedShipped, markedSources, resolveThemeRef, stillValid } from './theme-refs.mjs';
import { bundleDesignSystem, designSystemRefs, packageVerdict, resolveDesignSystemRef } from './design-system-refs.mjs';
import { bundleFont, fontRefs, fontVerdict, resolveFontRef } from './font-refs.mjs';
import { MarketplaceError } from './marketplace.mjs';
import { escapeHtml } from '../tools/escape.mjs';
import { isMain } from '../tools/args.mjs';
import { AUDIO_CHOICES, CODECS, estimateAudio, inlineAudio, narrationAudio, sizeLabel } from './bundle-audio.mjs';
import { injectBeforeBodyEnd } from '../tools/deck-html.mjs';

const fail = makeFail('bundle');


// Unescape a single-quoted JS string body ('·', '’', \' …).
function unescapeJs(raw) {
  try {
    return JSON.parse('"' + raw.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
  } catch {
    return raw;
  }
}

/** Locate the .decklight container and its content bounds (div-depth aware —
 *  sections contain nested divs, so a lazy regex would close too early). */
function containerBounds(html) {
  const openM = html.match(/<div\b[^>]*class=["'][^"']*\bdecklight\b[^"']*["'][^>]*>/i);
  if (!openM) return null;
  const contentStart = openM.index + openM[0].length;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = contentStart;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) {
      return { start: openM.index, contentStart, contentEnd: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/** Cut `const PLAYLIST = {…};` (brace-matched) and the `playlist: X` init
 *  property out of the deck being bundled — cross-file navigation has no meaning
 *  inside one file; in-file data-module markers replace it. */
function stripPlaylist(html) {
  const declM = html.match(/const\s+PLAYLIST\s*=\s*/);
  if (declM) {
    let i = declM.index + declM[0].length, depth = 0, end = -1;
    for (; i < html.length; i++) {
      const c = html[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end !== -1) {
      if (html[end] === ';') end++;
      html = html.slice(0, declM.index) + html.slice(end);
    }
  }
  html = html.replace(/,\s*playlist\s*:\s*(?:[A-Za-z_$][\w$]*|\{[^{}]*\})/, '');
  html = html.replace(/playlist\s*:\s*(?:[A-Za-z_$][\w$]*|\{[^{}]*\})\s*,\s*/, '');
  return html;
}

/** Parse the playlist modules ({title, href} pairs) out of a deck's source. */
function parsePlaylist(html) {
  const out = [];
  const re = /\{\s*title:\s*'((?:[^'\\]|\\.)*)'\s*,\s*href:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
  let m;
  while ((m = re.exec(html))) out.push({ title: unescapeJs(m[1]), href: unescapeJs(m[2]) });
  return out;
}

function titleOf(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].replace(/\s*\([^)]*port\)\s*$/i, '').trim() : fallback;
}

// ------------------------------------------------------------------- merge

/**
 * Merge module decks into the first one: concatenated sections, per-module
 * data-module markers on each first section, cast <script type=json> blocks
 * carried along with per-module id prefixes, relative asset refs rebased
 * onto the first deck's directory.
 */
function mergeDecks(jobs, baseDir, notices) {
  const base = fs.readFileSync(jobs[0].path, 'utf8');
  const baseBounds = containerBounds(base);
  if (!baseBounds) fail(`no .decklight container in ${jobs[0].path}`);

  const markSections = (inner, title) =>
    inner.replace(/<section\b/, `<section data-module="${escapeHtml(title)}"`);

  const castScriptRe = /<script\b[^>]*type=["']application\/json["'][^>]*id=["']([^"']+)["'][^>]*>[\s\S]*?<\/script>/gi;

  let mergedInner = markSections(
    base.slice(baseBounds.contentStart, baseBounds.contentEnd), jobs[0].title);
  const carried = [];
  const seenIds = new Set([...base.matchAll(castScriptRe)].map((m) => m[1]));

  for (let k = 1; k < jobs.length; k++) {
    const { path: modPath, title } = jobs[k];
    let mod = fs.readFileSync(modPath, 'utf8');
    const modDir = path.dirname(modPath);
    const prefix = `m${k + 1}-`;

    // Pull the module's embedded cast blocks out (they live outside the
    // container) and prefix their ids so merged ids stay unique.
    const blocks = [];
    mod = mod.replace(castScriptRe, (tag, id) => {
      blocks.push(tag.replace(`id="${id}"`, `id="${prefix}${id}"`)
                     .replace(`id='${id}'`, `id='${prefix}${id}'`));
      return '';
    });

    const bounds = containerBounds(mod);
    if (!bounds) fail(`no .decklight container in ${modPath}`);
    let inner = mod.slice(bounds.contentStart, bounds.contentEnd);

    // Rewire inline-cast refs to the prefixed ids.
    inner = inner.replace(/data-cast-inline=["']#([^"']+)["']/g,
      (t, id) => `data-cast-inline="#${prefix}${id}"`);

    // Rebase relative asset urls onto the first deck's directory.
    if (path.resolve(modDir) !== path.resolve(baseDir)) {
      const rebase = (rel) => path.relative(baseDir, path.resolve(modDir, rel)).split(path.sep).join('/');
      inner = inner.replace(
        /\b(data-cast|data-background-image|data-background-video|data-background-poster|src)=["'](?!#|data:|https?:|\/\/)([^"']+)["']/g,
        (t, attr, rel) => `${attr}="${rebase(rel)}"`);
    }

    for (const b of blocks) {
      const id = b.match(/id=["']([^"']+)["']/)[1];
      if (seenIds.has(id)) fail(`duplicate embedded cast id after merge: ${id}`);
      seenIds.add(id);
      carried.push(b);
    }
    mergedInner += '\n\n    <!-- ==================== module: ' + title.replace(/--/g, '—') + ' ==================== -->\n'
      + markSections(inner, title);
  }

  // Carried cast blocks must land BEFORE the runtime/init scripts: classic
  // scripts execute while the parser is mid-document, so anything inserted
  // after them is not yet in the DOM when the player looks its id up.
  // Right after the container's closing </div> matches the layout of decks
  // that author their casts inline (which is why single-deck bundles worked).
  const tail = base.slice(baseBounds.contentEnd); // begins with the container's </div>
  const closeLen = tail.match(/^<\/div>/i)[0].length;
  let html = base.slice(0, baseBounds.contentStart) + mergedInner
    + tail.slice(0, closeLen)
    + (carried.length ? '\n' + carried.join('\n') : '')
    + tail.slice(closeLen);
  html = stripPlaylist(html);
  notices.push(`merged ${jobs.length} modules: ${jobs.map((j) => j.title).join(' · ')}`);
  return html;
}

// ---------------------------------------------------------------- arguments

/** `client` is the sigstore seam — see publishMain; omitted, the real one is used. */
export async function bundleMain(argv = process.argv.slice(2), { client, estimate = false } = {}) {

if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`decklight bundle — flatten deck(s) into one self-contained HTML file

Usage:
  decklight bundle <deck.html> [-o out.html] [--audio [original|aac|opus]] [--sign] [--deck] [--themes current|all|…]
  decklight bundle <deck.html> --all [-o out.html] [--title "…"] [--themes …]
  decklight bundle <a.html> <b.html> … [-o out.html] [--title "…"] [--themes …]

Options:
  -o <file>        output path (default: <deck>-standalone.html, or
                   <deck>-course.html when merging)
  --all            follow the deck's playlist and merge EVERY module into
                   one single-file presentation (in-file module menu via
                   data-module markers)
  --sign           sign the output with Sigstore keyless and write a detached
                   <out>.sig beside it. There are no keys: signing mints a
                   short-lived certificate against an OIDC identity — the
                   ambient token in CI, or SIGSTORE_ID_TOKEN — and needs the
                   network. Plain bundle neither signs nor warns: offline-clean
                   by default, never silently unsigned.
  --deck           also write <out>.decklight — the deck, its signature and a
                   manifest as ONE file, which is what gets forwarded. Implies
                   --sign, because the container is the signed artifact. A
                   .decklight renamed to .html still plays in a browser: the
                   deck comes first in the file and the metadata is appended.
  --title <t>      <title> for the multi-module deck
  --transform <name>  run an installed build-time transform (decklight transform
                   add <name>) on the deck's own source before anything else
                   is inlined — repeatable, applied in the order given
  --themes <sel>   which shipped themes to embed:
                     current       just the deck's linked theme (default)
                     all           every theme in the deck's themes/ directory
                     name,name,…   an explicit list (the deck's linked theme
                                   stays active when included, else the first)
                   every theme the deck MARKS ("markedThemes") is embedded as
                   well, whichever you choose
  --theme <name>   the theme the bundle opens on — a shipped theme (embedded
                   alongside the others) or one the deck marks
  --audio [how]    carry the narration's recorded audio inside the file, so
                   it plays from disk with nothing beside it:
                     original      the files as recorded (the default)
                     aac           mono AAC at 32 kbps, ~4 KB a second of
                                   voice, plays in every browser
                     opus          mono Opus at 24 kbps, ~3 KB a second,
                                   the smallest (Safari from 17)
                   aac and opus need ffmpeg and cost some quality. Off by
                   default: a talk's audio is tens of MB, so it stays beside
                   the deck and the bundle names the folder to send with it
                   (--no-audio says so explicitly)
  --allow-missing-design-systems
                   bundle even when a design system the deck uses cannot be
                   read on this machine: it is left out, and the slides that
                   name its layouts render plainly wherever the file opens
  --allow-missing-fonts
                   bundle even when a font the deck references cannot be read
                   on this machine: it is left out, and the theme's own font
                   stack shows wherever the file opens
`);
  return 0;
}

const inputs = [];
let outPath = null, themesSel = 'current', all = false, mergedTitle = null, sign = false, deckFile = false, openOn = null;
let allowMissingSystems = false;
let allowMissingFonts = false;
let audioChoice = null;
const transformNames = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') outPath = argv[++i];
  else if (a === '--themes') themesSel = argv[++i];
  else if (a === '--theme') openOn = argv[++i];
  else if (a === '--all') all = true;
  else if (a === '--transform') transformNames.push(argv[++i]);
  else if (a === '--sign') sign = true;
  // --deck implies --sign rather than erroring on the pair: the container IS
  // the signed artifact, so an unsigned one would be a zip wearing the name of
  // an attestation. Naming the implication beats refusing the obvious command.
  else if (a === '--deck') { deckFile = true; sign = true; }
  else if (a === '--title') mergedTitle = argv[++i];
  else if (a === '--allow-missing-design-systems') allowMissingSystems = true;
  else if (a === '--allow-missing-fonts') allowMissingFonts = true;
  // `--audio` alone is the files as recorded; a codec after it re-encodes them
  else if (a === '--audio') audioChoice = AUDIO_CHOICES.includes(argv[i + 1]) ? argv[++i] : 'original';
  else if (a === '--no-audio') audioChoice = null;
  else if (!a.startsWith('-')) inputs.push(a);
  else fail(`unknown argument: ${a}`);
}
if (!inputs.length) fail('no deck given');
if (all && inputs.length > 1) fail('--all takes a single deck (it follows that deck’s playlist)');

const firstPath = path.resolve(inputs[0]);
if (!fs.existsSync(firstPath)) fail(`deck not found: ${firstPath}`);
const deckDir = path.dirname(firstPath);
const notices = [];

// Build the job list (merge mode when --all or several inputs).
let jobs = null;
if (all) {
  const src = fs.readFileSync(firstPath, 'utf8');
  const modules = parsePlaylist(src);
  if (!modules.length) fail('--all: the deck has no parseable playlist ({ title, href } modules)');
  jobs = modules.map((m) => {
    const p = path.resolve(deckDir, m.href);
    if (!fs.existsSync(p)) fail(`playlist module not found: ${m.href} (${p})`);
    return { path: p, title: m.title };
  });
} else if (inputs.length > 1) {
  jobs = inputs.map((rel, i) => {
    const p = path.resolve(rel);
    if (!fs.existsSync(p)) fail(`deck not found: ${p}`);
    return { path: p, title: titleOf(fs.readFileSync(p, 'utf8'), `Module ${i + 1}`) };
  });
}

let html;
if (jobs) {
  html = mergeDecks(jobs, deckDir, notices);
  const t = mergedTitle ||
    (jobs[0].title || '').replace(/^\d+\s*[·.:-]\s*/, '') || 'Presentation';
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(t)}</title>`);
  outPath = path.resolve(outPath ||
    path.join(deckDir, path.basename(firstPath, '.html') + '-course.html'));
} else {
  html = fs.readFileSync(firstPath, 'utf8');
  outPath = path.resolve(outPath ||
    path.join(deckDir, path.basename(firstPath, '.html') + '-standalone.html'));
}

// What went into the file and where each piece came from, said once at the end
// as two lines — the runtime and the themes — rather than a note per file.
const fromInstall = new Set();   // decklight.js / decklight.css read from the installed package
const read = (rel) => {
  const p = path.resolve(deckDir, rel);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  // A deck that LINKS the runtime ships no decklight.js beside itself: the
  // servers answer it from the installed package, and so does this (#517) —
  // what a bundle carries is what the deck was playing with.
  const asset = packageAsset(rel);
  if (asset) { fromInstall.add(path.basename(rel)); return fs.readFileSync(asset.file, 'utf8'); }
  fail(`referenced file not found: ${rel} (${p})`);
};

// --------------------------------------------------------------- transforms

// EXTENSIONS#LOADER. Deliberately BEFORE every other section below: a
// transform sees the deck's own source, the way the author wrote it, not
// decklight's runtime/theme/images already spliced in (SPEC
// EXTENSIONS_TRANSFORMS) — and that puts it ahead of signing for free, since
// everything in this file runs top to bottom before the sign step near the end.
if (transformNames.length) {
  const { runTransform, LoaderError } = await import('./loader.mjs');
  for (const name of transformNames) {
    let result;
    try {
      result = await runTransform(name, html);
    } catch (e) {
      if (e instanceof LoaderError) fail(e.message);
      throw e;
    }
    html = result.html;
    notices.push(`transform ${name} applied`
      + (result.checked ? '' : ' (no cached catalog entry — apiVersion not checked)'));
  }
}

// ---------------------------------------------------------- theme selection

// The deck as the author wrote it, before anything is spliced in. The playlist
// check below reads THIS: the runtime's own source says `playlist:` too, and
// matching the inlined page flagged every deck that links the runtime.
const sourceHtml = html;

// A deck as data (#520) carries no runtime at all: the servers reference it
// on the way out, and so does this — the same references, added by the same
// function — after which it is the linked deck the sections below already
// know how to flatten. What a bundle embeds is what the deck was playing with.
const linked = !hasRuntime(html);
if (linked) {
  html = linkRuntime(html);
  // said in the summary: the source deck carries no runtime of its own
}

const themeLinkRe = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']*themes\/([\w-]+)\.css)["'][^>]*>/i;
const themeLinkM = html.match(themeLinkRe);
// An imported deck whose theme was derived from the file's own palette embeds
// that one theme and nothing else (DECK_IMPORT): it has no link to flatten and
// no runtime yet, and the theme it has is the theme it keeps. An ADDED theme
// (`data-theme-added`, what `theme add` pasted in before 0.9.0) is not the
// deck's own: it is an extra over the base theme, and taking it for the base
// bundled a deck whose only theme was somebody else's.
const OWN_THEME_STYLE = /<style\b(?![^>]*\bdata-theme-added\b)[^>]*\bdata-theme\b/i;
const ownTheme = !themeLinkM && linked && OWN_THEME_STYLE.test(html);
if (!themeLinkM && !ownTheme) {
  // A deck with its themes already INLINE is the common way to arrive here —
  // `decklight init` scaffolds one, and the README's own quick start goes
  // straight from init to bundle. Blaming a missing <link> sends that reader
  // looking for markup they were never supposed to have, when the honest
  // answer is that there is nothing left to flatten.
  const inlined = OWN_THEME_STYLE.test(html);
  fail(inlined
    ? 'this deck is already self-contained — its themes are inline <style data-theme> blocks.\n'
      + '  bundle is for a deck that REFERENCES dist/ and themes/ by URL; there is nothing here to flatten.\n'
      + '  to refresh its inlined runtime and themes instead: decklight upgrade <deck.html>'
    : 'no theme <link> (href matching themes/<name>.css) found in the deck');
}
const [themeLinkTag, themeHref, linkedTheme] = themeLinkM ?? [null, 'themes/', null];
const themesDir = path.resolve(deckDir, path.dirname(themeHref));
// A linked deck ships no themes/ beside itself: what it links is answered by
// the installed package when served, and inlined from there here (#517). A
// folder on disk wins, per theme and for the `all` listing alike.
const themeFile = (name) => {
  const own = path.join(themesDir, `${name}.css`);
  if (fs.existsSync(own)) return own;
  const shipped = path.join(THEMES_DIR, `${name}.css`);
  return fs.existsSync(shipped) ? shipped : null;
};

let themeNames;
if (ownTheme) {
  themeNames = [html.match(/<style\b(?![^>]*\bdata-theme-added\b)[^>]*\bdata-theme\s*=\s*["']([\w-]+)["']/i)?.[1] ?? 'own'];
  if (themesSel !== 'all' && themesSel !== 'current') notices.push('--themes ignored: the deck embeds a theme of its own, and that is the one it keeps');
} else if (themesSel === 'current') {
  themeNames = [linkedTheme];
} else if (themesSel === 'all') {
  themeNames = fs.readdirSync(fs.existsSync(themesDir) ? themesDir : THEMES_DIR).filter((f) => f.endsWith('.css'))
    .map((f) => f.replace(/\.css$/, '')).sort();
} else {
  themeNames = themesSel.split(',').map((s) => s.trim()).filter(Boolean);
}
// The themes the deck MARKS travel with it: resolved from this machine's
// marketplaces now, inlined below, and never linked — a reference to a
// marketplace means nothing to whoever opens the file (SPEC THEME_DISTRIBUTION).
// A marked name is not a file in themes/, so it leaves the shipped list here.
const markedFrom = markedSources(sourceHtml);
const marked = markedRefs(sourceHtml).map((r) => {
  const hit = resolveThemeRef(r, undefined, { source: markedFrom[r.marketplace] ?? null });
  if (!hit.file) fail(`the deck marks ${r.ref}, and this machine cannot read it — ${hit.missing}`);
  const valid = stillValid(hit.file);
  if (!valid.ok) fail(`the deck marks ${r.ref}, and ${valid.why}`);
  return hit;
});
const markedNames = marked.map((r) => r.name);
// Design systems (SPEC DESIGN_SYSTEMS) travel like marked themes: resolved
// from this machine's checkouts now, carried as bytes, never linked. Merged,
// every module's count — once per name and version; one name at two
// versions has no single right answer, so it is refused.
const systems = [];          // { ref, name, version, marketplace, block }
const systemsLeftOut = [];   // { ref, why }
{
  const decks = jobs
    ? jobs.map((j) => ({ label: j.title, html: fs.readFileSync(j.path, 'utf8') }))
    : [{ label: path.basename(firstPath), html: sourceHtml }];
  const byName = new Map();
  for (const d of decks) {
    const from = markedSources(d.html);
    for (const ref of designSystemRefs(d.html)) {
      const r = resolveDesignSystemRef(ref, undefined, { source: from[ref.marketplace] ?? null });
      const verdict = r.dir ? packageVerdict(r.dir) : null;
      // a package that is HERE but broken is its author's bug, never papered over
      if (verdict && !verdict.ok) fail(`the deck uses the design system ${ref.ref}, and ${verdict.why}`);
      const why = r.missing;
      if (why) {
        if (!allowMissingSystems) {
          fail(`the deck uses the design system ${ref.ref}, and this machine cannot read it — ${why}
`
            + '  (--allow-missing-design-systems bundles without it: its slides render plainly)');
        }
        if (!systemsLeftOut.some((x) => x.ref === ref.ref)) systemsLeftOut.push({ ref: ref.ref, why });
        continue;
      }
      const version = String(verdict.manifest.version ?? '');
      const seen = byName.get(ref.name);
      if (seen) {
        if (seen.version !== version) {
          fail(`two modules use the design system "${ref.name}" at different versions — ${seen.label} has ${seen.version}, ${d.label} has ${version}; one file can carry one`);
        }
        continue;
      }
      let block;
      try { block = bundleDesignSystem(r, verdict); } catch (e) {
        if (e instanceof MarketplaceError) fail(`the design system ${ref.ref}: ${e.message}`);
        throw e;
      }
      byName.set(ref.name, { version, label: d.label });
      systems.push({ ref: ref.ref, name: ref.name, version, marketplace: ref.marketplace, block });
      for (const url of block.external) notices.push(`design system ${ref.ref}: url(${url}) stays external — it will not show offline`);
    }
  }
  for (const x of systemsLeftOut) notices.push(`design system ${x.ref} not carried — ${x.why}; the slides that use it render plainly`);
}

// Fonts (SPEC FONTS) the same way: resolved from the checkouts, carried as
// bytes, once per name; a font here but broken is refused whatever the flag.
const fonts = [];          // { ref, name, version, marketplace, block }
const fontsLeftOut = [];   // { ref, why }
{
  const decks = jobs
    ? jobs.map((j) => ({ label: j.title, html: fs.readFileSync(j.path, 'utf8') }))
    : [{ label: path.basename(firstPath), html: sourceHtml }];
  const byName = new Map();
  for (const d of decks) {
    const from = markedSources(d.html);
    for (const ref of fontRefs(d.html)) {
      const r = resolveFontRef(ref, undefined, { source: from[ref.marketplace] ?? null });
      const verdict = r.dir ? fontVerdict(r.dir) : null;
      if (verdict && !verdict.ok) fail(`the deck uses the font ${ref.ref}, and ${verdict.why}`);
      if (r.missing) {
        if (!allowMissingFonts) {
          fail(`the deck uses the font ${ref.ref}, and this machine cannot read it — ${r.missing}\n`
            + '  (--allow-missing-fonts bundles without it: the theme\'s own font stack shows instead)');
        }
        if (!fontsLeftOut.some((x) => x.ref === ref.ref)) fontsLeftOut.push({ ref: ref.ref, why: r.missing });
        continue;
      }
      const version = String(verdict.manifest.version ?? '');
      const seen = byName.get(ref.name);
      if (seen) {
        if (seen.version !== version) fail(`two modules use the font "${ref.name}" at different versions — ${seen.label} has ${seen.version}, ${d.label} has ${version}; one file can carry one`);
        continue;
      }
      byName.set(ref.name, { version, label: d.label });
      fonts.push({ ref: ref.ref, name: ref.name, version, marketplace: ref.marketplace, family: verdict.manifest.family, block: bundleFont(r, verdict) });
    }
  }
  for (const x of fontsLeftOut) notices.push(`font ${x.ref} not carried — ${x.why}; the theme's own font stack shows instead`);
}
if (openOn !== null && !/^[\w-]+$/.test(openOn)) fail(`--theme ${JSON.stringify(openOn)} is not a theme name`);
if (openOn && !ownTheme && !markedNames.includes(openOn) && !themeNames.includes(openOn)) themeNames.push(openOn);
themeNames = themeNames.filter((n) => !markedNames.includes(n));
// A marked SHIPPED theme travels too: embedded beside the one the file opens
// on, whatever --themes chose, because marking it is how the author said so.
const markedShippedNames = markedShipped(sourceHtml).filter((n) => !themeNames.includes(n));
if (!ownTheme) themeNames.push(...markedShippedNames);
if (!themeNames.length) fail('no themes selected');
const activeTheme = openOn && themeNames.includes(openOn) ? openOn
  : themeNames.includes(linkedTheme) ? linkedTheme : themeNames[0];
if (!ownTheme && activeTheme !== linkedTheme && !openOn) {
  notices.push(`linked theme "${linkedTheme}" not in --themes list; "${activeTheme}" is active`);
}

const ownThemeFiles = new Set();   // themes read from a themes/ folder beside the deck
const themeBlocks = ownTheme ? null : themeNames.map((name) => {
  const cssPath = themeFile(name);
  if (!cssPath) fail(`theme not found: ${name} (${path.join(themesDir, `${name}.css`)}, and not shipped)`);
  if (cssPath.startsWith(themesDir)) ownThemeFiles.add(name);
  const css = fs.readFileSync(cssPath, 'utf8');
  const media = name === activeTheme ? '' : ' media="not all"';
  return `<style data-theme="${name}"${media}>\n${css}\n</style>`;
}).join('\n');
if (themeBlocks !== null) html = html.replace(themeLinkTag, themeBlocks);
// A deck that keeps a theme of its own (DECK_IMPORT) carries marked shipped
// themes as further inline blocks, off until picked.
if (ownTheme && markedShippedNames.length) {
  const extra = markedShippedNames.map((name) => {
    const cssPath = themeFile(name);
    if (!cssPath) fail(`theme not found: ${name}`);
    return `<style data-theme="${name}" media="not all">\n${fs.readFileSync(cssPath, 'utf8')}\n</style>`;
  }).join('\n');
  const headEnd = html.search(/<\/head>/i);
  html = headEnd === -1 ? `${extra}\n${html}` : `${html.slice(0, headEnd)}${extra}\n${html.slice(headEnd)}`;
}
if (marked.length) {
  const blocks = marked.map((r) => addedThemeStyle(r, fs.readFileSync(r.file, 'utf8'))).join('\n');
  const headEnd = html.search(/<\/head>/i);
  html = headEnd === -1 ? `${blocks}\n${html}` : `${html.slice(0, headEnd)}${blocks}\n${html.slice(headEnd)}`;
}
// The theme the bundle opens on is the configured one, and the runtime reads
// it from the configuration block — so `--theme` is written THERE, which is
// what makes a marked theme (an added block, not an inline one) the one a
// double-clicked file opens on.
if (openOn) {
  const block = configBlock(html);
  if (block?.config) {
    const inner = /"theme"\s*:\s*"[^"]*"/.test(block.inner)
      ? block.inner.replace(/"theme"\s*:\s*"[^"]*"/, `"theme": ${JSON.stringify(openOn)}`)
      : block.inner.replace('{', `{ "theme": ${JSON.stringify(openOn)},`);
    html = html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
  } else if (markedNames.includes(openOn)) {
    fail(`--theme ${openOn}: the deck has no configuration block to open it from`);
  }
}

// ------------------------------------------------- structure stylesheet(s)

html = html.replace(
  /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
  (tag, href) => {
    if (/^(https?:)?\/\//.test(href)) { notices.push(`external stylesheet kept as link: ${href}`); return tag; }
    if (/themes\/[\w-]+\.css/.test(href)) return tag; // already handled
    return `<style>\n${read(href)}\n</style>`;
  });

// -------------------------------------------------------------------- images

const imageDataUri = (rel) => {
  const p = path.resolve(deckDir, rel);
  if (!fs.existsSync(p)) return null;
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
};

html = html.replace(
  /<img\b([^>]*)\bsrc=["']([^"']+)["']/gi,
  (tag, pre, src) => {
    if (/^(data:|https?:|\/\/)/.test(src)) return tag;
    const uri = imageDataUri(src);
    if (!uri) { notices.push(`image not found, left as-is: ${src}`); return tag; }
    return `<img${pre}src="${uri}"`;
  });

// Background media (SPEC DECK_ANATOMY): the image and the poster inline like <img src>.
// Background VIDEOS stay external — video cannot inline sanely, the same
// posture as character MP4s — with a notice so the author ships the files.
html = html.replace(
  /\b(data-background-image|data-background-poster)=["']([^"']+)["']/gi,
  (tag, attr, src) => {
    if (/^(data:|https?:|\/\/)/.test(src)) return tag;
    const uri = imageDataUri(src);
    if (!uri) { notices.push(`background image not found, left as-is: ${src}`); return tag; }
    return `${attr}="${uri}"`;
  });
{
  const external = [...new Set([...html.matchAll(/\bdata-background-video=["']([^"']+)["']/gi)]
    .map((m) => m[1]).filter((src) => !/^(data:|https?:|\/\/)/.test(src)))];
  if (external.length) {
    notices.push(`background video: ${external.length} file(s) stay external — ship next to the bundle:\n    `
      + external.join('\n    '));
  }
}

// ------------------------------------------------------------ runtime script

html = html.replace(
  /<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
  (tag, pre, src, post) => {
    if (/^(https?:)?\/\//.test(src)) { notices.push(`external script kept as src: ${src}`); return tag; }
    // the runtime's marker rides along (#520): a bundle that boots from its
    // configuration block has no init call for the audit and upgrade to
    // locate the engine by, so the mark is how they find it
    const marked = /\bdata-decklight-runtime\s*=\s*["']js["']/i.test(pre + post) ? ' data-decklight-runtime="js"' : '';
    return `<script${marked}>\n${inlineRuntime(read(src))}\n</script>`;
  });

// ------------------------------------------------------------------- casts

const embeds = [];
let castN = 0;
html = html.replace(
  /<div\b([^>]*class=["'][^"']*\bterminal\b[^"']*["'][^>]*)>/gi,
  (tag, attrs) => {
    const m = attrs.match(/\bdata-cast=["']([^"']+)["']/);
    if (!m) return tag; // data-cast-inline (or no cast) passes through
    const id = `bundled-cast-${++castN}`;
    const json = scriptSafe(read(m[1]));
    embeds.push(`<script type="application/json" id="${id}">\n${json}\n</script>`);
    return tag.replace(m[0], `data-cast-inline="#${id}"`);
  });

// ---------------------------------------------- narration lip-sync sidecars

// slide-NN.visemes.json next to a narration track (tools/lipsync.mjs, or the
// the recorder's export) inlines as a data-decklight-visemes block — fetch() is blocked
// on file:// and a bundle should not depend on a sidecar folder. Per-slide
// MP4s stay external: video cannot inline sanely (a deck's worth is
// 50–150 MB), same posture as playlist links.
{
  const seen = new Set();
  const narrDirs = [...new Set(
    [...html.matchAll(/\b(?:dir|files)\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  for (const d of narrDirs) {
    const abs = path.resolve(deckDir, d);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    let mp4s = 0;
    for (const f of fs.readdirSync(abs).sort()) {
      // slide-NN and slide-NN-KK alike: a beat-paced track carries a sidecar
      // per ⟨CLICK⟩ beat, and a bundle that inlined only the slide ones would
      // leave the character animating from amplitude the moment it is opened
      // from file:// — which is the one place a bundle is always opened.
      const vm = f.match(/^(slide-\d+(?:-\d+)?)\.visemes\.json$/);
      if (vm) {
        // vm[1] is the whole STEM (`slide-07`, `slide-07-02`) — the same name
        // the runtime looks the block up by, so the two cannot drift apart.
        if (seen.has(vm[1])) {
          notices.push(`character visemes: ${d}/${f} skipped — ${vm[1]} already inlined from another track`);
          continue;
        }
        seen.add(vm[1]);
        embeds.push(`<script type="application/json" data-decklight-visemes="${vm[1]}">\n`
          + `${scriptSafe(fs.readFileSync(path.join(abs, f), 'utf8'))}\n</script>`);
      } else if (/^slide-\d+\.mp4$/.test(f)) mp4s++;
    }
    if (mp4s) {
      notices.push(`character video: ${mp4s} slide-NN.mp4 in ${d}/ stay external — ship the folder next to the bundle`);
    }
  }
  if (seen.size) {
    const beats = [...seen].filter((k) => /^slide-\d+-\d+$/.test(k)).length;
    notices.push(`character visemes: inlined ${seen.size} timeline(s)`
      + (beats ? ` (${seen.size - beats} slides + ${beats} [click] beats)` : ''));
  }
}

// --------------------------------------------- narration manifest tracks

// A `manifest:` track is a fetch, and fetch is dead on file:// — so a bundle
// that kept only the path would play nothing when opened from disk, which is
// the one way bundles are most often opened. The manifest is a few KB of JSON
// naming URLs, so it inlines under its own path, exactly like the viseme
// sidecars above. The AUDIO stays in the bucket: that is the entire point of
// the manifest, and inlining it would undo the feature.
{
  let n = 0;
  const manifests = [...new Set(
    [...html.matchAll(/\bmanifest\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  for (const rel of manifests) {
    const abs = path.resolve(deckDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      notices.push(`narration manifest: ${rel} not found — the bundle will fetch it at runtime`);
      continue;
    }
    embeds.push(`<script type="application/json" data-decklight-voices="${rel.replace(/"/g, '&quot;')}">\n`
      + `${scriptSafe(fs.readFileSync(abs, 'utf8'))}\n</script>`);
    n++;
  }
  if (n) notices.push(`narration: inlined ${n} voice manifest(s) — the audio stays in its bucket`);
}

// ------------------------------------------------------ narration audio

// A recorded track's audio is the one part of a deck too big to carry by
// default: a slide's clip is half a megabyte to a few, a talk's worth tens,
// and base64 adds a third. So it stays beside the deck unless asked for:
// `--audio` carries it inside as recorded, `--audio aac` / `--audio opus`
// re-encoded small (cli/bundle-audio.mjs). Either way the bundle says which
// files it left out or took in.
let audioEstimate = null;
{
  const { found, remote, folders } = narrationAudio(html, deckDir);
  if (estimate) {
    if (found.size) audioEstimate = { ...(await estimateAudio(found)), folders };
  } else if (found.size && audioChoice) {
    let carried;
    try { carried = await inlineAudio(found, audioChoice); } catch (e) { fail(e.message); }
    embeds.push(...carried.blocks);
    notices.push(`narration audio: inlined ${found.size} file(s), ${sizeLabel(carried.bytes)}`
      + `${CODECS[audioChoice] ? ` (re-encoded from ${sizeLabel(carried.before)}, ${CODECS[audioChoice].label})` : ''}, from ${folders}`);
  } else if (found.size) {
    notices.push(`narration audio: ${found.size} file(s) stay beside the deck, in ${folders} — ship them next to the bundle, or bundle with --audio [original|aac|opus] to carry them inside`);
  }
  if (remote && audioChoice) notices.push(`narration audio: ${remote} manifest file(s) live at a URL and stay there`);
}

// -------------------------------------------------------- design systems

// The stylesheets where every server links them — the end of <head>, after
// the themes, so the cascade is the one the author saw — and the meta and
// layouts before the runtime too: classic scripts execute mid-parse, so they
// must be in the document when the engine looks for them.
if (systems.length) {
  const at = (withScript) => {
    const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const marks = [masked.search(/<\/head>/i), withScript ? firstExecutableScript(html) ?? -1 : -1].filter((i) => i !== -1);
    return marks.length ? Math.min(...marks) : 0;
  };
  const insert = (i, tags) => { html = `${html.slice(0, i)}${tags.join('\n')}\n${html.slice(i)}`; };
  insert(at(true), systems.flatMap((x) => x.block.tags.slice(1)));
  insert(at(false), systems.map((x) => x.block.tags[0]));
}
// The fonts the same way: their @font-face at the end of <head>, where the
// servers link them, their meta before the runtime reads it.
if (fonts.length) {
  const at = (withScript) => {
    const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    const marks = [masked.search(/<\/head>/i), withScript ? firstExecutableScript(html) ?? -1 : -1].filter((i) => i !== -1);
    return marks.length ? Math.min(...marks) : 0;
  };
  const insert = (i, tags) => { html = `${html.slice(0, i)}${tags.join('\n')}\n${html.slice(i)}`; };
  insert(at(true), fonts.map((x) => x.block.tags[1]));
  insert(at(false), fonts.map((x) => x.block.tags[0]));
}

// -------------------------------------------------------------- assemble

if (embeds.length) {
  const injected = injectBeforeBodyEnd(html, embeds.join('\n') + '\n');
  if (injected === null) fail('deck has no </body>');
  html = injected;
}

if (!jobs) {
  const playlistM = sourceHtml.match(/playlist\s*:/);
  if (playlistM) {
    const hrefs = [...sourceHtml.matchAll(/href:\s*['"]([^'"]+\.html)['"]/g)].map((m) => m[1]);
    notices.push('deck has a playlist — cross-file module links cannot resolve inside a single file:' +
      (hrefs.length ? '\n    ' + [...new Set(hrefs)].join('\n    ') : ''));
  }
}

// Signing happens BEFORE the write, and that ordering is the feature
// (INTEGRITY#SIGNING): a failed signature must leave no artifact behind, or
// the unsigned file sitting there afterwards gets picked up later and sent as
// though it were finished. Bytes, not a path, for exactly this reason.
// An estimate (the author server's bundle card) stops here: the file as it
// would be without its audio, and what each way of carrying the audio adds.
if (estimate) return { base: Buffer.byteLength(html, 'utf8'), audio: audioEstimate };

let bundleSig = null;
if (sign) {
  const { signBytes } = await import('./sign.mjs');
  // Through fail(), so an unsigned-because-offline bundle reads as a decision
  // the tool explains rather than a stack trace the user has to interpret.
  try { bundleSig = await signBytes(Buffer.from(html, 'utf8'), { client }); } catch (e) { fail(e.message); }
}

fs.writeFileSync(outPath, html);
const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
const what = jobs ? `${jobs.length} modules` : path.basename(firstPath);
process.stdout.write(`bundled ${what} → ${outPath} (${kb} KB)\n`);
// The runtime: where the copy in the file came from. A deck that is data (#520)
// carries none — which reads like a warning unless it says it is the SOURCE deck
// that carried none, and the file that has one.
const runtimeFrom = linked ? 'embedded from this install (the source deck carries no runtime)'
  : fromInstall.has('decklight.js') ? 'embedded from this install (the source deck links it)'
    : "embedded from the source deck's own copy";
process.stdout.write(`  runtime  decklight ${PKG.version} — ${runtimeFrom}\n`);
// The themes: the one it opens on, the others it can switch to, and why each
// is there — marked, or asked for with --themes — and where one came from when
// it was not this install (a themes/ folder beside the deck, a marketplace).
{
  const opening = openOn ?? (ownTheme ? themeNames[0] : activeTheme);
  const tagged = (n, ...why) => {
    const bits = [...why, ownThemeFiles.has(n) ? 'own file' : null].filter(Boolean);
    return bits.length ? `${n} (${bits.join(', ')})` : n;
  };
  const parts = [tagged(opening, 'opens on', ownTheme ? 'its own' : null)];
  const chosen = themeNames.filter((n) => n !== opening && !markedShippedNames.includes(n));
  if (chosen.length) parts.push(chosen.map((n) => tagged(n)).join(', '));
  const shippedMarked = markedShippedNames.filter((n) => n !== opening);
  if (shippedMarked.length) parts.push(`${shippedMarked.join(', ')} (marked)`);
  const byMarket = new Map();
  for (const r of marked) {
    const m = r.ref.split('@')[1];
    byMarket.set(m, [...(byMarket.get(m) ?? []), r.name]);
  }
  for (const [m, names] of byMarket) parts.push(`${names.join(', ')} (marked, from ${m})`);
  process.stdout.write(`  themes   ${parts.join(' · ')}\n`);
}
// The design systems: name, version, the catalog it came from, what went in.
if (systems.length || systemsLeftOut.length) {
  const parts = systems.map(({ name, version, marketplace, block }) => {
    const assets = block.assets ? `, ${block.assets} asset${block.assets === 1 ? '' : 's'} (${(block.bytes / 1024).toFixed(1)} KB)` : '';
    return `${name} ${version} (from ${marketplace}) — stylesheet${assets}, ${block.layouts} layout${block.layouts === 1 ? '' : 's'}`;
  });
  for (const x of systemsLeftOut) parts.push(`${x.ref} — not carried`);
  process.stdout.write(`  designs  ${parts.join(' · ')}\n`);
}
if (fonts.length || fontsLeftOut.length) {
  const parts = fonts.map(({ name, version, marketplace, family, block }) =>
    `${name} ${version} (from ${marketplace}) — '${family}', ${block.faces} face${block.faces === 1 ? '' : 's'} (${(block.bytes / 1024).toFixed(1)} KB)`);
  for (const x of fontsLeftOut) parts.push(`${x.ref} — not carried`);
  process.stdout.write(`  fonts    ${parts.join(' · ')}\n`);
}
if (bundleSig) {
  const { writeSidecar, verifyBytes, formatSignature } = await import('./sign.mjs');
  const sidecar = writeSidecar(outPath, bundleSig);
  process.stdout.write(`signed → ${sidecar} (detached — the sidecar is the authority; send both)\n`);
  // Read back what was just written the same way a recipient will. A signature
  // this command cannot verify itself is not one to hand anybody.
  process.stdout.write(`${formatSignature(await verifyBytes(html, bundleSig, { client }), { indent: '  ' })}\n`);

  // …and the container is that pair as one artifact, because two files is one
  // more than people forward (DECK_FILE).
  if (deckFile) {
    const { packContainer, containerFor, originOf, runtimeVersionOf } = await import('./deckfile.mjs');
    const { bytes } = packContainer({
      payload: html,
      signature: bundleSig,
      name: path.basename(outPath),
      runtime: runtimeVersionOf(html),
      origin: originOf(firstPath),
    });
    const container = containerFor(outPath);
    fs.writeFileSync(container, bytes);
    process.stdout.write(`packed → ${container} (${(bytes.length / 1024).toFixed(1)} KB — `
      + 'the deck, its signature and a manifest in one file; rename it .html and a browser still plays it)\n');
  }
}
for (const n of notices) process.stdout.write(`note: ${n}\n`);
}

if (isMain(import.meta.url)) process.exitCode = await runMain('bundle', bundleMain);
