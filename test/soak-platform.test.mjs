// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The soak's platform decisions, checked from whatever machine is running —
// which is the point. `npm run soak` itself cannot be imported (it is a script
// that runs on import) and its Windows branches cannot be executed here at all,
// so this suite is the only thing standing between "written for Windows" and
// "written and never looked at", the state tools/chrome.mjs was in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliCommand, npmCommand, gitFileUrl, narrator, narrateArgs, unverifiedPlatform,
} from './soak-platform.mjs';

test('the installed CLI is the .cmd shim on Windows, and needs a shell', () => {
  // npm writes decklight, decklight.cmd and decklight.ps1 there; the
  // extensionless one is a shell script Windows itself will not execute.
  const win = cliCommand('C:\\p', 'win32');
  assert.equal(win.bin, 'C:\\p\\node_modules\\.bin\\decklight.cmd',
    'a Windows answer, spelled in backslashes — whatever host is asking');
  assert.equal(win.shell, true, 'Node refuses to spawn a .cmd without a shell (CVE-2024-27980)');

  const nix = cliCommand('/p', 'darwin');
  assert.equal(nix.bin, '/p/node_modules/.bin/decklight',
    'a POSIX answer, spelled in POSIX — whatever host is asking');
  assert.equal(nix.shell, false, 'a shell on POSIX would only add a quoting hazard');
});

test('npm is npm.cmd on Windows, for the same reason', () => {
  assert.deepEqual(npmCommand('win32'), { bin: 'npm.cmd', shell: true });
  assert.deepEqual(npmCommand('linux'), { bin: 'npm', shell: false });
});

test('a local marketplace becomes a git URL that git can actually clone', () => {
  // `file://${dir}` is wrong on Windows twice: a drive letter needs a third
  // slash, and a backslash is not a URL separator.
  const url = gitFileUrl(process.cwd());
  assert.match(url, /^file:\/\/\//);
  assert.ok(!url.includes('\\'), `a backslash survived into ${url}`);
});

test('the space this soak insists on is encoded, not passed raw', () => {
  // Every path in the soak carries a space on purpose (#275). A raw one in a
  // URL is a different bug from the one being tested.
  const url = gitFileUrl(process.platform === 'win32' ? 'C:\\decklight soak x' : '/tmp/decklight soak x');
  assert.ok(url.includes('%20'), `the space is not encoded in ${url}`);
  assert.ok(!/ /.test(url), `a raw space survived into ${url}`);
});

test('each platform narrates with what it ships, or does not narrate', () => {
  assert.equal(narrator('darwin').kind, 'say');
  assert.equal(narrator('win32').kind, 'sapi');
  assert.equal(narrator('linux'), null, 'no offline synthesiser to assume — the leg skips');
});

test('the Windows narration goes through PowerShell, because SAPI has no CLI', () => {
  const [bin, args] = narrateArgs('win32', 'C:\\out\\slide.wav', 'hello');
  assert.equal(bin, 'powershell.exe');
  assert.ok(args.includes('-NoProfile'), 'a slow user profile must not hang the step');
  const script = args.at(-1);
  assert.match(script, /System\.Speech/);
  assert.match(script, /SetOutputToWaveFile\('C:\\out\\slide\.wav'\)/);
  assert.match(script, /Speak\('hello'\)/);
  assert.match(script, /Dispose\(\)/, 'the synthesiser releases the file, or the encode reads a lock');
});

test("a quote in the text cannot end PowerShell's string", () => {
  const script = narrateArgs('win32', "C:\\it's\\out.wav", "it's narrated").at(1).at(-1);
  assert.match(script, /Speak\('it''s narrated'\)/);
  assert.match(script, /SetOutputToWaveFile\('C:\\it''s\\out\.wav'\)/);
});

test('macOS narration is one call, to a file it names', () => {
  assert.deepEqual(narrateArgs('darwin', '/tmp/a.aiff', 'hi'), ['say', ['-o', '/tmp/a.aiff', 'hi']]);
});

test('Windows is flagged as written-but-never-run', () => {
  // The soak prints this. Windows support here has been unit-tested and never
  // executed; claiming otherwise in a green run would be the worst outcome.
  assert.equal(unverifiedPlatform('win32'), true);
  assert.equal(unverifiedPlatform('darwin'), false);
  assert.equal(unverifiedPlatform('linux'), false);
});
