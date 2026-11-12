// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// cli/editor-support.mjs: VS Code's completions and snippets, generated from
// tools/vocabulary.mjs when they are written, and the settings.json they need
// merged into, never over, the person's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DATA_FILE, DATA_REF, SNIPPETS_FILE, customData, expandSnippet, maskJsonc, mergeSettings, snippets, snippetsText,
  vscodeMain, writeEditorSupport,
} from '../cli/editor-support.mjs';
import { ATTRIBUTES, CONFIG_KEYS, attributeEntry } from '../tools/vocabulary.mjs';
import { checkMain, staticFindings } from '../cli/check.mjs';
import { planVscode } from '../cli/init.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-vscode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── the custom data ──────────────────────────────────────────────────────────

test('the custom data is the table: every authored attribute, its values, and no value where it takes none', () => {
  const data = customData();
  assert.equal(data.version, 1.1);
  assert.deepEqual(data.globalAttributes.map((a) => a.name), ATTRIBUTES.map((a) => a.name));
  const build = data.globalAttributes.find((a) => a.name === 'data-build');
  assert.deepEqual(build.values.map((v) => v.name), attributeEntry('data-build').values);
  assert.match(build.description.value, /Reveal in steps/);
  assert.equal(data.globalAttributes.find((a) => a.name === 'data-hidden').valueSet, 'v', 'bare: VS Code offers no value');
  assert.equal(data.globalAttributes.find((a) => a.name === 'data-logo').valueSet, undefined, 'bare or a number: a value may follow');
  assert.match(data.globalAttributes.find((a) => a.name === 'data-layout').description.value, /^On `<section>`\. /);
  const config = data.globalAttributes.find((a) => a.name === 'data-decklight-config').description.value;
  for (const k of CONFIG_KEYS) assert.ok(config.includes(`\`${k.name}\``), `the config hover names ${k.name}`);
});

// ── the snippets ─────────────────────────────────────────────────────────────

test('the snippets: six, each an HTML snippet with a dl- prefix, and every choice the table\'s', () => {
  const all = snippets();
  assert.deepEqual(Object.values(all).map((s) => s.prefix), ['dl-slide', 'dl-build', 'dl-notes', 'dl-diagram', 'dl-chart', 'dl-compare']);
  for (const s of Object.values(all)) {
    assert.equal(s.scope, 'html');
    assert.ok(s.description && Array.isArray(s.body));
    for (const m of s.body.join('\n').matchAll(/data-([a-z-]+)="\$\{\d+\|([^|]*)\|\}"/g)) {
      assert.deepEqual(m[2].split(','), attributeEntry(`data-${m[1]}`).values, `${s.prefix}: data-${m[1]}`);
    }
  }
  // the file is the JSON VS Code reads, after its one comment line
  const text = snippetsText();
  assert.match(text, /^\/\/ Decklight \d+\.\d+\.\d+/);
  assert.deepEqual(JSON.parse(maskJsonc(text)), all);
});

test('a snippet expands with every placeholder at its default', () => {
  assert.equal(expandSnippet(['<ul data-build="${1|fade,zoom|}">', '<li>${2:One}</li><g data-node="${3:a}"/><line data-from="${3}"/>$0']),
    '<ul data-build="fade">\n<li>One</li><g data-node="a"/><line data-from="a"/>');
});

