// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight check --watch` (cli/check-watch.mjs): the deck's saves heard
// through its DIRECTORY, so an atomic save (temp file + rename) is heard as
// well as a plain write; a burst of events is one run; and one Chrome serves
// every run. Real files in a temp dir, a counter in place of the lint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { watchDeck, persistentRenderer, watchHeader } from '../cli/check-watch.mjs';
import { checkMain } from '../cli/check.mjs';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const until = async (ok, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(20);
  return ok();
};

/** A deck in a temp dir, a watch on it counting runs, and the dir's cleanup. */
async function watched(t, { debounceMs = 40, run } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dl-check-watch-'));
  const file = join(dir, 'deck.html');
  writeFileSync(file, '<section><h1>One</h1></section>');
  writeFileSync(join(dir, 'other.html'), 'x');
  // a platform may still report the files just written: let that pass first
  await sleep(150);
  const runs = { n: 0 };
  const w = watchDeck({ file, debounceMs, initial: false, run: run ?? (() => { runs.n++; }) });
  t.after(() => { w.close(); rmSync(dir, { recursive: true, force: true }); });
  await sleep(100);
  runs.n = 0;
  return { dir, file, runs, w };
}

test('a plain write to the deck runs the check again', async (t) => {
  const { file, runs } = await watched(t);
  writeFileSync(file, '<section><h1>Two</h1></section>');
  assert.ok(await until(() => runs.n === 1), `one run after a write, got ${runs.n}`);
});

test('an atomic save (a temp file renamed over the deck) is heard, and so is the save after it', async (t) => {
  const { dir, file, runs } = await watched(t);
  writeFileSync(join(dir, '.deck.html.tmp'), '<section><h1>Swapped</h1></section>');
  renameSync(join(dir, '.deck.html.tmp'), file);
  assert.ok(await until(() => runs.n === 1), `one run after a rename, got ${runs.n}`);
  // a file watch would be deaf now, sitting on the inode the rename replaced
  await sleep(150);
  writeFileSync(file, '<section><h1>Again</h1></section>');
  assert.ok(await until(() => runs.n === 2), `the next save is heard too, got ${runs.n}`);
});

test('a burst of saves is one run, and another file in the directory is none', async (t) => {
  const { dir, file, runs } = await watched(t, { debounceMs: 120 });
  for (let i = 0; i < 6; i++) writeFileSync(file, `<section><h1>${i}</h1></section>`);
  assert.ok(await until(() => runs.n >= 1), 'the burst ran the check');
  await sleep(400);
  assert.equal(runs.n, 1, 'six writes, one run');
  writeFileSync(join(dir, 'other.html'), 'y');
  await sleep(400);
  assert.equal(runs.n, 1, 'a neighbour changing is not the deck changing');
});

test('a save during a run is one more run after it, never one beside it', async (t) => {
  let live = 0, most = 0, n = 0;
  let release;
  const { file, w } = await watched(t, {
    run: async () => {
      n++; live++; most = Math.max(most, live);
      if (n === 1) await new Promise((ok) => { release = ok; });
      live--;
    },
  });
  n = 0;
  writeFileSync(file, 'a');
  assert.ok(await until(() => n === 1), 'the first run started');
  writeFileSync(file, 'b');
  await sleep(150);
  writeFileSync(file, 'c');
  await sleep(150);
  assert.equal(n, 1, 'nothing runs while the first is still going');
  release();
  await w.settled();
  assert.equal(n, 2, 'the saves made meanwhile are one more run');
  assert.equal(most, 1, 'never two at a time');
});

test('one browser serves every run, a dead one is replaced, and close stops it', async () => {
  const opened = [];
  const open = async () => {
    const page = {
      closed: false, fail: false, calls: [],
      send: async (m, p) => { page.calls.push(m); if (page.fail && m === 'Page.navigate') throw new Error('gone'); return {}; },
      once: async () => ({}),
      navigate: async () => {},
      evaluate: async () => `<html data-run="${opened.length}"></html>`,
      close: async () => { page.closed = true; },
    };
    opened.push(page);
    return page;
  };
  const r = persistentRenderer('/no/chrome', { open });
  assert.match(await r.render('file:///deck.html?print', 8000), /<html/);
  await r.render('file:///deck.html?print', 8000);
  assert.equal(opened.length, 1, 'two runs, one browser');
  assert.ok(opened[0].calls.includes('Emulation.setVirtualTimePolicy'), 'a virtual-time budget, like --virtual-time-budget');
  opened[0].fail = true;
  await assert.rejects(r.render('file:///deck.html?print', 8000), /gone/);
  assert.ok(opened[0].closed, 'the broken one is closed');
  await r.render('file:///deck.html?print', 8000);
  assert.equal(opened.length, 2, 'the next run starts a fresh one');
  await r.close();
  assert.ok(opened[1].closed, 'Ctrl-C closes it');
});

test('the header says which deck, how many slides, when, and how to stop', () => {
  const line = watchHeader('deck.html', 3, new Date(2026, 10, 12, 9, 5, 7));
  assert.equal(line, 'check: deck.html · 3 slides · 09:05:07 · watching for saves, Ctrl-C stops');
});

test('--watch with --json is refused, saying what to run instead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-check-watch-'));
  const file = join(dir, 'deck.html');
  writeFileSync(file, '<section><h1>One</h1></section>');
  const err = [];
  const error = console.error;
  console.error = (...a) => err.push(a.join(' '));
  try { assert.equal(await checkMain([file, '--watch', '--json']), 1); }
  finally { console.error = error; rmSync(dir, { recursive: true, force: true }); }
  assert.match(err.join('\n'), /--watch is for a person at a terminal.*--json` once per edit/);
});

test('decklight check --watch prints a fresh report on each save and exits 0 on Ctrl-C', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-check-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'deck.html');
  writeFileSync(file, '<div class="decklight"><section><h1>One</h1></section></div>');
  await sleep(150);
  const said = [];
  const out = { isTTY: false, write: (s) => { said.push(s); } };
  const signals = new EventEmitter();
  const done = checkMain([file, '--watch', '--no-render'], { watchOpts: { signals, out, debounceMs: 40 } });
  assert.ok(await until(() => said.length === 1), 'the first check runs at once');
  assert.match(said[0], /^check: deck\.html · 1 slide · \d\d:\d\d:\d\d · watching for saves, Ctrl-C stops/);
  assert.match(said[0], /no findings/);
  await sleep(150);
  writeFileSync(file, '<div class="decklight"><section><h1>One</h1></section><section><img src="gone.png" alt=""></section></div>');
  assert.ok(await until(() => said.length === 2), 'a save prints the check again');
  assert.match(said[1], /2 slides/);
  assert.match(said[1], /missing asset: gone\.png/);
  signals.emit('SIGINT');
  assert.equal(await done, 0, 'interrupted is how a watch ends, and it is not a failure');
});
