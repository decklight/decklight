// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a deck TEMPLATE as a list of slides you can take (`UNITS#REST`).
 *
 * A template is one self-contained HTML deck — somebody's whole talk, with its
 * themes inlined and its images already `data:` URIs. `init --from` writes the
 * whole thing as a new deck, which is the only way it could be used until now:
 * a deck that already exists cannot be replaced by a template, it can only
 * take slides FROM one.
 *
 * So this reads the template the way the picker needs it — a numbered list with
 * a heading each — and, for each slide, what it points at that a different deck
 * will not have. That last part is the whole reason a slide cannot simply be
 * pasted and forgotten: a `data:` image travels, and `casts/demo.cast` does
 * not. The importer's posture applies here too — say it, by slide, rather than
 * discover it on stage.
 */

import { sectionBodies, sectionInner, slideHeading, isHiddenSection } from './deck-html.mjs';

/** A URL that travels with the markup: inline data, or somewhere on the web. */
const travels = (url) => /^(data:|https?:|#|mailto:)/i.test(url.trim());

/**
 * A section with the BODIES of `pre`, `code`, `script` and `style` blanked —
 * their open tags kept, because those carry real attributes.
 *
 * A slide teaching HTML shows markup as text, and only its angle brackets are
 * escaped: `&lt;link rel="stylesheet" href="theme.css"&gt;` carries a literal
 * `href="…"` that any attribute scan will find. The first template this
 * shipped against had exactly that slide, and it was reported as needing two
 * files it merely talks about. A slide ABOUT markup must not be flagged for
 * the markup it is teaching — a warning nobody can act on is how a report
 * stops being read.
 *
 * The open tag survives the blanking on purpose: `<pre data-cast="x.cast">` is
 * a terminal, and that reference is real.
 */
const scannable = (html) => String(html).replace(
  /(<(pre|code|script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
  (m, open, tag, body, close) => open + ' '.repeat(body.length) + close,
);

/**
 * What a section points at that its new deck will not have.
 *
 * Deliberately only the attributes that name a FILE decklight itself resolves
 * (DECK_ANATOMY): a cast, an image, background media. Anything else in a slide
 * is markup, and markup travels.
 */
export function externalRefs(sectionHtml) {
  const out = [];
  const attrs = /\b(data-cast|src|href|data-background-image|data-background-video|data-background-poster)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (const m of scannable(sectionHtml).matchAll(attrs)) {
    const url = m[3] ?? m[4] ?? '';
    if (!url || travels(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * A template's slides: `{ n, title, hidden, html, needs }`, in deck order.
 *
 * `html` is the section as written, open tag and all, ready to be inserted
 * somewhere else verbatim.
 */
export function templateSlides(html) {
  return sectionBodies(String(html ?? '')).map((body, i) => {
    const inner = sectionInner(body);
    const close = body.toLowerCase().lastIndexOf('</section>');
    const whole = `<section${close === -1 ? body : body.slice(0, close + '</section>'.length)}`;
    return {
      n: i + 1,
      title: slideHeading(inner, i),
      hidden: isHiddenSection(body),
      html: whole,
      needs: externalRefs(whole),
    };
  });
}

/**
 * `"2,5-7"` as slide numbers — sorted, de-duplicated, and refused when it names
 * a slide the template does not have.
 *
 * Refusing rather than clamping: `--slides 4-9` against a six-slide template is
 * somebody working from the wrong list, and quietly taking four to six hides
 * that until they look at the deck.
 */
export function parseSlideSpec(spec, total) {
  const picked = new Set();
  for (const piece of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    const one = /^\d+$/.test(piece) ? Number(piece) : null;
    if (one != null) {
      if (one < 1 || one > total) throw new Error(`no slide ${one} in this template (it has ${total})`);
      picked.add(one);
      continue;
    }
    if (!range) throw new Error(`not a slide or a range: "${piece}" — try 2,5-7`);
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from < 1 || to > total || from > to) {
      throw new Error(`no slides ${from}-${to} in this template (it has ${total})`);
    }
    for (let k = from; k <= to; k++) picked.add(k);
  }
  if (!picked.size) throw new Error('no slides named — try --slides 2,5-7, or leave it off for all of them');
  return [...picked].sort((a, b) => a - b);
}
