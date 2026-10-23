// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { test as baseTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// The whole recording suite drives rec, which needs node-pty (native) +
// js-yaml — both optional deps. Skip it when they're absent (e.g. CI installs
// with --omit=optional) rather than fail on a missing native toolchain.
import { optionalDepSkip as recSkip } from './helpers.mjs';
import { checkSteps } from '../cli/cast.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli', 'cast.mjs');

const test = (name, fn) => baseTest(name, { skip: recSkip }, fn);

// Record under zsh when it's present (macOS default — exercises the
// zsh-specific prompt taming), else bash (Linux/CI). rec supports both
// (cli/cast.mjs shellArgs/setupLine); only these fixtures were pinned to zsh.
const SHELL = fs.existsSync('/bin/zsh') ? 'zsh' : 'bash';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-cast-'));
}

function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

/** Run the CLI expecting failure; returns stderr for assertions. */
function runExpectFail(args) {
  try {
    execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String(e.stderr || e.message);
  }
  throw new Error('expected CLI to exit non-zero');
}

test('CLI end-to-end: structure, state carry-over, redaction, notes', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'demo.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'prompt: "% "',
    'cols: 90',
    'redact:',
    '  - "sk-[a-z0-9]+"',
    'steps:',
    '  - cmd: MARKER=decklight-state; echo "one"',
    '  - cmd: echo "carried=$MARKER key=sk-abc99"',
    '    note: proves session state carries over',
  ].join('\n'));
  run([script, '--quiet']);

  const castPath = path.join(dir, 'demo.cast.json');
  assert.ok(fs.existsSync(castPath), 'default output path derives from script name');
  const cast = JSON.parse(fs.readFileSync(castPath, 'utf8'));

  assert.equal(cast.decklightCast, 1);
  assert.equal(cast.meta.prompt, '% ');
  assert.equal(cast.meta.cols, 90);
  assert.equal(cast.meta.shell, SHELL);
  assert.ok(cast.meta.recorded.match(/^\d{4}-\d{2}-\d{2}T/));
  assert.deepEqual(cast.script.steps.length, 2, 'script embedded verbatim');
  assert.equal(cast.steps.length, 2);

  const [s1, s2] = cast.steps;
  assert.equal(s1.exit, 0);
  assert.ok(typeof s1.duration === 'number');
  assert.ok(s1.output.every(([t, d]) => typeof t === 'number' && typeof d === 'string'));
  assert.equal(joined(s1), 'one');
  // one persistent shell session: the variable survives into step 2
  assert.ok(joined(s2).includes('carried=decklight-state'), `state carry-over, got: ${joined(s2)}`);
  // redaction applied to output…
  assert.ok(joined(s2).includes('key=▓▓▓'));
  assert.ok(!joined(s2).includes('sk-abc99'));
  // …and no echo/prompt/sentinel pollution anywhere
  for (const s of cast.steps) {
    assert.ok(!joined(s).includes('\x1d'), 'no sentinel bytes');
    assert.ok(!joined(s).includes('printf'), 'no sentinel command echo');
  }
  assert.equal(s2.note, 'proves session state carries over');
});

test('non-zero exit aborts without --allow-fail, records with it', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'fail.term.yaml');
  fs.writeFileSync(script, [`shell: ${SHELL}`, 'steps:', '  - cmd: false', '  - cmd: echo after'].join('\n'));

  const err = runExpectFail([script, '--quiet']);
  assert.match(err, /exited 1/);
  assert.doesNotMatch(err, /bug/, 'a failing script is not a decklight bug');

  run([script, '--quiet', '--allow-fail']);
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'fail.cast.json'), 'utf8'));
  assert.equal(cast.steps[0].exit, 1);
  assert.equal(joined(cast.steps[1]), 'after');
});

test('timeout aborts with a step-identifying error', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'slow.term.yaml');
  fs.writeFileSync(script, [`shell: ${SHELL}`, 'steps:', '  - cmd: sleep 5', '    timeout: 1'].join('\n'));
  const err = runExpectFail([script, '--quiet']);
  assert.match(err, /timeout waiting for step 1/);
  assert.doesNotMatch(err, /bug/, 'a step outrunning its timeout is not a decklight bug');
});

