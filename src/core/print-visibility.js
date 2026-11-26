// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a still shows: the end of every entrance an author wrote by hand, and
 * a word about anything that still does not show (#1184).
 *
 * A deck's own CSS can bring an element in with keyframes: it starts at
 * `opacity: 0` and a `section.active .box { animation: in .6s forwards }`
 * rule fades it up once the slide is on. On screen it ends visible. A still
 * never sees the end: Chrome lays a page out again for print media, and a
 * running animation's value does not survive that, so `decklight pdf` printed
 * the element at its base style, invisible, and said nothing. The same goes
 * for every picture taken of a moment (the pptx export, a `shot`, a frame of
 * `decklight video`): a still is the slide as it ends up, as builds already are.
 *
 * Two halves:
 *
 *  - `finishAuthorAnimations` brings an author's CSS animations and
 *    transitions inside the slides to their end state (the Web Animations
 *    API's `finish()`: no frame needed, and a `forwards` fill applies exactly
 *    as the live slide ends). The engine's own are left alone: they are
 *    `dl-`/`decklight-`/`terminal-` keyframes (data-animate loops, builds,
 *    the travel token) or script-made animations, never a CSS animation of
 *    the deck's naming. A loop that never ends cannot be finished and is left
 *    as it is.
 *  - `invisibleContent` names what the print render still does not show: a
 *    content element at computed opacity 0 or visibility hidden, once builds
 *    are complete and animations finished. The runtime marks the slide
 *    `data-invisible="<what>"` in `?print`, the way it marks `data-overflow`,
 *    so `decklight check` and `pdf` read it off the render.
 */

/** Keyframes the runtime ships: data-animate loops, builds, transitions, the terminal's cursor. */
const ENGINE_KEYFRAMES = /^(dl-|decklight-|terminal-)/;

/**
 * Nodes the engine makes or hides on purpose, never the author's content: a
 * slide's background, the hero logo, the steps strip,
 * the draw build's pieces, a travel token, a code walk's callouts, a terminal
 * (its cursor blinks), auto-animate's fresh copies. And what a slide carries
 * that is not on it: notes, callout asides, scripts.
 */
const ENGINE_NODE = '.slide-bg, .decklight-hero-logo, .decklight-steps, nav.steps, '
  + '.draw-head, .draw-mask, .travel-token, .code-callout, .code-callout-entry, .terminal, .aa-fresh';
const NOT_ON_THE_SLIDE = 'aside, script, style, template, noscript, link, meta';
/** Hidden on purpose: `hidden`, aria-hidden decoration, a build still to come, and the author's own opt-out. */
const MEANT_HIDDEN = '[hidden], [aria-hidden="true"], [data-invisible-ok], .build-step[data-build-state="pending"]';
const SKIP = `${ENGINE_NODE}, ${NOT_ON_THE_SLIDE}, ${MEANT_HIDDEN}`;

/** Content in its own right, whatever text it holds. */
const MEDIA = new Set(['IMG', 'PICTURE', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED']);

/** What an element is called, in a sentence the author reads. */
const WHAT = {
  P: 'a paragraph', H1: 'a heading', H2: 'a heading', H3: 'a heading', H4: 'a heading', H5: 'a heading', H6: 'a heading',
  UL: 'a list', OL: 'a list', LI: 'a list item', TABLE: 'a table', TR: 'a table row', PRE: 'a code block',
  BLOCKQUOTE: 'a quote', FIGURE: 'a figure', IMG: 'an image', PICTURE: 'an image', SVG: 'a diagram',
  VIDEO: 'a video', CANVAS: 'a drawing', IFRAME: 'an embed', SPAN: 'a phrase', A: 'a link', BUTTON: 'a button',
};

/** Is `anim` one the deck's own stylesheet made (and so ours to finish in a still)? */
export function isAuthorAnimation(anim) {
  const name = anim?.animationName;
  const prop = anim?.transitionProperty;
  if (typeof name !== 'string' && typeof prop !== 'string') return false;   // a script's own: not a CSS one
  if (typeof name === 'string' && (!name || ENGINE_KEYFRAMES.test(name))) return false;
  const el = anim.effect?.target;
  if (!el || !el.closest || !el.closest('section')) return false;           // only what is on a slide
  if (el.closest(ENGINE_NODE)) return false;
  const iterations = anim.effect.getTiming?.().iterations;
  return Number.isFinite(iterations ?? 1);                                  // a loop never ends: leave it
}

/**
 * Finish every author CSS animation and transition under `scope` (a section,
 * or the stage for the whole print view). Synchronous: `getAnimations()`
 * brings styles up to date first, so an animation that a class added a moment
 * ago (`section.active`) is already there to finish. Returns how many were.
 */
export function finishAuthorAnimations(scope) {
  if (!scope?.getAnimations) return 0;
  let n = 0;
  for (const anim of scope.getAnimations({ subtree: true })) {
    if (!isAuthorAnimation(anim) || anim.playState === 'finished') continue;
    try { anim.finish(); n += 1; } catch { /* an infinite timing that reads finite: left as it plays */ }
  }
  return n;
}

/** A few words of an element's text, for naming it: “keyframed box 1”. */
function quoteOf(el) {
  const text = (el.textContent || el.getAttribute?.('alt') || el.getAttribute?.('aria-label') || '')
    // a serialized attribute escapes & and " but not < >, and a reader of the
    // dumped section tag stops at the first >: angle brackets go typographic
    .replace(/\s+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').trim();
  if (!text) return '';
  return ` “${text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text}”`;
}

/** “a paragraph “Revenue grew”” / “an element”: the element, as `data-invisible` says it. */
export function nameOf(el) {
  const tag = String(el.tagName || '').toUpperCase();
  const what = el.matches?.('.chart, [data-chart]') ? 'a chart' : WHAT[tag] ?? (tag === 'DIV' || tag === 'SECTION' ? 'a box' : 'an element');
  return `${what}${MEDIA.has(tag) && tag !== 'IMG' ? '' : quoteOf(el)}`;
}

/** Does `el` hold something to see: its own words, or a picture? */
function hasContent(el) {
  if (MEDIA.has(String(el.tagName).toUpperCase())) return true;
  if ((el.textContent || '').trim()) return true;
  return !!el.querySelector?.('img, picture, svg, video, canvas, iframe, object, embed');
}

/**
 * The content `section` does not show: `[{ el, what, why }]`, outermost first,
 * where `why` is 'opacity 0' or 'visibility hidden'. Opacity is not inherited
 * in computed style, so it is multiplied down the tree; an element hidden
 * inside one already named is not named again. A diagram is one element (its
 * shapes are the diagram's business), and a box with nothing in it is no
 * hole. `style` is injected so a Node test can run it on a fake tree.
 */
export function invisibleContent(section, { style = (el) => getComputedStyle(el) } = {}) {
  const out = [];
  if (!section || section.matches?.(SKIP)) return out;
  const facePage = section.matches?.('.decklight-face-page');
  if (facePage && section.dataset.faceKeep === 'none') return out;
  const walk = (parent, opacity, hidden) => {
    for (const el of parent.children) {
      if (el.matches(SKIP)) continue;
      const onPathToKeep = facePage && !el.closest('[data-face-keep]');
      if (onPathToKeep && !el.querySelector('[data-face-keep]')) continue;
      const cs = style(el);
      if (cs.display === 'none') continue;
      const own = cs.opacity === '' ? 1 : Number.parseFloat(cs.opacity);
      const op = opacity * (Number.isFinite(own) ? own : 1);
      const invisible = cs.visibility === 'hidden' || cs.visibility === 'collapse';
      if (op === 0 && hasContent(el)) { out.push({ el, what: nameOf(el), why: 'opacity 0' }); continue; }
      // visibility is inherited, and a child can take it back: name the element
      // where it turns hidden, if anything under it that has words stays so
      if (!onPathToKeep && invisible && !hidden && stillHidden(el, style)) { out.push({ el, what: nameOf(el), why: 'visibility hidden' }); continue; }
      if (op === 0) continue;   // an empty transparent box: nothing in it to miss
      if (String(el.tagName).toUpperCase() === 'SVG' || el.ownerSVGElement) continue;
      walk(el, op, invisible && !onPathToKeep);
    }
  };
  walk(section, 1, false);
  return out;
}

/** Is there content under `el` (itself included) still hidden by visibility? */
function stillHidden(el, style) {
  const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  if (own || MEDIA.has(String(el.tagName).toUpperCase())) return true;
  for (const c of el.children) {
    if (c.matches(SKIP)) continue;
    const cs = style(c);
    if (cs.display === 'none' || cs.visibility === 'visible') continue;
    if (stillHidden(c, style)) return true;
  }
  return false;
}

/**
 * Mark `section` with what it does not show, in a still (`?print`):
 * `data-invisible="a box “keyframed box 1” (opacity 0)"` for the first, and
 * `data-invisible-more="2"` when there are others. Cleared when it shows
 * everything. Returns the list.
 */
export function markInvisible(section, opts) {
  const found = invisibleContent(section, opts);
  const said = found.length ? `${found[0].what} (${found[0].why})` : null;
  const more = found.length > 1 ? String(found.length - 1) : null;
  if (said) { if (section.getAttribute('data-invisible') !== said) section.setAttribute('data-invisible', said); }
  else section.removeAttribute('data-invisible');
  if (more) { if (section.getAttribute('data-invisible-more') !== more) section.setAttribute('data-invisible-more', more); }
  else section.removeAttribute('data-invisible-more');
  return found;
}
