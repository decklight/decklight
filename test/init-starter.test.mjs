// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight init --starter full`: the reference starter, one slide per thing
// a slide can hold (cli/starter-full.mjs). An author copies from it, so it is
// held to what it teaches: `decklight check` finds nothing on it, linked or
// self-contained; every slide names what it shows and the SPEC section to
// read, by a mnemonic SPEC.md's index really has; every slide has notes. The
// browser half (check's render, every theme, nothing clipped, every word
// readable) is test/starter-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { planStarter, pickStarter, STARTER_QUESTION } from '../cli/init.mjs';
import { STARTERS } from '../cli/starter-full.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const SPEC = readFileSync(path.resolve(here, '../SPEC.md'), 'utf8');

/** The mnemonics SPEC.md's index table lists: the only names a citation may use. */
const INDEX = new Set((/\| Mnemonic \| Section \|\n\|---\|---\|\n((?:\|.*\|\n)+)/.exec(SPEC)?.[1] ?? '')
  .split('\n').flatMap((row) => [...(row.split('|')[1] ?? '').matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1])));

function scaffold(t, ...flags) {
  const dir = tmp('init-starter', t);
  const r = spawnSync(process.execPath, [CLI, 'init', 'Tour', '--dir', dir, '--no-git', '--no-skill', '--no-open', ...flags],
    { encoding: 'utf8', input: '', env: { ...process.env, DECKLIGHT_HOME: path.join(dir, '.home') } });
  return { r, dir, file: path.join(dir, 'deck.html') };
}

/** Each slide's opening tag, body, and the comment right above it (or null). */
function slides(html) {
  const deck = html.slice(html.indexOf('<div class="decklight">'));
  return [...deck.matchAll(/(?:<!--([^]*?)-->\s*)?<section\b([^>]*)>([^]*?)<\/section>/g)]
    .map((m) => ({ comment: m[1]?.trim() ?? null, attrs: m[2], body: m[3] }));
}

test('the starter planner: the flag in either spelling, a terminal asked, a headless run basic, a wrong name refused', () => {
  assert.deepEqual(STARTERS, ['basic', 'full']);
  assert.deepEqual(planStarter({ args: [] }), { action: 'use', starter: 'basic' }, 'headless: today\'s deck');
  assert.deepEqual(planStarter({ args: [], tty: true }), { action: 'ask' });
  assert.deepEqual(planStarter({ args: ['--starter', 'full'], tty: true }), { action: 'use', starter: 'full' }, 'the flag answers for the terminal');
  assert.deepEqual(planStarter({ args: ['--starter=full'] }), { action: 'use', starter: 'full' });
  assert.deepEqual(planStarter({ args: ['--starter', 'basic'] }), { action: 'use', starter: 'basic' });
  assert.match(planStarter({ args: ['--starter', 'fancy'] }).why, /no starter "fancy" \(basic or full\)/);
  assert.equal(planStarter({ args: ['--starter'] }).action, 'refuse', 'a flag with no name');
  assert.equal(planStarter({ args: ['--starter', '--inline'] }).action, 'refuse', 'a flag is not a name');
  assert.match(STARTER_QUESTION, /\[B\/f\] $/);
  assert.equal(pickStarter(''), 'basic', 'Enter (or the end of input) keeps basic');
  assert.equal(pickStarter('f'), 'full');
  assert.equal(pickStarter(' Full'), 'full');
  assert.equal(pickStarter('b'), 'basic');
});

test('init --starter refuses a starter it does not have, before anything is written', (t) => {
  const { r, file } = scaffold(t, '--starter', 'fancy');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--starter: no starter "fancy"/);
  assert.throws(() => readFileSync(file), /ENOENT/);
});

test('without --starter the deck is today\'s two slides, and init --help offers full', (t) => {
  const { r, file } = scaffold(t);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(slides(readFileSync(file, 'utf8')).length, 2);
  assert.doesNotMatch(r.stdout, /full starter/);
  const help = spawnSync(process.execPath, [CLI, 'init', '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /--starter <name>/);
  assert.match(help, /full {10}one slide per feature/);
});

for (const shape of ['linked', 'inline']) {
  test(`--starter full (${shape}): one slide per feature, each under a comment naming a SPEC section the index has, each with notes`, (t) => {
    const { r, file } = scaffold(t, '--starter', 'full', ...(shape === 'inline' ? ['--inline'] : []));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /created \S*deck\.html \(full starter: one slide per feature · /);
    const html = readFileSync(file, 'utf8');
    const all = slides(html);
    assert.ok(all.length >= 12, `${all.length} slides`);
    assert.ok(INDEX.size > 40 && INDEX.has('DECK_ANATOMY'), 'the index was read');
    for (const [i, s] of all.entries()) {
      const at = `slide ${i + 1}`;
      assert.ok(s.comment, `${at} has a comment above it`);
      const cited = [...s.comment.matchAll(/SPEC: ([A-Z_]+)/g)].map((m) => m[1]);
      assert.equal(cited.length, 1, `${at} names one SPEC section: ${s.comment}`);
      assert.ok(INDEX.has(cited[0]), `${at} cites ${cited[0]}, which SPEC.md's index does not list`);
      assert.doesNotMatch(s.comment, /§|\bsection \d/i, `${at} cites by mnemonic, never by number`);
      const notes = /<aside class="notes">([^]*?)<\/aside>/.exec(s.body)?.[1].replace(/<[^>]+>|\[click\]/g, '').trim();
      assert.ok(notes, `${at} has speaker notes with words in them`);
    }
    // what the starter promises to show, each on its own slide
    const shows = (re, what) => assert.ok(all.some((s) => re.test(s.attrs + s.body)), `a slide shows ${what}`);
    shows(/<h1>Tour<\/h1>/, 'the title');
    shows(/data-module="/, 'a module marker');
    shows(/<ul data-build/, 'bullets that build');
    shows(/data-layout="split"[^]*<div>[^]*<div>/, 'a comparison');
    shows(/<table data-build>[^]*<thead>/, 'a table');
    shows(/<pre data-fit data-lines="[^"]+"><code class="language-/, 'a code block');
    shows(/data-math/, 'math');
    shows(/<img src="data:image\/svg\+xml,[^"]+" alt="[^"]+">/, 'a picture that needs no file');
    shows(/class="chart" data-chart="bar"/, 'a chart');
    shows(/data-node="[^]*data-from="[^]*data-to="/, 'a diagram with connectors');
    shows(/<aside class="sources">/, 'sources');
    assert.equal(all.filter((s) => /data-module="/.test(s.attrs)).length, 3, 'three chapters');
  });

  test(`--starter full (${shape}): decklight check finds nothing, not even a hint`, (t) => {
    const { r, file } = scaffold(t, '--starter', 'full', ...(shape === 'inline' ? ['--inline'] : []));
    assert.equal(r.status, 0, r.stderr);
    // the file half, Chrome-free so it runs in every unit job; the render half
    // (check in Chrome, and every theme walked) is test/starter-render.mjs
    const c = spawnSync(process.execPath, [CLI, 'check', file, '--json', '--no-render'], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.deepEqual(JSON.parse(c.stdout), [], 'check is clean');
  });
}
