// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight <deck>`, the one command (cli/open.mjs): which
// services come up, which are skipped, and why.
// planServices() is pure — no ports are bound here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp, stop } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

import { planServices, inGitRepo, voiceSetupOffer, moveBridgesOffStrangers } from '../cli/open.mjs';
import { LEASH, onLeash, leashEnv, exitWhenOrphaned } from '../cli/supervise.mjs';
import { isPortOpen } from '../cli/port-conflict.mjs';
import { DECK_URL_RE } from '../cli/banner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const NO_BINS = () => false;
const ALL_BINS = () => true;
// `exists` defaults to true so a plan never depends on whether THIS machine
// happens to have a piper voice model on disk — the tests that care about the
// model being absent say so explicitly (see test/local-voice.test.mjs)
// `detect` is injected too, and has to be: it is what the machine can SAY out
// loud, and a test that leaves it out asks the host. That was invisible until
// detectLocalVoice's probe started working — before, its default answered "no
// synthesizer" everywhere, so "a bare machine" was bare by accident on every
// machine, including one listing 184 voices.
const NO_VOICE = () => ({ engine: null, why: 'no system speech synthesizer here', suggest: 'install piper' });
const plan = (args, { env = {}, hasBin = NO_BINS, saved = null, exists = () => true, detect = NO_VOICE } = {}) =>
  planServices({ args, env, hasBin, saved, exists, detect });

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
  // the bridge ports reach the edit server too: the deck asks it for /tts and /lipsync (#520)
  assert.deepEqual(svc(p, 'edit').args, ['deck.html', '--port', '9000', '--tts-port', '9001', '--lipsync-port', '9002']);
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

// ── a deck that runs code of its own asks; off a terminal, read-only (PRESENTING) ──

const SCRIPTED = '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div>'
  + '<script>Decklight.init()</script><script>window.mine = 1</script></body></html>';

/** Start `decklight deck.html` off a terminal in `dir`, resolve its base URL and log. */
async function openDeck(t, dir, extra = [], env = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-trust-home-'));
  const child = spawn(process.execPath, [CLI, 'deck.html', '--port', '0', '--no-tts', '--no-lipsync', '--no-git', ...extra],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home, ...env } });
  t.after(async () => { await stop(child); rmTemp(dir); rmTemp(home); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout:\n' + out)); }, 15000);
  });
  return { base, home, log: () => out };
}

test('a deck with script of its own, off a terminal: named, and opened read-only', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-trust-'));
  writeFileSync(path.join(dir, 'deck.html'), SCRIPTED);
  const { base, log } = await openDeck(t, dir);
  assert.match(log(), /this deck runs code that is not the runtime/, 'the warning');
  assert.match(log(), /window\.mine = 1/, 'names the block');
  assert.match(log(), /no terminal to ask on — opening read-only; --trust/, 'and says why read-only, and the way out');
  const ping = await (await fetch(base + '/deck/ping')).json();
  assert.equal(ping.readOnly, true);
  assert.ok((await fetch(base + '/deck.html')).headers.get('content-security-policy')?.startsWith("default-src 'none'"));
});

test('--trust opens it in write mode and remembers the script; the next open does not ask', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-trust-'));
  writeFileSync(path.join(dir, 'deck.html'), SCRIPTED);
  const first = await openDeck(t, dir, ['--trust']);
  assert.match(first.log(), /trusted \(--trust\) — write mode, remembered/);
  assert.equal((await (await fetch(first.base + '/deck/ping')).json()).readOnly, false);
  const store = JSON.parse(readFileSync(path.join(first.home, 'trust.json'), 'utf8'));
  assert.deepEqual(Object.keys(store), [realpathSync(path.join(dir, 'deck.html'))], 'remembered by its real path');
  // the same home, no flag: trusted before, write mode, no question
  const dir2 = mkdtempSync(path.join(tmpdir(), 'decklight-trust-'));
  writeFileSync(path.join(dir2, 'deck.html'), SCRIPTED);
  const home2 = mkdtempSync(path.join(tmpdir(), 'decklight-trust-home2-'));
  writeFileSync(path.join(home2, 'trust.json'), JSON.stringify({ [realpathSync(path.join(dir2, 'deck.html'))]: Object.values(store)[0] }));
  const again = await openDeck(t, dir2, [], { DECKLIGHT_HOME: home2 });
  assert.match(again.log(), /trusted before — write mode/);
  assert.doesNotMatch(again.log(), /this deck runs code/);
  assert.equal((await (await fetch(again.base + '/deck/ping')).json()).readOnly, false);
});

