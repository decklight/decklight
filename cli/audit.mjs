// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The ingredients label — what a deck will execute, itemised.
 *
 * MARKETPLACE.md INTEGRITY calls this the canonical-shape audit, and its value
 * comes from what a decklight deck *is*: content is HTML, themes are CSS,
 * charts are JSON read by the runtime, casts are JSON read by the player. A
 * well-formed deck therefore contains a very short list of executable things,
 * and everything else that executes is worth naming.
 *
 * **An inventory, never a verdict** (PRESENT). There is no "safe", no green
 * check, no score. The scan is a set of heuristics over a file an attacker may
 * have edited; a verdict would manufacture confidence the mechanism cannot
 * back, and the first person to trust it would be the one it fails. A list of
 * what will run makes no such promise and is still the thing you needed.
 *
 * What it does catch is the realistic attack this whole wave exists for:
 * someone appends a `<script>` to a bundled deck before forwarding it. That
 * block matches nothing in the canonical shape, so it gets named, with its
 * line and its opening bytes, before the first slide renders.
 *
 * The crypto path — a Sigstore signature over the whole file — is
 * INTEGRITY#SIGNING and is separate on purpose: this audit needs no signature,
 * no network, and no cooperation from whoever produced the file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scripts, headStyles } from './upgrade.mjs';
import { scriptSafe } from './util.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The deck's own claim about which runtime it carries.
 *
 * Read from the build banner, because minification renames the exported
 * `version` const and the banner is the one place a tool can read it back out
 * of an inlined bundle (build.mjs says so where it writes it). This is the
 * deck's claim, not a verified fact — the hash below is what makes it checkable.
 */
export function runtimeVersion(html) {
  return /\/\*!\s*Decklight v(\d+\.\d+\.\d+[^\s*]*)/.exec(html)?.[1] ?? null;
}

/**
 * The byte-exact inlined runtime the installed package would produce.
 *
 * `bundle`, `init` and `upgrade` all inline `dist/decklight.js` the same way —
 * sourceMappingURL stripped, then scriptSafe-escaped — so reproducing that
 * transform here is what lets a hash comparison mean anything. They differ only
 * in the whitespace around the payload, which is why the comparison trims.
 */
export function installedRuntime(root = PKG_ROOT) {
  const file = path.join(root, 'dist/decklight.js');
  if (!existsSync(file)) return null;
  const js = scriptSafe(readFileSync(file, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, ''));
  return { text: js, hash: sha256(js.trim()), version: runtimeVersion(js) };
}

/** 1-based line of a byte offset — the coordinate a person can act on. */
const lineAt = (html, index) => html.slice(0, index).split('\n').length;

