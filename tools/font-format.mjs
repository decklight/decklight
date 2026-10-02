// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The font package format, and the rules it is held to (SPEC FONTS). A font
// is what a theme NAMES and cannot carry: a theme's --font-body is a list of
// family names, and the files behind a name that is not on the machine come
// from somewhere else — a Google Fonts @import that needs the network, or
// nothing. A font package carries the faces themselves, by reference from a
// marketplace, so a deck (and its bundle) has them wherever it is opened.
//
//   <name>/
//     font.json     apiVersion, name, version, title, family, fallback,
//                   license, faces [{ file, weight, style }] (+ description, role)
//     *.woff2       the faces — woff2 or woff, nothing else that runs or loads
//     OFL.txt …     the licence the manifest names: a hand-over redistributes
//                   the font, so a package without one is refused
//
// PURE: texts and a file list in, never a path. `decklight font check` is a
// thin main over it, and the same rules run again wherever a package is
// served — and `fontFaceCss` is the one place an @font-face rule is written,
// for the servers and for bundle alike.

import { SEMVER_RE } from './semver.mjs';
import { NAME_RE, packagePathProblem } from './design-system-format.mjs';

/** The font-package contract's own version — additive only, like DESIGN_SYSTEM_API_VERSION. */
export const FONT_API_VERSION = 1;

/** What a face may be. The magic bytes are checked too: an extension is a claim. */
export const FACE_EXTENSIONS = ['woff2', 'woff'];
const MAGIC = { woff2: 'wOF2', woff: 'wOFF' };

/** Past this, a face is a warning — every deck that uses it, and every bundle, carries it. */
export const FACE_WARN_BYTES = 512 * 1024;

