// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The CSS a borrowed slide needs, cut out of the deck it came from
 * (`UNITS#REST`).
 *
 * A template is a deck somebody designed, and a good part of that design lives
 * in a `<style>` block in its head: `.breaks` is a stack of failure cards,
 * `.promises` is a three-column row. Taking the `<section>` and leaving the
 * stylesheet behind lands a slide in your deck that is *structurally* right
 * and looks like nothing — the markup names classes the deck has never heard
 * of. So the insert brings the rules that slide actually uses.
 *
 * This is a READER, not a CSS engine. It splits a stylesheet into rules,
 * looks at which classes and ids each selector names, and keeps the ones the
 * taken markup contains. It never resolves the cascade, never computes
 * specificity, and never decides that two rules mean the same thing.
 *
 * Two deliberate biases:
 *
 * - **Keep too much rather than too little.** A rule is carried when its
 *   selector names ANY class or id the markup has. `.breaks .missing` comes
 *   across on the strength of `.breaks` alone and then matches nothing, which
 *   costs a few bytes. The other error costs the slide its design.
 * - **Never carry a rule that names no class or id.** `p { margin: 0 }` from
 *   somebody else's deck would restyle every paragraph in yours. A rule that
 *   cannot be attributed to the taken markup is not the taken markup's rule.
 */

/** `.a .b > i#x` → the classes and ids it names. */
export function selectorTargets(selector) {
  const classes = new Set();
  const ids = new Set();
  // strings and attribute values first, so `[data-x=".foo"]` names nothing
  const bare = String(selector).replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, ' ');
  for (const m of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
  for (const m of bare.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) ids.add(m[1]);
  return { classes, ids };
}

/**
 * A stylesheet as a flat list of `{ kind, selector | prelude, body, text }`.
 *
 * Nested at-rules (`@media`, `@supports`, `@container`) keep their children so
 * a carried rule can be re-wrapped in the condition it was written under —
 * a rule lifted out of its `@media (print)` is a rule that now applies always.
 */
export function splitRules(css) {
  const src = String(css ?? '');
  const out = [];
  let i = 0;
  const skipTrivia = () => {
    for (;;) {
      const before = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
      }
      if (i === before) return;
    }
  };
  while (i < src.length) {
    skipTrivia();
    if (i >= src.length) break;
    const start = i;
    // read a prelude up to `{` or `;` (an at-statement like @import)
    let depth = 0;
    let quote = '';
    while (i < src.length) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '{' && depth <= 0) break;
      else if (c === ';' && depth <= 0) break;
      else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; }
      i++;
    }
    if (i >= src.length) break;
    const prelude = src.slice(start, i).trim();
    if (src[i] === ';') { i++; if (prelude) out.push({ kind: 'statement', prelude, text: `${prelude};` }); continue; }
    // read the braced body
    const bodyStart = ++i;
    let braces = 1;
    quote = '';
    while (i < src.length && braces > 0) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; }
      else if (c === '{') braces++;
      else if (c === '}') braces--;
      i++;
    }
    const body = src.slice(bodyStart, i - 1);
    const text = src.slice(start, i);
    if (/^@(media|supports|container|layer|scope)\b/i.test(prelude)) {
      out.push({ kind: 'group', prelude, body, text, inner: splitRules(body) });
    } else if (prelude.startsWith('@')) {
      out.push({ kind: 'at', prelude, body, text });
    } else {
      out.push({ kind: 'rule', selector: prelude, body, text });
    }
  }
  return out;
}