baseTest('checkSteps: a step is a cmd: (any YAML scalar) or a sleep: on its own', () => {
  const ok = [{ cmd: 'ls' }, { cmd: false }, { cmd: 42 }, { sleep: 1.5 }, { cmd: 'ls', sleep: 'x' }];
  checkSteps(ok);
  assert.equal(ok[1].cmd, 'false', 'a scalar cmd is coerced to text');
  const refused = (steps, re) => assert.throws(() => checkSteps(steps), e => e.name === 'CommandError' && re.test(e.message));
  refused([{ cmd: 'ls' }, { run: 'ls', note: 'x' }], /^step 2 has no "cmd" \(it has "run", "note"\)/);
  refused([{}], /^step 1 has no "cmd": each step/);
  refused(['echo hi'], /^step 1 is "echo hi", not a mapping/);
  refused([{ sleep: '2' }], /^step 1 has a "sleep" that is not a number/);
  refused([{ cmd: ['ls'] }], /^step 1 has a "cmd" that is not a command line/);
});

test('a malformed step is refused before any step runs, naming the keys it has', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'bad.term.yaml');
  fs.writeFileSync(script, [`shell: ${SHELL}`, 'steps:', '  - cmd: touch ran', '  - run: echo hi'].join('\n'));
  const err = runExpectFail([script, '--quiet']);
  assert.equal(err.trim(),
    'decklight cast: step 2 has no "cmd" (it has "run"): each step is a cmd: to run, or a sleep: in seconds');
  assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'step 1 never ran');
});

test('unset secrets, a missing shell and a missing cwd are script errors, not bugs', () => {
  const dir = tmpdir();
  const cases = {
    secret: [`shell: ${SHELL}`, 'steps:', '  - cmd: sleep 0.5', '    interact:',
      '      - expect: ""', '        send: { secret: "$DECKLIGHT_TEST_NOT_SET\\n" }'],
    shell: ['shell: /no/such/shell', 'steps:', '  - cmd: echo hi'],
    cwd: [`shell: ${SHELL}`, 'cwd: /no/such/dir', 'steps:', '  - cmd: echo hi'],
  };
  const want = { secret: /secret env var DECKLIGHT_TEST_NOT_SET is not set/, shell: /shell not found/, cwd: /cwd not found/ };
  for (const [name, lines] of Object.entries(cases)) {
    const script = path.join(dir, `${name}.term.yaml`);
    fs.writeFileSync(script, lines.join('\n'));
    const err = runExpectFail([script, '--quiet']);
    assert.match(err, want[name]);
    assert.doesNotMatch(err, /bug/, `${name}: not a decklight bug`);
  }
});

test('refresh: idempotent when output is stable, rewrites on drift', () => {
  const dir = tmpdir();
  const stateFile = path.join(dir, 'drift.txt');
  fs.writeFileSync(stateFile, 'v1');
  const script = path.join(dir, 'refresh.term.yaml');
  fs.writeFileSync(script, [`shell: ${SHELL}`, 'steps:', `  - cmd: cat ${stateFile}`].join('\n'));
  run([script, '--quiet']);
  const castPath = path.join(dir, 'refresh.cast.json');
  const before = fs.readFileSync(castPath, 'utf8');

  // stable content -> no rewrite
  const out1 = run(['--refresh', dir]);
  assert.match(out1, /re-ran 1 script, 0 casts changed/);
  assert.equal(fs.readFileSync(castPath, 'utf8'), before, 'file untouched without drift');

  // drift -> rewrite with new output
  fs.writeFileSync(stateFile, 'v2-changed');
  const out2 = run(['--refresh', dir]);
  assert.match(out2, /re-ran 1 script, 1 cast changed/);
  assert.match(out2, /refresh\.cast\.json/);
  const after = JSON.parse(fs.readFileSync(castPath, 'utf8'));
  assert.equal(joined(after.steps[0]), 'v2-changed');
});

test('directives: hide records but marks hidden; sleep records a marker; state flows through', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'directives.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'steps:',
    '  - cmd: HIDDEN_VAR=carried',
    '    hide: true',
    '  - sleep: 0.2',
    '  - cmd: echo "got=$HIDDEN_VAR"',
    '    type_speed: 3',
  ].join('\n'));
  run([script, '--quiet']);
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'directives.cast.json'), 'utf8'));
  assert.equal(cast.steps.length, 3);
  assert.equal(cast.steps[0].hidden, true, 'hidden flag recorded');
  assert.equal(cast.steps[1].sleep, 0.2, 'sleep marker recorded');
  assert.ok(joined(cast.steps[2]).includes('got=carried'), 'hidden step ran in the session');
  assert.equal(cast.steps[2].typeSpeed, 3, 'type_speed stored for the player');
});

