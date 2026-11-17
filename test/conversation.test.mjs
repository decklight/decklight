// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A conversation (SPEC DECK_ANATOMY, #1179): turns between a user, an agent
// and its tools. What is pure is here: which words are coloured as code, who
// speaks after whom, the turn writes Turn ▸ makes, the starter Add places,
// how `check` counts its builds and names a kind it does not know, and the
// theme gate for its bubbles. What the browser does with it (the bubbles,
// scroll-to-newest, print) is test/conversation-render.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeLanguage, callName, nextTurnRole, TURN_KINDS } from '../tools/conversation.mjs';
import { dedent } from '../src/core/conversation.js';
import { setConversationTurn, createHistory } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { insertStarter, ELEMENT_KINDS } from '../tools/starters.mjs';
import { buildSteps, buildClicks, parseTree, staticFindings } from '../cli/check.mjs';
import { attributeEntry, configFindings } from '../tools/vocabulary.mjs';
import { turnGates, validateTheme } from '../tools/theme-check.mjs';
import { tmp } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a tool turn is coloured as code when it parses as JSON or reads as a call, and words stay words', () => {
  assert.equal(codeLanguage('{ "status": "delayed", "eta": "Friday" }'), 'json');
  assert.equal(codeLanguage('[1, 2, 3]'), 'json');
  assert.equal(codeLanguage('get_order(4417)'), 'javascript');
  assert.equal(codeLanguage('search.query({ "q": "cache" })'), 'javascript');
  assert.equal(codeLanguage('  track_parcel("DHL",\n  "JD0144")  '), 'javascript', 'across lines');
  assert.equal(codeLanguage('{ not json'), null, 'a brace that does not parse is words');
  assert.equal(codeLanguage('The order is delayed (by weather).'), null);
  assert.equal(codeLanguage('"just a string"'), null, 'a JSON scalar is words');
  assert.equal(codeLanguage(''), null);
  assert.equal(callName('get_order(4417)'), 'get_order');
  assert.equal(callName('It is (late)'), null);
});

test('a turn written across lines in the file is shown at its own indentation', () => {
  assert.equal(dedent('{\n        "status": "delayed",\n        "eta": "Friday"\n      }'), '{\n  "status": "delayed",\n  "eta": "Friday"\n}');
  assert.equal(dedent('\n      get_order(4417)\n    '), 'get_order(4417)');
  assert.equal(dedent('one line'), 'one line');
});

test('who speaks next: the agent answers the user, the tool the call, the agent the tool, the user the agent', () => {
  assert.equal(nextTurnRole('user'), 'agent');
  assert.equal(nextTurnRole('agent', 'tool-call'), 'tool');
  assert.equal(nextTurnRole('tool'), 'agent');
  assert.equal(nextTurnRole('agent'), 'user');
  assert.equal(nextTurnRole('agent', 'thought'), 'user');
  assert.equal(nextTurnRole('system'), 'user');
  assert.equal(nextTurnRole('planner'), 'planner', 'a role of the author\'s own speaks again');
});

// ── the file: Turn ▸'s writes ───────────────────────────────────────────────

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Talk</h2>
    <div class="conversation" data-build>
      <p data-role="user">Where is my order?</p>
      <p data-role="agent" data-kind="tool-call">get_order(4417)</p>
    </div>
    <aside class="notes"></aside>
  </section>
  <section data-layout="split">
    <h2>Split</h2>
    <div><div class="conversation"><p data-role="user">Hi</p><p data-role="agent">Hello</p></div></div>
    <ul><li>a</li></ul>
  </section>
