// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Film yourself for the talking head (SPEC PRESENTING, character): a few
// seconds from the camera, recorded in the deck, sent to the lip-sync bridge,
// which prepares it like any filmed portrait (tools/lipsync-engines.mjs
// `prepareClip`) and keeps it. The alternative was "film it on your phone,
// AirDrop it, find the path, run decklight lipsync --portrait … --save" —
// five steps between wanting a talking head and having one.
//
// MediaRecorder here, unlike the voice recorder's WebAudio PCM: the bridge
// hands the film to ffmpeg, which reads webm and mp4 alike, and a video
// frame-by-frame in script would be absurd. The camera stays open from the
// first look to the last retake, and is closed on every way out.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop } from './overlay.js';
import { thinking } from './thinking.js';

/** What to ask MediaRecorder for, best first: mp4 is what every tool reads; webm is Chrome's own. */
const TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** Why this browser cannot film, in the words of the thing to do about it — null when it can. */
export function cameraUnavailable(win = globalThis) {
  if (!win.MediaRecorder) return 'this browser cannot record video (no MediaRecorder)';
  if (win.navigator?.mediaDevices?.getUserMedia) return null;
  return win.location?.protocol === 'file:'
    ? 'a browser will not open the camera for a page loaded from a file — run decklight <deck.html>'
    : 'this browser exposes no camera (getUserMedia needs http://127.0.0.1 or https://)';
}

/** The browser's refusal, said as what to do about it. */
function refusal(e) {
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'the camera was refused — allow it for this page (the camera icon in the address bar), then try again';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no camera found on this machine';
  if (n === 'NotReadableError') return 'the camera is busy — another app is using it';
  return `the camera would not open: ${e?.message ?? e}`;
}

/**
 * `bridge` is the lip-sync bridge's base URL; `onUse({ name, steady, seconds })`
 * runs once the bridge has taken the film. `seconds` is how long a take is;
 * `name` what the portrait is called. `getUserMedia`, `fetchFn` and
 * `createRecorder` are injectable for the harness, which has no camera.
 */
