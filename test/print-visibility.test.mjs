// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a still shows (#1184): the deck's own CSS entrances finished, the
 * engine's animations left alone, and what print still does not show named,
 * for `decklight check` and `pdf` to say. The browser half (the PDF itself,
 * the computed styles) is test/print-visibility-render.mjs; this is the logic,
 * on a small fake tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAuthorAnimation, finishAuthorAnimations, invisibleContent, markInvisible, nameOf } from '../src/core/print-visibility.js';
import { invisibleSaid, invisibleReport } from '../cli/pdf.mjs';
import { renderFindings } from '../cli/check.mjs';

// ── a tiny DOM: enough selector to answer the module's own lists ─────────────

/** Does `el` match ONE compound selector: tag, .class, [attr], [attr="v"]? */
function matchesOne(el, sel) {
  const m = /^([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(sel.trim());
  if (!m) return false;
  if (m[1] && m[1].toUpperCase() !== el.tagName) return false;
  for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part[0] === '.') { if (!el.classList.includes(part.slice(1))) return false; continue; }
    const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!(name in el.attrs)) return false;
    if (value !== undefined && el.attrs[name] !== value) return false;
  }
  return true;
}

function h(tag, props = {}, ...kids) {
  const { cls = '', style = {}, attrs = {} } = props;
  const el = {
    tagName: tag.toUpperCase(), classList: cls.split(/\s+/).filter(Boolean), attrs: { ...attrs }, style,
    parentElement: null, nodeType: 1,
    children: [], childNodes: [],
    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); },
    matches(sel) { return sel.split(',').some((s) => matchesOne(this, s)); },
    closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; },
    querySelector(sel) {
      for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; }
      return null;
    },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    hasAttribute(n) { return n in this.attrs; },
  };
  for (const k of kids) {
    if (typeof k === 'string') { el.childNodes.push({ nodeType: 3, textContent: k }); continue; }
    k.parentElement = el;
    el.children.push(k);
    el.childNodes.push(k);
  }
  return el;
}
/** Computed style, as the fake has it: opacity 1 and visible unless said, visibility inherited. */
const style = (el) => {
  let vis = 'visible';
  for (let n = el; n; n = n.parentElement) if (n.style.visibility) { vis = n.style.visibility; break; }
  return { display: el.style.display ?? 'block', opacity: el.style.opacity ?? '1', visibility: vis };
};
const seen = (sec) => invisibleContent(sec, { style }).map((f) => `${f.what} (${f.why})`);

// ── which animations a still finishes ────────────────────────────────────────

const anim = (name, { iterations = 1, target = h('div'), kind = 'animation', state = 'running' } = {}) => {
  const a = {
    playState: state, finished: 0,
    effect: { target, getTiming: () => ({ iterations }) },
    finish() { this.finished += 1; this.playState = 'finished'; },
  };
  if (kind === 'animation') a.animationName = name;
  if (kind === 'transition') a.transitionProperty = name;
  return a;
};

test('an animation the deck\'s own CSS runs on a slide is the author\'s, and a still finishes it (#1184)', () => {
  const box = h('div', { cls: 'kf' });
  h('section', {}, box);
  assert.equal(isAuthorAnimation(anim('fadein', { target: box })), true);
  assert.equal(isAuthorAnimation(anim('opacity', { target: box, kind: 'transition' })), true, 'a transition the slide starts too');
});

test('the engine\'s own animations, loops and anything off the slides are left alone (#1184)', () => {
  const box = h('div');
  const token = h('span', { cls: 'travel-token' });
  const term = h('div', { cls: 'terminal' }, h('span', { cls: 'cursor' }));
  h('section', {}, box, token, term);
  // data-animate loops, builds, transitions: the runtime's keyframes
  for (const name of ['dl-pulse', 'dl-fade-in', 'dl-travel-pulse', 'decklight-blink', 'terminal-blink']) {
    assert.equal(isAuthorAnimation(anim(name, { target: box })), false, name);
  }
  assert.equal(isAuthorAnimation(anim('spin', { target: box, iterations: Infinity })), false, 'a loop never ends');
  assert.equal(isAuthorAnimation(anim('fadein', { target: token })), false, 'an engine node');
  assert.equal(isAuthorAnimation(anim('blink', { target: term.children[0] })), false, 'inside a terminal');
  assert.equal(isAuthorAnimation(anim('fadein', { target: h('div') })), false, 'not on a slide');
  assert.equal(isAuthorAnimation({ effect: { target: box, getTiming: () => ({ iterations: 1 }) } }), false,
    'a script-made animation (figure count-up, travel) is not a CSS one');
});

