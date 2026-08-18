// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `--commit-messages`: an agent writes the subject decklight would otherwise
// template (SPEC PRESENTING).
//
// Two properties carry the whole feature, and both are about what happens when
// the agent does NOT cooperate.
//
// The commit must already exist. Autocommit is a safety net, and a net that
// waits on a language model is not one — so the subject arrives afterwards, as
// an amend, and every failure mode costs a generically-worded commit rather
// than a lost one.
//
// And the amend must be a formatting change, never a rewrite. It touches one
// message, on the tip, seconds old, that nothing is built on and nowhere else
// has. The moment any of that stops being true it must refuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAX_DIFF, amendSubject, amendable, changeDiff, describeCommit, messagePrompt,
  messagesLine, subjectFrom,
} from '../cli/commit-message.mjs';
import { AGENTS, agentAsk } from '../cli/agents.mjs';

// ── reading the agent's answer ───────────────────────────────────────────

test('a bare line is taken as-is', () => {
  assert.equal(subjectFrom('cut the pour-over slide to one claim'),
    'cut the pour-over slide to one claim');
});

test('the framing every CLI adds is stripped', () => {
  // Each of these is a real shape: a preamble, a fenced block, a bulleted
  // answer, a log banner the CLI prints around its own output.
  const cases = [
    ["Here's the commit message:\n\nadd a grind slide", 'add a grind slide'],
    ['```\nadd a grind slide\n```', 'add a grind slide'],
    ['- add a grind slide', 'add a grind slide'],
    ['"add a grind slide"', 'add a grind slide'],
    ['`add a grind slide`', 'add a grind slide'],
    ['add a grind slide.', 'add a grind slide'],
    ['[info] loading config\nadd a grind slide', 'add a grind slide'],
    ['Sure! Here you go:\nadd a grind slide', 'add a grind slide'],
  ];
  for (const [raw, want] of cases) assert.equal(subjectFrom(raw), want, JSON.stringify(raw));
});

test('the LAST line wins, because the answer follows the preamble', () => {
  assert.equal(subjectFrom('thinking about this…\nthe change adds a slide\ntrim the intro to one line'),
    'trim the intro to one line');
});

test('nothing usable is null, not a guess', () => {
  for (const raw of ['', '   ', '\n\n', null, undefined, '```\n```', 'Here you go:']) {
    assert.equal(subjectFrom(raw), null, JSON.stringify(raw));
  }
});

// ── the prompt ───────────────────────────────────────────────────────────

test('the prompt asks for one line and says what to do with nothing', () => {
  const p = messagePrompt({ deck: 'deck.html', diff: '+<h2>x</h2>', truncated: false,
    template: 'decklight: autosave deck.html' });
  assert.match(p, /ONE line/);
  assert.match(p, /72 characters/);
  assert.match(p, /nothing else/);
  // the escape hatch, so "I cannot tell" has an answer that is not invention
  assert.match(p, /decklight: autosave deck\.html/);
  assert.match(p, /\+<h2>x<\/h2>/);
});

test('a truncated diff is declared, not quietly shortened', () => {
  // An agent that does not know it is seeing part of a change writes a
  // confident subject about a change it never read.
  const p = messagePrompt({ deck: 'd.html', diff: 'x', truncated: true, template: 't' });
  assert.match(p, /TRUNCATED/);
  assert.doesNotMatch(messagePrompt({ deck: 'd.html', diff: 'x', truncated: false, template: 't' }), /TRUNCATED/);
});

test('the diff is capped, because a deck is one enormous file', () => {
  // Swapping a theme rewrites a 70 KB <style> block; a bundled deck carries
  // its whole runtime inline. Sending all of it is slower, dearer, and harder
  // to summarise than sending the front of it.
  const huge = 'x'.repeat(MAX_DIFF * 3);
  const out = changeDiff('/x', 'abc', 'deck.html', { run: () => huge });
  assert.equal(out.diff.length, MAX_DIFF);
  assert.equal(out.truncated, true);
  const small = changeDiff('/x', 'abc', 'deck.html', { run: () => 'short' });
  assert.deepEqual(small, { diff: 'short', truncated: false });
});

// ── the amend guard, against a real repository ───────────────────────────

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-msg-'));
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  const deck = path.join(dir, 'deck.html');
  const commit = (html, msg) => {
    fs.writeFileSync(deck, html);
    g(['add', '-A']);
    g(['commit', '-qm', msg]);
    return g(['rev-parse', 'HEAD']);
  };
  return { dir, deck, g, commit };
};

