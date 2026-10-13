// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight init` asks which design system a new deck is built on, when a
// cached catalog of a registered marketplace offers one (SPEC DESIGN_SYSTEMS,
// #812): the pure planner table, the question's rows and answers, the title
// slide on the brand's template, and the whole command against a fixture
// marketplace in a temporary DECKLIGHT_HOME (never this machine's own).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import {
  planDesignSystem, designSystemQuestion, pickDesignSystem, designSystemHint,
  availableDesignSystems, resolveDesignSystemFlag,
} from '../cli/init.mjs';
import { titleSlideTemplate, slotElements, insertSlideTemplateSlide } from '../cli/design-system-edit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const BRAND = path.join(here, 'fixtures/design-systems/brand');
const OK = path.join(here, 'fixtures/design-systems/ok');

const row = (name, extra = {}) => ({ name, marketplace: 'm', qualified: `${name}@m`, title: name.toUpperCase(), version: '1.0.0', description: '', ...extra });

// ── the planner ──────────────────────────────────────────────────────────────

test('the design-system planner: one on offer is the default, several have none, none on offer asks nothing', () => {
  const one = [row('acme')];
  const two = [row('acme'), row('beta')];
  assert.deepEqual(planDesignSystem({ tty: true, systems: one }), { action: 'ask', rows: one, defaultIndex: 0, unfetched: [], stale: [] });
  assert.equal(planDesignSystem({ tty: true, systems: two }).defaultIndex, null, 'several: the user must choose');
  assert.deepEqual(planDesignSystem({ tty: true, systems: [] }), { action: 'skip' }, 'nothing listed: no question');
  assert.deepEqual(planDesignSystem({ tty: false, systems: [] }), { action: 'skip' }, 'nothing listed: no hint either');
  assert.deepEqual(planDesignSystem({ tty: false, systems: one }), { action: 'hint', systems: one }, 'off a terminal: never asked, one line');
  const footnoted = planDesignSystem({ tty: true, systems: one, unfetched: ['far'], stale: ['old'] });
  assert.deepEqual([footnoted.unfetched, footnoted.stale], [['far'], ['old']]);
});

test('the design-system planner: each flag, the pair refused, and --inline', () => {
  const one = [row('acme')];
  assert.deepEqual(planDesignSystem({ args: ['--design-system', 'acme'], tty: true, systems: one }), { action: 'use', ref: 'acme' });
  assert.deepEqual(planDesignSystem({ args: ['--design-system', 'acme@m'], tty: false }), { action: 'use', ref: 'acme@m' }, 'chosen off a terminal too');
  assert.deepEqual(planDesignSystem({ args: ['--no-design-system'], tty: true, systems: one }), { action: 'skip' });
  assert.equal(planDesignSystem({ args: ['--design-system', 'acme', '--no-design-system'] }).action, 'refuse');
  assert.equal(planDesignSystem({ args: ['--design-system'] }).action, 'refuse', 'a flag with no reference');
  assert.equal(planDesignSystem({ args: ['--design-system', '--no-git'] }).action, 'refuse', 'a flag is not a reference');
  const inline = planDesignSystem({ args: ['--design-system', 'acme'], inline: true });
  assert.equal(inline.action, 'refuse');
  assert.match(inline.why, /no server to link a design system/, 'refused, saying why');
  assert.deepEqual(planDesignSystem({ inline: true, tty: true, systems: one }), { action: 'skip' }, '--inline: no question');
  assert.deepEqual(planDesignSystem({ inline: true, tty: false, systems: one }), { action: 'skip' }, '--inline: no hint');
});