/** Every snippet, expanded, as the slides of one deck. */
function snippetDeck(head = '') {
  const s = snippets();
  const x = (name) => expandSnippet(s[name].body);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Snippets</title>${head}
<script type="application/json" data-decklight-config>{ "decklight": "0.10.0", "theme": "aurora" }</script>
</head><body><div class="decklight">
${x('Decklight slide')}
<section>
<h2>Builds</h2>
${x('Decklight build list')}
${x('Decklight notes')}
</section>
<section><h2>A diagram</h2>
${x('Decklight diagram')}
</section>
<section><h2>A chart</h2>
${x('Decklight chart')}
</section>
${x('Decklight comparison slide')}
</div></body></html>`;
}

test('every snippet, expanded into a deck, passes decklight check from the file', () => {
  assert.deepEqual(staticFindings(snippetDeck(), { dir: ROOT, exists: () => true }), []);
});

test('every snippet renders: decklight check in Chrome has nothing to say', async (t) => {
  const { findChrome } = await import('../tools/chrome.mjs');
  const dist = path.join(ROOT, 'dist');
  if (!findChrome() || !fs.existsSync(path.join(dist, 'decklight.js'))) { t.skip('needs Chrome and a built dist/'); return; }
  const file = path.join(tmp(t), 'deck.html');
  fs.writeFileSync(file, snippetDeck());
  const out = [];
  const log = console.log, error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = () => {};
  let code;
  try { code = await checkMain([file, '--json']); } finally { console.log = log; console.error = error; }
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join('\n')), []);
});

// ── settings.json ────────────────────────────────────────────────────────────

const parses = (text) => JSON.parse(maskJsonc(text));

test('settings.json: created when there is none, and the key added in place to one that has other keys', () => {
  const none = mergeSettings(null);
  assert.equal(none.did, 'created');
  assert.deepEqual(parses(none.text), { 'html.customData': [DATA_REF] });
  assert.equal(mergeSettings('').did, 'created');

  const plain = '{\n  "editor.tabSize": 2\n}\n';
  const added = mergeSettings(plain);
  assert.equal(added.did, 'added');
  assert.deepEqual(parses(added.text), { 'html.customData': [DATA_REF], 'editor.tabSize': 2 });
  assert.ok(added.text.endsWith('"editor.tabSize": 2\n}\n'), 'the rest of the file as it was');

  assert.deepEqual(parses(mergeSettings('{}').text), { 'html.customData': [DATA_REF] });
});

test('settings.json with comments and a trailing comma: the key goes in, every comment stays', () => {
  const jsonc = '// mine\n{\n    "editor.tabSize": 4, // tabs\n    /* { not a brace */ "files.eol": "\\n",\n}\n';
  const r = mergeSettings(jsonc);
  assert.equal(r.did, 'added');
  assert.ok(r.text.startsWith('// mine\n{\n    "html.customData": ["./.vscode/decklight.html-data.json"],\n    "editor.tabSize": 4, // tabs'), r.text);
  assert.ok(r.text.includes('/* { not a brace */'));
  assert.deepEqual(parses(r.text), { 'html.customData': [DATA_REF], 'editor.tabSize': 4, 'files.eol': '\n' });
});

test('settings.json that already says it, has its own list, or is not JSON: never written, and what to add is said', () => {
  const have = `{ "html.customData": ["${DATA_REF}"] }`;
  assert.deepEqual(mergeSettings(have), { did: 'present', text: have });
  const own = mergeSettings('{ "html.customData": ["./mine.json"] }');
  assert.equal(own.did, 'manual');
  assert.equal(own.text, null);
  assert.match(own.say, /add "\.\/\.vscode\/decklight\.html-data\.json" to its "html\.customData" list/);
  assert.equal(mergeSettings('{ "a": ').did, 'manual');
  assert.equal(mergeSettings('[1]').did, 'manual');
});

test('writeEditorSupport: both files, the settings merged, and a second run changes nothing it should not', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, '.vscode'));
  const mine = '{\n  "editor.wordWrap": "on"\n}\n';
  fs.writeFileSync(path.join(dir, '.vscode/settings.json'), mine);
  const said = writeEditorSupport(dir);
  assert.match(said[0], new RegExp(`wrote \\.vscode/${DATA_FILE.replace('.', '\\.')} and \\.vscode/${SNIPPETS_FILE.replace('.', '\\.')}`));
  assert.match(said[1], /added html\.customData to \.vscode\/settings\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.vscode', DATA_FILE), 'utf8')), customData());
  const settings = fs.readFileSync(path.join(dir, '.vscode/settings.json'), 'utf8');
  assert.deepEqual(parses(settings), { 'html.customData': [DATA_REF], 'editor.wordWrap': 'on' });
  assert.match(writeEditorSupport(dir)[1], /already points VS Code/);
  assert.equal(fs.readFileSync(path.join(dir, '.vscode/settings.json'), 'utf8'), settings, 'a second run leaves it be');
  // a list of the person's own: the file is not touched, the line to add is said
  const own = '{ "html.customData": ["./mine.json"] }';
  fs.writeFileSync(path.join(dir, '.vscode/settings.json'), own);
  assert.match(writeEditorSupport(dir)[1], /left as it is: add "\.\/\.vscode\/decklight\.html-data\.json"/);
  assert.equal(fs.readFileSync(path.join(dir, '.vscode/settings.json'), 'utf8'), own);
});

test('decklight vscode <deck.html> writes beside the deck; a folder that is not there is refused', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'talk.html'), snippetDeck());
  const log = console.log;
  console.log = () => {};
  try { assert.equal(await vscodeMain([path.join(dir, 'talk.html')]), 0); } finally { console.log = log; }
  assert.ok(fs.existsSync(path.join(dir, '.vscode', SNIPPETS_FILE)));
  await assert.rejects(vscodeMain([path.join(dir, 'nowhere')]), /no such folder/);
  await assert.rejects(vscodeMain(['--nope']), /unknown option --nope/);
});

// ── init ─────────────────────────────────────────────────────────────────────

test('planVscode: a flag says; a terminal with VS Code on the PATH is asked; anything else writes nothing', () => {
  assert.equal(planVscode({ args: ['--vscode'] }).action, 'write');
  assert.equal(planVscode({ args: ['--no-vscode'], tty: true, hasCode: true }).action, 'skip');
  assert.equal(planVscode({ tty: true, hasCode: true }).action, 'ask');
  assert.equal(planVscode({ tty: true, hasCode: false }).action, 'skip');
  assert.equal(planVscode({ tty: false, hasCode: true }).action, 'skip');
});

test('init --vscode writes .vscode/ beside the new deck; init without it writes none', (t) => {
  const dir = tmp(t);
  const init = (sub, more) => spawnSync(process.execPath, [CLI, 'init', 'Typed', '--dir', path.join(dir, sub),
    '--no-skill', '--no-git', '--no-open', '--no-design-system', ...more], { encoding: 'utf8', input: '' });
  const r = init('with', ['--vscode']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.vscode\/decklight\.html-data\.json/);
  assert.deepEqual(parses(fs.readFileSync(path.join(dir, 'with/.vscode/settings.json'), 'utf8')), { 'html.customData': [DATA_REF] });
  assert.ok(fs.existsSync(path.join(dir, 'with/.vscode', SNIPPETS_FILE)));
  assert.equal(init('without', []).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'without/.vscode')));
});
