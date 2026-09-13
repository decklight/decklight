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
import { COMMANDS, GLOBAL_HELP, listedCommands, resolveCommand } from '../cli/commands.mjs';

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
