// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Open in your editor (PRESENTING_EDITING): the line and column an address
// starts at, the argument array each editor is started with, the remembered
// choice, and the routes, called as functions with a fake spawner. Nothing
// here starts an editor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lineColumn, sourcePosition, registerOpenRoutes } from '../cli/edit-open.mjs';
import {
  editorCommand, detectEditors, envEditor, parseTemplate, fillTemplate, launchEditor,
  loadEditorChoice, saveEditorChoice, editorConfigPath, checkChoice,
} from '../cli/code-editor.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <ul>
        <li>one</li>
        <li>two</li>
      </ul>
    </section>
    <section data-layout="centered">
\t<h2>Beta</h2> <p>é <b>x</b></p>
    </section>
  </div>
</body></html>
`;

/** A machine with exactly these files on it: PATH lookups and app bundles alike. */
const machine = (...files) => (f) => files.includes(f);
const POSIX = { platform: 'linux', env: { PATH: '/usr/bin:/opt/bin', HOME: '/home/me' } };

// ── where an address starts ──────────────────────────────────────────────

test('lineColumn counts lines and characters from 1, a tab and an accent one each', () => {
  assert.deepEqual(lineColumn('ab\ncd', 0), { line: 1, column: 1 });
  assert.deepEqual(lineColumn('ab\ncd', 4), { line: 2, column: 2 });
  assert.deepEqual(lineColumn('\té\tx', 3), { line: 1, column: 4 });
});

test('sourcePosition: a slide is its <section>, an element its open tag, a node by its file path', () => {
  const at = (addr) => { const p = sourcePosition(DECK, addr); return [p.line, p.column, DECK.slice(p.offset, p.offset + 12)]; };
  assert.deepEqual(at({ slide: 1 }), [4, 5, '<section>\n  ']);
  assert.deepEqual(at({ slide: 2 }), [11, 5, '<section dat']);
  assert.deepEqual(at({ slide: 1, index: 0 }), [5, 7, '<h2>Alpha</h']);
  assert.deepEqual(at({ slide: 1, index: 1, tag: 'ul' }), [6, 7, '<ul>\n       ']);
  assert.deepEqual(at({ slide: 1, index: 1, path: [1], tag: 'li' }), [8, 9, '<li>two</li>']);
  assert.deepEqual(at({ slide: 2, index: 0 }), [12, 2, '<h2>Beta</h2'], 'a tab is one column');
  assert.deepEqual(at({ slide: 2, index: 1, path: [0], tag: 'b' }), [12, 21, '<b>x</b></p>'], 'é is one column, not two bytes');
});

test('sourcePosition: what the file does not have throws, a stale path or tag as STALE', () => {
  assert.throws(() => sourcePosition(DECK, { slide: 3 }), /no slide 3/);
  assert.throws(() => sourcePosition(DECK, { slide: 1, index: 9 }), /no element at index 9/);
  assert.throws(() => sourcePosition(DECK, { slide: 1, index: 1, path: [5] }), (e) => e.code === 'STALE');
  assert.throws(() => sourcePosition(DECK, { slide: 1, index: 1, path: [0], tag: 'p' }), (e) => e.code === 'STALE');
  assert.throws(() => sourcePosition(DECK, { slide: 1, index: 0, tag: 'ul' }), (e) => e.code === 'STALE', 'a top-level tag is checked too');
});

// ── the commands ─────────────────────────────────────────────────────────

const POS = { file: '/decks/my talk.html', line: 12, column: 7 };

test('VS Code, Cursor and Zed: their own addressing, the file one argument however it is spelled', () => {
  const has = machine('/usr/bin/code', '/usr/bin/cursor', '/opt/bin/zed');
  const cmd = (editor) => editorCommand({ editor }, POS, { ...POSIX, exists: has });
  assert.deepEqual(cmd('vscode'), { ok: true, bin: '/usr/bin/code', args: ['-g', '/decks/my talk.html:12:7'], label: 'VS Code' });
  assert.deepEqual(cmd('cursor'), { ok: true, bin: '/usr/bin/cursor', args: ['-g', '/decks/my talk.html:12:7'], label: 'Cursor' });
  assert.deepEqual(cmd('zed'), { ok: true, bin: '/opt/bin/zed', args: ['/decks/my talk.html:12:7'], label: 'Zed' });
});

test('macOS: an editor whose shell command is not on PATH is found in its app bundle', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/me' };
  const vs = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const zed = '/Users/me/Applications/Zed.app/Contents/MacOS/cli';
  const r = editorCommand({ editor: 'vscode' }, POS, { env, platform: 'darwin', exists: machine(vs, zed) });
  assert.equal(r.bin, vs);
  assert.equal(editorCommand({ editor: 'zed' }, POS, { env, platform: 'darwin', exists: machine(vs, zed) }).bin, zed);
  const listed = detectEditors({ env, platform: 'darwin', exists: machine(vs, zed) });
  assert.deepEqual(listed.map((e) => e.id), ['vscode', 'zed', 'custom']);
  assert.equal(listed[0].note, 'from its app');
  assert.deepEqual(detectEditors({ env, platform: 'linux', exists: machine(vs, zed) }).map((e) => e.id), ['custom'], 'app bundles are a macOS place');
});

test('an editor that is not there is `missing`, said in a sentence; nothing chosen is `unset`', () => {
  const r = editorCommand({ editor: 'cursor' }, POS, { ...POSIX, exists: machine() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  assert.match(r.error, /Cursor is not installed here/);
  assert.equal(editorCommand(null, POS, POSIX).reason, 'unset');
});

test('$VISUAL before $EDITOR; a GUI one it knows is addressed, its --wait dropped', () => {
  const env = { ...POSIX.env, VISUAL: 'subl -w', EDITOR: 'vim' };
  const own = envEditor(env);
  assert.equal(own.name, 'VISUAL');
  assert.equal(own.blocked, null);
  const r = editorCommand({ editor: 'env' }, POS, { ...POSIX, env, exists: machine('/usr/bin/subl') });
  assert.deepEqual([r.bin, r.args, r.label], ['/usr/bin/subl', ['/decks/my talk.html:12:7'], 'Sublime Text ($VISUAL)']);
  const code = editorCommand({ editor: 'env' }, POS, { ...POSIX, env: { ...POSIX.env, EDITOR: '/opt/bin/code --wait --new-window' }, exists: machine('/opt/bin/code') });
  assert.deepEqual(code.args, ['--new-window', '-g', '/decks/my talk.html:12:7']);
  const mate = editorCommand({ editor: 'env' }, POS, { ...POSIX, env: { ...POSIX.env, EDITOR: 'mate' }, exists: machine('/usr/bin/mate') });
  assert.deepEqual(mate.args, ['-l', '12:7', '/decks/my talk.html']);
});

test('a terminal editor in $EDITOR is offered blocked, with the reason, and never run', () => {
  const env = { ...POSIX.env, EDITOR: 'nvim' };
  const listed = detectEditors({ env, platform: 'linux', exists: machine('/usr/bin/nvim') });
  const row = listed.find((e) => e.id === 'env');
  assert.match(row.blocked, /nvim runs in a terminal/);
  const r = editorCommand({ editor: 'env' }, POS, { ...POSIX, env, exists: machine('/usr/bin/nvim') });
  assert.deepEqual([r.ok, r.reason], [false, 'terminal']);
  const odd = editorCommand({ editor: 'env' }, POS, { ...POSIX, env: { ...POSIX.env, EDITOR: 'gedit' }, exists: machine('/usr/bin/gedit') });
  assert.deepEqual([odd.ok, odd.reason], [false, 'unknown']);
});

test('a template: words split like a shell would for the simple cases, placeholders filled, never a shell', () => {
  assert.deepEqual(parseTemplate('myedit --line {line} --col={column} "{file}"'), ['myedit', '--line', '{line}', '--col={column}', '{file}']);
  assert.deepEqual(fillTemplate(['--at', '{file}:{line}:{column}'], POS), ['--at', '/decks/my talk.html:12:7']);
  const r = editorCommand({ editor: 'custom', template: '"/opt/My Editor/bin/ed it" {file} +{line}' }, POS, { ...POSIX, exists: machine('/opt/My Editor/bin/ed it') });
  assert.deepEqual([r.bin, r.args], ['/opt/My Editor/bin/ed it', ['/decks/my talk.html', '+12']]);
  const semi = editorCommand({ editor: 'custom', template: 'myedit {file}; rm -rf ~' }, { ...POS, file: '/d/$(x).html' }, { ...POSIX, exists: machine('/usr/bin/myedit') });
  assert.deepEqual(semi.args, ['/d/$(x).html;', 'rm', '-rf', '~'], 'metacharacters are only ever argument text');
  for (const [bad, why] of [['', /empty/], ['{file}', /start with a program/], ['myedit {line}', /\{file\}/], ['myedit "{file}', /not closed/], ['a\n{file}', /one line/]]) {
    assert.throws(() => parseTemplate(bad), why, JSON.stringify(bad));
  }
  assert.equal(editorCommand({ editor: 'custom', template: 'nothere {file}' }, POS, { ...POSIX, exists: machine() }).reason, 'missing');
});

test('Windows: a batch file is said, never started through a shell', () => {
  const env = { Path: 'C:\\Code\\bin' };
  const r = editorCommand({ editor: 'vscode' }, POS, { env, platform: 'win32', exists: machine('C:\\Code\\bin\\code.cmd') });
  assert.deepEqual([r.ok, r.reason], [false, 'missing']);
  assert.match(r.error, /without a shell/);
});

test('launchEditor: detached, no shell, output ignored; a failure to start is an answer, not a throw', async () => {
  const calls = [];
  const fake = (event, extra = {}) => (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = Object.assign(new EventEmitter(), { unref: () => { calls.at(-1).unref = true; } });
    process.nextTick(() => child.emit(event, Object.assign(new Error('spawn x ENOENT'), extra)));
    return child;
  };
  assert.deepEqual(await launchEditor({ bin: '/usr/bin/code', args: ['-g', 'f:1:1'] }, { spawn: fake('spawn') }), { ok: true });
  assert.deepEqual(calls[0].args, ['-g', 'f:1:1']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[0].unref, true, 'the server does not wait for its editor');
  const r = await launchEditor({ bin: 'code', args: [] }, { spawn: fake('error', { code: 'ENOENT' }) });
  assert.deepEqual(r, { ok: false, error: 'code was not found' });
});

// ── the remembered choice ───────────────────────────────────────────────

test('the choice lives beside tts.json, $XDG_CONFIG_HOME honoured; a bad file is first use', (t) => {
  const dir = tmp('editor-store', t);
  const env = { XDG_CONFIG_HOME: dir, HOME: '/nowhere' };
  assert.equal(editorConfigPath(env), path.join(dir, 'decklight', 'editor.json'));
  assert.equal(editorConfigPath({ HOME: '/home/me' }), path.join('/home/me', '.config', 'decklight', 'editor.json'));
  assert.equal(loadEditorChoice(env), null);
  saveEditorChoice({ editor: 'zed', extra: 'dropped' }, env);
  assert.deepEqual(JSON.parse(readFileSync(editorConfigPath(env), 'utf8')), { editor: 'zed' });
  assert.deepEqual(loadEditorChoice(env), { editor: 'zed' });
  saveEditorChoice({ editor: 'custom', template: '  myedit {file}  ' }, env);
  assert.deepEqual(loadEditorChoice(env), { editor: 'custom', template: 'myedit {file}' });
  assert.throws(() => saveEditorChoice({ editor: 'custom', template: 'myedit' }, env), /\{file\}/);
  assert.deepEqual(loadEditorChoice(env), { editor: 'custom', template: 'myedit {file}' }, 'a refused choice wrote nothing');
  writeFileSync(editorConfigPath(env), '{"editor":"notepad++"}');
  assert.equal(loadEditorChoice(env), null);
  writeFileSync(editorConfigPath(env), 'not json');
  assert.equal(loadEditorChoice(env), null);
  saveEditorChoice(null, env);
  assert.equal(loadEditorChoice(env), null);
  assert.throws(() => checkChoice({ editor: 'emacs' }), /no editor called/);
});

// ── the routes ───────────────────────────────────────────────────────────

const OWN = { headers: { origin: 'http://127.0.0.1:9999' } };
function harness(t, { exists = machine('/usr/bin/code'), env: extra = {}, fail = null } = {}) {
  const dir = tmp('edit-open', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
  const env = { PATH: '/usr/bin', HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), ...extra };
  const spawned = [];
  const spawn = (bin, args, opts) => {
    spawned.push({ bin, args, opts });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    process.nextTick(() => (fail ? child.emit('error', Object.assign(new Error(fail), { code: 'ENOENT' })) : child.emit('spawn')));
    return child;
  };
  const routes = new Map();
  registerOpenRoutes(routes, {
    readDeck: () => readFileSync(deck, 'utf8'), deckPath: deck, env, spawn, platform: 'linux', exists,
    ownOrigin: (req) => req.headers?.origin === 'http://127.0.0.1:9999', log: () => {},
  });
  return { routes, deck, env, spawned };
}
async function call(routes, key, { body, req = OWN } = {}) {
  const sent = {};
  await routes.get(key)({ req, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: body === undefined ? '' : JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('the open routes, in order', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()], ['GET /deck/edit/editor', 'POST /deck/edit/editor', 'POST /deck/edit/open']);
});

test('POST /deck/edit/open: asks for a choice first, then opens the deck at the element\'s line', async (t) => {
  const { routes, deck, env, spawned } = harness(t);
  const first = await call(routes, 'POST /deck/edit/open', { body: { slide: 1, index: 1, path: [1], tag: 'li' } });
  assert.deepEqual([first.code, first.body.choose], [428, true]);
  assert.deepEqual(first.body.editors.map((e) => e.id), ['vscode', 'custom'], 'the chooser\'s list rides the refusal');
  assert.equal(spawned.length, 0);
  const saved = await call(routes, 'POST /deck/edit/editor', { body: { editor: 'vscode' } });
  assert.deepEqual([saved.code, saved.body.chosen.label], [200, 'VS Code']);
  assert.ok(existsSync(path.join(env.XDG_CONFIG_HOME, 'decklight', 'editor.json')));
  const r = await call(routes, 'POST /deck/edit/open', { body: { slide: 1, index: 1, path: [1], tag: 'li' } });
  assert.deepEqual([r.code, r.body.line, r.body.column, r.body.editor], [200, 8, 9, 'VS Code']);
  assert.deepEqual(spawned[0].args, ['-g', `${deck}:8:9`]);
  const slide = await call(routes, 'POST /deck/edit/open', { body: { slide: 2 } });
  assert.equal(slide.body.line, 11);
  assert.deepEqual(spawned[1].args, ['-g', `${deck}:11:5`]);
});

test('POST /deck/edit/open: a stale address is 409, a bad one 400; the file is always the deck', async (t) => {
  const { routes, spawned } = harness(t);
  await call(routes, 'POST /deck/edit/editor', { body: { editor: 'vscode' } });
  for (const body of [{ slide: 1, index: 1, path: [7], tag: 'li' }, { slide: 1, index: 0, tag: 'p' }, { slide: 9 }, { slide: 1, index: 40 }]) {
    const r = await call(routes, 'POST /deck/edit/open', { body });
    assert.deepEqual([r.code, r.body.stale], [409, true], JSON.stringify(body));
  }
  for (const body of [{}, { slide: 0 }, { slide: 1, index: -1 }, { slide: 1, path: [0] }, { slide: 1, index: 0, path: 'x' }, { slide: 1, index: 0, path: [-1] }]) {
    assert.equal((await call(routes, 'POST /deck/edit/open', { body })).code, 400, JSON.stringify(body));
  }
  const r = await call(routes, 'POST /deck/edit/open', { body: { slide: 1, file: '/etc/passwd', command: 'rm', editor: 'custom', template: 'sh -c {file}' } });
  assert.equal(r.code, 200);
  assert.equal(spawned.at(-1).bin, '/usr/bin/code', 'the request names no program');
  assert.ok(!spawned.some((s) => s.args.some((a) => a.includes('/etc/passwd'))), 'nor a file');
});

test('POST /deck/edit/editor and /open answer this server\'s own page only', async (t) => {
  const { routes, spawned, env } = harness(t);
  for (const req of [{ headers: {} }, { headers: { origin: 'null' } }, { headers: { origin: 'http://127.0.0.1:5173' } }]) {
    assert.equal((await call(routes, 'POST /deck/edit/editor', { req, body: { editor: 'custom', template: 'evil {file}' } })).code, 403);
    assert.equal((await call(routes, 'POST /deck/edit/open', { req, body: { slide: 1 } })).code, 403);
  }
  assert.equal(loadEditorChoice(env), null);
  assert.equal(spawned.length, 0);
});

test('POST /deck/edit/editor: refuses what this machine cannot run, keeps a template, forgets on null', async (t) => {
  const { routes, env } = harness(t, { env: { EDITOR: 'vim' } });
  const missing = await call(routes, 'POST /deck/edit/editor', { body: { editor: 'zed' } });
  assert.deepEqual([missing.code, missing.body.error], [400, 'Zed is not on this machine']);
  const vim = await call(routes, 'POST /deck/edit/editor', { body: { editor: 'env' } });
  assert.equal(vim.code, 400);
  assert.match(vim.body.error, /vim runs in a terminal/);
  assert.equal((await call(routes, 'POST /deck/edit/editor', { body: { editor: 'custom', template: 'x' } })).code, 400);
  const own = await call(routes, 'POST /deck/edit/editor', { body: { editor: 'custom', template: 'code -g {file}:{line}' } });
  assert.deepEqual([own.code, own.body.chosen.editor, own.body.chosen.label], [200, 'custom', 'your command (code)']);
  const state = await call(routes, 'GET /deck/edit/editor', { req: { headers: {} } });
  assert.equal(state.body.chosen.template, 'code -g {file}:{line}');
  await call(routes, 'POST /deck/edit/editor', { body: { editor: null } });
  assert.equal(loadEditorChoice(env), null);
});

test('POST /deck/edit/open: an editor that is gone, or does not start, is a 422 the page can say', async (t) => {
  const gone = harness(t);
  await call(gone.routes, 'POST /deck/edit/editor', { body: { editor: 'vscode' } });
  // the editor uninstalled after it was chosen
  const g2 = harness(t, { exists: machine() });
  saveEditorChoice({ editor: 'vscode' }, g2.env);
  const r = await call(g2.routes, 'POST /deck/edit/open', { body: { slide: 1 } });
  assert.deepEqual([r.code, r.body.reason], [422, 'missing']);
  assert.match(r.body.error, /VS Code is not installed here/);
  const broken = harness(t, { fail: 'spawn ENOENT' });
  saveEditorChoice({ editor: 'vscode' }, broken.env);
  const b = await call(broken.routes, 'POST /deck/edit/open', { body: { slide: 1 } });
  assert.deepEqual([b.code, b.body.reason], [422, 'missing']);
  assert.match(b.body.error, /VS Code did not start/);
});
