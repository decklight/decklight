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
// ScriptProcessor, `floatToPcm16`, `stitchWav`, `/deck/edit/narration/record` and the files on
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
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__gum = constraints;   // what the recorder asked the microphone for
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
    localStorage.setItem('decklight-onboarded-tour', '1');   // nor the editing tour: it takes the first key
  } catch (e) { /* private mode */ }
</script>
<script src="decklight.js"></script>
<script>
  // ?cfg: a deck that names a narration folder of its own, as one voiced by an
  // engine does. Your voice must not land in it.
  const deck = Decklight.init(params.has('cfg') ? { narration: { files: params.get('cfg') || 'voiceover', ext: 'wav', segments: true } } : {});
  const RESULTS = params.get('results');
  const r = { mode, beats: [], steps: [] };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const card = () => document.querySelector('.decklight-mic .narr-card');
  const reading = () => document.querySelector('.decklight-mic .rec-read')?.textContent ?? null;
  const done = () => /recording done|recording stopped/.test(card()?.textContent ?? '');
  // the indicator: 'countdown' during the 3-2-1, 'rec' once the take runs.
  // A new element per beat, which is how a re-render (a retake, a ←) is seen.
  const status = () => document.querySelector('.decklight-mic .rec-status');
  const phase = () => status()?.dataset.phase ?? null;
  // ?keys=R,L,…: what to answer each beat the deck puts up (R → or the
  // phone's next, L ←); past the end of the list, R
  const KEYS = (params.get('keys') || '').split(',').filter(Boolean);
  const press = (key) => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  // ?via=phone: every beat is ended by the phone remote instead (#848), the
  // same POST its next and retake buttons make, relayed back over the deck's
  // own stream. Loopback, so no token: the relay is not what is under test.
  const VIA = params.get('via') ?? 'keys';
  const tap = (key) => fetch('/deck/remote/key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
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
      // ?vpanel: no recording — open V and read what it says about the track
      if (params.has('vpanel')) {
        await wait(1500);   // the probe, then the track list the panel asks for
        press('v');
        const warn = await until(() => document.querySelector('.decklight-narr .narr-warn'), 6000);
        r.vWarn = warn?.textContent ?? null;
        r.vRows = [...document.querySelectorAll('.decklight-narr .narr-row')].map((n) => n.textContent).join(' | ');
        throw 'introonly';
      }
      // ?record opened it — no keystroke, which is the command's whole promise
      r.autoOpened = !!(await until(() => card()));
      // the beat count is read off the notes before a single sample is captured
      r.introLine = card()?.querySelector('.rec-line')?.textContent ?? '';
      // ?pick: choose noise suppression off and 48 kHz on the card, by click,
      // once the deferred render has settled (it re-renders with the folder)
      if (params.has('pick')) {
        await until(() => card()?.querySelector('.rec-folder'), 5000);
        card().querySelector('[data-noise="off"]').click();
        card().querySelector('[data-rate="48000"]').click();
        card().querySelector('[data-count="1"]').click();   // the count-in, by click
      }
      r.countSays = card()?.querySelector('.rec-count-says')?.textContent ?? null;
      // ?from=N: step the start point N beats on with → before Enter
      for (let k = 0; k < Number(params.get('from') ?? 0); k++) { press('ArrowRight'); await wait(50); }
      r.fromLine = card()?.querySelector('.rec-from')?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
      r.folder = (await until(() => card()?.querySelector('.rec-dir'), 5000))?.value ?? null;
      r.clash = !!card()?.querySelector('.rec-warn');
      r.warnText = [...(card()?.querySelectorAll('.rec-warn') ?? [])].map((w) => w.textContent).join(' | ');
      r.canStart = !!card()?.querySelector('.narr-row');
      if (params.has('introonly')) throw 'introonly';
      r.introOpts = [...(card()?.querySelectorAll('.rec-seg button.on') ?? [])].map((b) => b.textContent);
      r.introWhy = card()?.querySelector('.rec-opt-why')?.textContent ?? '';
      // with --remote on, the card carries the QR (the speaker view is not open)
      r.introQr = !!(await until(() => card()?.querySelector('.rec-phone img'), 5000));
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
        r.counted = [];
        for (let i = 0; i < 16; i++) {
          const text = await until(() => reading());
          if (text === null) break;
          r.beats.push(text);
          // the build the beat is filmed at — the claim that → both ends a file
          // AND reveals the next build has to be visible from outside
          r.steps.push(deck.state.slide + '.' + deck.state.step);
          // every take is counted in, from the count-in asked for, and nothing
          // is captured while it counts: the first number seen, or null for none
          r.counted.push(phase() === 'countdown' ? ((status()?.textContent ?? '').match(/\\d/)?.[0] ?? '?') : null);
          if (i === 0 && params.has('early')) {
            // → during the 3-2-1 waits for the take, it does not skip the beat
            press('ArrowRight');
            await wait(200);
            r.earlyIgnored = phase() === 'countdown' && reading() === text;
          }
          if (!(await until(() => phase() === 'rec', 6000))) { r.noTake = text; break; }
          await wait(${BEAT_MS});
          if (VIA === 'phone' && i === 0) {
            // retake from the phone: the same beat comes back, at the same
            // build, counted in again
            const el = status();
            await tap('retake');
            await until(() => status() !== el, 5000);
            r.retook = reading() === text && (deck.state.slide + '.' + deck.state.step) === r.steps[0]
              && phase() === 'countdown';
            if (!(await until(() => phase() === 'rec', 6000))) { r.noTake = text; break; }
            await wait(${BEAT_MS});
          }
          const el = status();
          if ((KEYS[i + 1] ?? 'R') === 'E' && params.has('escnext')) {
            // stop on the NEXT beat's count-in, once this one is saved
            if (VIA === 'phone') await tap('next'); else press('ArrowRight');
            await until(() => status() !== el, 15000);
            await wait(300);
            press('Escape');
            r.escaped = true;
            break;
          }
          if ((KEYS[i] ?? 'R') === 'L') press('ArrowLeft');
          else if (VIA === 'phone') await tap('next');
          else press('ArrowRight');
          const moved = await until(() => status() !== el || done(), 15000);
          if (!moved || done()) break;
        }
        if (!r.escaped) await until(() => done());
        r.card = card()?.textContent ?? '';
        r.finished = done();
      }
      r.audioRan = window.__audioRan !== false;
      r.gum = window.__gum?.audio ?? null;
    } catch (e) { if (e !== 'introonly') r.exception = String(e && (e.stack || e.message || e)); }
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

