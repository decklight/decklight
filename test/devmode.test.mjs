// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The "needs author mode" message every author-mode-gated action shares (SPEC PRESENTING). The
// point of the helper is that a deck opened by double-clicking it — the common
// case — gets told the folder to run from, and that every action says the same
// thing. The toasts themselves are DOM; this covers the text they carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChipText, elapsedLabel, needsDevMode } from '../src/core/devmode.js';

const FILE = { protocol: 'file:', pathname: '/Users/gp/decks/talk.html' };
const HTTP = { protocol: 'https:', pathname: '/talks/talk.html' };

test('file:// names the containing folder and the deck', () => {
  const msg = needsDevMode('layout', FILE);
  assert.match(msg, /^layout needs author mode: /);
  assert.match(msg, /from \/Users\/gp\/decks, /);
  assert.match(msg, /run npx decklight author talk\.html/);
  assert.match(msg, /then reopen the URL it prints$/);
});

test('an http(s) origin gets the command but never a claimed folder', () => {
  const msg = needsDevMode('layout', HTTP);
  assert.match(msg, /run npx decklight author talk\.html/);
  assert.doesNotMatch(msg, /from \//, 'a URL path is not a filesystem path');
});

test('every action shares the one phrasing, and it is always `author`', () => {
  for (const action of ['layout', 'undo', 'redo', 'asking an agent', 'editing notes']) {
    for (const loc of [FILE, HTTP, {}]) {
      const msg = needsDevMode(action, loc);
      assert.ok(msg.startsWith(`${action} needs author mode: `), `${action}: ${msg}`);
      assert.match(msg, /npx decklight author /);
      // the inconsistency this replaced: the notes editor said `decklight edit`
      // — a command that no longer exists at all
      assert.doesNotMatch(msg, /decklight edit|decklight dev/, `${action} must name only \`author\``);
    }
  }
});

test('percent-escapes in a file path are decoded for display', () => {
  const msg = needsDevMode('layout', { protocol: 'file:', pathname: '/Users/gp/my%20decks/q3%20review.html' });
  assert.match(msg, /from \/Users\/gp\/my decks, /);
  assert.match(msg, /run npx decklight author q3 review\.html/);
});

test('a Windows file URL drops the URL-syntax leading slash', () => {
  const msg = needsDevMode('undo', { protocol: 'file:', pathname: '/C:/decks/talk.html' });
  assert.match(msg, /from C:\/decks, /);
});

test('an unreadable location still gives the command, with a placeholder deck', () => {
  for (const loc of [{}, { protocol: 'file:', pathname: '' }, { protocol: 'file:', pathname: '/talk' }]) {
    const msg = needsDevMode('layout', loc);
    assert.match(msg, /run npx decklight author /);
    assert.ok(!msg.includes('undefined'), msg);
  }
  assert.match(needsDevMode('layout', {}), /<deck\.html>/);
});

// ── "the agent is still working" ──────────────────────────────────────────
//
// An agent ask reported itself twice — a toast at the start, a toast at the end
// — and both expired in seconds. In between, for a run that can last minutes,
// the deck said nothing, and the only way to learn it was still going was to
// press A again and read the refusal. These cover the part of the fix that is
// decidable without a browser: what the chip says, and when it says nothing.

test('elapsed reads as a clock, and keeps counting past an hour', () => {
  assert.equal(elapsedLabel(0), '0:00');
  assert.equal(elapsedLabel(1_000), '0:01');
  assert.equal(elapsedLabel(61_000), '1:01');
  assert.equal(elapsedLabel(599_000), '9:59');
  // Not 0:00 again: an agent that has been going for an hour is the single
  // most important thing this chip can tell you, and a wrapped clock would
  // say the opposite of the truth.
  assert.equal(elapsedLabel(3_600_000), '1:00:00');
  assert.equal(elapsedLabel(3_661_000), '1:01:01');
});

test('seconds are always two digits, so the chip cannot jitter', () => {
  // Paired with font-variant-numeric: tabular-nums in the CSS. A width that
  // changes every second in the corner of a slide is a distraction.
  for (const s of [1, 9, 10, 59]) assert.match(elapsedLabel(s * 1000), /:\d\d$/);
});

test('a fraction of a second rounds down, never up to a second that has not passed', () => {
  assert.equal(elapsedLabel(999), '0:00');
  assert.equal(elapsedLabel(1_999), '0:01');
});

test('nothing running is no chip at all', () => {
  // Removed outright rather than hidden: a deck that never asks an agent never
  // grows the node.
  assert.equal(agentChipText(null), null);
  assert.equal(agentChipText(undefined), null);
  assert.equal(agentChipText({}), null, 'a job with no agent is not a job');
  assert.equal(agentChipText({ startedAt: Date.now() }), null);
});

test('a running job says who, and for how long', () => {
  const now = 1_000_000;
  assert.equal(agentChipText({ agent: 'claude', startedAt: now - 83_000 }, now), 'claude · 1:23');
});

test('the clock comes from the SERVER, so a reload does not restart it', () => {
  // startedAt rides in the `agent` start event and in /edit/ping. A page that
  // reloaded mid-run must show the true elapsed time — a job outlives the page,
  // and a chip that reset to 0:00 would claim otherwise.
  const now = 2_000_000;
  assert.equal(agentChipText({ agent: 'codex', startedAt: now - 305_000 }, now), 'codex · 5:05');
});

test('an unreadable timestamp still gets a chip, without a clock', () => {
  // Knowing an agent is running matters more than knowing for how long, so a
  // bad startedAt drops the duration and never the indicator.
  const now = 1_000_000;
  for (const bad of [undefined, null, 'soon', NaN, 0, -1, now + 5_000]) {
    assert.equal(agentChipText({ agent: 'bob', startedAt: bad }, now), 'bob', String(bad));
  }
});
