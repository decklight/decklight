// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a link typed into a slide may point at (SPEC PRESENTING_EDITING).
 *
 * The URL box that ⌘K opens while text is edited in place (authoring.js)
 * asks this module, and nothing else, whether the address it was given can
 * go into the file, and in what spelling. Pure: no DOM, so the rule is
 * unit-tested on its own and the page and the tests cannot disagree.
 *
 * A deck carries five kinds of link: a web page (`https:`, `http:`), a mail
 * address (`mailto:`), a file beside the deck (a relative path), and a slide
 * of this deck (`#/N`). Everything else is refused with a reason, because a
 * link is an attribute a browser follows: `javascript:` and `data:text/html`
 * are exactly the executable URLs the ingredients label names
 * (`NO_TRUST#AUDIT`, cli/audit.mjs), and a deck that would be flagged the
 * moment it travels is not one the editor should write. The scheme is read
 * the way that scan reads it, character references decoded and the
 * whitespace a browser ignores inside a scheme dropped, so `jav&#x61;script:`
 * or `java\tscript:` is refused here as surely as it is named there.
 */

/** The schemes a link may carry as it is typed. */
const ALLOWED = new Set(['https', 'http', 'mailto']);
/** Schemes that run something when followed: refused with that reason. */
const RUNS_CODE = new Set(['javascript', 'vbscript', 'data']);
/** A file a deck sits beside, told from a domain by what it ends in. */
const FILE_EXT = /\.(html?|pdf|png|jpe?g|gif|svg|webp|avif|mp4|webm|mov|mp3|wav|ogg|m4a|txt|md|csv|json|xml|zip|pptx?|key|docx?|xlsx?)$/i;

/**
 * The value as a browser reads it before deciding what scheme it is: the
 * same decoding `NO_TRUST#AUDIT` applies (cli/audit.mjs `resolvedValue`).
 */
export function resolvedScheme(value) {
  const cp = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', colon: ':', semi: ';', tab: '\t', newline: '\n' };
  const v = String(value ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => cp(Number(d)))
    .replace(/&([a-z]+);/gi, (_, n) => named[n.toLowerCase()] ?? `&${n};`)
    .replace(/[\u0000- ]/g, '')
    .toLowerCase();
  return v.match(/^([a-z][a-z0-9+.-]*):/)?.[1] ?? null;
}

const why = (text) => ({ ok: false, why: text });
const KINDS = 'https:, http:, mailto:, a file beside the deck, or a slide (#/3)';

/**
 * The href to write for what was typed, or why not.
 *
 * `{ ok: true, href, kind }` where kind is `web`, `mail`, `file` or `slide`
 * (with `slide`, its number), or `{ ok: false, why }`. `slides` is how many
 * the deck has, so `#/9` on a deck of five is refused rather than written.
 *
 * - `https://…`, `http://…` and `mailto:…` are kept, their scheme lowercased.
 * - A bare domain (`example.com`, `www.example.com/a`) becomes `https://…`;
 *   `//host/path` does too.
 * - `#/N`, `#N` and a bare number are slide N, written `#/N` (`#/N/S`, a
 *   build step, is kept).
 * - A relative path (`./notes.pdf`, `docs/guide.html`, `../shared/a.png`) is
 *   a file beside the deck, spaces written `%20`.
 * - Anything with another scheme, a root path, or a fragment that is not a
 *   slide is refused.
 */
export function linkTarget(raw, { slides = Infinity } = {}) {
  const v = String(raw ?? '').trim();
  if (!v) return why('type an address: ' + KINDS);
  // a slide of this deck: #/3, #3, 3, and #/3/2 for a build step
  const slide = v.match(/^#?\/?(\d+)(?:\/(\d+))?$/);
  if (slide && (v.startsWith('#') || /^\d+$/.test(v))) {
    const n = Number(slide[1]);
    if (n < 1) return why('slides count from 1');
    if (n > slides) return why(`this deck has ${slides} slide${slides === 1 ? '' : 's'}`);
    return { ok: true, href: `#/${n}${slide[2] !== undefined ? `/${Number(slide[2])}` : ''}`, kind: 'slide', slide: n };
  }
  if (v.startsWith('#')) return why('a link inside the deck goes to a slide: #/3');
  // protocol-relative: the page's own scheme, which for a deck opened from
  // disk is file:, so it is written as the https: it means
  if (v.startsWith('//')) return linkTarget('https:' + v, { slides });
  const scheme = resolvedScheme(v);
  // `example.com:8080/x` reads as scheme `example.com`: a dotted "scheme"
  // followed by a port is a host
  const hostPort = /^[a-z0-9-]+(\.[a-z0-9-]+)+:\d+([/?#]|$)/i.test(v);
  if (scheme && !hostPort) {
    if (scheme === 'data') return why('a data: link carries a page of its own, which can run code: link to a file beside the deck instead');
    if (RUNS_CODE.has(scheme)) return why(`${scheme}: links run code when clicked, so a deck does not carry them`);
    if (!ALLOWED.has(scheme)) return why(`${scheme}: is not a link a deck can carry: use ${KINDS}`);
    // the spelling typed, scheme lowercased; nothing else is touched
    const rest = v.slice(v.indexOf(':') + 1);
    if (scheme === 'mailto') {
      if (!/^[^\s@]+@[^\s@]+$/.test(rest.split('?')[0])) return why('mailto: needs an address, like mailto:ana@example.com');
      return { ok: true, href: 'mailto:' + rest, kind: 'mail' };
    }
    if (!/^\/\/[^\s/?#]+/.test(rest)) return why(`${scheme}: needs a site after it, like ${scheme}://example.com`);
    if (/\s/.test(rest)) return why('an address has no spaces in it');
    return { ok: true, href: `${scheme}:${rest}`, kind: 'web' };
  }
  if (v.startsWith('/')) return why('a path from the site root breaks when the deck moves: write it beside the deck (./file.pdf)');
  const first = v.split(/[/?#]/)[0];
  const isFile = v.startsWith('./') || v.startsWith('../')
    || !first.includes('.')
    || (FILE_EXT.test(first) && !/[/?#]/.test(v) && !/^www\./i.test(first));
  if (isFile) return { ok: true, href: v.replace(/ /g, '%20'), kind: 'file' };
  // a bare domain: the web, over https
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?$/i.test(first)) return why(`${first} is not a site or a file: use ${KINDS}`);
  if (/\s/.test(v)) return why('an address has no spaces in it');
  return { ok: true, href: 'https://' + v, kind: 'web' };
}

/**
 * The slides to offer while a slide link is typed: `#`, `#/`, `#/1` or a
 * bare `1` list the slides whose number starts so, at most `max`, with
 * their titles. Anything else offers none.
 */
export function slideSuggestions(raw, titles, { max = 6 } = {}) {
  const m = String(raw ?? '').trim().match(/^(?:#\/?(\d*)|(\d+))$/);
  if (!m) return [];
  const digits = m[1] ?? m[2] ?? '';
  const out = [];
  for (let i = 0; i < titles.length && out.length < max; i++) {
    if (String(i + 1).startsWith(digits)) out.push({ slide: i + 1, title: titles[i], href: `#/${i + 1}` });
  }
  return out;
}
