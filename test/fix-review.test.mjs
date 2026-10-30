// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A quick fix reviewed before it lands (#907): the merge a partial apply
// makes (cli/fix-review.mjs), the routes that hold, show, apply, adjust and
// discard the candidate, called as functions over a temp deck, and the step
// comparison the review view stops by (src/core/fixreview.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  deckParts, candidateUnits, mergeCandidate, commitDraft, notesText, changedLines, registerFixReviewRoutes, adjustPrompt,
} from '../cli/fix-review.mjs';
import { createHistory } from '../cli/edit.mjs';
import { changedSteps, reviewMode, nextView } from '../src/core/fixreview.js';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html>
<html><head><style>.a { color: red; }</style></head><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <aside class="notes">first [click] second</aside>
    </section>

    <section>
      <h2>Beta</h2>
      <svg><rect data-concept="agent" fill="red"/></svg>
    </section>
    <section>
      <h2>Gamma</h2>
      <p>three</p>
    </section>
  </div>
  <script type="application/json" data-decklight-config>{ "decklight": "0.10.0" }</script>
</body></html>
`;

/** The fix: the head's style, slide 1's notes, slide 2's fill, and slide 3 replaced by another (a removal and an addition). */
const FIXED = DECK
  .replace('color: red', 'color: blue')
  .replace('first [click] second', 'first [click] the second, said better')
  .replace(' fill="red"', '')
  .replace(`    <section>
      <h2>Gamma</h2>
      <p>three</p>
    </section>`, `    <section>
      <h2>Delta</h2>
      <p>four, which is new</p>
    </section>`);

test('deckParts cuts a deck at its slides and puts it back byte for byte', () => {
  const p = deckParts(DECK);
  assert.equal(p.slides.length, 3);
  assert.equal(p.prefix + p.slides.map((s, i) => s + (p.gaps[i] ?? '')).join('') + p.suffix, DECK);
  assert.match(p.slides[1], /^ {4}<section>[\s\S]*Beta[\s\S]*<\/section>$/);
});

test('candidateUnits: the head, each changed slide with its notes diff, in reading order', () => {
  const units = candidateUnits(DECK, FIXED);
  assert.deepEqual(units.map((u) => [u.key, u.kind]), [['head', 'head'], ['s1', 'changed'], ['s2', 'changed'], ['s3', 'removed'], ['a3', 'added']]);
  assert.deepEqual(units[1].notes, { before: 'first [click] second', after: 'first [click] the second, said better' });
  assert.equal(units[2].notes, undefined, 'a slide whose notes did not change carries no notes diff');
  assert.equal(units[2].title, 'Beta');
});

test('an added and a removed slide are their own units, keyed so an adjustment cannot move them', () => {
  const added = DECK.replace('  </div>\n  <script', `    <section>
      <h2>Epsilon</h2>
    </section>
  </div>
  <script`);
  assert.deepEqual(candidateUnits(DECK, added).map((u) => [u.key, u.kind, u.slide ?? u.was]), [['a4', 'added', 4]]);
  const removed = DECK.replace(`    <section>
      <h2>Beta</h2>
      <svg><rect data-concept="agent" fill="red"/></svg>
    </section>
`, '');
  assert.deepEqual(candidateUnits(DECK, removed).map((u) => [u.key, u.kind, u.was]), [['s2', 'removed', 2]]);
});

test('mergeCandidate: all is the fix exactly, none is the deck exactly, and a slide is taken on its own', () => {
  const keys = candidateUnits(DECK, FIXED).map((u) => u.key);
  assert.equal(mergeCandidate(DECK, FIXED, keys), FIXED);
  assert.equal(mergeCandidate(DECK, FIXED, []), DECK);
  const onlyFill = mergeCandidate(DECK, FIXED, ['s2']);
  assert.match(onlyFill, /<rect data-concept="agent"\/>/, 'the approved slide comes from the fix');
  assert.match(onlyFill, /color: red/, 'the head stays as it is');
  assert.match(onlyFill, /first \[click\] second</, 'an undecided slide stays as it is');
  assert.match(onlyFill, /Gamma/, 'a rejected slide stays as it is');
  assert.equal(deckParts(onlyFill).slides.length, 3);
  const headOnly = mergeCandidate(DECK, FIXED, ['head']);
  assert.match(headOnly, /color: blue/);
  assert.match(headOnly, /fill="red"/);
});

test('mergeCandidate keeps a removed slide unless the removal is approved, and an added one only when it is', () => {
  const after = DECK.replace(`    <section>
      <h2>Beta</h2>
      <svg><rect data-concept="agent" fill="red"/></svg>
    </section>
