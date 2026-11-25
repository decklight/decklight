// #1244: a viseme sidecar is checked against the audio it plays beside — in
// the export (tools/video.mjs visemesFor), in the batch tool (tools/lipsync.mjs)
// and, by length, in the runtime (tools/viseme-fit.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioStamp, visemeHash, visemeMismatch, wavDuration } from '../tools/viseme-match.mjs';
import { timelineFits } from '../tools/viseme-fit.mjs';
import { visemesFor } from '../tools/video.mjs';
import { winShellSkip as winSkip, writeRhubarbStub, tmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIPSYNC = path.resolve(here, '../tools/lipsync.mjs');

/** A 16-bit mono WAV of `secs`, every sample `fill` so two takes differ. */
const wav = (secs, fill = 0, rate = 8000) => {
  const data = Buffer.alloc(Math.round(secs * rate) * 2, fill);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
const timeline = (duration, extra = {}) => ({ v: 1, kind: 'visemes', duration, source: 'rhubarb', cues: [{ t: 0, v: 'B' }, { t: duration - 0.1, v: 'X' }], ...extra });

test('wavDuration reads a PCM header, and says nothing about what is not one', () => {
  assert.equal(wavDuration(wav(2.5)), 2.5);
  assert.equal(wavDuration(Buffer.from('RIFF....WAVEfmt ')), null);
  assert.equal(wavDuration(Buffer.from('not audio at all')), null);
});

test('visemeMismatch: the stamp settles it, then lipsync.json, then the length', () => {
  const take1 = wav(6, 1), take2 = wav(6, 2);
  // stamped: this audio's, whatever the length says; another's, whatever it says
  assert.equal(visemeMismatch(timeline(2, { audio: audioStamp(take1) }), { audioBytes: take1, duration: 6 }), null);
  assert.match(visemeMismatch(timeline(6, { audio: audioStamp(take1) }), { audioBytes: take2, duration: 6 }), /another recording/);
  // unstamped, made by lipsync.mjs: its hash of text + audio
  assert.equal(visemeMismatch(timeline(6), { audioBytes: take1, text: 'hi', stateHash: visemeHash('hi', take1), duration: 6 }), null);
  assert.match(visemeMismatch(timeline(6), { audioBytes: take2, text: 'hi', stateHash: visemeHash('hi', take1), duration: 6 }), /changed/);
  // nothing else to go on: the length — the issue's 33.4 s audio, 20.27 s timeline
  assert.match(visemeMismatch(timeline(20.27), { audioBytes: take1, duration: 33.4 }), /20\.3s and its audio 33\.4s/);
  assert.equal(visemeMismatch(timeline(33.2), { audioBytes: take1, duration: 33.4 }), null, 'rounding is not another take');
  assert.equal(visemeMismatch(timeline(3), {}), null, 'nothing known, nothing claimed');
  // the runtime's half of it
  assert.equal(timelineFits(timeline(2.5), 6), false);
  assert.equal(timelineFits(timeline(6), 6.4), true);
  assert.equal(timelineFits(timeline(2.5), NaN), true, 'length not known yet: not judged');
});

test('the export does not play a foreign sidecar: it remakes it, or stops and names the command', async (t) => {
  const dir = tmp('viseme', t);
  const audio = path.join(dir, 'slide-01.wav');
  const file = path.join(dir, 'slide-01.visemes.json');
  fs.writeFileSync(audio, wav(6, 1));
  // the leftover of an older, shorter take (the repro's 2.5 s against 6 s)
  fs.writeFileSync(file, JSON.stringify(timeline(2.5)));
  const items = [{ audio, file, duration: 6 }];
  const lines = [];
  const log = (l) => lines.push(l);

  // no Rhubarb here: the export stops — never renders the wrong mouth silently
  await assert.rejects(visemesFor(items, { dir, deck: 'deck.html', log, remakeWith: () => 'rhubarb not found' }),
    /lip-sync does not match its audio in slide-01\.visemes\.json and could not be remade here: rhubarb not found — run decklight narrate deck\.html --face/);
  assert.ok(lines.some((l) => /slide-01\.visemes\.json does not match its audio — it lasts 2\.5s and its audio 6\.0s/.test(l)));
  const skipped = await visemesFor(items, {
    dir, deck: 'deck.html', log, skipBad: true,
    remakeWith: () => assert.fail('exporting as-is must not remake lip-sync'),
  });
  assert.equal(skipped.has(file), false);

  // Rhubarb here: just that stem is remade, and the log says how many
  lines.length = 0;
  let asked = null;
  const remade = await visemesFor(items, {
    dir, deck: 'deck.html', log,
    remakeWith: (d, stems) => { asked = stems; fs.writeFileSync(file, JSON.stringify(timeline(6, { audio: audioStamp(fs.readFileSync(audio)) }))); return null; },
  });
  assert.deepEqual(asked, ['slide-01']);
  assert.equal(remade.get(file).duration, 6);
  assert.ok(lines.some((l) => /remade 1 file to match its audio/.test(l)));

  // and once it matches, nothing is remade
  const again = await visemesFor(items, { dir, deck: 'deck.html', log, remakeWith: () => assert.fail('nothing to remake') });
  assert.equal(again.get(file).duration, 6);

  // a missing sidecar is remade the same way, instead of failing outright (#1220)
  fs.rmSync(file);
  await assert.rejects(visemesFor(items, { dir, deck: 'deck.html', log, remakeWith: () => 'no rhubarb' }), /narrate deck\.html --face/);
});

test('lipsync: a re-recorded beat gets a new sidecar, and one copied in over a current hash is not kept', { skip: winSkip }, (t) => {
  const dir = tmp('viseme', t);
  const stub = writeRhubarbStub(dir, path.join(here, 'fixtures', 'rhubarb-out.json'));   // 2.72 s
  const vo = path.join(dir, 'voiceover');
  fs.mkdirSync(vo);
  fs.writeFileSync(path.join(vo, 'slide-01-01.wav'), wav(2.72, 1));
  fs.writeFileSync(path.join(vo, 'slide-01-02.wav'), wav(2.72, 3));
  const run = (...extra) => execFileSync('node', [LIPSYNC, vo, '--rhubarb', stub, ...extra], { encoding: 'utf8' });
  const read = (stem) => JSON.parse(fs.readFileSync(path.join(vo, `${stem}.visemes.json`), 'utf8'));

  run();
  assert.equal(read('slide-01-01').audio, audioStamp(fs.readFileSync(path.join(vo, 'slide-01-01.wav'))), 'stamped');

  // re-record ONE beat: its sidecar is remade, stamped with the new take
  fs.writeFileSync(path.join(vo, 'slide-01-01.wav'), wav(2.72, 2));
  assert.match(run(), /1 generated, 1 unchanged/);
  assert.equal(read('slide-01-01').audio, audioStamp(fs.readFileSync(path.join(vo, 'slide-01-01.wav'))));

  // a foreign sidecar copied over a current one: lipsync.json still says
  // "made", but the file is not this audio's — made again, not kept
  fs.copyFileSync(path.join(vo, 'slide-01-02.visemes.json'), path.join(vo, 'slide-01-01.visemes.json'));
  assert.match(run(), /1 generated, 1 unchanged/);
  assert.equal(read('slide-01-01').audio, audioStamp(fs.readFileSync(path.join(vo, 'slide-01-01.wav'))));

  // --remake: only the named stems, whatever the state says
  const out = run('--remake', 'slide-01-02');
  assert.match(out, /1 generated/);
  assert.doesNotMatch(out, /slide-01-01/);

  // and the export takes the folder as it now stands
  return visemesFor(['slide-01-01', 'slide-01-02'].map((st) => ({
    audio: path.join(vo, `${st}.wav`), file: path.join(vo, `${st}.visemes.json`), duration: 2.72,
  })), { dir: vo, deck: 'deck.html', log: () => {}, remakeWith: () => assert.fail('nothing to remake') })
    .then((m) => assert.equal(m.size, 2));
});
