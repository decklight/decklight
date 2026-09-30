// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The talking-head setup, remembered (tools/lipsync-config.mjs) — and the one
// answer to "can neural video run, and if not why", shared by the bridge,
// `author` and `doctor`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lipsyncConfigPath, loadLipsyncConfig, saveLipsyncConfig, parsePortrait, videoSetup, SETUP_HINT } from '../tools/lipsync-config.mjs';
import { planServices } from '../cli/dev.mjs';

test('the setup lives beside tts.json, round-trips, and a missing file is "not set up", not an error', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dl-lips-'));
  const env = { XDG_CONFIG_HOME: home };
  assert.equal(lipsyncConfigPath(env), path.join(home, 'decklight', 'lipsync.json'));
  assert.equal(loadLipsyncConfig(env), null);
  saveLipsyncConfig({ wav2lipDir: '/w', portraits: ['me=/p.jpg'] }, env);
  assert.deepEqual(loadLipsyncConfig(env), { wav2lipDir: '/w', portraits: ['me=/p.jpg'] });
});

test('a portrait is name=path, or a bare path named by its file', () => {
  assert.deepEqual(parsePortrait('me=/tmp/face.jpg'), ['me', '/tmp/face.jpg']);
  assert.deepEqual(parsePortrait('/tmp/gilles.png'), ['gilles', '/tmp/gilles.png']);
});

test('videoSetup says which engines can run — and, when none can, exactly what is missing', () => {
  const have = (...files) => (f) => files.includes(f);
  const ok = videoSetup({ wav2lipDir: '/w', wav2lipCkpt: '/w/c.pth', portraits: ['me=/p.jpg'] },
    { exists: have('/w/inference.py', '/w/c.pth', '/p.jpg') });
  assert.deepEqual(ok, { engines: ['wav2lip'], problems: [] });
  const noCkpt = videoSetup({ wav2lipDir: '/w', portraits: ['me=/p.jpg'] }, { exists: have('/w/inference.py', '/p.jpg') });
  assert.deepEqual(noCkpt.engines, []);
  assert.match(noCkpt.problems[0], /needs its checkpoint/);
  const noRepo = videoSetup({ wav2lipDir: '/nope', wav2lipCkpt: '/c', portraits: ['/p.jpg'] }, { exists: have('/c', '/p.jpg') });
  assert.match(noRepo.problems[0], /no Wav2Lip checkout at \/nope/);
  const noFace = videoSetup({ wav2lipDir: '/w', wav2lipCkpt: '/c' }, { exists: have('/w/inference.py', '/c') });
  assert.match(noFace.problems.join(), /no portrait/);
  const lostFace = videoSetup({ wav2lipDir: '/w', wav2lipCkpt: '/c', portraits: ['me=/gone.jpg'] }, { exists: have('/w/inference.py', '/c') });
  assert.match(lostFace.problems.join(), /portrait not found: me/);
  assert.match(SETUP_HINT, /--save$/);
});

test('author starts the lip-sync bridge for a saved talking head — rhubarb or not — and says how to set one up otherwise', () => {
  const noRhubarb = { args: ['deck.html', '--no-tts'], hasBin: () => false, env: {} };
  const saved = planServices({ ...noRhubarb, lipsync: { wav2lipDir: '/w', wav2lipCkpt: '/c', portraits: ['me=/p.jpg'] } });
  assert.ok(saved.run.some((s) => s.name === 'lipsync'), 'a saved setup starts it');
  const none = planServices(noRhubarb);
  assert.ok(!none.run.some((s) => s.name === 'lipsync'));
  assert.match(none.skip.find((s) => s.name === 'lip-sync').why, /decklight lipsync --wav2lip-dir .* --save/);
});