`, '').replace('  </div>\n  <script', `    <section>
      <h2>Epsilon</h2>
    </section>
  </div>
  <script`);
  const units = candidateUnits(DECK, after);
  assert.deepEqual(units.map((u) => u.key), ['s2', 'a3']);
  const titles = (html) => deckParts(html).slides.map((s) => /<h2>(\w+)/.exec(s)[1]);
  assert.deepEqual(titles(mergeCandidate(DECK, after, ['a3'])), ['Alpha', 'Beta', 'Gamma', 'Epsilon']);
  assert.deepEqual(titles(mergeCandidate(DECK, after, ['s2'])), ['Alpha', 'Gamma']);
});

test('the head unit carries only the lines of it that changed, cut short for a bundled deck', () => {
  const head = candidateUnits(DECK, FIXED)[0];
  assert.deepEqual(head.lines, { before: '<html><head><style>.a { color: red; }</style></head><body>', after: '<html><head><style>.a { color: blue; }</style></head><body>' });
  const many = Array.from({ length: 100 }, (_, i) => `rule ${i}`);
  const cut = changedLines(['same', ...many, 'end'].join('\n'), ['same', ...many.map((l) => `${l}!`), 'end'].join('\n'), 3);
  assert.equal(cut.before, 'rule 0\nrule 1\nrule 2\n… 97 more lines');
});

test('notesText reads an aside as its words', () => {
  assert.equal(notesText('<section><aside class="notes">one<br>two &amp; <b>three</b></aside></section>'), 'one\ntwo & three');
  assert.equal(notesText('<section><h2>x</h2></section>'), '');
});

test('commitDraft names the slides that landed and puts the rejections in the body', () => {
  const units = candidateUnits(DECK, FIXED);
  assert.deepEqual(commitDraft('fix: off-role on slide 2', units, new Set(['s1', 's2'])), { subject: 'fix: off-role on slides 1 and 2', body: '' });
  const d = commitDraft('fix: off-role', units, new Set(['s2']), [{ key: 's3', comment: 'keep  Gamma,\nit is fine' }, { key: 'head', comment: '' }]);
  assert.equal(d.subject, 'fix: off-role on slide 2');
  assert.equal(d.body, 'Rejected in review:\n- slide 3 (removed): keep Gamma, it is fine\n- the deck');
  assert.equal(commitDraft('fix: theme-off-brand', units, new Set(['head'])).subject, 'fix: theme-off-brand');
});

test('adjustPrompt confines the agent to the one slide and carries the reviewer\'s words', () => {
  const p = adjustPrompt({ slide: 4, title: 'Agents' }, 'keep the stroke', 'fix: off-role on slide 4');
  assert.match(p, /On slide 4 \("Agents"\)/);
  assert.match(p, /keep the stroke/);
  assert.match(p, /leave every other slide exactly as it is/);
});

// ── the routes ──────────────────────────────────────────────────────────

function harness(t, deps = {}) {
  const dir = tmp('fix-review', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileSync(deck, next);
    return true;
  };
  const events = [];
  const saved = [];
  const routes = new Map();
  const review = registerFixReviewRoutes(routes, {
    readDeck, applyEdit, broadcast: (e, d) => events.push([e, d]), saveBefore: (w) => saved.push(w), ...deps,
  });
  return { routes, review, history, readDeck, deck, events, saved };
}

async function call(routes, key, { body, query = '' } = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `no handler registered for ${key}`);
  const sent = {};
  await handler({
    req: {},
    res: { writeHead: (code, headers) => { sent.code = code; sent.headers = headers; }, end: (text) => { sent.text = text; } },
    url: new URL(`http://x${key.split(' ')[1]}${query}`),
    body: body === undefined ? '' : JSON.stringify(body),
    json: (code, obj) => { sent.code = code; sent.body = obj; },
    CORS: {},
  });
  return sent;
}

