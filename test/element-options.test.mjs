// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A code block's settings from the inspector's Options tab (PRESENTING_EDITING,
// CODE_AND_MATH): the shared reading of them (tools/code-options.mjs), the
// server's one transform (setElementOptions) and its route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory, setElementOptions, undoMeta, whatWrote } from '../cli/edit.mjs';
import { CODE_LANGUAGES, languageOf, lineCount, linesError, specOf, stepError, stepsOf, toggleLine } from '../tools/code-options.mjs';
import { hljs } from '../src/code/code.js';
import { tmp } from './helpers.mjs';

const CODE = '<pre data-lines="1|2"><code class="language-js">\nconst a = 1;\nconst b = 2;\nif (a &lt; b) go();\n</code></pre>';
const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Code</h2>
      ${CODE}
      <div class="columns">
        <pre><code>plain</code></pre>
        <p>words</p>
      </div>
    </section>
  </div>
</body></html>
`;

test('the languages offered are the ones the runtime highlights, and every alias reads as one of them', () => {
  for (const [name] of CODE_LANGUAGES) assert.ok(hljs.getLanguage(name), `${name} is registered in code.js`);
  assert.equal(languageOf('js'), 'javascript');
  assert.equal(languageOf('zsh'), 'bash');
  assert.equal(languageOf('plaintext'), '', 'plain text is no language');
  assert.equal(languageOf(null), '');
  assert.equal(languageOf('cobol'), null, 'a name the runtime does not highlight is not one of the list');
});

test('lines are counted as the runtime counts them, and a step past the end is refused in words', () => {
  assert.equal(lineCount('\nconst a = 1;\nconst b = 2;\n  '), 2);
  assert.equal(lineCount(''), 0);
  assert.deepEqual(stepsOf('1-2| 4 |all'), ['1-2', '4', 'all']);
  assert.deepEqual(stepsOf(null), []);
  assert.equal(specOf(['1-2', '4']), '1-2|4');
  assert.equal(specOf([]), null);
  assert.equal(stepError('1,3-4', 4), null);
  assert.equal(stepError('all', 1), null);
  assert.match(stepError('5', 4), /has 4 lines: 5 is past its end/);
  assert.match(stepError('3-1', 4), /runs backwards/);
  assert.match(stepError('two', 4), /not a line or a range/);
  assert.match(stepError('', 4), /needs its lines/);
  assert.match(linesError('1|9', 3), /^step 2: /);
  assert.equal(linesError('1|2', 3), null);
});

test('a click on a line adds it to the step, kept as ranges, and a second click takes it out', () => {
  assert.equal(toggleLine('', 3), '3');
  assert.equal(toggleLine('1-2', 3), '1-3');
  assert.equal(toggleLine('1-2', 5), '1-2,5');
  assert.equal(toggleLine('1-3', 2), '1,3');
});

test('setElementOptions writes language, toggles and steps in ONE edit, and touches nothing else', () => {
  const out = setElementOptions(DECK, 1, 1, { tag: 'pre', set: { language: 'python', 'data-lines-numbers': true, 'data-fit': true, 'data-lines': '1-2|3' } });
  assert.match(out, /<pre data-lines="1-2\|3" data-lines-numbers data-fit><code class="language-python">\nconst a = 1;\nconst b = 2;\nif \(a &lt; b\) go\(\);\n<\/code><\/pre>/);
  const off = setElementOptions(out, 1, 1, { tag: 'pre', set: { language: '', 'data-lines-numbers': null, 'data-lines': null } });
  assert.match(off, /<pre data-fit><code>\nconst a/);
  // a name that already means the language is kept as the file wrote it
  assert.equal(setElementOptions(DECK, 1, 1, { tag: 'pre', set: { language: 'javascript' } }), DECK);
  // inside the columns, by path
  const inner = setElementOptions(DECK, 1, 2, { path: [0], tag: 'pre', set: { language: 'bash' } });
  assert.match(inner, /<pre><code class="language-bash">plain<\/code><\/pre>/);
});

test('setElementOptions refuses what the block cannot take, with a sentence', () => {
  const bad = [
    [{ 'data-lines': '1|7' }, /step 2: the block has 3 lines: 7 is past its end/],
    [{ language: 'cobol' }, /not a language the runtime highlights/],
    [{ 'data-fit': 'yes' }, /on \(true\) or off \(null\)/],
    [{ onclick: 'x' }, /no setting "onclick"/],
    [{}, /nothing to change/],
  ];
  for (const [set, why] of bad) assert.throws(() => setElementOptions(DECK, 1, 1, { tag: 'pre', set }), why);
  assert.throws(() => setElementOptions(DECK, 1, 1, { tag: 'img', set: { 'data-fit': true } }), /no settings are written for <img>/);
  assert.throws(() => setElementOptions(DECK, 1, 0, { tag: 'pre', set: { 'data-fit': true } }), (e) => e.code === 'STALE', 'a path that lands on another tag is stale');
});

function harness(t) {
  const dir = tmp('element-options', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileSync(deck, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, broadcast: () => {}, quiet: () => {} });
  return { routes, history, readDeck };
}
async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('POST /deck/edit/element/options writes a burst as one undo entry, and refuses a step past the end', async (t) => {
  const { routes, history, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/element/options', { slide: 1, index: 1, tag: 'pre', set: { 'data-lines-numbers': true, 'data-lines': '1|3' }, quiet: true, from: 'page-a' });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(history.counts().undo, 1, 'one undo entry for the burst');
  assert.match(readDeck(), /<pre data-lines="1\|3" data-lines-numbers>/);
  const past = await call(routes, 'POST /deck/edit/element/options', { slide: 1, index: 1, tag: 'pre', set: { 'data-lines': '9' } });
  assert.equal(past.code, 400);
  assert.match(past.body.error, /past its end/);
  const shape = await call(routes, 'POST /deck/edit/element/options', { slide: 1, index: 1, set: { 'data-fit': true } });
  assert.equal(shape.code, 400, 'no tag, no write');
  assert.equal(undoMeta('/deck/edit/element/options', '{"slide":1}').what, 'settings');
  assert.ok(whatWrote('/deck/edit/element/options'));
});

const VDECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Clip</h2>
      <video src="assets/a.mp4" controls playsinline preload="metadata"></video>
    </section>
  </div>
</body></html>
`;

