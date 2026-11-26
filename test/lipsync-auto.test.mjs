// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// #1244, the feature half: whatever writes narration audio for a deck with a
// 2D character has its lip-sync cut from that audio afterwards
// (tools/lipsync-auto.mjs), and the voice card is told which tracks' lip-sync
// is out of step (cli/edit.mjs tracksRoute).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lipsyncStatus, lipsyncAfterVoicing, makeLipsync, characterMode, RHUBARB_HINT } from '../tools/lipsync-auto.mjs';
import { synthesizeSlides, readTrack } from '../tools/narration-synth.mjs';
import { createTtsCache } from '../tools/tts-cache.mjs';
import { audioStamp } from '../tools/viseme-match.mjs';
import { visemesFor } from '../tools/video.mjs';
import { winShellSkip as winSkip, writeRhubarbStub, tmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A deck with notes per slide and, unless `mode` is null, a configured character. */
const deck = (notes, mode = 'viseme') => `<!doctype html><html><head>${mode
  ? `<script type="application/json" data-decklight-config>${JSON.stringify({ narration: { character: { mode } } })}</script>` : ''}
</head><body><div class="decklight">${notes
  .map((n, i) => `<section><h2>S${i + 1}</h2><aside class="notes">${n}</aside></section>`).join('')}</div></body></html>`;

/** A WAV whose bytes are the words: a re-voice is a different file. */
function wavOf(text) {
  const pcm = Buffer.from(text.padEnd(64, '.'));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const fakeTts = () => ({
  name: 'fake', model: 'm1', stylable: false,
  synth: Object.assign(async (text) => ({ wav: wavOf(text), usage: { cost: 0 } }), { mimeType: 'audio/wav' }),
});
const voice = (html, dir, range = null) => synthesizeSlides({
  html, dir, tts: fakeTts(), voice: 'v1', style: 'warm', format: 'wav', range, prev: readTrack(dir),
  cache: createTtsCache({ enabled: false }), log: () => {}, encoder: null,
});
const stamped = (dir, stem) => ({ v: 1, kind: 'visemes', duration: 1, source: 'test', cues: [{ t: 0, v: 'X' }],
  audio: audioStamp(fs.readFileSync(path.join(dir, `${stem}.wav`))) });
const write = (dir, stem, tl) => fs.writeFileSync(path.join(dir, `${stem}.visemes.json`), JSON.stringify(tl));
const read = (dir, stem) => JSON.parse(fs.readFileSync(path.join(dir, `${stem}.visemes.json`), 'utf8'));

test('characterMode reads the deck\'s configured character', () => {
  assert.equal(characterMode(deck(['a'])), 'viseme');
  assert.equal(characterMode(deck(['a'], 'video')), 'video');
  assert.equal(characterMode(deck(['a'], null)), null);
});

test('lipsyncStatus: a missing or foreign sidecar is stale, a stamped one is not, a filmed slide is not counted', (t) => {
  const dir = tmp('lipauto', t);
  for (const [stem, words] of [['slide-01', 'one'], ['slide-02', 'two'], ['slide-03', 'three'], ['slide-04', 'four']]) {
    fs.writeFileSync(path.join(dir, `${stem}.wav`), wavOf(words));
  }
  write(dir, 'slide-01', stamped(dir, 'slide-01'));
  // slide 2's sidecar is slide 1's: another recording
  write(dir, 'slide-02', stamped(dir, 'slide-01'));
  // slide 3 has none; slide 4 was filmed with your face, and plays the film
  fs.writeFileSync(path.join(dir, 'slide-04.mp4'), 'film');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ recorder: 'mic', slides: [{}, {}, {}, { face: true }] }));
  const { stems, stale } = lipsyncStatus(dir);
  assert.deepEqual(stems, ['slide-01', 'slide-02', 'slide-03']);
  assert.deepEqual(stale.map((s) => s.stem), ['slide-02', 'slide-03']);
  assert.match(stale[0].why, /another recording/);
  assert.match(stale[1].why, /missing/);
  // a fixed sidecar is seen at once (the memo is keyed on the files)
  write(dir, 'slide-02', stamped(dir, 'slide-02'));
  assert.deepEqual(lipsyncStatus(dir).stale.map((s) => s.stem), ['slide-03']);
});

