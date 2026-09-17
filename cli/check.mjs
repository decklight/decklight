#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight check — one headless lint of one deck, with one exit code.
 *
 *   decklight check <deck.html> [--no-render] [--json] [--wait <ms>]
 *
 * The promise this repo makes (README, SPEC PRESENTING: the overflow guardrail
 * is assertable headlessly) is that an agent can verify its own work without
 * eyes. The signals to verify it WITH were real but scattered: `pdf` names the
 * clipped slides on stderr while writing a PDF nobody asked for, `present
 * --check` prints the ingredients label, a missing image is a 404 only a human
 * with a browser open ever sees, and a ⟨CLICK⟩ that does not line up with a
 * build step is discovered while presenting. Each of those is a different
 * command, a different output shape, and a different exit code.
 *
 * So this is the one command whose whole job is to REPORT, per slide, what an
 * author or an agent would otherwise only find by looking — and to exit 1 when
 * something is actually wrong. Nothing here writes a file, starts a server, or
 * changes the deck.
 *
 * TWO HALVES, AND WHY THEY ARE SEPARATE FUNCTIONS. `staticFindings` is pure
 * over the file text (with `exists` injected, it touches no disk at all) and
 * `renderFindings` is pure over one dumped DOM string. Everything decidable is
 * therefore unit-testable without a browser, and `--no-render` is a real mode
 * rather than a degraded one: on a machine with no Chrome the static half still
 * runs and says so in one line, instead of refusing to run at all.
 *
 * WHAT IT IS NOT. Not a style critic and not a verdict on the deck — the same
 * position cli/audit.mjs takes about the ingredients label. Every finding names
 * something checkable: a file that is not on disk, a section that never closes,
 * a count that disagrees with another count, a slide the browser measured as
 * clipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { computeGroups, orderItem } from '../tools/build-groups.mjs';
import { findChrome, chromeArgs } from '../tools/chrome.mjs';
import { runAsync, CODEC_MS } from '../tools/exec.mjs';
import {
  NOTES_ASIDE, cleanNotes, indexOfCI, readAttrs, sectionBodies, sectionCloseIndex,
  sectionInner, slideHeading, splitOpenTag,
} from '../tools/deck-html.mjs';
import { auditDeck } from './audit.mjs';
import { printUrl } from './pdf.mjs';
import { runMain } from './util.mjs';

/**
 * One finding. `slide` is null for anything outside a section (the head), and
 * `rule` is there for the `--json` reader: an agent filters on a stable name,
 * never on the wording of a message a human reads.
 */
const finding = (level, rule, slide, title, message) => ({ level, rule, slide, title, message });

// ── a deck as a tree, just enough of one ─────────────────────────────────────
// Both static halves need the same two things — which element carries which
// attribute, and how many ELEMENT CHILDREN it has — and neither is answerable
// with a flat regex sweep. tools/deck-html.mjs walks elements for its own
// slide-splicing (`sectionChildRanges`), but only ever at one level of one
// section; this is the same shape generalised, and it stays here because that
// is the file's job and the runtime never needs it.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Bodies that are not markup: a chart's JSON spec is not a tag soup. */
const OPAQUE_ELEMENTS = new Set(['script', 'style']);
/**
 * Tags HTML lets an author leave open, and what a new one closes. Decks are
 * hand-written, and `<li>a<li>b` is legal HTML that a naive stack would read
 * as one li nested in another — which would then report one build step where
 * the browser will show two, i.e. a warning about a deck that is correct.
 */
const IMPLIED_CLOSE = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], p: ['p'], option: ['option'],
  tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'], tfoot: ['thead', 'tbody', 'tfoot'],
};

const TAG = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/**
 * `html` as a tree of `{ tag, attrs, start, children }`, best-effort.
 *
 * Best-effort is the contract: this reads a file somebody is mid-edit on, so a
 * stray `</div>` is ignored rather than thrown on, and an unclosed tag simply
 * ends with the document. A lint that crashes on the deck it was asked about
 * is worse than one that reports a little less.
 */
