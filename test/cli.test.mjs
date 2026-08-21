// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The `decklight` dispatcher: global help, routing, exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveTitle, planGit, planSkill, initRepo, epilogue, openCommand, openDeck } from '../cli/init.mjs';
import { createRepo, inGitRepo, STARTER_GITIGNORE } from '../cli/edit.mjs';
import { deckHistory, restoreDeck } from '../cli/restore.mjs';
import * as restoreMod from '../cli/restore.mjs';
import { packSkill } from '../cli/skills.mjs';
import { zipSync, crc32 } from '../cli/zip.mjs';
import { claudeSkillMd, referenceDoc, reportBugSkillMd, agentsSection } from '../cli/skill-content.mjs';
import { probe, environmentBlock, issuesUrl } from '../cli/report-bug.mjs';
// `rec` needs node-pty (native) + js-yaml, both optional deps; skip the one
// recording test when they're absent (e.g. CI installs with --omit=optional).
import { optionalDepSkip as recSkip, childEnv, homeEnv, rmTemp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

test('global help lists all subcommands with runnable examples', () => {
  const out = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  for (const sub of ['init', 'skills', 'cast', 'record', 'refresh', 'export', 'bundle', 'upgrade', 'publish', 'marketplace', 'video']) {
    assert.match(out, new RegExp(`^  ${sub} `, 'm'), `missing subcommand: ${sub}`);
  }
  assert.equal((out.match(/EXAMPLE:/g) || []).length >= 5, true, 'one example per subcommand');
});

test('help <sub> shows the subcommand help', () => {
  const out = execFileSync('node', [CLI, 'help', 'bundle'], { encoding: 'utf8' });
  assert.match(out, /decklight bundle <deck\.html>/);
  const cast = execFileSync('node', [CLI, 'help', 'cast'], { encoding: 'utf8' });
  assert.match(cast, /decklight cast <script\.term\.yaml>/);
});

test('`rec` is gone — no alias, no stub, and the two recorders name each other', () => {
  // `rec` was renamed to `cast` because `decklight record` (the author's voice)
  // made a three-letter abbreviation of "record" mean the other recorder. It
  // was dropped outright rather than aliased or stubbed: an alias would have
  // kept a name that quietly means the opposite of what its reader assumes,
  // and a refusal stub is a migration aid for users decklight does not have
  // yet. What survives is the help, which is where someone who typed `rec`
  // now finds both answers.
  const r = spawnSync('node', [CLI, 'rec', 'demo.term.yaml'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "rec"/);
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.doesNotMatch(help, /^ {2}rec {2}/m);
  // Each recorder says what the OTHER one records. This is the whole
  // disambiguation now, so it is the thing worth pinning: the names alone
  // cannot carry it, and nothing else says it.
  assert.match(help, /^ {2}cast .*\n.*decklight record records your VOICE/m);
  assert.match(help, /^ {2}record .*\n(?:.*\n)*?.*decklight cast records a terminal/m);
});

test('unknown subcommand exits 1 with the global help', () => {
  const r = spawnSync('node', [CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "frobnicate"/);
  assert.match(r.stdout, /Commands:/);
});

test('a tiny cast runs through the dispatcher end-to-end', { skip: recSkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-cli-'));
  const yamlPath = path.join(dir, 'tiny.term.yaml');
  fs.writeFileSync(yamlPath, 'steps:\n  - cmd: echo dispatcher-ok\n');
  execFileSync('node', [CLI, 'cast', yamlPath, '--quiet'], { encoding: 'utf8' });
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'tiny.cast.json'), 'utf8'));
  assert.equal(cast.decklightCast, 1);
  assert.equal(cast.steps[0].cmd, 'echo dispatcher-ok');
  assert.match(cast.steps[0].output.map((o) => o[1]).join(''), /dispatcher-ok/);
  rmTemp(dir);
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
  assert.match(reference, /## DECK_ANATOMY/);
  assert.match(reference, /## JS_API/);
  assert.doesNotMatch(reference, /## REPO_LAYOUT/);

  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /decklight:skill/);
  assert.match(agents, /\.claude\/skills\/decklight\/reference\.md/);

  rmTemp(dir);
});

test('init title: an argument skips the prompt, a TTY asks, headless never does', async () => {
  const neverAsk = async () => { throw new Error('prompted when it must not'); };
  // a title argument wins outright — even on a TTY
  assert.equal(await resolveTitle('Q3 Review', { isTTY: true, ask: neverAsk }), 'Q3 Review');
  // no argument, no TTY → the default, silently
  assert.equal(await resolveTitle(null, { isTTY: false, ask: neverAsk }), 'My Deck');
  // no argument, TTY → exactly one question; the answer wins
  let question;
  const answered = await resolveTitle(null, { isTTY: true, ask: async (q) => { question = q; return 'Ship & Tell'; } });
  assert.equal(answered, 'Ship & Tell');
  assert.equal(question, 'deck title [My Deck]: ');
  // an empty (or blank) answer keeps the default
  assert.equal(await resolveTitle(null, { isTTY: true, ask: async () => '  ' }), 'My Deck');
});

test('init HTML-escapes the title where it lands (<title> and the h1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', 'Q3 <Review> & "Friends"', '--dir', dir, '--no-skill'], { encoding: 'utf8' });
  const deck = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  // Quotes escape too, since the shared escape (tools/escape.mjs) is the one
  // that is correct in an attribute as well — `&quot;` renders as `"` in text,
  // so this is the same title, spelled so that the same function stays safe
  // when a title eventually lands in `title="…"`. It used to leave them raw,
  // under the comment "a prompt invites &, < and quotes".
  assert.match(deck, /<title>Q3 &lt;Review&gt; &amp; &quot;Friends&quot;<\/title>/);
  assert.match(deck, /<h1>Q3 &lt;Review&gt; &amp; &quot;Friends&quot;<\/h1>/);
  rmTemp(dir);
});

test('init without a title never prompts when stdio is not a TTY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  const r = spawnSync('node', [CLI, 'init', '--dir', dir, '--no-skill'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /deck title/);
  assert.match(fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'), /<title>My Deck<\/title>/);
  rmTemp(dir);
});

// script(1) lends the run a real pty, so this covers the actual isTTY gate +
// readline wiring — the pure-function test above covers the decision table.
const ptySkip = process.platform === 'linux' && fs.existsSync('/usr/bin/script')
  ? false : 'needs util-linux script(1)';
test('init on a real TTY prompts and takes the typed title', { skip: ptySkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  // three answers typed ahead: the title, "n" to the git offer, "n" to the
  // dev handoff — one readline serves all three, so none of them is dropped
  const r = spawnSync('/usr/bin/script',
    ['-qec', `node "${CLI}" init --dir "${dir}" --no-skill`, '/dev/null'],
    { encoding: 'utf8', input: 'Ship & Tell\nn\nn\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /deck title \[My Deck\]:/);
  assert.match(fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'), /<title>Ship &amp; Tell<\/title>/);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false, '"n" declines the repo');
  rmTemp(dir);
});

// what the collision message compares: the version inlined in dist (the deck's
// runtime) against the installed package version
const runtimeVersion = /^export const version = '([^']+)';$/m
  .exec(fs.readFileSync(path.resolve(here, '../src/index.js'), 'utf8'))[1];
const pkgVersion = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;

test('the runtime version and the package version are the same number', () => {
  // These drifted silently: src/index.js sat at 0.1.0 while package.json reached
  // 0.3.0, so every bundled deck carried a banner two releases stale — and the
  // banner is not decoration. `decklight init` quotes it back when it refuses a
  // collision, `upgrade` locates the runtime by it, and since PRESENT#AUDIT the
  // ingredients label prints it to whoever opens a deck they did not author. A
  // stamped version nobody checks is read as a fact, which is what makes a wrong
  // one worse than none.
  //
  // build.mjs refuses to build on a mismatch; this asserts the same thing in
  // `npm test`, where it costs nothing and fails in one line rather than
  // wherever a stale banner happens to surface.
  assert.equal(runtimeVersion, pkgVersion,
    'set src/index.js\'s exported version to package.json\'s — a release bumps both');
});

test('init refusal on a decklight deck leads with upgrade, names both versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  const r = spawnSync('node', [CLI, 'init'], { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deck\.html is already a decklight deck/);
  assert.match(r.stderr, new RegExp(`deck has runtime ${runtimeVersion.replace(/\./g, '\\.')}, installed is ${pkgVersion.replace(/\./g, '\\.')}`));
  // upgrade (keeps slides) is the lead suggestion; --force (destroys them) comes second
  const upgradeAt = r.stderr.indexOf('decklight upgrade deck.html');
  const forceAt = r.stderr.indexOf('--force');
  assert.ok(upgradeAt >= 0, 'suggests decklight upgrade <file>');
  assert.ok(forceAt > upgradeAt, '--force is mentioned after upgrade');
  assert.match(r.stderr, /--force to replace it with a fresh starter deck/);
  execFileSync('node', [CLI, 'init', 'Renamed', '--dir', dir, '--force'], { encoding: 'utf8' });
  assert.match(fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'), /<title>Renamed<\/title>/);
  rmTemp(dir);
});

test('init refusal on a deck of unknown runtime version still suggests upgrade, versionless', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  const deck = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'deck.html'), deck.replace(/\/\*! Decklight v[^*]*\*\//, ''));
  const r = spawnSync('node', [CLI, 'init'], { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is already a decklight deck\n/, 'no version parenthetical');
  assert.doesNotMatch(r.stderr, /deck has runtime/);
  assert.match(r.stderr, /decklight upgrade deck\.html/);
  rmTemp(dir);
});

test('init refusal on a non-decklight file keeps the plain --force message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  fs.writeFileSync(path.join(dir, 'deck.html'), '<!doctype html><html><body><h1>Not a deck</h1></body></html>\n');
  const r = spawnSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists — pass --force to overwrite/);
  assert.doesNotMatch(r.stderr, /upgrade/);
  rmTemp(dir);
});