test('a video’s settings: its file, its toggles written bare, its poster, in ONE edit', () => {
  const out = setElementOptions(VDECK, 1, 1, { tag: 'video', set: { src: 'assets/b.webm', loop: true, muted: true, autoplay: true, poster: 'assets/b.jpg', controls: null } });
  assert.match(out, /<video src="assets\/b\.webm" playsinline preload="metadata" loop muted autoplay poster="assets\/b\.jpg"><\/video>/);
  const back = setElementOptions(out, 1, 1, { tag: 'video', set: { autoplay: null, poster: null } });
  assert.match(back, /<video src="assets\/b\.webm" playsinline preload="metadata" loop muted><\/video>/);
});

test('a video that plays on arrival is muted, and its files are beside the deck; anything else is refused in words', () => {
  assert.throws(() => setElementOptions(VDECK, 1, 1, { tag: 'video', set: { autoplay: true } }), /plays when its slide arrives is muted/);
  const playing = setElementOptions(VDECK, 1, 1, { tag: 'video', set: { autoplay: true, muted: true } });
  assert.throws(() => setElementOptions(playing, 1, 1, { tag: 'video', set: { muted: null } }), /is muted/, 'unmuting one that plays on arrival is refused too');
  assert.throws(() => setElementOptions(VDECK, 1, 1, { tag: 'video', set: { src: 'https://x.test/a.mp4' } }), /mp4 or a webm beside the deck/);
  assert.throws(() => setElementOptions(VDECK, 1, 1, { tag: 'video', set: { poster: '../p.png' } }), /a poster is a picture beside the deck/);
  assert.throws(() => setElementOptions(VDECK, 1, 1, { tag: 'video', set: { onplay: 'x' } }), /a video has no setting "onplay"/);
});

const TDECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Shell</h2>
      <div class="terminal" data-cast="casts/demo.cast.json" data-mode="step"></div>
      <div class="note">not a terminal</div>
    </section>
  </div>
</body></html>
`;

test('a terminal’s settings: its recording, how it plays, title, rows, typing speed and sound, poster, in ONE edit', () => {
  const out = setElementOptions(TDECK, 1, 1, { tag: 'div', set: { 'data-cast': 'casts/b.cast', 'data-mode': 'play', 'data-title': 'zsh', 'data-rows': 18, 'data-type-speed': '7', 'data-type-sound': 'off', 'data-poster': 1 } });
  assert.match(out, /<div class="terminal" data-cast="casts\/b\.cast" data-mode="play" data-title="zsh" data-rows="18" data-type-speed="7" data-type-sound="off" data-poster="1"><\/div>/);
  assert.match(setElementOptions(out, 1, 1, { tag: 'div', set: { 'data-title': null, 'data-rows': null } }), /<div class="terminal" data-cast="casts\/b\.cast" data-mode="play" data-type-speed="7"/);
});

test('a terminal’s settings are refused outside their shapes, and only a terminal has them', () => {
  const bad = [
    [{ 'data-mode': 'loop' }, /step .* or play/], [{ 'data-rows': 2 }, /4 to 60/], [{ 'data-type-speed': 11 }, /1 \(slow\) to 10/],
    [{ 'data-type-sound': 'loud' }, /thocky, creamy, clacky or off/], [{ 'data-cast': '../x.cast' }, /beside the deck/], [{ 'data-cast': null }, /keeps its recording/],
  ];
  for (const [set, why] of bad) assert.throws(() => setElementOptions(TDECK, 1, 1, { tag: 'div', set }), why);
  assert.throws(() => setElementOptions(TDECK, 1, 2, { tag: 'div', set: { 'data-mode': 'play' } }), /only a terminal/);
});
