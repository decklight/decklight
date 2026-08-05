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
 * line and its opening bytes, before the first slide renders. The same holds
 * for the vector that never needs a block at all: an inline `onerror=` handler
 * or a `javascript:` href, which the CSP's unavoidable `'unsafe-inline'`
 * would happily run — `executableAttributes` names those.
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
    // start/end are the block's byte range in `html` — carried so a caller can
    // act on a block, not merely name it (PRESENT#STRICT splices on them).
    const at = { line: lineAt(html, s.start), bytes: s.inner.length, start: s.start, end: s.end };
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

/** Attributes whose value a browser treats as a URL to follow or load. */
const URL_ATTRS = /^(href|src|action|formaction|xlink:href|data)$/i;

/**
 * The value the way a browser would read it before deciding what it is:
 * character references decoded, then the whitespace and control characters
 * browsers ignore inside a scheme dropped. `jav&#x61;script:` and
 * `java\tscript:` both resolve to `javascript:` in a browser, so they resolve
 * to it here too — matching on spelling would be a scanner an attacker chooses
 * the spelling for.
 */
function resolvedValue(value) {
  const cp = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', colon: ':', semi: ';', tab: '\t', newline: '\n' };
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => cp(Number(d)))
    .replace(/&([a-z]+);/gi, (_, n) => named[n.toLowerCase()] ?? `&${n};`)
    .replace(/[\u0000-\u0020]/g, '')
    .toLowerCase();
}

/** Blank a block's inner text, length- and line-preserving, like maskComments. */
const blankInner = (html, re) =>
  html.replace(re, (_, open, inner, close) => open + inner.replace(/[^\n]/g, ' ') + close);

/**
 * Executable ATTRIBUTES — what no `<script>` scan can see.
 *
 * `script-src 'unsafe-inline'` (which a bundled deck forces, cli/present.mjs)
 * does not only permit script blocks: it is exactly what lets an inline
 * `onerror=` handler or a `javascript:` href run too. A deck's canonical shape
 * contains neither — content is markup, behaviour lives in the runtime — so
 * every one found is named, the same way an unaccounted block is.
 *
 * Named, in the one scan the label and the stripper share (PRESENT#STRICT):
 *   - `on*` handler attributes carrying a value (`onerror=`, `onclick=`, …)
 *   - URL attributes (href, src, action, formaction, xlink:href, data) whose
 *     value resolves to `javascript:` or `data:text/html`
 *   - `srcdoc` — an inline document that inherits the deck's CSP, so script
 *     inside it runs under the same `'unsafe-inline'` that lets the deck boot
 *
 * Deliberately NOT named: a handler *mentioned* in prose, an HTML comment, an
 * escaped code sample (`&lt;img onerror=…&gt;` never forms a tag), or the
 * runtime's own strings. Everything that is not an attribute on a real tag is
 * masked before the scan — a label that cried wolf on a slide ABOUT XSS would
 * be turned off within a day. Still a heuristic over markup, like everything
 * here: an inventory, never a verdict.
 */
export function executableAttributes(html) {
  // Comments first (the same mask scripts() applies), then script and style
  // text, so the tag walk below only ever reads markup. Every mask preserves
  // length and line breaks, so offsets found here index the original file.
  let masked = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  masked = blankInner(masked, /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi);
  masked = blankInner(masked, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi);

  const found = [];
  const open = /<([a-zA-Z][^\s/>]*)/g;
  let m;
  while ((m = open.exec(masked))) {
    // Walk to the tag's own `>` — quote-aware, because an attribute value may
    // legitimately contain one (`data-chart` JSON does).
    let i = m.index + m[0].length;
    while (i < masked.length && masked[i] !== '>') {
      const c = masked[i];
      if (c === '"' || c === "'") {
        i = masked.indexOf(c, i + 1);
        if (i === -1) { i = masked.length; break; }
      }
      i++;
    }
    const attrsStart = m.index + m[0].length;
    // Sequential, so a value is consumed by its own attribute's match and its
    // contents are never re-read as attribute names — `alt="use onclick= here"`
    // is one attribute, not two.
    const attrRe = /([^\s"'<>/=]+)(\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]*))?/g;
    const attrsText = masked.slice(attrsStart, Math.min(i, masked.length));
    let a;
    while ((a = attrRe.exec(attrsText))) {
      const name = a[1];
      const value = a[4] ?? a[5] ?? a[3] ?? '';
      const what =
        /^on[a-z]+$/i.test(name) && a[2] !== undefined ? 'handler'
          : URL_ATTRS.test(name) && /^(javascript:|data:text\/html)/.test(resolvedValue(value)) ? 'executable URL'
            : /^srcdoc$/i.test(name) && value.trim() ? 'inline document'
              : null;
      if (!what) continue;
      const start = attrsStart + a.index;
      const end = start + a[0].length;
      found.push({
        kind: what, tag: m[1].toLowerCase(), attr: name.toLowerCase(),
        line: lineAt(html, start), start, end, snippet: snippet(html.slice(start, end)),
      });
    }
    open.lastIndex = i + 1;
  }
  return found;
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
  const handlers = executableAttributes(html);
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
      handlers: handlers.length,
    },
    unaccounted: blocks.filter((b) => b.kind === 'unaccounted' || b.kind === 'external'),
    handlers,
    blocks,
  };
}