test('a deck with nothing to account for opens in write mode without a word', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-trust-'));
  writeFileSync(path.join(dir, 'deck.html'), SCRIPTED.replace('<script>window.mine = 1</script>', ''));
  const { base, log } = await openDeck(t, dir);
  assert.doesNotMatch(log(), /runs code|trusted|read-only/);
  assert.equal((await (await fetch(base + '/deck/ping')).json()).readOnly, false);
});

test('--remote and --host travel to the deck server, in write mode too', () => {
  // The phone remote is the server's in either mode (READ_ONLY#REMOTE): off
  // this machine only /deck/remote/* answers, with the token, so the flag
  // widens the listener and nothing else — and the plan passes it through.
  assert.deepEqual(svc(plan(['deck.html', '--remote']), 'edit').args, ['deck.html', '--port', '8788', '--remote']);
  assert.deepEqual(svc(plan(['deck.html', '--host', '192.168.1.5']), 'edit').args, ['deck.html', '--port', '8788', '--host', '192.168.1.5']);
  assert.deepEqual(svc(plan(['deck.html']), 'edit').args, ['deck.html', '--port', '8788'], 'and nothing travels when nothing was asked');
  // --host consumes its argument, so a deck sitting after it is still found
  assert.equal(plan(['--host', '0.0.0.0', 'deck.html']).deck, 'deck.html');
});

test('--read-only is the same server in read-only mode: every edit route refuses, the CSP rides on every response', async (t) => {
  // One command, one server, two modes (PRESENTING): the flag does not start
  // a different server, it starts this one with the write family refused.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-ro-'));
  writeFileSync(path.join(dir, 'deck.html'), '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div><script>Decklight.init()</script></body></html>');
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-ro-home-'));
  const child = spawn(process.execPath, [CLI, 'deck.html', '--read-only', '--port', '0'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
  t.after(async () => { await stop(child); rmTemp(dir); rmTemp(home); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout:\n' + out)); }, 10000);
  });
  assert.match(out, /read-only, CSP enforced/, 'it says what it is');
  const page = await fetch(base + '/deck.html');
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy')?.startsWith("default-src 'none'"), 'the policy, as an HTTP header');
  const edit = await fetch(base + '/deck/edit/slide/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"slide":1,"text":"x"}' });
  assert.equal(edit.status, 403, 'the write family is refused by the mode');
  assert.equal((await edit.json()).readOnly, true, 'and the refusal says which mode answered');
  const ping = await (await fetch(base + '/deck/ping')).json();
  assert.equal(ping.readOnly, true, 'the one probe answers, and says read-only');
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

test('the deck is the command: the global help opens with it, and no word for it is listed', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  decklight <deck\.html \| repository url> \[--read-only\]/m, 'the one way to open a deck, first');
  for (const word of ['edit', 'dev', 'open']) {
    assert.doesNotMatch(help, new RegExp(`^  ${word} +\\S`, 'm'), `${word} is not a command`);
  }

  const openHelp = execFileSync('node', [CLI, 'deck.html', '--help'], { encoding: 'utf8' });
  assert.match(openHelp, /usage: decklight <deck\.html \| git url> \[--read-only\]/);
  // the remote is a flag of the one command, in either mode
  assert.match(openHelp, /^\s+--remote\b/m, 'the LAN opt-in is offered');
  assert.match(openHelp, /^\s+--host\b/m, 'and so is the bind address');
  assert.match(openHelp, /^\s+--read-only\b/m, 'the read-only mode is a flag of the same command');
});

test('`edit` is not a command, and says so the way any other unknown one does', () => {
  // It used to carry a refusal stub naming `open`. That stub was a migration
  // aid, and there is nobody to migrate: decklight has no released users, so
  // every stub is a line of dispatch, a test and a paragraph of docs bought
  // for no one. Dropped along with `rec`'s (MARKETPLACE.md COMMANDS records
  // the supersession).
  const r = spawnSync('node', [CLI, 'edit', 'deck.html'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command "edit"/);
  // the help still lists the command that does the job, which is how someone
  // who typed `edit` finds `open` now
  assert.match(r.stdout, /^ {2}decklight <deck\.html \| url>/m, 'the deck is the command, first in the short help');
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
  // The mechanism, end to end, in two processes and without `open` (#172).
  //
  // This is the test that goes red the instant the leash is broken, and it says
  // so in milliseconds: closing the write end of a pipe is an OS event, so the
  // only thing between the close and the exit is one scheduling slice. There
  // are no bridges here, no git probe, no service plan and no third process —
  // nothing whose latency could be mistaken for the thing under test. It reads
  // the same on an idle laptop and on a box running twenty test files at once,
  // which is precisely what the SIGKILL test below cannot promise.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-leash-'));
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'deck.html'),
    '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>\n');

  const child = spawn(process.execPath,
    [path.resolve(here, '../cli/edit.mjs'), 'deck.html', '--port', '0'],
    { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: leashEnv() });
  t.after(() => stop(child));

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
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'deck.html'),
    '<!doctype html><html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>\n');

  const dev = spawn(process.execPath, [
    CLI, 'deck.html', '--port', '0', '--no-tts', '--no-lipsync', '--no-git',
  ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(dev));

  let out = '';
  dev.stdout.on('data', (c) => { out += c; });
  dev.stderr.on('data', (c) => { out += c; });

  const [, spawned] = await waitFor('the deck server to announce its port',
    async () => out.match(DECK_URL_RE), () => out);
  const port = Number(spawned);
  assert.equal(await isPortOpen(port), true, 'the deck server is up');

  // `open` never gets to run shutdown() — this is the crash it cannot handle
  dev.kill('SIGKILL');
  await waitFor(`the orphan on port ${port} to notice and let go`,
    async () => (await isPortOpen(port)) === false, () => out);
});