test('deckRuntimeVersion: version for a scaffold, null when mangled, undefined for a non-deck', async () => {
  const { deckRuntimeVersion } = await import('../cli/init.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill', '--themes', 'aurora'], { encoding: 'utf8' });
  const scaffold = fs.readFileSync(path.join(dir, 'deck.html'), 'utf8');
  rmTemp(dir);
  assert.equal(deckRuntimeVersion(scaffold), runtimeVersion);

  // hand-mangled: still a deck (stage div + init call intact), banner gone
  const mangled = scaffold.replace(/\/\*! Decklight v[^*]*\*\//, '');
  assert.equal(deckRuntimeVersion(mangled), null);

  assert.equal(deckRuntimeVersion('<!doctype html><html><body><h1>Hello</h1></body></html>'), undefined);
  // one marker without the other is not a deck
  assert.equal(deckRuntimeVersion('<div class="decklight"></div>'), undefined);
  assert.equal(deckRuntimeVersion('<script>Decklight.init({})</script>'), undefined);
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
  rmTemp(dir);
});

test('init --no-skill writes only the deck', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-'));
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill'], { encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(dir, 'deck.html')), true);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  rmTemp(dir);
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
  rmTemp(dir);
});

// --- init: git offer + epilogue (issue #50), starter .gitignore (#53) --------

// a git identity supplied via env, so `init --git` can commit in a bare tmp dir
// (CI runners have no user.name/user.email configured)
const gitIdEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
};

test('planGit: the --git/--no-git/TTY/repo decision table', () => {
  // flags decide non-interactively, and --no-git wins over --git
  assert.deepEqual(planGit({ args: ['--git'] }), { action: 'create' });
  assert.deepEqual(planGit({ args: ['--git'], tty: true }), { action: 'create' });
  assert.deepEqual(planGit({ args: ['--no-git'], tty: true }), { action: 'skip' });
  assert.deepEqual(planGit({ args: ['--git', '--no-git'] }), { action: 'skip' });
  // already inside a repo: nothing to create, nothing to ask
  assert.deepEqual(planGit({ args: [], tty: true, inRepo: true }), { action: 'skip' });
  assert.deepEqual(planGit({ args: ['--git'], inRepo: true }), { action: 'skip' });
  // no repo, no flag: a TTY is asked, headless gets the one-line hint
  assert.deepEqual(planGit({ args: [], tty: true }), { action: 'ask' });
  assert.deepEqual(planGit({ args: [] }), { action: 'hint' });
});

test('initRepo: goes through the createRepo seam, reports each failure in one line, never throws', () => {
  const fake = (fails, stderr = '') => (cmd, a) => {
    if (fails.includes(a[0])) { const e = new Error(`git ${a[0]} failed`); e.stderr = stderr; throw e; }
    return '';
  };
  const seam = { exec: fake([]), mkRepo: () => true };
  // the .gitignore fact is surfaced: seeded vs left alone
  assert.match(initRepo('/x', seam), /repository created \(with a starter \.gitignore\), everything committed/);
  assert.match(initRepo('/x', { ...seam, mkRepo: () => false }), /repository created, everything committed/);
  assert.match(initRepo('/x', { ...seam, mkRepo: () => { throw new Error('git init failed'); } }), /git: init failed/);
  assert.match(initRepo('/x', { exec: fake(['commit'], 'Please tell me who you are.'), mkRepo: () => true }), /no identity configured.*staged/);
  assert.match(initRepo('/x', { exec: fake(['commit'], 'disk full'), mkRepo: () => true }), /git: commit failed.*staged/);
  assert.match(initRepo('/x', { exec: fake(['add']), mkRepo: () => true }), /git: add failed/);
});

