// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The skill, offered up to date at startup (PRESENTING): which files count
 * as stale, that a refresh touches those and nothing else, and that the
 * question is asked once per version when the answer is no.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { staleSkills, refreshSkills, placedDecklightSkill, decklightSkillPlaces, installDecklightSkill, skillOfferDeclined, declineSkillOffer } from '../cli/skills.mjs';
import { offerSkillRefresh } from '../cli/open.mjs';
import { PKG, AGENTS_MARKER, SKILL_STAMP, agentsSection, claudeSkillMd, skillVersionOf } from '../cli/skill-content.mjs';
import { rmTemp } from './helpers.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skill-refresh-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const oldSkill = (v) => claudeSkillMd().replace(SKILL_STAMP(), v ? SKILL_STAMP(v) : '');
const oldAgents = (v) => `# Agent notes\n\n${agentsSection('.decklight/reference.md').replace(SKILL_STAMP(), v ? SKILL_STAMP(v) : '')}`;

/** A machine of its own: a project dir, and a config home per agent. */
function machine() {
  const root = mk();
  const env = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    BOB_HOME: path.join(root, 'bob-home'),
    DECKLIGHT_HOME: path.join(root, 'decklight-home'),
  };
  return { root, dir: path.join(root, 'project'), env };
}

test('staleSkills: the project skill, a marked AGENTS.md and every global home, by stamp', () => {
  const { root, dir, env } = machine();
  try {
    write(path.join(dir, '.claude/skills/decklight/SKILL.md'), oldSkill('0.3.0'));
    write(path.join(dir, 'AGENTS.md'), oldAgents(null));                       // before the stamp
    write(path.join(env.CLAUDE_CONFIG_DIR, 'skills/decklight/SKILL.md'), oldSkill('0.8.1'));
    write(path.join(env.CODEX_HOME, 'AGENTS.md'), oldAgents('0.8.0'));
    write(path.join(env.BOB_HOME, 'AGENTS.md'), '# mine\n\nnothing of decklight here\n');   // unmarked: not ours
    write(path.join(env.XDG_CONFIG_HOME, 'opencode/AGENTS.md'), oldAgents(PKG.version));    // current
    const stale = staleSkills({ dir, env });
    assert.deepEqual(
      stale.map((s) => [s.scope, s.target, s.version]),
      [['project', 'claude', '0.3.0'], ['project', 'agents', null], ['global', 'claude', '0.8.1'], ['global', 'codex', '0.8.0']],
    );
    assert.ok(stale.every((s) => path.isAbsolute(s.file) && fs.existsSync(s.file)));
  } finally { rmTemp(root); }
});

test('staleSkills: nothing installed, or everything current, is nothing to say', () => {
  const { root, dir, env } = machine();
  try {
    assert.deepEqual(staleSkills({ dir, env }), []);
    write(path.join(dir, '.claude/skills/decklight/SKILL.md'), claudeSkillMd());
    write(path.join(env.CLAUDE_CONFIG_DIR, 'skills/decklight/SKILL.md'), claudeSkillMd());
    assert.deepEqual(staleSkills({ dir, env }), []);
  } finally { rmTemp(root); }
});

