// The lipsync bridge (tools/lipsync-server.mjs) against a stub rhubarb:
// route shapes, timeline-v1 schema, and the disk cache. The real rhubarb /
// Wav2Lip / SadTalker runs are exercised manually (they need the binaries
// and a GPU) — the bridge's own plumbing is what's tested here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lipsyncMain } from '../tools/lipsync-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const winSkip = process.platform === 'win32' ? 'stub rhubarb is a shell script' : false;

let dir, server, base;
if (!winSkip) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-lipsync-'));
  // a stub rhubarb: answers --version, and copies the checked-in fixture to
  // whatever -o names — the bridge should normalize + cache it
  const fixture = path.join(here, 'fixtures', 'rhubarb-out.json');
  const stub = path.join(dir, 'rhubarb');
  fs.writeFileSync(stub, `#!/bin/sh
[ "$1" = "--version" ] && { echo "Rhubarb stub"; exit 0; }
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cp "${fixture}" "$out"
`, { mode: 0o755 });
  server = await lipsyncMain(['--port', '0', '--rhubarb', stub, '--cache-dir', path.join(dir, 'cache')]);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

// 1 KB of fake WAV — the bridge only checks it's plausibly audio (>44 bytes)
const wav = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(1024)]);

test('/ping reports the available engines and portraits', { skip: winSkip }, async () => {
  const j = await (await fetch(`${base}/ping`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.engines.viseme, true);
  assert.deepEqual(j.engines.video, []); // no wav2lip/sadtalker configured
  assert.deepEqual(j.portraits, []);
});

test('/viseme returns a normalized timeline and caches it on disk', { skip: winSkip }, async () => {
  const res = await fetch(`${base}/viseme?text=${encodeURIComponent('Hey, this is Decklight.')}`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-lipsync-cached'), '0');
  const tl = await res.json();
  assert.equal(tl.v, 1);
  assert.equal(tl.kind, 'visemes');
  assert.equal(tl.duration, 2.72);
  assert.equal(tl.cues[0].v, 'X');
  assert.ok(tl.cues.every((c) => typeof c.t === 'number' && /^[A-HX]$/.test(c.v)));

  // same audio + text → served from the disk cache
  const again = await fetch(`${base}/viseme?text=${encodeURIComponent('Hey, this is Decklight.')}`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  assert.equal(again.headers.get('x-lipsync-cached'), '1');
  assert.deepEqual(await again.json(), tl);

  // different transcript → different cache key, fresh run
  const other = await fetch(`${base}/viseme?text=other`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  assert.equal(other.headers.get('x-lipsync-cached'), '0');
});

test('/viseme rejects an empty body, /video rejects a missing engine', { skip: winSkip }, async () => {
  const empty = await fetch(`${base}/viseme`, { method: 'POST', body: '' });
  assert.equal(empty.status, 400);
  const vid = await fetch(`${base}/video?engine=wav2lip`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  assert.equal(vid.status, 502); // not configured on this bridge
  assert.match(await vid.text(), /not available/);
});
