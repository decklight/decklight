// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The git routes (cli/edit-git.mjs), called as functions.
//
// These are the routes that need the most of editMain, and the deps object
// they take says exactly what: the deck, the repository, and the commit
// bookkeeping editMain keeps for its timer and its agents, reached through
// functions, getters and setters. So the harness is a real repository in a
// temp directory (git is the one tool these routes cannot be honest without)
// and the bookkeeping as plain closures over this file's own variables, which
// is also how a test sees that a commit cleared the pending .gitattributes,
// reset the episode or dismissed the nag. Nothing here touches a network: the
// repository has no remote, which is itself an answer the routes give.
//
// What is NOT tested here is the dispatch (the table, the CSRF gate, the body
// read): test/edit.test.mjs holds that over a real socket. Nor are the routes
// that ask an agent to write a subject or a split, past the refusal a session
// started with --no-commit-messages gives before any agent is asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerGitRoutes } from '../cli/edit-git.mjs';
import { createHistory } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

const deckOf = (...titles) => `<!doctype html>
<html><head><title>t</title></head><body>
  <div class="decklight">
${titles.map((t) => `    <section>\n      <h2>${t}</h2>\n    </section>`).join('\n')}
  </div>
</body></html>
`;
const V1 = deckOf('Alpha', 'Beta');
const V2 = deckOf('Alpha', 'Beta, tightened', 'Gamma');

/**
 * A repository with the deck committed twice (V1, then V2), and the routes
 * registered over it with every binding editMain hands in. The commit
 * bookkeeping is a plain object the test can read and set: `book.pendingAttr`
 * is editMain's `let`, reached through a getter and a setter as it is there,
 * and every call the routes make into it is counted.
 */
function harness(t, { gitOn = true, subjectsOff = false } = {}) {
  const dir = tmp('edit-git', t);
  const deck = path.join(dir, 'talk.html');
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'tag.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  writeFileSync(deck, V1);
  g('add', 'talk.html');
  g('commit', '-qm', 'first version');
  writeFileSync(deck, V2);
  g('commit', '-qam', 'second version');

  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const sent = [];
  const book = {
    gitOn, pendingAttr: null,
    calls: { measureDirty: 0, resetEpisode: 0, clearPendingAttr: 0, dismissNag: 0 },
    state: { dirty: 0, nag: false },
  };
  const routes = new Map();
  registerGitRoutes(routes, {
    readDeck, history, broadcast: (e, d) => sent.push([e, d]), deckPath: deck, deckRel: 'talk.html', root: dir,
    gitOn: () => book.gitOn,
    agentPref: () => null,
    subjectsOff,
    describer: () => null,
    commitState: () => ({ ...book.state }),
    measureDirty: () => { book.calls.measureDirty++; },
    resetEpisode: () => { book.calls.resetEpisode++; },
    alsoNow: () => ({ also: [] }),
    alsoRels: () => [],
    attrRel: () => null,
    pendingAttr: () => book.pendingAttr,
    clearPendingAttr: () => { book.calls.clearPendingAttr++; book.pendingAttr = null; },
    dismissNag: () => { book.calls.dismissNag++; },
  });
  return { routes, history, readDeck, deck, dir, g, book, sent };
}

/** Call one route the way the dispatcher does: a fake `json`, no socket. */
async function call(routes, key, { body, query = '', res = {} } = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `no handler registered for ${key}`);
  const sent = {};
  const json = (code, obj) => { sent.code = code; sent.body = obj; };
  await handler({
    req: {},
    res,
    url: new URL(`http://x${key.split(' ')[1]}${query}`),
    body: body === undefined ? '' : JSON.stringify(body),
    json,
    CORS: {},
  });
  return sent;
}

/** A response the history preview can write its page to, as the server's own would take it. */
function fakeRes() {
  const r = { code: null, headers: null, body: null };
  return Object.assign(r, {
    writeHead(code, headers) { r.code = code; r.headers = headers; },
    end(body) { r.body = String(body); },
  });
}

test('every git route the server dispatches is registered here', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /deck/edit/commit',
    'GET /deck/edit/history',
    'GET /deck/edit/history/at',
    'GET /deck/edit/history/changes',
    'POST /deck/edit/commit',
    'POST /deck/edit/commit/dismiss',
    'POST /deck/edit/commit/plan',
    'POST /deck/edit/commit/push',
    'POST /deck/edit/commit/split',
    'POST /deck/edit/commit/subject',
    'POST /deck/edit/commit/tag',
    'POST /deck/edit/restore',
  ], 'a route that leaves this list has left the edit server too');
});