test('epilogue: plain when piped, accent + OSC 8 on a TTY, NO_COLOR wins', () => {
  const deckPath = path.join(os.tmpdir(), 'epi', 'deck.html');
  const url = pathToFileURL(deckPath).href;

  const plain = epilogue({ deckPath, tty: false, noColor: false });
  assert.ok(plain.includes(url), 'raw file:// URL present');
  assert.ok(plain.includes('decklight author '), 'the way to start editing');
  assert.doesNotMatch(plain, /\x1b/, 'piped output has zero escape codes');

  const colored = epilogue({ deckPath, tty: true, noColor: false });
  assert.match(colored, /\x1b\[36m/, 'accent color on a TTY');
  assert.ok(colored.includes(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`),
    'OSC 8 link wraps the raw URL (the URL stays the visible text)');

  const noColor = epilogue({ deckPath, tty: true, noColor: true });
  assert.doesNotMatch(noColor, /\x1b/, 'NO_COLOR disables every escape code');
  assert.ok(noColor.includes(url));
});

test('init --git creates a repo whose first commit carries everything + the starter .gitignore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const out = execFileSync('node', [CLI, 'init', 'Repo Deck', '--dir', dir, '--git'],
    { encoding: 'utf8', env: gitIdEnv });
  assert.match(out, /git: repository created \(with a starter \.gitignore\), everything committed/);
  const show = execFileSync('git', ['-C', dir, 'show', '--format=%s%n%b', '--name-only', 'HEAD'],
    { encoding: 'utf8', env: gitIdEnv });
  assert.match(show, /^decklight init\n/);
  assert.doesNotMatch(show, /Signed-off-by/, 'the DCO is this repo\'s, not the player\'s');
  for (const f of ['deck.html', 'AGENTS.md', '.gitignore', '.claude/skills/decklight/SKILL.md', '.claude/skills/decklight/reference.md']) {
    assert.ok(show.includes(f), `commit includes ${f}`);
  }
  // the seeded file is the shared starter — #53's contract, wired into init
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), STARTER_GITIGNORE);
  rmTemp(dir);
});

test('init --git never clobbers an existing .gitignore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const theirs = '# the player wrote this\nnode_modules/\n';
  fs.writeFileSync(path.join(dir, '.gitignore'), theirs);
  const out = execFileSync('node', [CLI, 'init', '--dir', dir, '--git', '--no-skill'],
    { encoding: 'utf8', env: gitIdEnv });
  assert.match(out, /git: repository created, everything committed/, 'no starter parenthetical');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), theirs,
    'byte-identical — no appending, no merging');
  rmTemp(dir);
});

test('init headless without a flag prints the authoring hint and touches no git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const out = execFileSync('node', [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /git: no repository here — pass --git to create one and auto-commit the deck/);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  // the epilogue is present, plain — piped output carries zero escape codes
  assert.ok(out.includes(pathToFileURL(path.join(dir, 'deck.html')).href));
  assert.match(out, /decklight author /);
  assert.doesNotMatch(out, /\x1b/);
  rmTemp(dir);
});

test('init --no-git skips silently; an existing repo is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const out = execFileSync('node', [CLI, 'init', '--dir', dir, '--no-git'], { encoding: 'utf8' });
  assert.doesNotMatch(out, /git:/, 'no nagging after an explicit no');
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  execFileSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  const out2 = execFileSync('node', [CLI, 'init', '--dir', repo], { encoding: 'utf8' });
  assert.doesNotMatch(out2, /git:/, 'inside a work tree there is nothing to offer');
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(status, /\?\? deck\.html/, 'init never commits into a pre-existing repo');
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false,
    'a repository decklight didn\'t create never gets a .gitignore');
  rmTemp(dir);
  rmTemp(repo);
});

test('init --git still succeeds when git is missing from PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-emptypath-'));
  const r = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--git'],
    { encoding: 'utf8', env: { ...process.env, PATH: empty } });
  assert.equal(r.status, 0, 'the deck is the product — a git problem is not a failure');
  assert.equal(fs.existsSync(path.join(dir, 'deck.html')), true);
  assert.match(r.stdout, /git: init failed/);
  assert.match(r.stdout, /decklight author /, 'the epilogue still prints');
  rmTemp(dir);
  rmTemp(empty);
});

test('init on a real TTY asks the git question; Y creates the repo and commits', { skip: ptySkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-init-git-'));
  const r = spawnSync('/usr/bin/script',
    ['-qec', `node "${CLI}" init "Repo Talk" --dir "${dir}" --no-skill`, '/dev/null'],
    { encoding: 'utf8', input: 'y\n', env: gitIdEnv });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /create a git repository so your edits are auto-committed\? \[Y\/n\]/);
  // init prints the command instead of asking, or starting anything
  assert.doesNotMatch(r.stdout, /start editing now\?/);
  assert.match(r.stdout, /decklight author /, 'the command that starts editing is printed');
  assert.match(r.stdout, /\x1b\[36m/, 'the epilogue is accent-colored on a TTY');
  const log = execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8', env: gitIdEnv });
  assert.equal(log.trim(), 'decklight init');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), STARTER_GITIGNORE);
  rmTemp(dir);
});

test('init --help documents --git/--no-git/--open', () => {
  const out = execFileSync('node', [CLI, 'init', '--help'], { encoding: 'utf8' });
  assert.match(out, /--git\b/);
  assert.match(out, /--no-git\b/);
  assert.match(out, /--open\s+open the scaffolded deck in your default browser/);
});

// --- decklight init --open (issue #52) ----------------------------------------

test('openCommand maps each platform to its stock launcher', () => {
  const url = 'file:///tmp/deck.html';
  assert.deepEqual(openCommand('darwin', url), { cmd: 'open', args: [url] });
  assert.deepEqual(openCommand('win32', url), { cmd: 'cmd', args: ['/c', 'start', '', url] });
  assert.deepEqual(openCommand('linux', url), { cmd: 'xdg-open', args: [url] });
  assert.deepEqual(openCommand('freebsd', url), { cmd: 'xdg-open', args: [url] });
});

// a spawn stand-in that never launches anything: records the call, hands back
// an EventEmitter posing as the child, and reports the given fate
const fakeSpawn = (calls, fate = 'spawn') => (cmd, args, opts) => {
  const child = new EventEmitter();
  child.unref = () => { child.unrefed = true; };
  calls.push({ cmd, args, opts, child });
  queueMicrotask(() => child.emit(fate, fate === 'error' ? Object.assign(new Error('nope'), { code: 'ENOENT' }) : undefined));
  return child;
};
const sink = () => ({ text: '', isTTY: false, write(s) { this.text += s; } });

test('openDeck spawns the launcher detached on the deck file URL and unrefs it', async () => {
  const calls = [];
  const out = sink();
  await openDeck('/tmp/spaced dir/deck.html', { platform: 'linux', spawnFn: fakeSpawn(calls), out });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'xdg-open');
  assert.deepEqual(calls[0].args, [pathToFileURL('/tmp/spaced dir/deck.html').href]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[0].child.unrefed, true, 'must unref so init exits promptly');
  assert.match(out.text, /opening .*deck\.html in your default browser/);
});

test('openDeck survives a missing launcher: one line naming it, no throw', async () => {
  const out = sink();
  await openDeck('/tmp/deck.html', { platform: 'linux', spawnFn: fakeSpawn([], 'error'), out });
  assert.match(out.text, /--open: could not launch a browser \(xdg-open: ENOENT\)/);
});

test('init --open launches the platform launcher on the deck actually written', { skip: process.platform !== 'linux' && 'exercises the xdg-open path' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-open-'));
  // a PATH holding ONLY a logging xdg-open, so the test never opens a browser
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-open-bin-'));
  const log = path.join(bin, 'log');
  fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > "${log}"\n`, { mode: 0o755 });

  // no --open, no launch — ever
  execFileSync(process.execPath, [CLI, 'init', '--dir', dir, '--no-skill'], { encoding: 'utf8', env: { ...process.env, PATH: bin } });
  await delay(150);
  assert.equal(fs.existsSync(log), false, 'init without --open must not launch anything');

  const out = execFileSync(process.execPath,
    [CLI, 'init', '--open', '--dir', dir, '-o', 'talk.html', '--no-skill'],
    { encoding: 'utf8', env: { ...process.env, PATH: bin } });
  assert.match(out, /created .*talk\.html/);
  assert.match(out, /opening .*talk\.html in your default browser/);
  // the launch is detached — give the logging script a beat to land
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(log) && Date.now() < deadline) await delay(25);
  assert.equal(fs.readFileSync(log, 'utf8'), pathToFileURL(path.join(dir, 'talk.html')).href,
    '--open must honor -o and --dir: it opens the deck that was written');

  rmTemp(bin);
  rmTemp(dir);
});

test('init --open with no launcher on PATH: deck still created, exit 0, skip line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-open-'));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-open-empty-'));
  const r = spawnSync(process.execPath, [CLI, 'init', '--open', '--dir', dir, '--no-skill'],
    { encoding: 'utf8', env: { ...process.env, PATH: emptyBin } });
  assert.equal(r.status, 0, 'a failed launch is non-fatal — the deck was created');
  assert.match(r.stdout, /created .*deck\.html/);
  assert.match(r.stdout, /--open: could not launch a browser/);
  assert.equal(fs.existsSync(path.join(dir, 'deck.html')), true);
  rmTemp(emptyBin);
  rmTemp(dir);
});

// --- the repo-creation seam (author --git today; init's git offer, #50) ----

test('createRepo seeds a fresh repository with the starter .gitignore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-gitignore-'));
  assert.equal(createRepo(dir), true, 'reports that it wrote the starter file');
  assert.equal(inGitRepo(dir), true, 'the repository exists');

  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(ignore, STARTER_GITIGNORE);
  assert.match(ignore, /^\.shots\/$/m, 'screenshot evidence dirs are ignored');
  assert.match(ignore, /^\.DS_Store$/m, 'OS junk is ignored');
  // voiceover/ carries its tradeoff comment DIRECTLY above the entry — the
  // file itself must tell the player narration audio is bulky but cloud
  // voices cost money to regenerate, and that deleting the line versions it
  assert.match(ignore, /^# .*costs money to regenerate.*\nvoiceover\/$/m);
  assert.match(ignore, /delete this line/);
  rmTemp(dir);
});

test('the starter entries really ignore the artifacts — git add -A stays clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-gitignore-'));
  createRepo(dir);
  fs.writeFileSync(path.join(dir, 'deck.html'), '<!doctype html>');
  fs.mkdirSync(path.join(dir, '.shots'));
  fs.writeFileSync(path.join(dir, '.shots', 'evidence.png'), 'png');
  fs.mkdirSync(path.join(dir, 'voiceover'));
  fs.writeFileSync(path.join(dir, 'voiceover', 'slide-01.m4a'), 'audio');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');

  execFileSync('git', ['add', '-A'], { cwd: dir });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' })
    .trim().split('\n').sort();
  assert.deepEqual(staged, ['.gitignore', 'deck.html'],
    'a hasty git add -A picks up the deck and the ignore file, none of the artifacts');
  rmTemp(dir);
});

test('createRepo never touches an existing .gitignore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-gitignore-'));
  const theirs = '# the player wrote this\nnode_modules/\n';
  fs.writeFileSync(path.join(dir, '.gitignore'), theirs);
  assert.equal(createRepo(dir), false, 'reports that it left the file alone');
  assert.equal(inGitRepo(dir), true, 'the repository is still created');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), theirs,
    'byte-identical — no appending, no merging');
  rmTemp(dir);
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
  assert.match(reference, /## DECK_ANATOMY/);
  assert.match(reference, /## JS_API/);
  assert.doesNotMatch(reference, /## REPO_LAYOUT/);
  // claude-only: no AGENTS.md and no standalone reference copy
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '.decklight')), false);
  rmTemp(dir);
});

test('skills for AGENTS.md agents writes the shared reference + a marked section', () => {
  const dir = mkdir();
  const out = execFileSync('node', [CLI, 'skills', 'codex', 'opencode', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /OpenAI Codex, OpenCode/);
  // no Claude target → the reference stands alone under .decklight/
  const reference = fs.readFileSync(path.join(dir, '.decklight', 'reference.md'), 'utf8');
  assert.match(reference, /## DECK_ANATOMY/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /decklight:skill/);
  assert.match(agents, /\.decklight\/reference\.md/);
  rmTemp(dir);
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
  rmTemp(dir);
});

test('skills --all installs every supported agent', () => {
  const dir = mkdir();
  const out = execFileSync('node', [CLI, 'skills', '--all', '--dir', dir], { encoding: 'utf8' });
  for (const label of ['Claude Code', 'OpenAI Codex', 'OpenCode', 'IBM Bob']) {
    assert.match(out, new RegExp(label));
  }
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), true);
  rmTemp(dir);
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
  rmTemp(dir);
});

