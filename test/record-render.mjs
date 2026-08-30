// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// ⇧R end to end: a real browser, a real audio graph, a real server, real files.
//
// WHY THIS HARNESS IS SHAPED DIFFERENTLY FROM THE OTHERS. Every other render
// harness here dumps the DOM under `--virtual-time-budget`, which fast-forwards
// Chrome's clock so a one-second animation costs a millisecond. That is exactly
// what recording cannot survive: an AudioContext runs on the REAL clock, so
// under virtual time the page's timers race to the end while nothing has been
// captured — and an open MediaStream keeps the virtual clock from draining at
// all, so `--dump-dom` sits there until the wall clock kills it. (Measured, not
// assumed: a 120s hang, every time.)
//
// So this one runs Chrome on the real clock with no dump, and the PAGE reports
// back over HTTP when it is finished — the same shape the feature itself has, a
// deck talking to the server that owns its file.
//
// AND WHY THE MICROPHONE IS AN OSCILLATOR. `--use-fake-device-for-media-stream`
// is the obvious answer and it does not work: on macOS the capture subsystem is
// gated by the OS, headless has nobody to grant it, and getUserMedia never
// settles — not a rejection, a hang. So the page hands `getUserMedia` a stream
// from `createMediaStreamDestination()` with an oscillator on it. That is a
// REAL MediaStream carrying REAL audio: `createMediaStreamSource`, the
// ScriptProcessor, `floatToPcm16`, `stitchWav`, `/edit/record` and the files on
// disk are all the shipping code path, and the only thing substituted is the
// one thing a headless machine has no honest version of — a person and a
// microphone. The refusal path gets its own run, where getUserMedia rejects.

import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const EDIT = path.join(root, 'cli', 'edit.mjs');

/** How long one run may take before it is called stuck. */
const WALL_MS = Number(process.env.RECORD_WALL_MS ?? 90_000);
/** How long the page holds each beat, in real milliseconds of real audio. */
const BEAT_MS = 250;

// Two slides that speak and one that does not, which is where every interesting
// case lives:
//   1 — three ⟨CLICK⟩ beats over two builds: three segment files AND a
//       whole-slide file, and the deck must step its builds as they are read
//   2 — notes with no ⟨CLICK⟩: one take, one file, no segments
//   3 — no notes: nothing was ever said, and nothing must be written
const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Record harness</title>
<link rel="stylesheet" href="decklight.css"></head><body>
<div class="decklight">
  <section><h1>One</h1><ul data-build><li>First</li><li>Second</li></ul>
    <aside class="notes">Beat one. ⟨CLICK⟩ Beat two. ⟨CLICK⟩ Beat three.</aside></section>
  <section><h2>Two</h2><aside class="notes">Slide two, all in one breath.</aside></section>
  <section><h2>Three</h2></section>
</div>
<script>
  // ── the microphone ──────────────────────────────────────────────────────
  // Installed BEFORE the runtime, because the runtime reads
  // navigator.mediaDevices to decide whether recording is possible at all.
  const params = new URLSearchParams(location.search);
  const mode = params.get('mic') ?? 'tone';
  if (mode === 'blocked') {
    // exactly what a browser throws when the user (or a policy) says no
    navigator.mediaDevices.getUserMedia = () => Promise.reject(
      Object.assign(new DOMException('Permission denied', 'NotAllowedError')));
  } else if (mode !== 'real') {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      // DOES THE AUDIO GRAPH ACTUALLY RUN HERE? ctx.state says "running" on a
      // machine with no output device driving the render quantum, and then
      // renders nothing: currentTime crawls, no ScriptProcessor callback ever
      // fires, and every WAV comes out as a 44-byte header. That is a fact
      // about the host, not about the recorder, so it is measured and reported
      // rather than left to look like a failure.
      // (No backticks in here: this lives inside the deck's template literal.)
      const t0 = ctx.currentTime;
      await new Promise((ok) => setTimeout(ok, 250));
      window.__audioRan = ctx.currentTime - t0 > 0.05;
      const dest = ctx.createMediaStreamDestination();
      // A tone, not noise: "did it capture audio" then has a deterministic
      // answer instead of one that depends on what the room sounds like.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      osc.connect(gain); gain.connect(dest);
      osc.start();
      window.__micCtx = ctx;   // kept alive: a collected context stops the tone
      return dest.stream;
    };
  }
  try {
    localStorage.setItem('decklight-onboarded', '1');
    localStorage.setItem('decklight-tips-off', '1');
  } catch (e) { /* private mode */ }