</div></body></html>`;

test('Turn ▸ writes one turn: its role, its kind (speech is none), a turn after it at its indentation, one removed', () => {
  const role = setConversationTurn(DECK, 1, 1, { path: [0], op: 'role', value: 'system' });
  assert.match(role.html, /<p data-role="system">Where is my order\?<\/p>/);
  const thought = setConversationTurn(DECK, 1, 1, { path: [0], op: 'kind', value: 'thought' });
  assert.match(thought.html, /<p data-role="user" data-kind="thought">Where/);
  const speech = setConversationTurn(DECK, 1, 1, { path: [1], op: 'kind', value: 'speech' });
  assert.match(speech.html, /<p data-role="agent">get_order\(4417\)<\/p>/, 'speech is the turn with no kind');
  // after a call, the tool answers, named after what was called, on its own line at the turn's indentation
  const added = setConversationTurn(DECK, 1, 1, { path: [1], op: 'add' });
  assert.deepEqual(added.path, [2]);
  assert.match(added.html, /get_order\(4417\)<\/p>\n {6}<p data-role="tool" data-name="get_order">New turn<\/p>\n {4}<\/div>/);
  // after the user, the agent; a conversation in a column is reached by its path
  const inColumn = setConversationTurn(DECK, 2, 1, { path: [0, 0], op: 'add' });
  assert.deepEqual(inColumn.path, [0, 1]);
  assert.match(inColumn.html, /<p data-role="user">Hi<\/p><p data-role="agent">New turn<\/p><p data-role="agent">Hello<\/p>/);
  const removed = setConversationTurn(DECK, 1, 1, { path: [0], op: 'remove' });
  assert.doesNotMatch(removed.html, /Where is my order/);
  assert.match(removed.html, /<div class="conversation" data-build>\n {6}<p data-role="agent"/, 'its line goes with it');
});

test('Turn ▸ refuses what is not a turn, a kind it does not know, and the last turn', () => {
  assert.throws(() => setConversationTurn(DECK, 1, 1, { path: [0], op: 'kind', value: 'monologue' }), /speech, thought, tool-call/);
  assert.throws(() => setConversationTurn(DECK, 1, 1, { path: [0], op: 'role', value: 'two words' }), /one word/);
  assert.throws(() => setConversationTurn(DECK, 1, 1, { path: [0], op: 'shout' }), /role, kind, add, remove/);
  assert.throws(() => setConversationTurn(DECK, 2, 2, { path: [0], tag: 'li', op: 'add' }), (e) => e.code === 'STALE', 'a list item is not a turn');
  const one = DECK.replace('      <p data-role="agent" data-kind="tool-call">get_order(4417)</p>\n', '');
  assert.throws(() => setConversationTurn(one, 1, 1, { path: [0], op: 'remove' }), /keeps one turn/);
});

test('POST /deck/edit/element/turn is one undo entry and answers the turn it leaves selected', async (t) => {
  const deck = path.join(tmp('conversation', t), 'talk.html');
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
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck });
  const call = async (body) => {
    const sent = {};
    await routes.get('POST /deck/edit/element/turn')({ req: {}, res: {}, url: new URL('http://x/deck/edit/element/turn'), body: JSON.stringify(body),
      json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
    return sent;
  };
  const r = await call({ slide: 1, index: 1, path: [0], tag: 'p', op: 'add' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.path, [1]);
  assert.equal(history.counts().undo, 1);
  assert.match(readDeck(), /<p data-role="agent">New turn<\/p>/);
  assert.equal((await call({ slide: 1, index: 1, path: [0], tag: 'p', op: 'kind', value: 'nope' })).code, 400);
  assert.equal((await call({ slide: 1, index: 1, path: [7], tag: 'p', op: 'add' })).code, 409, 'a turn the file does not have is stale');
  assert.equal((await call({ slide: 1, index: 1, op: 'add' })).code, 400, 'no path');
  assert.equal(history.counts().undo, 1, 'nothing refused was written');
});

// ── Add ▸ Conversation ──────────────────────────────────────────────────────

test('Add places a conversation that builds, a user, a call, the tool\'s answer and the agent\'s, in placeholders', () => {
  assert.ok(ELEMENT_KINDS.includes('conversation'));
  const { markup } = insertStarter(DECK, 1, null, 'conversation');
  assert.match(markup, /^<div class="conversation" data-build>\n {2}<p data-role="user">/);
  assert.deepEqual([...markup.matchAll(/data-role="(\w+)"/g)].map((m) => m[1]), ['user', 'agent', 'tool', 'agent']);
  assert.match(markup, /data-kind="tool-call">look_up\("the question"\)<\/p>/);
  assert.match(markup, /data-role="tool" data-name="look_up">\{ "answer": "what the tool found" \}<\/p>/);
  assert.doesNotMatch(markup, /#[0-9a-f]{3,8}\b/i, 'theme tokens only');
  // a column that is a conversation is one block: what goes beside it wraps it, as a figure is
  const split = DECK.replace('<div><div class="conversation"><p data-role="user">Hi</p><p data-role="agent">Hello</p></div></div>',
    '<div class="conversation"><p data-role="user">Hi</p><p data-role="agent">Hello</p></div>');
  assert.equal(insertStarter(split, 2, 1, 'text').wrapped, true);
});

// ── check: its builds and its words ─────────────────────────────────────────

const deck = (sections, config = null) => `<!doctype html><html><head>${config ? `<script type="application/json" data-decklight-config>${JSON.stringify(config)}</script>` : ''}</head>
<body><div class="decklight">
${sections}
</div></body></html>`;
const everything = { dir: '/decks', exists: () => true };

test('a conversation builds one turn a click, as a list does: data-build-order ties turns, data-build-with joins one to the one before', () => {
  const turns = '<p data-role="user">a</p><p data-role="agent" data-kind="thought">b</p><p data-role="agent">c</p>';
  assert.equal(buildSteps(parseTree(`<div class="conversation" data-build>${turns}</div>`)), 3);
  assert.equal(buildSteps(parseTree(`<div class="conversation" data-build="highlight">${turns}</div>`)), 3);
  assert.equal(buildClicks(parseTree(`<div class="conversation" data-build><p data-role="user">a</p><p data-role="agent" data-build-with>b</p><p data-role="agent">c</p></div>`)), 2);
  assert.equal(buildClicks(parseTree(`<div class="conversation" data-build><p data-role="user" data-build-order="2">a</p><p data-role="agent" data-build-order="1">b</p><p data-role="agent" data-build-order="1">c</p></div>`)), 2);
  // the notes' beats agree with it, and the checker says nothing
  const agree = deck(`<section><h2>Talk</h2><div class="conversation" data-build>${turns}</div>
    <aside class="notes"><p>[click]</p><p>Asked.</p><p>[click]</p><p>Thinks.</p><p>[click]</p><p>Answers.</p></aside></section>`);
  assert.deepEqual(staticFindings(agree, everything).filter((f) => f.rule === 'clicks-vs-builds'), []);
});

test('check names a turn kind it does not know, with the one meant; the role, the tool\'s name and roleConcepts are words it reads', () => {
  const html = deck(`<section><h2>Talk</h2><div class="conversation">
    <p data-role="user">a</p><p data-role="agent" data-kind="thougth">b</p><p data-role="tool" data-name="get_order" data-kind="tool-call">c()</p>
    <p data-role="planner" data-concept="agent">d</p></div></section>`, { decklight: '0.10.0', roleConcepts: { agent: 'agent' } });
  const found = staticFindings(html, everything);
  const kinds = found.filter((f) => f.rule === 'unknown-value');
  assert.equal(kinds.length, 1);
  assert.match(kinds[0].message, /data-kind="thougth" is not a turn kind: did you mean thought\? It takes speech, thought or tool-call/);
  assert.deepEqual(found.filter((f) => f.rule === 'unknown-attribute' || f.rule === 'config-key'), []);
  assert.deepEqual(attributeEntry('data-kind').values, TURN_KINDS);
  assert.deepEqual(configFindings(JSON.stringify({ roleConcept: {} })).map((f) => f.message), ['"roleConcept" is not a configuration key Decklight reads: did you mean "roleConcepts"? As written it does nothing']);
});

// ── a theme's bubbles ───────────────────────────────────────────────────────

test('a conversation\'s bubbles read as body text: the block\'s ground and the body ink, the accent and its contrast, unless the theme sets its own', () => {
  const light = { bg: '#fdf6e3', fg: '#5e737a', 'block-bg': '#ece9e0', accent: '#1f5f8f', 'accent-contrast': '#ffffff' };
  const faint = turnGates(light);
  assert.equal(faint.length, 1);
  assert.match(faint[0].message, /--fg on --block-bg: 4\.\d\d < 4\.5 — a conversation's turn would not read: set --turn-bg and --turn-ink/);
  assert.deepEqual(turnGates({ ...light, 'turn-ink': '#4c6066' }), [], 'its own ink reads');
  // a translucent block is read over every stop of the slide
  const glass = { bg: 'linear-gradient(#0b1020, #ffffff)', fg: '#f0f0f0', 'block-bg': 'rgba(0, 0, 0, 0.2)', accent: '#000', 'accent-contrast': '#fff' };
  assert.equal(turnGates(glass).length, 1, 'light words on a faint dark glass fail over the white end');
  const user = turnGates({ ...light, 'turn-ink': '#333', 'turn-user-bg': '#f0c090', 'turn-user-ink': '#ffffff' });
  assert.match(user[0].message, /--turn-user-ink on --turn-user-bg: .* — a user's turn would not read/);
  // a theme from elsewhere still applies: a warning; the shipped one sets its own ink
  const shipped = readFileSync(path.join(ROOT, 'themes', 'reveal-solarized.css'), 'utf8');
  const older = shipped.replace(/\n\s*--turn-ink:[^\n]*/, '');
  assert.notEqual(older, shipped);
  const r = validateTheme(older);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /set --turn-bg and --turn-ink/.test(w)), JSON.stringify(r.warnings));
  assert.deepEqual(validateTheme(shipped).warnings, []);
});
