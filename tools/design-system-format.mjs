// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The design-system package format, and the rules it is held to (SPEC
// DESIGN_SYSTEMS). A design system is what a company publishes once so every
// deck built on it inherits tokens beyond the theme contract, background art,
// and slide layouts with slots — by reference, the way a marked theme is.
//
//   <name>/
//     design-system.json   apiVersion, name, version, title, styles, layouts
//                          (+ description, tokenPrefix, palette, recommendedThemes)
//     design-system.css    prefixed tokens, component and per-layout rules;
//                          url()s relative to this file
//     layouts.html         inert <template data-layout="…"> blocks with data-slot containers
//     assets/…             svg · png · jpg · jpeg · webp · woff2 · woff
//
// PURE: every function here takes texts and a file list, never a path to read,
// and imports nothing from Node. `decklight design-system check` (the
// admission gate a catalog's CI runs) is a thin main over it, and the same
// rules run again where a package is served and where the engine clones a
// layout — one module, so the three can never disagree about what is safe.
//
// THE THREAT this exists for: layout HTML and SVG from a third-party catalog
// end up inside a page whose policy allows inline script. So layouts are
// inert markup and nothing else, SVGs carry no script, handlers or outside
// references, and the CSS reaches nothing outside its own package.

import { SEMVER_RE } from './semver.mjs';

/**
 * The design-system package contract's own version (SPEC DESIGN_SYSTEMS) —
 * additive only, like TRANSFORM_API_VERSION and its siblings: bumped only
 * when the format would break an existing package, never for an internal
 * reorganisation. A package declares the lowest version it needs; this
 * decklight reads anything at or below it.
 */
export const DESIGN_SYSTEM_API_VERSION = 1;

/** What an asset may be. SVG is the executable one, and gets the deep scan. */
export const ASSET_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp', 'woff2', 'woff'];

/** Past this, an asset is a warning — a deck that ships it pays for it on every load. */
export const ASSET_WARN_BYTES = 2 * 1024 * 1024;

/** A package's, a layout's and a slot's name: what a slide writes, so it stays plain. */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Is this `data-layout` value a design-system layout (`name/layout`)? The built-in ring never has a slash. */
export const isSystemLayout = (value) => typeof value === 'string' && value.includes('/');

/** `acme/section-divider` → `{ system, layout }`, or null for anything else. */
export function parseSystemLayout(value) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(value ?? ''));
  return m && NAME_RE.test(m[1]) && NAME_RE.test(m[2]) ? { system: m[1], layout: m[2] } : null;
}

/**
 * The theme contract (SPEC THEMING): the tokens a THEME owns. A design system
 * sits beside any theme, so setting one of these is overriding the theme —
 * allowed only with a `ds-exception: --token reason` comment, which every run
 * prints, the way a theme's `rule-exception:` is.
 */
export const THEME_CONTRACT = [
  'bg', 'bg-accent', 'fg', 'muted',
  'font-body', 'font-heading', 'font-mono', 'heading-color', 'heading-weight', 'link',
  'accent', 'accent-contrast',
  'block-bg', 'block-border', 'block-radius', 'shadow',
  'code-bg', 'code-fg', 'hl-keyword', 'hl-string', 'hl-number', 'hl-comment', 'hl-function', 'hl-type', 'hl-punct',
  'd-stroke', 'd-text', 'd-muted', 'd-accent', 'd-fill-1', 'd-fill-2', 'd-fill-3', 'd-fill-4', 'd-fill-5', 'd-fill-6',
  'term-bg', 'term-fg', 'term-prompt', 'term-cursor', 'term-selection',
  'ansi-black', 'ansi-red', 'ansi-green', 'ansi-yellow', 'ansi-blue', 'ansi-magenta', 'ansi-cyan', 'ansi-white',
  'ansi-bright-black', 'ansi-bright-red', 'ansi-bright-green', 'ansi-bright-yellow',
  'ansi-bright-blue', 'ansi-bright-magenta', 'ansi-bright-cyan', 'ansi-bright-white',
].map((t) => `--${t}`);
const CONTRACT = new Set(THEME_CONTRACT);

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const ext = (path) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();

/**
 * Is `p` a plain path inside the package? No scheme, not absolute, no `..`,
 * no backslashes — the containment every serving path relies on, decided on
 * the text so it means the same on every platform.
 */