test('skills re-run is idempotent — the AGENTS.md section never duplicates', () => {
  const dir = mkdir();
  execFileSync('node', [CLI, 'skills', 'codex', '--dir', dir], { encoding: 'utf8' });
  const first = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  execFileSync('node', [CLI, 'skills', 'codex', '--dir', dir, '--force'], { encoding: 'utf8' });
  const second = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(first, second, 're-running must not duplicate or drift the marked section');
  rmTemp(dir);
});

// a HOME the agents' global config dirs derive from, with any inherited
// per-agent overrides cleared so the run resolves under this HOME alone.
// homeEnv sets USERPROFILE beside HOME: os.homedir() reads the first on POSIX
// and the second on Windows, so setting only HOME redirected nothing there —
// the run wrote into the real user profile while asserting about a temp one.
const fakeHomeEnv = (home) => {
  const env = childEnv(homeEnv(home));
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
  assert.match(codexRef, /## DECK_ANATOMY/);
  // global must not scribble in the working directory
  assert.equal(fs.existsSync(path.join(cwd, '.claude')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'AGENTS.md')), false);
  rmTemp(home);
  rmTemp(cwd);
});

test('skills --global for one agent touches only that agent home', () => {
  const home = mkdir();
  execFileSync(process.execPath, [CLI, 'skills', 'claude', '--global'], { encoding: 'utf8', cwd: mkdir(), env: fakeHomeEnv(home) });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
  assert.equal(fs.existsSync(path.join(home, '.bob')), false);
  rmTemp(home);
});

test('skills --global and --dir are mutually exclusive', () => {
  const r = spawnSync('node', [CLI, 'skills', 'claude', '--global', '--dir', '.'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--global and --dir are mutually exclusive/);
});

// --- init: the skill-scope question (issue #75) -------------------------------

// a PATH with nothing on it: detection finds no agent, and node itself is
// always launched by its absolute path so only the probe is starved
const emptyPath = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-emptypath-'));

test('planSkill: the --no-skill/--global-skill/TTY decision table', () => {
  // headless keeps today's project install; a terminal is asked
  assert.deepEqual(planSkill({ args: [] }), { action: 'project' });
  assert.deepEqual(planSkill({ args: [], tty: true }), { action: 'ask' });
  // either flag answers for the user — no question on a TTY
  assert.deepEqual(planSkill({ args: ['--global-skill'] }), { action: 'global' });
  assert.deepEqual(planSkill({ args: ['--global-skill'], tty: true }), { action: 'global' });
  assert.deepEqual(planSkill({ args: ['--no-skill'], tty: true }), { action: 'skip' });
});

test('init --help documents the skill-scope question and --global-skill', () => {
  const out = execFileSync('node', [CLI, 'init', '--help'], { encoding: 'utf8' });
  assert.match(out, /--global-skill/);
  assert.match(out, /where should the\s+skill go\? \[P\/g\]/);
  assert.match(out, /skills --global/);
});

test('init --no-skill with --global-skill is an error', () => {
  const r = spawnSync('node', [CLI, 'init', '--no-skill', '--global-skill'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--no-skill and --global-skill are mutually exclusive/);
});

test('init without a TTY never asks the skill question — the project install is untouched', () => {
  const dir = mkdir();
  const r = spawnSync('node', [CLI, 'init', 'Quiet Deck', '--dir', dir], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /where should the skill go/);
  assert.doesNotMatch(r.stdout + r.stderr, /agent skill teaches/, 'no scope explanation either — output is byte-identical to before');
  assert.match(r.stdout, /wrote \.claude\/skills\/decklight\/\{SKILL\.md,reference\.md\}/);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /decklight:skill/);
  rmTemp(dir);
});

test('init --global-skill with no agent on PATH falls back to Claude Code; the project stays skill-free', () => {
  const home = mkdir(); const dir = mkdir(); const empty = emptyPath();
  const r = spawnSync(process.execPath, [CLI, 'init', 'Global Deck', '--dir', dir, '--global-skill'],
    { encoding: 'utf8', input: '', env: { ...fakeHomeEnv(home), PATH: empty } });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /where should the skill go/, 'the flag suppresses the question');
  assert.doesNotMatch(r.stdout, /detected on PATH/, 'nothing was detected — no lie about it');
  assert.match(r.stdout, /installed the Decklight skill \(v[\d.]+\) globally for Claude Code/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'reference.md')), true);
  // the deck is scaffolded as always; NOTHING skill-shaped lands in the project
  assert.equal(fs.existsSync(path.join(dir, 'deck.html')), true);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  for (const d of [home, dir, empty]) rmTemp(d);
});

test('init --global-skill targets the PATH-detected agents, like bare `decklight skills`', () => {
  const home = mkdir(); const dir = mkdir();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-skillbin-'));
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--global-skill'],
    { encoding: 'utf8', input: '', env: { ...fakeHomeEnv(home), PATH: bin } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /detected on PATH: OpenAI Codex/);
  assert.match(r.stdout, /globally for OpenAI Codex/);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex', '.decklight', 'reference.md')), true);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'undetected agents are not targeted');
  for (const d of [home, dir, bin]) rmTemp(d);
});

test('init --global-skill refreshes an existing global skill without demanding --force', () => {
  const home = mkdir(); const empty = emptyPath();
  const env = { ...fakeHomeEnv(home), PATH: empty };
  const dirs = [mkdir(), mkdir()];
  execFileSync(process.execPath, [CLI, 'init', '--dir', dirs[0], '--global-skill'], { encoding: 'utf8', env });
  const skillFile = path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md');
  fs.writeFileSync(skillFile, 'stale');
  // a fresh project, the same global answer: init's refresh semantics, not skills' clobber guard
  const out = execFileSync(process.execPath, [CLI, 'init', '--dir', dirs[1], '--global-skill'], { encoding: 'utf8', env });
  assert.match(out, /globally for Claude Code/);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: decklight\n/, 'the stale copy was refreshed');
  for (const d of [home, empty, ...dirs]) rmTemp(d);
});

test('init on a real TTY asks the skill scope, naming both paths; g installs globally', { skip: ptySkip }, () => {
  const home = mkdir(); const dir = mkdir(); const empty = emptyPath();
  const r = spawnSync('/usr/bin/script',
    ['-qec', `"${process.execPath}" "${CLI}" init "Global Talk" --dir "${dir}"`, '/dev/null'],
    { encoding: 'utf8', input: 'g\nn\nn\n', env: { ...fakeHomeEnv(home), PATH: empty, SHELL: '/bin/sh' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /where should the skill go\? \[P\/g\]/);
  assert.match(r.stdout, /\.claude\/skills\/decklight/, 'the project path is named');
  assert.match(r.stdout, /~\/\.claude — every project/, 'the global path is named');
  assert.match(r.stdout, /globally for Claude Code/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  for (const d of [home, dir, empty]) rmTemp(d);
});

test('init on a real TTY: Enter keeps the project install, byte-for-byte', { skip: ptySkip }, () => {
  const home = mkdir(); const dir = mkdir(); const empty = emptyPath();
  const r = spawnSync('/usr/bin/script',
    ['-qec', `"${process.execPath}" "${CLI}" init "Local Talk" --dir "${dir}"`, '/dev/null'],
    { encoding: 'utf8', input: '\nn\nn\n', env: { ...fakeHomeEnv(home), PATH: empty, SHELL: '/bin/sh' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /where should the skill go\? \[P\/g\]/);
  assert.match(r.stdout, /wrote \.claude\/skills\/decklight\/\{SKILL\.md,reference\.md\}/);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'skills', 'decklight', 'SKILL.md')), true);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /decklight:skill/);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'Enter never installs globally');
  for (const d of [home, dir, empty]) rmTemp(d);
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
  rmTemp(empty);
  rmTemp(dir);
});

// ── decklight restore (#127): a deck's durable history ─────────────────────

const restoreRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-restore-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '.']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'Test']);
  const deck = path.join(dir, 'deck.html');
  for (const v of ['one', 'two', 'three']) {
    fs.writeFileSync(deck, `<p>${v}</p>\n`);
    g(['add', '-A']);
    g(['commit', '-qm', v]);
  }
  return { dir, deck, g };
};

