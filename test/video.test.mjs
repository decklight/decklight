// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/video.mjs — the timeline math and the ffmpeg/Chrome arg builders,
// without ffmpeg or a browser: what matters here is that every slide gets the
// right duration (narration + tail, or its hold), that silent slides still
// carry an audio stream, and that the narration dir resolves in the documented
// order. The end-to-end (real Chrome + ffmpeg) lives in test/video-e2e.mjs,
// runnable manually — deliberately not part of this suite or `npm run verify`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAIL_SECONDS, LAST_STEP, parseSize, parseSlideRange, extractHolds, planTimeline,
  segmentArgs, concatList, concatArgs, ffprobeArgs, resolveNarration, parseBuildSteps,
} from '../tools/video.mjs';

// --- planTimeline -------------------------------------------------------------

const manifest = [
  { file: 'slide-01.m4a', hash: 'aa' },
  null,                                  // slide 2: no notes → silent
  { file: 'slide-03.m4a', hash: 'cc' },
];
const durations = { 'slide-01.m4a': 3.2, 'slide-03.m4a': 7.05 };

test('a narrated slide holds for its REAL audio duration plus the tail', () => {
  const plan = planTimeline(manifest, durations, [5, 5, 5]);
  assert.deepEqual(plan[0], { slide: 1, step: LAST_STEP, audio: 'slide-01.m4a', duration: 3.2 + TAIL_SECONDS });
  assert.deepEqual(plan[2], { slide: 3, step: LAST_STEP, audio: 'slide-03.m4a', duration: 7.45 });
});

test('a slide without narration holds --hold seconds, per-slide override included', () => {
  const plan = planTimeline(manifest, durations, [5, 8, 5]);   // slide 2: data-video-hold="8"
  assert.deepEqual(plan[1], { slide: 2, step: LAST_STEP, audio: null, duration: 8 });
});

test('a fully silent deck (no manifest) is all holds — and still one entry per slide', () => {
  const plan = planTimeline(null, {}, [5, 1.5, 5]);
  assert.deepEqual(plan.map((p) => p.audio), [null, null, null]);
  assert.deepEqual(plan.map((p) => p.duration), [5, 1.5, 5]);
});

test('a manifest entry whose audio has no measured duration falls back to the hold', () => {
  const plan = planTimeline(manifest, { 'slide-01.m4a': 3.2 }, [5, 5, 6]);
  assert.deepEqual(plan[2], { slide: 3, step: LAST_STEP, audio: null, duration: 6 });
});

test('--slides a-b keeps absolute slide numbers and manifest alignment', () => {
  const plan = planTimeline(manifest, durations, [5, 5, 5], { from: 2, to: 3 });
  assert.deepEqual(plan.map((p) => p.slide), [2, 3]);
  assert.equal(plan[1].audio, 'slide-03.m4a');
});

// --- flag parsing -------------------------------------------------------------

test('parseSlideRange: a-b, a single slide, and the honest failures', () => {
  assert.deepEqual(parseSlideRange('2-3', 5), { from: 2, to: 3 });
  assert.deepEqual(parseSlideRange('4', 5), { from: 4, to: 4 });
  assert.deepEqual(parseSlideRange(undefined, 5), { from: 1, to: 5 });
  assert.throws(() => parseSlideRange('0-2', 5), /outside this deck/);
  assert.throws(() => parseSlideRange('3-9', 5), /outside this deck/);
  assert.throws(() => parseSlideRange('3-2', 5), /outside this deck/);
  assert.throws(() => parseSlideRange('a-b', 5), /--slides/);
});

test('parseSize accepts WxH and refuses odd dimensions (yuv420p would)', () => {
  assert.deepEqual(parseSize('1280x720'), { w: 1280, h: 720 });
  assert.throws(() => parseSize('1281x720'), /even/);
  assert.throws(() => parseSize('720p'), /WxH/);
});

test('extractHolds reads data-video-hold off each section, default elsewhere', () => {
  const html = `<div class="decklight">
    <section><h2>one</h2></section>
    <section data-video-hold="8" data-layout="top"><h2>two</h2></section>
    <section data-transition="fade"><p data-video-hold="9">an attr on CONTENT is not a slide hold</p></section>
  </div>`;
  assert.deepEqual(extractHolds(html, 5), [5, 8, 5]);
});