test('wait_for: passes when output matches, times out with an identifying error when not', () => {
  const dir = tmpdir();
  const ok = path.join(dir, 'wait-ok.term.yaml');
  fs.writeFileSync(ok, [
    `shell: ${SHELL}`,
    'steps:',
    "  - cmd: sh -c 'sleep 0.2; echo status=RUNNING; echo done'",
    '    wait_for: "RUNNING"',
  ].join('\n'));
  run([ok, '--quiet']);
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'wait-ok.cast.json'), 'utf8'));
  assert.ok(joined(cast.steps[0]).includes('status=RUNNING'));

  const bad = path.join(dir, 'wait-bad.term.yaml');
  fs.writeFileSync(bad, [
    `shell: ${SHELL}`,
    'steps:',
    '  - cmd: echo nothing-to-see',
    '    wait_for: "NEVER_APPEARS"',
    '    timeout: 1',
  ].join('\n'));
  assert.match(runExpectFail([bad, '--quiet']), /wait_for \/NEVER_APPEARS\/ in step 1/);
});

test('interact: answers prompts; secret sends are masked in input, redacted in output, scrubbed from literal script', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'interact.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'env: { DEMO_TOKEN: fake-tok-12345 }',
    'steps:',
    // prompt for a name (plain send) then a token (secret via $ENV), then leak both
    '  - cmd: >-',
    "      printf 'Name: '; read -r N; printf 'Token: '; read -r T; printf '\\n';",
    '      echo "hello $N got $T len=${#T}"',
    '    interact:',
    '      - expect: "Name: "',
    '        send: "ada\\n"',
    '      - expect: "Token: "',
    '        send: { secret: "$DEMO_TOKEN\\n" }',
    '  - cmd: >-',
    "      printf 'Pin: '; read -r P; printf '\\n'; echo \"pin=$P\"",
    '    interact:',
    '      - expect: "Pin: "',
    '        send: { secret: "literal-pin-77\\n" }',
  ].join('\n'));
  run([script, '--quiet']);
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'interact.cast.json'), 'utf8'));

  const [s1, s2] = cast.steps;
  // plain send recorded verbatim; secret masked
  assert.deepEqual(s1.input.map(([, d]) => d), ['ada\n', '▓▓▓']);
  // output: plain value visible, secret value auto-redacted (len leaks by design)
  const out1 = joined(s1);
  assert.ok(out1.includes('hello ada'));
  assert.ok(out1.includes('got ▓▓▓'), `secret redacted in output, got: ${out1}`);
  assert.ok(!out1.includes('fake-tok-12345'));
  assert.ok(out1.includes('len=14'), 'the real value was sent (14 chars)');
  // literal secret: sent for real, but scrubbed from the embedded script
  assert.ok(joined(s2).includes('pin=▓▓▓'));
  assert.equal(cast.script.steps[1].interact[0].send.secret, '▓▓▓', 'literal secret scrubbed from embedded script');
  assert.equal(cast.script.steps[0].interact[1].send.secret, '$DEMO_TOKEN\n', '$ENV secret kept (refreshable)');
  assert.equal(cast.script.env.DEMO_TOKEN, '▓▓▓', 'inlined env value referenced by a secret is scrubbed too');
  // and nowhere in the whole cast file
  const rawFile = fs.readFileSync(path.join(dir, 'interact.cast.json'), 'utf8');
  assert.ok(!rawFile.includes('fake-tok-12345') && !rawFile.includes('literal-pin-77'));
});

test('interact: command exiting before an expect matches aborts (unless --allow-fail)', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'noprompt.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'steps:',
    '  - cmd: echo no prompt here',
    '    interact:',
    '      - expect: "Password: "',
    '        send: "x\\n"',
  ].join('\n'));
  const err = runExpectFail([script, '--quiet']);
  assert.match(err, /exited before expect \/Password: \//);
  assert.doesNotMatch(err, /bug/, 'an unmatched expect is not a decklight bug');
  run([script, '--quiet', '--allow-fail']); // records instead of failing
});

test('max_idle clamps recorded gaps at capture time', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'idle.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'max_idle: 0.3',
    'steps:',
    "  - cmd: sh -c 'echo first; sleep 1.2; echo second'",
  ].join('\n'));
  run([script, '--quiet']);
  const cast = JSON.parse(fs.readFileSync(path.join(dir, 'idle.cast.json'), 'utf8'));
  const out = cast.steps[0].output;
  const iFirst = out.findIndex(([, d]) => d.includes('first'));
  const iSecond = out.findIndex(([, d]) => d.includes('second'));
  assert.ok(iFirst !== -1 && iSecond !== -1);
  const gap = out[iSecond][0] - out[iFirst][0];
  assert.ok(gap <= 0.6, `1.2s pause clamped to ~0.3s, got ${gap}`);
});

