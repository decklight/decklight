// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The agent roster as an extensible thing (SPEC AGENT_UNITS, #269 / #125):
// a marketplace descriptor teaching `A` an agent decklight has never heard
// of, and a preferred agent that survives a restart.
//
// Two properties get most of the attention, because both are the kind that
// look fine until the day they are not:
//
//   A DESCRIPTOR IS NOT CODE. `decklight agent add` fetches nothing and runs
//   nothing of the catalog's — it names a binary the user installed. That is
//   what keeps an open roster out of UNIT_PINNING's risk class, so the test
//   asserts the install works with no network and no sha256 at all.
//
//   A MISSING PREFERENCE IS NEVER SUBSTITUTED. Which agent edits your deck is
//   not interchangeable; falling back to another one would be the worst
//   version of this feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENTS, agentCommand, detectAgents, installedAgents, expandArgs,
  preferredAgent, setPreferredAgent, agentUnavailable, agentConfigPath,
  shimTarget, spawnSpec, whichBin, claudeActivity,
} from '../cli/agents.mjs';
import { validateManifest, REFERENCE_ONLY, INSTALL_HINT } from '../cli/marketplace.mjs';
import { listUnits, unitPath } from '../cli/units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), `decklight-${p}-`));

const DESCRIPTOR = {
  name: 'my-agent', type: 'agent', bin: 'my-agent',
  args: ['-p', '{prompt}', '--file', '{deck}', '--yes'],
};

/** A local marketplace carrying one agent descriptor, registered into `home`. */
function agentMarket(home, entry = DESCRIPTOR) {
  const root = tmp('agent-market');
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'),
    JSON.stringify({ name: 'crew', entries: [entry] }, null, 2));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

const run = (args, home) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args],
      { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};

// ── the descriptor, and what a catalog may say ─────────────────────────────

test('an agent entry validates as a descriptor — bin plus the argv of its headless mode', () => {
  const v = validateManifest(JSON.stringify({ name: 'crew', entries: [DESCRIPTOR] }));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('an agent is REFERENCE_ONLY — it carries no source, so no code can arrive', () => {
  assert.ok(REFERENCE_ONLY.has('agent'));
  assert.match(INSTALL_HINT.agent, /decklight agent add/);
});

test('a descriptor that would hand the agent no instruction is refused', () => {
  const noPrompt = { ...DESCRIPTOR, args: ['--yes', '--file', '{deck}'] };
  const v = validateManifest(JSON.stringify({ name: 'crew', entries: [noPrompt] }));
  assert.equal(v.ok, false);
  assert.match(v.errors.find((x) => x.field === 'entries[0].args').msg, /\{prompt\}/);
});

test('bin must be a bare command — never a path or a shell line', () => {
  for (const bad of ['/usr/bin/evil', 'sh -c "rm -rf /"', 'a;b', '', 42]) {
    const v = validateManifest(JSON.stringify({ name: 'crew', entries: [{ ...DESCRIPTOR, bin: bad }] }));
    assert.equal(v.ok, false, `bin: ${JSON.stringify(bad)} should not validate`);
  }
});

test('expandArgs substitutes into argv ELEMENTS — a hostile deck name stays one argument', () => {
  const args = expandArgs(DESCRIPTOR.args, 'make it blue', 'my deck; rm -rf ~.html');
  assert.deepEqual(args, ['-p', 'make it blue', '--file', 'my deck; rm -rf ~.html', '--yes']);
  // the shell metacharacters are INSIDE one element, so spawn can never split
  // them into a command of their own
  assert.equal(args.filter((a) => a.includes('rm -rf')).length, 1);
});

// ── installing one, offline ────────────────────────────────────────────────

test('an agent installs with no network, no source and no sha256 — it is a descriptor', () => {
  const home = tmp('agent-install');
  try {
    agentMarket(home);
    const { code, out } = run(['agent', 'add', 'my-agent'], home);
    assert.equal(code, 0, out);
    assert.ok(existsSync(unitPath('agent', 'my-agent', home)));
    assert.equal(listUnits('agent', home).length, 1);

    assert.match(run(['agent', 'list'], home).out, /my-agent/);
  } finally { rmTemp(home); }
});

test('an installed agent joins the roster and builds a real spawn', () => {
  const home = tmp('agent-roster');
  try {
    agentMarket(home);
    run(['agent', 'add', 'my-agent'], home);

    const loaded = installedAgents(home);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].bin, 'my-agent');

    // detect only what the machine can run: the descriptor names a binary,
    // and a machine without it must not be offered the agent
    assert.equal(detectAgents({ hasBin: () => false, home }).length, 0);
    const roster = detectAgents({ hasBin: (b) => b === 'my-agent', home });
    assert.deepEqual(roster.map((a) => a.name), ['my-agent']);

    const cmd = agentCommand('my-agent', 'centre slide 2', 'deck.html',
      { hasBin: (b) => b === 'my-agent', home });
    assert.equal(cmd.bin, 'my-agent');
    assert.equal(cmd.args[0], '-p');
    assert.match(cmd.args[1], /centre slide 2/, 'the instruction reaches the prompt');
    assert.match(cmd.args[1], /deck\.html/, 'and the prompt names the file');
    assert.deepEqual(cmd.args.slice(2), ['--file', 'deck.html', '--yes']);
  } finally { rmTemp(home); }
});

