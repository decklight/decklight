// tools/lipsync.mjs (batch sidecar generator): output schema and the
// hash-incremental lipsync.json state, against a stub rhubarb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '../tools/lipsync.mjs');
const winSkip = process.platform === 'win32' ? 'stub rhubarb is a shell script' : false;

test('batch visemes: generates sidecars, second run keeps them, edits invalidate', { skip: winSkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-lipsync-batch-'));
  const fixture = path.join(here, 'fixtures', 'rhubarb-out.json');
  const stub = path.join(dir, 'rhubarb');
  fs.writeFileSync(stub, `#!/bin/sh
[ "$1" = "--version" ] && { echo "Rhubarb stub"; exit 0; }
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cp "${fixture}" "$out"
`, { mode: 0o755 });

  // a fake ⇧V-style voiceover set: two wav slides, one with a transcript
  const vo = path.join(dir, 'voiceover');
  fs.mkdirSync(vo);
  fs.writeFileSync(path.join(vo, 'slide-01.wav'), Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(512, 1)]));
  fs.writeFileSync(path.join(vo, 'slide-01.txt'), 'Hello from slide one.');
  fs.writeFileSync(path.join(vo, 'slide-02.wav'), Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(512, 2)]));

  const run = () => execFileSync('node', [TOOL, vo, '--rhubarb', stub], { encoding: 'utf8' });

  const first = run();
  assert.match(first, /2 slides with audio/);
  assert.match(first, /2 generated/);
  const tl = JSON.parse(fs.readFileSync(path.join(vo, 'slide-01.visemes.json'), 'utf8'));
  assert.equal(tl.v, 1);
  assert.equal(tl.kind, 'visemes');
  assert.equal(tl.duration, 2.72);
  assert.ok(tl.cues.every((c) => typeof c.t === 'number' && /^[A-HX]$/.test(c.v)));
  assert.ok(fs.existsSync(path.join(vo, 'slide-02.visemes.json')));
  // temp decode/dialog files are cleaned up
  assert.ok(!fs.readdirSync(vo).some((f) => f.includes('.tmp.')));

  // unchanged audio → everything kept
  const second = run();
  assert.match(second, /0 generated, 2 unchanged/);

  // new audio bytes for slide 2 → only that slide regenerates
  fs.writeFileSync(path.join(vo, 'slide-02.wav'), Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(512, 3)]));
  const third = run();
  assert.match(third, /slide 01: visemes unchanged — kept/);
  assert.match(third, /1 generated, 1 unchanged/);

  fs.rmSync(dir, { recursive: true, force: true });
});