/** A family name as a stylesheet will quote it: letters, digits, spaces, _ and -. */
export const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** A fallback stack: family names (quoted or not), commas, spaces — nothing that could close a rule. */
const FALLBACK_RE = /^[A-Za-z0-9 ,'"_-]{1,200}$/;
const GENERIC = /(^|,)\s*(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji)\s*$/;
export const ROLES = ['body', 'heading', 'mono', 'any'];

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const keyLine = (raw, key) => {
  const i = raw.indexOf(`"${key}"`);
  return i < 0 ? 1 : lineAt(raw, i);
};
const ext = (path) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
/** Top-level papers that are part of a package without being faces. */
const isPapers = (p) => /^(readme|license|licence|changelog|notice|ofl|authors|fontlog)([._-][\w.-]*)?(\.(md|txt))?$/i.test(p);

/** A weight as CSS takes it: a number 1–1000, or a variable font's "lo hi" range. */
function weightProblem(w) {
  if (Number.isInteger(w)) return w >= 1 && w <= 1000 ? null : 'is outside 1–1000';
  if (typeof w === 'string' && /^\d{1,4} \d{1,4}$/.test(w)) {
    const [lo, hi] = w.split(' ').map(Number);
    return lo >= 1 && hi <= 1000 && lo < hi ? null : 'must be "lo hi" with 1 ≤ lo < hi ≤ 1000';
  }
  return 'must be a number (400) or a variable font\'s range ("100 900")';
}

/**
 * `font.json`, parsed and shaped: `{ manifest, problems }`, `manifest` null
 * when the JSON itself does not parse.
 */
export function readFontManifest(raw) {
  const problems = [];
  const file = 'font.json';
  const at = (rule, key, msg) => problems.push({ file, line: keyLine(raw, key), rule, msg });
  let m;
  try { m = JSON.parse(raw); } catch (e) {
    const pos = /position (\d+)/.exec(e.message)?.[1];
    problems.push({ file, line: pos ? lineAt(raw, Number(pos)) : 1, rule: 'manifest-json', msg: `not valid JSON — ${e.message}` });
    return { manifest: null, problems };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    problems.push({ file, line: 1, rule: 'manifest-json', msg: 'must be a JSON object' });
    return { manifest: null, problems };
  }
  if (!Number.isInteger(m.apiVersion) || m.apiVersion < 1) at('manifest-field', 'apiVersion', 'apiVersion must be a positive integer — the font format version this package needs');
  else if (m.apiVersion > FONT_API_VERSION) at('api-too-new', 'apiVersion', `apiVersion ${m.apiVersion} needs a newer decklight — this one reads fonts up to ${FONT_API_VERSION}`);
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) at('manifest-field', 'name', `name ${JSON.stringify(m.name)} — a lowercase word: letters, digits and -, starting with a letter`);
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) at('manifest-field', 'version', `version ${JSON.stringify(m.version)} — a semver version, major.minor.patch (e.g. "4.1.0"), no leading v`);
  if (typeof m.title !== 'string' || !m.title.trim()) at('manifest-field', 'title', 'title must be the font\'s human name, e.g. "Inter"');
  if (typeof m.family !== 'string' || !FAMILY_RE.test(m.family)) {
    at('manifest-field', 'family', `family ${JSON.stringify(m.family)} — the CSS family name a theme writes in --font-body: letters, digits, spaces, _ and -`);
  }
  if (typeof m.fallback !== 'string' || !FALLBACK_RE.test(m.fallback)) {
    at('manifest-field', 'fallback', `fallback ${JSON.stringify(m.fallback)} — the stack used until the face loads, e.g. "system-ui, sans-serif": names, commas and quotes only`);
  } else if (!GENERIC.test(m.fallback)) {
    at('manifest-field', 'fallback', `fallback "${m.fallback}" must end in a generic family (sans-serif, serif, monospace, system-ui, …) — the one name every machine has`);
  }
  if (typeof m.license !== 'string') at('manifest-field', 'license', 'license must name the licence file in the package, e.g. "OFL.txt" — a font is licensed, and a deck that carries it redistributes it');
  else {
    const why = packagePathProblem(m.license);
    if (why) at('file-outside', 'license', `license "${m.license}" ${why}`);
  }
  if (m.description !== undefined && typeof m.description !== 'string') at('manifest-field', 'description', 'description must be a string');
  if (m.role !== undefined && !ROLES.includes(m.role)) at('manifest-field', 'role', `role must be one of ${ROLES.join(', ')} — what the font is drawn for`);
  if (!Array.isArray(m.faces) || !m.faces.length) at('manifest-field', 'faces', 'faces must be a non-empty array of { file, weight, style }');
  else {
    const seen = new Set();
    m.faces.forEach((f, i) => {
      if (!f || typeof f !== 'object') { at('manifest-field', 'faces', `faces[${i}] must be { file, weight, style }`); return; }
      if (typeof f.file !== 'string') at('manifest-field', 'faces', `faces[${i}].file must name a .woff2 or .woff in the package`);
      else {
        const why = packagePathProblem(f.file);
        if (why) at('file-outside', 'faces', `faces[${i}].file "${f.file}" ${why}`);
        else if (!FACE_EXTENSIONS.includes(ext(f.file))) at('face-extension', 'faces', `faces[${i}].file "${f.file}" — a face is ${FACE_EXTENSIONS.join(' or ')}`);
      }
      const wp = weightProblem(f.weight ?? 400);
      if (wp) at('manifest-field', 'faces', `faces[${i}].weight ${JSON.stringify(f.weight)} ${wp}`);
      const style = f.style ?? 'normal';
      if (!['normal', 'italic'].includes(style)) at('manifest-field', 'faces', `faces[${i}].style must be "normal" or "italic"`);
      const key = `${f.weight ?? 400}/${style}`;
      if (seen.has(key)) at('face-twice', 'faces', `faces[${i}] is weight ${f.weight ?? 400} ${style} again — one file per weight and style`);
      seen.add(key);
    });
  }
  return { manifest: m, problems };
}

/**
 * The admission gate over a package in memory: `{ manifest, files: Map<path,
 * { size, head?, text? }> }` — `head` the first bytes as a latin1 string, for
 * the magic check. Returns `{ ok, problems, warnings, summary }`.
 */
