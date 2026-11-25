// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openPage } from './cdp.mjs';

// Runs inside the deck. The page keeps time by its own wall clock, the same
// clock the capture samples frames by, so a slow capture does not slow the
// talk down and the picture stays where the narration is (the encoder lays the
// narration in from the WAV; the page never plays it). An <audio> element
// streaming a WAV of hundreds of megabytes used to be the clock here: when it
// stalled partway through a long talk, the deck froze on one frame and nothing
// noticed (#1254).
//
// Everything the watchdog reads is on `window.__dlLive`: when the loop last
// ran, the talk time it showed, the beat it is on, when the slide last
// changed, the first error, and the media events the watchdog has not read yet.
function playTalk(beats, fps, fault) {
  const root = document.querySelector('.decklight');
  const deck = root?.__decklight;
  if (!deck) throw new Error('the deck did not initialize');
  const wall = () => performance.timeOrigin + performance.now();
  const state = window.__dlLive = { tick: wall(), time: 0, index: -1, changedAt: 0, dropped: 0, error: null, errorAt: null, events: [] };
  let index = -1;
  let pose = -1;
  let shown = null;
  let overlay;
  let video;
  const note = (what) => { if (state.events.length < 200) state.events.push(what); };
  function show(time) {
    if (fault?.kind === 'throw' && time >= fault.at) throw new Error('simulated failure at ' + fault.at + ' s');
    let next = Math.max(0, index);
    while (beats[next + 1]?.start <= time) next++;
    const beat = beats[next];
    const elapsed = Math.max(0, time - beat.start);
    if (next !== index) {
      index = next;
      state.index = next;
      pose = -1;
      const at = beat.slide + '/' + beat.step;
      if (at !== shown) { shown = at; state.changedAt = wall(); }
      deck.goto(beat.slide, beat.step);
      deck.character?.stop();
      if (video) video.pause();
      overlay?.remove();
      root.classList.remove('decklight-face-full');
      video = null;
      if (beat.face) {
        overlay = document.createElement('div');
        const full = beat.face.kind === 'full';
        overlay.className = 'decklight-character show mode-video pos-' + (beat.face.at ?? 'br');
        overlay.classList.toggle('face-full', full);
        overlay.style.setProperty('--face-zoom', beat.face.zoom);
        root.classList.toggle('decklight-face-full', full);
        const face = video = document.createElement('video');
        face.muted = true;
        face.playsInline = true;
        face.className = 'live';
        for (const type of ['waiting', 'stalled', 'error']) {
          face.addEventListener(type, () => note('slide ' + beat.slide + ' face video: ' + type
            + (type === 'error' && face.error ? ' (' + (face.error.message || 'code ' + face.error.code) + ')' : '')));
        }
        face.src = beat.face.url;
        overlay.append(face);
        root.append(overlay);
        face.currentTime = elapsed;
        face.play().catch(() => {});
      }
    }
    if (video && video.readyState >= 1 && !video.ended && !video.seeking
        && elapsed < video.duration && Math.abs(video.currentTime - elapsed) > 0.06) {
      video.currentTime = elapsed;
    }
    let current = Math.max(0, pose);
    while (beat.poses[current + 1]?.audioOffset <= elapsed) current++;
    const shape = beat.poses[current];
    if (shape && current !== pose) {
      pose = current;
      deck.character?.capture(shape.character, shape.placement, shape.force);
    }
  }
  show(0);
  const started = wall();
  const end = beats.at(-1).end;
  let lastPaint = performance.now();
  function advance(now) {
    const time = (wall() - started) / 1000;
    if (fault?.kind === 'freeze' && time >= fault.at) return;
    // the next tick is asked for first: one bad frame must not end the loop
    // unseen, and the watchdog stops the capture on the error recorded here
    if (time < end) requestAnimationFrame(advance);
    state.dropped += Math.max(0, Math.round((now - lastPaint) * fps / 1000) - 1);
    lastPaint = now;
    state.tick = wall();
    state.time = time;
    try { show(time); } catch (err) {
      state.errorAt ??= time;
      state.error ??= String(err?.stack || err).split('\n').slice(0, 3).map((line) => line.trim()).join(' · ');
    }
  }
  requestAnimationFrame(advance);
  return started;
}

/** Seconds as m:ss, for the log. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** The index of the beat a talk `time` (seconds) falls in. */
function beatAt(beats, time) {
  return Math.max(0, beats.findLastIndex((beat) => beat.start <= time));
}