test('GET /deck/edit/commit measures the work NOW and says where the branch stands; with git off it only reports', async (t) => {
  const { routes, book } = harness(t);
  book.state = { dirty: 3, nag: true };
  const r = await call(routes, 'GET /deck/edit/commit');
  assert.equal(r.code, 200);
  assert.equal(book.calls.measureDirty, 1, 'a stale count is a lie about what you are agreeing to');
  assert.deepEqual([r.body.ok, r.body.dirty, r.body.nag, r.body.deck], [true, 3, true, 'talk.html']);
  assert.deepEqual(r.body.tags, []);
  assert.deepEqual([r.body.push.state, r.body.push.branch, r.body.push.remote, r.body.push.ahead], ['no-remote', 'main', null, 2],
    'no remote: both commits are only on this machine');

  book.gitOn = false;
  const off = await call(routes, 'GET /deck/edit/commit');
  assert.equal(book.calls.measureDirty, 1, 'git off: nothing to measure');
  assert.deepEqual(off.body, { ok: true, dirty: 3, nag: true, deck: 'talk.html' }, 'and no tags or push rows');
});

test('POST /deck/edit/commit commits the deck under the author\'s subject, clears the pending attribute and ends the episode', async (t) => {
  const { routes, g, deck, book, history } = harness(t);
  const next = V2.replace('Gamma', 'Gamma, with a point');
  writeFileSync(deck, next);
  book.pendingAttr = '/somewhere/.gitattributes';
  const r = await call(routes, 'POST /deck/edit/commit', { body: { message: '  tighten   the\nclose  ' } });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.ok, r.body.committed, r.body.subject], [true, true, 'tighten the close'],
    'one line, its whitespace folded, and nothing else rewritten');
  assert.deepEqual([r.body.undo, r.body.redo], [0, 0], 'the answer carries the undo counts');
  assert.equal(g('log', '-1', '--format=%s'), 'tighten the close');
  assert.equal(g('show', 'HEAD:talk.html'), next.trim(), 'the commit holds the bytes on disk');
  assert.equal(g('status', '--porcelain'), '');
  assert.deepEqual([book.pendingAttr, book.calls.clearPendingAttr, book.calls.resetEpisode], [null, 1, 1]);
  assert.equal(history.counts().undo, 0, 'a commit is not an edit: no undo entry');

  const again = await call(routes, 'POST /deck/edit/commit', { body: { message: 'again' } });
  assert.deepEqual([again.code, again.body.committed], [200, false], 'nothing to commit is the answer to pressing K twice, not an error');
  assert.equal(book.calls.resetEpisode, 1);
  assert.equal(g('rev-list', '--count', 'HEAD'), '3');
});

