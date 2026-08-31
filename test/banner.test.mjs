// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// author's startup banner. The two things worth pinning are the two things
// that were wrong before it existed: the deck's URL was not last, and the
// order depended on which process happened to wake up first.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { READY, ROW_ORDER, nextFlushDelay, parseReady, readyLine, renderBanner } from '../cli/banner.mjs';

const URL = 'http://127.0.0.1:8788/talk.html';
const base = { deck: 'talk.html', url: URL, keys: 'E edit · Ctrl-C stops' };

// ── the URL is the last thing, and the only loud thing ──────────────────────

test('the deck URL is the last line, whatever else is on the banner', () => {
  for (const rows of [
    [],
    [{ key: 'voice', text: 'say · Voice 1' }],
    ROW_ORDER.map((key) => ({ key, text: `${key} row` })),
  ]) {
    const out = renderBanner({ ...base, rows, keys: undefined });
    assert.equal(out.at(-1).includes(URL), true, `URL not last with ${rows.length} rows`);
  }
  // with the key hints on, the URL is still below every row — the hints belong
  // TO it, indented under it, and are not something to click
  const out = renderBanner({ ...base, rows: [{ key: 'voice', text: 'say' }] });
  const url = out.findIndex((l) => l.includes(URL));
  assert.equal(url, out.length - 2);
  assert.equal(out.findIndex((l) => l.includes('say')) < url, true, 'a row printed below the URL');
});

test('the URL is the only thing coloured, and only when a terminal asked', () => {
  const plain = renderBanner({ ...base, rows: [{ key: 'voice', text: 'say' }] });
  assert.equal(plain.some((l) => l.includes('\x1b[')), false, 'escape codes in non-tty output');

  const lit = renderBanner({ ...base, rows: [{ key: 'voice', text: 'say' }], color: true });
  const urlLine = lit.find((l) => l.includes(URL));
  assert.match(urlLine, /\x1b\[1m/, 'the URL is not bold');
  assert.match(urlLine, /\x1b\[36m/, 'the URL is not coloured');
  // the row text itself stays plain: colouring everything colours nothing
  const row = lit.find((l) => l.includes('say'));
  assert.equal(/\x1b\[(1|36)m/.test(row.slice(row.indexOf('say'))), false, 'row text competes with the URL');
});

// ── order is the banner's, not the processes' ───────────────────────────────

test('rows sort by ROW_ORDER however they arrived', () => {
  // Deliberately the reverse of ROW_ORDER: this is the race the banner exists
  // to absorb — the voice bridge is slow to introduce itself and used to land
  // last, after the URL.
  const rows = [...ROW_ORDER].reverse().map((key) => ({ key, text: `${key} row` }));
  const out = renderBanner({ ...base, rows });
  const seen = out.filter((l) => l.startsWith('  ') && !l.includes(URL) && !l.includes('E edit'))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(seen, ROW_ORDER);
});

test('a key nobody has heard of still appears, after the known ones', () => {
  const out = renderBanner({ ...base, rows: [{ key: 'wat', text: 'a new service' }, { key: 'voice', text: 'say' }] });
  const voice = out.findIndex((l) => l.includes('say'));
  const wat = out.findIndex((l) => l.includes('a new service'));
  assert.equal(voice < wat, true, 'an unknown key jumped the known ones');
  assert.equal(wat < out.findIndex((l) => l.includes(URL)), true, 'an unknown key fell below the URL');
});

test('a row with no text is not a row', () => {
  const out = renderBanner({ ...base, rows: [{ key: 'voice', text: '' }, { key: 'git' }, null] });
  assert.equal(out.some((l) => /\bvoice\b|\bgit\b/.test(l)), false);
});

// ── the child→author protocol ───────────────────────────────────────────────

test('a fact round-trips, and ordinary output is never mistaken for one', () => {
  const fact = { key: 'voice', text: 'say · Voice 1 (free · offline)' };
  assert.deepEqual(parseReady(readyLine(fact)), fact);
  assert.deepEqual(parseReady(readyLine({ url: URL, keys: 'E edit' })), { url: URL, keys: 'E edit' });

  // Everything a child might legitimately print stays a line to show someone.
  for (const line of [
    'decklight author on http://127.0.0.1:8788/talk.html — E element edit mode',
    '  agents: claude — “Ask agent” (A) is live',
    '', '{"key":"voice"}', 'decklight:ready {"key":"x"}',
  ]) assert.equal(parseReady(line), null, `mistook a human line for a fact: ${line}`);

  // A marked line that is not a fact is dropped, not crashed on: the sentinel
  // is a promise about the prefix, not about what follows it.
  for (const junk of ['not json', '[1,2]', '"a string"', 'null']) {
    assert.equal(parseReady(READY + junk), null, `accepted junk: ${junk}`);
  }
});

// ── when to print ───────────────────────────────────────────────────────────

test('the banner waits on names, not on a clock', () => {
  // THE BUG: a grace window alone printed the banner before the voice bridge
  // had introduced itself, and its row then landed under the URL.
  assert.equal(nextFlushDelay({ waiting: 1, elapsed: 0 }), null, 'printed while a service still owed a row');
  assert.equal(nextFlushDelay({ waiting: 2, elapsed: 4999 }), null);

  // Nobody owed: a short grace for the late (the review check is detached).
  assert.equal(nextFlushDelay({ waiting: 0, elapsed: 0, grace: 350 }), 350);

  // The cap is a ceiling on the total wait, not an extra delay on top of it.
  assert.equal(nextFlushDelay({ waiting: 0, elapsed: 4900, cap: 5000, grace: 350 }), 100);
  assert.equal(nextFlushDelay({ waiting: 0, elapsed: 9000, cap: 5000 }), 0, 'a negative delay');
});
