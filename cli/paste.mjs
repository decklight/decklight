// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a paste may put in a deck (PRESENTING_EDITING, the clipboard).
 *
 * A paste is not an edit the author typed: any web page can put markup on
 * the clipboard, a forged Decklight marker included, and markup that runs
 * would run on the local origin that can write the deck. So everything
 * pasted is cleaned here, on the server, before it reaches the file, and
 * what was left out is named so the page can say it:
 *
 *   - whole elements that run or embed: <script>, <style>, <iframe>, <frame>,
 *     <frameset>, <object>, <embed>, <applet>, <base>, <link>, <meta>, <form>;
 *   - every attribute `executableAttributes` (audit.mjs) finds: an `on*=`
 *     handler, a `javascript:` or `data:text/html` URL, a `srcdoc`;
 *   - a `style` attribute that reaches out (`url(javascript:`, `expression(`).
 *
 * Pictures by absolute http(s) URL stay: the author can already write them.
 */

import { executableAttributes } from './audit.mjs';

/** The elements a paste never keeps, each with how the page says it was left out. */
const DROPPED_ELEMENTS = [
  ['script', 'a script'], ['style', 'a style block'], ['iframe', 'a frame'], ['frame', 'a frame'], ['frameset', 'a frame'],
  ['object', 'an embedded object'], ['embed', 'an embedded object'], ['applet', 'an embedded object'],
  ['base', 'a base link'], ['link', 'a linked file'], ['meta', 'a meta tag'], ['form', 'a form'],
];
const VOID = new Set(['embed', 'base', 'link', 'meta', 'frame']);

/**
 * `html` with everything that would run taken out. Returns `{ html, dropped }`:
 * `dropped` is what was left out, said once each ("a script", "an onclick
 * handler", "a javascript: link").
 */
export function sanitizePasted(html) {
  let out = String(html ?? '');
  const said = new Set();
  // comments go first: one could hide a tag from the walk below, and none is content
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  for (const [tag, what] of DROPPED_ELEMENTS) {
    const whole = VOID.has(tag)
      ? new RegExp(`<${tag}\\b[^>]*>`, 'gi')
      : new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>|<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(whole, () => { said.add(what); return ''; });
  }
  // a stray close tag of one of them, left by an element that never opened
  out = out.replace(new RegExp(`<\\/(?:${DROPPED_ELEMENTS.map(([t]) => t).join('|')})\\s*>`, 'gi'), '');
  // attributes that run, last to first so each offset still stands
  const found = executableAttributes(out).sort((a, b) => b.start - a.start);
  for (const f of found) {
    out = out.slice(0, f.start).replace(/\s+$/, '') + out.slice(f.end);
    said.add(f.kind === 'handler' ? `an ${f.attr} handler` : f.kind === 'executable URL' ? `a ${/data:/i.test(f.snippet) ? 'data:' : 'javascript:'} link` : 'an inline document');
  }
  // a style that reaches out of the page
  out = out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, (m, v) => {
    if (!/url\s*\(\s*["']?\s*javascript:|expression\s*\(|-moz-binding|behavior\s*:/i.test(v)) return m;
    said.add('a style that runs code');
    return '';
  });
  return { html: out, dropped: [...said] };
}

/** The relative paths a paste points at (a picture, a background, a video), each once, in order. */
export function relativeAssets(html) {
  const out = new Set();
  const re = /\s(?:src|poster|href|data-background-image|data-background-video|data-background-poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!v || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(v)) continue;
    out.add(v.split(/[?#]/)[0]);
  }
  return [...out];
}

/**
 * A slide from the clipboard, as the deck will take it (PRESENTING_EDITING):
 * exactly one `<section>…</section>`, cleaned the way an element is
 * (sanitizePasted), its page ids left behind (`withoutPageIds`, handed in so
 * this file stays free of the editor's). Returns `{ section, dropped }`, or
 * throws a sentence (status 400) for anything else.
 */
export function pasteSection(markup, withoutPageIds = (x) => x) {
  const { html, dropped } = sanitizePasted(markup);
  const t = html.trim();
  const opens = t.match(/<section\b/gi) ?? [];
  if (!/^<section\b[^>]*>[\s\S]*<\/section>$/i.test(t) || opens.length !== 1) {
    throw Object.assign(new Error('a pasted slide is one <section>, and this is not one'), { status: 400 });
  }
  return { section: withoutPageIds(t), dropped };
}