test('deckHistory parses git log rows, newest first', () => {
  // the git invoker is injected, so no repo is needed to test the parsing
  // `full` rides along because marking a commit as unpushed means comparing it
  // against `rev-list`'s output, and %h's abbreviation length is a repository
  // setting the two commands need not agree on.
  const fake = () => [
    'a1b2c3d\x012 hours ago\x01third\x01a1b2c3d4444444444444444444444444444444',
    'ffff000\x013 days ago\x01first\x01ffff000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ].join('\n');
  const rows = deckHistory('/x/deck.html', '/x', fake);
  assert.deepEqual(rows, [
    { hash: 'a1b2c3d', when: '2 hours ago', subject: 'third', full: 'a1b2c3d4444444444444444444444444444444' },
    { hash: 'ffff000', when: '3 days ago', subject: 'first', full: 'ffff000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ]);
});

test('deckHistory: a subject containing the separator cannot corrupt the row', () => {
  // \x01 is unreachable from a real commit message, which is the point of it
  const fake = () => 'a1b2c3d\x01now\x01fix: a · b — c\x01a1b2c3dfull';
  assert.deepEqual(deckHistory('/x/d.html', '/x', fake), [
    { hash: 'a1b2c3d', when: 'now', subject: 'fix: a · b — c', full: 'a1b2c3dfull' },
  ]);
});

test('deckHistory: a file git has never seen has no history', () => {
  assert.deepEqual(deckHistory('/x/deck.html', '/x', () => ''), []);
});

test('restore rides ON TOP — the version you left is still reachable', (t) => {
  const { dir, deck, g } = restoreRepo();
  t.after(() => rmTemp(dir));

  const before = g(['log', '--oneline']).trim().split('\n').length;
  const first = g(['log', '--format=%h', '--reverse']).trim().split('\n')[0];

  const res = restoreDeck(deck, first, dir);
  assert.equal(res.changed, true);
  assert.equal(fs.readFileSync(deck, 'utf8'), '<p>one</p>\n');

  const after = g(['log', '--oneline']).trim().split('\n');
  assert.equal(after.length, before + 1, 'a new commit, not a rewrite');
  assert.match(after[0], /decklight: restore/);
  // and the version we navigated away from is still in the history
  assert.equal(g(['show', 'HEAD~1:./deck.html']), '<p>three</p>\n');
});

test('restore never silently discards uncommitted work', (t) => {
  const { dir, deck, g } = restoreRepo();
  t.after(() => rmTemp(dir));

  fs.writeFileSync(deck, '<p>UNSAVED</p>\n');
  const first = g(['log', '--format=%h', '--reverse']).trim().split('\n')[0];

  const res = restoreDeck(deck, first, dir);
  assert.equal(res.savedFirst, true);
  assert.equal(fs.readFileSync(deck, 'utf8'), '<p>one</p>\n');
  // the unsaved edit was committed on the way past, so it is recoverable
  assert.equal(g(['show', 'HEAD~1:./deck.html']), '<p>UNSAVED</p>\n');
});

test('restore preserves the file byte for byte, trailing newline included', (t) => {
  const { dir, deck, g } = restoreRepo();
  t.after(() => rmTemp(dir));

  const exact = '<p>trailing</p>\n\n\n';
  fs.writeFileSync(deck, exact);
  g(['commit', '-qam', 'exact']);
  fs.writeFileSync(deck, '<p>later</p>\n');
  g(['commit', '-qam', 'later']);

  restoreDeck(deck, g(['rev-parse', '--short', 'HEAD~1']).trim(), dir);
  assert.equal(fs.readFileSync(deck, 'utf8'), exact, 'whitespace is content');
});

test('an unknown ref fails before anything is written', (t) => {
  const { dir, deck } = restoreRepo();
  t.after(() => rmTemp(dir));

  const before = fs.readFileSync(deck, 'utf8');
  assert.throws(() => restoreDeck(deck, 'nosuchref', dir));
  assert.equal(fs.readFileSync(deck, 'utf8'), before, 'no partial write');
});

test('restoring where the deck already is changes nothing', (t) => {
  const { dir, deck, g } = restoreRepo();
  t.after(() => rmTemp(dir));

  const n = g(['log', '--oneline']).trim().split('\n').length;
  const res = restoreDeck(deck, 'HEAD', dir);
  assert.equal(res.changed, false);
  assert.equal(g(['log', '--oneline']).trim().split('\n').length, n, 'no empty commit');
});

test('the CLI lists history and refuses a deck with none', (t) => {
  const { dir, deck } = restoreRepo();
  t.after(() => rmTemp(dir));

  const list = spawnSync(process.execPath, [CLI, 'restore', deck], { encoding: 'utf8' });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /3 commits, newest first/);
  assert.match(list.stdout, /three/);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-norepo-'));
  t.after(() => rmTemp(plain));
  fs.writeFileSync(path.join(plain, 'deck.html'), 'x');
  const no = spawnSync(process.execPath, [CLI, 'restore', path.join(plain, 'deck.html')], { encoding: 'utf8' });
  assert.equal(no.status, 1);
  assert.match(no.stderr, /not in a git repository/);
});

test('decklight help lists restore', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /^\s+restore\s+list the commits/m);
});

test('withBaseHref survives decks that have no head — head is optional in HTML', () => {
  const { withBaseHref } = restoreMod;
  // the normal case
  assert.match(withBaseHref('<html><head><title>x</title></head><body>b</body></html>'),
    /<head><base href="\/">/);
  // no head at all — still needs a base, or the preview loads no runtime
  assert.match(withBaseHref('<html><body>b</body></html>'), /<html><head><base href="\/"><\/head>/);
  // no html element either
  assert.match(withBaseHref('<div class="decklight"></div>'), /^<base href="\/">/);
  // an author's own base is theirs, not ours to override
  const own = '<html><head><base href="https://cdn.example/"></head></html>';
  assert.equal(withBaseHref(own), own);
});

// ── decklight skills --pack (#80): the account-level artifact ──────────────

test('--pack writes a real archive holding exactly the two skill files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-pack-'));
  t.after(() => rmTemp(dir));

  const res = spawnSync(process.execPath, [CLI, 'skills', 'claude', '--pack'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status ?? 0, 0, res.stderr);
  const zipPath = path.join(dir, 'decklight-skill.zip');
  assert.ok(fs.existsSync(zipPath), 'wrote decklight-skill.zip');

  // the output teaches both routes, so the command explains its own story
  assert.match(res.stdout, /commit \.claude\/skills\/decklight\//);
  assert.match(res.stdout, /claude\.ai skill settings/);

  // a standard archive: real unzip reads it, and the bytes round-trip
  const list = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  if (list.error) return; // no unzip on this machine — the byte checks below still run
  assert.match(list.stdout, /decklight\/SKILL\.md/);
  assert.match(list.stdout, /decklight\/reference\.md/);

  const out = path.join(dir, 'x');
  assert.equal(spawnSync('unzip', ['-q', zipPath, '-d', out]).status, 0);
  // byte-identical to what a project install writes — one source, no drift
  assert.equal(fs.readFileSync(path.join(out, 'decklight/SKILL.md'), 'utf8'), claudeSkillMd('reference.md'));
  assert.equal(fs.readFileSync(path.join(out, 'decklight/reference.md'), 'utf8'), referenceDoc());
});

test('--pack honors -o, and refuses to clobber without --force', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-pack-'));
  t.after(() => rmTemp(dir));

  const named = spawnSync(process.execPath, [CLI, 'skills', 'claude', '--pack', '-o', 'mine.zip'], { cwd: dir, encoding: 'utf8' });
  assert.equal(named.status ?? 0, 0, named.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'mine.zip')));

  const again = spawnSync(process.execPath, [CLI, 'skills', 'claude', '--pack', '-o', 'mine.zip'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr + again.stdout, /already exists — pass --force/);

  const forced = spawnSync(process.execPath, [CLI, 'skills', 'claude', '--pack', '-o', 'mine.zip', '--force'], { cwd: dir, encoding: 'utf8' });
  assert.equal(forced.status ?? 0, 0, forced.stderr);
});

test('--pack rejects the flag combinations that would quietly do nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-pack-'));
  t.after(() => rmTemp(dir));

  const bad = [
    [['skills', 'claude', '--pack', '--global'], /--global/],
    [['skills', 'claude', '--pack', '--dir', '.'], /--dir/],
    [['skills', '--pack', '--all'], /--all/],
    [['skills', 'codex', '--pack'], /Claude's skill format only/],
  ];
  for (const [argv, re] of bad) {
    const res = spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(res.status, 0, argv.join(' '));
    assert.match(res.stderr + res.stdout, re, argv.join(' '));
    assert.equal(fs.existsSync(path.join(dir, 'decklight-skill.zip')), false, 'nothing written on a rejected combination');
  }
});