export function parseTree(html) {
  const root = { tag: '#root', attrs: '', start: 0, children: [] };
  const stack = [root];
  const re = new RegExp(TAG.source, 'g');
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const [, closing, rawName, rawAttrs] = m;
    const tag = rawName.toLowerCase();
    if (closing) {
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;   // a close with no open is somebody's typo, not a nesting level
      continue;
    }
    const selfClosed = /\/\s*$/.test(rawAttrs);
    const node = { tag, attrs: rawAttrs.replace(/\/\s*$/, ''), start: m.index, children: [] };
    for (const implied of IMPLIED_CLOSE[tag] ?? []) {
      if (stack.at(-1).tag === implied) stack.pop();
    }
    stack.at(-1).children.push(node);
    if (selfClosed || VOID_ELEMENTS.has(tag)) continue;
    if (OPAQUE_ELEMENTS.has(tag)) {
      const close = indexOfCI(html, `</${tag}`, re.lastIndex);
      re.lastIndex = close === -1 ? html.length : close;
      continue;
    }
    stack.push(node);
  }
  return root;
}

/** Every node under `root`, itself excluded, in document order. */
function* descendants(root) {
  for (const child of root.children) {
    yield child;
    yield* descendants(child);
  }
}

/**
 * Each slide's byte range in the file, so a finding found at an offset can be
 * given a slide number.
 *
 * The end matters as much as the start: `sectionBodies` cuts at the NEXT
 * `<section`, so the last slide's piece carries the whole tail of the document
 * — `</div>`, the inlined runtime, `</body>`. Bounding each range at the
 * section's own `</section>` (deck-html's `sectionCloseIndex`, which knows
 * about `</section>` shown inside a code block) is what keeps a `<script src>`
 * in the page's tail from being reported as a fault of the last slide.
 */
export function sectionRanges(html) {
  const bodies = sectionBodies(html);
  const opens = [...String(html).matchAll(/<section\b/g)].map((m) => m.index);
  return bodies.map((body, i) => {
    const start = opens[i];
    const close = sectionCloseIndex(body);
    const end = close === -1
      ? (opens[i + 1] ?? html.length)
      : start + '<section'.length + close + '</section>'.length;
    return { slide: i + 1, start, end, body };
  });
}

/** The 1-based slide an offset falls in, or null for the head and the tail. */
const slideAt = (ranges, at) => ranges.find((r) => at >= r.start && at < r.end)?.slide ?? null;

// ── local assets ─────────────────────────────────────────────────────────────

/**
 * Attributes a browser fetches, per tag. `link` is conditional (only a
 * stylesheet is a local asset worth resolving) and the background trio is
 * read by the runtime rather than the browser (SPEC DECK_ANATOMY), which makes
 * no difference to the author: a path that is not there shows nothing either
 * way, and shows it silently.
 */
const ASSET_ATTRS = {
  img: ['src'], script: ['src'], source: ['src'], video: ['src'], audio: ['src'],
  track: ['src'], embed: ['src'], iframe: ['src'], object: ['data'],
};
/**
 * Paths the RUNTIME loads rather than the browser (SPEC DECK_ANATOMY,
 * TERMINAL_RECORDINGS). The distinction is invisible to an author: a
 * background photo or a cast that is not there shows nothing, and shows it
 * silently. `data-cast-inline="#id"` names an embedded block, not a file, and
 * falls out by itself — `localAsset` refuses an anchor.
 */
const LOADED_ATTRS = [
  'data-background-image', 'data-background-video', 'data-background-poster', 'data-cast',
];

/**
 * The local file an attribute value points at, or null when it points
 * somewhere this check cannot follow.
 *
 * ANY scheme means not-local, not merely the four common ones: `file:`,
 * `mailto:` and a Windows-style `C:` are all things a resolve-against-the-deck
 * would turn into a confident, wrong "missing asset". Same for a
 * protocol-relative `//cdn/x.js` and an in-page `#anchor`. What is left is a
 * relative or root-relative path, and THAT is the class of mistake worth
 * reporting: `%20`-encoded, because a browser decodes before it opens a file
 * and so must this, and stripped of `?query#hash`, because a cache-buster is
 * not part of the filename.
 */