test('export: asciicast v2 with markers, injected prompt/command, hidden steps omitted', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'exp.term.yaml');
  fs.writeFileSync(script, [
    `shell: ${SHELL}`,
    'prompt: "% "',
    'steps:',
    '  - cmd: SECRET_SETUP=1',
    '    hide: true',
    '  - cmd: echo visible',
    '  - sleep: 0.4',
    '  - cmd: echo after-sleep',
  ].join('\n'));
  run([script, '--quiet']);
  run(['export', path.join(dir, 'exp.cast.json'), '--quiet']);   // cast.mjs directly: its own subcommand

  const lines = fs.readFileSync(path.join(dir, 'exp.cast'), 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0]);
  assert.equal(header.version, 2);
  assert.equal(header.width, 100);
  const events = lines.slice(1).map(l => JSON.parse(l));
  assert.ok(events.every(e => Array.isArray(e) && typeof e[0] === 'number'), 'NDJSON events');
  for (let i = 1; i < events.length; i++) assert.ok(events[i][0] >= events[i - 1][0], 'monotonic time');
  const markers = events.filter(e => e[1] === 'm').map(e => e[2]);
  assert.deepEqual(markers, ['echo visible', 'echo after-sleep'], 'markers per visible step, hidden omitted');
  const stream = events.filter(e => e[1] === 'o').map(e => e[2]).join('');
  assert.ok(stream.includes('% ') && stream.includes('echo visible'), 'prompt + typed command injected');
  assert.ok(!stream.includes('SECRET_SETUP'), 'hidden step absent from export');
  // the sleep marker becomes a pure time gap between the two steps' events
  const mVisible = events.find(e => e[1] === 'm' && e[2] === 'echo visible');
  const mAfter = events.find(e => e[1] === 'm' && e[2] === 'echo after-sleep');
  assert.ok(mAfter[0] - mVisible[0] >= 0.4, 'sleep contributes to the timeline');
});

function joined(step) {
  return step.output.map(([, d]) => d).join('');
}

test('a step ended with Ctrl-C (an interact send) completes as 130, and the session carries on', () => {
  // How a server is stopped on camera: it prints its banner, the script
  // presses Ctrl-C. The interrupt used to abandon the sentinel with the rest
  // of the line, so the step timed out; and its exit, 130, aborted the cast.
  for (const shell of ['zsh', 'bash'].filter((s) => fs.existsSync(`/bin/${s}`))) {
    const dir = tmpdir();
    const script = path.join(dir, 'server.term.yaml');
    fs.writeFileSync(script, [
      `shell: ${shell}`,
      'steps:',
      // one process that prints, then waits, like a server: with `echo; sleep`
      // the shell itself ran the echo, and under load a Ctrl-C could land in
      // the gap before sleep started and be lost, so the step timed out
      "  - cmd: sh -c 'echo serving on 8788; exec sleep 30'",
      '    timeout: 10',
      '    interact:',
      '      - expect: "serving"',
      '        send: "\\u0003"',
      '  - cmd: echo after',
    ].join('\n'));
    run([script, '--quiet']);
    const cast = JSON.parse(fs.readFileSync(path.join(dir, 'server.cast.json'), 'utf8'));
    assert.equal(cast.steps.length, 2, `${shell}: both steps recorded`);
    assert.equal(cast.steps[0].exit, 130, `${shell}: the interrupted step exits 130`);
    assert.match(cast.steps[0].output.map(([, d]) => d).join(''), /serving on 8788/, `${shell}: its output is kept`);
    assert.match(cast.steps[1].output.map(([, d]) => d).join(''), /after/, `${shell}: the session carries on`);
  }
});

test('Ctrl-C the script did not send still fails the step', () => {
  // only an interrupt the script itself sent is a normal end: a command that
  // exits 130 by itself is still a failure without --allow-fail
  const dir = tmpdir();
  const script = path.join(dir, 'selfint.term.yaml');
  fs.writeFileSync(script, [`shell: ${SHELL}`, 'steps:', '  - cmd: (exit 130)'].join('\n'));
  assert.match(runExpectFail([script, '--quiet']), /exited 130/);
});
