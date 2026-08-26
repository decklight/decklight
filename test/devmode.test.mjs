// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The "needs author mode" message every author-mode-gated action shares (SPEC PRESENTING). The
// point of the helper is that a deck opened by double-clicking it — the common
// case — gets told the folder to run from, and that every action says the same
// thing. The toasts themselves are DOM; this covers the text they carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChipText, elapsedLabel, needsDevMode, pushToastText, shortAge, AGE_UNIT } from '../src/core/devmode.js';

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

test('…and WHAT it is doing, once the server has heard', () => {
  const now = 1_000_000;
  assert.equal(agentChipText({ agent: 'claude', startedAt: now - 83_000, activity: 'editing talk.html' }, now),
    'claude · 1:23 — editing talk.html');
  // a clueless run is just the timer, exactly as before
  assert.equal(agentChipText({ agent: 'claude', startedAt: now - 83_000, activity: '   ' }, now), 'claude · 1:23');
  // somebody else's text is bounded, not trusted with the whole chip
  assert.equal(agentChipText({ agent: 'claude', activity: 'x'.repeat(200) }, now), `claude — ${'x'.repeat(60)}`);
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

// ── the one push nudge that interrupts ────────────────────────────────────

test('a repository with no remote is SILENT — that nudge belongs to init', () => {
  // Telling somebody to push when there is nowhere to push is noise, and the
  // moment a remote could actually be added is `decklight init`, once.
  assert.equal(pushToastText({ state: 'no-remote', unpushed: 50 }), null);
  assert.equal(pushToastText({ state: 'no-repo' }), null);
  assert.equal(pushToastText({ state: 'detached', unpushed: 20 }), null);
  assert.equal(pushToastText(null), null);
});

test('below the threshold, nothing is said', () => {
  // A handful of unpushed commits is a normal afternoon.
  assert.equal(pushToastText({ state: 'ok', ahead: 9, unpushed: 9 }), null);
  assert.equal(pushToastText({ state: 'ok', ahead: 0, unpushed: 0 }), null);
});

test('at the threshold it says how many, and where to look', () => {
  assert.equal(pushToastText({ state: 'ok', ahead: 10, unpushed: 10 }),
    '↑10 commits are only on this machine — H shows them');
  // A branch that tracks nothing counts what exists nowhere else instead.
  assert.equal(pushToastText({ state: 'no-upstream', unpushed: 12 }),
    '↑12 commits are only on this machine — H shows them');
});

test('once per session, by construction', () => {
  // The load-bearing guarantee: a limit expressed as a COUNT cannot decay into
  // "every few minutes" the way an interval-based nudge does — and an interval
  // nudge is the kind people turn off, after which the reminder is worth zero.
  assert.equal(pushToastText({ state: 'ok', ahead: 40, unpushed: 40 }, { shown: true }), null);
});

test('the threshold is a knob, so a test can state it rather than assume it', () => {
  assert.match(pushToastText({ state: 'ok', ahead: 3, unpushed: 3 }, { threshold: 3 }), /↑3 commits/);
});

// ── shortAge — the metadata line under a history subject ──────────────────
//
// The history rail is deliberately narrow (the preview is the point of that
// overlay), so the age rides on the metadata line as `18m` rather than
// `18 minutes ago`. Compressed in the runtime rather than asked of git,
// because `deckHistory`'s shape is the CLI's too and a fifth field would
// ripple into `decklight restore` and `decklight history` for a label only
// the overlay wants.

test('git\'s relative dates compress to a unit character', () => {
  const cases = [
    ['12 seconds ago', '12s'], ['1 minute ago', '1m'], ['18 minutes ago', '18m'],
    ['5 hours ago', '5h'], ['2 days ago', '2d'], ['3 weeks ago', '3w'],
    ['2 months ago', '2mo'], ['1 year ago', '1y'],
  ];
  for (const [long, short] of cases) assert.equal(shortAge(long), short, long);
});

test('months and years do not collide on m and y', () => {
  // `2m` for two months next to `2m` for two minutes would be a readout that
  // is wrong by a factor of forty thousand and looks identical.
  assert.notEqual(shortAge('2 months ago'), shortAge('2 minutes ago'));
  assert.equal(shortAge('2 months ago'), '2mo');
  assert.equal(shortAge('2 minutes ago'), '2m');
});

test('anything git words differently falls through unchanged', () => {
  // The parse is a shortcut, not a contract. Something it does not recognise
  // must arrive intact rather than become a guess or an empty cell — the row
  // still has to say WHEN, even if it says it the long way.
  for (const odd of ['just now', 'yesterday', '', 'in the future', '5 hours', 'ages ago']) {
    assert.equal(shortAge(odd), odd, JSON.stringify(odd));
  }
});

test('null and undefined are the empty string, not "undefined"', () => {
  // It is rendered straight into a row; the string "undefined" in a UI is
  // worse than a blank one.
  assert.equal(shortAge(null), '');
  assert.equal(shortAge(undefined), '');
});

test('every unit git can emit has a letter', () => {
  // A unit missing from the table would render as `18undefined`. Git's
  // relative dates come from exactly this set.
  for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']) {
    assert.match(shortAge(`7 ${unit}s ago`), /^7[a-z]+$/, unit);
  }
  assert.equal(Object.keys(AGE_UNIT).length, 7);
});
