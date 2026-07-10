// The character overlay's pure core: cue lookup, timeline stitching, and the
// Rhubarb → timeline-v1 normalization shared by the bridge and batch tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cueAt, concatTimelines } from '../src/core/character.js';
import { normalizeRhubarb } from '../tools/visemes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rhubarbFixture = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'rhubarb-out.json'), 'utf8'));

const TL = {
  v: 1, kind: 'visemes', duration: 2.0, source: 'test',
  cues: [{ t: 0.2, v: 'B' }, { t: 0.5, v: 'D' }, { t: 1.1, v: 'F' }, { t: 1.6, v: 'X' }],
};

test('cueAt returns the shape whose cue started at or before t', () => {
  assert.equal(cueAt(TL, 0.2), 'B');   // exactly on a cue boundary
  assert.equal(cueAt(TL, 0.49), 'B');  // holds until the next cue
  assert.equal(cueAt(TL, 0.5), 'D');
  assert.equal(cueAt(TL, 1.59), 'F');
  assert.equal(cueAt(TL, 1.9), 'X');
});

test('cueAt rests at X outside the timeline', () => {
  assert.equal(cueAt(TL, 0.0), 'X', 'before the first cue');
  assert.equal(cueAt(TL, 2.0), 'X', 'at duration');
  assert.equal(cueAt(TL, 5.0), 'X', 'past duration');
  assert.equal(cueAt(TL, -1), 'X', 'negative time');
  assert.equal(cueAt(TL, NaN), 'X', 'NaN (audio not started)');
  assert.equal(cueAt(null, 1), 'X', 'no timeline at all');
  assert.equal(cueAt({ cues: [] }, 1), 'X', 'empty cue list');
});

test('cueAt maps unknown shapes to X instead of leaking them to the DOM', () => {
  assert.equal(cueAt({ duration: 1, cues: [{ t: 0, v: 'Q' }] }, 0.5), 'X');
});

test('concatTimelines offsets parts by their durations and gaps', () => {
  const a = { duration: 1.0, cues: [{ t: 0, v: 'X' }, { t: 0.3, v: 'B' }] };
  const b = { duration: 0.8, cues: [{ t: 0, v: 'C' }, { t: 0.4, v: 'D' }] };
  const out = concatTimelines([{ timeline: a, gap: 0 }, { timeline: b, gap: 0.15 }]);
  assert.equal(out.v, 1);
  assert.equal(out.duration, 1.95); // 1.0 + 0.15 + 0.8
  assert.deepEqual(out.cues, [
    { t: 0, v: 'X' },
    { t: 0.3, v: 'B' },
    // the 0.15 s gap rests at X starting where part a ended
    { t: 1.0, v: 'X' },
    { t: 1.15, v: 'C' },
    { t: 1.55, v: 'D' },
  ]);
  // and the merged timeline answers lookups across the seam
  assert.equal(cueAt(out, 1.05), 'X');
  assert.equal(cueAt(out, 1.2), 'C');
});

test('concatTimelines collapses duplicate shapes across the seam', () => {
  const a = { duration: 0.5, cues: [{ t: 0, v: 'X' }] };
  const b = { duration: 0.5, cues: [{ t: 0, v: 'X' }, { t: 0.2, v: 'B' }] };
  // no gap: part b starts with X while part a already rests at X
  const out = concatTimelines([{ timeline: a }, { timeline: b }]);
  assert.deepEqual(out.cues, [{ t: 0, v: 'X' }, { t: 0.7, v: 'B' }]);
});

test('normalizeRhubarb converts runs to start-time cues and drops duplicates', () => {
  const tl = normalizeRhubarb(rhubarbFixture);
  assert.equal(tl.v, 1);
  assert.equal(tl.kind, 'visemes');
  assert.equal(tl.source, 'rhubarb');
  assert.equal(tl.duration, 2.72);
  // the fixture's consecutive B+B runs collapse into one cue
  assert.deepEqual(tl.cues.map((c) => c.v), ['X', 'B', 'C', 'D', 'F', 'B', 'G', 'E', 'H', 'X']);
  assert.deepEqual(tl.cues[1], { t: 0.17, v: 'B' });
  assert.deepEqual(tl.cues[2], { t: 0.45, v: 'C' });
  // and the normalized timeline drives cueAt directly
  assert.equal(cueAt(tl, 0.35), 'B');
  assert.equal(cueAt(tl, 2.0), 'H');
  assert.equal(cueAt(tl, 2.72), 'X');
});

test('normalizeRhubarb tolerates missing metadata', () => {
  const tl = normalizeRhubarb({ mouthCues: [{ start: 0, end: 1.5, value: 'A' }] });
  assert.equal(tl.duration, 1.5); // falls back to the last cue's end
  assert.deepEqual(tl.cues, [{ t: 0, v: 'A' }]);
});