/**
 * Why a live capture has stopped progressing, or null while it is fine.
 * `state` is the page's `window.__dlLive`; `now` and `started` are wall-clock
 * milliseconds. A still picture is not a problem in itself, since a slide that
 * does not move sends no new image, so this judges the page's own clock and
 * not the frames.
 */
export function liveStall(state, { now, started, beats, grace = 2 }) {
  if (!state) return 'the live player is gone from the page';
  if (state.error) return 'page error: ' + state.error;
  const talk = (now - started) / 1000;
  const quiet = (now - state.tick) / 1000;
  if (quiet > grace) return `the page stopped animating ${quiet.toFixed(1)} s ago`;
  if (talk - state.time > grace) return `the deck's clock is ${(talk - state.time).toFixed(1)} s behind the talk`;
  const expected = beatAt(beats, talk - grace);
  if (state.index < expected) {
    const on = beats[state.index] ?? beats[0];
    const due = beats[expected];
    return `the deck is still on slide ${on.slide} step ${on.step}, but the talk is at slide ${due.slide} step ${due.step}`;
  }
  return null;
}

/** `throw@12` or `freeze@12` (seconds into the talk): a simulated stall, for the tests. */
export function liveFault(spec) {
  const m = /^(throw|freeze)@(\d+(?:\.\d+)?)$/.exec(spec ?? '');
  return m ? { kind: m[1], at: Number(m[2]) } : null;
}

const READ_STATE = '(() => { const s = window.__dlLive; return s ? { ...s, events: s.events.splice(0) } : null; })()';

