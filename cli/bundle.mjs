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
 *   - terminals    : data-cast="url" casts are embedded and switched to
 *                    data-cast-inline (fetch is blocked on file://).
 *   - images       : <img src> → data: URIs.
 *
 * MERGE mode (--all or several inputs): every module's <section>s are
 * concatenated into one deck, in order. Each module's first section gets
 * data-module="<title>" — the engine's module menu (M) and chrome tag then
 * navigate in-file instead of across files, and the per-module playlist
 * config is stripped (it has no meaning inside a single file).
 */

import fs from 'node:fs';
import path from 'node:path';

function fail(msg) {
  process.stderr.write(`decklight bundle: ${msg}\n`);
  process.exit(1);
}

// Inline <script> content must never contain "</script" (terminates the tag)
// NOR "<!--" (flips the HTML tokenizer into script-data-escaped mode, after
// which closers mis-parse — marked's comment regexes contain it). "\/" is an
// identity escape everywhere. "<!--" is broken by rewriting the bang as a
// backslash-u0021 unicode escape, NOT as backslash-bang: the latter is fine
// in strings and flagless regexes but an INVALID escape inside u-flagged
// regexes — highlight.js composes its XML grammar's comment regex with /imu
// the first time a deck highlights language-html, which turned the old
// escape into a lazy SyntaxError. The unicode escape is valid in strings,
// templates, JSON, and regexes with or without the u flag.
const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');
const jsonSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

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
 *  property out of a merged deck — cross-file navigation has no meaning
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
    inner.replace(/<section\b/, `<section data-module="${escAttr(title)}"`);

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
      inner = inner.replace(/\b(data-cast|src)=["'](?!#|data:|https?:|\/\/)([^"']+)["']/g,
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

export async function bundleMain(argv = process.argv.slice(2)) {

if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`decklight bundle — flatten deck(s) into one self-contained HTML file

Usage:
  decklight bundle <deck.html> [-o out.html] [--themes current|all|name,name,…]
  decklight bundle <deck.html> --all [-o out.html] [--title "…"] [--themes …]
  decklight bundle <a.html> <b.html> … [-o out.html] [--title "…"] [--themes …]

Options:
  -o <file>        output path (default: <deck>-standalone.html, or
                   <deck>-course.html when merging)
  --all            follow the deck's playlist and merge EVERY module into
                   one single-file presentation (in-file module menu via
                   data-module markers)
  --title <t>      <title> for a merged presentation
  --themes <sel>   which themes to embed:
                     current       just the deck's linked theme (default)
                     all           every theme in the deck's themes/ directory
                     name,name,…   an explicit list (the deck's linked theme
                                   stays active when included, else the first)
`);
  process.exit(0);
}

const inputs = [];
let outPath = null, themesSel = 'current', all = false, mergedTitle = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') outPath = argv[++i];
  else if (a === '--themes') themesSel = argv[++i];
  else if (a === '--all') all = true;
  else if (a === '--title') mergedTitle = argv[++i];
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
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escAttr(t)}</title>`);
  outPath = path.resolve(outPath ||
    path.join(deckDir, path.basename(firstPath, '.html') + '-course.html'));
} else {
  html = fs.readFileSync(firstPath, 'utf8');
  outPath = path.resolve(outPath ||
    path.join(deckDir, path.basename(firstPath, '.html') + '-standalone.html'));
}

const read = (rel) => {
  const p = path.resolve(deckDir, rel);
  if (!fs.existsSync(p)) fail(`referenced file not found: ${rel} (${p})`);
  return fs.readFileSync(p, 'utf8');
};

// ---------------------------------------------------------- theme selection

const themeLinkRe = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']*themes\/([\w-]+)\.css)["'][^>]*>/i;
const themeLinkM = html.match(themeLinkRe);
if (!themeLinkM) fail('no theme <link> (href matching themes/<name>.css) found in the deck');
const [themeLinkTag, themeHref, linkedTheme] = themeLinkM;
const themesDir = path.resolve(deckDir, path.dirname(themeHref));

let themeNames;
if (themesSel === 'current') {
  themeNames = [linkedTheme];
} else if (themesSel === 'all') {
  themeNames = fs.readdirSync(themesDir).filter((f) => f.endsWith('.css'))
    .map((f) => f.replace(/\.css$/, '')).sort();
} else {
  themeNames = themesSel.split(',').map((s) => s.trim()).filter(Boolean);
}
if (!themeNames.length) fail('no themes selected');
const activeTheme = themeNames.includes(linkedTheme) ? linkedTheme : themeNames[0];
if (activeTheme !== linkedTheme) {
  notices.push(`linked theme "${linkedTheme}" not in --themes list; "${activeTheme}" is active`);
}

const themeBlocks = themeNames.map((name) => {
  const cssPath = path.join(themesDir, name + '.css');
  if (!fs.existsSync(cssPath)) fail(`theme not found: ${name} (${cssPath})`);
  const css = fs.readFileSync(cssPath, 'utf8');
  const media = name === activeTheme ? '' : ' media="not all"';
  return `<style data-theme="${name}"${media}>\n${css}\n</style>`;
}).join('\n');
html = html.replace(themeLinkTag, themeBlocks);

// ------------------------------------------------- structure stylesheet(s)

html = html.replace(
  /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
  (tag, href) => {
    if (/^(https?:)?\/\//.test(href)) { notices.push(`external stylesheet kept as link: ${href}`); return tag; }
    if (/themes\/[\w-]+\.css/.test(href)) return tag; // already handled
    return `<style>\n${read(href)}\n</style>`;
  });

// -------------------------------------------------------------------- images

html = html.replace(
  /<img\b([^>]*)\bsrc=["']([^"']+)["']/gi,
  (tag, pre, src) => {
    if (/^(data:|https?:|\/\/)/.test(src)) return tag;
    const p = path.resolve(deckDir, src);
    if (!fs.existsSync(p)) { notices.push(`image not found, left as-is: ${src}`); return tag; }
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
    const b64 = fs.readFileSync(p).toString('base64');
    return `<img${pre}src="data:${mime};base64,${b64}"`;
  });

// ------------------------------------------------------------ runtime script

html = html.replace(
  /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
  (tag, src) => {
    if (/^(https?:)?\/\//.test(src)) { notices.push(`external script kept as src: ${src}`); return tag; }
    const js = read(src).replace(/\/\/# sourceMappingURL=.*$/m, '');
    return `<script>\n${scriptSafe(js)}\n</script>`;
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
    const json = jsonSafe(read(m[1]));
    embeds.push(`<script type="application/json" id="${id}">\n${json}\n</script>`);
    return tag.replace(m[0], `data-cast-inline="#${id}"`);
  });

// ---------------------------------------------- narration lip-sync sidecars

// slide-NN.visemes.json next to a narration track (tools/lipsync.mjs, or the
// ⇧V export) inlines as a data-decklight-visemes block — fetch() is blocked
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
      const vm = f.match(/^slide-(\d+)\.visemes\.json$/);
      if (vm) {
        if (seen.has(vm[1])) {
          notices.push(`character visemes: ${d}/${f} skipped — slide ${vm[1]} already inlined from another track`);
          continue;
        }
        seen.add(vm[1]);
        embeds.push(`<script type="application/json" data-decklight-visemes="slide-${vm[1]}">\n`
          + `${jsonSafe(fs.readFileSync(path.join(abs, f), 'utf8'))}\n</script>`);
      } else if (/^slide-\d+\.mp4$/.test(f)) mp4s++;
    }
    if (mp4s) {
      notices.push(`character video: ${mp4s} slide-NN.mp4 in ${d}/ stay external — ship the folder next to the bundle`);
    }
  }
  if (seen.size) notices.push(`character visemes: inlined ${seen.size} slide timeline(s)`);
}

// -------------------------------------------------------------- assemble

// Anchor to the LAST </body>: the inlined runtime contains the speaker-view
// popup template, whose "</body></html>" string would match a first-occurrence
// search and corrupt the JS mid-payload.
if (embeds.length) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at === -1) fail('deck has no </body>');
  html = html.slice(0, at) + embeds.join('\n') + '\n' + html.slice(at);
}

if (!jobs) {
  const playlistM = html.match(/playlist\s*:/);
  if (playlistM) {
    const hrefs = [...html.matchAll(/href:\s*['"]([^'"]+\.html)['"]/g)].map((m) => m[1]);
    notices.push('deck has a playlist — cross-file module links cannot resolve inside a single file:' +
      (hrefs.length ? '\n    ' + [...new Set(hrefs)].join('\n    ') : ''));
  }
}

fs.writeFileSync(outPath, html);
const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
const what = jobs ? `${jobs.length} modules` : path.basename(firstPath);
process.stdout.write(`bundled ${what} → ${outPath} (${kb} KB, themes: ${themeNames.join(', ')}; active: ${activeTheme})\n`);
for (const n of notices) process.stdout.write(`note: ${n}\n`);
}

import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) bundleMain().catch((e) => fail(e.message));