test('POST /deck/edit/commit keeps what follows a blank line as the body — a reviewed fix\'s rejections (#907)', async (t) => {
  const { routes, g, deck } = harness(t);
  writeFileSync(deck, V2.replace('Gamma', 'Gamma, fixed'));
  const r = await call(routes, 'POST /deck/edit/commit', {
    body: { message: 'fix: off-role on slides 2 and 3\n\nRejected in review:\n- slide 4: keep the stroke   \n' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.subject, 'fix: off-role on slides 2 and 3', 'the answer names the subject alone');
  assert.equal(g('log', '-1', '--format=%s'), 'fix: off-role on slides 2 and 3');
  assert.equal(g('log', '-1', '--format=%b').trim(), 'Rejected in review:\n- slide 4: keep the stroke');
});

test('POST /deck/edit/commit refuses a message-less commit, an option-shaped one is made safe, and git off is 409', async (t) => {
  const { routes, g, deck, book } = harness(t);
  writeFileSync(deck, V1);
  for (const body of [{}, { message: '   ' }, { message: null }]) {
    const r = await call(routes, 'POST /deck/edit/commit', { body });
    assert.deepEqual([r.code, r.body.error], [400, 'a commit needs a message'], JSON.stringify(body));
  }
  const dash = await call(routes, 'POST /deck/edit/commit', { body: { message: '--amend' } });
  assert.equal(dash.body.subject, 'agent: --amend', 'a subject never reaches git as an option');
  assert.equal(g('log', '-1', '--format=%s'), 'agent: --amend');

  book.gitOn = false;
  writeFileSync(deck, V2);
  const off = await call(routes, 'POST /deck/edit/commit', { body: { message: 'x' } });
  assert.equal(off.code, 409);
  assert.match(off.body.error, /open the deck with --git/);
  assert.equal(g('rev-list', '--count', 'HEAD'), '3', 'git off commits nothing');
});

test('POST /deck/edit/commit/dismiss is "not now": the nag is dismissed, the work stays uncommitted', async (t) => {
  const { routes, g, deck, book } = harness(t);
  writeFileSync(deck, V1);
  const r = await call(routes, 'POST /deck/edit/commit/dismiss');
  assert.deepEqual([r.code, r.body.ok, book.calls.dismissNag], [200, true, 1]);
  assert.match(g('status', '--porcelain'), /talk\.html/);
});

test('the agent-written subject and split are refused with --no-commit-messages before any agent is asked', async (t) => {
  const { routes } = harness(t, { subjectsOff: true });
  for (const key of ['POST /deck/edit/commit/subject', 'POST /deck/edit/commit/plan']) {
    const r = await call(routes, key);
    assert.equal(r.code, 403, key);
    assert.match(r.body.error, /--no-commit-messages/);
  }
});

test('POST /deck/edit/commit/split refuses a plan with nothing ticked, or a ticked commit with no message, and commits nothing', async (t) => {
  const { routes, g, deck } = harness(t);
  writeFileSync(deck, V1);
  const none = await call(routes, 'POST /deck/edit/commit/split', { body: { base: 'x', commits: [{ message: 'a', skip: true }] } });
  assert.deepEqual([none.code, none.body.code], [400, 'EMPTY']);
  const blank = await call(routes, 'POST /deck/edit/commit/split', { body: { base: 'x', commits: [{ message: 'a' }, { message: ' ' }] } });
  assert.deepEqual([blank.code, blank.body.error], [400, 'every commit needs a message']);
  assert.equal(g('rev-list', '--count', 'HEAD'), '2');
});

test('POST /deck/edit/commit/tag puts an annotated tag on HEAD, and refuses the same name twice', async (t) => {
  const { routes, g } = harness(t);
  const r = await call(routes, 'POST /deck/edit/commit/tag', { body: { name: ' v1.0 ' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.tag, 'v1.0');
  assert.deepEqual(r.body.tags, ['v1.0'], 'the answer is the window\'s tag row, read after the tag');
  assert.equal(g('cat-file', '-t', 'v1.0'), 'tag', 'annotated, so it travels with a push');
  assert.equal(g('rev-parse', 'v1.0^{commit}'), g('rev-parse', 'HEAD'));
  const twice = await call(routes, 'POST /deck/edit/commit/tag', { body: { name: 'v1.0' } });
  assert.deepEqual([twice.code, twice.body.code], [409, 'EXISTS']);
});

test('POST /deck/edit/commit/push with no remote is refused without reaching for one, and no page is told', async (t) => {
  const { routes, sent } = harness(t);
  const r = await call(routes, 'POST /deck/edit/commit/push');
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'BLOCKED');
  assert.deepEqual(sent, []);
});

test('GET /deck/edit/history lists the deck\'s versions newest first, with what each was and changed, and none marked pushed', async (t) => {
  const { routes, g } = harness(t);
  const r = await call(routes, 'GET /deck/edit/history');
  assert.equal(r.code, 200);
  const { entries, remote } = r.body;
  assert.deepEqual(entries.map((e) => e.subject), ['second version', 'first version']);
  assert.deepEqual(entries.map((e) => e.full), g('rev-list', 'HEAD').split('\n'));
  assert.deepEqual(entries.map((e) => e.slides), [3, 2], 'what each version WAS');
  assert.ok(entries[0].add > 0 && entries[0].del > 0, 'and what it CHANGED');
  assert.deepEqual(entries.map((e) => e.pushed), [null, null], 'no remote: "pushed" is not a question worth answering');
  assert.equal(remote.line, 'main · no remote — this history is only on this machine');

  const { routes: off, book } = harness(t);
  book.gitOn = false;
  assert.equal((await call(off, 'GET /deck/edit/history')).code, 409);
});

test('GET /deck/edit/history/changes names the slides a version changed and added, and refuses what is not a hash', async (t) => {
  const { routes, g } = harness(t);
  const head = g('rev-parse', 'HEAD');
  const r = await call(routes, 'GET /deck/edit/history/changes', { query: `?ref=${head}` });
  assert.equal(r.code, 200);
  assert.equal(r.body.ref, head.slice(0, 7));
  assert.equal(r.body.parent, g('rev-parse', '--short', 'HEAD^'));
  const kinds = r.body.stops.map((s) => `${s.kind}:${s.slide ?? s.was}`);
  assert.deepEqual(kinds, ['changed:2', 'added:3'], JSON.stringify(r.body));

  const first = await call(routes, 'GET /deck/edit/history/changes', { query: `?ref=${g('rev-parse', 'HEAD^')}` });
  assert.equal(first.body.parent, null, 'the first version has no parent');
  assert.deepEqual(first.body.stops.map((s) => s.kind), ['added', 'added'], 'everything in it was added');

  for (const ref of ['HEAD', '--all', '']) {
    assert.equal((await call(routes, 'GET /deck/edit/history/changes', { query: `?ref=${encodeURIComponent(ref)}` })).code, 400, ref);
  }
  assert.equal((await call(routes, 'GET /deck/edit/history/changes', { query: '?ref=deadbeef' })).code, 404);
});

test('GET /deck/edit/history/at serves an old version as a page rooted at /, and an unknown one as a 404 page', async (t) => {
  const { routes, g } = harness(t);
  const res = fakeRes();
  await call(routes, 'GET /deck/edit/history/at', { query: `?ref=${g('rev-parse', '--short', 'HEAD^')}`, res });
  assert.equal(res.code, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(res.body, /<head><base href="\/">/, 'served from /deck/edit/, so its relative paths need the root');
  assert.match(res.body, /<h2>Beta<\/h2>/);
  assert.doesNotMatch(res.body, /Gamma/, 'the version asked for, not the file on disk');

  const gone = fakeRes();
  await call(routes, 'GET /deck/edit/history/at', { query: '?ref=deadbeef', res: gone });
  assert.equal(gone.code, 404);
  assert.match(gone.body, /this version could not be previewed/);
  assert.match(gone.body, /no such revision of this deck/);
});

test('POST /deck/edit/restore writes the old version\'s bytes back as a new commit, and undo takes it back', async (t) => {
  const { routes, g, readDeck, history } = harness(t);
  const short = g('rev-parse', '--short', 'HEAD^');
  const r = await call(routes, 'POST /deck/edit/restore', { body: { ref: ` ${short} ` } });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.ok, r.body.short, r.body.changed, r.body.savedFirst], [true, short, true, false]);
  assert.equal(readDeck(), V1, 'the file on disk is the old version, byte for byte');
  assert.equal(g('log', '-1', '--format=%s'), `decklight: restore ${short}`, 'a new commit on top, history never rewritten');
  assert.equal(g('rev-list', '--count', 'HEAD'), '3');
  assert.equal(history.counts().undo, 1, 'one undo entry');
  assert.equal(history.undo(readDeck()), V2, 'and what it holds is the deck as it was before the restore');
});

test('POST /deck/edit/restore commits uncommitted work first, so nothing is lost on the way back', async (t) => {
  const { routes, g, deck, readDeck } = harness(t);
  const unsaved = V2.replace('Gamma', 'Gamma, unsaved');
  writeFileSync(deck, unsaved);
  const short = g('rev-parse', '--short', 'HEAD^');
  const r = await call(routes, 'POST /deck/edit/restore', { body: { ref: short } });
  assert.equal(r.body.savedFirst, true);
  assert.equal(readDeck(), V1);
  assert.equal(g('show', 'HEAD^:talk.html'), unsaved.trim(), 'the work in hand is the commit before the restore');
});

test('POST /deck/edit/restore refuses a ref git does not know and leaves the deck alone; no ref is a bad payload', async (t) => {
  const { routes, g, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /deck/edit/restore', { body: { ref: 'deadbeef' } });
  assert.equal(r.code, 400);
  assert.equal(r.body.ok, false);
  assert.equal(readDeck(), V2);
  assert.equal(g('rev-list', '--count', 'HEAD'), '2');
  assert.equal(history.counts().undo, 0);
  for (const body of [{}, { ref: '  ' }, { ref: 7 }]) {
    await assert.rejects(call(routes, 'POST /deck/edit/restore', { body }), /bad payload/, JSON.stringify(body));
  }

  const { routes: off, book } = harness(t);
  book.gitOn = false;
  assert.equal((await call(off, 'POST /deck/edit/restore', { body: { ref: 'HEAD' } })).code, 409);
});
