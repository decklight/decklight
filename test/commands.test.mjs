// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The command roster (cli/commands.mjs) and the help text are two lists of the
// same commands, kept in the same file so that they drift together or not at
// all. This pins "not at all": a row the help does not mention, a help
// paragraph for a command that does not exist, or a row naming a module or an
// export that is not there each fail here, in one line, under `npm test` —
// rather than as `unknown command` for a user or a TypeError at dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMANDS, GLOBAL_HELP, START_COMMANDS, listedCommands, resolveCommand, routeForPath, shortHelp, suggestCommand,
} from '../cli/commands.mjs';

const visible = Object.entries(COMMANDS).filter(([, row]) => !row.alias).map(([name]) => name);

test('every command in the table is described in the help, and every described command exists', () => {
  const listed = listedCommands().filter((c) => c !== 'help' && c !== 'version');
  assert.deepEqual([...listed].sort(), [...visible].sort(),
    'GLOBAL_HELP and COMMANDS list different commands — add the row, or the paragraph');
});

test('the help lists each command exactly once, in one table', () => {
  const listed = listedCommands();
  assert.equal(new Set(listed).size, listed.length, 'a command is described twice');
  assert.ok(GLOBAL_HELP.startsWith('decklight — '), 'the help opens with the program name');
});

test('every row names a module that exists and an export it defines', () => {
  for (const [name, row] of Object.entries(COMMANDS)) {
    if (row.alias) continue;
    const file = row.spawn ?? row.module;
    const url = new URL(file, new URL('../cli/', import.meta.url));
    let text;
    try { text = readFileSync(fileURLToPath(url), 'utf8'); }
    catch { assert.fail(`${name}: ${file} does not exist`); }
    if (row.spawn) continue;
    // a source check rather than an import: importing every command module here
    // would load the whole CLI into the test process for a question about names
    assert.match(text, new RegExp(`^export (?:async )?function ${row.main}\\b`, 'm'),
      `${name}: ${file} does not export function ${row.main}`);
  }
});

test('an alias resolves to the row it names, and stays out of the help', () => {
  assert.equal(resolveCommand('dev'), COMMANDS.author, 'dev is the pre-rename name of author');
  assert.ok(!listedCommands().includes('dev'), 'the alias is documented nowhere, on purpose');
  assert.equal(resolveCommand('frobnicate'), null);
});

test('the cast subcommands reach castMain with their name first, except for --help', () => {
  assert.deepEqual(COMMANDS.refresh.args(['casts/'], 'refresh'), [['refresh', 'casts/']]);
  assert.deepEqual(COMMANDS.export.args(['--help'], 'export'), [['--help']],
    '--help must reach castMain bare, or it is read as a file to export');
});

test('the six unit commands share one main and pass their own name', () => {
  for (const kind of ['template', 'importer', 'transform', 'engine', 'voice', 'agent']) {
    assert.equal(COMMANDS[kind].module, './units.mjs');
    assert.deepEqual(COMMANDS[kind].args(['list'], kind), [kind, ['list']]);
  }
});

// ── the newcomer's surface: the short help, the file as the command, did-you-mean ──

test('the short help names the journey, every row a real command with a summary, and points at the rest', () => {
  const text = shortHelp();
  for (const c of START_COMMANDS) {
    assert.ok(COMMANDS[c], `${c} is in the roster`);
    assert.match(text, new RegExp(`^  ${c} +\\S`, 'm'), `${c} has a line`);
  }
  assert.match(text, /^Commands:$/m, 'the unknown-command test reads this header');
  assert.match(text, /decklight help +every command \(\d+ more\)/, 'the way to the other thirty');
  assert.match(text, /decklight <deck\.html>/, 'and the shape a newcomer will actually type');
});

test('a file as the first argument implies its verb', () => {
  assert.equal(routeForPath('talk.html'), 'author');
  assert.equal(routeForPath('slides/Talk.HTM'), 'author');
  assert.equal(routeForPath('talk.decklight'), 'present', 'a container is somebody else\u2019s deck: read-only');
  assert.equal(routeForPath('Q3 Review.pptx'), 'import');
  assert.equal(routeForPath('talk.key'), 'import');
  assert.equal(routeForPath('https://docs.google.com/presentation/d/abc/edit'), 'import');
  assert.equal(routeForPath('demo.term.yaml'), 'cast');
  assert.equal(routeForPath('notes.txt'), null, 'an unknown kind stays an unknown command');
  assert.equal(routeForPath('--help'), null);
  assert.equal(routeForPath(''), null);
});

test('did-you-mean: the word for the command first, then a unique prefix, then a slipped finger', () => {
  assert.equal(suggestCommand('edit'), 'author', 'edit is not a typo of author, it is the word people use for it');
  assert.equal(suggestCommand('new'), 'init');
  assert.equal(suggestCommand('preview'), 'present');
  assert.equal(suggestCommand('build'), 'bundle');
  assert.equal(suggestCommand('pub'), 'publish', 'a prefix that names one command');
  assert.equal(suggestCommand('pubish'), 'publish', 'one edit away');
  assert.equal(suggestCommand('bundel'), 'bundle', 'a transposition is two edits');
  assert.equal(suggestCommand('frobnicate'), null, 'nothing close: no guess is better than a wrong one');
  assert.equal(suggestCommand('author'), null, 'a real command needs no suggestion');
  assert.equal(suggestCommand('p'), null, 'one letter matches too many to guess from');
});