test('the question: a row per design system with its description dim beneath, none last, the default in the prompt', () => {
  const plan = planDesignSystem({ tty: true, systems: [row('acme', { title: 'Acme Brand', version: '2.0.0', description: 'the brand' })], unfetched: ['far'], stale: ['old'] });
  const { lines, prompt } = designSystemQuestion(plan);
  assert.deepEqual(lines, [
    'design system for this deck?',
    '  1  Acme Brand — acme@m 2.0.0',
    '       the brand',
    "  2  none — decklight's own themes",
    '  far has not been fetched yet — decklight marketplace update far',
    "  old's cached catalog could not be read — decklight marketplace update old",
  ]);
  assert.equal(prompt, '[1]: ');
  assert.match(designSystemQuestion(plan, { color: true }).lines[2], /^\x1b\[2m {7}the brand\x1b\[0m$/, 'the description is dim');
  assert.equal(designSystemQuestion(planDesignSystem({ tty: true, systems: [row('a'), row('b')] })).prompt, '[1-3]: ', 'no default');
});

test('an answer: Enter takes the one default, re-asks with several; EOF is none; a number, a name or none picks', () => {
  const one = planDesignSystem({ tty: true, systems: [row('acme')] });
  const two = planDesignSystem({ tty: true, systems: [row('acme'), row('beta')] });
  assert.equal(pickDesignSystem('', one).pick.qualified, 'acme@m');
  assert.deepEqual(pickDesignSystem('', two), { again: true });
  assert.deepEqual(pickDesignSystem('', two, { eof: true }), { pick: null });
  assert.deepEqual(pickDesignSystem('', one, { eof: true }), { pick: null }, 'EOF is none even with a default');
  assert.equal(pickDesignSystem('2', two).pick.qualified, 'beta@m');
  assert.deepEqual(pickDesignSystem('3', two), { pick: null }, 'the none row');
  assert.deepEqual(pickDesignSystem('none', two), { pick: null });
  assert.equal(pickDesignSystem('beta', two).pick.qualified, 'beta@m');
  assert.equal(pickDesignSystem(' acme@m ', two).pick.qualified, 'acme@m');
  assert.deepEqual(pickDesignSystem('7', two), { again: true });
  assert.deepEqual(pickDesignSystem('gamma', two), { again: true }, 'an answer naming no row asks again');
});

test('the hint off a terminal names every design system on offer and the flag', () => {
  assert.equal(designSystemHint([row('acme'), row('beta')]),
    "  design system: none — this machine's marketplaces offer acme@m, beta@m; --design-system <name@marketplace> starts a deck on one");
});

// ── the title slide: the insert path's slot filling ──────────────────────────

const DIVIDER = { id: 'section-divider', slots: [
  { name: 'kicker', hint: 'p', required: false, default: false },
  { name: 'title', hint: 'h1,h2', required: true, default: false },
  { name: 'tag', hint: 'p', required: true, default: false },
  { name: 'body', hint: '', required: false, default: true },
] };

test('the title slide is the first template with a heading-hinted slot, the title in it, every other required slot by its hint', () => {
  const plain = { id: 'quote', slots: [{ name: 'quote', hint: 'blockquote', required: true }] };
  const t = titleSlideTemplate('acme', [plain, DIVIDER], 'Orders &amp; Time');
  assert.equal(t.ref, 'acme/section-divider', 'a template with no heading slot is passed over');
  assert.equal(t.slot, 'title');
  assert.deepEqual(t.lines, ['<h1 data-slot="title">Orders &amp; Time</h1>', '<p data-slot="tag">Tag</p>']);
  assert.equal(titleSlideTemplate('acme', [plain], 'T'), null, 'no heading-hinted slot: today\'s title slide');
  // a heading slot that is not required still carries the title
  const optional = { id: 'cover', slots: [{ name: 'headline', hint: 'h2', required: false }] };
  assert.deepEqual(titleSlideTemplate('acme', [optional], 'T').lines, ['<h2 data-slot="headline">T</h2>']);
});

test('insert still writes one element per required slot, by the same helper', () => {
  assert.deepEqual(slotElements(DIVIDER), ['<h1 data-slot="title">Title</h1>', '<p data-slot="tag">Tag</p>']);
  const out = insertSlideTemplateSlide('<div class="decklight"><section>a</section></div>', 1, { ...DIVIDER, ref: 'acme/section-divider' });
  assert.match(out, /<section data-template="acme\/section-divider">\n {2}<h1 data-slot="title">Title<\/h1>\n {2}<p data-slot="tag">Tag<\/p>\n {2}<aside class="notes"><\/aside>\n<\/section>/);
});

// ── the command, against a fixture marketplace ───────────────────────────────

/**
 * A DECKLIGHT_HOME with one registered marketplace, `brand-mkt`, holding the
 * design systems `systems` names: `acme` (the brand fixture: its own themes,
 * recommending the shipped `paper`) and `beta` (the plain fixture renamed,
 * recommending `paper`, no own themes). Registered from a local path, so
 * nothing touches the network.
 */
function world(t, systems = ['acme'], { breakAcme = false } = {}) {
  const dir = tmp('init-ds', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'brand-mkt');
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, DECKLIGHT_HOME: h, NO_COLOR: '1', SHELL: '/bin/sh' };
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  const entries = [];
  const edit = (file, patch) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
  if (systems.includes('acme')) {
    cpSync(BRAND, path.join(repo, 'systems/acme'), { recursive: true });
    edit(path.join(repo, 'systems/acme/design-system.json'), { recommendedThemes: ['paper'] });
    if (breakAcme) writeFileSync(path.join(repo, 'systems/acme/templates.html'), '<template data-template="x"><script>alert(1)</script></template>');
    entries.push({ name: 'acme', type: 'design-system', source: 'systems/acme', version: '2.0.0', apiVersion: 2, description: 'the Acme brand' });
  }
  if (systems.includes('beta')) {
    cpSync(OK, path.join(repo, 'systems/beta'), { recursive: true });
    edit(path.join(repo, 'systems/beta/design-system.json'), { name: 'beta', title: 'Beta Brand', tokenPrefix: '--acme-', recommendedThemes: ['paper'] });
    entries.push({ name: 'beta', type: 'design-system', source: 'systems/beta', version: '1.2.0', apiVersion: 1 });
  }
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name: 'brand-mkt', title: 'Brand', entries }));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  const deckDir = path.join(dir, 'deck');
  mkdirSync(deckDir);
  return { dir, h, env, deckDir };
}

