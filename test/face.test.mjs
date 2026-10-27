// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Your face, filmed while you record the deck: where a slide places it
// (FACE_LAYOUT), the clips the server makes of it, the manifest that says a
// slide was filmed, and the frames `decklight video` composes it into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { have } from './helpers.mjs';
import { parseFaceLayout, faceLayout, FACE_CORNER } from '../tools/face-layout.mjs';
import { wavSeconds, faceClipArgs, faceJoinArgs, writeFaceClip, joinFaceClips } from '../tools/face-clip.mjs';
import { extractFaces, faceFor, segmentArgs, FACE_CORNER_PX } from '../tools/video.mjs';
import { recorderManifest } from '../tools/narration-manifest.mjs';
import { recordUrl } from '../cli/record.mjs';
import { videoExportProblem } from '../cli/edit.mjs';

// ── FACE_LAYOUT ─────────────────────────────────────────────────────────────
test('data-face: no attribute, or nothing it understands, is the corner', () => {
  assert.deepEqual(faceLayout(null), FACE_CORNER);
  assert.deepEqual(faceLayout(''), FACE_CORNER);
  assert.deepEqual(faceLayout('sideways'), FACE_CORNER);
  assert.deepEqual(parseFaceLayout('sideways 1.4').bad, ['sideways', '1.4'], 'a zoom with no full before it is not read either');
});

test('data-face: a slide-wide value, with a zoom only full takes', () => {
  assert.deepEqual(faceLayout('full'), { kind: 'full', zoom: 1 });
  assert.deepEqual(faceLayout('full 1.4'), { kind: 'full', zoom: 1.4 });
  assert.deepEqual(faceLayout('FULL 1.5x'), { kind: 'full', zoom: 1.5 }, 'any case, and 1.5x as a person writes it');
  assert.deepEqual(faceLayout('full ×2', 3), { kind: 'full', zoom: 2 }, 'every beat of the slide');
  assert.deepEqual(faceLayout('full 9'), { kind: 'full', zoom: 4 }, 'clamped: a 9× crop is a blur');
  assert.deepEqual(faceLayout('full 0.5'), { kind: 'full', zoom: 1 }, 'never smaller than the frame it fills');
  assert.deepEqual(faceLayout('hide'), { kind: 'hide', zoom: 1 });
});

test('data-face: each beat value holds until the next one', () => {
  const attr = 'hide 3:full 1.5 4:corner';
  assert.deepEqual([1, 2, 3, 4, 5].map((b) => faceLayout(attr, b).kind), ['hide', 'hide', 'full', 'corner', 'corner']);
  assert.equal(faceLayout(attr, 3).zoom, 1.5);
  // a beat-only attribute leaves the beats before it in the corner
  assert.deepEqual([1, 2].map((b) => faceLayout('2:full', b).kind), ['corner', 'full']);
  // out of order, or the same beat twice: sorted, the later one wins
  assert.deepEqual(parseFaceLayout('4:hide 2:full 2:corner').rules.map((r) => [r.from, r.kind]), [[2, 'corner'], [4, 'hide']]);
});

// ── the clips ───────────────────────────────────────────────────────────────
/** A 16-bit mono WAV of `secs` of silence at `rate`. */
function wav(secs, rate = 24000) {
  const data = Math.round(secs * rate) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

test('wavSeconds reads a WAV\'s length off its header, and nothing else', () => {
  assert.equal(wavSeconds(wav(1.5)), 1.5);
  assert.equal(wavSeconds(wav(2, 48000)), 2);
  assert.equal(wavSeconds(Buffer.from('not a wav at all')), null);
  assert.equal(wavSeconds(null), null);
});

test('a filmed beat is cut or held to its WAV, silent, at one frame rate', () => {
  const a = faceClipArgs({ input: 'take', out: 'slide-02-01.mp4', seconds: 3.2 });
  assert.ok(a.includes('-an'), 'the voice is the WAV\'s, never the camera\'s');
  assert.equal(a[a.indexOf('-t') + 1], '3.200');
  assert.match(a[a.indexOf('-vf') + 1], /fps=25,.*tpad=stop_mode=clone:stop_duration=3\.200/);
  assert.equal(a.at(-1), 'slide-02-01.mp4');
  // the beats are joined as they are: made alike, they need no re-encode
  const j = faceJoinArgs({ list: 'l.txt', out: 'slide-02.mp4' });
  assert.deepEqual(j.slice(j.indexOf('-i'), j.indexOf('-i') + 4), ['-i', 'l.txt', '-c', 'copy']);
});

test('with ffmpeg: a take comes out as long as its beat, and the beats join into the slide', { skip: !have('ffmpeg') || !have('ffprobe') }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-face-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = (f) => path.join(dir, f);
  // a take longer than the beat, at another frame rate, in the container Chrome films in
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2.4', '-c:v', 'libvpx', '-f', 'webm', at('a.webm')]);
  // …and one shorter than its beat
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '0.6', '-c:v', 'libvpx', '-f', 'webm', at('b.webm')]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(at('slide-01-01.wav'), wav(1.6));
  writeFileSync(at('slide-01-02.wav'), wav(1.2));
  await writeFaceClip({ bytes: readFileSync(at('a.webm')), out: at('slide-01-01.mp4'), wav: at('slide-01-01.wav') });
  await writeFaceClip({ bytes: readFileSync(at('b.webm')), out: at('slide-01-02.mp4'), wav: at('slide-01-02.wav') });
  await joinFaceClips({ parts: [at('slide-01-01.mp4'), at('slide-01-02.mp4')], out: at('slide-01.mp4') });
  const secs = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', at(f)]).toString());
  // within a frame (1/25 s) of the WAV: cut, held, and summed
  assert.ok(Math.abs(secs('slide-01-01.mp4') - 1.6) <= 0.041, `cut: ${secs('slide-01-01.mp4')}`);
  assert.ok(Math.abs(secs('slide-01-02.mp4') - 1.2) <= 0.041, `held: ${secs('slide-01-02.mp4')}`);
  assert.ok(Math.abs(secs('slide-01.mp4') - 2.8) <= 0.081, `joined: ${secs('slide-01.mp4')}`);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', at('slide-01.mp4')]).toString().trim();
  assert.equal(streams, 'video', 'no sound in a face clip');
});