// ── the deck, the runtime beside it, and the real edit server ────────────
if (!existsSync(path.join(root, 'dist', 'decklight.js'))) fail('dist/decklight.js is missing — run npm run build');
writeFileSync(path.join(tmp, 'deck.html'), DECK);
for (const f of ['decklight.js', 'decklight.css']) copyFileSync(path.join(root, 'dist', f), path.join(tmp, f));

// --remote: the QR on the recorder's card is only offered when the remote is
// on. The phone's taps go over loopback, which answers either way.
const server = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git', '--remote', '--host', '127.0.0.1'], {
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
  server.on('exit', () => { clearInterval(scan); reject(new Error(`the edit server exited early:\n${log}`)); });
  setTimeout(() => { clearInterval(scan); reject(new Error(`no edit server after 20s:\n${log}`)); }, 20_000);
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

let runs = 0;
/** One run of the deck in a fresh browser: returns what the page reported. */
async function run(mic, dir, via = 'keys', extra = '') {
  report = null;
  const profile = path.join(tmp, `profile-${++runs}`);
  mkdirSync(profile, { recursive: true });
  const url = `${deckBase}/deck.html?${extra.includes('vpanel') ? '' : 'record&'}mic=${mic}${dir ? `&dir=${dir}` : ''}&via=${via}${extra}`
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
// the audio; the manifest and the slide-NN.txt scripts beside it are #850's, checked below
const wavs = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.wav')).sort() : []);
const files = wavs(outDir);
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

// ── run 3: the phone ends every beat, and retakes one (#848) ────────────────
// The phone's view of the take, from the relay's own readout stream: what a
// phone subscribed to /deck/remote/events would have shown.
const phoneSaw = [];
const phoneStream = await fetch(`${deckBase}/deck/remote/events`);
const phoneReader = phoneStream.body.getReader();
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done: end } = await phoneReader.read().catch(() => ({ done: true }));
    if (end) return;
    buf += dec.decode(value, { stream: true });
    for (let k; (k = buf.indexOf('\n\n')) !== -1;) {
      const ev = buf.slice(0, k); buf = buf.slice(k + 2);
      const data = /^event: pos\ndata: (.*)$/m.exec(ev)?.[1];
      if (data) { try { phoneSaw.push(JSON.parse(data)); } catch { /* malformed */ } }
    }
  }
})();
// a one-second count-in, asked for in the URL as narrate --countdown 1 does
const tapped = await run('tone', 'phone', 'phone', '&countdown=1');
phoneReader.cancel().catch(() => {});
const phoneFiles = wavs(path.join(tmp, 'phone'));
check('qr', took.introQr === true, `--remote puts the phone's QR on the recorder's intro card=${took.introQr}`);
// The phone's next ENDS the beat; the recorder reveals the next build. Had the
// deck also stepped, beat two would be read at 1.2 and the third at slide 2.
check('phone', JSON.stringify(tapped.steps) === JSON.stringify(['1.0', '1.1', '1.2', '2.0'])
  && tapped.finished === true && JSON.stringify(phoneFiles) === JSON.stringify(files),
`phone next read ${tapped.beats.length} beats at builds ${tapped.steps.join(' ')} · wrote ${phoneFiles.join(' ') || '(nothing)'}`);
check('retake', tapped.retook === true && tapped.beats[0] === 'Beat one.' && tapped.counted.every((c) => c === '1'),
  `phone retake kept the same beat at the same build=${tapped.retook}`);