const config = (html) => JSON.parse(html.match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);
const init = (w, args, extra = {}) => spawnSync(process.execPath, [CLI, 'init', ...args],
  { encoding: 'utf8', cwd: w.deckDir, env: { ...w.env, ...extra }, input: '' });
const deck = (w) => readFileSync(path.join(w.deckDir, 'deck.html'), 'utf8');

test('availableDesignSystems reads the cache: rows with the package title; an unresolvable entry left out', async (t) => {
  const w = world(t, ['acme', 'beta']);
  const got = await availableDesignSystems(w.h);
  assert.deepEqual(got.systems.map((s) => [s.qualified, s.title, s.version]), [['acme@brand-mkt', 'Acme Brand', '2.0.0'], ['beta@brand-mkt', 'Beta Brand', '1.2.0']]);
  assert.equal(await resolveDesignSystemFlag('beta', w.h), 'beta@brand-mkt', 'a bare name resolves as design-system add resolves it');
  await assert.rejects(resolveDesignSystemFlag('nope', w.h), /the cached catalogs offer: acme@brand-mkt, beta@brand-mkt/);
  // a checkout gone: its row goes, the other stays
  rmSync(path.join(w.dir, 'brand-mkt/systems/beta'), { recursive: true });
  assert.deepEqual((await availableDesignSystems(w.h)).systems.map((s) => s.qualified), ['acme@brand-mkt']);
  assert.deepEqual(await availableDesignSystems(path.join(w.dir, 'nowhere')), { systems: [], unfetched: [], stale: [] });
});

test('init with no marketplace offering one is byte-for-byte today\'s: no question, no new line, the same deck', (t) => {
  const w = world(t, []);
  const bare = init(w, ['Plain', '--no-skill', '--no-git'], { DECKLIGHT_HOME: path.join(w.dir, 'fresh-home') });
  assert.equal(bare.status, 0, bare.stderr);
  assert.doesNotMatch(bare.stdout, /design system/);
  const html = deck(w);
  // a registered marketplace whose catalog lists no design system: the same
  writeFileSync(path.join(w.deckDir, 'deck.html'), '');
  const listed = init(w, ['Plain', '--no-skill', '--no-git', '--force']);
  assert.equal(listed.stdout, bare.stdout);
  assert.equal(deck(w), html);
  assert.doesNotMatch(html, /designSystems|data-template/);
  assert.match(html, /<h1>Plain<\/h1>\n {6}<p>Made with Decklight/);
});