test('refreshSkills brings the stale files to this version and touches nothing else', () => {
  const { root, dir, env } = machine();
  try {
    write(path.join(dir, '.claude/skills/decklight/SKILL.md'), oldSkill('0.3.0'));
    write(path.join(env.CODEX_HOME, 'AGENTS.md'), oldAgents('0.8.0') + '\nMy own notes stay.\n');
    const before = staleSkills({ dir, env });
    const written = refreshSkills(before, { dir, env });
    assert.ok(written.length >= 2, written.join('\n'));
    assert.equal(skillVersionOf(fs.readFileSync(path.join(dir, '.claude/skills/decklight/SKILL.md'), 'utf8')), PKG.version);
    assert.ok(fs.existsSync(path.join(dir, '.claude/skills/decklight/reference.md')), 'the reference follows the skill');
    const codex = fs.readFileSync(path.join(env.CODEX_HOME, 'AGENTS.md'), 'utf8');
    assert.equal(skillVersionOf(codex), PKG.version);
    assert.match(codex, /My own notes stay\./);
    assert.ok(codex.includes(AGENTS_MARKER));
    // not asked for, not written: no project AGENTS.md, no Claude global skill
    assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(!fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills/decklight/SKILL.md')));
    assert.deepEqual(staleSkills({ dir, env }), []);
  } finally { rmTemp(root); }
});

test('offerSkillRefresh: ⏎ refreshes; n is remembered for this version, and nothing current asks nothing', async () => {
  const { root, dir, env } = machine();
  try {
    const lines = [];
    const log = (l) => lines.push(l);
    // nothing stale: silent
    assert.equal((await offerSkillRefresh({ dir, env, ask: async () => 'y', log })).refreshed, false);
    assert.deepEqual(lines, []);
    // stale, and the answer is no: kept, remembered, not asked again
    write(path.join(env.CLAUDE_CONFIG_DIR, 'skills/decklight/SKILL.md'), oldSkill('0.3.0'));
    let asked = 0;
    const no = await offerSkillRefresh({ dir, env, ask: async () => { asked++; return 'n'; }, log });
    assert.equal(no.refreshed, false);
    assert.equal(asked, 1);
    assert.match(lines[0], /skill: .*SKILL\.md v0\.3\.0 — older than this install/);
    assert.match(lines[1], /kept as it is .* not asked again for/);
    assert.equal(fs.readFileSync(path.join(env.DECKLIGHT_HOME, 'skill-prompt-declined'), 'utf8').trim(), PKG.version);
    const again = await offerSkillRefresh({ dir, env, ask: async () => { asked++; return 'n'; }, log });
    assert.equal(again.declined, true);
    assert.equal(asked, 1, 'declined for this version: not asked');
    // a decline from another version does not hold
    fs.writeFileSync(path.join(env.DECKLIGHT_HOME, 'skill-prompt-declined'), '0.0.1\n');
    lines.length = 0;
    const yes = await offerSkillRefresh({ dir, env, ask: async () => '', log });   // ⏎ is yes
    assert.equal(yes.refreshed, true);
    assert.equal(skillVersionOf(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'skills/decklight/SKILL.md'), 'utf8')), PKG.version);
    assert.match(lines.join('\n'), /installed the Decklight skill \(v/);
    assert.deepEqual(staleSkills({ dir, env }), []);
  } finally { rmTemp(root); }
});

test('before an agent job: Decklight\'s skill is found where each agent reads it, installed there, and a no is kept per project and agent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skill-offer-'));
  t.after(() => rmTemp(dir));
  const project = path.join(dir, 'talk');
  fs.mkdirSync(project);
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'), DECKLIGHT_HOME: path.join(dir, 'dl') };
  for (const key of ['claude', 'codex']) assert.equal(placedDecklightSkill(key, { dir: project, env }), null, key);
  assert.deepEqual(placedDecklightSkill('gemini', { dir: project, env }), { scope: 'none', file: null }, 'no install for it: never offered');
  assert.equal(decklightSkillPlaces('codex', { dir: project, env }).global, path.join(dir, 'codex', 'AGENTS.md'));

  // an AGENTS.md without the section is not the skill
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# notes\n');
  assert.equal(placedDecklightSkill('codex', { dir: project, env }), null);
  installDecklightSkill('codex', { global: false, dir: project, env });
  assert.equal(placedDecklightSkill('codex', { dir: project, env }).scope, 'project');
  installDecklightSkill('claude', { global: true, dir: project, env });
  assert.deepEqual(placedDecklightSkill('claude', { dir: project, env }), { scope: 'global', file: path.join(dir, 'claude', 'skills', 'decklight', 'SKILL.md') });
  assert.ok(!fs.existsSync(path.join(project, '.claude')), 'every project is the config home, not this one');

  assert.equal(skillOfferDeclined('claude', { dir: project, env }), false);
  declineSkillOffer('claude', { dir: project, env });
  assert.equal(skillOfferDeclined('claude', { dir: project, env }), true);
  assert.equal(skillOfferDeclined('codex', { dir: project, env }), false, 'per agent');
  assert.equal(skillOfferDeclined('claude', { dir, env }), false, 'per project');
});
