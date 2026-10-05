// Film yourself, the bridge's half (tools/lipsync-server.mjs POST /portrait):
// a Wav2Lip that is set up with no portrait yet still serves, takes a film
// from the deck, prepares it with the real ffmpeg (a stand-in face detector
// for Wav2Lip's), keeps it beside lipsync.json, remembers it there, and
// offers it at once. The deck's half is in test/character.html.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lipsyncMain } from '../tools/lipsync-server.mjs';
import { winShellSkip as winSkip, rmTemp } from './helpers.mjs';

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* skip */ }
const skip = winSkip || !ffmpeg ? 'needs ffmpeg and a POSIX shell' : false;

let dir, server, base, film;
if (!skip) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-film-'));
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
  // a Wav2Lip checkout as far as the bridge can tell: inference.py and a checkpoint
  const w2l = path.join(dir, 'Wav2Lip');
  fs.mkdirSync(w2l);
  fs.writeFileSync(path.join(w2l, 'inference.py'), '');
  fs.writeFileSync(path.join(w2l, 'ckpt.pth'), '');
  // its python, as far as the face detector goes: a face in every frame,
  // unless a file named NOFACE is beside it
  const python = path.join(dir, 'python');
  fs.writeFileSync(python, `#!/bin/sh
shift 2
if [ -e "${path.join(dir, 'NOFACE')}" ]; then f=null; else f="[200,100,420,380]"; fi
out=""; for x in "$@"; do out="$out,$f"; done
echo "[\${out#,}]"
`);
  fs.chmodSync(python, 0o755);
  film = path.join(dir, 'take.webm');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3',
    '-c:v', 'libvpx', '-b:v', '500k', film]);
  server = await lipsyncMain(['--port', '0', '--rhubarb', path.join(dir, 'no-rhubarb'), '--cache-dir', path.join(dir, 'cache'),
    '--wav2lip-dir', w2l, '--wav2lip-ckpt', path.join(w2l, 'ckpt.pth'), '--python', python]);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  after(() => { server.close(); rmTemp(dir); });
}

const post = (q, body, type = 'video/webm') => fetch(`${base}/portrait${q}`, { method: 'POST', headers: { 'content-type': type }, body });

test('Wav2Lip with no portrait yet: the bridge serves, and says it can take a film', { skip }, async () => {
  const j = await (await fetch(`${base}/ping`)).json();
  assert.equal(j.film, true);
  assert.equal(j.filmWhy, undefined);
  assert.deepEqual(j.engines.video, [], 'no portrait, no video — yet');
  assert.match(j.videoWhy, /no portrait/);
});

test('a film from the deck becomes a portrait: prepared, kept, remembered, offered at once', { skip }, async () => {
  const r = await post('?name=filmed', fs.readFileSync(film));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.name, 'filmed');
  assert.equal(j.steady, true);
  assert.equal(j.faces, '3/3');
  const kept = path.join(dir, 'config', 'decklight', 'portraits', 'filmed.webm');
  assert.equal(j.file, kept);
  assert.ok(fs.existsSync(kept));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'decklight', 'lipsync.json'), 'utf8'));
  assert.deepEqual(cfg.portraits, [`filmed=${kept}`]);
  assert.equal(cfg.wav2lipDir, path.join(dir, 'Wav2Lip'), 'the setup is saved with it, so a plain write mode finds it');
  const ping = await (await fetch(`${base}/ping`)).json();
  assert.deepEqual(ping.engines.video, ['wav2lip'], 'video is on without a restart');
  assert.ok(ping.portraits.includes('filmed'));
  const still = await fetch(`${base}/portrait?name=filmed`);
  assert.equal(still.status, 200);
  assert.equal(still.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache')).filter((f) => f.startsWith('upload-')), [], 'the upload is not left behind');

  // a retake in another container replaces the take, never sits beside it
  const again = await post('?name=filmed', fs.readFileSync(film), 'video/mp4');
  assert.equal(again.status, 200);
  assert.deepEqual(fs.readdirSync(path.dirname(kept)).sort(), ['filmed.mp4']);
});

test('what the bridge will not take is said, and nothing is kept', { skip }, async () => {
  const bad = await post('?name=../etc', fs.readFileSync(film));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /letters, digits/);
  assert.equal((await post('?name=default', fs.readFileSync(film))).status, 400, "'default' is an alias, not a name");
  const type = await post('?name=x', fs.readFileSync(film), 'image/png');
  assert.equal(type.status, 415);
  fs.writeFileSync(path.join(dir, 'NOFACE'), '');
  try {
    // a film never seen before (the one above is prepared, and cached by content)
    const back = path.join(dir, 'back.webm');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=gray:size=320x240:rate=25:duration=2', '-c:v', 'libvpx', back]);
    const noface = await post('?name=back', fs.readFileSync(back));
    assert.equal(noface.status, 422);
    const { error } = await noface.json();
    assert.match(error, /no face found in the film — film the face toward the camera/);
    assert.ok(!error.includes(dir), 'no temp path in what the deck shows');
  } finally { fs.rmSync(path.join(dir, 'NOFACE')); }
  const ping = await (await fetch(`${base}/ping`)).json();
  assert.ok(!ping.portraits.includes('back') && !ping.portraits.includes('x'));
});
