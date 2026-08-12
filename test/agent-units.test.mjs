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