export function packagePathProblem(p) {
  const s = String(p ?? '');
  if (!s) return 'is empty';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'names a URL — a design system reaches only its own files';
  if (s.startsWith('/') || s.startsWith('\\') || /^[A-Za-z]:/.test(s)) return 'is absolute — paths are relative to the package';
  if (s.includes('\\')) return 'uses a backslash — paths use /';
  if (s.split('/').some((seg) => seg === '..')) return 'climbs out with .. — a package reaches only its own files';
  return null;
}

/** `a/b/../c` style joining, for a url() relative to the stylesheet. Assumes no `..` (refused first). */
const joinRel = (base, rel) => {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return (dir + rel).split('/').filter((seg) => seg && seg !== '.').join('/');
};

// ── the manifest ───────────────────────────────────────────────────────────

/** The line a JSON key first appears on — good enough to point a person at it. */
const keyLine = (raw, key) => {
  const i = raw.indexOf(`"${key}"`);
  return i < 0 ? 1 : lineAt(raw, i);
};

/**
 * `design-system.json`, parsed and shaped. Returns `{ manifest, problems }`;
 * `manifest` is null when the JSON itself does not parse. `prefix` is the
 * token prefix the CSS is held to (`tokenPrefix`, default `--<name>-`).
 */
export function readManifest(raw) {
  const problems = [];
  const at = (rule, key, msg) => problems.push({ file: 'design-system.json', line: keyLine(raw, key), rule, msg });
  let m;
  try { m = JSON.parse(raw); } catch (e) {
    const pos = /position (\d+)/.exec(e.message)?.[1];
    problems.push({ file: 'design-system.json', line: pos ? lineAt(raw, Number(pos)) : 1, rule: 'manifest-json', msg: `not valid JSON — ${e.message}` });
    return { manifest: null, problems };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    problems.push({ file: 'design-system.json', line: 1, rule: 'manifest-json', msg: 'must be a JSON object' });
    return { manifest: null, problems };
  }
  if (!Number.isInteger(m.apiVersion) || m.apiVersion < 1) at('manifest-field', 'apiVersion', 'apiVersion must be a positive integer — the design-system format version this package needs');
  else if (m.apiVersion > DESIGN_SYSTEM_API_VERSION) {
    at('api-too-new', 'apiVersion', `apiVersion ${m.apiVersion} needs a newer decklight — this one reads design systems up to ${DESIGN_SYSTEM_API_VERSION}`);
  }
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) at('manifest-field', 'name', `name ${JSON.stringify(m.name)} — a lowercase word: letters, digits and -, starting with a letter (a slide writes it: data-layout="<name>/<layout>")`);
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) at('manifest-field', 'version', `version ${JSON.stringify(m.version)} — a semver version, major.minor.patch (e.g. "1.2.0"), no leading v`);
  if (typeof m.title !== 'string' || !m.title.trim()) at('manifest-field', 'title', 'title must be the design system\'s human name, e.g. "Acme Brand"');
  for (const key of ['styles', 'layouts']) {
    if (typeof m[key] !== 'string') at('manifest-field', key, `${key} must name the package's ${key === 'styles' ? 'stylesheet ("design-system.css")' : 'layouts file ("layouts.html")'}`);
    else {
      const why = packagePathProblem(m[key]);
      if (why) at('file-outside', key, `${key} "${m[key]}" ${why}`);
    }
  }
  if (m.description !== undefined && typeof m.description !== 'string') at('manifest-field', 'description', 'description must be a string');
  if (m.tokenPrefix !== undefined && (typeof m.tokenPrefix !== 'string' || !/^--[a-z][a-z0-9-]*-$/.test(m.tokenPrefix))) {
    at('manifest-field', 'tokenPrefix', `tokenPrefix ${JSON.stringify(m.tokenPrefix)} — a custom-property prefix ending in -, e.g. "--acme-"`);
  }
  if (m.palette !== undefined) {
    if (!Array.isArray(m.palette)) at('manifest-field', 'palette', 'palette must be an array of { group, label, token }');
    else {
      m.palette.forEach((p, i) => {
        if (!p || typeof p.label !== 'string' || typeof p.token !== 'string' || !/^--[A-Za-z0-9_-]+$/.test(p.token)
          || (p.group !== undefined && typeof p.group !== 'string')) {
          at('manifest-field', 'palette', `palette[${i}] must be { group, label, token: "--…" }`);
        }
      });
    }
  }
  if (m.recommendedThemes !== undefined && (!Array.isArray(m.recommendedThemes) || !m.recommendedThemes.every((t) => typeof t === 'string'))) {
    at('manifest-field', 'recommendedThemes', 'recommendedThemes must be an array of theme names');
  }
  return { manifest: m, problems };
}