// ── the manifest ────────────────────────────────────────────────────────────
test('the recorder\'s manifest says which slides were filmed', () => {
  const header = { engine: null, model: null, voice: null, style: null };
  const m = recorderManifest({ prev: null, header, texts: ['a', 'b'], range: { from: 1, to: 2 },
    recorded: { 1: { segments: [1, 2], face: true }, 2: { segments: [] } }, recorder: 'mic' });
  assert.equal(m.slides[0].face, true);
  assert.equal('face' in m.slides[1], false, 'an unfilmed slide says nothing, as it always has');
});

// ── the export ──────────────────────────────────────────────────────────────
const DECK = '<div class="decklight"><section data-face="full 1.4"><h1>a</h1></section>'
  + '<section><h1>b</h1></section><section class="x" data-face="hide 2:corner"><h1>c</h1></section></div>';

test('extractFaces reads each slide\'s own data-face, not one in its content', () => {
  const html = DECK.replace('<h1>b</h1>', '<p data-face="full">b</p>');
  assert.deepEqual(extractFaces(html), ['full 1.4', null, 'hide 2:corner']);
});

test('faceFor: a filmed slide\'s clip beside its audio, placed as the slide says for that beat', () => {
  const faces = extractFaces(DECK);
  const narration = { dir: '/n', slides: [{ face: true }, null, { face: true }] };
  const all = () => true;
  assert.deepEqual(faceFor({ slide: 1, audio: 'slide-01.wav' }, { narration, faces, exists: all }),
    { clip: path.join('/n', 'slide-01.mp4'), kind: 'full', zoom: 1.4 });
  // beat 1 of slide 3 is hidden: no face composed into that frame
  assert.equal(faceFor({ slide: 3, audio: 'slide-03-01.wav' }, { narration, faces, exists: all }), null);
  assert.deepEqual(faceFor({ slide: 3, audio: 'slide-03-02.wav' }, { narration, faces, exists: all }),
    { clip: path.join('/n', 'slide-03-02.mp4'), kind: 'corner', zoom: 1 });
  // not filmed, silent, or the clip is gone: nothing
  assert.equal(faceFor({ slide: 2, audio: 'slide-02.wav' }, { narration, faces, exists: all }), null);
  assert.equal(faceFor({ slide: 1, audio: null }, { narration, faces, exists: all }), null);
  assert.equal(faceFor({ slide: 1, audio: 'slide-01.wav' }, { narration, faces, exists: () => false }), null);
  // a clip `decklight lipsync` rendered is not your face: only a filmed slide composes one
  assert.equal(faceFor({ slide: 1, audio: 'slide-01.wav' }, { narration: { dir: '/n', slides: [{}] }, faces, exists: all }), null);
});

test('segmentArgs: a face segment composes the clip; a plain one is as it was', () => {
  const base = { frame: 'f.png', audio: 'a.wav', duration: 3, pad: 0.4, fps: 30, out: 's.mp4' };
  const plain = segmentArgs(base);
  assert.ok(!plain.includes('-filter_complex'));
  assert.deepEqual(segmentArgs({ ...base, face: null, size: { w: 1280, h: 720 } }), plain, 'no face, no change');

  const corner = segmentArgs({ ...base, face: { clip: 'c.mp4', kind: 'corner', zoom: 1 }, size: { w: 1280, h: 720 } });
  const g = corner[corner.indexOf('-filter_complex') + 1];
  const { size: d, margin: m } = FACE_CORNER_PX;
  assert.match(g, new RegExp(`overlay=${1280 - d - m}:${720 - d - m}`), 'bottom right, where the deck puts it');
  assert.match(g, /geq=.*hypot/, 'cut round');
  assert.match(g, /\[1:a\]apad=pad_dur=0\.4\[a\]/);
  assert.deepEqual(corner.slice(corner.indexOf('-map'), corner.indexOf('-map') + 4), ['-map', '[v]', '-map', '[a]']);
  assert.equal(corner[corner.indexOf('-t') + 1], '3.000');

  const full = segmentArgs({ ...base, face: { clip: 'c.mp4', kind: 'full', zoom: 1.5 }, size: { w: 1280, h: 720 } });
  const gf = full[full.indexOf('-filter_complex') + 1];
  assert.match(gf, /scale=1920:1080:force_original_aspect_ratio=increase,crop=1280:720:\(iw-1280\)\/2:\(ih-720\)\*0\.4/);
  assert.doesNotMatch(gf, /overlay/, 'the slide steps aside');
});

// ── the doors ───────────────────────────────────────────────────────────────
test('narrate --mic --camera opens the recorder with the camera on', () => {
  assert.equal(recordUrl(8788, '/talk.html', null, null, null, null, null, true), 'http://127.0.0.1:8788/talk.html?record&camera');
  assert.equal(recordUrl(8788, '/talk.html', null, null, null, null, null), 'http://127.0.0.1:8788/talk.html?record');
});

test('the export card\'s Face is on or off, and nothing else', () => {
  assert.equal(videoExportProblem({ face: 'on' }, '/x'), null);
  assert.equal(videoExportProblem({ face: 'off' }, '/x'), null);
  assert.match(videoExportProblem({ face: 'maybe' }, '/x'), /face must be on, off/);
});