export function localAsset(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const bare = raw.split(/[?#]/)[0];
  if (!bare) return null;
  try { return decodeURIComponent(bare); } catch { return bare; }   // a lone % is a filename, not an escape
}

/** Every (tag, attribute, value, offset) in the file that names a local file. */
function assetReferences(tree) {
  const out = [];
  for (const node of descendants(tree)) {
    const attrs = readAttrs(node.attrs);
    const named = [...(ASSET_ATTRS[node.tag] ?? [])];
    // a <link> is only an asset when it is the deck's CSS; rel="canonical" and
    // friends name a document, not a file beside the deck
    if (node.tag === 'link' && /\bstylesheet\b/i.test(attrs.rel ?? '')) named.push('href');
    for (const attr of [...named, ...LOADED_ATTRS]) {
      const path = localAsset(attrs[attr]);
      if (path) out.push({ tag: node.tag, attr, value: attrs[attr], path, at: node.start });
    }
  }
  return out;
}

// ── ⟨CLICK⟩ segments vs build steps ──────────────────────────────────────────

const SVG_SKIP = new Set(['defs', 'title', 'desc', 'style', 'metadata']);
const CONTAINER_TAGS = new Set(['ul', 'ol', 'table', 'tbody', 'dl', 'svg']);

/** src/core/builds.js `eligibleChildren`, over the file instead of the DOM. */
function eligibleChildren(node) {
  return node.children.filter((c) => {
    if (SVG_SKIP.has(c.tag)) return false;
    if (c.tag === 'aside') return false;
    return !('data-build-stay' in readAttrs(c.attrs));
  });
}

/** src/core/builds.js `isContainer` — the "one g is a leaf" resolution included. */
function isContainer(node) {
  if ('data-build-self' in readAttrs(node.attrs)) return false;
  if (CONTAINER_TAGS.has(node.tag)) return true;
  if (node.tag === 'div' || node.tag === 'g') return eligibleChildren(node).length >= 2;
  return false;
}

/** src/core/builds.js `stepSource`: a table steps by ROW, not by its tbody. */
function stepSource(node) {
  if (node.tag !== 'table') return eligibleChildren(node);
  const tbody = node.children.find((c) => c.tag === 'tbody');
  return tbody ? eligibleChildren(tbody) : eligibleChildren(node).filter((c) => c.tag === 'tr');
}

/**
 * A STATIC estimate of a slide's build steps — the file-reading twin of
 * `scanSlide` (SPEC BUILDS, BUILD_SEMANTICS).
 *
 * An estimate, and named as one: a container's children each become a step and
 * their own subtrees are then claimed (so a nested `data-build` inside a
 * counted child adds nothing), which this reproduces — but build PROVIDERS
 * (BUILD_PROVIDER_API) contribute steps that exist only once the runtime has
 * read a cast or parsed `data-lines`, and no file reader can count those.
 * `hasProvider` below is why the caller does not compare on such a slide at
 * all: a guess against a number nobody can know is a warning about nothing.
 */
export function buildSteps(node) {
  return buildItems(node).length;
}

/**
 * The slide's build steps as the order items `computeGroups` takes — the
 * static twin of `scanSlide`'s `push`: a container's children each one step
 * keyed by their own `data-build-order`, a leaf one step keyed by its own; a
 * stroke drawing in stages (`data-draw-stops`, #522) one step per stop, since
 * its count is right there in the attribute, unlike a provider's.
 */
function buildItems(node) {
  const items = [];
  let auto = 0;
  const push = (orderAttr) => { items.push(orderItem(orderAttr, auto)); auto++; };
  const stops = (n) => parseDrawStops(readAttrs(n.attrs)['data-draw-stops']).length;
  const stepsOf = (n) => {
    const attrs = readAttrs(n.attrs);
    if ('data-draw-stops' in attrs && stops(n)) {
      // its stops count up from its data-build-order, when it has one (#524)
      const base = parseInt(attrs['data-build-order'] ?? '', 10);
      for (let i = 0; i < stops(n); i++) push(Number.isFinite(base) ? String(base + i) : null);
      return;
    }
    push(attrs['data-build-order']);
  };
  const walk = (parent) => {
    for (const child of parent.children) {
      if (child.tag === 'aside' || OPAQUE_ELEMENTS.has(child.tag)) continue;
      const attrs = readAttrs(child.attrs);
      if ('data-build' in attrs) {
        if (isContainer(child)) { for (const c of stepSource(child)) stepsOf(c); continue; }
        stepsOf(child);    // a leaf is one step, and the engine keeps walking into it
      } else if ('data-draw-stops' in attrs && stops(child)) {
        stepsOf(child);    // a staged stroke outside any build container is its own provider
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return items;
}

/**
 * How many CLICKS the slide's builds take — steps tied by a shared explicit
 * `data-build-order` advance together (SPEC BUILD_SEMANTICS), so a slide with
 * three steps in two ties takes two clicks, and its notes want three segments,
 * not four (#526). The same `computeGroups` the runtime applies to the DOM.
 */
export function buildClicks(node) {
  return computeGroups(buildItems(node)).length;
}

/** The stop count a `data-draw-stops` attribute declares (the runtime's `parseDrawStops`, without a length to clamp to). */
function parseDrawStops(attr) {
  const raw = String(attr ?? '').trim().split(/[\s,]+/).filter(Boolean);
  const nums = raw.map((s) => parseFloat(s));
  return nums.length && nums.every((n) => Number.isFinite(n) && n >= 0) ? nums : [];
}

/**
 * Does this slide contain a widget whose step count only the runtime knows?
 *
 * Code stepping (`data-lines`) and a terminal cast register build providers
 * (BUILD_PROVIDER_API), so their steps are a count parsed at load. A chart is
 * the same shape without the API: `initCharts` MOVES the authored `data-build`
 * off the wrapper onto the `<svg>` it generates, whose series groups are then
 * the steps — a file reader sees an empty div and would report one step for a
 * slide that has one per series. On any of these the comparison is skipped
 * rather than guessed at: a warning about a number nobody can know is noise,
 * and noise is how a check gets turned off.
 */
const hasProvider = (node) => [...descendants(node)].some((n) => {
  const attrs = readAttrs(n.attrs);
  return 'data-lines' in attrs || 'data-cast' in attrs || 'data-cast-inline' in attrs || 'data-chart' in attrs;
});

/**
 * How many ⟨CLICK⟩ segments a slide's notes have, by the RUNTIME's rule.
 *
 * `notesSegsOf` (src/core/narration.js) keeps every part of the split, empties
 * included, because segment k must line up with build step k — so segments are
 * clicks + 1, always. `notesSegments` in deck-html drops empties, because it is
 * naming files; using it here would make a ⟨CLICK⟩ at the very start of a note
 * read as one fewer beat than the deck will actually play.
 */
export function clickSegments(notesHtml) {
  const text = String(notesHtml ?? '');
  if (!cleanNotes(text)) return 0;    // no notes at all is not a disagreement
  return text.split('⟨CLICK⟩').length;
}

// ── A. the static half ───────────────────────────────────────────────────────

/**
 * Everything decidable from the file text. Pure when `exists` is injected:
 * nothing here reads a file, spawns anything, or looks at the clock.
 *
 * `dir` is what a relative asset path resolves against — the deck's own
 * directory, exactly as the browser would resolve it from the deck's URL.
 */
export function staticFindings(html, { dir = '.', exists = existsSync } = {}) {
  const src = String(html ?? '');
  const out = [];
  const ranges = sectionRanges(src);
  // `sectionInner`, never the raw body: a body begins mid-open-tag, so a slide
  // with no heading to fall back on would be titled ` data-markdown>` — the
  // remnant of its own tag, read as the slide's opening words.
  const title = (slide) => (slide ? slideHeading(sectionInner(ranges[slide - 1].body), slide - 1) : 'head');
  const at = (offset) => {
    const slide = slideAt(ranges, offset);
    return { slide, title: title(slide) };
  };

  for (const range of ranges) {
    const { slide, body } = range;
    const attrs = readAttrs(splitOpenTag(body).attrs);
    const head = title(slide);
    const inner = sectionInner(body);

    // An unclosed section swallows every slide after it: the browser nests
    // them, the deck shows one slide where the file has five, and nothing else
    // in this file can be trusted about that slide either.
    if (sectionCloseIndex(body) === -1) {
      out.push(finding('error', 'unclosed-section', slide, head,
        'this <section> is never closed — every slide after it is swallowed into this one'));
    }

    // Markdown slides were removed in 0.3.0 (SPEC DECK_ANATOMY). The runtime
    // stamps data-markdown-removed and warns, but only once the deck is open;
    // in a file it is silent, and the slide comes up empty on stage.
    if ('data-markdown' in attrs) {
      out.push(finding('error', 'markdown-slide', slide, head,
        'markdown slides are not rendered — data-markdown was removed in 0.3.0, so this slide comes up '
        + 'empty; author it in HTML (SPEC DECK_ANATOMY)'));
    }

    const tree = parseTree(inner);
    const segments = clickSegments(NOTES_ASIDE.exec(inner)?.[1]);
    const steps = buildSteps(tree);
    const clicks = buildClicks(tree);
    // segments = clicks + 1, so a slide with one segment has no ⟨CLICK⟩ at all
    // and is making no claim about the builds.
    if (segments > 1 && segments - 1 !== clicks && !hasProvider(tree)) {
      const tied = clicks !== steps ? ` (${steps} build steps, tied by data-build-order)` : '';
      out.push(finding('warn', 'clicks-vs-builds', slide, head,
        `${segments} ⟨CLICK⟩ segment${segments === 1 ? '' : 's'} but ${clicks} build click${clicks === 1 ? '' : 's'}${tied}`
        + ' — segment k narrates click k, so the narration and the builds drift apart here'));
    }
  }

  // An asset that is not on disk is the failure with no symptom: the deck
  // renders, the image is a blank box, and whoever exported the PDF finds out
  // afterwards. Resolved the way the browser would, against the deck's folder.
  for (const ref of assetReferences(parseTree(src))) {
    if (exists(resolve(dir, ref.path))) continue;
    const where = at(ref.at);
    out.push(finding('error', 'missing-asset', where.slide, where.title,
      `missing asset: ${ref.value} — <${ref.tag} ${ref.attr}> points at nothing on disk`));
  }

  // The ingredients label (cli/audit.mjs), per item and per slide. A WARNING,
  // not an error: a deck may legitimately carry its own script, and this
  // command has no more standing than the label does to call that wrong — it
  // says what will happen to it. `installed: null` keeps this half pure; the
  // runtime hash is the label's business, not this one's.
  const report = auditDeck(src, { installed: null });
  for (const block of report.unaccounted) {
    const where = at(block.start);
    out.push(finding('warn', 'unaccounted-script', where.slide, where.title,
      `line ${block.line}: unaccounted script block (${block.src ? `src=${block.src}` : `${block.bytes} B`})`
      + ' — present --strict would strip this'));
  }
  for (const h of report.handlers) {
    const where = at(h.start);
    out.push(finding('warn', 'executable-attribute', where.slide, where.title,
      `line ${h.line}: ${h.kind} on <${h.tag}> (${h.attr}) — present --strict would strip this`));
  }

  return sortFindings(out);
}

/** Head first, then slides in order; within a slide, the order they were found. */
const sortFindings = (findings) => findings
  .map((f, i) => [f, i])
  .sort((a, b) => (a[0].slide ?? 0) - (b[0].slide ?? 0) || a[1] - b[1])
  .map(([f]) => f);

// ── B. the render half ───────────────────────────────────────────────────────

/**
 * Everything only a browser can say, read back off one `--dump-dom` of the
 * deck's `?print` view (SPEC PRESENTING): every slide rendered, every build
 * complete, so a slide that only clips once its last build lands is measured
 * like all the others.
 *
 * Pure over the dumped string. `slides` is what the FILE said, so the two
 * counts can be compared — a runtime that never mounted produces a page whose
 * sections are still there but whose measurements are all clean, which is the
 * one failure that reads exactly like a healthy deck.
 */
export function renderFindings(domHtml, { slides = 0 } = {}) {
  const dom = String(domHtml ?? '');
  const out = [];
  const tags = [...dom.matchAll(/<section\b[^>]*>/g)];
  const bodies = sectionBodies(dom);

  if (slides && tags.length !== slides) {
    out.push(finding('error', 'not-rendered', null, 'head',
      `the deck did not render: ${slides} section${slides === 1 ? '' : 's'} in the file, `
      + `${tags.length} on the page`));
  }

  tags.forEach((m, i) => {
    const slide = i + 1;    // print never re-orders: position IS the slide number
    const head = slideHeading(sectionInner(bodies[i] ?? ''), i);
    const attrs = readAttrs(m[0].slice('<section'.length).replace(/>$/, ''));
    if ('data-overflow' in attrs) {
      // The guardrail is a boolean today (engine.js `checkOverflow` toggles the
      // attribute), so the px figure is reported only if a future one writes it
      // — better than printing a number this file made up.
      const by = Number(attrs['data-overflow-by']);
      out.push(finding('error', 'overflow', slide, head,
        Number.isFinite(by) && by > 0
          ? `content is clipped (${Math.round(by)} px over)`
          : 'content is clipped — it does not fit the slide, and the audience never sees the rest'));
    }
    if ('data-split-conflict' in attrs) {
      out.push(finding('warn', 'split-conflict', slide, head,
        'data-layout="split" is fighting this slide\'s own column flexbox — two layout systems, '
        + 'drop one (SPEC COMPARISON_SLIDES)'));
    }
    // data-markdown-removed is deliberately not reported here: the static half
    // already names that slide from the file, and saying it twice would make a
    // machine with Chrome disagree with one without about how many findings a
    // deck has.
  });

  return sortFindings(out);
}

// ── output ───────────────────────────────────────────────────────────────────

/**
 * The findings as lines, grouped by slide. Pure, and marks are words rather
 * than colours or symbols, so a CI log and a terminal read the same.
 */
export function formatFindings(findings, { color = false, slides = 0 } = {}) {
  const RED = '\x1b[31m', YELLOW = '\x1b[33m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';
  const paint = (s, c) => (color ? `${c}${s}${RESET}` : s);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;
  if (!findings.length) return [`no findings — ${slides} slide${slides === 1 ? '' : 's'} checked`];

  const groups = new Map();
  for (const f of sortFindings(findings)) {
    const key = f.slide ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const lines = [];
  for (const [slide, list] of groups) {
    // `slideHeading` falls back to the slide's own number when a slide has no
    // heading and no words to borrow — printing that back as `slide 5 "slide 5"`
    // says nothing twice, so the quoted half is dropped instead.
    const title = list.find((f) => f.title)?.title ?? '';
    const named = title && title !== `slide ${slide}`;
    lines.push(slide === 0
      ? paint('head', BOLD)
      : paint(`slide ${slide}`, BOLD) + (named ? `  ${paint(`"${title}"`, DIM)}` : ''));
    for (const f of list) {
      lines.push(`  ${f.level === 'error' ? paint('error', RED) : paint('warn ', YELLOW)}  ${f.message}`);
    }
    lines.push('');
  }
  lines.push(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return lines;
}

const USAGE = `usage: decklight check <deck.html> [--no-render] [--json] [--wait <ms>]
  lints one deck and says, per slide, what you would otherwise only find by
  looking — for an AI agent after every edit, and for a human before a talk

  what it reports
    from the file     a <section> that is never closed · an image, video, cast
                      or stylesheet that is not on disk · a data-markdown slide
                      (removed in 0.3.0) · ⟨CLICK⟩ segments that do not line up
                      with the slide's build steps · script blocks and inline
                      handlers present --strict would strip
    from a render     slides the overflow guardrail measured as clipped, split
                      layouts fighting their own flexbox, and a deck whose
                      runtime never mounted at all

  --no-render    the file half only — no Chrome, no render (a machine without
                 Chrome skips that half by itself, and says so)
  --json         the findings as a JSON array: level, rule, slide, title, message
  --wait <ms>    render budget for heavy decks  [8000]

  exit 1 if anything is an error, 0 otherwise — warnings never fail the run`;

export async function checkMain(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const { opt } = argReader(args);
  const deck = firstPositional(args, ['--wait']);
  if (!deck) { console.error(`decklight check: needs a deck\n\n${USAGE}`); return 1; }
  const src = resolve(deck);
  if (!existsSync(src)) { console.error(`decklight check: no such deck: ${deck}`); return 1; }

  const html = readFileSync(src, 'utf8');
  const slides = sectionBodies(html).length;
  const findings = staticFindings(html, { dir: dirname(src) });

  // The render half is skipped rather than failed when there is no browser:
  // `findChrome` and never `chromeBin`, which exits the process — half a lint
  // is the useful answer on a machine that cannot run the other half.
  const json = args.includes('--json');
  const bin = args.includes('--no-render') ? null : findChrome();
  const notes = [];
  if (args.includes('--no-render')) notes.push('check: --no-render — the file half only, nothing was rendered');
  else if (!bin) notes.push('check: no Chrome found — the file half only; clipped slides go unreported (point $CHROME at one)');

  if (bin) {
    const wait = Number(opt('--wait', 8000));
    try {
      const dom = await runAsync(bin, [
        ...chromeArgs('--allow-file-access-from-files', `--virtual-time-budget=${wait}`),
        '--dump-dom', printUrl(src),
      ], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CODEC_MS,
        why: 'Chrome did not finish rendering — a slide is probably waiting on a resource it cannot reach',
      });
      findings.push(...renderFindings(dom, { slides }));
    } catch (e) {
      findings.push(finding('error', 'render-failed', null, 'head',
        `the deck could not be rendered — ${String(e.message ?? e).split('\n')[0]}`));
    }
  }

  const ordered = sortFindings(findings);
  const errors = ordered.filter((f) => f.level === 'error').length;
  if (json) {
    console.log(JSON.stringify(ordered, null, 2));
  } else {
    for (const note of notes) console.error(note);
    console.error(`check: ${basename(src)} — ${slides} slide${slides === 1 ? '' : 's'}`);
    console.log(formatFindings(ordered, { color: !!process.stdout.isTTY, slides }).join('\n'));
  }
  return errors ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(await runMain('check', () => checkMain(process.argv.slice(2))));
