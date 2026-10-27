// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The model decklight's agent runs on (#918): remembered per agent beside the
// preferred one, overridden per run, passed as the agent's own model flag, and
// never at all when nothing is set, so the user's own default still applies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rmTemp, tmp } from './helpers.mjs';

import {
  AGENTS, agentAsk, agentCommand, agentConfigPath, agentModel, applyModelFlags, installedAgents,
  preferredAgent, rememberedModels, setAgentModel, setPreferredAgent, takesModel, MODEL_ENV,
} from '../cli/agents.mjs';
import { unitPath } from '../cli/units.mjs';
import { agentChipText } from '../src/core/devmode.js';

// an empty PATH and no override: what the shell exports must not leak in
const ENV = { PATH: '' };
const all = () => true;
const tail = (cmd, n = 2) => cmd.args.slice(-n);

test('nothing set: no model flag, the agent opens on its own default exactly as before', () => {
  const home = tmp('agent-model-none');
  try {
    const cmd = agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: ENV });
    assert.ok(!cmd.args.includes('--model'));
    assert.equal(cmd.model, null);
    const ask = agentAsk('claude', 'x', { hasBin: all, home, env: ENV });
    assert.deepEqual(ask.args, ['-p', 'x'], 'an ask is the same argv it always was');
    assert.equal(agentModel('claude', { home, env: ENV }).source, null);
  } finally { rmTemp(home); }
});

test('a remembered model is passed as that agent\'s own flag, and only that agent\'s', () => {
  const home = tmp('agent-model-saved');
  try {
    setAgentModel('claude', 'sonnet', { home });
    setAgentModel('codex', 'gpt-5-codex', { home });
    const claude = agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: ENV });
    assert.deepEqual(tail(claude), ['--model', 'sonnet']);
    assert.equal(claude.model, 'sonnet');
    assert.deepEqual(tail(agentCommand('codex', 'x', 'd.html', { hasBin: all, home, env: ENV })), ['-m', 'gpt-5-codex']);
    assert.ok(!agentCommand('gemini', 'x', 'd.html', { hasBin: all, home, env: ENV }).args.includes('-m'),
      'a model is per agent: gemini was never given one');
    // an ask with no model of its own runs on the edit's
    assert.deepEqual(agentAsk('claude', 'x', { hasBin: all, home, env: ENV }).args, ['-p', 'x', '--model', 'sonnet']);
    setAgentModel('claude', null, { home });
    assert.equal(rememberedModels('claude', home).edit, null, 'null forgets it');
  } finally { rmTemp(home); }
});

test('the model and the preferred agent share agent.json without clobbering each other', () => {
  const home = tmp('agent-model-file');
  try {
    setPreferredAgent('claude', home);
    setAgentModel('claude', 'sonnet', { home });
    setPreferredAgent('codex', home);
    assert.equal(rememberedModels('claude', home).edit, 'sonnet', 'choosing an agent keeps the models');
    assert.equal(preferredAgent(home), 'codex', 'choosing a model keeps the agent');
    assert.deepEqual(JSON.parse(readFileSync(agentConfigPath(home), 'utf8')),
      { preferred: 'codex', models: { claude: 'sonnet' } });
  } finally { rmTemp(home); }
});

test('this run beats the remembered one, and an ask can have its own', () => {
  const home = tmp('agent-model-run');
  try {
    setAgentModel('claude', 'opus', { home });
    setAgentModel('claude', 'sonnet', { task: 'ask', home });
    // remembered: opus for edits, sonnet for questions
    assert.deepEqual(tail(agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: ENV })), ['--model', 'opus']);
    assert.deepEqual(tail(agentAsk('claude', 'x', { hasBin: all, home, env: ENV })), ['--model', 'sonnet']);
    // --agent-model haiku for this run: both kinds, the demo's commit subject included
    const run = { ...ENV, [MODEL_ENV.edit]: 'haiku' };
    assert.deepEqual(tail(agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: run })), ['--model', 'haiku']);
    assert.deepEqual(tail(agentAsk('claude', 'x', { hasBin: all, home, env: run })), ['--model', 'haiku']);
    assert.deepEqual(agentModel('claude', { task: 'ask', home, env: run }), { model: 'haiku', source: 'run' });
    // --agent-ask-model alone moves only the questions
    const asks = { ...ENV, [MODEL_ENV.ask]: 'haiku' };
    assert.deepEqual(tail(agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: asks })), ['--model', 'opus']);
    assert.deepEqual(tail(agentAsk('claude', 'x', { hasBin: all, home, env: asks })), ['--model', 'haiku']);
    // and an explicit model given to the call wins over all of it
    assert.deepEqual(tail(agentCommand('claude', 'x', 'd.html', { hasBin: all, home, env: run, model: 'sonnet' })), ['--model', 'sonnet']);
  } finally { rmTemp(home); }
});

test('--agent-model and --agent-ask-model land in the env every spawn reads', () => {
  const env = {};
  const flags = { '--agent-model': ' sonnet ', '--agent-ask-model': 'haiku' };
  applyModelFlags((f) => flags[f], env);
  assert.deepEqual(env, { [MODEL_ENV.edit]: 'sonnet', [MODEL_ENV.ask]: 'haiku' });
  const none = {};
  applyModelFlags(() => undefined, none);
  assert.deepEqual(none, {}, 'no flag sets nothing');
});

test('an agent with no model flag says it could not take one, rather than ignoring it', () => {
  const home = tmp('agent-model-unsupported');
  try {
    setAgentModel('goose', 'gpt-5', { home });
    const goose = AGENTS.find((a) => a.name === 'goose');
    assert.equal(takesModel(goose), false);
    const cmd = agentCommand('goose', 'x', 'd.html', { hasBin: all, home, env: ENV });
    assert.equal(cmd.model, null);
    assert.equal(cmd.modelUnsupported, 'gpt-5');
    assert.deepEqual(cmd.args.slice(0, 2), ['run', '-t']);
    assert.ok(!cmd.args.includes('gpt-5'), 'a CLI that has no flag for it is not handed one');
  } finally { rmTemp(home); }
});

test('every built-in agent says how its CLI takes a model, or that it takes none', () => {
  for (const a of AGENTS) {
    assert.ok(a.model === null || typeof a.model === 'function', `${a.name} declares its model flag`);
    if (a.model) assert.equal(a.model('m').at(-1), 'm', `${a.name}: the id is the flag's value`);
  }
});

test('an installed agent takes a model when its descriptor has a template for one', () => {
  const home = tmp('agent-model-unit');
  try {
    const file = unitPath('agent', 'mine', home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ bin: 'mine', args: ['{prompt}'], model: ['--llm={model}'] }));
    const [mine] = installedAgents(home);
    assert.ok(mine, 'the unit is read');
    assert.deepEqual(mine.model('big'), ['--llm=big']);
  } finally { rmTemp(home); }
});

test('the chip names the agent and the model it runs on', () => {
  const now = 1_000_000;
  assert.equal(agentChipText({ agent: 'claude', label: 'Claude Code', model: 'sonnet', startedAt: now - 5_000 }, now),
    'Claude Code · sonnet · 0:05');
  assert.equal(agentChipText({ agent: 'claude', label: 'Claude Code', startedAt: now - 5_000 }, now),
    'Claude Code · 0:05', 'its own default: no model named');
});