export function createFilmRecorder({
  root, bridge, debugLog = () => {}, onUse = () => {},
  seconds = 8, name = 'filmed',
  getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
  fetchFn = (...a) => fetch(...a),
  createRecorder = (stream, opts) => new MediaRecorder(stream, opts),
  countdownMs = 700,
}) {
  let el = null, view = 'closed', stream = null, recorder = null, take = null, takeUrl = null;
  let run = 0;                // bumps on close/retake: a stale timer or upload stands down
  let stopBusy = () => {};

  const card = () => el?.querySelector('.narr-card');
  const TIPS = `<ul class="film-tips">
    <li>face the camera, your face in the circle, evenly lit</li>
    <li>mouth relaxed and closed — <strong>don't talk</strong></li>
    <li>blink, breathe — but keep your head still</li></ul>`;

  function render(next, data = {}) {
    view = next;
    const c = card();
    if (!c) return;
    stopBusy();
    const circle = (inner = '') => `<div class="film-circle"><video class="film-video" muted playsinline autoplay></video>${inner}</div>`;
    if (next === 'why') {
      c.innerHTML = `<div class="narr-head">film yourself</div>
        <div class="rec-line rec-warn">${escapeHtml(data.why)}</div>
        <div class="rec-hint">Esc to close</div>`;
      return;
    }
    if (next === 'opening') {
      c.innerHTML = `<div class="narr-head">film yourself</div><div class="rec-line film-busy"></div>`;
      stopBusy = thinking((t) => { const b = c.querySelector('.film-busy'); if (b) b.textContent = t; }, { label: 'opening the camera' });
      return;
    }
    if (next === 'ready') {
      c.innerHTML = `<div class="narr-head">film yourself — ${seconds} s for your talking head</div>
        ${circle('<div class="film-mark"></div>')}
        <div class="film-below">${TIPS}<div class="narr-row narr-sel film-go">● Record ${seconds} s</div></div>
        <div class="rec-hint">Enter to record · Esc to cancel</div>`;
      const v = c.querySelector('.film-video');
      v.classList.add('mirror');   // a mirror is what a face expects to see; the film is not flipped
      v.srcObject = stream;
      v.play?.().catch(() => {});
      c.querySelector('.film-go').addEventListener('click', start);
      return;
    }
    if (next === 'review') {
      c.innerHTML = `<div class="narr-head">your take — ${data.secs.toFixed(1)} s</div>
        ${circle()}
        <div class="narr-row narr-sel film-use">Use it — as “${escapeHtml(name)}”</div>
        <div class="narr-row film-retake">Retake</div>
        <div class="rec-hint">Enter to use it · R to retake · Esc to cancel</div>`;
      const v = c.querySelector('.film-video');
      v.src = takeUrl;
      v.loop = true;
      v.play?.().catch(() => {});
      c.querySelector('.film-use').addEventListener('click', use);
      c.querySelector('.film-retake').addEventListener('click', retake);
      return;
    }
    if (next === 'saving') {
      c.innerHTML = `<div class="narr-head">film yourself</div>
        <div class="rec-line film-busy"></div>
        <div class="rec-line">finding your face in every second of it, and making the loop — once; a minute at most</div>`;
      stopBusy = thinking((t) => { const b = c.querySelector('.film-busy'); if (b) b.textContent = t; }, { label: 'the bridge is preparing it' });
      return;
    }
    if (next === 'failed') {
      c.innerHTML = `<div class="narr-head">film yourself</div>
        <div class="rec-line rec-warn">${escapeHtml(data.error)}</div>
        ${stream ? '<div class="narr-row narr-sel film-retake">Retake</div>' : ''}
        <div class="rec-hint">${stream ? 'Enter or R to retake · ' : ''}Esc to close</div>`;
      c.querySelector('.film-retake')?.addEventListener('click', retake);
    }
  }

  async function open() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-film';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Film yourself"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    const mine = ++run;
    const why = cameraUnavailable();
    if (why) return render('why', { why });
    render('opening');
    try {
      const s = await getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      if (mine !== run) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      render('ready');
    } catch (e) {
      if (mine === run) render('why', { why: refusal(e) });
    }
  }

  /** Countdown and seconds left, drawn over the live picture — not a re-render, which would restart it. */
  function mark(next, text) {
    view = next;
    const c = card();
    if (!c) return;
    c.querySelector('.film-mark').textContent = text;
    c.querySelector('.film-circle').classList.toggle('rec', next === 'recording');
    c.querySelector('.narr-head').textContent = next === 'recording' ? `● recording — ${seconds} s` : 'film yourself — get ready';
    c.querySelector('.film-below').innerHTML = '<div class="rec-line film-hold">hold still — mouth relaxed, don\'t talk</div>';
    c.querySelector('.rec-hint').textContent = 'Esc to stop';
  }

  function wait(ms, mine) {
    return new Promise((res) => setTimeout(() => res(mine === run), ms));
  }

  async function start() {
    if (view !== 'ready' || !stream) return;
    const mine = run;
    for (const n of [3, 2, 1]) {
      mark('countdown', String(n));
      if (!await wait(countdownMs, mine)) return;
    }
    const type = TYPES.find((t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) ?? '';
    const chunks = [];
    recorder = createRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const done = new Promise((res) => { recorder.onstop = res; });
    const t0 = performance.now();
    recorder.start(250);
    for (let left = seconds; left > 0; left--) {
      mark('recording', `${left}s`);
      if (!await wait(1000, mine)) { try { recorder.stop(); } catch { /* gone */ } return; }
    }
    recorder.stop();
    await done;
    if (mine !== run) return;
    const secs = (performance.now() - t0) / 1000;
    take = new Blob(chunks, { type: (recorder.mimeType || type || 'video/webm').split(';')[0] });
    recorder = null;
    if (takeUrl) URL.revokeObjectURL(takeUrl);
    takeUrl = URL.createObjectURL(take);
    debugLog('character', `filmed ${secs.toFixed(1)} s · ${(take.size / 1024).toFixed(0)} KB · ${take.type}`);
    render('review', { secs });
  }

  function retake() {
    if (!stream) return;
    run++;
    take = null;
    render('ready');
  }

  async function use() {
    if (view !== 'review' || !take) return;
    const mine = run;
    render('saving');
    try {
      const r = await fetchFn(`${bridge}/portrait?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'content-type': take.type }, body: take,
      });
      const j = await r.json().catch(() => ({}));
      if (mine !== run) return;
      if (!r.ok || !j.ok) return render('failed', { error: j.error ?? `the lip-sync bridge answered ${r.status}` });
      close();
      onUse({ name: j.name ?? name, steady: j.steady, seconds: j.seconds });
    } catch (e) {
      if (mine === run) render('failed', { error: `the lip-sync bridge did not answer (${e.message ?? e})` });
    }
  }

  function close() {
    run++;
    stopBusy();
    try { recorder?.state === 'recording' && recorder.stop(); } catch { /* gone */ }
    recorder = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (takeUrl) URL.revokeObjectURL(takeUrl);
    takeUrl = null;
    take = null;
    el?.remove();
    el = null;
    view = 'closed';
  }

  function keydown(e) {
    if (e.key === 'Escape') { close(); return true; }
    if (e.key === 'Enter') {
      if (view === 'ready') start();
      else if (view === 'review') use();
      else if (view === 'failed') retake();
      else return false;
      return true;
    }
    if ((e.key === 'r' || e.key === 'R' || e.key === 'Backspace') && (view === 'review' || view === 'failed')) { retake(); return true; }
    return false;
  }

  return { open, close, keydown, isOpen: () => !!el, get view() { return view; } };
}