const recs = phoneSaw.map((p) => p.rec).filter(Boolean);
check('readout', recs.some((r) => r.slide === 1 && r.beat === 2 && r.of === 3)
  && recs.some((r) => r.slide === 2 && r.beat === 1 && r.of === 1) && phoneSaw.at(-1)?.rec === null,
`the phone saw ${recs.length} beat reports, ending on not-recording=${phoneSaw.at(-1)?.rec === null}`);

// ── run 4: ← goes back, the 3-2-1 holds, and the microphone choices stick ──
// ← on beat two goes back to beat one; ← on slide 2's first beat goes back to
// slide 1, which is recorded again over its own files. 48 kHz with noise
// suppression off, clicked on the intro card before Enter starts it.
const backed = await run('tone', 'back', 'keys',
  '&early&keys=R,L,R,R,R,L&pick');
const backDir = path.join(tmp, 'back');
const backFiles = wavs(backDir);
const rateOf = (f) => readFileSync(path.join(backDir, f)).readUInt32LE(24);
check('back', JSON.stringify(backed.steps) === JSON.stringify(
  ['1.0', '1.1', '1.0', '1.1', '1.2', '2.0', '1.0', '1.1', '1.2', '2.0'])
  && backed.finished === true && /2 slides · 5 files/.test(backed.card ?? '')
  && JSON.stringify(backFiles) === JSON.stringify(files),
`← read ${backed.steps.join(' ')} · done card: "${/\d+ slides? · \d+ files?/.exec(backed.card ?? '')?.[0]}" · wrote ${backFiles.join(' ') || '(nothing)'}`);
check('options', JSON.stringify(took.introOpts) === JSON.stringify(['on', '24 kHz', '3 s'])
  && JSON.stringify(backed.introOpts) === JSON.stringify(['off', '48 kHz', '1 s'])
  && /after a 3, 2, 1, and/.test(took.countSays ?? '') && /after a 1, and/.test(backed.countSays ?? '') && /5\.8 MB/.test(backed.introWhy)
  && took.gum?.noiseSuppression === true && backed.gum?.noiseSuppression === false
  && rateOf('slide-01.wav') === 48000 && readFileSync(path.join(outDir, 'slide-01.wav')).readUInt32LE(24) === 24000,
`defaults on/24 kHz=${JSON.stringify(took.introOpts)} · chosen ${JSON.stringify(backed.introOpts)}`
  + ` · asked noiseSuppression=${backed.gum?.noiseSuppression} · wrote ${backFiles.length ? rateOf('slide-01.wav') : '?'} Hz`);

// ── run 5: no --dir, on a deck that names its own folder: voices/me ─────────
const mine = await run('tone', '', 'keys', '&cfg&countdown=0');
const meDir = path.join(tmp, 'voices', 'me');
const meFiles = wavs(meDir);
// …and the next visit refreshes that folder, rather than proposing voices/me-2
const again = await run('tone', '', 'keys', '&cfg&introonly&countdown=0');
check('voices/me', mine.folder === 'voices/me' && mine.finished === true
  && JSON.stringify(meFiles) === JSON.stringify(files) && !existsSync(path.join(tmp, 'voiceover'))
  && again.folder === 'voices/me' && again.clash === false,
`proposed ${mine.folder} over the deck's voiceover/ · wrote ${meFiles.length} files there`
  + ` · voiceover/ untouched=${!existsSync(path.join(tmp, 'voiceover'))} · next time ${again.folder}, no clash warning=${again.clash === false}`);

check('count-in', took.counted.length === 4 && took.counted.every((c) => c === '3') && backed.earlyIgnored === true
  && backed.counted.every((c) => c === '1') && mine.counted.every((c) => c === null),
`by default from 3=${took.counted.join('')} · clicked 1 s=${backed.counted.join('')}`
  + ` · → during the count waited=${backed.earlyIgnored} · ?countdown=0 none=${mine.counted.every((c) => c === null)}`);