</script>
<script src="decklight.js"></script>
<script>
  const deck = Decklight.init({});
  const RESULTS = params.get('results');
  const r = { mode, beats: [], steps: [] };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const card = () => document.querySelector('.decklight-mic .narr-card');
  const reading = () => document.querySelector('.decklight-mic .rec-read')?.textContent ?? null;
  const done = () => /recording done|recording stopped/.test(card()?.textContent ?? '');
  const press = (key) => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  async function until(fn, ms = 15000) {
    const stop = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > stop) return null;
      await wait(30);
    }
  }
  (async () => {
    try {
      // ?record opened it — no keystroke, which is the command's whole promise
      r.autoOpened = !!(await until(() => card()));
      // the beat count is read off the notes before a single sample is captured
      r.introLine = card()?.querySelector('.rec-line')?.textContent ?? '';
      press('Enter');
      if (mode === 'blocked') {
        // a refusal must SAY so and change nothing — no take, no file, and the
        // card still offering to try again
        await wait(1200);
        r.card = card()?.textContent ?? '';
        r.stillOnTheCard = !!card();
        r.recordedNothing = reading() === null;
      } else {
        // Read every beat the deck puts up, holding each one long enough that
        // there is real audio in it, and answer it the way a presenter does.
        for (let i = 0; i < 12; i++) {
          const text = await until(() => reading());
          if (text === null) break;
          r.beats.push(text);
          // the build the beat is filmed at — the claim that → both ends a file
          // AND reveals the next build has to be visible from outside
          r.steps.push(deck.state.slide + '.' + deck.state.step);
          await wait(${BEAT_MS});
          press('ArrowRight');
          const moved = await until(() => reading() !== text || done(), 15000);
          if (!moved || done()) break;
        }
        await until(() => done());
        r.card = card()?.textContent ?? '';
        r.finished = done();
      }
      r.audioRan = window.__audioRan !== false;
    } catch (e) { r.exception = String(e && (e.stack || e.message || e)); }
    // The page is the only thing that knows it is finished; nothing is dumped,
    // so this is how the harness finds out.
    try {
      await fetch(RESULTS, { method: 'POST', body: JSON.stringify(r) });
    } catch (e) { /* the harness already gave up */ }
  })();
</script></body></html>
`;

let bad = 0;
let skipped = 0;
function check(label, ok, detail) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(9)} ${detail}`);
}
/**
 * A check this machine cannot answer.
 *
 * Reported as its own state — never silently passed, never failed. The one
 * check here that needs the host to have a working audio output device is the
 * one that reads the captured bytes, and a machine without one is not a
 * regression in the recorder. Counted in the summary so a run that skipped it
 * cannot read as a run that made the check.
 */
function skip(label, why) {
  skipped++;
  console.log(`skip ${label.padEnd(9)} ${why}`);
}
function fail(msg) {
  console.error(`FAIL record-render — ${msg}`);
  console.error('record-render: FAILED');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'dl-recrender-'));
const kill = new Set();
process.on('exit', () => {
  for (const c of kill) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows holds handles */ }
});

// ── the deck, the runtime beside it, and the real author server ────────────
if (!existsSync(path.join(root, 'dist', 'decklight.js'))) fail('dist/decklight.js is missing — run npm run build');
writeFileSync(path.join(tmp, 'deck.html'), DECK);
for (const f of ['decklight.js', 'decklight.css']) copyFileSync(path.join(root, 'dist', f), path.join(tmp, f));

const server = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], {
  cwd: tmp,
  stdio: ['ignore', 'pipe', 'pipe'],
  // PATH narrowed to the temp dir: no git, no agents, no surprises
  env: { ...process.env, PATH: tmp },
});
kill.add(server);
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });

const deckBase = await new Promise((resolve, reject) => {
  const scan = setInterval(() => {
    const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
  }, 25);
  server.on('exit', () => { clearInterval(scan); reject(new Error(`the author server exited early:\n${log}`)); });
  setTimeout(() => { clearInterval(scan); reject(new Error(`no author server after 20s:\n${log}`)); }, 20_000);
}).catch((e) => fail(e.message));

// ── the channel the page reports through ───────────────────────────────────
let report = null;
const results = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { report = JSON.parse(body); } catch { report = { exception: `unparseable report: ${body.slice(0, 200)}` }; }
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('ok');
  });
});
await new Promise((r) => results.listen(0, '127.0.0.1', r));
const resultsUrl = `http://127.0.0.1:${results.address().port}/`;

/** One run of the deck in a fresh browser: returns what the page reported. */
async function run(mic, dir) {
  report = null;
  const profile = path.join(tmp, `profile-${mic}`);
  mkdirSync(profile, { recursive: true });
  const url = `${deckBase}/deck.html?record&mic=${mic}&dir=${dir}`
    + `&results=${encodeURIComponent(resultsUrl)}`;
  // --autoplay-policy: the deck's own audio elements are not what is under
  // test, and a blocked one would toast over the recorder. A throwaway
  // --user-data-dir keeps one run's localStorage out of the next.
  const chrome = spawn(chromeBin('record-render'), chromeArgs(
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, url,
  ), { stdio: ['ignore', 'ignore', 'ignore'] });
  kill.add(chrome);
  const t0 = Date.now();
  while (!report && Date.now() - t0 < WALL_MS) {
    await new Promise((r) => { setTimeout(r, 100); });
  }
  try { chrome.kill('SIGTERM'); } catch { /* gone */ }
  kill.delete(chrome);
  if (!report) fail(`mic=${mic}: the page never reported within ${WALL_MS / 1000}s`);
  if (report.exception) fail(`mic=${mic}: the page threw — ${report.exception.split('\n')[0]}`);
  return report;
}

