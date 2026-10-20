// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Migrate, offered where the author is (SPEC DESIGN_SYSTEM_MIGRATIONS): the
// behind check reads what `check` reads, `marketplace update` says a major
// with migrations means migrating, the in-app update says the open deck is
// now behind, and Migrate runs in the agent panel — an agent's ask when there
// is a skill and an agent, the server's own entry otherwise — as one undo
// step over the deck and the stylesheets it links, committed on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, childEnv, writeFakeBin, stop, wait } from './helpers.mjs';
import {
  linkDesignSystems, deckBehind, withMigrationHint, planMigration, migrationLines, deckDesignSystemVersions,
} from '../cli/design-system-refs.mjs';
import { createHistory, describeReload } from '../cli/edit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const EDIT = path.resolve(here, '../cli/edit.mjs');
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');

// the roles fixture is acme 3.0.0; this is what 3.0.0 renamed
const MIGRATIONS = {
  '3.0.0': {
    skill: 'acme-migrate',
    roles: { 'text-main': 'text-body' },
    tokens: { '--acme-pad': '--acme-divider-pad' },
    classes: { 'acme-tile': 'acme-card' },
  },
};

const deck = (cfg, slides, head = '') => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], theme: 'acme-dark', ...cfg })}</script>\n`
  + `${head}</head><body><div class="decklight">${slides}</div></body></html>`;
const CLEAN = '<section><h2>S</h2><p style="color: var(--acme-color-text-body)">x</p></section>';
const OLD = '<section><h2>S</h2><p style="color: var(--acme-color-text-main)">x</p></section>';
const LINKED = '<link rel="stylesheet" href="course.css">\n';
const OLD_CSS = '.acme-tile { padding: var(--acme-pad); }\n';
const NEW_CSS = '.acme-card { padding: var(--acme-divider-pad); }\n';

/** acme-mkt with the roles fixture and its migrations, registered into `<dir>/home`. */
function market(t, dir, migrations = MIGRATIONS) {
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'acme-mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(ROLES, path.join(repo, 'systems/acme'), { recursive: true });
  const file = path.join(repo, 'systems/acme/design-system.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  if (migrations) m.migrations = migrations;
  writeFileSync(file, JSON.stringify(m, null, 2));
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme-mkt', entries: [{ name: 'acme', type: 'design-system', source: 'systems/acme', version: '3.0.0', apiVersion: 2 }],
  }));
  const env = { ...process.env, DECKLIGHT_HOME: h };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  return { h, env, repo };
}

/** The ledger says `acme` was installed at `version` — what `marketplace update` compares against. */
function installedAt(h, version) {
  const file = path.join(h, 'installed.json');
  writeFileSync(file, JSON.stringify({ version: 1, installs: {
    'design-system:acme@acme-mkt': { type: 'design-system', name: 'acme', marketplace: 'acme-mkt', version, commit: null, at: new Date().toISOString() },
  } }));
}

// ── what is behind, read as `check` reads it ────────────────────────────────

test('the page is told a deck is behind from what check reads: a stylesheet it links counts, and the meta names the reference', (t) => {
  const dir = scratch('ds-offer-meta', t);
  const { h } = market(t, dir);
  writeFileSync(path.join(dir, 'course.css'), OLD_CSS);
  // no version recorded: held to every migration, and only the stylesheet still uses an old name
  const html = deck({}, CLEAN, LINKED);
  assert.doesNotMatch(linkDesignSystems(html, h), /decklight-design-system-behind/, 'the deck alone is clean');
  const page = linkDesignSystems(html, h, { dir }).match(/<meta name="decklight-design-system-behind"[^>]*>/)?.[0] ?? "";
  assert.match(page, /<meta name="decklight-design-system-behind" data-ref="acme@acme-mkt" data-version="3\.0\.0" content="Acme Brand: written for an earlier acme, this machine serves 3\.0\.0: 2 renamed names \(--acme-pad → --acme-divider-pad, acme-tile → acme-card\)/);

  const behind = deckBehind(html, dir, h, { deck: 'talk.html' });
  assert.deepEqual(behind.map((b) => [b.ref, b.recorded, b.current, b.skills]), [['acme@acme-mkt', null, '3.0.0', ['acme-migrate']]]);
  assert.match(behind[0].message, /decklight design-system migrate acme@acme-mkt talk\.html$/);
  writeFileSync(path.join(dir, 'course.css'), NEW_CSS);
  assert.deepEqual(deckBehind(html, dir, h), [], 'nothing old anywhere: nothing to offer');
});

test('a migration planned in memory is what the command and the server both apply, said in the same lines', (t) => {
  const dir = scratch('ds-offer-plan', t);
  const { h } = market(t, dir);
  writeFileSync(path.join(dir, 'course.css'), OLD_CSS);
  const html = deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, OLD, LINKED);
  const plan = planMigration(html, dir, 'acme@acme-mkt', h);
  assert.equal(plan.changed, true);
  assert.equal(plan.renamed, 3);
  assert.deepEqual(plan.sheets.map((x) => [x.href, x.text]), [['course.css', NEW_CSS]]);
  assert.deepEqual(deckDesignSystemVersions(plan.html), { 'acme@acme-mkt': '3.0.0' });
  assert.equal(readFileSync(path.join(dir, 'course.css'), 'utf8'), OLD_CSS, 'nothing is written by a plan');
  assert.deepEqual(migrationLines(plan, 'talk.html').slice(0, 2), ['talk.html: acme@acme-mkt 2.0.0 → 3.0.0', '  roles    text-main → text-body']);
  assert.match(planMigration(html, dir, 'other@acme-mkt', h).error, /does not use other@acme-mkt/);
});

// ── marketplace update ──────────────────────────────────────────────────────

test('marketplace update: a newer design system that declares migrations says decks need migrating, and names the skill', (t) => {
  const dir = scratch('ds-offer-update', t);
  const { h, env } = market(t, dir);
  installedAt(h, '2.0.0');
  const r = spawnSync(process.execPath, [CLI, 'marketplace', 'update', 'acme-mkt'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme@acme-mkt {2}2\.0\.0 → 3\.0\.0 \(major: decks that use it need migrating, with the acme-migrate skill\) {2}— {2}decklight check finds them; decklight design-system migrate acme@acme-mkt <deck\.html> moves one/);

  const minor = withMigrationHint({ qualified: 'acme@acme-mkt', type: 'design-system', from: '3.0.0', to: '3.1.0', how: 'x' }, h);
  assert.equal(minor.how, 'x', 'nothing declared since the version installed: the reinstall hint stays');
  const theme = { qualified: 'x@acme-mkt', type: 'theme', from: '1.0.0', to: '2.0.0', how: 'y' };
  assert.equal(withMigrationHint(theme, h), theme);
});

// ── the undo entry and the reload ───────────────────────────────────────────

test('one undo entry can hold files beside the deck, and the step back is answered with those files as they are', () => {
  const h = createHistory();
  h.record({ deck: 'old deck', files: { '/x/course.css': 'old css' } });
  const asked = [];
  const back = h.undo((e) => { asked.push(e); return { deck: 'new deck', files: { '/x/course.css': 'new css' } }; });
  assert.deepEqual(back, { deck: 'old deck', files: { '/x/course.css': 'old css' } });
  assert.deepEqual(asked, [back], 'the current state is taken for exactly the files the entry names');
  assert.deepEqual(h.redo('ignored when a function is not given'), { deck: 'new deck', files: { '/x/course.css': 'new css' } });
  h.record('plain');
  assert.equal(h.undo('now'), 'plain', 'a plain entry is the deck, as before');
  assert.deepEqual(describeReload({ agent: { agent: 'claude', reload: 'migrated to acme 3.0.0' } }), { reload: 'migrated to acme 3.0.0', from: null });
  assert.deepEqual(describeReload({ agent: { agent: 'claude' } }), { reload: "claude's edit", from: null });
});

// ── the edit server ─────────────────────────────────────────────────────────

const GIT = (() => { try { return path.dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]); } catch { return null; } })();

async function startEdit(t, dir, env) {
  const child = spawn(process.execPath, [EDIT, 'talk.html', '--port', '0'], { cwd: dir, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 400; i++) {
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return { base: `http://127.0.0.1:${m[1]}`, log: () => out };
    if (child.exitCode !== null) break;
    await wait(25);
  }
  throw new Error(`the edit server did not start:\n${out}`);
}
const post = (base, p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function settled(base) {
  let p;
  for (let i = 0; i < 300; i++) {
    p = await (await fetch(base + '/deck/ping')).json();
    if (!p.agentBusy && p.agentAsks?.at(-1)?.state === 'done') return p;
    await wait(50);
  }
  return p;
}
/** A folder with talk.html (behind) and the course.css it links, in a git repo when git is here. */
function project(t, name) {
  const dir = scratch(name, t);
  const m = market(t, dir);
  writeFileSync(path.join(dir, 'course.css'), OLD_CSS);
  writeFileSync(path.join(dir, 'talk.html'), deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, OLD, LINKED));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  if (GIT) {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    writeFileSync(path.join(dir, '.gitignore'), 'home/\nacme-mkt/\nbin/\n');
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');
  }
  return { dir, bin, ...m, PATH: [bin, GIT].filter(Boolean).join(path.delimiter) };
}
const subjects = (dir) => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');

