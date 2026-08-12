// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight associate` — the macOS launcher (SPEC PRESENTING, MARKETPLACE
// DECK_FILE#ASSOC). The double-clicked path is the filename of a file someone
// *sent*, and the launcher runs before `present` checks a byte, so the one
// property worth a test is: that filename is data, never code. These tests run
// the generated launcher under `sh` against a stub `osascript` that records
// its argv and stdin and executes nothing — which is exactly the boundary the
// fix moved the filename behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { darwinFiles } from '../cli/associate.mjs';

// Every character an injection needs, in one name: `'` breaks out of a
// single-quoted shell splice, `"` breaks the AppleScript string level, `$()`
// is command substitution, `;` a separator, and the space keeps word-splitting
// honest. The touch targets tell us if any layer ever executed it.
const HOSTILE = `talk'; touch PWNED; '"$(touch PWNED2)".decklight`;

const NODE = '/usr/local/bin/node';
const CLI = '/opt/decklight/cli/decklight.mjs';

/** Write the generated launcher into `dir` and return its path. */
function launcherIn(dir, node = NODE, cli = CLI) {
  const file = darwinFiles('/Users/someone', node, cli)
    .find((f) => f.path.endsWith('Contents/MacOS/decklight'));
  const out = path.join(dir, 'launcher');
  writeFileSync(out, file.text);
  chmodSync(out, 0o755);
  return out;
}

/**
 * A PATH-first `osascript` that records instead of running: argv (one record
 * per line-separator so a newline-free filename round-trips exactly) and the
 * script it was fed on stdin.
 */
function stubOsascript(dir) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh
: > "$OSASCRIPT_SPY.argv"
for a in "$@"; do printf '%s\\n--ARG--\\n' "$a" >> "$OSASCRIPT_SPY.argv"; done
cat > "$OSASCRIPT_SPY.stdin"
`);
  chmodSync(path.join(bin, 'osascript'), 0o755);
  return bin;
}

function runLauncher(dir, args) {
  const spy = path.join(dir, 'spy');
  const r = spawnSync('sh', [launcherIn(dir), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubOsascript(dir)}:${process.env.PATH}`, OSASCRIPT_SPY: spy },
  });
  const read = (ext) => (existsSync(spy + ext) ? readFileSync(spy + ext, 'utf8') : null);
  const argvRaw = read('.argv');
  return {
    status: r.status,
    stderr: r.stderr,
    called: argvRaw !== null,
    argv: argvRaw === null ? [] : argvRaw.split('\n--ARG--\n').slice(0, -1),
    script: read('.stdin') ?? '',
  };
}

/**
 * The hostile filename this asserts about cannot EXIST on Windows: `"` is one
 * of the characters the filesystem refuses outright, so the fixture cannot be
 * created and there is nothing to escape. What it checks — AppleScript quoting
 * — only ever runs on macOS anyway.
 */
const noHostileNames = process.platform === 'win32'
  ? 'a filename containing a quote cannot exist on Windows, and osascript is macOS-only'
  : false;

test('a hostile deck filename reaches osascript as an argument, never as code', { skip: noHostileNames }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decklight-assoc-'));
  const deck = path.join(dir, HOSTILE);
  writeFileSync(deck, '<!doctype html>');

  const r = runLauncher(dir, [deck]);
  assert.equal(r.status, 0, r.stderr);

  // Nothing in the name executed at the launcher layer.
  assert.equal(existsSync(path.join(dir, 'PWNED')), false, 'the `;`-separated command ran');
  assert.equal(existsSync(path.join(dir, 'PWNED2')), false, 'the $() substitution ran');

  // The path and its directory arrive as their own argv elements, verbatim —
  // not embedded in any script text.
  assert.deepEqual(r.argv, ['-', dir, deck]);

  // And the AppleScript source contains no trace of the filename: it names
  // only argv slots, quoted by AppleScript itself at the last moment.
  assert.ok(!r.script.includes(HOSTILE), 'the filename was spliced into the AppleScript source');
  assert.match(r.script, /on run argv/);
  assert.match(r.script, /quoted form of item 1 of argv/);
  assert.match(r.script, /quoted form of item 2 of argv/);
});

test('no argument is a quiet no-op — osascript is never invoked', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decklight-assoc-'));
  const r = runLauncher(dir, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.called, false, 'osascript ran with nothing to open');
});

test('the install paths are baked as AppleScript string literals, not raw splices', () => {
  // These are ours, not an attacker's — but a home directory with a quote in
  // it must break the launcher loudly at generation time review, not quietly
  // at double-click time, so they get real escaping too.
  const node = '/Users/we"ird/no de/bin/node';
  const file = darwinFiles('/Users/we"ird', node, CLI)
    .find((f) => f.path.endsWith('Contents/MacOS/decklight'));
  assert.ok(file.text.includes(JSON.stringify(node)), 'node path is not an escaped string literal');
  assert.ok(!file.text.includes(`'${node}'`), 'node path is spliced raw into shell text');
});
