// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight author` (with `dev` as its permanent hidden alias): which
// services come up, which are skipped, and why.
// planServices() is pure — no ports are bound here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planServices, inGitRepo, voiceSetupOffer } from '../cli/dev.mjs';
import { LEASH, onLeash, leashEnv, exitWhenOrphaned } from '../cli/supervise.mjs';
import { isPortOpen } from '../cli/port-conflict.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const NO_BINS = () => false;
const ALL_BINS = () => true;
// `exists` defaults to true so a plan never depends on whether THIS machine
// happens to have a piper voice model on disk — the tests that care about the
// model being absent say so explicitly (see test/local-voice.test.mjs)
const plan = (args, { env = {}, hasBin = NO_BINS, saved = null, exists = () => true } = {}) =>
  planServices({ args, env, hasBin, saved, exists });

const names = (p) => p.run.map((s) => s.name);
const svc = (p, name) => p.run.find((s) => s.name === name);
const why = (p, name) => p.skip.find((s) => s.name === name)?.why ?? '';

test('the deck is found past flags that take a value', () => {
  assert.equal(plan(['--port', '9000', 'deck.html']).deck, 'deck.html');
  assert.equal(plan(['deck.html', '--port', '9000']).deck, 'deck.html');
  // "8788" is --port's value, not the deck
  assert.notEqual(plan(['--port', '8788']).deck, '8788');
  assert.equal(plan(['--no-tts', 'deck.html']).deck, 'deck.html');
});