/** The token prefix a manifest holds its CSS to. */
export const tokenPrefixOf = (manifest) => manifest?.tokenPrefix ?? `--${manifest?.name ?? ''}-`;

// ── the stylesheet ─────────────────────────────────────────────────────────

/**
 * What `design-system.css` declares and references: `{ tokens, exceptions,
 * urls, imports }` — custom properties DECLARED (not merely read through
 * var()), `ds-exception:` comments, every url() with its line, every @import.
 */
export function parseStyles(css) {
  const text = String(css ?? '');
  // comments blanked to spaces, so indexes (and lines) stay true
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const tokens = [];
  for (const m of bare.matchAll(/(^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g)) {
    tokens.push({ name: m[2], line: lineAt(text, m.index + m[1].length) });
  }
  const exceptions = [];
  for (const m of text.matchAll(/ds-exception:\s*(--[A-Za-z0-9_-]+)\s+([^\n*]+)/g)) {
    exceptions.push({ token: m[1], reason: m[2].trim(), line: lineAt(text, m.index) });
  }
  const urls = [];
  for (const m of bare.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) urls.push({ value: m[2].trim(), line: lineAt(text, m.index) });
  const imports = [];
  for (const m of bare.matchAll(/@import\b/gi)) imports.push({ line: lineAt(text, m.index) });
  return { tokens, exceptions, urls, imports };
}

function styleProblems(css, { file, prefix, files }) {
  const problems = [];
  const { tokens, exceptions, urls, imports } = parseStyles(css);
  const push = (line, rule, msg) => problems.push({ file, line, rule, msg });
  for (const i of imports) push(i.line, 'css-import', '@import is refused — a design system reaches nothing outside its own package; put the rules in this file');
  for (const u of urls) {
    const v = u.value;
    if (!v || v.startsWith('#')) continue;  // a fragment points into the page itself
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) { push(u.line, 'css-url-scheme', `url(${v}) names a URL — a design system reaches only its own files (url(assets/…))`); continue; }
    if (v.startsWith('/') || v.startsWith('\\')) { push(u.line, 'css-url-absolute', `url(${v}) is absolute — url()s are relative to ${file}`); continue; }
    if (v.split(/[\\/]/).includes('..')) { push(u.line, 'css-url-dotdot', `url(${v}) climbs out with .. — a design system reaches only its own files`); continue; }
    const target = joinRel(file, v.replace(/[?#].*$/, ''));
    if (!files.has(target)) push(u.line, 'css-url-missing', `url(${v}) — no such file in the package (${target})`);
  }
  const excepted = new Map(exceptions.map((e) => [e.token, e]));
  for (const t of tokens) {
    if (CONTRACT.has(t.name)) {
      if (!excepted.has(t.name)) {
        push(t.line, 'contract-token', `${t.name} is a theme-contract token — a design system sits beside any theme; set it only with a /* ds-exception: ${t.name} <reason> */ comment`);
      }
    } else if (prefix && !t.name.startsWith(prefix)) {
      push(t.line, 'unprefixed-token', `${t.name} does not start with this package's tokenPrefix ${prefix}`);
    }
  }
  return { problems, tokens, exceptions };
}

// ── the layouts ────────────────────────────────────────────────────────────

/** Tags a layout may never contain: anything that runs, loads, or frames. */
const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'foreignobject', 'link', 'meta', 'base', 'frame', 'frameset', 'template-in-template']);
/** Attributes that point somewhere — a layout carries structure; its art lives in the CSS. */
const REF_ATTRS = new Set(['src', 'srcset', 'href', 'xlink:href', 'poster', 'action', 'formaction', 'data', 'background']);

/** Numeric and the common named entities decoded, controls and whitespace stripped — what a browser sees in a URL. */
const urlSeen = (v) => String(v).replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '')
  .replace(/[\u0000- ]/g, '');

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function attrsOf(src) {
  const out = [];
  for (const m of src.matchAll(ATTR_RE)) out.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' });
  return out;
}