// ── run 1: a take, start to finish ─────────────────────────────────────────
const t0 = Date.now();
const took = await run('tone', 'takes');
const outDir = path.join(tmp, 'takes');
const files = existsSync(outDir) ? readdirSync(outDir).sort() : [];
const sizes = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(outDir, f)).length]));

check('record', took.autoOpened === true && /2 slides · 4 beats/.test(took.introLine ?? ''),
  `?record opened it=${took.autoOpened} · counted the beats off the notes: "${took.introLine}"`);

// Per SEGMENT, not per step — and the whole-slide file beside them, because
// every reader that predates segments only knows the short name.
check('files', JSON.stringify(files) === JSON.stringify([
  'slide-01-01.wav', 'slide-01-02.wav', 'slide-01-03.wav', 'slide-01.wav', 'slide-02.wav',
]), `--dir takes → ${files.join(' ') || '(nothing)'}`);
// slide 2 has one beat, so it is not a segmented slide — the same threshold
// tools/voiceover.mjs gives up at. Slide 3 never spoke.
check('quiet', !files.includes('slide-02-01.wav') && !files.some((f) => f.startsWith('slide-03')),
  `one-beat slide got no segments=${!files.includes('slide-02-01.wav')}`
  + ` · a slide with no notes wrote nothing=${!files.some((f) => f.startsWith('slide-03'))}`);

// Real WAVs with real audio in them: a 44-byte header proves only that the
// plumbing ran. 24 kHz mono 16-bit is 48 bytes a millisecond, and every beat
// was held for BEAT_MS.
const riff = files.every((f) => {
  const b = readFileSync(path.join(outDir, f));
  return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE';
});
const audible = files.length > 0 && files.every((f) => sizes[f] > 44 + 2000);
const segBytes = ['slide-01-01.wav', 'slide-01-02.wav', 'slide-01-03.wav']
  .reduce((n, f) => n + ((sizes[f] ?? 0) - 44), 0);
// the whole-slide file IS its beats, back to back — no synthetic gap, because a
// human take already contains every pause the person took
const sums = files.length > 0 && Math.abs((sizes['slide-01.wav'] - 44) - segBytes) <= 4;
// The header is structure and is checked on any machine; the CONTENT needs an
// audio device that renders. Splitting them is what keeps the useful half of
// this check alive on a laptop with no output device plugged in.
check('wav', riff, `every file is a real RIFF/WAVE (${files.length} of them)`);
if (took.audioRan === false) {
  skip('audio', 'this machine\'s audio graph does not render — AudioContext says "running" while'
    + ' currentTime stands still, so nothing was captured to measure. The recorder is untested here,'
    + ' not broken: plug in an output device, or read this check on CI.');
} else {
  // `sums` is under the same gate on purpose: 44-byte files sum to 44 bytes and
  // would pass this trivially, which is a false pass rather than a check.
  check('audio', audible && sums,
    `not silence=${audible} · whole slide = its beats back to back=${sums}`
    + ` (${Object.entries(sizes).map(([f, n]) => `${f.replace('slide-0', '')}:${n}`).join(' ')})`);
}

// The claim, in one line: → ended a file AND revealed the next build. Beat k of
// slide 1 is read at build step k; slide 2 has no builds and starts at 0.
check('pacing', JSON.stringify(took.beats) === JSON.stringify([
  'Beat one.', 'Beat two.', 'Beat three.', 'Slide two, all in one breath.',
]) && JSON.stringify(took.steps) === JSON.stringify(['1.0', '1.1', '1.2', '2.0']),
`read ${took.beats.length} beats at builds ${took.steps.join(' ')}`);

// Where a presenter learns what they just made and how to play it back — the
// flag included, because without it the files are there and nothing uses them.
check('done', took.finished === true && /takes\//.test(took.card ?? '')
  && /segments: true/.test(took.card ?? '') && /ext: 'wav'/.test(took.card ?? ''),
`names the folder=${/takes\//.test(took.card ?? '')} · prints segments: true=${/segments: true/.test(took.card ?? '')}`);

// ── run 2: the browser says no ─────────────────────────────────────────────
const blocked = await run('blocked', 'denied');
check('refusal', /microphone was blocked/.test(blocked.card ?? '')
  // …and says HOW to try again. It used to name ⇧R; recording lives in the
  // narration panel now, so the refusal has to name the route that exists —
  // a card that tells you to press a freed key is worse than one that says
  // nothing, because it reads as a bug in the microphone.
  && /Record this deck/.test(blocked.card ?? '')
  && blocked.recordedNothing === true && !existsSync(path.join(tmp, 'denied')),
`explains and offers a retry=${/microphone was blocked/.test(blocked.card ?? '')}`
  + ` · wrote nothing=${!existsSync(path.join(tmp, 'denied'))}`);

if (bad) fail(`${bad} check${bad === 1 ? '' : 's'} failed`);
console.log(`record-render: PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  + (skipped ? ` — ${skipped} check${skipped === 1 ? '' : 's'} SKIPPED, see above` : ''));
process.exit(0);