test('off a terminal init asks nothing: the deck is plain and one line names what is on offer and the flag', (t) => {
  const w = world(t, ['acme', 'beta']);
  const r = init(w, ['Talk', '--no-skill', '--no-git']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /design system for this deck\?/);
  assert.match(r.stdout, /^ {2}design system: none — this machine's marketplaces offer acme@brand-mkt, beta@brand-mkt; --design-system <name@marketplace> starts a deck on one$/m);
  assert.equal(config(deck(w)).designSystems, undefined);
  // --no-design-system and --inline say nothing about it
  for (const flag of ['--no-design-system', '--inline']) {
    const q = init(w, ['Talk', '--no-skill', '--no-git', '--force', flag]);
    assert.equal(q.status, 0, q.stderr);
    assert.doesNotMatch(q.stdout, /design system/, flag);
  }
});

test('--design-system wires it in before the one write: reference, recommendations, look, title slide; check is clean', (t) => {
  const w = world(t, ['acme', 'beta']);
  const r = init(w, ['Orders <in> Real Time', '--no-skill', '--no-git', '--design-system', 'acme']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^created deck\.html \(design system: Acme Brand 2\.0\.0 — theme acme-dark · title slide on acme\/section-divider · slides and a config block, no runtime in the file/m);
  const html = deck(w);
  const c = config(html);
  assert.deepEqual(c.designSystems, ['acme@brand-mkt']);
  assert.deepEqual(c.markedThemes, ['paper'], 'what it recommends comes with it');
  assert.equal(c.theme, 'acme-dark', 'its own first theme (BRAND_PALETTE) before a recommended one');
  assert.match(html, /<section data-template="acme\/section-divider">\n {6}<h1 data-slot="title">Orders &lt;in&gt; Real Time<\/h1>\n {6}<aside class="notes">/);
  assert.match(html, /<h2>A slide with a build<\/h2>\n {6}<ul data-build="fade-up">/, 'the build slide stays');
  assert.doesNotMatch(html, /<script(?! type="application\/json" data-decklight-config)/, 'still data: no runtime in the file');
  const installs = JSON.parse(readFileSync(path.join(w.h, 'installed.json'), 'utf8')).installs;
  assert.equal(installs['design-system:acme@brand-mkt'].version, '2.0.0', 'recorded as design-system add records it');
  const check = spawnSync(process.execPath, [CLI, 'check', 'deck.html', '--no-render', '--json'], { encoding: 'utf8', cwd: w.deckDir, env: w.env });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  // the file half (Chrome-free, so CI-safe): no design-system finding, nothing at all
  assert.deepEqual(JSON.parse(check.stdout), [], 'check is clean');

  // one with no theme of its own wears the first recommended one
  const b = init(w, ['B', '--no-skill', '--no-git', '--force', '--design-system', 'beta@brand-mkt']);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(config(deck(w)).theme, 'paper');
  assert.match(b.stdout, /design system: Beta Brand 1\.2\.0 — theme paper · title slide on beta\/section-divider/);
});

test('it is exactly what design-system add --apply writes on today\'s starter (the title slide apart)', (t) => {
  const w = world(t, ['acme']);
  init(w, ['Same', '--no-skill', '--no-git', '--no-design-system']);
  const add = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@brand-mkt', 'deck.html', '--apply'], { encoding: 'utf8', cwd: w.deckDir, env: w.env });
  assert.equal(add.status, 0, add.stderr);
  const added = config(deck(w));
  init(w, ['Same', '--no-skill', '--no-git', '--force', '--design-system', 'acme@brand-mkt']);
  assert.deepEqual(config(deck(w)), added);
});

test('--design-system that no cached catalog has fails before anything is written, listing what they offer', (t) => {
  const w = world(t, ['acme']);
  const r = init(w, ['T', '--no-skill', '--no-git', '--design-system', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no "nope" in any registered marketplace — the cached catalogs offer: acme@brand-mkt/);
  assert.equal(existsSync(path.join(w.deckDir, 'deck.html')), false);
  for (const args of [['--design-system', 'acme', '--no-design-system'], ['--design-system', 'acme', '--inline']]) {
    const q = init(w, ['T', '--no-skill', '--no-git', ...args]);
    assert.equal(q.status, 1, args.join(' '));
    assert.equal(existsSync(path.join(w.deckDir, 'deck.html')), false);
  }
});

test('a design system that fails its gate costs a note and a plain deck, never the scaffold', (t) => {
  const w = world(t, ['acme'], { breakAcme: true });
  const r = init(w, ['T', '--no-skill', '--no-git', '--design-system', 'acme']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^created deck\.html \(theme: aurora · /m);
  assert.match(r.stdout, /^ {2}design system: acme@brand-mkt not wired in — it no longer passes its gate .*; the deck starts plain \(decklight design-system add acme@brand-mkt deck\.html --apply retries\)$/m);
  const html = deck(w);
  assert.equal(config(html).designSystems, undefined);
  assert.match(html, /<h1>T<\/h1>/);
  assert.equal(existsSync(path.join(w.h, 'installed.json')), false, 'nothing recorded');
});

// ── on a terminal: script(1) lends a real pty ────────────────────────────────

const ptySkip = (process.platform === 'linux' || process.platform === 'darwin') && existsSync('/usr/bin/script')
  ? false : 'needs script(1)';
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g, '');

/**
 * Run `decklight …args` on a pty, answering each prompt (`[regex, answer]`)
 * as it appears, and stop once `until` has been printed: the deck is
 * written by then and init is waiting on a later question, so nothing (no
 * write-mode server) has been started that would outlive the test.
 */
function onPty(w, args, steps, until) {
  const cmd = [process.execPath, CLI, ...args];
  const quoted = cmd.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  // util-linux script takes the command as a string; the BSD one takes argv,
  // and refuses a socket for stdin (tcgetattr), so `cat` hands it a pipe
  const opts = { cwd: w.deckDir, env: w.env, detached: true };
  const child = process.platform === 'linux'
    ? spawn('/usr/bin/script', ['-qec', quoted, '/dev/null'], opts)
    : spawn('/bin/sh', ['-c', 'cat | /usr/bin/script -q /dev/null "$@"', 'sh', ...cmd], opts);
  // the whole group: script, and with it the pty, whose hangup ends init
  // where it waits, on a later question, before it could start anything
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  let out = '';
  let from = 0;
  let i = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { kill(); reject(new Error(`timed out:\n${strip(out)}`)); }, 30_000);
    const done = () => { clearTimeout(timer); kill(); resolve(strip(out)); };
    child.stdout.on('data', (d) => {
      out += d;
      const text = strip(out);
      while (i < steps.length && steps[i][0].test(text.slice(from))) {
        from = text.length;
        child.stdin.write(`${steps[i][1]}\n`);
        i++;
      }
      if (until.test(text)) done();
    });
    child.on('exit', () => { clearTimeout(timer); resolve(strip(out)); });
  });
}