/**
 * `layouts.html` as data: `[{ id, title, slots: [{ name, hint, required,
 * default }], line }]`, in file order. The structure a slide fills, read
 * without a DOM — what the deck's meta block, `design-system layouts` and
 * `check` all print.
 */
export function parseLayouts(html) {
  return walkLayouts(html).layouts;
}

/** The tokenizer every layout question goes through — tags, comments and text, with lines. */
function walkLayouts(html) {
  const text = String(html ?? '');
  const layouts = [];
  const problems = [];
  const push = (line, rule, msg) => problems.push({ line, rule, msg });
  let current = null;
  let depth = 0;
  // one finding per stray run outside the templates, not one per tag and text in it
  let strayed = false;
  const stray = (line, msg) => { if (!strayed) { strayed = true; push(line, 'layout-outside-template', msg); } };
  const TAG = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    const between = text.slice(last, m.index);
    last = m.index + m[0].length;
    if (!current && between.trim()) stray(lineAt(text, m.index - between.length + between.search(/\S/)), 'text outside a <template data-layout> block — everything in layouts.html sits inside one');
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const line = lineAt(text, m.index);
    const selfClosing = /\/\s*$/.test(m[3]);
    if (tag === 'template') {
      if (closing) {
        if (current && depth === 0) { layouts.push(current); current = null; }
        else if (current) depth--;
        // A </template> with nothing open is not harmless: wherever these
        // layouts are inlined into a page's own <template>, it would close
        // that one early and let what follows out as live markup.
        else push(line, 'layout-outside-template', '</template> with no <template data-layout> open — it would close whatever template the layouts are carried in');
        continue;
      }
      if (current) { push(line, 'layout-forbidden-tag', '<template> inside a layout — one level of templates, one per layout'); depth++; continue; }
      const attrs = attrsOf(m[3]);
      const id = attrs.find((a) => a.name === 'data-layout')?.value;
      if (id === undefined) { push(line, 'layout-outside-template', '<template> without data-layout — every template is a layout, named by data-layout'); }
      else if (!NAME_RE.test(id)) push(line, 'layout-id', `data-layout="${id}" — a lowercase word: letters, digits and -, starting with a letter`);
      current = { id: id ?? '', title: attrs.find((a) => a.name === 'data-title')?.value || id || '', slots: [], line };
      depth = 0;
      strayed = false;
      continue;
    }
    if (!current) {
      // the opening tag is the finding; its closing tag is the same one
      if (!closing) stray(line, `<${tag}> outside a <template data-layout> block — everything in layouts.html sits inside one`);
      continue;
    }
    if (closing) continue;
    if (FORBIDDEN_TAGS.has(tag)) push(line, 'layout-forbidden-tag', `<${tag}> is refused in a layout — a layout is inert structure: no script, style, frames or embedded documents`);
    for (const a of attrsOf(m[3].replace(/\/\s*$/, ''))) {
      if (/^on/.test(a.name)) push(line, 'layout-forbidden-attr', `${a.name}= on <${tag}> is refused — a layout runs nothing`);
      else if (a.name === 'srcdoc') push(line, 'layout-forbidden-attr', `srcdoc on <${tag}> is refused — a layout embeds no document`);
      else if (/^javascript:/i.test(urlSeen(a.value))) push(line, 'layout-javascript-url', `${a.name}="${a.value}" on <${tag}> is a javascript: URL — refused`);
      else if (REF_ATTRS.has(a.name) && a.value && !a.value.startsWith('#')) {
        push(line, 'layout-reference', `${a.name}="${a.value}" on <${tag}> — a layout carries structure only; put art in design-system.css (url(assets/…)), where it resolves inside the package`);
      }
    }
    const attrs = attrsOf(m[3]);
    const slot = attrs.find((a) => a.name === 'data-slot');
    if (slot) {
      if (!NAME_RE.test(slot.value)) push(line, 'slot-name', `data-slot="${slot.value}" in ${current.id} — a lowercase word: letters, digits and -, starting with a letter (a slide writes it)`);
      else if (current.slots.some((s) => s.name === slot.value)) push(line, 'slot-repeated', `slot "${slot.value}" appears twice in ${current.id} — a slot name is one place in a layout`);
      const isDefault = attrs.some((a) => a.name === 'data-slot-default');
      if (isDefault && current.slots.some((s) => s.default)) push(line, 'slot-default-twice', `${current.id} has more than one data-slot-default — unslotted content can land in one place only`);
      current.slots.push({
        name: slot.value,
        hint: attrs.find((a) => a.name === 'data-slot-hint')?.value ?? '',
        required: attrs.some((a) => a.name === 'data-slot-required'),
        default: isDefault,
      });
    }
    if (selfClosing) continue;
  }
  const tail = text.slice(last);
  if (current) push(current.line, 'layout-outside-template', `<template data-layout="${current.id}"> is never closed`);
  else if (tail.trim()) stray(lineAt(text, last + tail.search(/\S/)), 'text outside a <template data-layout> block — everything in layouts.html sits inside one');
  const seen = new Map();
  for (const l of layouts) {
    if (!l.id) continue;
    if (seen.has(l.id)) push(l.line, 'layout-duplicate', `data-layout="${l.id}" is defined twice (lines ${seen.get(l.id)} and ${l.line}) — a layout id names one layout`);
    else seen.set(l.id, l.line);
  }
  return { layouts, problems };
}