test('finishing takes the author\'s, skips the rest, and is synchronous (#1184)', () => {
  const box = h('div');
  h('section', {}, box);
  const mine = anim('fadein', { target: box });
  const loop = anim('dl-pulse', { target: box, iterations: Infinity });
  const done = anim('fadein', { target: box, state: 'finished' });
  const scope = { getAnimations: (o) => { assert.deepEqual(o, { subtree: true }); return [mine, loop, done]; } };
  assert.equal(finishAuthorAnimations(scope), 1);
  assert.equal(mine.finished, 1);
  assert.equal(loop.finished, 0);
  assert.equal(done.finished, 0);
  assert.equal(finishAuthorAnimations(null), 0);
});

// ── what print does not show ─────────────────────────────────────────────────

test('content at opacity 0 or visibility hidden is named, with what it says (#1184)', () => {
  const sec = h('section', {},
    h('h2', {}, 'Batch vs streaming'),
    h('div', { cls: 'box' }, 'plain box'),
    h('div', { cls: 'box', style: { opacity: '0' } }, 'keyframed box 1'),
    h('p', { style: { visibility: 'hidden' } }, 'never shown'));
  assert.deepEqual(seen(sec), ['a box “keyframed box 1” (opacity 0)', 'a paragraph “never shown” (visibility hidden)']);
});

test('opacity multiplies down: a box inside a transparent one is named once, at the outside (#1184)', () => {
  const sec = h('section', {}, h('div', { style: { opacity: '0' } }, h('div', {}, h('p', {}, 'inside'))));
  assert.deepEqual(seen(sec), ['a box “inside” (opacity 0)']);
  // half see-through is seen
  assert.deepEqual(seen(h('section', {}, h('p', { style: { opacity: '0.4' } }, 'faint'))), []);
});

test('a hidden wrapper whose content takes visibility back is no hole (#1184)', () => {
  const sec = h('section', {}, h('div', { style: { visibility: 'hidden' } }, h('p', { style: { visibility: 'visible' } }, 'shown')));
  assert.deepEqual(seen(sec), []);
});

test('what is hidden on purpose, or the engine\'s, or empty, is not reported (#1184)', () => {
  const sec = h('section', {},
    h('aside', { cls: 'notes', style: { visibility: 'hidden' } }, 'speaker notes'),
    h('aside', { cls: 'callouts', style: { opacity: '0' } }, 'a callout'),
    h('nav', { cls: 'steps', style: { opacity: '0' } }, 'step 1'),
    h('div', { cls: 'slide-bg', style: { opacity: '0' } }, h('img')),
    h('span', { cls: 'travel-token', style: { visibility: 'hidden' } }, '●'),
    h('div', { cls: 'code-callout', style: { opacity: '0' } }, 'kept for later'),
    h('div', { cls: 'terminal' }, h('span', { style: { opacity: '0' } }, '█')),
    h('div', { attrs: { hidden: '' }, style: { visibility: 'hidden' } }, 'hidden attribute'),
    h('div', { attrs: { 'aria-hidden': 'true' }, style: { opacity: '0' } }, 'decoration'),
    h('div', { attrs: { 'data-invisible-ok': '' }, style: { opacity: '0' } }, 'meant'),
    h('div', { cls: 'build-step', attrs: { 'data-build-state': 'pending' }, style: { opacity: '0' } }, 'to come'),
    h('div', { style: { display: 'none' } }, 'not laid out'),
    h('div', { style: { opacity: '0' } }),
    h('div', { style: { opacity: '0' } }, '   '));
  assert.deepEqual(seen(sec), []);
});

