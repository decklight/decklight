// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openPage } from './cdp.mjs';

// Runs inside the deck. The audio element is the clock for both slide
// navigation and lip sync, so a slow capture does not slow the talk down.
async function playTalk(beats, audioUrl, fps) {
  const root = document.querySelector('.decklight');
  const deck = root?.__decklight;
  if (!deck) throw new Error('the deck did not initialize');
  let index = -1;
  let pose = -1;
  let overlay;
  let video;
  const audio = new Audio(audioUrl);
  function show(time) {
    let next = Math.max(0, index);
    while (beats[next + 1]?.start <= time) next++;
    const beat = beats[next];
    const elapsed = Math.max(0, time - beat.start);
    if (next !== index) {
      index = next;
      pose = -1;
      deck.goto(beat.slide, beat.step);
      deck.character?.stop();
      if (video) video.pause();
      overlay?.remove();
      root.classList.remove('decklight-face-full');
      if (beat.face) {
        overlay = document.createElement('div');
        const full = beat.face.kind === 'full';
        overlay.className = 'decklight-character show mode-video pos-' + (beat.face.at ?? 'br');
        overlay.classList.toggle('face-full', full);
        overlay.style.setProperty('--face-zoom', beat.face.zoom);
        root.classList.toggle('decklight-face-full', full);
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.className = 'live';
        video.src = beat.face.url;
        overlay.append(video);
        root.append(overlay);
        video.currentTime = elapsed;
        video.play().catch(() => {});
      }
    }
    if (beat.face && video.readyState >= 1 && !video.ended && !video.seeking
        && elapsed < video.duration && Math.abs(video.currentTime - elapsed) > 0.06) {
      video.currentTime = elapsed;
    }
    let current = Math.max(0, pose);
    while (beat.poses[current + 1]?.audioOffset <= elapsed) current++;
    const shape = beat.poses[current];
    if (shape && current !== pose) {
      pose = current;
      deck.character.capture(shape.character, shape.placement, shape.force);
    }
  }
  show(0);
  await audio.play();
  const started = performance.timeOrigin + performance.now() - audio.currentTime * 1000;
  let lastPaint = performance.now();
  window.__dlLiveDropped = 0;
  function advance(now) {
    window.__dlLiveDropped += Math.max(0, Math.round((now - lastPaint) * fps / 1000) - 1);
    lastPaint = now;
    show(audio.currentTime);
    if (!audio.ended) requestAnimationFrame(advance);
  }
  requestAnimationFrame(advance);
  return started;
}

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
    beats.push({ slide: beat.slide, step: beat.step, start: duration, face, poses });
    duration += beat.duration;
  }
  const list = join(work, 'live-audio.txt');
  writeFileSync(list, audioFiles.map((file) => "file '" + file.replaceAll("'", "'\\''") + "'").join('\n') + '\n');
  const audio = join(work, 'live.wav');
  await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'copy', audio]);
  const audioUrl = '/decklight-live/narration.wav';
  media.set(audioUrl, audio);
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
  let dropped = 0;
  async function* frames({ signal }) {
    const page = await openPage(chrome, { w, h, signal, args: ['--mute-audio'] });
    let latest;
    const off = page.on('Page.screencastFrame', ({ data, sessionId }) => {
      latest = Buffer.from(data, 'base64');
      page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    try {
      const first = beats[0];
      await page.navigate(url + '#/' + first.slide + '/' + first.step);
      await page.send('Page.bringToFront');
      latest = await page.screenshot('jpeg');
      await page.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
      const started = await page.evaluate('(' + playTalk + ')(' + JSON.stringify(beats) + ', ' + JSON.stringify(audioUrl) + ', ' + fps + ')');
      log(`  live capture: recording ${duration.toFixed(1)}s at ${fps} fps`);
      let index = 0;
      let currentSlide = null;
      let previous;
      while (index < count) {
        signal.throwIfAborted();
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
      // A still viewport need not send a new image. Count missed animation
      // ticks and late sampling, without counting the same stall twice.
      dropped = Math.min(count, Math.max(dropped, await page.evaluate('window.__dlLiveDropped')));
    } finally {
      off();
      await page.close();
    }
  }
  try {
    await pipeline(frames, encoder.stdin, { signal });
  } catch (err) {
    encoder.kill();
    await encoded;
    if (error || stderr) throw new Error(error?.message || stderr.trim());
    throw err;
  }
  if (await encoded !== 0) throw new Error(stderr.trim() || 'FFmpeg could not encode the live recording');
  if (error) throw error;
  if (dropped) log(`  live capture: warning — ${dropped} dropped or late frames at ${fps} fps`);
  else log('  live capture: no dropped frames detected');
  return out;
}