test('the packed archive is byte-stable — the same content packs the same', () => {
  assert.equal(Buffer.compare(packSkill(), packSkill()), 0);
});

test('zipSync round-trips through a real unzip, and stores what deflate would grow', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-zip-'));
  t.after(() => rmTemp(dir));

  // the canonical CRC-32 check value — the one number the whole format hangs on
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);

  const zipPath = path.join(dir, 'z.zip');
  const long = 'repeat me '.repeat(200);
  fs.writeFileSync(zipPath, zipSync([{ name: 'a/big.txt', data: long }, { name: 'a/tiny.txt', data: 'x' }]));

  const test = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  if (test.error) return; // no unzip here
  assert.equal(test.status, 0, test.stdout);
  assert.match(test.stdout, /No errors detected/);

  const out = path.join(dir, 'x');
  spawnSync('unzip', ['-q', zipPath, '-d', out]);
  assert.equal(fs.readFileSync(path.join(out, 'a/big.txt'), 'utf8'), long);
  assert.equal(fs.readFileSync(path.join(out, 'a/tiny.txt'), 'utf8'), 'x');
});

// ── decklight report-bug (#73) ─────────────────────────────────────────────

test('the environment block carries every fact a triager asks for first', () => {
  const facts = probe({
    platform: 'darwin', release: '24.1.0', arch: 'arm64',
    node: 'v20.11.0', chrome: '/Applications/Chrome.app/chrome', pty: true,
    version: '9.9.9',
  });
  const block = environmentBlock(facts);
  assert.match(block, /^## Environment$/m);
  assert.match(block, /- decklight: 9\.9\.9/);
  assert.match(block, /- node: v20\.11\.0/);
  assert.match(block, /- os: darwin 24\.1\.0 \(arm64\)/);
  assert.match(block, /- headless Chrome: yes \(\/Applications\/Chrome\.app\/chrome\)/);
  assert.match(block, /- node-pty: installed/);
});

test('a machine missing the optional pieces says so, rather than omitting them', () => {
  const block = environmentBlock(probe({ chrome: null, pty: false }));
  assert.match(block, /- headless Chrome: not found/);
  assert.match(block, /- node-pty: not installed/);
});

test('the issues URL comes from package.json, not a second copy of it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.equal(issuesUrl(), typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url);
  // both shapes of the npm field are legal
  assert.equal(issuesUrl({ bugs: { url: 'https://example.test/i' } }), 'https://example.test/i');
});

test('report-bug prints and exits — it files nothing and says so', () => {
  const res = spawnSync(process.execPath, [CLI, 'report-bug'], { encoding: 'utf8' });
  assert.equal(res.status ?? 0, 0);
  assert.match(res.stdout, /## Environment/);
  assert.match(res.stdout, /- decklight: /);
  assert.match(res.stdout, /issues\/new/);
  assert.match(res.stdout, /nothing has been sent/);
  // the three things the command cannot know are asked for explicitly
  assert.match(res.stdout, /what happened/);
  assert.match(res.stdout, /what you expected/);
  assert.match(res.stdout, /reproduce it/);
});

test('decklight help lists report-bug, and the command documents itself', () => {
  assert.match(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout,
    /^\s+report-bug\s+gather the version/m);
  assert.match(spawnSync(process.execPath, [CLI, 'report-bug', '--help'], { encoding: 'utf8' }).stdout,
    /makes no\s*\n?network requests/);
});

test('skills installs the bug-reporting skill beside the authoring one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-rb-'));
  t.after(() => rmTemp(dir));

  const res = spawnSync(process.execPath, [CLI, 'skills', 'claude'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status ?? 0, 0, res.stderr);

  const skill = path.join(dir, '.claude/skills/decklight-report-bug/SKILL.md');
  assert.ok(fs.existsSync(skill), 'wrote the report-bug skill');
  assert.equal(fs.readFileSync(skill, 'utf8'), reportBugSkillMd(), 'one source, no drift');
  // the authoring skill is untouched by its new sibling
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/decklight/SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/decklight/reference.md')));
});

test('the report-bug skill gates both consent moments in order', () => {
  const md = reportBugSkillMd();
  // it drives the CLI rather than retyping facts
  assert.match(md, /npx decklight@latest report-bug/, 'pinned to @latest — npx keeps whatever it first unpacked (#314)');
  // a screenshot is a headless render of a named deck, never the user's screen
  assert.match(md, /never a capture of their screen/i);
  assert.match(md, /publishes that\s*\n?slide's content/i);
  // and nothing is filed until the whole body has been seen and approved
  assert.match(md, /\*\*complete\*\* text/);
  assert.match(md, /only on an explicit yes/i);
  assert.match(md, /nothing was uploaded and nothing was filed/);
  // the frontmatter Claude indexes on
  assert.match(md, /^name: decklight-report-bug$/m);
});

test('the AGENTS.md section points its readers at the bug flow too, idempotently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-rb-'));
  t.after(() => rmTemp(dir));

  spawnSync(process.execPath, [CLI, 'skills', 'codex'], { cwd: dir, encoding: 'utf8' });
  const agents = path.join(dir, 'AGENTS.md');
  const first = fs.readFileSync(agents, 'utf8');
  assert.match(first, /npx decklight@latest report-bug/);

  // a refresh rewrites the marked block in place — never a second copy
  spawnSync(process.execPath, [CLI, 'skills', 'codex', '--force'], { cwd: dir, encoding: 'utf8' });
  const second = fs.readFileSync(agents, 'utf8');
  assert.equal(second, first);
  assert.equal(second.split('## Decklight decks').length - 1, 1, 'exactly one section');
});

test('the skill tells agents to commit their own logical changes', () => {
  const md = claudeSkillMd();
  assert.match(md, /POST localhost:8788\/edit\/commit/);
  assert.match(md, /One call per logical change/);
  // it must be honest about WHY the server cannot do this for them
  assert.match(md, /it did not\s*\n?start you/);
  // and must not have agents starting servers or failing when none is up
  assert.match(md, /skip it silently/);
  assert.match(md, /never start one\s*\n?yourself/);
});

test('the AGENTS.md section carries the same instruction for agents that read it', () => {
  assert.match(agentsSection(), /\/edit\/commit/);
  assert.match(agentsSection(), /No server listening means no\n?authoring/);
});

test('the always-loaded skill tells agents to render and check for clipped slides', () => {
  // This lived on line ~336 of the 360-line reference, which is read "before
  // authoring" — so an agent writing thirty slides in one pass could author
  // every one of them without ever meeting the rule, and did. The whole value
  // of the rule is being in the file that is always loaded, so that is what is
  // pinned here: if it drifts back into the reference, this fails.
  const md = claudeSkillMd();
  assert.match(md, /decklight@latest pdf/, 'the command that audits every slide');
  assert.match(md, /overflows/, 'and what its output means');
  assert.match(md, /data-overflow/, 'named, so an agent can also assert it directly');
  // overflow is the LATE failure — a slide can fit and still be unpresentable
  assert.match(md, /3–4 bullets/);

  // and the same for agents that never read SKILL.md
  const agents = agentsSection();
  assert.match(agents, /decklight@latest pdf/);
  assert.match(agents, /overflows/);
});

test('the skill names the comparison recipe and its one trap', () => {
  // The recipe's ABSENCE is what produced the deck that shipped broken: with no
  // canonical markup for the most common structured slide, the author hand-rolled
  // a flex shell AND left data-layout="split" on the same section, and the two
  // layout systems fought until the title sat on the column headings.
  const md = claudeSkillMd();
  assert.match(md, /data-layout="split"/);
  // the wording may rewrap; match on words that survive a reflow
  assert.match(md, /do not also write/i);
  assert.match(md, /your own column flexbox/i);
  assert.match(md, /full-width footer/);
  assert.match(md, /COMPARISON_SLIDES/, 'and points at the worked markup');
  assert.match(md, /SLIDE_DENSITY/, 'and at the density guidance');
  // the engine marks the mixed state; the always-loaded file names the mark so
  // the standing `decklight pdf` check is known to catch this trap too
  assert.match(md, /data-split-conflict/, 'the attribute the engine sets on the mixed state');
});

test('init states the commit policy when it creates a repository', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-gitmode-'));
  t.after(() => rmTemp(dir));

  const res = spawnSync(process.execPath, [CLI, 'init', 'My Deck', '--git', '--no-skill'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status ?? 0, 0, res.stderr);
  assert.match(res.stdout, /commits land one per agent edit/);
  assert.match(res.stdout, /--git-mode timer/, 'names the way out');

  // and says nothing about it when it did not create a repo
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-gitmode-'));
  t.after(() => rmTemp(plain));
  const noGit = spawnSync(process.execPath, [CLI, 'init', 'My Deck', '--no-git', '--no-skill'],
    { cwd: plain, encoding: 'utf8' });
  assert.doesNotMatch(noGit.stdout, /commits land one per agent edit/);
});