test('a missing deck fails by name — not a stack trace', () => {
  const bare = spawnSync('node', [CLI, 'nope.html', '--read-only'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /deck not found/);
  assert.doesNotMatch(bare.stderr, /at .*\.mjs:\d+/, 'no stack trace');

  const missing = spawnSync('node', [CLI, 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such deck/);
});

// ── a bridge's port held by somebody else's program (`open` moves it) ────────

test('open moves a bridge off a port another program holds — onto one no other service takes — and tells the edit server', async () => {
  const plan = { run: [
    { name: 'edit', args: ['deck.html', '--port', '8788'] },
    { name: 'tts', args: ['tts', '--port', '8787'], url: 'http://127.0.0.1:8787' },
    { name: 'lipsync', args: ['--port', '8789'], url: 'http://127.0.0.1:8789' },
  ] };
  const held = new Set([8787, 8790]);
  const lines = await moveBridgesOffStrangers(plan, {
    isOpen: async (p) => held.has(p),
    isBridge: async () => null,                                   // what holds 8787 is not decklight
    bindable: async (p) => !held.has(p),
    stranger: () => ({ pid: 42, command: 'Python' }),
  });
  const tts = plan.run.find((s) => s.name === 'tts');
  assert.equal(tts.args.at(-1), '8791', 'not 8788 (edit), not 8789 (lip-sync), not 8790 (held)');
  assert.equal(tts.url, 'http://127.0.0.1:8791');
  const edit = plan.run.find((s) => s.name === 'edit').args;
  assert.equal(edit[edit.indexOf('--tts-port') + 1], '8791', 'the edit server forwards /tts there');
  assert.equal(plan.run.find((s) => s.name === 'lipsync').args.at(-1), '8789', 'a free bridge port stays put');
  assert.deepEqual(lines, ['voice: port 8787 is held by Python (pid 42) — not decklight — so the bridge takes 8791; the deck reaches it through this server']);
});

test('a decklight bridge already on the port is not moved — the bridge reuses it', async () => {
  const plan = { run: [
    { name: 'edit', args: ['deck.html', '--port', '8788', '--tts-port', '8787'] },
    { name: 'tts', args: ['tts', '--port', '8787'] },
  ] };
  const lines = await moveBridgesOffStrangers(plan, {
    isOpen: async () => true, isBridge: async () => ({ bridge: true, engine: 'say' }), bindable: async () => true, stranger: () => null,
  });
  assert.deepEqual(lines, []);
  assert.equal(plan.run[1].args.at(-1), '8787');
});

test('a voice bridge that moved onto the lip-sync port is not the lip-sync bridge — the lip-sync bridge moves on', async () => {
  const plan = { run: [
    { name: 'edit', args: ['deck.html', '--port', '8788'] },
    { name: 'lipsync', args: ['--port', '8789'], url: 'http://127.0.0.1:8789' },
  ] };
  const lines = await moveBridgesOffStrangers(plan, {
    isOpen: async (p) => p === 8789,
    isBridge: async () => ({ ok: true, engine: 'say', bridge: true, name: 'the say voice bridge' }),
    bindable: async (p) => p !== 8789,
    stranger: () => null,
  });
  assert.equal(plan.run[1].args.at(-1), '8790');
  assert.match(lines[0], /lip-sync: port 8789 is held by the say voice bridge — not this bridge — so the bridge takes 8790/);
});