export function checkFontPackage(pkg) {
  const files = pkg.files ?? new Map();
  const { manifest, problems } = readFontManifest(String(pkg.manifest ?? ''));
  const warnings = [];
  const summary = {};
  if (!manifest) return { ok: false, problems, warnings, summary };
  Object.assign(summary, {
    name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion, title: manifest.title,
    family: manifest.family, fallback: manifest.fallback, role: manifest.role ?? 'any', license: manifest.license,
  });
  if (typeof manifest.license === 'string' && !packagePathProblem(manifest.license)) {
    const lic = files.get(manifest.license);
    if (!lic) problems.push({ file: 'font.json', line: keyLine(String(pkg.manifest), 'license'), rule: 'license-missing', msg: `license names ${manifest.license}, which is not in the package — a font travels with its licence or not at all` });
    else if (!lic.size) problems.push({ file: manifest.license, rule: 'license-missing', msg: 'the licence file is empty' });
  }
  const faces = [];
  const named = new Set();
  for (const [i, f] of (Array.isArray(manifest.faces) ? manifest.faces : []).entries()) {
    if (!f || typeof f.file !== 'string' || packagePathProblem(f.file) || !FACE_EXTENSIONS.includes(ext(f.file))) continue;
    named.add(f.file);
    const got = files.get(f.file);
    if (!got) { problems.push({ file: 'font.json', line: keyLine(String(pkg.manifest), 'faces'), rule: 'file-missing', msg: `faces[${i}].file ${f.file} is not in the package` }); continue; }
    if (typeof got.head === 'string' && !got.head.startsWith(MAGIC[ext(f.file)])) {
      problems.push({ file: f.file, rule: 'face-not-a-font', msg: `${f.file} is not a ${ext(f.file)} file — its first bytes are not "${MAGIC[ext(f.file)]}"` });
    }
    if ((got.size ?? 0) > FACE_WARN_BYTES) {
      warnings.push({ file: f.file, rule: 'face-size', msg: `${Math.round(got.size / 1024)} KB — over the ${FACE_WARN_BYTES / 1024} KB a face should weigh; every deck and bundle that uses it carries it (subset it, or ship woff2)` });
    }
    faces.push({ file: f.file, weight: f.weight ?? 400, style: f.style ?? 'normal', size: got.size ?? 0 });
  }
  // anything else in the package: papers are fine, and so is nothing else
  for (const path of files.keys()) {
    if (path === 'font.json' || path === manifest.license || named.has(path)) continue;
    if (path.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (!path.includes('/') && isPapers(path)) continue;
    if (FACE_EXTENSIONS.includes(ext(path))) {
      warnings.push({ file: path, rule: 'face-unused', msg: 'a face font.json does not list — it is never served' });
      continue;
    }
    problems.push({ file: path, rule: 'file-kind', msg: `.${ext(path) || '(none)'} has no place in a font package — font.json, its faces (${FACE_EXTENSIONS.join(', ')}) and its licence` });
  }
  summary.faces = faces;
  summary.bytes = faces.reduce((t, f) => t + f.size, 0);
  return { ok: problems.length === 0, problems, warnings, summary };
}

/** The family and its fallback as a theme token would hold them: `'Inter', system-ui, sans-serif`. */
export const fontStack = (m) => `'${m.family}', ${m.fallback}`;

/**
 * The @font-face rules for a package, one per face, each `src` from
 * `urlFor(file, face)` — a served path, or a bundle's data: URI. The family
 * and every value were held to the manifest's rules, so nothing here can
 * close the rule it sits in. `font-display: swap`: the fallback shows at once
 * and the face replaces it — a slide is never blank while a font loads.
 */
export function fontFaceCss(manifest, urlFor) {
  return (manifest.faces ?? []).map((f) => {
    const format = ext(f.file) === 'woff2' ? 'woff2' : 'woff';
    return `@font-face { font-family: '${manifest.family}'; src: url("${urlFor(f.file, f)}") format("${format}");`
      + ` font-weight: ${f.weight ?? 400}; font-style: ${f.style ?? 'normal'}; font-display: swap; }`;
  }).join('\n');
}