export async function captureLive({ plan, chrome, url, settings, work, exec, signal, media, log, encoding }) {
  const { w, h, fps, format, quality } = settings;
  const beats = [];
  const audioFiles = [];
  const fmt = ['-ar', String(encoding.sampleRate), '-ac', '2', '-c:a', 'pcm_s16le'];
  let duration = 0;
  for (const [i, beat] of plan.entries()) {
    const file = join(work, 'live-audio-' + i + '.wav');
    const input = beat.audio ? ['-i', beat.audio, '-af', 'apad'] : ['-f', 'lavfi', '-i', 'anullsrc'];
    await exec('ffmpeg', ['-y', ...input, ...fmt, '-t', String(beat.duration), file]);
    audioFiles.push(file);
    const face = beat.face && { kind: beat.face.kind, at: beat.face.at, zoom: beat.face.zoom, url: '/decklight-live/face-' + i + '.mp4' };
    if (face) media.set(face.url, beat.face.clip);
    const poses = beat.poses.map(({ character, placement, audioOffset, force }) => ({ character, placement, audioOffset, force }));
    beats.push({ slide: beat.slide, step: beat.step, start: duration, end: duration + beat.duration, face, poses });
    duration += beat.duration;
  }
  const list = join(work, 'live-audio.txt');
  writeFileSync(list, audioFiles.map((file) => "file '" + file.replaceAll("'", "'\\''") + "'").join('\n') + '\n');
  const audio = join(work, 'live.wav');
  await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'copy', audio]);
  const out = join(work, 'live.' + format);
  const encoder = spawn('ffmpeg', [
    '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-i', audio,
    ...encoding.video(quality, true), ...encoding.audio(quality), '-t', duration.toFixed(3), out,
  ], { stdio: ['pipe', 'ignore', 'pipe'], signal });
  let error = null;
  let stderr = '';
  encoder.on('error', (err) => { error = err; });
  encoder.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const encoded = new Promise((resolve) => encoder.once('close', resolve));
  const count = Math.ceil(duration * fps);
  const fault = liveFault(process.env.DECKLIGHT_TEST_LIVE_FAULT);
  const screencast = { format: 'jpeg', quality: 92, maxWidth: w, maxHeight: h, everyNthFrame: 1 };
  let dropped = 0;
  async function* frames({ signal }) {
    const page = await openPage(chrome, { w, h, signal, args: ['--mute-audio'] });
    let latest;
    let lastFrameAt = 0;
    const offs = [
      page.on('Page.screencastFrame', ({ data, sessionId }) => {
        latest = Buffer.from(data, 'base64');
        lastFrameAt = Date.now();
        page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      }),
      page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        log('  live capture: page error: ' + (d.exception?.description ?? d.text ?? 'unknown').split('\n')[0]);
      }),
      page.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type !== 'error' && type !== 'warning') return;
        const text = args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        log(`  live capture: console.${type === 'warning' ? 'warn' : type}: ${text}`);
      }),
    ];
    const watching = new AbortController();
    let watch = Promise.resolve();
    try {
      const first = beats[0];
      await page.navigate(url + '#/' + first.slide + '/' + first.step);
      await page.send('Page.bringToFront');
      latest = await page.screenshot('jpeg');
      await page.send('Page.startScreencast', screencast);
      const started = await page.evaluate('(' + playTalk + ')(' + JSON.stringify(beats) + ', ' + fps + ', ' + JSON.stringify(fault) + ')');
      log(`  live capture: recording ${duration.toFixed(1)}s at ${fps} fps`);
      let failure = null;
      let state = null;
      // where the page last was: a frozen page is named where it froze, not
      // where the capture noticed
      const where = () => {
        const talk = Math.min(duration, state ? (state.errorAt ?? state.time) : (Date.now() - started) / 1000);
        return `slide ${beats[beatAt(beats, talk)].slide}, ${clock(talk)} into the talk`;
      };
      // Once a second: is the page still moving through the talk? A stall
      // stops the capture with where and why; a video whose second half is
      // one frame is never written.
      watch = (async () => {
        let warned = 0;
        while (!failure) {
          await delay(1000, undefined, { signal: watching.signal });
          const now = Date.now();
          const read = await Promise.race([page.evaluate(READ_STATE), delay(5000, 'timeout', { signal: watching.signal, ref: false })]);
          if (read === 'timeout') { failure = 'the page did not answer for 5 s'; break; }
          state = read;
          for (const event of state?.events ?? []) log('  live capture: ' + event);
          failure = liveStall(state, { now, started, beats });
          // The slide changed but no screencast frame followed: take the
          // picture by hand and restart the screencast.
          if (!failure && state.changedAt > lastFrameAt && now - state.changedAt > 1500) {
            if (now - warned > 30000) log(`  live capture: warning — the screencast sent nothing after the slide changed (${where()}); restarting it`);
            warned = now;
            latest = await page.screenshot('jpeg');
            lastFrameAt = Date.now();
            await page.send('Page.stopScreencast');
            await page.send('Page.startScreencast', screencast);
          }
        }
      })().catch((err) => { if (!watching.signal.aborted) failure ??= 'lost the page: ' + err.message; });
      const stalled = () => Object.assign(new Error(`live capture stopped at ${where()}: ${failure}`), { liveStall: true });
      let index = 0;
      let currentSlide = null;
      let previous;
      while (index < count) {
        signal.throwIfAborted();
        if (failure) throw stalled();
        const target = started + index * 1000 / fps;
        const wait = target - Date.now();
        if (wait > 0) await delay(wait, undefined, { signal });
        const actual = Math.min(count - 1, Math.max(index, Math.floor((Date.now() - started) * fps / 1000)));
        const image = latest;
        for (let missing = index; missing < actual; missing++) {
          yield previous ?? image;
          dropped++;
        }
        yield image;
        previous = image;
        index = actual + 1;
        const beat = beats.findLast((beat) => beat.start <= actual / fps);
        if (beat.slide !== currentSlide) {
          currentSlide = beat.slide;
          log(`  slide ${String(currentSlide).padStart(2, '0')}: recorded`);
        }
      }
      await delay(Math.max(0, started + duration * 1000 - Date.now()), undefined, { signal });
      if (failure) throw stalled();
      // A still viewport need not send a new image. Count missed animation
      // ticks and late sampling, without counting the same stall twice.
      const final = await page.evaluate(READ_STATE);
      for (const event of final?.events ?? []) log('  live capture: ' + event);
      if (final?.error) { failure = 'page error: ' + final.error; throw stalled(); }
      dropped = Math.min(count, Math.max(dropped, final?.dropped ?? 0));
    } finally {
      watching.abort();
      await watch;
      for (const off of offs) off();
      await page.close();
    }
  }
  try {
    await pipeline(frames, encoder.stdin, { signal });
  } catch (err) {
    encoder.kill();
    await encoded;
    if (err?.liveStall) throw new Error(err.message);
    if (error || stderr) throw new Error(error?.message || stderr.trim());
    throw err;
  }
  if (await encoded !== 0) throw new Error(stderr.trim() || 'FFmpeg could not encode the live recording');
  if (error) throw error;
  if (dropped) log(`  live capture: warning — ${dropped} dropped or late frames at ${fps} fps`);
  else log('  live capture: no dropped frames detected');
  return out;
}