test('a unit may not shadow a built-in, and a malformed one does not take the roster down', () => {
  const home = tmp('agent-shadow');
  try {
    // a descriptor calling itself `claude` must not change how claude is run
    agentMarket(home, { ...DESCRIPTOR, name: 'claude', bin: 'my-agent' });
    run(['agent', 'add', 'claude'], home);
    const claude = detectAgents({ hasBin: () => true, home }).find((a) => a.name === 'claude');
    assert.equal(claude.bin, 'claude', 'still the built-in');
    assert.equal(claude.label, 'Claude Code');

    // and a descriptor that is not readable is skipped, not thrown on
    mkdirSync(path.dirname(unitPath('agent', 'broken', home)), { recursive: true });
    writeFileSync(unitPath('agent', 'broken', home), '{ not json');
    writeFileSync(unitPath('agent', 'shapeless', home), '{"bin":"x"}');
    const names = detectAgents({ hasBin: () => true, home }).map((a) => a.name);
    assert.ok(names.includes('claude'), 'the built-ins survive a broken entry');
    assert.equal(names.includes('broken'), false);
    assert.equal(names.includes('shapeless'), false);
  } finally { rmTemp(home); }
});

// ── the remembered preference (#125) ───────────────────────────────────────

test('a preferred agent is remembered, and survives a restart', () => {
  const home = tmp('agent-pref');
  try {
    assert.equal(preferredAgent(home), null, 'a missing file is first-run, not an error');
    setPreferredAgent('codex', home);
    assert.match(agentConfigPath(home), /agent\.json$/);
    // read back through a fresh call — this is the "survives a restart" claim,
    // since nothing is cached in memory between them
    assert.equal(preferredAgent(home), 'codex');

    const cmd = agentCommand(undefined, 'x', 'd.html', { hasBin: () => true, home });
    assert.equal(cmd.name, 'codex', 'A reaches for the remembered one, not the first detected');

    // an explicit name still wins over the preference
    assert.equal(agentCommand('bob', 'x', 'd.html', { hasBin: () => true, home }).name, 'bob');

    setPreferredAgent(null, home);
    assert.equal(preferredAgent(home), null);
    assert.equal(agentCommand(undefined, 'x', 'd.html', { hasBin: () => true, home }).name, AGENTS[0].name);
  } finally { rmTemp(home); }
});

test('a remembered agent that is GONE is named, never silently swapped', () => {
  const home = tmp('agent-pref-missing');
  try {
    setPreferredAgent('codex', home);
    // codex is remembered but not on this machine; claude is
    const only = (b) => b === 'claude';
    assert.equal(agentCommand(undefined, 'x', 'd.html', { hasBin: only, home }), null,
      'no fallback — a different agent editing your deck is worse than none');

    const roster = detectAgents({ hasBin: only, home });
    const why = agentUnavailable('codex', roster, home);
    assert.match(why, /codex/, 'names the missing one');
    assert.match(why, /claude/, 'and what is available instead');
    assert.match(why, /not on PATH/);

    // a name nothing has ever heard of says how to teach decklight about it
    assert.match(agentUnavailable('nope', roster, home), /decklight agent add nope/);
  } finally { rmTemp(home); }
});