test('no command resolves a filesystem path through a URL pathname', () => {
  // `new URL('..', import.meta.url).pathname` looks equivalent to
  // fileURLToPath and is not: a URL path is percent-encoded, so an install
  // under `/Users/First Last/…` — every Windows profile with a space in it —
  // came back as `/Users/First%20Last/…`, and `decklight import` died on a raw
  // ENOENT reading its own themes/ (#273 found it during the 0.3.0 release
  // check). The other four package roots in the tree already used
  // fileURLToPath, which is what made this one a lone survivor rather than a
  // convention. Swept rather than fixed in place, because the next one would
  // read just as plausibly.
  //
  // `test/` is in the sweep because it was NOT, and that is how two harnesses
  // kept the bug for another release: contrast and palette-rules resolved
  // themes/ this way, and nothing noticed until `npm run verify` was attempted
  // on Windows (#309), where the same expression reads `D:\D:\a\…`. A guard
  // that covers where the bug was last seen is a guard for the last bug.
  const dirs = ['cli', 'tools', 'test'].map((d) => path.resolve(here, '..', d));
  const hits = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      text.split('\n').forEach((line, i) => {
        // `.pathname` on a URL built from import.meta.url, assigned or joined
        // — the filesystem uses, not the URL-parsing ones (a served request's
        // pathname is genuinely a URL path and stays). A comment is not code,
        // and this file's own explanation of the trap quotes the expression.
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/new URL\([^)]*import\.meta\.url[^)]*\)\.pathname/.test(line))
          hits.push(`${path.basename(dir)}/${name}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [],
    'use fileURLToPath(new URL(…)) — .pathname is percent-encoded and breaks on a path with a space');
});

// ── the failure convention (CommandError / runMain / reportFailure) ─────────
// These call the mains IN-PROCESS, which is the point: `fail()` used to be
// `process.exit(1)`, so a test that touched a refusal path took the runner
// down with it and the only way to test these six commands was to spawn a
// subprocess for every case.

test('a refusal from a main is a thrown CommandError, not a dead process', async () => {
  const { bundleMain } = await import('../cli/bundle.mjs');
  const { CommandError } = await import('../cli/util.mjs');
  await assert.rejects(
    () => bundleMain(['/nonexistent-deck.html']),
    (e) => {
      assert.ok(e instanceof CommandError, 'refusals carry the type the boundary keys on');
      assert.equal(e.command, 'bundle', 'and the command that refused');
      assert.match(e.message, /deck not found/);
      return true;
    });
  // the test runner is still here, which it would not have been before
});

test('runMain turns a refusal into exit 1 and the line commands have always printed', async () => {
  const { runMain, CommandError } = await import('../cli/util.mjs');
  const seen = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { seen.push(String(s)); return true; };
  try {
    assert.equal(await runMain('bundle', () => { throw new CommandError('no theme <link>', 'bundle'); }), 1);
    assert.equal(await runMain('bundle', () => 0), 0, 'a clean run passes its code through');
    assert.equal(await runMain('bundle', () => undefined), 0, 'and no return means success');
  } finally { process.stderr.write = write; }
  assert.deepEqual(seen, ['decklight bundle: no theme <link>\n']);
});

test('an unexpected throw prints a message and hides the stack behind DECKLIGHT_DEBUG', async () => {
  const { runMain } = await import('../cli/util.mjs');
  const seen = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { seen.push(String(s)); return true; };
  const boom = () => { throw new TypeError('x is not a function'); };
  try {
    await runMain('import', boom);
    assert.equal(await runMain('import', boom), 1);
  } finally { process.stderr.write = write; }
  const out = seen.join('');
  assert.match(out, /decklight import: x is not a function/, 'the message leads');
  assert.match(out, /DECKLIGHT_DEBUG=1 for the stack/, 'and names how to get the stack');
  assert.doesNotMatch(out, /at Object|at Test/, 'no raw stack in the default output');
});

test('the dispatcher refuses a bad deck with one line, and --help still exits 0', () => {
  const bad = spawnSync('node', [CLI, 'bundle', '/nonexistent-deck.html'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^decklight bundle: deck not found/m);
  assert.doesNotMatch(bad.stderr, /at \w+ \(/, 'a refusal never shows a stack');

  const help = spawnSync('node', [CLI, 'bundle', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, 'help is not a failure');
  assert.match(help.stdout, /decklight bundle — flatten deck\(s\)/);
});

test('bundling an already-inlined deck says so, instead of blaming a missing <link>', async () => {
  // `decklight init` scaffolds a self-contained deck, and the README's own
  // quick start goes straight from init to bundle — so this refusal is one of
  // the first things a new user meets. It used to read "no theme <link>
  // (href matching themes/<name>.css) found in the deck", sending them to look
  // for markup they were never supposed to have.
  const { bundleMain } = await import('../cli/bundle.mjs');
  const { CommandError } = await import('../cli/util.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-bundle-'));

  const inlined = path.join(dir, 'inlined.html');
  fs.writeFileSync(inlined, '<!doctype html><html><head><style data-theme="midnight">.x{}</style></head>'
    + '<body><div class="decklight"><section><h2>One</h2></section></div>'
    + '<script data-decklight-runtime="js">/* runtime */</script>'
    + '<script>Decklight.init({});</script></body></html>');
  await assert.rejects(() => bundleMain([inlined]), (e) => {
    assert.ok(e instanceof CommandError);
    assert.match(e.message, /already self-contained/);
    assert.match(e.message, /decklight upgrade/, 'and names the command that DOES refresh it');
    return true;
  });

  // a deck with no theme in either form keeps the original message — it is
  // accurate there, and it is the one that tells an author what to add
  const bare = path.join(dir, 'bare.html');
  fs.writeFileSync(bare, '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div>'
    + '<script>Decklight.init({});</script></body></html>');
  await assert.rejects(() => bundleMain([bare]), (e) => {
    assert.match(e.message, /no theme <link>/);
    return true;
  });

  rmTemp(dir);
});

// ── decklight history — a readout, not a means to an end ──────────────────

/** git in `cwd`, with a fixed identity so a bare CI machine can commit. */
const hgit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitIdEnv });

test('markPushState marks what exists nowhere else, and admits when it cannot tell', async () => {
  const { markPushState } = await import('../cli/history.mjs');
  const entries = [{ full: 'aaa' }, { full: 'bbb' }, { full: 'ccc' }];
  assert.deepEqual(markPushState(entries, ['aaa']).map((e) => e.pushed), [false, true, true]);
  assert.deepEqual(markPushState(entries, []).map((e) => e.pushed), [true, true, true],
    'nothing unpushed means everything is pushed — not "unknown"');
  // null is "not a question worth answering here" — no remote, or git could not
  // say. Marking every row in a repo with no remote is a wall of arrows saying
  // what the footer says once.
  assert.deepEqual(markPushState(entries, null).map((e) => e.pushed), [null, null, null]);
});

test('history refuses without a repo, and does NOT refuse an empty history', () => {
  // The difference from `restore`, stated as a test: restore exits 1 when there
  // is nothing to restore, because it is an action that could not be performed.
  // A readout that exits non-zero because the answer is "nothing yet" breaks
  // `decklight history && …` and reads as a malfunction.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-hist-'));
  try {
    fs.writeFileSync(path.join(plain, 'deck.html'), '<div class="decklight"></div><script>Decklight.init({})</script>');
    const noRepo = spawnSync(process.execPath, [CLI, 'history', 'deck.html'], { cwd: plain, encoding: 'utf8' });
    assert.equal(noRepo.status, 1);
    assert.match(noRepo.stderr, /not in a git repository/);

    hgit(['init', '-q'], plain);
    hgit(['config', 'user.email', 't@e.com'], plain);
    hgit(['config', 'user.name', 'T'], plain);
    const fresh = spawnSync(process.execPath, [CLI, 'history', 'deck.html'], { cwd: plain, encoding: 'utf8' });
    assert.equal(fresh.status, 0, 'an empty history is an answer, not a failure');
    // A repository with no commits at all: `git log` exits non-zero there
    // ("does not have any commits yet"), and reporting that as a read error
    // would turn the ordinary first minute of a deck's life into an error.
    assert.match(fresh.stdout, /nothing committed yet/);

    // And once there IS a commit, but none that touched this deck.
    fs.writeFileSync(path.join(plain, 'other.txt'), 'x');
    hgit(['add', 'other.txt'], plain); hgit(['commit', '-qm', 'unrelated'], plain);
    const unseen = spawnSync(process.execPath, [CLI, 'history', 'deck.html'], { cwd: plain, encoding: 'utf8' });
    assert.equal(unseen.status, 0);
    assert.match(unseen.stdout, /no record of this file yet/);
  } finally { rmTemp(plain); }
});

test('history lists commits, marks the unpushed ones, and names where they stand', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-hist2-'));
  try {
    const bare = path.join(root, 'bare.git');
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    hgit(['init', '--bare', '-q', bare], root);
    hgit(['init', '-q'], work);
    hgit(['config', 'user.email', 't@e.com'], work);
    hgit(['config', 'user.name', 'T'], work);
    fs.writeFileSync(path.join(work, 'deck.html'), '<div class="decklight"></div>');
    hgit(['add', '-A'], work); hgit(['commit', '-qm', 'first'], work);
    hgit(['remote', 'add', 'origin', `file://${bare}`], work);
    hgit(['push', '-q', '-u', 'origin', 'HEAD'], work);

    let out = spawnSync(process.execPath, [CLI, 'history', 'deck.html'], { cwd: work, encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /1 commit, newest first/);
    assert.match(out.stdout, /all pushed/);
    assert.ok(!out.stdout.includes('↑'), 'a pushed deck has no arrows');

    fs.writeFileSync(path.join(work, 'deck.html'), '<div class="decklight"><section></section></div>');
    hgit(['add', '-A'], work); hgit(['commit', '-qm', 'second'], work);
    out = spawnSync(process.execPath, [CLI, 'history', 'deck.html'], { cwd: work, encoding: 'utf8' });
    assert.match(out.stdout, /↑/, 'the new commit is marked');
    assert.match(out.stdout, /↑1 unpushed/);
    assert.match(out.stdout, /push them with:/);
    assert.match(out.stdout, /restore one with:  decklight restore deck\.html/);
  } finally { rmTemp(root); }
});