test('a held fix writes nothing, and the review reads it slide by slide', async (t) => {
  const { routes, review, readDeck } = harness(t);
  assert.equal((await call(routes, 'GET /deck/edit/candidate')).code, 404);
  const h = review.hold({ before: DECK, after: FIXED, what: 'fix: off-role on slide 2', rule: 'off-role', slide: 2 });
  assert.equal(h.ok, true);
  assert.equal(readDeck(), DECK, 'holding a fix leaves the deck file as it was');
  const r = await call(routes, 'GET /deck/edit/candidate');
  assert.equal(r.code, 200);
  assert.equal(r.body.id, h.id);
  assert.deepEqual(r.body.units.map((u) => u.key), ['head', 's1', 's2', 's3', 'a3']);
  const before = await call(routes, 'GET /deck/edit/candidate/at', { query: `?id=${h.id}&side=before` });
  const after = await call(routes, 'GET /deck/edit/candidate/at', { query: `?id=${h.id}&side=after` });
  assert.equal(before.code, 200);
  assert.match(before.text, /<base href="\/">/, 'served from under /deck/edit/, it resolves from the root');
  assert.match(before.text, /fill="red"/);
  assert.doesNotMatch(after.text, /fill="red"/);
  assert.equal((await call(routes, 'GET /deck/edit/candidate/at', { query: '?id=nope&side=after' })).code, 404);
});

test('apply writes the approved slides as ONE undo entry and drafts the commit', async (t) => {
  const { routes, review, readDeck, history, saved } = harness(t);
  const h = review.hold({ before: DECK, after: FIXED, what: 'fix: off-role on slide 2', rule: 'off-role' });
  const r = await call(routes, 'POST /deck/edit/candidate/apply', {
    body: { id: h.id, take: ['s1', 's2'], rejected: [{ key: 's3', comment: 'Gamma stays' }] },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.said, 'applied 2 of 5 · 1 rejected · 2 left out');
  assert.deepEqual(r.body.commit, { subject: 'fix: off-role on slides 1 and 2', body: 'Rejected in review:\n- slide 3 (removed): Gamma stays' });
  assert.deepEqual(history.counts(), { undo: 1, redo: 0 });
  assert.deepEqual(saved, ['fix: off-role on slide 2'], 'the outstanding work is saved before the fix lands');
  const now = readDeck();
  assert.match(now, /<rect data-concept="agent"\/>/);
  assert.match(now, /said better/);
  assert.match(now, /color: red/);
  assert.match(now, /Gamma/);
  assert.doesNotMatch(now, /Delta/, 'an added slide left undecided is not added');
  assert.equal(review.held(), null, 'an applied fix is not held any more');
  assert.equal((await call(routes, 'POST /deck/edit/candidate/apply', { body: { id: h.id, take: ['s1'] } })).code, 404);
});

test('apply is refused when the deck moved under the review, and nothing approved writes nothing', async (t) => {
  const { routes, review, deck, history } = harness(t);
  let h = review.hold({ before: DECK, after: FIXED, what: 'fix: off-role' });
  writeFileSync(deck, DECK.replace('Alpha', 'Alpha, edited by hand'));
  const moved = await call(routes, 'POST /deck/edit/candidate/apply', { body: { id: h.id, take: ['s2'] } });
  assert.equal(moved.code, 409);
  assert.equal(moved.body.code, 'MOVED');
  writeFileSync(deck, DECK);
  h = review.hold({ before: DECK, after: FIXED, what: 'fix: off-role' });
  const none = await call(routes, 'POST /deck/edit/candidate/apply', { body: { id: h.id, take: [] } });
  assert.equal(none.code, 200);
  assert.equal(none.body.changed, false);
  assert.deepEqual(history.counts(), { undo: 0, redo: 0 });
});

test('discard drops the candidate and leaves the deck alone; a new fix replaces one never applied', async (t) => {
  const { routes, review, readDeck } = harness(t);
  const first = review.hold({ before: DECK, after: FIXED, what: 'fix: a' });
  const second = review.hold({ before: DECK, after: FIXED.replace('Delta', 'Omega'), what: 'fix: b' });
  assert.notEqual(first.id, second.id);
  assert.equal((await call(routes, 'GET /deck/edit/candidate', { query: `?id=${first.id}` })).code, 404);
  const r = await call(routes, 'POST /deck/edit/candidate/discard', { body: { id: second.id } });
  assert.deepEqual(r.body, { ok: true, discarded: true });
  assert.equal(review.held(), null);
  assert.equal(readDeck(), DECK);
});

test('adjust hands one slide to the agent, and the adjusted candidate comes back as a candidate event', async (t) => {
  const asked = [];
  const { routes, review, events } = harness(t, {
    adjust: async ({ candidate, unit, comment }) => { asked.push({ id: candidate.id, key: unit.key, comment }); return { ok: true, agent: 'claude' }; },
  });
  const h = review.hold({ before: DECK, after: FIXED, what: 'fix: off-role' });
  assert.equal((await call(routes, 'POST /deck/edit/candidate/adjust', { body: { id: h.id, key: 's2', comment: '' } })).code, 400);
  const r = await call(routes, 'POST /deck/edit/candidate/adjust', { body: { id: h.id, key: 's2', comment: 'keep a stroke' } });
  assert.equal(r.code, 200);
  assert.deepEqual(asked, [{ id: h.id, key: 's2', comment: 'keep a stroke' }]);
  // while the agent works the candidate cannot be applied
  assert.equal((await call(routes, 'POST /deck/edit/candidate/apply', { body: { id: h.id, take: ['s2'] } })).code, 409);
  review.adjusted(h.id, FIXED.replace('<rect data-concept="agent"/>', '<rect data-concept="agent" stroke="black"/>'), 's2');
  assert.deepEqual(events.at(-1), ['candidate', { id: h.id, rev: 2, adjusted: 's2', ok: true }]);
  const now = await call(routes, 'GET /deck/edit/candidate');
  assert.equal(now.body.rev, 2);
  assert.equal(now.body.adjusting, null);
  const after = await call(routes, 'GET /deck/edit/candidate/at', { query: `?id=${h.id}&side=after` });
  assert.match(after.text, /stroke="black"/);
});

test('adjust without an agent, or on a removed slide, says why', async (t) => {
  const { routes, review } = harness(t);
  const h = review.hold({ before: DECK, after: FIXED, what: 'fix: x' });
  const r = await call(routes, 'POST /deck/edit/candidate/adjust', { body: { id: h.id, key: 's2', comment: 'more' } });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /no agent/);
});

