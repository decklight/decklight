// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/vocabulary.mjs: the one table of what an author may write, and the
// rules that read it. The first tests keep the table honest against the code
// that acts on it, in both directions: a `data-*` name the runtime reads that
// the table does not know would be reported as a typo of something, and an
// entry nothing reads would be completed in an editor for no effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ATTRIBUTES, CONFIG_KEYS, ENGINE_ATTRIBUTES, attributeEntry, attributeFindings, configFindings,
  didYouMean, editDistance, isKnownAttribute, jsonErrorAt,
} from '../tools/vocabulary.mjs';
import { staticFindings } from '../cli/check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir` matching `re`, as `[path, text]`. */
function sources(dir, re) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (re.test(f.name)) out.push([p, fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every `data-*` name a text spells, literally or as `dataset.camelCase`. */
function dataNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/\bdata-[a-z][a-z0-9-]*/g)) names.add(m[0]);
  for (const m of text.matchAll(/\bdataset\.([a-zA-Z]+)/g)) names.add(`data-${kebab(m[1])}`);
  return names;
}

const AUTHORED = ATTRIBUTES.map((a) => a.name);
const ALL = [...AUTHORED, ...ENGINE_ATTRIBUTES];

test('every data-* name the runtime spells is in the table, as authored or as the engine\'s own', () => {
  const missing = new Map();
  for (const [file, text] of sources('src', /\.(m?js|css)$/)) {
    for (const name of dataNames(text)) {
      // a name built in a template literal (`data-background-${k}`) is a prefix
      if (name.endsWith('-') ? ALL.some((n) => n.startsWith(name)) : ALL.includes(name)) continue;
      missing.set(name, path.relative(ROOT, file));
    }
  }
  assert.deepEqual([...missing], [], 'add each to ATTRIBUTES (an author writes it) or ENGINE_ATTRIBUTES (the runtime does)');
});

test('every name in the table is read somewhere: no entry completes in an editor for nothing', () => {
  const corpus = [...sources('src', /\.(m?js|css)$/), ...sources('cli', /\.mjs$/), ...sources('tools', /\.mjs$/)]
    .filter(([file]) => !file.endsWith(`tools${path.sep}vocabulary.mjs`) && !/cli[\\/](editor-support|vocabulary-docs)\.mjs$/.test(file));
  const spelled = new Set();
  for (const [, text] of corpus) for (const n of dataNames(text)) spelled.add(n);
  assert.deepEqual(ALL.filter((n) => !spelled.has(n)), []);
});

test('the table is well formed: unique, lower case, every enumeration named and non-empty', () => {
  assert.equal(new Set(ALL).size, ALL.length, 'no name twice, and none both authored and the engine\'s');
  for (const a of ATTRIBUTES) {
    assert.match(a.name, /^data-[a-z][a-z0-9-]*$/);
    assert.deepEqual(Object.keys(a).filter((k) => !['name', 'kind', 'values', 'bare', 'number', 'open'].includes(k)), [],
      `${a.name}: only what the rules read (it ships in the runtime)`);
    if (a.values) {
      assert.ok(a.values.length && a.kind, `${a.name}: an enumeration has values and a kind`);
      assert.ok(!a.values.includes(''), `${a.name}: bare is said with bare: true`);
    }
  }
  assert.equal(new Set(CONFIG_KEYS.map((k) => k.name)).size, CONFIG_KEYS.length);
  for (const k of CONFIG_KEYS) assert.ok(k.type, `${k.name}: a type`);
});

