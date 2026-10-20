// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Check deck…'s quick fixes (SPEC PRESENTING_EDITING, #889): the edit server
// hands the panel every static finding with the fix it could apply, and
// applies the deterministic ones itself — a theme off the brand, a renamed
// role left on a slide — as one undo step and one commit, recorded in the
// agent panel beside the agents' edits. The pure half (cli/check-fixes.mjs)
// is held here without a socket; the routes against a live server, with the
// acme marketplace the migration tests use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, childEnv, stop, wait } from './helpers.mjs';
import { staticFindings } from '../cli/check.mjs';
import { quickFixes, offBrandTarget, renameRoles, fixSubject, BATCH_RULES } from '../cli/check-fixes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const EDIT = path.resolve(here, '../cli/edit.mjs');
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');

// the roles fixture is acme 3.0.0; this is what 3.0.0 renamed, its theme included
const MIGRATIONS = {
  '3.0.0': { skill: 'acme-migrate', roles: { 'text-main': 'text-body' }, themes: { 'acme-devrel': 'acme-dark' } },
};

const deck = (cfg, slides) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], theme: 'acme-dark', ...cfg })}</script>\n`
  + `</head><body><div class="decklight">${slides}</div></body></html>`;
const OLD = '<section><h2>One</h2><p style="color: var(--acme-color-text-main)">x</p></section>';
const OLD_TOO = '<section><h2>Two</h2><svg viewBox="0 0 9 9"><rect fill="var(--acme-color-text-main)" width="2" height="2"/></svg></section>';
const CLEAN = '<section><h2>Three</h2><p style="color: var(--acme-color-text-body)">x</p></section>';

/** acme-mkt with the roles fixture and its migrations, registered into `<dir>/home`; DECKLIGHT_HOME points there for the process too. */
function market(t, dir) {
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'acme-mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(ROLES, path.join(repo, 'systems/acme'), { recursive: true });
  const file = path.join(repo, 'systems/acme/design-system.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.migrations = MIGRATIONS;
  writeFileSync(file, JSON.stringify(m, null, 2));
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme-mkt', entries: [{ name: 'acme', type: 'design-system', source: 'systems/acme', version: '3.0.0', apiVersion: 2 }],
  }));
  const env = { ...process.env, DECKLIGHT_HOME: h };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  const had = process.env.DECKLIGHT_HOME;
  process.env.DECKLIGHT_HOME = h;
  t.after(() => { if (had === undefined) delete process.env.DECKLIGHT_HOME; else process.env.DECKLIGHT_HOME = had; });
  return { h, env };
}

const byRule = (list, rule) => list.filter((f) => f.rule === rule);

// ── the pure half ───────────────────────────────────────────────────────────

test('every static finding carries the fix the server could apply, in the words of what it will do', (t) => {
  const dir = scratch('check-fixes-pure', t);
  const { h } = market(t, dir);
  // recorded at the current version, so the old role is off-role (not ds-behind); the theme is not the brand's
  const html = deck({ designSystemVersions: { 'acme@acme-mkt': '3.0.0' }, theme: 'acme-devrel' }, OLD + OLD_TOO + CLEAN);
  const found = quickFixes(staticFindings(html, { dir, deck: 'talk.html' }), html, dir, { home: h, deck: 'talk.html' });

  const theme = byRule(found, 'theme-off-brand');
  assert.equal(theme.length, 1);
  assert.equal(theme[0].slide, null, 'head-level');
  assert.deepEqual(theme[0].fix, { kind: 'theme', theme: 'acme-dark', label: 'Switch to acme-dark (acme-devrel was renamed)' });

  const roles = byRule(found, 'off-role');
  assert.deepEqual(roles.map((f) => f.slide), [1, 2]);
  assert.match(roles[0].message, /was renamed text-body in 3\.0\.0/);
  assert.deepEqual(roles[0].fix, { kind: 'rename', slide: 1, batch: true, label: 'Rename text-main → text-body on slide 1' });
  assert.equal(byRule(found, 'ds-behind').length, 0, 'a deck on the version is not behind');

  // a deck behind: Migrate, with the plan's count
  const behind = deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, OLD + CLEAN);
  const b = byRule(quickFixes(staticFindings(behind, { dir, deck: 'talk.html' }), behind, dir, { home: h, deck: 'talk.html' }), 'ds-behind');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].fix, { kind: 'migrate', ref: 'acme@acme-mkt', label: 'Migrate to acme 3.0.0 · 1 rename', skills: ['acme-migrate'] });
  assert.equal(byRule(quickFixes(staticFindings(behind, { dir }), behind, dir, { home: h }), 'off-role').length, 0, 'a name ds-behind counts is not off-role too');
});

test('the off-brand target: the migration\'s rename when it is a brand theme, else the brand\'s first; nothing when the deck is on the brand or unlocked', (t) => {
  const dir = scratch('check-fixes-theme', t);
  market(t, dir);
  assert.deepEqual(offBrandTarget(deck({ theme: 'acme-devrel' }, CLEAN)), { from: 'acme-devrel', to: 'acme-dark', renamed: true });
  const first = offBrandTarget(deck({ theme: 'aurora' }, CLEAN));
  assert.equal(first.renamed, false);
  assert.equal(first.from, 'aurora');
  assert.match(first.to, /^acme-/, 'one of the brand\'s own');
  assert.equal(offBrandTarget(deck({ theme: 'acme-dark' }, CLEAN)), null);
  assert.equal(offBrandTarget(deck({ theme: 'aurora', brandThemesOnly: false }, CLEAN)), null);
});

test('renameRoles moves a renamed role to its successor on one slide, or on every slide, and touches nothing else', (t) => {
  const dir = scratch('check-fixes-rename', t);
  market(t, dir);
  const html = deck({}, OLD + OLD_TOO + CLEAN);
  const one = renameRoles(html, 1);
  assert.deepEqual([one.count, one.slides], [1, [1]]);
  assert.match(one.html, /<h2>One<\/h2><p style="color: var\(--acme-color-text-body\)"/);
  assert.match(one.html, /<rect fill="var\(--acme-color-text-main\)"/, 'slide 2 is left as it was');
  assert.equal(one.html.replace('--acme-color-text-body', '--acme-color-text-main').replace('--acme-color-text-body', '--acme-color-text-main'), html.replace('--acme-color-text-body', '--acme-color-text-main'), 'byte for byte otherwise');
  const all = renameRoles(html, null);
  assert.deepEqual([all.count, all.slides], [2, [1, 2]]);
  assert.doesNotMatch(all.html, /text-main/);
  assert.deepEqual(renameRoles(CLEAN, 1), { html: CLEAN, count: 0, slides: [] });
  assert.deepEqual(BATCH_RULES, ['off-role']);
  assert.equal(fixSubject('off-role', 2), 'fix: off-role on slide 2');
  assert.equal(fixSubject('theme-off-brand'), 'fix: theme-off-brand');
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
const get = async (base, p) => (await fetch(base + p)).json();

/** A folder with talk.html (off its brand, two old roles) in a git repo when git is here; no agent on PATH. */
function project(t, name) {
  const dir = scratch(name, t);
  const m = market(t, dir);
  writeFileSync(path.join(dir, 'talk.html'), deck({ designSystemVersions: { 'acme@acme-mkt': '3.0.0' }, theme: 'acme-devrel' }, OLD + OLD_TOO + CLEAN));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  if (GIT) {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    writeFileSync(path.join(dir, '.gitignore'), 'home/\nacme-mkt/\nbin/\n');
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');
  }
  return { dir, ...m, PATH: [bin, GIT].filter(Boolean).join(path.delimiter) };
}
const subjects = (dir) => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');

test('GET /deck/edit/check: the whole deck\'s static findings, head first, each with its quick fix', async (t) => {
  const { dir, h, PATH } = project(t, 'check-route');
  const { base } = await startEdit(t, dir, { DECKLIGHT_HOME: h, PATH });
  const r = await get(base, '/deck/edit/check');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.file, r.slides], ['talk.html', 3]);
  assert.deepEqual(r.findings.map((f) => [f.rule, f.slide, f.fix?.kind ?? null]), [
    ['theme-off-brand', null, 'theme'], ['off-role', 1, 'rename'], ['off-role', 2, 'rename'],
  ]);
  assert.equal(r.findings[0].title, 'head');
  assert.equal(r.findings[0].fix.label, 'Switch to acme-dark (acme-devrel was renamed)');
  assert.ok(r.findings.every((f) => ['level', 'rule', 'slide', 'title', 'message'].every((k) => k in f)), 'the shape check --json prints');
});

test('POST /deck/edit/check/fix: the theme fix and a role rename each land as one undo step, one commit and one panel entry; fix all renames every slide', async (t) => {
  const { dir, h, PATH } = project(t, 'check-fix');
  const file = path.join(dir, 'talk.html');
  const { base, log } = await startEdit(t, dir, { DECKLIGHT_HOME: h, PATH });

  const theme = await (await post(base, '/deck/edit/check/fix', { rule: 'theme-off-brand' })).json();
  assert.deepEqual([theme.ok, theme.changed, theme.said, theme.undo], [true, true, 'theme acme-devrel → acme-dark', 1], JSON.stringify(theme));
  assert.match(readFileSync(file, 'utf8'), /"theme":"acme-dark"/);
  assert.deepEqual([theme.ask.agent, theme.ask.kind, theme.ask.title, theme.ask.state, theme.ask.ok, theme.ask.changed], ['decklight', 'fix', 'fix: theme-off-brand', 'done', true, true]);
  assert.match(theme.ask.tail, /"theme": "acme-devrel" → "acme-dark" \(acme-devrel was renamed\)/);
  if (GIT) assert.equal(subjects(dir)[0], 'fix: theme-off-brand', 'its own commit');

  const again = await post(base, '/deck/edit/check/fix', { rule: 'theme-off-brand' });
  assert.equal(again.status, 409, 'fixed: nothing to fix');

  const one = await (await post(base, '/deck/edit/check/fix', { rule: 'off-role', slide: 2 })).json();
  assert.deepEqual([one.ok, one.changed, one.said, one.undo], [true, true, '1 role renamed on slide 2', 2], JSON.stringify(one));
  assert.deepEqual([one.ask.title, one.ask.slide], ['fix: off-role on slide 2', 2]);
  const after = readFileSync(file, 'utf8');
  assert.match(after, /<rect fill="var\(--acme-color-text-body\)"/);
  assert.match(after, /<h2>One<\/h2><p style="color: var\(--acme-color-text-main\)"/, 'slide 1 is left for its own fix');
  if (GIT) assert.equal(subjects(dir)[0], 'fix: off-role on slide 2');

  // what is left: slide 1's role, and nothing at the head
  const left = await get(base, '/deck/edit/check');
  assert.deepEqual(left.findings.map((f) => [f.rule, f.slide]), [['off-role', 1]]);

  // ⇧F: every slide, one step
  const all = await (await post(base, '/deck/edit/check/fix', { rule: 'off-role', all: true })).json();
  assert.deepEqual([all.ok, all.said, all.undo, all.ask.title], [true, '1 role renamed on slide 1', 3, 'fix: off-role'], JSON.stringify(all));
  assert.doesNotMatch(readFileSync(file, 'utf8'), /text-main/);
  assert.deepEqual((await get(base, '/deck/edit/check')).findings, [], 'the rows go when the findings do');
  if (GIT) assert.equal(subjects(dir)[0], 'fix: off-role');

  const p = await get(base, '/deck/ping');
  assert.deepEqual(p.agentAsks.map((a) => a.title), ['fix: theme-off-brand', 'fix: off-role on slide 2', 'fix: off-role'], 'three entries in the agent panel');
  assert.equal((await post(base, '/deck/edit/undo')).status, 200);
  assert.match(readFileSync(file, 'utf8'), /<h2>One<\/h2><p style="color: var\(--acme-color-text-main\)"/, 'one Z takes the batch back');

  const none = await post(base, '/deck/edit/check/fix', { rule: 'overflow', slide: 1 });
  assert.equal(none.status, 400, 'a judgement rule is the agent\'s, not the server\'s');
  assert.match((await none.json()).error, /ask the agent/);
  assert.match(log(), /check: fix: theme-off-brand — theme acme-devrel → acme-dark/);
});