/**
 * The same inventory, with the unaccounted blocks taken out (PRESENT#STRICT).
 *
 * Pure: it takes HTML and returns HTML. Nothing here touches the filesystem,
 * which is the whole design — `present` strips on the way OUT, so the deck you
 * were sent is still the deck you were sent, byte for byte, and you can hand
 * the same file to someone else or diff it against the original.
 *
 * What survives is exactly what the label calls accounted for: the runtime
 * (inlined or by `src`), the `Decklight.init` boot call, JSON data blocks and
 * templates. That set is not a convenience — it is what a deck needs to render
 * itself. Builds, layouts, themes and `data-chart` JSON are markup and CSS and
 * attributes, so they are never in the blast radius to begin with.
 *
 * What it removes is what `unaccounted` and `external` mean: a block that
 * executes and matches nothing in the canonical shape. Each becomes a fixed
 * comment of the same shape — fixed on purpose, since interpolating any of the
 * removed bytes into the page is how a stripper hands the payload a second way
 * in, and the terminal is where the details belong anyway (never the
 * audience-facing page).
 *
 * Executable ATTRIBUTES go in the same pass, because the label names them
 * (`executableAttributes` is the one scanner both share): an inline `onerror=`
 * handler, a `javascript:` href, an inline `srcdoc` document. An attribute is
 * spliced OUT of its tag with nothing in its place — a comment cannot live
 * inside a tag, and the fixed-text rule holds either way: none of the removed
 * bytes enter the page. Widening the label without this stripper (or the
 * reverse) would let the printed inventory and the served bytes disagree,
 * which is worse than a limit you can read — so they move together.
 *
 * The honest limit that remains: both are heuristics over markup. A parser
 * trick this scan does not see is a parser trick strict serves, which is why
 * the label is an inventory and never a verdict.
 */
export function stripUnaccounted(html) {
  const blocks = classifyScripts(html);
  const strippedBlocks = blocks.filter((b) => b.kind === 'unaccounted' || b.kind === 'external');
  // An attribute inside a block that is going away rides out with the block's
  // own splice — splicing its range a second time would corrupt what survives.
  const attrs = executableAttributes(html)
    .filter((a) => !strippedBlocks.some((b) => a.start >= b.start && a.end <= b.end));
  const splices = [
    ...strippedBlocks.map((b) => ({
      at: b, start: b.start, end: b.end,
      insert: `<!-- decklight strict mode: script block removed (${b.bytes} B) -->`,
    })),
    ...attrs.map((a) => ({ at: a, start: a.start, end: a.end, insert: '' })),
  ];
  let out = html;
  // Back to front: every splice changes the offsets after it, none before it.
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, s.start)}${s.insert}${out.slice(s.end)}`;
  }
  return { html: out, stripped: splices.sort((a, b) => a.start - b.start).map((s) => s.at) };
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
  const { counts, unaccounted, handlers } = report;
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
  // Attributes are the other executable surface `script-src 'unsafe-inline'`
  // lets through, and the zero line is as load-bearing as the findings: it is
  // what says this class of content was examined at all.
  if (!counts.handlers) {
    lines.push(`${indent}  0 inline handlers or executable URLs in attributes`);
  } else {
    lines.push(`${indent}  ${counts.handlers} executable attribute${counts.handlers === 1 ? '' : 's'} — this file runs code outside any script block:`);
    for (const h of handlers) {
      lines.push(`${indent}    line ${String(h.line).padStart(5)}  ${`<${h.tag}>`.padEnd(10)}  ${h.snippet}`);
    }
  }
  return lines;
}
