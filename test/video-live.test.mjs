// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/video-live.mjs — the live-capture watchdog, without a browser: a page
// that stops moving through the talk (a dead animation loop, a frozen clock,
// a deck stuck on one beat, an error) is named with its reason, and a page
// that is merely showing a still slide is not (#1254). The real capture,
// simulated stalls included, runs in test/video-e2e.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { liveStall, liveFault, clock, displayStall } from '../tools/video-live.mjs';
import { keepAwake } from '../cli/keep-awake.mjs';

test('live capture adds the display assertion on macOS and Windows', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const display of [false, true]) {
      let args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: () => child.emit('close') });
      child.kill = () => child.emit('close');
      const awake = await keepAwake({ platform, display, launch: (_bin, argv) => {
        args = argv;
        queueMicrotask(() => {
          child.emit('spawn');
          child.stdout.emit('data', 'ready\n');
        });
        return child;
      } });
      assert.equal(awake.active, true);
      assert.equal(awake.displayActive, display && platform !== 'linux');
      if (platform === 'darwin') assert.equal(args.includes('-d'), display);
      if (platform === 'win32') assert.match(args.at(-1), display ? /2147483651/ : /2147483649/);
      if (platform === 'linux') assert.ok(args.includes('--what=idle:sleep'));
      await awake.release();
    }
  }
});

test('macOS watchdog identifies a recent display-off or lock and ignores stale events', async () => {
  const tick = Date.parse('2026-11-26T14:11:44+0100');
  const off = '2026-11-26 14:11:45 +0100 Display Display is turned off\n';
  const on = '2026-11-26 14:11:46 +0100 Display Display is turned on\n';
  const check = (power, session = '', at = tick) => displayStall({
    platform: 'darwin', tick: at, now: at + 3000,
    run: async (file) => ({ stdout: file.endsWith('/pmset') ? power : session }),
  });
  assert.equal(await check(off), 'the display turned off');
  assert.equal(await check(off + on), null);
  assert.equal(await check(off, '', tick + 10000), null);
  assert.equal(await check('', '"CGSSessionScreenIsLocked"=Yes'), 'the screen locked');
  assert.equal(await check('', '"IOConsoleLocked"=No'), null);
});

const beats = [
  { slide: 1, step: 0, start: 0, end: 10 },
  { slide: 2, step: 0, start: 10, end: 20 },
  { slide: 2, step: 1, start: 20, end: 600 },
];
const started = 1_000_000;
const at = (talk) => started + talk * 1000;
const live = (talk, extra = {}) => ({ tick: at(talk), time: talk, index: beats.findLastIndex((b) => b.start <= talk), error: null, ...extra });

test('a page keeping pace with the talk is fine, still picture or not', () => {
  for (const talk of [0.5, 9.9, 10.2, 300, 599]) {
    assert.equal(liveStall(live(talk - 0.3), { now: at(talk), started, beats }), null, `at ${talk}s`);
  }
});

test('a dead animation loop is caught within the grace period, with how long ago', () => {
  // the loop last ran at 9:40 and the talk is at 9:45: the mid-slide freeze of the report
  const reason = liveStall(live(580), { now: at(585), started, beats });
  assert.match(reason, /stopped animating 5\.0 s ago/);
  assert.equal(liveStall(live(580), { now: at(581.5), started, beats }), null, 'inside the grace period');
});

test('a clock that stops while the loop still runs is caught, as is a deck stuck on a beat', () => {
  assert.match(liveStall(live(200, { tick: at(205) }), { now: at(205), started, beats }), /clock is 5\.0 s behind/);
  assert.match(liveStall(live(25, { index: 0 }), { now: at(25), started, beats }),
    /still on slide 1 step 0, but the talk is at slide 2 step 1/);
});

test('a page error, or a page with no player, is the reason itself', () => {
  assert.equal(liveStall(live(30, { error: 'TypeError: boom' }), { now: at(30), started, beats }), 'page error: TypeError: boom');
  assert.match(liveStall(null, { now: at(30), started, beats }), /player is gone/);
});

test('the simulated stall spec, and the log clock', () => {
  assert.deepEqual(liveFault('throw@12'), { kind: 'throw', at: 12 });
  assert.deepEqual(liveFault('freeze@2.5'), { kind: 'freeze', at: 2.5 });
  for (const bad of [undefined, '', 'pause@3', 'throw@', 'freeze@x']) assert.equal(liveFault(bad), null, String(bad));
  assert.equal(clock(811.7), '13:31');
  assert.equal(clock(5), '0:05');
});
