// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A diagram on a design-system slide (SPEC DESIGN_SYSTEMS, SVG_DIAGRAMS, #831):
// expansion moves the author's <svg> into a slot container marked
// data-ds-injected, and that container is no reason to treat the diagram as
// template decoration. Only an injected svg, or an injected node between a
// node and its svg, is decoration. Each rule is asked of an authored svg in a
// slot, a template's own svg, and the same svg on a plain slide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNode, injectedIn } from '../src/core/pick.js';
import { svgTextTarget } from '../src/core/authoring.js';
import { isAuthoredShape } from '../src/core/concepts.js';
import { isAuthoredDiagram } from '../src/core/deckcheck.js';

/** A duck-typed element tree: tag, children, and the traversal methods used. */
function el(tag, children = [], attrs = {}) {
  const node = { tag, children: [], parentElement: null, attrs };
  for (const c of children) { c.parentElement = node; node.children.push(c); }
  node.matches = (sel) => sel.split(',').map((s) => s.trim()).some((s) => selectorHits(node, s));
  node.closest = (sel) => { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; };
  node.contains = (other) => { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; };
  node.hasAttribute = (k) => k in attrs;
  const all = () => node.children.flatMap((c) => [c, ...c.all()]);
  node.all = all;
  node.querySelectorAll = (sel) => all().filter((n) => n.matches(sel));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] ?? null;
  return node;
}
// the selector shapes the filters use: a tag, `.class`, `[attr]`, `tag[attr]`
function selectorHits(node, sel) {
  const m = /^([a-zA-Z0-9]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(sel);
  if (!m) return false;
  const [, tag, cls, attr] = m;
  if (tag && node.tag !== tag) return false;
  if (cls && !(node.attrs.class ?? '').split(/\s+/).includes(cls)) return false;
  if (attr && !(attr in node.attrs)) return false;
  return true;
}

const INJ = { 'data-ds-injected': '' };
/** A diagram: three shapes and a label. */
function diagram(svgAttrs = {}) {
  const rect = el('rect'); const label = el('text');
  const svg = el('svg', [rect, el('circle'), el('path'), label], svgAttrs);
  return { svg, rect, label };
}
/** The author's svg moved into a template's slot container. */
function slotted() {
  const d = diagram();
  const slot = el('div', [d.svg], { ...INJ, 'data-slot': 'diagram' });
  const sec = el('section', [el('div', [slot], { ...INJ, class: 'acme-diagram' })]);
  return { ...d, sec, top: d.svg };
}
/** The template's own svg, decoration in templates.html. */
function decoration() {
  const d = diagram(INJ);
  for (const c of d.svg.children) c.attrs['data-ds-injected'] = '';
  const art = el('div', [d.svg], { ...INJ, class: 'acme-art' });
  const sec = el('section', [art]);
  return { ...d, sec, top: art };
}
/** The same svg on a plain slide. */
function plain() {
  const d = diagram();
  return { ...d, sec: el('section', [d.svg]), top: d.svg };
}

test('injected means the svg itself or a node inside it, never a slot container above it', () => {
  const s = slotted();
  assert.equal(injectedIn(s.rect, s.svg), false, 'the slot container above the svg does not count');
  assert.equal(injectedIn(s.svg, s.svg), false);
  const d = decoration();
  assert.equal(injectedIn(d.rect, d.svg), true);
  assert.equal(injectedIn(d.svg, d.svg), true, 'an injected svg is decoration');
  const rect = el('rect');
  const svg = el('svg', [el('g', [rect], INJ)]);
  assert.equal(injectedIn(rect, svg), true, 'an injected node between the shape and its svg counts');
});

test('a click in a templated diagram picks the drawn node, as on a plain slide', () => {
  for (const [name, s] of [['slotted', slotted()], ['plain', plain()]]) {
    assert.equal(pickNode(s.top, s.rect), s.rect, `${name}: the rect, not the whole svg`);
    assert.equal(pickNode(s.top, s.label), s.label, `${name}: the label`);
    assert.equal(pickNode(s.top, s.svg), s.svg, `${name}: the empty canvas selects the svg`);
  }
  const d = decoration();
  assert.equal(pickNode(d.top, d.rect), d.top, 'nothing a template drew is picked');
  // the engine's own nodes still map to the svg
  const s = slotted();
  const head = el('path', [], { class: 'draw-head' });
  head.parentElement = s.svg; s.svg.children.push(head);
  assert.equal(pickNode(s.top, head), s.svg);
});

test('a double-click on a templated diagram label opens the label editor', () => {
  const s = slotted();
  assert.equal(svgTextTarget(s.label, s.sec), s.label);
  assert.equal(svgTextTarget(plain().label, plain().sec), null, 'a label of another slide is not this slide’s');
  const p = plain();
  assert.equal(svgTextTarget(p.label, p.sec), p.label);
  const d = decoration();
  assert.equal(svgTextTarget(d.label, d.sec), null, 'a template’s label is not in the file');
});

test('concepts can be attached to shapes in a templated diagram', () => {
  assert.equal(isAuthoredShape(slotted().rect), true);
  assert.equal(isAuthoredShape(plain().rect), true);
  assert.equal(isAuthoredShape(decoration().rect), false);
  const inDefs = el('rect');
  el('svg', [el('defs', [inDefs])]);
  assert.equal(isAuthoredShape(inDefs), false, 'SVG plumbing is still not a shape');
});

test('check finds the same diagram whether or not its slide uses a template', () => {
  assert.equal(isAuthoredDiagram(slotted().svg), true);
  assert.equal(isAuthoredDiagram(plain().svg), true);
  assert.equal(isAuthoredDiagram(decoration().svg), false, 'a template’s own svg is not the slide’s');
});