/** First non-blank line of a block, clipped — enough to recognise it by. */
function snippet(inner, max = 88) {
  const line = inner.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/**
 * A `<script>` whose entire body is one `Decklight.init(…)` call — the boot
 * line every deck has, written by `init` and preserved by `bundle`.
 *
 * Matched by SHAPE, not by "mentions Decklight.init": `Decklight.init();
 * fetch('//evil')` mentions it too. Comments and an optional assignment are
 * allowed because that is what the scaffolder writes (`const deck =
 * Decklight.init({…})`); anything after the call's closing paren is not.
 */
export function isBootCall(inner) {
  const bare = inner
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .trim();
  const m = /^(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?Decklight\s*\.\s*init\s*\(/.exec(bare);
  if (!m) return false;
  // Walk to the matching paren; whatever follows may be at most a semicolon.
  // A greedy regex to the LAST ")" cannot do this job — `Decklight.init();
  // fetch("//evil")` starts and ends exactly right — and a walker that does
  // not know about strings flags `{ alt: "Acme (Inc)" }`, which is a false
  // positive on a deck that did nothing wrong. So: strings are skipped.
  let depth = 0;
  for (let i = m[0].length - 1; i < bare.length; i++) {
    const c = bare[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < bare.length && bare[i] !== c; i++) if (bare[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return /^\s*;?\s*$/.test(bare.slice(i + 1));
  }
  return false;
}

/** Does this block define the runtime? (upgrade's fallback locator, verbatim.) */
const definesRuntime = (s) => /(?:\bvar\s+|\bwindow\.)Decklight\s*=/.test(s.inner);

/**
 * Sort every `<script>` in `html` into what it is.
 *
 * kinds: `runtime` (inlined engine) · `runtime-src` (the engine by reference,
 * a source deck) · `data` (`type="application/json"` — casts, viseme sidecars,
 * voice manifests) · `template` (`type="text/template"` — never executed by any
 * browser) · `boot` (the `Decklight.init` call) · `external` (someone else's
 * `src=`) · `unaccounted` (executes, matches nothing above).
 */
export function classifyScripts(html) {
  const all = scripts(html);
  const marked = all.find((s) => /\bdata-decklight-runtime\b/i.test(s.attrs));
  // Unmarked decks (bundle writes a bare <script>): the runtime is the block
  // defining Decklight before the init call — upgrade's fallback, so the two
  // commands always agree on which block is the engine.
  let fallback = null;
  if (!marked) {
    const initAt = all.findIndex((s) =>
      !/\bsrc\s*=/i.test(s.attrs) && /Decklight\.init\s*\(/.test(s.inner) && !definesRuntime(s));
    for (let i = initAt - 1; i >= 0; i--) {
      if (!/\bsrc\s*=/i.test(all[i].attrs) && definesRuntime(all[i])) { fallback = all[i]; break; }
    }
  }
  const runtimeBlock = marked ?? fallback;

  return all.map((s) => {
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(s.attrs)?.[1]?.toLowerCase() ?? '';
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(s.attrs)?.[1] ?? null;
    const at = { line: lineAt(html, s.start), bytes: s.inner.length };
    if (s === runtimeBlock) return { kind: 'runtime', ...at, inner: s.inner };
    if (src) {
      // a source deck loads dist/decklight.js by reference; anything else with
      // a src is a third party and is named as one
      return /(^|\/)decklight(\.min)?\.js(\?|#|$)/i.test(src)
        ? { kind: 'runtime-src', ...at, src }
        : { kind: 'external', ...at, src, snippet: src };
    }
    // Data, not findings. A JSON block is inert until the runtime reads it —
    // no browser executes it — so casts, visemes and voice manifests are
    // inventory lines, never suspects.
    if (type === 'application/json') return { kind: 'data', ...at, subtype: dataSubtype(s.attrs) };
    if (type === 'text/template') return { kind: 'template', ...at };
    // A type the browser does not recognise as JS is not executed either, but
    // it is unusual enough in a deck to be worth naming rather than filing.
    if (type && !/^(text\/javascript|application\/javascript|module)$/.test(type)) {
      return { kind: 'unaccounted', ...at, snippet: `type="${type}" — ${snippet(s.inner)}` };
    }
    if (isBootCall(s.inner)) return { kind: 'boot', ...at };
    return { kind: 'unaccounted', ...at, snippet: snippet(s.inner) };
  });
}

function dataSubtype(attrs) {
  if (/\bdata-decklight-visemes\b/i.test(attrs)) return 'visemes';
  if (/\bdata-decklight-voices\b/i.test(attrs)) return 'voice manifest';
  return 'cast';
}

/**
 * The whole label, as data. `present` prints it; `--check` exits on it.
 *
 * `runtime.state` is deliberately three-valued. A version this install does not
 * have cannot be hash-checked here at all, and saying so is the honest answer —
 * see the note on hashes in the PR: this package can only vouch for the build it
 * ships, and inventing hashes for versions it has never seen would be the exact
 * manufactured confidence the inventory refuses elsewhere.
 */
export function auditDeck(html, { installed = installedRuntime() } = {}) {
  const blocks = classifyScripts(html);
  const rt = blocks.find((b) => b.kind === 'runtime');
  const rtSrc = blocks.find((b) => b.kind === 'runtime-src');
  const version = runtimeVersion(html);

  let runtime;
  if (rt) {
    const hash = sha256(rt.inner.trim());
    const state = !installed ? 'uncheckable'
      : hash === installed.hash ? 'matches'
        : version && installed.version && version !== installed.version ? 'other-version'
          : 'differs';
    runtime = { kind: 'inline', version, hash, state, installedVersion: installed?.version ?? null };
  } else if (rtSrc) {
    // A source deck's engine is a separate file this audit never sees. Naming
    // that limit beats hashing the empty <script> tag and reporting a match.
    runtime = { kind: 'external', version, src: rtSrc.src, state: 'not-inlined' };
  } else {
    runtime = { kind: 'missing', version, state: 'not-found' };
  }

  const count = (k) => blocks.filter((b) => b.kind === k).length;
  return {
    runtime,
    themes: headStyles(html).filter((s) => /\bdata-theme\b/i.test(s.attrs)).length,
    counts: {
      runtime: count('runtime') + count('runtime-src'),
      data: count('data'),
      template: count('template'),
      boot: count('boot'),
      unaccounted: count('unaccounted') + count('external'),
    },
    unaccounted: blocks.filter((b) => b.kind === 'unaccounted' || b.kind === 'external'),
    blocks,
  };
}

const RUNTIME_LINE = {
  matches: (r) => `runtime ${r.version ?? '(unversioned)'} — sha256 ${r.hash.slice(0, 12)}, identical to this install`,
  differs: (r) => `runtime ${r.version ?? '(unversioned)'} — sha256 ${r.hash.slice(0, 12)}, DIFFERS from this install's build of ${r.installedVersion}`,
  'other-version': (r) => `runtime ${r.version} — sha256 ${r.hash.slice(0, 12)}, not comparable here (this install ships ${r.installedVersion})`,
  uncheckable: (r) => `runtime ${r.version ?? '(unversioned)'} — sha256 ${r.hash.slice(0, 12)}, no installed build to compare against`,
  'not-inlined': (r) => `runtime ${r.version ?? '(unknown version)'} — loaded from ${r.src}, not inlined, so not hashed here`,
  'not-found': () => 'no decklight runtime found in this file',
};

/** The printed label: plain lines, no verdict, caller decides where they go. */
export function formatLabel(report, { indent = '  ' } = {}) {
  const { counts, unaccounted } = report;
  const lines = [`${indent}ingredients — what this file will execute`];
  lines.push(`${indent}  ${RUNTIME_LINE[report.runtime.state](report.runtime)}`);

  const inert = [];
  if (counts.data) inert.push(`${counts.data} data block${counts.data === 1 ? '' : 's'}`);
  if (report.themes) inert.push(`${report.themes} theme style${report.themes === 1 ? '' : 's'}`);
  if (counts.template) inert.push(`${counts.template} template${counts.template === 1 ? '' : 's'}`);
  if (counts.boot) inert.push(`${counts.boot} Decklight.init call`);
  if (inert.length) lines.push(`${indent}  ${inert.join(' · ')} — read by the runtime, not executed as script`);

  if (!counts.unaccounted) {
    lines.push(`${indent}  0 unaccounted script blocks`);
  } else {
    lines.push(`${indent}  ${counts.unaccounted} unaccounted script block${counts.unaccounted === 1 ? '' : 's'} — this file runs code that is not the runtime:`);
    for (const b of unaccounted) {
      const size = b.src ? `src=${b.src}` : `${b.bytes} B`;
      lines.push(`${indent}    line ${String(b.line).padStart(5)}  ${size.padEnd(10)}  ${b.snippet}`);
    }
  }
  return lines;
}
