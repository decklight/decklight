// The inspector's arithmetic (PRESENTING): a contrast ratio, a token name and
// a box in deck units are read as facts, so they have to be right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, blend, contrastRatio, isLargeText, aaFloor, hex, tokenFor,
  stageBox, shareOf, fontLine, clock, effectiveBackground, firstStop,
} from '../src/core/inspect-facts.js';

test('colours parse the way computed styles and authors write them', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#0056F9'), [0, 86, 249, 1]);
  assert.deepEqual(parseColor('#00000080'), [0, 0, 0, 128 / 255]);
  assert.deepEqual(parseColor('rgb(18, 52, 86)'), [18, 52, 86, 1]);
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0, 0.5]);
  assert.deepEqual(parseColor('rgb(0 0 0 / 50%)'), [0, 0, 0, 0.5]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.equal(parseColor('var(--fg)'), null);
  assert.equal(parseColor('#12345'), null);
});

test('contrast matches the WCAG reference pairs', () => {
  const ratio = (a, b) => +contrastRatio(parseColor(a), parseColor(b)).toFixed(2);
  assert.equal(ratio('#000', '#fff'), 21);
  assert.equal(ratio('#fff', '#fff'), 1);
  assert.equal(ratio('#767676', '#fff'), 4.54, 'the lightest grey that passes AA on white');
  assert.equal(ratio('#777', '#fff'), 4.48, 'and the first that fails');
  assert.equal(ratio('#fff', '#000'), ratio('#000', '#fff'), 'order does not matter');
  // translucent text is the colour it LOOKS on its background
  assert.equal(ratio('rgba(0,0,0,0.5)', '#fff'), ratio(hex(blend([0, 0, 0, 0.5], [255, 255, 255, 1])), '#fff'));
});

test('large text needs 3:1 and body text 4.5:1', () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(19, 700), true);
  assert.equal(isLargeText(19, 400), false);
  assert.equal(aaFloor(30, 400), 3);
  assert.equal(aaFloor(16, 700), 4.5);
});

test('a colour is named by the first token that holds it', () => {
  const tokens = [['--fg', '#e8e6e3'], ['--accent', ' #0056f9'], ['--d-fill-3', '#0056f9']];
  assert.equal(tokenFor('rgb(0, 86, 249)', tokens), '--accent');
  assert.equal(tokenFor('rgb(232, 230, 227)', tokens), '--fg');
  assert.equal(tokenFor('rgb(1, 2, 3)', tokens), null);
  assert.equal(tokenFor('rgba(0, 0, 0, 0)', tokens), null, 'transparent is nobody');
});

test('a box is measured in deck units at any window size', () => {
  const stage = { left: 100, top: 50 };
  assert.deepEqual(stageBox({ left: 160, top: 220, width: 430, height: 205 }, stage, 0.5),
    { x: 120, y: 340, w: 860, h: 410 });
  assert.equal(shareOf({ w: 640, h: 360 }, 1280, 720), 25);
});

test('a font reads as family size/line-height · weight', () => {
  assert.equal(fontLine({ fontFamily: '"Inter", system-ui', fontSize: '40px', lineHeight: '52px', fontWeight: '600' }),
    'Inter 40/1.3 · 600');
  assert.equal(fontLine({ fontFamily: 'Georgia', fontSize: '30px', lineHeight: 'normal', fontWeight: '400' }),
    'Georgia 30 · 400');
});

test('the clock reads minutes and seconds', () => {
  assert.equal(clock(90), '1:30');
  assert.equal(clock(5), '0:05');
});

test('the background behind a node is composited up to the first opaque layer', () => {
  const page = { nodeType: 1, parentElement: null, bg: 'rgb(0, 0, 0)' };
  const card = { nodeType: 1, parentElement: page, bg: 'rgba(255, 255, 255, 0.5)' };
  const text = { nodeType: 1, parentElement: card, bg: 'rgba(0, 0, 0, 0)' };
  const styleOf = (n) => ({ backgroundColor: n.bg });
  assert.deepEqual(effectiveBackground(text, { styleOf }), [128, 128, 128, 1]);
  // nothing opaque: the canvas behind the deck
  const loose = { nodeType: 1, parentElement: null, bg: 'transparent' };
  assert.deepEqual(effectiveBackground(loose, { styleOf, fallback: [10, 20, 30, 1] }), [10, 20, 30, 1]);
});

test('a gradient stands in by its first stop, and says it was one', () => {
  assert.deepEqual(firstStop('linear-gradient(135deg, rgb(15, 42, 99) 0%, rgb(12, 74, 80) 100%)'), [15, 42, 99, 1]);
  assert.equal(firstStop('url(x.png)'), null);
  const sec = { nodeType: 1, parentElement: null, bg: 'rgba(0, 0, 0, 0)', image: 'linear-gradient(rgb(15, 42, 99), rgb(0, 0, 0))' };
  const h2 = { nodeType: 1, parentElement: sec, bg: 'rgba(0, 0, 0, 0)', image: 'none' };
  const seen = {};
  assert.deepEqual(effectiveBackground(h2, { styleOf: (n) => ({ backgroundColor: n.bg, backgroundImage: n.image }), seen }),
    [15, 42, 99, 1]);
  assert.equal(seen.image, true);
});