// ── running an npm-installed agent on Windows (#307) ───────────────────────
//
// Every agent in the roster installs from npm, and on Windows npm installs a
// JS CLI as a BATCH SHIM. Node has refused to spawn one without `shell: true`
// since CVE-2024-27980, so `A` detected the agent, offered it, and then did
// nothing — the worst of the three available outcomes.
//
// The fix is not a shell. With one, the arguments stop being arguments and
// become a command line for cmd.exe to re-split, and one of them is the user's
// prompt. So decklight resolves the shim to the script it would have run and
// spawns node on it: argv stays argv, on both platforms. These tests reach the
// Windows half from any machine, because it is precisely the branch this
// repo's CI could not execute until #305 and still cannot execute here.

const winFs = (files) => ({
  exists: (f) => Object.hasOwn(files, f),
  read: (f) => files[f],
  platform: 'win32',
  // Spelled `Path`, which is how Windows spells it — and separated by `;`,
  // which is why none of this may use the host's own path grammar.
  env: { Path: 'C:\\other;C:\\bin' },
});

// What npm actually writes to node_modules/.bin/claude.cmd, verbatim template.
const NPM_SHIM = [
  '@ECHO off', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
  + '"%_prog%"  "%dp0%\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

test('an npm shim resolves to the script it runs, not to cmd.exe', () => {
  const files = {
    'C:\\bin\\claude.cmd': NPM_SHIM,
    // where `%dp0%\..\@anthropic-ai\…` actually lands once resolved
    'C:\\@anthropic-ai\\claude-code\\cli.js': '// the agent',
  };
  const spec = spawnSpec('claude', winFs(files));
  assert.equal(spec.bin, process.execPath, 'node runs it — no shell, ever');
  assert.deepEqual(spec.prefix, ['C:\\@anthropic-ai\\claude-code\\cli.js'],
    'the .. is resolved, so the path handed to node is the real one');
});

test("the PATHEXT line in npm's own template is not mistaken for the script", () => {
  // `SET PATHEXT=%PATHEXT:;.JS;=;%` appears ABOVE the line that matters and
  // ends in `.JS`. Nothing by that name is ever on disk, which is exactly why
  // the resolver checks rather than trusts its own regex.
  assert.equal(shimTarget(NPM_SHIM, 'C:\\bin', { platform: 'win32', exists: () => false }), null);
});

test('the shim spellings all mean the same directory', () => {
  // npm writes `%dp0%\`, a hand-written wrapper writes `%~dp0`, and the POSIX
  // sibling npm installs alongside writes `$basedir/`. All three name the
  // folder the shim is in.
  const exists = (f) => f === 'C:\\bin\\agent.mjs';
  for (const text of [
    '@"%~dp0node.exe" "%~dp0agent.mjs" %*',
    '"%_prog%"  "%dp0%\\agent.mjs" %*',
    '"$basedir/node"  "$basedir/agent.mjs" "$@"',
  ]) {
    assert.equal(shimTarget(text, 'C:\\bin', { platform: 'win32', exists }),
      'C:\\bin\\agent.mjs', text);
  }
});

test('a .cmd that is a real batch program is NOT offered as an agent', () => {
  // Detected-but-unrunnable is the state #307 is about. Reporting it as
  // available is what made it a bug rather than a gap, so the roster drops it.
  const opts = winFs({ 'C:\\bin\\claude.cmd': '@echo off\r\ncall :something\r\n' });
  assert.equal(spawnSpec('claude', opts), null);
  assert.equal(whichBin('claude', opts.env, 'win32', opts.exists), 'C:\\bin\\claude.cmd',
    'it IS on PATH — detection was never the broken half');
});

test('an agent found but unrunnable says so, naming the file and the refusal', () => {
  const home = tmp('agent-unrunnable');
  try {
    const why = agentUnavailable('claude', [], home, {
      env: { Path: 'C:\\bin' }, platform: 'win32', spec: () => null,
      exists: (f) => f === 'C:\\bin\\claude.cmd',
    });
    assert.match(why, /claude/);
    assert.match(why, /cmd\.exe/, 'and why decklight will not simply use a shell');
    assert.doesNotMatch(why, /not on PATH/,
      'telling someone their agent is not on PATH while `where claude` prints one is how this stayed invisible');
  } finally { rmTemp(home); }
});

test('a .exe agent is spawned by its resolved path, with nothing in front of it', () => {
  const spec = spawnSpec('codex', winFs({ 'C:\\bin\\codex.exe': 'MZ' }));
  assert.deepEqual(spec, { bin: 'C:\\bin\\codex.exe', prefix: [] });
});

test('POSIX is untouched: the bare name, no prefix, no shell', () => {
  const spec = spawnSpec('claude', {
    platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => true,
    read: () => { throw new Error('a POSIX spawn must not read the binary'); },
  });
  assert.deepEqual(spec, { bin: 'claude', prefix: [] });
});

test('a hostile prompt reaches the agent as ONE argument, verbatim, on both platforms', () => {
  // The reason a shell is out of the question. `%PATH%` is the sharp one:
  // cmd.exe expands it BEFORE any quoting the caller could apply, so there is
  // no escaping that makes this safe — only not doing it.
  const nasty = 'add a slide " & calc | echo ^ %PATH% $(id) `id` \'x\'';
  const home = tmp('agent-argv');
  try {
    for (const platform of ['linux', 'win32']) {
      const cmd = agentCommand('claude', nasty, 'deck.html', {
        hasBin: () => true,
        home,
        spec: () => (platform === 'win32'
          ? { bin: process.execPath, prefix: ['C:\\bin\\cli.js'] }
          : { bin: 'claude', prefix: [] }),
      });
      const carrying = cmd.args.filter((a) => a.includes(nasty));
      assert.equal(carrying.length, 1, `${platform}: exactly one argument carries the prompt`);
      assert.ok(carrying[0].endsWith(nasty), `${platform}: verbatim, nothing escaped away`);
      assert.equal(cmd.shell, undefined, `${platform}: there is no shell to quote for`);
      assert.ok(!cmd.args.some((a) => /^\/[cC]$/.test(a)), `${platform}: nothing is being handed to cmd.exe`);
    }
  } finally { rmTemp(home); }
});

test('the Windows spawn is node + the script + the agent\'s own argv, in that order', () => {
  const home = tmp('agent-winargv');
  try {
    const cmd = agentCommand('claude', 'centre slide 2', 'deck.html', {
      hasBin: () => true,
      home,
      spec: () => ({ bin: process.execPath, prefix: ['C:\\bin\\cli.js'] }),
    });
    assert.equal(cmd.bin, process.execPath);
    assert.equal(cmd.args[0], 'C:\\bin\\cli.js');
    assert.equal(cmd.args[1], '-p', "the agent's own flags follow, unchanged");
    assert.match(cmd.args[2], /centre slide 2/);
    assert.deepEqual(cmd.args.slice(3),
      ['--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'],
      'acceptEdits plus the stream that narrates the run');
    assert.equal(cmd.name, 'claude');
  } finally { rmTemp(home); }
});

test('claude\'s stream narrates the run — each tool call becomes a clue', () => {
  const line = (o) => JSON.stringify(o);
  const tool = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.deepEqual(claudeActivity(tool('Edit', { file_path: '/x/y/talk.html' })), { activity: 'editing talk.html' });
  assert.deepEqual(claudeActivity(tool('Read', { file_path: 'SPEC.md' })), { activity: 'reading SPEC.md' });
  assert.deepEqual(claudeActivity(tool('Bash', { command: 'npm test -- --grep slide' })),
    { activity: 'running: npm test -- --grep slide' });
  assert.deepEqual(claudeActivity(tool('Grep', { pattern: 'data-build' })), { activity: 'searching for data-build' });
  assert.deepEqual(claudeActivity(tool('WebSearch', { query: 'x' })), { activity: 'WebSearch…' });
  // the final answer is the done-toast's text — never the raw JSON wall
  assert.deepEqual(claudeActivity(line({ type: 'result', result: 'Removed the bullet.' })),
    { result: 'Removed the bullet.' });
  // system chatter, plain text blocks, and garbage are silence, not errors
  assert.equal(claudeActivity(line({ type: 'system', subtype: 'init' })), null);
  assert.equal(claudeActivity(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hm' }] } })), null);
  assert.equal(claudeActivity('not json at all'), null);
  assert.equal(claudeActivity(''), null);
});