test('a diagram is one element: its shapes are its own business, the diagram is not (#1184)', () => {
  const svg = h('svg', {}, h('rect', { style: { opacity: '0' } }));
  assert.deepEqual(seen(h('section', {}, svg)), [], 'a transparent shape inside a diagram');
  assert.deepEqual(seen(h('section', {}, h('svg', { style: { opacity: '0' } }, h('rect')))), ['a diagram (opacity 0)']);
  assert.deepEqual(seen(h('section', {}, h('div', { style: { opacity: '0' } }, h('img')))), ['a box (opacity 0)'], 'a picture is content');
});

test('the name is short and safe to carry in a section tag (#1184)', () => {
  assert.equal(nameOf(h('p', {}, 'x'.repeat(60))), `a paragraph “${'x'.repeat(39)}…”`);
  assert.equal(nameOf(h('li', {}, 'a <b> & c')), 'a list item “a ‹b› & c”');
  assert.equal(nameOf(h('div', { cls: 'chart' }, '')), 'a chart');
});

test('the slide is marked with the first and a count of the others, and the mark comes back off (#1184)', () => {
  const a = h('p', { style: { opacity: '0' } }, 'one');
  const sec = h('section', {}, a, h('p', { style: { opacity: '0' } }, 'two'), h('p', { style: { opacity: '0' } }, 'three'));
  markInvisible(sec, { style });
  assert.equal(sec.getAttribute('data-invisible'), 'a paragraph “one” (opacity 0)');
  assert.equal(sec.getAttribute('data-invisible-more'), '2');
  for (const p of sec.children) p.style.opacity = '1';
  markInvisible(sec, { style });
  assert.equal(sec.hasAttribute('data-invisible'), false);
  assert.equal(sec.hasAttribute('data-invisible-more'), false);
});

// ── what pdf and check say, read off the render ──────────────────────────────

test('pdf names each slide with a hole, by number, entities undone (#1184)', () => {
  const dom = '<section><h2>a</h2></section>'
    + '<section data-invisible="a box “Batch &amp; Co” (opacity 0)" data-invisible-more="1"><h2>b</h2></section>'
    + '<section data-invisible="a paragraph (visibility hidden)"><h2>c</h2></section>';
  assert.deepEqual(invisibleReport(dom), [
    { n: 2, said: 'a box “Batch & Co” (opacity 0), and 1 more element' },
    { n: 3, said: 'a paragraph (visibility hidden)' },
  ]);
  assert.equal(invisibleSaid('<section data-invisible="">'), '', 'an empty mark says nothing');
  assert.deepEqual(invisibleReport('<section><pre>data-invisible="x"</pre></section>'), [], 'a deck that only talks about it');
});

test('check reports invisible-in-print as a warning on that slide, naming the element (#1184)', () => {
  const found = renderFindings('<section><h2>Fine</h2></section>'
    + '<section data-invisible="a box “keyframed box 1” (opacity 0)" data-invisible-more="2"><h2>Pipelines</h2></section>', { slides: 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'invisible-in-print');
  assert.equal(found[0].level, 'warn');
  assert.equal(found[0].slide, 2);
  assert.match(found[0].message, /^invisible in print: a box “keyframed box 1” \(opacity 0\), and 2 more elements — /);
  assert.match(found[0].message, /SPEC BUILDS/);
});

test('one sentence for pdf, check and the Check deck panel (#1184)', async () => {
  const { invisibleSaidOf, invisibleMessage, INVISIBLE_ADVICE } = await import('../tools/invisible-in-print.mjs');
  assert.equal(invisibleSaidOf('a box “Batch” (opacity 0)', 0), 'a box “Batch” (opacity 0)');
  assert.equal(invisibleSaidOf('a box “Batch” (opacity 0)', 1), 'a box “Batch” (opacity 0), and 1 more element');
  assert.equal(invisibleSaidOf('a list (visibility hidden)', '3'), 'a list (visibility hidden), and 3 more elements', 'a count read off an attribute');
  assert.equal(invisibleSaidOf('', 2), '', 'nothing named, nothing said');
  assert.equal(invisibleMessage('a list (visibility hidden)'), `invisible in print: a list (visibility hidden) — ${INVISIBLE_ADVICE}`);
  // check's own finding is that sentence, word for word: the panel says it so too
  const found = renderFindings('<section data-invisible="a heading “Hi” (opacity 0)"><h2>Hi</h2></section>', { slides: 1 });
  assert.equal(found[0].message, invisibleMessage('a heading “Hi” (opacity 0)'));
});