test('the tip of a local branch may be amended', () => {
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  assert.equal(amendable(r.dir, sha), true);
  assert.equal(amendSubject(r.dir, sha, 'add the first slide'), true);
  assert.equal(r.g(['log', '-1', '--format=%s']), 'add the first slide');
  // the tree is untouched — this rewords, it does not re-commit
  assert.equal(fs.readFileSync(r.deck, 'utf8'), '<section>a</section>');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a commit that is no longer the tip is refused', () => {
  // The race this exists for: the agent flow's own commit, a restore, or a
  // second cadence tick landing while the agent was still thinking. Rewriting
  // anything below the tip is not something this feature may do.
  const r = repo();
  const first = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  r.commit('<section>a</section><section>b</section>', 'decklight: autosave deck.html');
  assert.equal(amendable(r.dir, first), false);
  assert.equal(amendSubject(r.dir, first, 'should not happen'), false);
  assert.equal(r.g(['log', '-1', '--format=%s']), 'decklight: autosave deck.html');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a commit that reached a remote is refused', () => {
  // Amending something somebody else may have is a rewrite of shared history,
  // which is the one thing this must never do — and the check works with no
  // upstream configured, because `--remotes` asks about refs, not tracking.
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-msg-remote-'));
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' });
  r.g(['remote', 'add', 'origin', bare]);
  assert.equal(amendable(r.dir, sha), true, 'nothing is pushed yet');
  r.g(['push', '-q', 'origin', 'main']);
  assert.equal(amendable(r.dir, sha), false, 'a pushed commit was still considered amendable');
  fs.rmSync(r.dir, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

// ── the whole flow ───────────────────────────────────────────────────────

const fakeAgent = (answer) => async () => answer;

test('a subject the agent wrote replaces the template', async () => {
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  const out = await describeCommit({
    cwd: r.dir, sha, deckPath: r.deck, template: 'decklight: autosave deck.html',
    exec: fakeAgent('add the opening slide'),
  });
  assert.equal(out, 'add the opening slide');
  assert.equal(r.g(['log', '-1', '--format=%s']), 'add the opening slide');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('every way the agent can fail leaves the commit exactly as it was', async () => {
  // The property the whole design exists for. None of these may cost a commit,
  // change a tree, or leave the message half-written.
  const answers = [null, '', '   ', '```\n```', 'Here you go:'];
  for (const answer of answers) {
    const r = repo();
    const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
    const out = await describeCommit({
      cwd: r.dir, sha, deckPath: r.deck, template: 'decklight: autosave deck.html',
      exec: fakeAgent(answer),
    });
    assert.equal(out, null, JSON.stringify(answer));
    assert.equal(r.g(['log', '-1', '--format=%s']), 'decklight: autosave deck.html');
    assert.equal(r.g(['rev-parse', 'HEAD']), sha, 'the commit itself moved');
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('an agent that throws is a non-event', async () => {
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  const out = await describeCommit({
    cwd: r.dir, sha, deckPath: r.deck, template: 'decklight: autosave deck.html',
    exec: async () => { throw new Error('the CLI exploded'); },
  }).catch((e) => e);
  assert.ok(!(out instanceof Error), 'describeCommit rejected instead of giving up quietly');
  assert.equal(r.g(['log', '-1', '--format=%s']), 'decklight: autosave deck.html');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the agent echoing the template back is not an amend', async () => {
  // The prompt's own escape hatch for "this diff says nothing useful".
  // Amending a message to itself is a rewrite for no reason.
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  const before = r.g(['log', '-1', '--format=%H %s']);
  const out = await describeCommit({
    cwd: r.dir, sha, deckPath: r.deck, template: 'decklight: autosave deck.html',
    exec: fakeAgent('decklight: autosave deck.html'),
  });
  assert.equal(out, null);
  assert.equal(r.g(['log', '-1', '--format=%H %s']), before, 'the commit was rewritten to itself');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('an agent answer is sanitized like any other agent text', async () => {
  // It reaches `git commit --amend -m`, so commitSubject's rules apply: one
  // line, capped, and never leading with `-` where something downstream could
  // read it as an option.
  const r = repo();
  const sha = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  await describeCommit({
    cwd: r.dir, sha, deckPath: r.deck, template: 'decklight: autosave deck.html',
    exec: fakeAgent('-rf everything'),
  });
  const subject = r.g(['log', '-1', '--format=%s']);
  assert.ok(!subject.startsWith('-'), `subject starts with a dash: ${subject}`);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a commit already superseded is never sent to an agent at all', async () => {
  // Paying for a description of a message nobody will read is the feature's
  // own busywork — so the tip check runs BEFORE the spawn as well as after.
  const r = repo();
  const first = r.commit('<section>a</section>', 'decklight: autosave deck.html');
  r.commit('<section>a</section><section>b</section>', 'decklight: autosave deck.html');
  let asked = false;
  const out = await describeCommit({
    cwd: r.dir, sha: first, deckPath: r.deck, template: 'decklight: autosave deck.html',
    exec: async () => { asked = true; return 'never'; },
  });
  assert.equal(out, null);
  assert.equal(asked, false, 'the agent was spawned for a commit that is no longer the tip');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

// ── the agent is asked, not told ─────────────────────────────────────────

test('every built-in agent has an ask argv that cannot edit the deck', () => {
  // A call to write a commit message has no business being able to change what
  // it is describing. These are the flags that would let it.
  const writeFlags = /--permission-mode|acceptEdits|--full-auto|--yolo|--force|--allow-all-tools/;
  for (const a of AGENTS) {
    assert.ok(a.ask, `${a.name} has no ask argv — it would fall back to the editing one`);
    const argv = a.ask('P').join(' ');
    assert.doesNotMatch(argv, writeFlags, `${a.name}: ask argv carries a write permission`);
    assert.ok(argv.includes('P'), `${a.name}: ask argv drops the prompt`);
  }
});

test('agentAsk passes the prompt through with no editing preamble', () => {
  const cmd = agentAsk('claude', 'DESCRIBE THIS DIFF', { hasBin: () => true });
  assert.ok(cmd);
  const argv = cmd.args.join(' ');
  assert.match(argv, /DESCRIBE THIS DIFF/);
  assert.doesNotMatch(argv, /Edit the Decklight deck/, 'the ask carried the edit path\'s preamble');
  assert.equal(cmd.readOnly, true);
});

test('no agent at all is null, not a throw', () => {
  assert.equal(agentAsk(null, 'x', { hasBin: () => false }), null);
});

// ── what the session says out loud ───────────────────────────────────────

test('the startup line names the agent and that diffs leave the machine', () => {
  const on = messagesLine('claude');
  assert.match(on, /claude/);
  assert.match(on, /diffs/, 'the line does not say what is sent');
  assert.match(messagesLine(null), /needs an agent/);
});