// --- ffmpeg arg builders --------------------------------------------------------

test('a narrated segment loops the still under the audio, padded by the tail', () => {
  const a = segmentArgs({ frame: 'f.png', audio: 'slide-01.m4a', duration: 3.6, fps: 30, out: 'seg.mp4' });
  const arg = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(arg('-framerate'), '30');
  assert.equal(a.filter((x) => x === '-i').length, 2, 'two inputs: the still and the audio');
  assert.equal(a[a.lastIndexOf('-i') + 1], 'slide-01.m4a');
  assert.equal(arg('-af'), `apad=pad_dur=${TAIL_SECONDS}`);
  assert.equal(arg('-tune'), 'stillimage');
  assert.equal(arg('-pix_fmt'), 'yuv420p');
  assert.equal(arg('-t'), '3.600');
  assert.equal(a[a.length - 1], 'seg.mp4');
});

test('a silent segment still carries an audio stream — anullsrc, same codec params', () => {
  const a = segmentArgs({ frame: 'f.png', audio: null, duration: 5, fps: 30, out: 'seg.mp4' });
  assert.ok(a.includes('anullsrc=channel_layout=stereo:sample_rate=44100'),
    'concat with -c copy needs every segment to have audio');
  assert.ok(!a.includes('-af'), 'nothing to pad — the hold IS the silence');
  assert.equal(a[a.indexOf('-t') + 1], '5.000');
  // identical audio encode params to the narrated case, or -c copy concat breaks
  for (const flag of ['-c:a', '-ar', '-ac']) {
    const narrated = segmentArgs({ frame: 'f.png', audio: 'x.m4a', duration: 1, fps: 30, out: 'o.mp4' });
    assert.equal(a[a.indexOf(flag) + 1], narrated[narrated.indexOf(flag) + 1]);
  }
});

test('concat is the demuxer with -c copy, list quoting included', () => {
  assert.equal(concatList(['/tmp/a.mp4', "/tmp/it's.mp4"]),
    "file '/tmp/a.mp4'\nfile '/tmp/it'\\''s.mp4'\n");
  const a = concatArgs('list.txt', 'out.mp4');
  assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 2), ['-f', 'concat']);
  assert.ok(a.includes('copy'));
  assert.equal(a[a.length - 1], 'out.mp4');
});

test('ffprobe asks for the format duration, one bare number', () => {
  const a = ffprobeArgs('x.m4a');
  assert.ok(a.includes('format=duration'));
  assert.equal(a[a.length - 1], 'x.m4a');
});

// --- narration resolution -------------------------------------------------------

