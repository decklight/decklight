// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The `decklight` dispatcher: global help, routing, exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

// `rec` needs node-pty (native) + js-yaml, both optional deps; skip the one
// recording test when they're absent (e.g. CI installs with --omit=optional).
const require = createRequire(import.meta.url);
let recSkip = false;
try { require.resolve('node-pty'); require.resolve('js-yaml'); }
catch { recSkip = 'node-pty/js-yaml not installed (optional deps)'; }

test('global help lists all subcommands with runnable examples', () => {
  const out = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  for (const sub of ['init', 'skills', 'rec', 'refresh', 'export', 'bundle', 'publish']) {
    assert.match(out, new RegExp(`^  ${sub} `, 'm'), `missing subcommand: ${sub}`);
  }
  assert.equal((out.match(/EXAMPLE:/g) || []).length >= 5, true, 'one example per subcommand');
});

test('help <sub> shows the subcommand help', () => {
  const out = execFileSync('node', [CLI, 'help', 'bundle'], { encoding: 'utf8' });
  assert.match(out, /decklight bundle <deck\.html>/);
  const rec = execFileSync('node', [CLI, 'help', 'rec'], { encoding: 'utf8' });
  assert.match(rec, /decklight rec <script\.term\.yaml>/);
});

test('unknown subcommand exits 1 with the global help', () => {
  const r = spawnSync('node', [CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "frobnicate"/);
  assert.match(r.stdout, /Commands:/);
});

test('a tiny rec runs through the dispatcher end-to-end', { skip: recSkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-cli-'));
  const yamlPath = path.join(dir, 'tiny.term.yaml');
  fs.writeFileSync(yamlPath, 'steps:\n  - cmd: echo dispatcher-ok\n');
  execFileSync('node', [CLI, 'rec', yamlPath, '--quiet'], { encoding: 'utf8' });
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'tiny.cast.json'), 'utf8'));
  assert.equal(cast.decklightCast, 1);
  assert.equal(cast.steps[0].cmd, 'echo dispatcher-ok');
  assert.match(cast.steps[0].output.map((o) => o[1]).join(''), /dispatcher-ok/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init scaffolds a self-contained deck and the agent skill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  const out = execFileSync('node', [CLI, 'init', 'Test Deck', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /created .*deck\.html/);
  assert.match(out, /SKILL\.md,reference\.md/);
  assert.match(out, /created AGENTS\.md/);

  const deck = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  assert.match(deck, /<title>Test Deck<\/title>/);
  assert.match(deck, /<div class="decklight">/);
  assert.match(deck, /<section>/);
  assert.match(deck, /aside class="notes"/);
  // fully self-contained: no link/src referencing an external file
  assert.doesNotMatch(deck, /<link\b[^>]*rel=["']stylesheet["']/);
  assert.doesNotMatch(deck, /<script\b[^>]*\bsrc=/);

  // ships every theme by default, aurora active — the in-deck picker is stocked
  const themeCount = fs.readdirSync(path.resolve(here, '../themes')).filter((f) => f.endsWith('.css')).length;
  const blocks = [...deck.matchAll(/<style data-theme="([\w-]+)"( media="not all")?>/g)];
  assert.equal(blocks.length, themeCount);
  assert.deepEqual(blocks.filter((m) => !m[2]).map((m) => m[1]), ['aurora']);

  const skillDir = path.join(dir, '.claude', 'skills', 'decklight');
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: decklight\n/);
  assert.match(skill, /reference\.md/);
  const reference = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
  assert.match(reference, /## 1\. Deck anatomy/);
  assert.match(reference, /## 9\. Public JS API/);
  assert.doesNotMatch(reference, /## 10\. Repository layout/);

  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /decklight:skill/);
  assert.match(agents, /\.claude\/skills\/decklight\/reference\.md/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('init refuses to overwrite an existing deck without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  const r = spawnSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists.*--force/);
  execFileSync('node', [CLI, 'init', 'Renamed', '--dir', dir, '--force'], { encoding: 'utf8' });
  assert.match(fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'), /<title>Renamed<\/title>/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init --themes ships only the named set; missing theme fails cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  // pick a real non-aurora theme so we exercise "first listed is active"
  const other = fs.readdirSync(path.resolve(here, '../themes'))
    .filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)).find((n) => n !== 'aurora');
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill', '--themes', `${other},aurora`], { encoding: 'utf8' });
  const deck = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  const blocks = [...deck.matchAll(/<style data-theme="([\w-]+)"( media="not all")?>/g)];
  assert.deepEqual(blocks.map((m) => m[1]), [other, 'aurora']);
  // aurora stays active even when not listed first
  assert.deepEqual(blocks.filter((m) => !m[2]).map((m) => m[1]), ['aurora']);

  const bad = spawnSync('node', [CLI, 'init', '--dir', dir, '--no-skill', '--force', '--themes', 'nope123'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /theme not found: nope123/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init --no-skill writes only the deck', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill'], { encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(dir, 'deck.html')), true);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init appends a marked section to an existing AGENTS.md, and refresh is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nExisting notes.\n');
  execFileSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  const first = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(first, /Existing notes\./);
  assert.match(first, /decklight:skill/);

  execFileSync('node', [CLI, 'init', '--dir', dir, '--force'], { encoding: 'utf8' });
  const second = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(first, second, 're-running must not duplicate or drift the marked section');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- decklight skills --------------------------------------------------------

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skills-'));

test('skills claude writes only the Claude skill, no AGENTS.md', () => {
  const dir = mkdir();
  const out = execFileSync('node', [CLI, 'skills', 'claude', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /for Claude Code/);
  const skillDir = path.join(dir, '.claude', 'skills', 'decklight');
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: decklight\n/);
  const reference = fs.readFileSync(path.join(skillDir, 'reference.md'), 'utf8');
  assert.match(reference, /## 1\. Deck anatomy/);
  assert.match(reference, /## 9\. Public JS API/);
  assert.doesNotMatch(reference, /## 10\. Repository layout/);
  // claude-only: no AGENTS.md and no standalone reference copy
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '.decklight')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skills for AGENTS.md agents writes the shared reference + a marked section', () => {
  const dir = mkdir();
  const out = execFileSync('node', [CLI, 'skills', 'codex', 'opencode', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /OpenAI Codex, OpenCode/);
  // no Claude target → the reference stands alone under .decklight/
  const reference = fs.readFileSync(path.join(dir, '.decklight', 'reference.md'), 'utf8');
  assert.match(reference, /## 1\. Deck anatomy/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /decklight:skill/);
  assert.match(agents, /\.decklight\/reference\.md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skills claude + an AGENTS.md agent keeps one reference, pointed at the skill copy', () => {
  const dir = mkdir();
  execFileSync('node', [CLI, 'skills', 'claude', 'bob', '--dir', dir], { encoding: 'utf8' });
  // Claude present → the skill dir copy is canonical; no duplicate under .decklight/
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills', 'decklight', 'reference.md')), true);
  assert.equal(fs.existsSync(path.join(dir, '.decklight')), false);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\.claude\/skills\/decklight\/reference\.md/);
  assert.doesNotMatch(agents, /\.decklight\/reference\.md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skills --all installs every supported agent', () => {
  const dir = mkdir();
  const out = execFileSync('node', [CLI, 'skills', '--all', '--dir', dir], { encoding: 'utf8' });
  for (const label of ['Claude Code', 'OpenAI Codex', 'OpenCode', 'IBM Bob']) {
    assert.match(out, new RegExp(label));
  }
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skills refuses an existing skill file without --force, overwrites with it', () => {
  const dir = mkdir();
  execFileSync('node', [CLI, 'skills', 'claude', '--dir', dir], { encoding: 'utf8' });
  const skillFile = path.join(dir, '.claude', 'skills', 'decklight', 'SKILL.md');
  fs.writeFileSync(skillFile, 'stale');
  const r = spawnSync('node', [CLI, 'skills', 'claude', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists.*--force/);
  execFileSync('node', [CLI, 'skills', 'claude', '--dir', dir, '--force'], { encoding: 'utf8' });
  assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: decklight\n/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skills re-run is idempotent — the AGENTS.md section never duplicates', () => {
  const dir = mkdir();
  execFileSync('node', [CLI, 'skills', 'codex', '--dir', dir], { encoding: 'utf8' });
  const first = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  execFileSync('node', [CLI, 'skills', 'codex', '--dir', dir, '--force'], { encoding: 'utf8' });
  const second = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(first, second, 're-running must not duplicate or drift the marked section');
  fs.rmSync(dir, { recursive: true, force: true });
});

// a HOME the agents' global config dirs derive from, with any inherited
// per-agent overrides cleared so the run resolves under this HOME alone
const fakeHomeEnv = (home) => {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME; delete env.BOB_HOME;
  return env;
};

test('skills --global installs into each agent config home, not the project', () => {
  const home = mkdir();
  const cwd = mkdir();
  const out = execFileSync(process.execPath, [CLI, 'skills', '--all', '--global'], { encoding: 'utf8', cwd, env: fakeHomeEnv(home) });
  assert.match(out, /globally for/);
  // Claude → a real skill under ~/.claude; the AGENTS.md agents → their own homes
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.bob', 'AGENTS.md')), true);
  const codexRef = fs.readFileSync(path.join(home, '.codex', '.decklight', 'reference.md'), 'utf8');
  assert.match(codexRef, /## 1\. Deck anatomy/);
  // global must not scribble in the working directory
  assert.equal(fs.existsSync(path.join(cwd, '.claude')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'AGENTS.md')), false);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('skills --global for one agent touches only that agent home', () => {
  const home = mkdir();
  execFileSync(process.execPath, [CLI, 'skills', 'claude', '--global'], { encoding: 'utf8', cwd: mkdir(), env: fakeHomeEnv(home) });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
  assert.equal(fs.existsSync(path.join(home, '.bob')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('skills --global and --dir are mutually exclusive', () => {
  const r = spawnSync('node', [CLI, 'skills', 'claude', '--global', '--dir', '.'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--global and --dir are mutually exclusive/);
});

test('skills rejects an unknown agent, and errors when none is detected', () => {
  const dir = mkdir();
  const bad = spawnSync('node', [CLI, 'skills', 'frobnicate', '--dir', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown agent: frobnicate/);
  // no agent named and a PATH with none of the agents on it → nothing
  // detected, clean failure (no guess). node itself is launched by its
  // absolute path, so the empty PATH only starves the agent probe.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-emptypath-'));
  const none = spawnSync(process.execPath, [CLI, 'skills', '--dir', dir], { encoding: 'utf8', env: { ...process.env, PATH: empty } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no supported agent detected/);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
