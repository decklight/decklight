// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A bare `decklight` on a terminal (cli/start.mjs): what the directory holds
// decides the question, and every answer lands in a command that already
// exists. Driven here with a scripted `ask` and recorded launchers, so no TTY,
// no server and no browser are involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.mjs';
import { pickDeck, pickVerb, planStart, startMain } from '../cli/start.mjs';

const DECK = '<!doctype html><html><body><div class="decklight"><section><h1>x</h1></section></div>'
  + '<script>Decklight.init({});</script></body></html>';

function harness(answers) {
  const out = [];
  const calls = [];
  const run = {
    init: async (args) => { calls.push(['init', args]); return 0; },
    author: async (args) => { calls.push(['author', args]); return 0; },
    present: async (args) => { calls.push(['present', args]); return 0; },
  };
  const ask = async (q) => { out.push(q); return answers.shift() ?? ''; };
  return { out: { write: (s) => out.push(s) }, ask, run, calls, log: () => out.join('') };
}

test('the plan reads the directory: nothing to open offers init, one deck offers it, several offer a choice', () => {
  assert.deepEqual(planStart({ decks: [], tty: true }), { action: 'offer-init' });
  assert.deepEqual(planStart({ decks: ['a.html'], tty: true }), { action: 'offer-open', deck: 'a.html' });
  assert.deepEqual(planStart({ decks: ['a.html', 'b.html'], tty: true }), { action: 'choose', decks: ['a.html', 'b.html'] });
  assert.deepEqual(planStart({ decks: ['a.html'], tty: false }), { action: 'help' },
    'off a terminal there is nobody to ask — the short help, not a hang');
});

test('Enter means author; p means present; anything else opens nothing', () => {
  assert.equal(pickVerb(''), 'author', 'the deck in front of you is one you are working on, more often than not');
  assert.equal(pickVerb('a'), 'author');
  assert.equal(pickVerb('edit'), 'author');
  assert.equal(pickVerb('P'), 'present');
  assert.equal(pickVerb('q'), null);
});

test('a deck is picked by number, by name, or by Enter for the first', () => {
  const decks = ['intro.html', 'Talk.html'];
  assert.equal(pickDeck('', decks), 'intro.html');
  assert.equal(pickDeck('2', decks), 'Talk.html');
  assert.equal(pickDeck('talk.html', decks), 'Talk.html', 'names match the way a filesystem would');
  assert.equal(pickDeck('9', decks), null);
  assert.equal(pickDeck('x', decks), null);
});

test('an empty directory offers to start a deck, and Enter starts one', async (t) => {
  const dir = tmp('start', t);
  const h = harness(['']);
  assert.equal(await startMain([], { cwd: dir, tty: true, ...h }), 0);
  assert.match(h.log(), /no decklight deck in this directory — start one here\? \[Y\/n\]/);
  assert.deepEqual(h.calls, [['init', []]], 'init asks its own questions from here');
});

test('declining the offer prints the short help instead', async (t) => {
  const dir = tmp('start', t);
  const h = harness(['n']);
  assert.equal(await startMain([], { cwd: dir, tty: true, ...h }), 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.log(), /Commands:/);
});

test('one deck is found and opened in author mode with the browser, on Enter', async (t) => {
  const dir = tmp('start', t);
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  writeFileSync(path.join(dir, 'notes.html'), '<p>not a deck</p>');
  const h = harness(['']);
  assert.equal(await startMain([], { cwd: dir, tty: true, ...h }), 0);
  assert.match(h.log(), /found talk\.html/);
  assert.deepEqual(h.calls, [['author', ['talk.html', '--open']]]);
});

test('p presents the deck instead, and q opens nothing', async (t) => {
  const dir = tmp('start', t);
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  const p = harness(['p']);
  await startMain([], { cwd: dir, tty: true, ...p });
  assert.deepEqual(p.calls, [['present', ['talk.html']]]);
  const q = harness(['q']);
  await startMain([], { cwd: dir, tty: true, ...q });
  assert.deepEqual(q.calls, []);
  assert.match(q.log(), /nothing opened/);
});

test('several decks are listed and one is chosen by number', async (t) => {
  const dir = tmp('start', t);
  writeFileSync(path.join(dir, 'a.html'), DECK);
  writeFileSync(path.join(dir, 'b.html'), DECK);
  const h = harness(['2', 'a']);
  await startMain([], { cwd: dir, tty: true, ...h });
  assert.match(h.log(), /2 decks here:\n {2}1\) a\.html\n {2}2\) b\.html/);
  assert.deepEqual(h.calls, [['author', ['b.html', '--open']]]);
});

test('off a terminal the short help prints and nothing is asked', async (t) => {
  const dir = tmp('start', t);
  writeFileSync(path.join(dir, 'a.html'), DECK);
  const h = harness([]);
  assert.equal(await startMain([], { cwd: dir, tty: false, ...h }), 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.log(), /^decklight — /);
});