// ── the review view's stops ─────────────────────────────────────────────

test('changedSteps stops only at the build steps whose render differs', () => {
  assert.deepEqual(changedSteps(['a', 'b', 'c'], ['a', 'B', 'c']), [1]);
  assert.deepEqual(changedSteps(['a', 'b'], ['a', 'b', 'c']), [2], 'a step only one version has is a change');
  assert.deepEqual(changedSteps(['x', 'y'], ['X', 'Y']), [0, 1]);
  assert.deepEqual(changedSteps(['a'], ['a']), [0], 'a change the renders cannot see still gets one stop');
  assert.deepEqual(changedSteps(null, ['a']), [0]);
});

test('a slide whose notes are the whole change is marked notesOnly; one that also looks different is not', () => {
  const deck = (body, notes) => `<!doctype html><div class="decklight">\n<section>\n<h2>One</h2>\n<p>${body}</p>\n<aside class="notes"><p>${notes}</p></aside>\n</section>\n<section>\n<h2>Two</h2>\n</section>\n</div>`;
  const before = deck('A point.', 'Terse.');
  const notes = candidateUnits(before, deck('A point.', 'And now, said out loud.'));
  assert.deepEqual(notes.map((u) => [u.key, u.notesOnly === true, u.notes.after]), [['s1', true, 'And now, said out loud.']]);
  const both = candidateUnits(before, deck('A tighter point.', 'And now, said out loud.'));
  assert.deepEqual(both.map((u) => [u.key, u.notesOnly === true]), [['s1', false]]);
  const look = candidateUnits(before, deck('A tighter point.', 'Terse.'));
  assert.equal(look[0].notes, undefined, 'no notes diff when the notes did not change');
  assert.equal(look[0].notesOnly, undefined);
});

test('a slide that changed only in punctuation says so; a changed letter does not', () => {
  const deck = (body) => `<!doctype html><div class="decklight">\n<section>\n<ul><li>${body}</li></ul>\n</section>\n</div>`;
  const before = deck("Data freshness is not a nice-to-have, it's a requirement");
  const [semi] = candidateUnits(before, deck("Data freshness is not a nice-to-have; it's a requirement"));
  assert.equal(semi.punctuationOnly, true);
  const [typo] = candidateUnits(before, deck("Data freshness is not a nice-to-have, its a requirement"));
  assert.equal(typo.punctuationOnly, true, 'a dropped apostrophe is punctuation');
  const [word] = candidateUnits(before, deck("Data freshness is not a nice-to-have, it's the requirement"));
  assert.equal(word.punctuationOnly, undefined);
});

test('reviewMode: text when every unit is a notes-only slide, the slides otherwise; D cycles the three views', () => {
  assert.equal(reviewMode([{ kind: 'changed', notesOnly: true }, { kind: 'changed', notesOnly: true }]), 'text');
  assert.equal(reviewMode([{ kind: 'changed', notesOnly: true }, { kind: 'changed' }]), 'slide');
  assert.equal(reviewMode([{ kind: 'head' }]), 'slide');
  assert.equal(reviewMode([]), 'slide');
  assert.deepEqual(['diff', 'side', 'slides'].map(nextView), ['side', 'slides', 'diff']);
});