/** Every class and id the markup actually carries. */
export function markupTargets(html) {
  const classes = new Set();
  const ids = new Set();
  const src = String(html ?? '');
  for (const m of src.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    for (const c of (m[2] ?? m[3] ?? '').split(/\s+/)) if (c) classes.add(c);
  }
  for (const m of src.matchAll(/\bid\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const v = (m[2] ?? m[3] ?? '').trim();
    if (v) ids.add(v);
  }
  return { classes, ids };
}

/**
 * Every class and id a stylesheet gives rules to.
 *
 * The counterpart of `markupTargets`, and not interchangeable with it: one
 * reads `class="breaks"` out of markup, this reads `.breaks` out of selectors.
 * Feeding a stylesheet to the markup reader finds nothing at all, quietly.
 */
export function styleTargets(css) {
  const classes = new Set();
  const ids = new Set();
  const walk = (rules) => {
    for (const r of rules) {
      if (r.kind === 'rule') {
        const t = selectorTargets(r.selector);
        for (const c of t.classes) classes.add(c);
        for (const n of t.ids) ids.add(n);
      } else if (r.kind === 'group') walk(r.inner);
    }
  };
  walk(splitRules(css));
  return { classes, ids };
}

const hits = (selector, have) => {
  const { classes, ids } = selectorTargets(selector);
  if (!classes.size && !ids.size) return null;      // names nothing of its own
  const named = [...classes].map((c) => `.${c}`).concat([...ids].map((n) => `#${n}`));
  const met = [...classes].some((c) => have.classes.has(c)) || [...ids].some((n) => have.ids.has(n));
  return met ? named : null;
};

/**
 * The rules `markup` needs out of `css`, minus anything `defined` already
 * styles in the deck they are going to.
 *
 * A collision is REFUSED rather than resolved. If the receiving deck already
 * has its own `.breaks`, carrying the template's would silently restyle slides
 * the author never touched — a paste that edits pages you were not looking at.
 * The class comes back in `clashed` so the insert can say so, and the slide
 * lands with the deck's own meaning of the name, which is the one it can see.
 *
 * `animates` picks up the `@keyframes` a carried rule names, because a carried
 * `animation: fade .3s` whose keyframes stayed behind is a rule that does
 * nothing and says nothing.
 */
export function sliceFor(css, markup, { defined = { classes: new Set(), ids: new Set() } } = {}) {
  const have = markupTargets(markup);
  const carried = [];
  const clashed = [];

  const take = (rules) => {
    const kept = [];
    for (const r of rules) {
      if (r.kind === 'rule') {
        const named = hits(r.selector, have);
        if (!named) continue;
        const t = selectorTargets(r.selector);
        const clash = [...t.classes].filter((c) => have.classes.has(c) && defined.classes.has(c)).map((c) => `.${c}`)
          .concat([...t.ids].filter((n) => have.ids.has(n) && defined.ids.has(n)).map((n) => `#${n}`));
        if (clash.length) {
          for (const c of clash) if (!clashed.includes(c)) clashed.push(c);
          continue;
        }
        for (const n of named) if (!carried.includes(n)) carried.push(n);
        kept.push(r.text.trim());
      } else if (r.kind === 'group') {
        const innerKept = take(r.inner);
        if (innerKept.length) kept.push(`${r.prelude} {\n${innerKept.map((t) => `  ${t}`).join('\n')}\n}`);
      }
    }
    return kept;
  };

  const kept = take(splitRules(css));

  // the @keyframes a kept rule animates, wherever they were declared
  const all = splitRules(css);
  const wanted = new Set();
  for (const m of kept.join('\n').matchAll(/\banimation(?:-name)?\s*:([^;}]*)/gi)) {
    for (const w of m[1].split(/[\s,]+/)) if (w && !/^\d/.test(w)) wanted.add(w.trim());
  }
  const frames = [];
  const collectFrames = (rules) => {
    for (const r of rules) {
      if (r.kind === 'at' && /^@(-\w+-)?keyframes\b/i.test(r.prelude)) {
        const name = r.prelude.replace(/^@(-\w+-)?keyframes\s+/i, '').trim();
        if (wanted.has(name)) frames.push(r.text.trim());
      } else if (r.kind === 'group') collectFrames(r.inner);
    }
  };
  if (wanted.size) collectFrames(all);

  return { css: [...frames, ...kept].join('\n'), carried, clashed };
}

/**
 * Custom properties a carried rule reads that came from nowhere.
 *
 * A template's own `--card-bg`, declared on `:root`, is not carried: `:root`
 * names no class, and carrying it would redefine tokens across the whole
 * receiving deck. So a rule that reads one lands half-dressed. This does not
 * fix that — it NAMES it, so the insert can say which properties the slide
 * will be missing instead of letting somebody find the grey box on stage.
 *
 * A property the receiving deck's theme defines is not missing; `known` is how
 * the caller says so.
 */
export function danglingVars(carriedCss, sourceCss, known = new Set()) {
  const read = new Set();
  for (const m of String(carriedCss).matchAll(/var\(\s*(--[\w-]+)/g)) read.add(m[1]);
  if (!read.size) return [];
  const declaredHere = new Set();
  for (const m of String(carriedCss).matchAll(/(--[\w-]+)\s*:/g)) declaredHere.add(m[1]);
  const declaredThere = new Set();
  for (const m of String(sourceCss).matchAll(/(--[\w-]+)\s*:/g)) declaredThere.add(m[1]);
  return [...read].filter((v) => !declaredHere.has(v) && !known.has(v) && declaredThere.has(v)).sort();
}