test('the in-app marketplace update answers with what the open deck is now behind, and the newer row says to migrate', async (t) => {
  const { dir, h, PATH } = project(t, 'ds-offer-inapp');
  installedAt(h, '2.0.0');
  const { base } = await startEdit(t, dir, { DECKLIGHT_HOME: h, PATH });
  const r = await (await post(base, '/deck/edit/marketplace/update', { name: 'acme-mkt' })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.behind.map((b) => b.ref), ['acme@acme-mkt']);
  assert.match(r.behind[0].message, /^written for acme 2\.0\.0, this machine serves 3\.0\.0: 3 renamed names/);
  assert.match(r.behind[0].message, /decklight design-system migrate acme@acme-mkt talk\.html$/);
  assert.match(r.newer[0].note, /^major: decks that use it need migrating, with the acme-migrate skill$/);
});

test('Migrate with no agent: the server runs it, records it in the panel, and one undo puts the deck and its stylesheet back', async (t) => {
  const { dir, h, PATH } = project(t, 'ds-offer-server');
  const deckFile = path.join(dir, 'talk.html');
  const cssFile = path.join(dir, 'course.css');
  const before = readFileSync(deckFile, 'utf8');
  const { base, log } = await startEdit(t, dir, { DECKLIGHT_HOME: h, PATH });
  const page = await (await fetch(base + '/talk.html')).text();
  assert.match(page, /decklight-design-system-behind" data-ref="acme@acme-mkt"[^>]*decklight design-system migrate acme@acme-mkt talk\.html">/, 'the served page carries the offer, naming the deck');

  const r = await (await post(base, '/deck/edit/design-system/migrate', { ref: 'acme@acme-mkt' })).json();
  assert.deepEqual([r.ok, r.by, r.renamed, r.version], [true, 'server', 3, '3.0.0'], JSON.stringify(r));
  assert.equal(readFileSync(cssFile, 'utf8'), NEW_CSS);
  assert.deepEqual(deckDesignSystemVersions(readFileSync(deckFile, 'utf8')), { 'acme@acme-mkt': '3.0.0' });

  const p = await settled(base);
  const ask = p.agentAsks.at(-1);
  assert.deepEqual([ask.kind, ask.agent, ask.title, ask.ok, ask.changed], ['migrate', 'decklight', 'migrate to acme 3.0.0', true, true]);
  assert.match(ask.tail, /roles {4}text-main → text-body/);
  assert.match(ask.tail, /3 renames — in talk\.html, course\.css/);
  assert.match(ask.tail, /the acme-migrate skill's/, 'what a rename cannot decide is named');
  assert.equal(p.undo, 1, 'one step');
  const served = await (await fetch(base + '/talk.html')).text();
  assert.doesNotMatch(served, /decklight-design-system-behind/, 'once migrated, the offer is gone');
  if (GIT) assert.equal(subjects(dir)[0], 'decklight: migrate talk.html to acme 3.0.0', 'its own commit');
  if (GIT) assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'talk.html', 'course.css'], { cwd: dir, encoding: 'utf8' }), '', 'the stylesheet is in it');

  const again = await (await post(base, '/deck/edit/design-system/migrate', { ref: 'acme@acme-mkt' })).json();
  assert.deepEqual([again.ok, again.nothing], [true, true]);

  assert.equal((await post(base, '/deck/edit/undo')).status, 200);
  assert.equal(readFileSync(deckFile, 'utf8'), before);
  assert.equal(readFileSync(cssFile, 'utf8'), OLD_CSS, 'the same undo puts the stylesheet back');
  assert.equal((await post(base, '/deck/edit/redo')).status, 200);
  assert.equal(readFileSync(cssFile, 'utf8'), NEW_CSS, 'and redo takes both forward again');
  assert.match(log(), /design system: migrated to acme 3\.0\.0 — 3 renames/);
});