// ── run 6+: part of a slide (#851), against run 1's takes/ ──────────────────
const bytes = (f) => readFileSync(path.join(outDir, f));
const before = Object.fromEntries(files.map((f) => [f, bytes(f)]));
const same = (f) => before[f] && Buffer.compare(before[f], bytes(f)) === 0;
const pcmLen = (f) => bytes(f).length - 44;
// --beats 2-3, stopped on beat 3's count-in: beat 2 is new, 1 and 3 are byte
// for byte as recorded, and slide-01.wav is the three beats back to back
const part = await run('tone', 'takes', 'keys', '&slides=1&beats=2-3&keys=R,E&escnext&countdown=0');
check('beats', part.fromLine?.includes('beats 2–3 of 3 only') && part.steps[0] === '1.1'
  && !same('slide-01-02.wav') && same('slide-01-01.wav') && same('slide-01-03.wav') && same('slide-02.wav')
  && pcmLen('slide-01.wav') === pcmLen('slide-01-01.wav') + pcmLen('slide-01-02.wav') + pcmLen('slide-01-03.wav'),
`--beats 2-3 started at build ${part.steps[0]} · Esc after beat 2 · rewrote 01-02=${!same('slide-01-02.wav')}`
  + ` · kept 01-01, 01-03, 02 byte for byte=${same('slide-01-01.wav') && same('slide-01-03.wav') && same('slide-02.wav')}`
  + ' · slide-01.wav rebuilt from all three');
// a beat the slide does not have is refused with the count, and nothing starts
const nope = await run('tone', 'takes', 'keys', '&slides=1&beats=5&introonly');
check('no beat', /slide 1 has 3 beats: there is no beat 5/.test(nope.warnText ?? '') && nope.canStart === false,
  `--beats 5 on a 3-beat slide: "${nope.warnText}" · offers to start=${nope.canStart}`);
// → twice on the intro card starts at beat 3; that one is redone, then slide 2
const now = Object.fromEntries(files.map((f) => [f, bytes(f)]));
const picked = await run('tone', 'takes', 'keys', '&from=2&keys=R,R&countdown=0');
check('start at', /slide 1 · beat 3 of 3/.test(picked.fromLine ?? '') && /beats 1–2 of slide 1 kept/.test(picked.fromLine ?? '')
  && JSON.stringify(picked.steps) === JSON.stringify(['1.2', '2.0']) && picked.finished === true
  && Buffer.compare(now['slide-01-01.wav'], bytes('slide-01-01.wav')) === 0
  && Buffer.compare(now['slide-01-02.wav'], bytes('slide-01-02.wav')) === 0
  && Buffer.compare(now['slide-01-03.wav'], bytes('slide-01-03.wav')) !== 0,
`picked "${picked.fromLine}" · read ${picked.steps.join(' ')} · beats 1–2 untouched, 3 redone`);

// ── #850: the take kept its script, and V says when the notes move on ────────
const takeManifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
check('manifest', takeManifest.recorder === 'mic' && takeManifest.engine === null
  && JSON.stringify(takeManifest.slides[0]?.beats) === JSON.stringify(['Beat one.', 'Beat two.', 'Beat three.'])
  && JSON.stringify(takeManifest.slides[1]?.beats) === JSON.stringify(['Slide two, all in one breath.'])
  && takeManifest.slides[0]?.segments?.length === 3 && !takeManifest.slides[2],
`recorder=${takeManifest.recorder} · slide 1 beats=${JSON.stringify(takeManifest.slides[0]?.beats)}`);
// move slide 1's second [click] one sentence on: the words are the same
const deckFile = path.join(tmp, 'deck.html');
writeFileSync(deckFile, DECK.replace('Beat two. ⟨CLICK⟩ Beat three.', 'Beat two. Beat three. ⟨CLICK⟩'));
const moved = await run('tone', '', 'keys', '&cfg=takes&vpanel');
writeFileSync(deckFile, DECK);
const steady = await run('tone', '', 'keys', '&cfg=takes&vpanel');
check('drift', /Slide 1's \[click\] moved since it was recorded \(3 beats → 2\)/.test(moved.vWarn ?? '')
  && /cannot move a build/.test(moved.vWarn ?? '') && /decklight narrate deck\.html --mic --slides 1 --dir takes/.test(moved.vWarn ?? '')
  && /build split changed — re-record slide 1/.test(moved.vRows ?? '') && steady.vWarn === null,
`V says: "${moved.vWarn}" · put back, says nothing=${steady.vWarn === null}`);

if (bad) fail(`${bad} check${bad === 1 ? '' : 's'} failed`);
console.log(`record-render: PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  + (skipped ? ` — ${skipped} check${skipped === 1 ? '' : 's'} SKIPPED, see above` : ''));
process.exit(0);
