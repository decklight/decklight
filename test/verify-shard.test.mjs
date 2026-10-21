// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The shards of `npm run verify` (VERIFY_SHARD=i/n) must partition the suite:
// every harness in exactly one shard, no shard empty for a sane n. CI runs the
// Windows verify as three of them, and a harness that fell between two shards
// would pass CI by never running — the one outcome no suite reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, shardOf } from './verify-shard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const HARNESSES = quoted(/const HARNESSES = \[([\s\S]*?)\];/.exec(readFileSync(path.join(here, 'verify.mjs'), 'utf8'))[1]);

test('n shards together are the whole suite, each harness in exactly one', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const shards = Array.from({ length: count }, (_, i) => shardOf(HARNESSES, { index: i + 1, count }));
    assert.deepEqual(shards.flat().sort(), [...HARNESSES].sort(), `${count} shards do not cover the suite`);
    for (const s of shards) assert.ok(s.length > 0, `an empty shard at n=${count}`);
    for (const s of shards) assert.deepEqual(s, HARNESSES.filter((h) => s.includes(h)), 'a shard reorders the suite');
  }
  assert.deepEqual(shardOf(['a', 'b', 'c', 'd', 'e'], { index: 2, count: 3 }), ['b', 'e']);
});

test('the shard spec is i/n with 1 ≤ i ≤ n, and nothing else', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
  assert.deepEqual(parseShard(' 1 / 1 '), { index: 1, count: 1 });
  for (const bad of ['', '3', '0/3', '4/3', '1/0', 'a/b', '1-3', undefined]) {
    assert.throws(() => parseShard(bad), /VERIFY_SHARD/, `accepted "${bad}"`);
  }
});

test('verify.mjs refuses a bad shard before running anything', () => {
  const res = spawnSync(process.execPath, [path.join(here, 'verify.mjs')],
    { encoding: 'utf8', env: { ...process.env, VERIFY_SHARD: '4/3' } });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /VERIFY_SHARD/);
});
