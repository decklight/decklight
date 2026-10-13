// tools/lipsync.mjs (batch sidecar generator): output schema and the
// hash-incremental lipsync.json state, against a stub rhubarb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { winShellSkip as winSkip, writeRhubarbStub, rmTemp, tmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '../tools/lipsync.mjs');
test('batch visemes: generates sidecars, second run keeps them, edits invalidate', { skip: winSkip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-lipsync-batch-'));
  const stub = writeRhubarbStub(dir, path.join(here, 'fixtures', 'rhubarb-out.json'));

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
  // the log names the STEM, which is the filename — `slide-01-02` reads as
  // itself, where "slide 01-02" reads as a typo
  assert.match(third, /slide-01: visemes unchanged — kept/);
  assert.match(third, /1 generated, 1 unchanged/);

  rmTemp(dir);
});

test('a ⟨CLICK⟩ beat gets its own sidecar, cut to its own audio', { skip: winSkip }, () => {
  // The drift this closes: a beat-paced track plays ONE beat's audio at a time
  // (PRESENTING), so a timeline cut for the whole slide starts at zero against
  // every one of them — right for the first beat, progressively wronger after.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-lipsync-seg-'));
  const stub = writeRhubarbStub(dir, path.join(here, 'fixtures', 'rhubarb-out.json'));
  const vo = path.join(dir, 'voiceover');
  fs.mkdirSync(vo);
  const wav = (fill) => Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(512, fill)]);
  // slide 1 was recorded in two beats; slide 2 in one breath
  fs.writeFileSync(path.join(vo, 'slide-01.wav'), wav(1));
  fs.writeFileSync(path.join(vo, 'slide-01-01.wav'), wav(2));
  fs.writeFileSync(path.join(vo, 'slide-01-01.txt'), 'The first beat.');
  fs.writeFileSync(path.join(vo, 'slide-01-02.wav'), wav(3));
  fs.writeFileSync(path.join(vo, 'slide-01-02.txt'), 'And the second.');
  fs.writeFileSync(path.join(vo, 'slide-02.wav'), wav(4));

  const out = execFileSync('node', [TOOL, vo, '--rhubarb', stub], { encoding: 'utf8' });
  // counted apart, because "4 slides" would be a lie about a two-slide deck
  assert.match(out, /2 slides with audio · 2 \[click\] beats/);
  for (const f of ['slide-01.visemes.json', 'slide-01-01.visemes.json',
    'slide-01-02.visemes.json', 'slide-02.visemes.json']) {
    assert.ok(fs.existsSync(path.join(vo, f)), `missing ${f}`);
  }
  assert.ok(!fs.readdirSync(vo).some((f) => f.includes('.tmp.')), 'temp files cleaned up');

  // and a beat is incremental like everything else here
  const again = execFileSync('node', [TOOL, vo, '--rhubarb', stub], { encoding: 'utf8' });
  assert.match(again, /0 generated, 4 unchanged/);
  assert.match(again, /slide-01-02: visemes unchanged — kept/);

  rmTemp(dir);
});

// `decklight narrate <deck> --face`: the command in front of the batch tool.

const NARRATE = path.resolve(here, '../cli/decklight.mjs');
const wavOf = (fill) => Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(512, fill)]);
const deckWith = (config = '') => `<!doctype html><html><body><div class="decklight">
<section><h2>One</h2></section><section><h2>Two</h2></section></div>
<script>Decklight.init(${config || '{}'});</script></body></html>`;

test('narrate --face cuts sidecars into every folder the deck names', { skip: winSkip }, (t) => {
  const dir = tmp('narrate-face', t);
  const stub = writeRhubarbStub(dir, path.join(here, 'fixtures', 'rhubarb-out.json'));
  const deck = path.join(dir, 'talk.html');
  fs.writeFileSync(deck, deckWith(`{ narration: { files: [{ dir: 'en' }, { dir: 'fr' }] } }`));
  for (const d of ['en', 'fr']) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'slide-01.wav'), wavOf(d === 'en' ? 1 : 2));
  }
  // an empty home: nothing `setup face` saved leaks in from the machine
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config') };
  const out = execFileSync(process.execPath, [NARRATE, 'narrate', deck, '--face', '--rhubarb', stub], { encoding: 'utf8', env });
  assert.match(out, /en: 1 slides with audio/);
  assert.match(out, /fr: 1 slides with audio/);
  for (const d of ['en', 'fr']) assert.ok(fs.existsSync(path.join(dir, d, 'slide-01.visemes.json')), `${d} has no sidecar`);
  // nothing was voiced: the audio is the audio it was
  assert.deepEqual(fs.readFileSync(path.join(dir, 'en', 'slide-01.wav')), wavOf(1));
});

test('narrate --face uses the rhubarb `setup face` saved', { skip: winSkip }, (t) => {
  const dir = tmp('narrate-face-saved', t);
  const stub = writeRhubarbStub(dir, path.join(here, 'fixtures', 'rhubarb-out.json'));
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(config, 'decklight'), { recursive: true });
  fs.writeFileSync(path.join(config, 'decklight', 'lipsync.json'), JSON.stringify({ rhubarb: stub }));
  const deck = path.join(dir, 'talk.html');
  fs.writeFileSync(deck, deckWith());
  fs.mkdirSync(path.join(dir, 'voiceover'));
  fs.writeFileSync(path.join(dir, 'voiceover', 'slide-02.wav'), wavOf(3));
  const env = { ...process.env, XDG_CONFIG_HOME: config, PATH: '/usr/bin:/bin' };
  const out = execFileSync(process.execPath, [NARRATE, 'narrate', deck, '--face'], { encoding: 'utf8', env });
  assert.match(out, /1 generated/);
  assert.ok(fs.existsSync(path.join(dir, 'voiceover', 'slide-02.visemes.json')));
});

test('narrate --face refuses what it cannot do, before any work', (t) => {
  const dir = tmp('narrate-face-no', t);
  const deck = path.join(dir, 'talk.html');
  fs.writeFileSync(deck, deckWith());
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config') };
  const fail = (...args) => {
    try { execFileSync(process.execPath, [NARRATE, 'narrate', deck, '--face', ...args], { encoding: 'utf8', env, stdio: 'pipe' }); }
    catch (e) { return { code: e.status, err: String(e.stderr) }; }
    assert.fail('expected a refusal');
  };
  // no narration yet: it says how to make some, and voices nothing itself
  const none = fail();
  assert.equal(none.code, 1);
  assert.match(none.err, /voice it first: decklight narrate/);
  assert.ok(!fs.existsSync(path.join(dir, 'voiceover')));
  // the batch is incremental by audio, so a range is refused rather than ignored
  assert.equal(fail('--slides', '1').code, 2);
  // a microphone take is made first, then given a face
  assert.equal(fail('--mic').code, 2);
});
