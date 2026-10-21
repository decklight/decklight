// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Which harnesses a shard of `npm run verify` runs.
 *
 * `VERIFY_SHARD=2/3` is "the second of three": the harness list dealt out
 * round-robin, so shard i of n takes every n-th harness starting at the i-th.
 * Deterministic over the list and nothing else — no timing table to drift, and
 * the n shards together are exactly the suite, each harness in exactly one of
 * them. Round-robin rather than contiguous because the slow harnesses are
 * spread through the list (narration-render:live, record-render,
 * engine-render:authoring, extension-check-render); on windows-latest three
 * shards came out at 170s, 266s and 217s against 654s for the whole.
 *
 * A module of its own, pure over the list, because verify.mjs is a SCRIPT —
 * importing it runs the suite — and the one failure a sharded run must never
 * have is a harness that no shard runs.
 */

/**
 * Parse `i/n`. Throws on anything that is not two integers with 1 ≤ i ≤ n:
 * a shard that quietly ran nothing, or everything, would be the silent kind
 * of green.
 */
export function parseShard(spec) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(spec ?? '');
  if (!m) throw new Error(`VERIFY_SHARD must be "i/n", got "${spec}"`);
  const [index, count] = [Number(m[1]), Number(m[2])];
  if (count < 1 || index < 1 || index > count) {
    throw new Error(`VERIFY_SHARD "${spec}": need 1 ≤ i ≤ n`);
  }
  return { index, count };
}

/** Shard `index` of `count` over `list`, in the list's own order. */
export function shardOf(list, { index, count }) {
  return list.filter((_, i) => i % count === index - 1);
}
