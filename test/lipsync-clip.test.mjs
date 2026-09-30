// A FILMED portrait (tools/lipsync-engines.mjs `prepareClip`): the pure parts
// — which files are films, the head's square, whether the head held still —
// and the loop itself, made by the real ffmpeg from a generated film with a
// stand-in for Wav2Lip's face detector. Wav2Lip itself needs a GPU and its
// checkpoints, and is run by hand.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isClip, squareAround, steadyBox, prepareClip, CLIP_MAX_SECONDS } from '../tools/lipsync-engines.mjs';
import { winShellSkip as winSkip, rmTemp } from './helpers.mjs';

test('a portrait is a film by its extension, whatever the case', () => {
  for (const f of ['me.mp4', 'me.MOV', 'a/b.m4v', 'x.webm', 'y.mkv']) assert.equal(isClip(f), true, f);
  for (const f of ['me.jpg', 'me.png', 'mp4', 'me.mp4.jpg']) assert.equal(isClip(f), false, f);
});

test('the head square is 1.7× the face, face a little above centre, inside the frame, even', () => {
  const box = { x1: 400, y1: 300, x2: 600, y2: 550 };
  const { x, y, side } = squareAround(box, 1024, 1024);
  assert.equal(side, 424); // 1.7 × 250 = 425 → even
  assert.equal(side % 2, 0);
  assert.equal(x, 288);
  assert.ok(y >= 0 && y + side <= 1024);
  // a face near the edge is not cropped off-frame
  const edge = squareAround({ x1: 0, y1: 0, x2: 200, y2: 250 }, 1024, 768);
  assert.deepEqual([edge.x, edge.y], [0, 0]);
  // never larger than the frame
  assert.equal(squareAround({ x1: 0, y1: 0, x2: 700, y2: 700 }, 800, 600).side, 600);
});

test('a head that held still keeps one box; one that wandered, or left the frame, does not', () => {
  const at = (dx, dy) => ({ x1: 100 + dx, y1: 100 + dy, x2: 300 + dx, y2: 350 + dy });
  const still = steadyBox([at(0, 0), at(5, 3), at(-4, 8), at(10, 0)]);
  assert.equal(still.steady, true);
  assert.deepEqual(still.box, { x1: 96, y1: 100, x2: 310, y2: 358 }, 'the union of every frame');
  assert.equal(steadyBox([at(0, 0), at(60, 0)]).steady, false, '60 px on a 200 px face is a turn');
  const lost = steadyBox([at(0, 0), null, at(2, 2)]);
  assert.equal(lost.steady, false, 'a frame with no face is not steady');
  assert.equal(lost.found, 2);
  assert.deepEqual(steadyBox([null, null]), { box: null, steady: false, found: 0 });
});

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* skip */ }
const skip = winSkip || !ffmpeg ? 'needs ffmpeg and a POSIX shell' : false;

let dir;
after(() => dir && rmTemp(dir));

// A stand-in for Wav2Lip's python: every frame it is shown has a face at the
// same place, unless FACE=none. It logs the frames it was given.
function fakePython(d, { face = [400, 150, 600, 400] } = {}) {
  const bin = path.join(d, 'python');
  fs.writeFileSync(bin, `#!/bin/sh
shift 2
echo "$#" >> "${path.join(d, 'detect.log')}"
out=""
for f in "$@"; do out="$out,${face ? `[${face.join(',')}]` : 'null'}"; done
echo "[\${out#,}]"
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('a film becomes a square loop that plays there and back, with its first frame as the still', { skip }, async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-clip-'));
  const clip = path.join(dir, 'me.mov');
  // 12 s at 30 fps, 1280×720 with a sound track — longer, faster, wider and
  // noisier than what Wav2Lip is given
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=duration=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir);
  const python = fakePython(dir);
  const c = await prepareClip(python, { dir, clip, cacheDir });

  assert.equal(c.steady, true);
  assert.equal(c.faces, `${CLIP_MAX_SECONDS}/${CLIP_MAX_SECONDS}`, 'one frame a second, the film cut to its first 10 s');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=width,height,nb_read_frames,r_frame_rate,codec_type', '-of', 'json', c.loop], { encoding: 'utf8' }));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  assert.equal(probe.streams.length, 1, 'no sound: the deck owns the voice');
  assert.equal(v.width, v.height, 'square, for the round medallion');
  assert.equal(v.r_frame_rate, '25/1');
  assert.equal(Number(v.nb_read_frames), 2 * 250 - 1, 'forward, then back without doubling the turn-around frame');
  // scaled to at most 1024 wide (1024×576) before the face is looked for; the
  // box found there is moved into the square crop
  const { side } = squareAround({ x1: 400, y1: 150, x2: 600, y2: 425 }, 1024, 576);
  assert.equal(v.width, side);
  assert.ok(c.box.x1 >= 0 && c.box.y1 >= 0 && c.box.x2 <= side && c.box.y2 <= side, JSON.stringify(c.box));
  assert.ok(fs.statSync(c.still).size > 0, 'the still under the video');

  // prepared ONCE: a second ask reads the cache, the detector is not run again
  const again = await prepareClip(python, { dir, clip, cacheDir });
  assert.deepEqual(again, c);
  assert.equal(fs.readFileSync(path.join(dir, 'detect.log'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(fs.readdirSync(cacheDir).filter((f) => f.includes('.tmp')), [], 'no work files left behind');
});

test('a film with no face in it is refused in a sentence, and nothing is cached', { skip }, async () => {
  const d = fs.mkdtempSync(path.join(dir ?? os.tmpdir(), 'noface-'));
  const clip = path.join(d, 'back.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=gray:size=320x240:rate=25:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const cacheDir = path.join(d, 'cache');
  fs.mkdirSync(cacheDir);
  await assert.rejects(prepareClip(fakePython(d, { face: null }), { dir: d, clip, cacheDir }), /no face found in .*back\.mp4 — film the face toward the camera/);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});