test('decklight --help lists history', () => {
  const out = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(out, /^ {2}history /m);
});

// ── the remote offer at init time ─────────────────────────────────────────

test('planRemote: the whole table', async () => {
  const { planRemote } = await import('../cli/init.mjs');
  const p = (o) => planRemote({ tty: true, haveRepo: true, ...o });
  assert.deepEqual(p({ args: ['--no-remote'] }), { action: 'skip' });
  assert.deepEqual(p({ args: ['--remote', 'git@h:a/b'] }), { action: 'set', url: 'git@h:a/b' });
  // Nothing to attach a remote to, or one is already attached.
  assert.deepEqual(p({ haveRepo: false }), { action: 'skip' });
  assert.deepEqual(p({ hasRemote: true }), { action: 'skip' });
  // A headless run never blocks on a question nobody can answer.
  assert.deepEqual(p({ tty: false }), { action: 'hint' });
  assert.deepEqual(p({ ghReady: true }), { action: 'ask-gh', defaultYes: true });
  assert.deepEqual(p({ ghReady: false }), { action: 'ask-url', defaultYes: true });
  // A `--remote` that is really a flag is not a URL.
  assert.deepEqual(p({ args: ['--remote', '--upload-pack=x'] }), { action: 'ask-url', defaultYes: true });
});

test('a directory that already held work flips the default to N', async () => {
  const { planRemote } = await import('../cli/init.mjs');
  // `initRepo` runs `git add -A`, so a decklight init in somebody's existing
  // folder has just committed all of it. Same question, different default —
  // "yes" should not be what happens when you press return over 23 files you
  // did not think about.
  assert.equal(planRemote({ tty: true, haveRepo: true, ghReady: true, foreign: 0 }).defaultYes, true);
  assert.equal(planRemote({ tty: true, haveRepo: true, ghReady: true, foreign: 23 }).defaultYes, false);
});

test('init --remote wires the remote and says so; --no-remote adds nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-rem-'));
  try {
    const bare = path.join(root, 'bare.git');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    execFileSync('git', ['init', '--bare', '-q', bare], { encoding: 'utf8' });
    const out = spawnSync(process.execPath, [CLI, 'init', 'Remote Deck', '-o', 'deck.html',
      '--themes', 'aurora', '--git', '--no-skill', '--remote', `file://${bare}`],
    { cwd: proj, encoding: 'utf8', env: gitIdEnv });
    assert.equal(out.status, 0, out.stderr);
    const url = execFileSync('git', ['-C', proj, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    assert.equal(url, `file://${bare}`);
    // and it actually pushed — the bare repo has the commit
    assert.match(execFileSync('git', ['-C', bare, 'log', '--format=%s'], { encoding: 'utf8' }), /decklight init/);
    assert.match(out.stdout, /origin added and pushed/);

    const proj2 = path.join(root, 'proj2');
    fs.mkdirSync(proj2);
    spawnSync(process.execPath, [CLI, 'init', 'No Remote', '-o', 'd.html', '--themes', 'aurora',
      '--git', '--no-skill', '--no-remote'], { cwd: proj2, encoding: 'utf8', env: gitIdEnv });
    assert.equal(execFileSync('git', ['-C', proj2, 'remote'], { encoding: 'utf8' }).trim(), '',
      '--no-remote adds nothing');
  } finally { rmTemp(root); }
});

test('init --remote refuses a flag dressed as a URL', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-rem2-'));
  try {
    const out = spawnSync(process.execPath, [CLI, 'init', 'D', '-o', 'd.html', '--themes', 'aurora',
      '--git', '--no-skill', '--remote', '--upload-pack=/bin/sh'],
    { cwd: proj, encoding: 'utf8', env: gitIdEnv });
    assert.equal(execFileSync('git', ['-C', proj, 'remote'], { encoding: 'utf8' }).trim(), '',
      'no remote was added');
    assert.equal(out.status, 0, 'and the deck was still scaffolded — this is a note, not a failure');
  } finally { rmTemp(proj); }
});

// ── decklight record — the command whose whole job is the origin ──────────
// A browser will not open a microphone for a file:// page: getUserMedia needs
// a secure context and a local file is not one, however many times you click
// Allow. http://127.0.0.1 is one. That is the command.

test('record refuses a --dir it could not write into, before serving anything', async () => {
  const { dirProblem } = await import('../cli/record.mjs');
  assert.equal(dirProblem(undefined), null);       // unset: the deck decides
  assert.equal(dirProblem('voiceover'), null);
  assert.equal(dirProblem('audio/take-2'), null);
  // the same three shapes /edit/record refuses, refused here so a typo costs a
  // message rather than a 400 per beat halfway through a take
  assert.match(dirProblem('/etc'), /absolute path/);
  assert.match(dirProblem('C:\\Windows'), /absolute path/);
  assert.match(dirProblem('../..'), /inside the deck/);
  assert.match(dirProblem('a/../../b'), /inside the deck/);
  assert.match(dirProblem('https://bucket/voices'), /folder, not a URL/);
  assert.match(dirProblem(''), /needs a folder name/);
});

test('record opens the deck on the server it just started, with the recorder armed', async () => {
  const { recordUrl } = await import('../cli/record.mjs');
  // ?record, not #record: the runtime reads location.search. And the deck
  // itself, not a separate page — you record against the slides the audience
  // sees, at the build they see them at.
  assert.equal(recordUrl(8788, '/talk.html'), 'http://127.0.0.1:8788/talk.html?record');
  assert.equal(recordUrl(9001, '/decks/talk.html', 'audio/take 2'),
    'http://127.0.0.1:9001/decks/talk.html?record&dir=audio%2Ftake%202');
});

test('record serves the deck and prints the URL the browser is sent to', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-record-'));
  t.after(() => rmTemp(dir));
  fs.writeFileSync(path.join(dir, 'talk.html'),
    '<!doctype html><div class="decklight"><section><h1>Hi</h1></section></div>');

  // Spawned, not called: this command's server is meant to OUTLIVE the call —
  // it holds a file watcher and a live-reload stream for as long as you are
  // recording — so in-process it would keep the test runner alive forever.
  // --port 0 lets the OS pick, which is what makes it safe to run anywhere.
  const child = spawn(process.execPath, [CLI, 'record', 'talk.html', '--port', '0', '--dir', 'takes', '--no-open'],
    { cwd: dir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const url = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/decklight record on (\S+)/);
      if (m) { clearInterval(scan); resolve(m[1]); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('record exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout:\n' + out)); }, 15000);
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/talk\.html\?record&dir=takes$/);
  // ?record is what arms the recorder, and --dir rides along so the files land
  // where the command was told to put them rather than where the deck guesses
  assert.match(out, /⇧R opens the recorder/);
  // …and the server really is serving that deck
  const res = await fetch(url.replace(/\?.*/, ''));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /class="decklight"/);
});