test('on a terminal, one design system on offer is the default: Enter takes it', { skip: ptySkip, timeout: 60_000 }, async (t) => {
  const w = world(t, ['acme']);
  const out = await onPty(w, ['init', '--no-git'], [
    [/deck title \[My Deck\]: $/, 'Orders in Real Time'],
    [/\[1\]: $/, ''],
  ], /where should the skill go\?/);
  assert.match(out, /design system for this deck\?\n {2}1 {2}Acme Brand — acme@brand-mkt 2\.0\.0\n {7}the Acme brand\n {2}2 {2}none — decklight's own themes\n/);
  assert.match(out, /created deck\.html \(design system: Acme Brand 2\.0\.0 — theme acme-dark · title slide on acme\/section-divider/);
  assert.match(deck(w), /<h1 data-slot="title">Orders in Real Time<\/h1>/);
});

test('on a terminal, several design systems have no default: Enter asks again, a number picks', { skip: ptySkip, timeout: 60_000 }, async (t) => {
  const w = world(t, ['acme', 'beta']);
  const out = await onPty(w, ['init', 'Talk', '--no-git'], [
    [/\[1-3\]: $/, ''],
    [/\[1-3\]: $/, '2'],
  ], /where should the skill go\?/);
  assert.equal(out.match(/\[1-3\]: /g).length, 2, 'Enter re-asked');
  assert.match(out, /created deck\.html \(design system: Beta Brand 1\.2\.0/);
  assert.deepEqual(config(deck(w)).designSystems, ['beta@brand-mkt']);
});

test('on a terminal, none keeps today\'s starter', { skip: ptySkip, timeout: 60_000 }, async (t) => {
  const w = world(t, ['acme']);
  const out = await onPty(w, ['init', 'Talk', '--no-git'], [[/\[1\]: $/, '2']], /where should the skill go\?/);
  assert.match(out, /created deck\.html \(theme: aurora · /);
  assert.equal(config(deck(w)).designSystems, undefined);
});

test('the bare `decklight` offer to start a deck reaches the same question', { skip: ptySkip, timeout: 60_000 }, async (t) => {
  const w = world(t, ['acme']);
  const out = await onPty(w, [], [
    [/start one here\? \[Y\/n\] $/, ''],
    [/deck title \[My Deck\]: $/, 'From Start'],
    [/\[1\]: $/, '1'],
  ], /where should the skill go\?/);
  assert.match(out, /design system for this deck\?/);
  assert.match(out, /created deck\.html \(design system: Acme Brand/);
  assert.match(deck(w), /<h1 data-slot="title">From Start<\/h1>/);
});