test('narration resolves --narration → deck voiceover/ → silent, in that order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-test-'));
  try {
    const deck = join(dir, 'deck.html');
    writeFileSync(deck, '<section></section>');

    // nothing anywhere → silent
    assert.equal(resolveNarration(deck, undefined), null);

    // the deck's own voiceover/ artifact is picked up automatically
    const vo = join(dir, 'voiceover');
    mkdirSync(vo);
    writeFileSync(join(vo, 'manifest.json'),
      JSON.stringify({ engine: 'piper', slides: [{ file: 'slide-01.m4a', hash: 'x' }] }));
    assert.equal(resolveNarration(deck, undefined).dir, vo);

    // an explicit --narration dir wins over it
    const other = join(dir, 'take2');
    mkdirSync(other);
    writeFileSync(join(other, 'manifest.json'), JSON.stringify({ slides: [null] }));
    assert.equal(resolveNarration(deck, other).dir, other);

    // …and an explicit dir WITHOUT a manifest is an error, not a silent fallback
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    assert.throws(() => resolveNarration(deck, empty), /no manifest\.json/);

    // a manifest that is not a voiceover manifest is named, not half-read
    writeFileSync(join(other, 'manifest.json'), JSON.stringify({ files: [] }));
    assert.throws(() => resolveNarration(deck, other), /not a voiceover manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the help convention ------------------------------------------------------

test('--help is an answer, not a failure — like every other command', () => {
  // `video` was the one command in the roster that answered `--help` on stderr
  // with exit 1, because one branch served two situations and took its stream
  // and its exit code from whether a deck was named rather than from which
  // situation it was in. Asking for help is not a failure; naming no deck is.
  // (Found by the `npm run soak` help sweep across all 26 commands.)
  const CLI = fileURLToPath(new URL('../cli/decklight.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [CLI, 'video', ...args], { encoding: 'utf8' });

  for (const flag of ['--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, `video ${flag} exited ${r.status}`);
    assert.match(r.stdout, /decklight video/, `video ${flag} wrote nothing to stdout`);
  }
  // No deck is still a refusal, and still on stderr.
  const bare = run();
  assert.equal(bare.status, 1);
  assert.equal(bare.stdout, '');
  assert.match(bare.stderr, /decklight video/);
});

// --- builds get frames of their own (silent slides only) ----------------------

test('a silent slide with builds becomes one frame per step, each holding --hold', () => {
  // Every frame gets the slide's hold, so a build lands at the pace the rest of
  // the deck moves at. Splitting the hold across the frames instead was tried
  // and reads far too fast — the more a slide has to say, the less time each
  // beat of it got.
  const plan = planTimeline(null, {}, [2, 2], null, { steps: [0, 3] });
  assert.deepEqual(plan.map((p) => [p.slide, p.step, p.duration]), [
    [1, LAST_STEP, 2],
    [2, 0, 2], [2, 1, 2], [2, 2, 2], [2, LAST_STEP, 2],
  ]);
});

test('--build-hold paces the build-up frames alone; the finished slide keeps its hold', () => {
  const plan = planTimeline(null, {}, [2, 2], null, { steps: [0, 3], buildHold: 0.5 });
  assert.deepEqual(plan.map((p) => p.duration), [2, 0.5, 0.5, 0.5, 2]);
});

test("a per-slide data-video-hold paces that slide's builds too", () => {
  // extractHolds already gives each slide its own hold; builds inherit it, so
  // `data-video-hold="8"` slows a slide's build-up as well as its final state.
  const plan = planTimeline(null, {}, [1, 8], null, { steps: [0, 2] });
  assert.deepEqual(plan.map((p) => p.duration), [1, 8, 8, 8]);
});

test('the final frame of a slide is always LAST_STEP, never a counted step', () => {
  // A miscount can shorten a build-up; it must never leave the slide unfinished,
  // so the last frame is the same oversized step this command always used.
  const plan = planTimeline(null, {}, [3], null, { steps: [2] });
  assert.equal(plan.at(-1).step, LAST_STEP);
});

test('a narrated slide stays one fully-built still, builds or not', () => {
  // Splitting narration across builds needs ⟨CLICK⟩ markers mapped to real
  // timestamps; until that exists, guessing would put words under the wrong
  // build.
  const plan = planTimeline(manifest, durations, [5, 5, 5], null, { steps: [4, 4, 4] });
  assert.equal(plan.filter((p) => p.slide === 1).length, 1);
  assert.equal(plan[0].step, LAST_STEP);
  assert.equal(plan.filter((p) => p.slide === 2).length, 5, 'the silent slide still steps');
});

test('no step counts at all ⇒ exactly the old plan, one still per slide', () => {
  const plan = planTimeline(null, {}, [5, 5, 5]);
  assert.deepEqual(plan.map((p) => p.step), [LAST_STEP, LAST_STEP, LAST_STEP]);
});

test('the build-step probe is read strictly, or not at all', () => {
  assert.deepEqual(parseBuildSteps('x DECKLIGHT-BUILD-STEPS [0,3,1] y', 3), [0, 3, 1]);
  assert.equal(parseBuildSteps('nothing here', 3), null, 'a deck that did not report');
  assert.equal(parseBuildSteps('DECKLIGHT-BUILD-STEPS [0,3]', 3), null, 'a count for the wrong slide count');
  assert.equal(parseBuildSteps('DECKLIGHT-BUILD-STEPS ["err","boom"]', 2), null, 'the probe reporting a failure');
  assert.equal(parseBuildSteps('DECKLIGHT-BUILD-STEPS [1,-2]', 2), null, 'a negative count');
});