/** Everything wrong with a layouts file, each `{ line, rule, msg }`. */
export function layoutProblems(html) {
  return walkLayouts(html).problems;
}

// ── SVG assets ─────────────────────────────────────────────────────────────

/** An SVG is a document that can run script: none, no handlers, nothing outside it. */
export function svgProblems(svg) {
  const text = String(svg ?? '');
  const problems = [];
  for (const m of text.matchAll(/<\s*script\b/gi)) problems.push({ line: lineAt(text, m.index), rule: 'svg-script', msg: '<script> in an SVG asset is refused — an asset is a picture, not a program' });
  for (const m of text.matchAll(/<\s*foreignObject\b/gi)) problems.push({ line: lineAt(text, m.index), rule: 'svg-script', msg: '<foreignObject> in an SVG asset is refused — it embeds a document' });
  for (const m of text.matchAll(/<[A-Za-z][^>]*?\s(on[a-z]+)\s*=/gi)) problems.push({ line: lineAt(text, m.index), rule: 'svg-handler', msg: `${m[1]}= in an SVG asset is refused — an asset runs nothing` });
  for (const m of text.matchAll(/\s((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gi)) {
    const v = m[3].trim();
    if (v && !v.startsWith('#')) problems.push({ line: lineAt(text, m.index), rule: 'svg-external-href', msg: `${m[1]}="${v}" reaches outside the SVG — only #fragment references are allowed` });
  }
  return problems;
}

// ── the package ────────────────────────────────────────────────────────────

/** Files a package may hold that are neither its manifest, CSS, layouts nor assets. */
const isPapers = (p) => /^(readme|license|licence|changelog|notice)(\.(md|txt))?$/i.test(p);

/**
 * Check a whole package. `pkg` is plain data:
 *   { manifest: <design-system.json text>,
 *     files: Map<relative path, { size, text? }> }  — every file in the package
 *     (the CSS, layouts and every .svg must carry `text`).
 * Returns `{ ok, problems, warnings, summary }`. `problems` refuse the
 * package; `warnings` do not. Each is `{ file, line?, rule, msg }`.
 */
export function checkPackage(pkg) {
  const problems = [];
  const warnings = [];
  const files = pkg.files instanceof Map ? pkg.files : new Map(Object.entries(pkg.files ?? {}));
  const { manifest, problems: mp } = readManifest(pkg.manifest ?? '');
  problems.push(...mp);
  const summary = { name: manifest?.name ?? null, version: manifest?.version ?? null, apiVersion: manifest?.apiVersion ?? null, title: manifest?.title ?? null };
  if (!manifest) return { ok: false, problems, warnings, summary };

  // the prefix the CSS is held to — unknowable when neither a tokenPrefix nor
  // a valid name says it, and then that rule stands aside rather than holding
  // every token to a nonsense prefix
  const prefixKnown = (typeof manifest.tokenPrefix === 'string' && /^--[a-z][a-z0-9-]*-$/.test(manifest.tokenPrefix))
    || (typeof manifest.name === 'string' && NAME_RE.test(manifest.name));
  const prefix = prefixKnown ? tokenPrefixOf(manifest) : null;
  const stylesPath = typeof manifest.styles === 'string' && !packagePathProblem(manifest.styles) ? manifest.styles : null;
  const layoutsPath = typeof manifest.layouts === 'string' && !packagePathProblem(manifest.layouts) ? manifest.layouts : null;

  let tokens = [];
  let stylesRead = false;
  if (stylesPath) {
    const f = files.get(stylesPath);
    if (!f) problems.push({ file: 'design-system.json', line: keyLine(pkg.manifest, 'styles'), rule: 'file-missing', msg: `styles names ${stylesPath}, which is not in the package` });
    else {
      stylesRead = true;
      const r = styleProblems(f.text ?? '', { file: stylesPath, prefix, files });
      problems.push(...r.problems);
      tokens = r.tokens;
      summary.exceptions = r.exceptions;
    }
  }
  summary.tokens = [...new Set(tokens.filter((t) => prefix && t.name.startsWith(prefix)).map((t) => t.name))];
  summary.prefix = prefix;

  if (layoutsPath) {
    const f = files.get(layoutsPath);
    if (!f) problems.push({ file: 'design-system.json', line: keyLine(pkg.manifest, 'layouts'), rule: 'file-missing', msg: `layouts names ${layoutsPath}, which is not in the package` });
    else {
      const { layouts, problems: lp } = walkLayouts(f.text ?? '');
      problems.push(...lp.map((p) => ({ file: layoutsPath, ...p })));
      summary.layouts = layouts.map(({ id, title, slots }) => ({ id, title, slots }));
    }
  }

  const declared = new Set(tokens.map((t) => t.name));
  // a palette is held to the stylesheet only when there was one to read
  (stylesRead && Array.isArray(manifest.palette) ? manifest.palette : []).forEach((p, i) => {
    if (p && typeof p.token === 'string' && !declared.has(p.token)) {
      problems.push({ file: 'design-system.json', line: keyLine(pkg.manifest, 'palette'), rule: 'palette-undefined', msg: `palette[${i}] "${p.label ?? ''}" names ${p.token}, which ${stylesPath ?? 'the stylesheet'} never defines` });
    }
  });

  const assets = [];
  for (const [path, f] of files) {
    // the stylesheet and layouts the manifest names — or, when it names them
    // wrongly, the conventional files; either way not assets, and already said
    if (path === 'design-system.json' || path === stylesPath || path === layoutsPath) continue;
    if (((!stylesPath || !files.has(stylesPath)) && path === 'design-system.css')
      || ((!layoutsPath || !files.has(layoutsPath)) && path === 'layouts.html')) continue;
    if (path.split('/').some((seg) => seg.startsWith('.'))) continue;   // never served — dotfiles are not the package
    if (!path.includes('/') && isPapers(path)) continue;
    const e = ext(path);
    if (!ASSET_EXTENSIONS.includes(e)) {
      problems.push({ file: path, rule: 'asset-extension', msg: `.${e || '(none)'} is not an asset a design system may carry — ${ASSET_EXTENSIONS.join(', ')}` });
      continue;
    }
    assets.push({ path, ext: e, size: f.size ?? 0 });
    if ((f.size ?? 0) > ASSET_WARN_BYTES) {
      warnings.push({ file: path, rule: 'asset-size', msg: `${(f.size / 1024 / 1024).toFixed(1)} MB — over the ${ASSET_WARN_BYTES / 1024 / 1024} MB a deck should carry per asset; every deck using it pays for it on load` });
    }
    if (e === 'svg') problems.push(...svgProblems(f.text ?? '').map((p) => ({ file: path, ...p })));
  }
  summary.assets = assets;
  summary.palette = Array.isArray(manifest.palette) ? manifest.palette.length : 0;
  summary.recommendedThemes = manifest.recommendedThemes ?? [];
  return { ok: problems.length === 0, problems, warnings, summary };
}