test('Migrate with a skill and an agent: it is the agent\'s ask, naming the skill and the command, and its edit is one undo over both files', async (t) => {
  const { dir, h, PATH, bin } = project(t, 'ds-offer-agent');
  const cssFile = path.join(dir, 'course.css');
  // a fake agent: keeps the prompt, renames in the stylesheet, records the version in the deck
  writeFakeBin(bin, 'claude', [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "writeFileSync('prompt.txt', process.argv[process.argv.indexOf('-p') + 1] ?? '');",
    "writeFileSync('course.css', readFileSync('course.css', 'utf8').replace('acme-tile', 'acme-card'));",
    "writeFileSync('talk.html', readFileSync('talk.html', 'utf8').replace('\"2.0.0\"', '\"3.0.0\"'));",
    "console.log(JSON.stringify({ type: 'result', result: 'Renamed 3 names; one judgement call.' }));",
  ].join('\n'));
  const { base } = await startEdit(t, dir, { DECKLIGHT_HOME: h, PATH });
  const r = await (await post(base, '/deck/edit/design-system/migrate', { ref: 'acme@acme-mkt' })).json();
  assert.deepEqual([r.ok, r.by, r.agent], [true, 'agent', 'claude'], JSON.stringify(r));
  const p = await settled(base);
  const ask = p.agentAsks.at(-1);
  assert.deepEqual([ask.kind, ask.agent, ask.title, ask.changed], ['migrate', 'claude', 'migrate to acme 3.0.0', true]);
  assert.match(ask.tail, /Renamed 3 names; one judgement call\./, 'the panel shows the skill\'s report');
  const prompt = readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  assert.match(prompt, /with the acme-migrate skill/);
  assert.match(prompt, /decklight design-system migrate acme@acme-mkt talk\.html/);
  assert.match(prompt, /judgement calls/);
  if (GIT) assert.equal(subjects(dir)[0], 'decklight: migrate talk.html to acme 3.0.0');
  assert.equal((await post(base, '/deck/edit/undo')).status, 200);
  assert.equal(readFileSync(cssFile, 'utf8'), OLD_CSS, 'the agent\'s stylesheet edit is in the same undo');
});