test('the edit server always runs — it needs no credentials and no cost', () => {
  const p = plan(['deck.html']);
  assert.ok(names(p).includes('edit'));
  assert.deepEqual(svc(p, 'edit').args, ['deck.html', '--port', '8788']);
  assert.equal(svc(p, 'edit').url, 'http://127.0.0.1:8788/deck.html');
  // `edit` is not a dispatcher command anymore — the plan names the module to run
  assert.match(svc(p, 'edit').entry, /edit\.mjs$/);
  assert.match(svc(plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-1' } }), 'tts').entry, /decklight\.mjs$/);
});

test('a bare machine still gets the deck — bridges are skipped, not fatal', () => {
  const p = plan(['deck.html']);
  assert.deepEqual(names(p), ['edit'], 'no bridges, but edit still comes up');
  assert.match(why(p, 'voice'), /GOOGLE_CLOUD_PROJECT|--project/);
  assert.match(why(p, 'lip-sync'), /rhubarb/);
});

test('voice comes up when a project is available (flag or env)', () => {
  const viaFlag = plan(['deck.html', '--project', 'proj-1']);
  assert.ok(names(viaFlag).includes('tts'));
  assert.deepEqual(svc(viaFlag, 'tts').args, ['tts', '--port', '8787', '--project', 'proj-1']);

  const viaEnv = plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-2' } });
  assert.deepEqual(svc(viaEnv, 'tts').args, ['tts', '--port', '8787', '--project', 'proj-2']);
});

test('piper needs no project — the cloud engines do', () => {
  // the free engine must not be gated on a GCP project it never uses
  const offline = plan(['deck.html', '--tts-engine', 'piper'], { hasBin: ALL_BINS });
  assert.ok(names(offline).includes('tts'), 'piper comes up with no project at all');
  assert.deepEqual(svc(offline, 'tts').args, ['tts', '--port', '8787', '--engine', 'piper']);

  // …but without the binary there is nothing to run, and we say so
  const noBin = plan(['deck.html', '--tts-engine', 'piper']);
  assert.ok(!names(noBin).includes('tts'));
  assert.match(why(noBin, 'voice'), /piper not on PATH/);

  // chirp is cloud: project required, and the skip reason points at the way out
  const chirp = plan(['deck.html', '--tts-engine', 'chirp']);
  assert.ok(!names(chirp).includes('tts'));
  assert.match(why(chirp, 'voice'), /chirp needs a GCP project/);
  assert.match(why(chirp, 'voice'), /--tts-engine piper/, 'offers the free way out');

  const chirpOk = plan(['deck.html', '--tts-engine', 'chirp', '--project', 'decklight-tts']);
  assert.deepEqual(svc(chirpOk, 'tts').args,
    ['tts', '--port', '8787', '--engine', 'chirp', '--project', 'decklight-tts']);

  // gemini stays the default, so an existing command line keeps working
  const dflt = plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-1' } });
  assert.deepEqual(svc(dflt, 'tts').args, ['tts', '--port', '8787', '--project', 'proj-1']);

  const bogus = plan(['deck.html', '--tts-engine', 'espeak'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-1' } });
  assert.ok(!names(bogus).includes('tts'));
  assert.match(why(bogus, 'voice'), /unknown --tts-engine 'espeak'/);
});

test('a malformed project id is caught here, not by Vertex', () => {
  // 'decklight-tts,' — the trailing comma is real: it rides along when the id
  // is copied out of a sentence. The bridge used to start, look healthy, and
  // 403 on the first keypress, naming a project nobody typed.
  const p = plan(['deck.html', '--project', 'decklight-tts,']);
  assert.deepEqual(names(p), ['edit'], 'voice must not start on a bad id');
  assert.match(why(p, 'voice'), /decklight-tts,/, 'the reason quotes the id back');

  for (const bad of ['decklight tts', 'Decklight-TTS', 'x', 'proj-', '1proj', 'a/../b'])
    assert.ok(!names(plan(['deck.html', '--project', bad])).includes('tts'), `rejected: ${bad}`);
  for (const ok of ['decklight-tts', 'proj-1', 'a1b2c3'])
    assert.ok(names(plan(['deck.html', '--project', ok])).includes('tts'), `accepted: ${ok}`);
});

test('the saved tts config counts — but flags and the environment still win', () => {
  // the wizard saved piper: the voice comes up with no flags at all
  const piperSaved = { engine: 'piper', voice: 'en_US-ryan-high' };
  const offline = plan(['deck.html'], { hasBin: ALL_BINS, saved: piperSaved });
  assert.deepEqual(svc(offline, 'tts').args, ['tts', '--port', '8787', '--engine', 'piper']);

  // …but a saved piper with no binary anymore is still a skip, with the reason
  assert.match(why(plan(['deck.html'], { saved: piperSaved }), 'voice'), /piper not on PATH/);

  // a saved cloud engine carries its project
  const chirpSaved = { engine: 'chirp', project: 'proj-saved' };
  assert.deepEqual(svc(plan(['deck.html'], { saved: chirpSaved }), 'tts').args,
    ['tts', '--port', '8787', '--engine', 'chirp', '--project', 'proj-saved']);

  // precedence: flags > environment > saved config
  const viaFlag = plan(['deck.html', '--tts-engine', 'gemini', '--project', 'proj-flag'], { saved: chirpSaved });
  assert.deepEqual(svc(viaFlag, 'tts').args, ['tts', '--port', '8787', '--engine', 'gemini', '--project', 'proj-flag']);
  const viaEnv = plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-env' }, saved: chirpSaved });
  assert.deepEqual(svc(viaEnv, 'tts').args, ['tts', '--port', '8787', '--engine', 'chirp', '--project', 'proj-env']);
});

test('the setup offer fires only on the fixable skip — a flag-chosen outcome never asks', () => {
  assert.ok(voiceSetupOffer(plan(['deck.html'])), 'nothing configured: offer');
  assert.ok(voiceSetupOffer(plan(['deck.html', '--tts-engine', 'chirp'])), 'engine picked, project missing: still fixable');
  assert.equal(voiceSetupOffer(plan(['deck.html', '--no-tts'])), null, '--no-tts never asks');
  assert.equal(voiceSetupOffer(plan(['deck.html', '--tts-engine', 'espeak'])), null, 'an unknown engine is a typo, not a setup');
  assert.equal(voiceSetupOffer(plan(['deck.html', '--project', 'decklight-tts,'])), null, 'a malformed id keeps its own message');
  assert.equal(voiceSetupOffer(plan(['deck.html', '--tts-engine', 'piper'])), null, 'a missing binary is an install, not a config');
  assert.equal(voiceSetupOffer(plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-1' } })), null, 'nothing to fix: the voice runs');
});

test('lip-sync comes up when rhubarb is on PATH, or when explicitly configured', () => {
  const onPath = plan(['deck.html'], { hasBin: ALL_BINS });
  assert.ok(names(onPath).includes('lipsync'));

  // no rhubarb on PATH, but the user pointed at a portrait — trust them
  const configured = plan(['deck.html', '--portrait', 'me=face.png']);
  assert.ok(names(configured).includes('lipsync'));
  assert.deepEqual(svc(configured, 'lipsync').args,
    ['lipsync', '--port', '8789', '--portrait', 'me=face.png']);
});

test('--no-tts / --no-lipsync opt out, and say so', () => {
  const p = plan(['deck.html', '--no-tts', '--no-lipsync'], { env: { GOOGLE_CLOUD_PROJECT: 'p' }, hasBin: ALL_BINS });
  assert.deepEqual(names(p), ['edit']);
  assert.match(why(p, 'voice'), /--no-tts/);
  assert.match(why(p, 'lip-sync'), /--no-lipsync/);
});

test('ports and bridge flags pass through to the right child', () => {
  const p = plan(
    ['deck.html', '--port', '9000', '--tts-port', '9001', '--lipsync-port', '9002',
      '--project', 'proj-9', '--tts-model', 'm', '--wav2lip-dir', '/w'],
    { hasBin: ALL_BINS },
  );
  assert.equal(svc(p, 'edit').args.at(-1), '9000');
  assert.deepEqual(svc(p, 'tts').args, ['tts', '--port', '9001', '--project', 'proj-9', '--tts-model', 'm']);
  assert.deepEqual(svc(p, 'lipsync').args, ['lipsync', '--port', '9002', '--wav2lip-dir', '/w']);
});

test('git and agent flags ride along to the edit child', () => {
  const p = plan(['deck.html', '--git', '--commit-every', '60', '--agent', 'codex']);
  assert.deepEqual(svc(p, 'edit').args,
    ['deck.html', '--port', '8788', '--git', '--commit-every', '60', '--agent', 'codex']);
  assert.ok(svc(plan(['deck.html', '--no-git']), 'edit').args.includes('--no-git'));
  // the deck is still found past the new value flags
  assert.equal(plan(['--agent', 'claude', 'deck.html']).deck, 'deck.html');
  assert.equal(plan(['--commit-every', '60', 'deck.html']).deck, 'deck.html');
});

test('--remote and --host ride along to the edit child; no flag, no change', () => {
  const p = plan(['deck.html', '--remote']);
  assert.deepEqual(svc(p, 'edit').args, ['deck.html', '--port', '8788', '--remote']);

  const h = plan(['deck.html', '--remote', '--host', '192.168.1.5']);
  assert.deepEqual(svc(h, 'edit').args,
    ['deck.html', '--port', '8788', '--remote', '--host', '192.168.1.5']);

  // without the flag the edit child's args are byte-for-byte what they were
  assert.deepEqual(svc(plan(['deck.html']), 'edit').args, ['deck.html', '--port', '8788']);

  // the deck is still found past the new value flag
  assert.equal(plan(['--host', '0.0.0.0', 'deck.html']).deck, 'deck.html');
});

test('the agent roster is part of the plan — the big three included', () => {
  const all = plan(['deck.html'], { hasBin: ALL_BINS });
  for (const name of ['claude', 'codex', 'bob']) {
    assert.ok(all.agents.includes(name), `${name} missing`);
  }
  assert.deepEqual(plan(['deck.html']).agents, [], 'a bare machine has none');
});

test('inGitRepo trusts git\'s answer and treats failure as "no repo"', () => {
  assert.equal(inGitRepo('/anywhere', () => 'true\n'), true);
  assert.equal(inGitRepo('/anywhere', () => 'false\n'), false);
  assert.equal(inGitRepo('/anywhere', () => { throw new Error('not a repo'); }), false);
});

test('author is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  author {2}/m, 'author is listed in the global help');
  assert.doesNotMatch(help, /^  dev {5}/m, 'the alias is documented nowhere');
  assert.doesNotMatch(help, /^  edit {4}/m, 'the removed command is not offered');

  const authorHelp = execFileSync('node', [CLI, 'author', '--help'], { encoding: 'utf8' });
  assert.match(authorHelp, /usage: decklight author/);
  assert.match(authorHelp, /--remote/, 'the LAN opt-in is documented');
  assert.match(authorHelp, /--host/, 'and so is the bind address');
});

test('`dev` still works, as a permanent hidden alias — same command, no nag', () => {
  const viaAlias = execFileSync('node', [CLI, 'dev', '--help'], { encoding: 'utf8' });
  const direct = execFileSync('node', [CLI, 'author', '--help'], { encoding: 'utf8' });
  assert.equal(viaAlias, direct, 'flag for flag the same command');
  assert.doesNotMatch(viaAlias, /deprecat/i, 'an alias forever is not a deprecation');

  // and it really routes to author, not to the unknown-command path
  const missing = spawnSync('node', [CLI, 'dev', 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such deck/);
  assert.doesNotMatch(missing.stderr, /unknown command/);
});

test('`edit` refuses out loud — the replacement named, never "unknown command"', () => {
  const r = spawnSync('node', [CLI, 'edit', 'deck.html'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /decklight author/, 'the way forward is named');
  assert.doesNotMatch(r.stderr, /unknown command/);
  assert.doesNotMatch(r.stdout + r.stderr, /Usage:\n {2}decklight <command>/, 'no global-help dump — one line, on purpose');
});

// ── the leash: a child outlives its parent for exactly as long as the pipe ──

/**
 * Poll until `want` returns something truthy, or give up.
 *
 * The deadline is deliberately generous, and the reason is worth writing down
 * because the number looks careless otherwise (#172). The leash is EDGE
 * triggered: the OS closes the pipe, the child reads EOF, the child exits.
 * There is no timer anywhere in it, and so no threshold at which a working
 * leash becomes a broken one — a broken leash never releases the port AT ALL,
 * while a working one releases it as soon as the orphan gets a scheduling
 * slice. On an idle machine that is ~15ms; under a parallel suite with twenty
 * node processes and a headless Chrome competing for the CPU, the same working
 * leash was measured taking seconds.
 *
 * So a short deadline cannot tell slow from broken. It can only convert a busy
 * machine into a red test, which is exactly what the old fixed 10s did. The one
 * thing a deadline is good for here is stopping a genuinely stuck run from
 * hanging forever, and for that, generous is correct: a long deadline costs
 * time only on a real failure, while the short one charged everybody running
 * `npm test` on a loaded box.
 *
 * 60s is six times the longest a working leash has been observed to need. The
 * fast, load-independent check on the same mechanism is the pipe test below;
 * this deadline is a backstop, not the assertion.
 */
async function waitFor(label, want, context = () => '', timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const got = await want();
    if (got) return got;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timed out after ${Math.round((Date.now() - start) / 1000)}s waiting for ${label}\n${context()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the leash is opt-in — an unsupervised command never reads stdin', () => {
  assert.equal(onLeash({}), false);
  assert.equal(onLeash({ [LEASH]: '0' }), false);
  assert.equal(onLeash({ [LEASH]: '1' }), true);

  const stdin = new EventEmitter();
  stdin.resume = () => assert.fail('an unsupervised command must leave stdin alone');
  assert.equal(exitWhenOrphaned({ env: {}, stdin, exit: () => {} }), false);
  assert.equal(stdin.listenerCount('end'), 0);
});

test('a supervised child exits 0 the moment the pipe closes, however it closes', () => {
  for (const how of ['end', 'close', 'error']) {
    const stdin = new EventEmitter();
    let resumed = false, unreffed = false;
    stdin.resume = () => { resumed = true; };
    stdin.unref = () => { unreffed = true; };
    const codes = [];

    assert.equal(exitWhenOrphaned({ env: leashEnv({}), stdin, exit: (c) => codes.push(c) }), true);
    assert.ok(resumed, 'nothing else reads stdin, so the end never arrives unflowing');
    assert.ok(unreffed, 'the leash must not be what keeps a process alive');

    stdin.emit(how, new Error('EPIPE'));
    assert.deepEqual(codes, [0], `losing the parent via "${how}" is not a failure`);
  }
});

test('leashEnv adds the flag and keeps the rest of the environment', () => {
  assert.deepEqual(leashEnv({ PATH: '/bin' }), { PATH: '/bin', [LEASH]: '1' });
});

test('a real child on a real pipe exits when the pipe closes, and lets go of its port', async (t) => {
  // The mechanism, end to end, in two processes and without `author` (#172).
  //
  // This is the test that goes red the instant the leash is broken, and it says
  // so in milliseconds: closing the write end of a pipe is an OS event, so the
  // only thing between the close and the exit is one scheduling slice. There
  // are no bridges here, no git probe, no service plan and no third process —
  // nothing whose latency could be mistaken for the thing under test. It reads
  // the same on an idle laptop and on a box running twenty test files at once,
  // which is precisely what the SIGKILL test below cannot promise.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-leash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'deck.html'),
    '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>\n');

  const child = spawn(process.execPath,
    [path.resolve(here, '../cli/edit.mjs'), 'deck.html', '--port', '0'],
    { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: leashEnv() });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const port = Number((await waitFor('the deck server to announce its port',
    async () => out.match(/http:\/\/127\.0\.0\.1:(\d+)/), () => out))[1]);
  assert.equal(await isPortOpen(port), true, 'the deck server is up');

  // Exactly what a SIGKILLed parent does to its end of the pipe, minus the
  // parent — so a failure here is the leash and cannot be anything else.
  child.stdin.end();
  await waitFor('the child to notice the closed pipe', async () => child.exitCode !== null, () => out);

  assert.equal(child.exitCode, 0, 'losing the parent is not a failure — the child leaves quietly');
  assert.equal(await isPortOpen(port), false, 'and the port goes with it');
});

test('SIGKILL to author takes the deck server with it — no orphan holding the port', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-leash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'deck.html'),
    '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>\n');

  const dev = spawn(process.execPath, [
    CLI, 'author', 'deck.html', '--port', '0', '--no-tts', '--no-lipsync', '--no-git',
  ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { dev.kill('SIGKILL'); } catch { /* already gone */ } });

  let out = '';
  dev.stdout.on('data', (c) => { out += c; });
  dev.stderr.on('data', (c) => { out += c; });

  const [, spawned] = await waitFor('the deck server to announce its port',
    async () => out.match(/decklight author on http:\/\/127\.0\.0\.1:(\d+)/), () => out);
  const port = Number(spawned);
  assert.equal(await isPortOpen(port), true, 'the deck server is up');

  // author never gets to run shutdown() — this is the crash it cannot handle
  dev.kill('SIGKILL');
  await waitFor(`the orphan on port ${port} to notice and let go`,
    async () => (await isPortOpen(port)) === false, () => out);
});

test('author without a deck, or with a missing one, fails with usage — not a stack trace', () => {
  const bare = spawnSync('node', [CLI, 'author'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /needs a deck/);
  assert.doesNotMatch(bare.stderr, /at .*\.mjs:\d+/, 'no stack trace');

  const missing = spawnSync('node', [CLI, 'author', 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such deck/);
});
