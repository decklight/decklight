// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/args.mjs is the argv reader every command and tool goes through, and
// until now only `firstPositional` had a test — one, for the bug that created
// it. The two regressions pinned at the bottom are the same bug in two more
// places: a server that found its deck with a naive `filter(!startsWith('-'))`
// (present) and one whose value-flag list was missing an entry (the author
// server's --git-mode), each refusing a "deck" that was really a flag's value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argReader, firstPositional, parsePort, badPort } from '../tools/args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = (rel) => path.resolve(here, '..', rel);
const run = (rel, args) => spawnSync(process.execPath, [script(rel), ...args], { encoding: 'utf8', env: { ...process.env, DECKLIGHT_BANNER: '1' } });

// ── argReader ──────────────────────────────────────────────────────────────

test('opt reads the token after the first occurrence of a flag, or the default', () => {
  const { opt } = argReader(['--port', '8790', 'deck.html', '--port', '9000']);
  assert.equal(opt('--port', 1), '8790', 'the first occurrence wins');
  assert.equal(opt('--host', '127.0.0.1'), '127.0.0.1');
  assert.equal(opt('--host'), undefined, 'no default means undefined, not null');
});

test('a value flag at the very end of argv reads as undefined rather than throwing', () => {
  const { opt } = argReader(['deck.html', '--port']);
  assert.equal(opt('--port', 8790), undefined,
    'the flag is present so the default does not apply — the caller sees the missing value');
});

test('opts collects every occurrence of a repeatable flag, in order', () => {
  const { opts } = argReader(['--voice', 'a', 'x', '--voice', 'b']);
  assert.deepEqual(opts('--voice'), ['a', 'b']);
  assert.deepEqual(opts('--lang'), [], 'absent means empty, not undefined');
});

// ── firstPositional ────────────────────────────────────────────────────────

test('the first positional steps over the values of the flags it is told about', () => {
  assert.equal(firstPositional(['--port', '8790', 'deck.html'], ['--port']), 'deck.html');
  assert.equal(firstPositional(['--port', '8790', 'deck.html']), '8790',
    'without the list, 8790 IS the first bare token — the list is what makes the difference');
  assert.equal(firstPositional(['--strict', 'deck.html'], ['--port']), 'deck.html', 'a boolean flag consumes nothing');
  assert.equal(firstPositional(['--port', '8790'], ['--port']), undefined, 'no positional at all');
  assert.equal(firstPositional([]), undefined);
});

test('a positional is any token not starting with a dash, whatever its extension', () => {
  // record wants to SEE a .yaml so it can say "that is a cast, not a deck"
  assert.equal(firstPositional(['talk.term.yaml']), 'talk.term.yaml');
});

// ── parsePort ──────────────────────────────────────────────────────────────

test('a port is an integer between 0 and 65535, from a string or a number', () => {
  assert.equal(parsePort('8790'), 8790);
  assert.equal(parsePort(8790), 8790);
  assert.equal(parsePort('0'), 0, '0 asks the OS for a port, which is how the tests bind');
  assert.equal(parsePort('65535'), 65535);
});

test('anything else is null, never NaN — NaN reached server.listen as a RangeError with a stack', () => {
  for (const bad of ['abc', '', '80.5', '-1', '65536', undefined, null, '8790x']) {
    assert.equal(parsePort(bad), null, `${JSON.stringify(bad)} is not a port`);
  }
});

test('the refusal names the flag and quotes what was typed', () => {
  assert.equal(badPort('--port', 'abc'), '--port wants a port number (0-65535), got "abc"');
  assert.match(badPort('--port', undefined), /got "undefined"/, 'a flag with no value says so rather than printing nothing');
});

// ── the regressions, end to end ────────────────────────────────────────────

test('present --port <n> <deck> refuses the DECK by name, not the port number', () => {
  const r = run('cli/present.mjs', ['--port', '8790', 'no-such-deck.html']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deck not found: .*no-such-deck\.html/);
  assert.doesNotMatch(r.stderr, /8790/, 'the port was read as the deck');
});

test('edit.mjs --git-mode <mode> <deck> refuses the DECK by name, not the mode', () => {
  const r = run('cli/edit.mjs', ['--git-mode', 'agent', 'no-such-deck.html']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deck not found: .*no-such-deck\.html/);
  assert.doesNotMatch(r.stderr, /found: .*agent$/m, 'the mode was read as the deck');
});

test('a typo in --port is a one-line refusal, not a RangeError with a stack', () => {
  for (const [rel, cmd] of [['cli/present.mjs', 'present'], ['cli/edit.mjs', 'author'], ['cli/review.mjs', 'review']]) {
    const r = run(rel, ['--port', 'abc', script('demo/intro.html')]);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`decklight ${cmd}: --port wants a port number`), cmd);
    assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|at Server\.listen/, `${cmd} printed a stack`);
  }
});