test('after voicing: a 2D character gets its stale sidecars cut; without one nothing runs; without Rhubarb they are read from the voice, and it says so once', async (t) => {
  const dir = tmp('lipauto', t);
  const html = deck(['One says this.', 'Two says that.']);
  await voice(html, dir);
  const lines = [];
  const log = (l) => lines.push(l);

  // no character configured: nothing to cut, nothing said
  assert.deepEqual(await lipsyncAfterVoicing({ html: deck(['x'], null), dir, log, make: () => assert.fail('no character') }), { ran: false, made: 0, why: null });
  assert.deepEqual(lines, []);

  // no Rhubarb: the files are still made (read from the voice, by the same
  // tool), and the hint for Rhubarb's is said once; nothing is written here
  let fromVoice = null;
  const r = await lipsyncAfterVoicing({ html, dir, log, have: () => false, make: async (d, stems) => { fromVoice = stems; return { ok: true, made: stems.length }; } });
  assert.deepEqual(fromVoice, ['slide-01', 'slide-02']);
  assert.equal(r.ran, true);
  assert.equal(lines.filter((l) => l.includes(RHUBARB_HINT)).length, 1);
  assert.ok(lines.some((l) => /cutting 2 files for the 2D character in .*, read from the voice/.test(l)));
  assert.ok(fs.existsSync(path.join(dir, 'slide-01.wav')));

  // Rhubarb: every stem without lip-sync, in one run
  let asked = null;
  const made = await lipsyncAfterVoicing({
    html, dir, log, have: () => true,
    make: async (d, stems) => { asked = stems; for (const st of stems) write(d, st, stamped(d, st)); return { ok: true, made: stems.length }; },
  });
  assert.deepEqual(asked, ['slide-01', 'slide-02']);
  assert.equal(made.made, 2);
  assert.ok(lines.some((l) => /cutting 2 files for the 2D character/.test(l)));

  // re-voice ONE slide: its old sidecar went with its old audio, and only it is cut again
  const before = read(dir, 'slide-01');
  await voice(deck(['One says this.', 'Two says something new.']), dir, { from: 2, to: 2 });
  assert.equal(fs.existsSync(path.join(dir, 'slide-02.visemes.json')), false, 'new audio took its old sidecar away');
  asked = null;
  await lipsyncAfterVoicing({
    html, dir, log, have: () => true,
    make: async (d, stems) => { asked = stems; for (const st of stems) write(d, st, stamped(d, st)); return { ok: true, made: stems.length }; },
  });
  assert.deepEqual(asked, ['slide-02']);
  assert.deepEqual(read(dir, 'slide-01'), before, 'the slide that was not re-voiced keeps its lip-sync');
  assert.equal(read(dir, 'slide-02').audio, audioStamp(fs.readFileSync(path.join(dir, 'slide-02.wav'))));
});

test('makeLipsync passes the tool\'s per-file progress on and counts what it made', async () => {
  const lines = [];
  let argv = null;
  const spawnImpl = (bin, args) => {
    argv = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', 'voiceover: 2 slides with audio\n  cutting up to 2 files at once\n  [1/2] slide-02: 5 cues → slide-02.visemes.json · 1.0s\n');
      child.stdout.emit('data', '  [2/2] slide-01: 4 cues → slide-01.visemes.json · 1.2s\ndone → x (2 generated)\n');
      child.emit('close', 0);
    });
    return child;
  };
  const r = await makeLipsync('/deck/voiceover', ['slide-01', 'slide-02'], { log: (l) => lines.push(l), spawnImpl, jobs: 2 });
  assert.deepEqual(r, { ok: true, made: 2, why: null });
  assert.deepEqual(argv.slice(1), ['/deck/voiceover', '--visemes', '--remake', 'slide-01,slide-02', '--jobs', '2']);
  assert.deepEqual(lines, [
    '  lip-sync: cutting up to 2 files at once',
    '  lip-sync: [1/2] slide-02: 5 cues → slide-02.visemes.json · 1.0s',
    '  lip-sync: [2/2] slide-01: 4 cues → slide-01.visemes.json · 1.2s',
  ]);
  // nothing to do is not a run
  assert.deepEqual(await makeLipsync('/deck/voiceover', [], { spawnImpl: () => assert.fail('nothing to cut') }), { ok: true, made: 0, why: null });
});

test('re-recording one slide remakes its sidecar with Rhubarb, in parallel, and the export accepts the folder', { skip: winSkip }, async (t) => {
  const root = tmp('lipauto', t);
  const stub = writeRhubarbStub(root, path.join(here, 'fixtures', 'rhubarb-out.json'));
  // the Rhubarb `decklight setup face` saved, which lipsync.mjs reads
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config') };
  fs.mkdirSync(path.join(root, 'config', 'decklight'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'decklight', 'lipsync.json'), JSON.stringify({ rhubarb: stub }));
  const dir = path.join(root, 'voiceover');
  const html = deck(['One says this.', 'Two says that.', 'Three says the rest.']);
  const make = (d, stems, o) => makeLipsync(d, stems, { ...o, env, jobs: 3 });
  const lines = [];
  const log = (l) => lines.push(l);

  await voice(html, dir);
  await lipsyncAfterVoicing({ html, dir, log, have: () => true, make });
  assert.ok(lines.some((l) => /cutting up to 3 files at once/.test(l)), lines.join('\n'));
  assert.equal(lipsyncStatus(dir).stale.length, 0);
  const first = read(dir, 'slide-01');

  await voice(deck(['One says this.', 'Two says something new.', 'Three says the rest.']), dir, { from: 2, to: 2 });
  lines.length = 0;
  const r = await lipsyncAfterVoicing({ html, dir, log, have: () => true, make });
  assert.equal(r.made, 1);
  assert.equal(read(dir, 'slide-02').audio, audioStamp(fs.readFileSync(path.join(dir, 'slide-02.wav'))), 'remade from the new take');
  assert.deepEqual(read(dir, 'slide-01'), first);

  const m = await visemesFor(['slide-01', 'slide-02', 'slide-03'].map((st) => ({
    audio: path.join(dir, `${st}.wav`), file: path.join(dir, `${st}.visemes.json`), duration: null,
  })), { dir, deck: 'deck.html', log: () => {}, remakeWith: () => assert.fail('nothing to remake') });
  assert.equal(m.size, 3);
});