test('the enumerations are the runtime\'s own lists', () => {
  const text = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // the layout ring (src/core/layout.js) and the shipped build styles (decklight.css)
  const ring = JSON.parse(/LAYOUTS = (\[[^\]]*\])/.exec(text('src/core/layout.js'))[1].replace(/'/g, '"'));
  assert.deepEqual(attributeEntry('data-layout').values, ring);
  const styled = new Set([...text('src/decklight.css').matchAll(/data-build-style="([a-z-]+)"/g)].map((m) => m[1]));
  for (const s of styled) assert.ok(attributeEntry('data-build').values.includes(s), `build style ${s}`);
  const animated = new Set([...text('src/decklight.css').matchAll(/data-animate="([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...animated].sort(), [...attributeEntry('data-animate').values].sort());
  const sounds = JSON.parse(/SOUND_STEPS = (\[[^\]]*\])/.exec(text('src/terminal/player.mjs'))[1].replace(/'/g, '"'));
  assert.deepEqual(attributeEntry('data-type-sound').values, sounds);
});

test('every configuration key the runtime and the CLI read is in the table', () => {
  const keys = new Set(CONFIG_KEYS.map((k) => k.name));
  const engine = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  const defaults = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(engine)[1];
  for (const m of defaults.matchAll(/^\s*(\w+):/gm)) assert.ok(keys.has(m[1]), `DEFAULTS.${m[1]}`);
  for (const [file, text] of sources('src', /\.js$/)) {
    for (const m of text.matchAll(/\bconfig\??\.([a-zA-Z]+)\b/g)) assert.ok(keys.has(m[1]), `${path.relative(ROOT, file)}: config.${m[1]}`);
  }
  for (const [file, text] of sources('cli', /\.mjs$/)) {
    for (const m of text.matchAll(/export const \w+_KEY = '(\w+)'/g)) assert.ok(keys.has(m[1]), `${path.relative(ROOT, file)}: ${m[1]}`);
  }
  assert.ok(keys.has('decklight') && keys.has('theme'), 'the file\'s own key, and the theme it opens on');
});

// ── did you mean ─────────────────────────────────────────────────────────────

test('edit distance counts a swap of neighbours as one slip', () => {
  assert.equal(editDistance('build', 'build'), 0);
  assert.equal(editDistance('buld', 'build'), 1);
  assert.equal(editDistance('bulid', 'build'), 1);
  assert.equal(editDistance('fdae', 'fade'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('did-you-mean finds the slip, ignores case, and leaves a word close to nothing alone', () => {
  assert.equal(didYouMean('data-buld', AUTHORED, { strip: 'data-' }), 'data-build');
  assert.equal(didYouMean('data-layuot', AUTHORED, { strip: 'data-' }), 'data-layout');
  assert.equal(didYouMean('data-backgrund-image', AUTHORED, { strip: 'data-' }), 'data-background-image');
  assert.equal(didYouMean('Fade-Up', ['fade', 'fade-up']), 'fade-up');
  assert.equal(didYouMean('data-tracking-id', AUTHORED, { strip: 'data-' }), null);
  assert.equal(didYouMean('data-myapp', AUTHORED, { strip: 'data-' }), null);
  // three letters or fewer: everything is near `to` and `id`, so nothing is a slip of them
  assert.equal(didYouMean('data-tx', AUTHORED, { strip: 'data-' }), null);
  assert.equal(didYouMean('data-ix', AUTHORED, { strip: 'data-' }), null);
  assert.equal(didYouMean('trasition', CONFIG_KEYS.map((k) => k.name)), 'transition');
  assert.equal(didYouMean('slidenumber', CONFIG_KEYS.map((k) => k.name)), 'slideNumber');
});

test('the engine\'s own names are known, and never a slip of the authored one beside them', () => {
  for (const n of ['data-builds', 'data-pinned', 'data-build-state', 'data-dense', 'data-slide-index']) {
    assert.ok(isKnownAttribute(n), n);
    assert.deepEqual(attributeFindings([{ slide: 1, title: 'x', attrs: { [n]: '' } }]), [], n);
  }
});

// ── the rules ────────────────────────────────────────────────────────────────

const on = (attrs, slide = 1) => attributeFindings([{ slide, title: 'A slide', attrs }]);

test('unknown-attribute: a slip of a name Decklight reads is a warning that names the one meant', () => {
  const [f, ...rest] = on({ 'data-buld': '' });
  assert.equal(rest.length, 0);
  assert.equal(f.rule, 'unknown-attribute');
  assert.equal(f.level, 'warn');
  assert.equal(f.slide, 1);
  assert.match(f.message, /^data-buld is not an attribute Decklight reads: did you mean data-build\?/);
  assert.deepEqual(on({ 'data-myapp': '1', 'data-tracking-id': 'x', class: 'a', 'aria-label': 'x' }), [], 'the author\'s own');
  assert.deepEqual(on({ 'data-Build': 'fade' }), [], 'HTML names are not case-sensitive');
});

test('unknown-attribute: said once per slide, however many elements carry the slip', () => {
  const found = attributeFindings([1, 1, 1, 2].map((slide) => ({ slide, title: '', attrs: { 'data-buld': '' } })));
  assert.deepEqual(found.map((f) => f.slide), [1, 2]);
});

test('unknown-value: an enumerated attribute\'s slip names the value meant and what it takes', () => {
  const [f] = on({ 'data-build': 'fade-upp' });
  assert.equal(f.rule, 'unknown-value');
  assert.equal(f.level, 'warn');
  assert.match(f.message, /^data-build="fade-upp" is not a build effect: did you mean fade-up\? It takes fade, fade-up, .* or no value$/);
  const [far] = on({ 'data-build': 'wobble' });
  assert.match(far.message, /^data-build="wobble" is not a build effect\. It takes /);
  assert.match(on({ 'data-route': 'elbo' })[0].message, /did you mean elbow\?/);
  assert.match(on({ 'data-transition': 'fdae' })[0].message, /did you mean fade\?/);
  assert.match(on({ 'data-chart': 'pi' })[0].message, /is not a chart type/);
  assert.match(on({ 'data-animate': 'spinn' })[0].message, /is not an animation: did you mean spin\?/);
});

test('unknown-value: what an attribute does take is never a finding', () => {
  const fine = [
    { 'data-build': '' }, { 'data-build': 'draw' }, { 'data-layout': 'split-flip' }, { 'data-pin': '' }, { 'data-pin': 'none' },
    { 'data-pin': '120' }, { 'data-logo': '' }, { 'data-logo': '80' }, { 'data-background-size': '50% auto' },
    { 'data-concept': 'anything' }, { 'data-template': 'acme/cover' }, { 'data-speed': '2' }, { 'data-nest': 'off' },
    // a slashed data-layout names a template: ds-layout-attr says so, not this rule
    { 'data-layout': 'acme/cover' },
  ];
  for (const attrs of fine) assert.deepEqual(on(attrs), [], JSON.stringify(attrs));
  assert.equal(on({ 'data-layout': '' })[0]?.rule, 'unknown-value', 'a layout with no value is no layout');
  assert.equal(on({ 'data-pin': 'nope' })[0]?.rule, 'unknown-value');
  assert.match(on({ 'data-pin': 'nope' })[0].message, /It takes none, a number or no value$/);
});

test('config-json: a block that does not parse is an error with the line, and the likely slip', () => {
  const text = '\n  { "decklight": "0.10.0",\n    "theme": "aurora",\n  }\n  ';
  const [f, ...rest] = configFindings(text, { line: 7 });
  assert.equal(rest.length, 0);
  assert.equal(f.rule, 'config-json');
  assert.equal(f.level, 'error');
  assert.equal(f.slide, null);
  assert.match(f.message, /^the configuration block is not valid JSON \(line 10, column 3\): .*\(a comma after the last entry\?\)\. The deck boots with its defaults/);
  // with no file line, the block's own
  assert.match(configFindings(text)[0].message, /\(line 4 of the block, column 3\)/);
  assert.match(configFindings('[1, 2]')[0].message, /is not a JSON object/);
  assert.deepEqual(configFindings(null), [], 'no block, nothing to say');
});

test('jsonErrorAt reads the position V8 and Firefox give, and nothing from a parser that gives none', () => {
  assert.deepEqual(jsonErrorAt('Unexpected token } in JSON at position 5', 'ab\ncd}'), { line: 2, column: 3, offset: 5 });
  assert.deepEqual(jsonErrorAt('JSON.parse: expected property name at line 3 column 2 of the JSON data', ''), { line: 3, column: 2, offset: null });
  assert.equal(jsonErrorAt('JSON Parse error: Expected \'}\'', 'x'), null);
});

test('config-key and config-value: a key or a value Decklight does not read, with the one meant', () => {
  const found = configFindings('{ "decklight": "0.10.0", "trasition": "fade", "transition": "fad", "analytics": 1, "slideNumber": "n/N", "pinTitles": 99 }');
  assert.deepEqual(found.map((f) => f.rule), ['config-key', 'config-value', 'config-key']);
  assert.ok(found.every((f) => f.level === 'warn' && f.slide === null));
  assert.match(found[0].message, /^"trasition" is not a configuration key Decklight reads: did you mean "transition"\?/);
  assert.match(found[1].message, /^"transition": "fad" is not a transition: did you mean "fade"\?/);
  assert.match(found[2].message, /^"analytics" is not a configuration key Decklight reads\. As written it does nothing$/);
  assert.deepEqual(configFindings('{ "decklight": "0.10.0", "theme": "aurora", "slideNumber": false }'), []);
});

// ── a deck typed by hand ─────────────────────────────────────────────────────

test('decklight check on a deck with typos: each slip once, where it is, and the clean slide clean', () => {
  const file = path.join(ROOT, 'test/fixtures/vocabulary/typos.html');
  const found = staticFindings(fs.readFileSync(file, 'utf8'), { dir: path.dirname(file), exists: () => true })
    .filter((f) => /^(unknown-attribute|unknown-value|config-)/.test(f.rule));
  const said = found.map((f) => `${f.slide ?? '-'} ${f.rule} ${/^"?([\w-]+(?:="[^"]*")?)/.exec(f.message)[1]}`);
  assert.deepEqual(said, [
    '- config-key trasition',
    '- config-value slideNumber',
    '- config-key analytics',
    '1 unknown-attribute data-layuot',
    '1 unknown-value data-build="fade-upp"',
    '1 unknown-attribute data-buld',
    '2 unknown-value data-transition="fdae"',
    '2 unknown-value data-route="elbo"',
    '2 unknown-value data-animate="wobble"',
  ]);
  assert.match(found.find((f) => f.rule === 'config-value').message, /"n\/n" is not a slide number style: did you mean "n\/N"\?/);
});

test('a freshly init-ed deck, data or self-contained, has nothing to say', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-vocab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, more] of [['data.html', []], ['inline.html', ['--inline']]]) {
    execFileSync(process.execPath, [path.join(ROOT, 'cli/decklight.mjs'), 'init', 'Typed by hand', '--dir', dir, '-o', name,
      '--no-skill', '--no-git', '--no-open', '--no-design-system', ...more], { stdio: 'ignore', input: '' });
    const found = staticFindings(fs.readFileSync(path.join(dir, name), 'utf8'), { dir, exists: () => true })
      .filter((f) => /^(unknown-attribute|unknown-value|config-)/.test(f.rule));
    assert.deepEqual(found, [], name);
  }
});

test('the demo decks have nothing to say', () => {
  const decks = ['demo/features.html', 'demo/intro.html', 'demo/pitch.html', 'demo/showcase.html', 'demo/smoke.html',
    ...fs.readdirSync(path.join(ROOT, 'demo/postmortem/stages')).map((f) => `demo/postmortem/stages/${f}`)];
  for (const d of decks) {
    const html = fs.readFileSync(path.join(ROOT, d), 'utf8');
    const found = staticFindings(html, { dir: path.dirname(path.join(ROOT, d)), exists: () => true })
      .filter((f) => /^(unknown-attribute|unknown-value|config-)/.test(f.rule));
    assert.deepEqual(found, [], d);
  }
});
