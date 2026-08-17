// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The presenter's heads-up display: the four things you can layer over the
// slides while you talk. The clock (K), the progress hairline (J), the ink
// tools (W pen, ⇧W laser) and the transcript (palette).
//
// They share a shape rather than any state. Each is off by default, each
// remembers its setting per deck in localStorage, each mounts one element
// under the root and takes it away again, and none of them is ever rendered
// in ?print. That shape was repeated four times in the middle of engine.js,
// between the deck's own scaling and its narration.

import { closeOnBackdrop } from './overlay.js';
import { createAnnotator } from './annotate.js';

/**
 * Wire the presenter overlays to a deck.
 *
 * `setProgressBar` hands the engine the bar element to write into (or null
 * when the bar goes away): the width comes from the same slide/step fraction
 * the chrome already computes, so the engine keeps that job.
 */
export function createHud({
  root, printMode, toast, debugLog, overlays, instance, narration, downloadFromUrl, setProgressBar,
}) {
  // ── presenter clock (K) — SPEC PRESENTING ─────────────────────────────────────────
  // Wall time + elapsed talk time under the slide number — the two numbers a
  // presenter otherwise checks a phone for, and the room notices a phone.
  // Elapsed counts from the deck's FIRST advance, not page load: a deck
  // idling on its title slide while people file in is not a talk yet.
  // Off by default; persists per deck. Never rendered in ?print.
  const clockKey = 'decklight-clock:' + location.pathname;
  let clockOn = false;
  try { clockOn = localStorage.getItem(clockKey) === '1'; } catch { /* ignore */ }
  let clockEl = null, clockTimer = null, talkStart = null, clockArmed = false;
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    return (h ? h + ':' : '') + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    clockEl.querySelector('.clk-time').textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    clockEl.querySelector('.clk-elapsed').textContent =
      '+' + fmtElapsed(talkStart == null ? 0 : Date.now() - talkStart);
  }
  function showClock() {
    clockEl = document.createElement('div');
    clockEl.className = 'decklight-clock';
    clockEl.innerHTML = '<span class="clk-time"></span><span class="clk-elapsed"></span>';
    root.appendChild(clockEl);
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
  }
  function toggleClock() {
    clockOn = !clockOn;
    try { localStorage.setItem(clockKey, clockOn ? '1' : '0'); } catch { /* ignore */ }
    if (clockOn) showClock();
    else { clearInterval(clockTimer); clockTimer = null; clockEl?.remove(); clockEl = null; }
    toast(`clock ${clockOn ? 'on' : 'off'}`);
    debugLog('nav', `clock ${clockOn ? 'on' : 'off'}`);
  }
  // Arm only after init's opening goto (and any deep-link landing): the
  // first navigation AFTER ready is the start of the talk.
  instance.on('ready', () => { clockArmed = true; });
  const startTalk = () => {
    if (!clockArmed || talkStart != null) return;
    talkStart = Date.now();
    updateClock();
  };
  instance.on('slide', startTalk);
  instance.on('build', startTalk);
  instance.toggleClock = toggleClock; // K programmatically
  if (clockOn && !printMode) showClock();

  // ── progress bar (J) — SPEC PRESENTING ────────────────────────────────────────────
  // A hairline along the bottom edge whose width IS the position in the deck —
  // the shape of the talk at a glance, without counting slides. A passive
  // readout of state.slide/step (the fraction _updateChrome computes); it
  // never drives navigation or auto-advance.
  // Off by default; persists per deck. Never rendered in ?print.
  const progressKey = 'decklight-progress:' + location.pathname;
  let progressOn = false;
  try { progressOn = localStorage.getItem(progressKey) === '1'; } catch { /* ignore */ }
  let progressEl = null;
  function showProgress() {
    progressEl = document.createElement('div');
    progressEl.className = 'decklight-progress';
    progressEl.innerHTML = '<div class="bar"></div>';
    root.appendChild(progressEl);
    setProgressBar(progressEl.querySelector('.bar'));
    instance._updateChrome(); // arrive at the current width, not a sweep from 0
  }
  function toggleProgress() {
    progressOn = !progressOn;
    try { localStorage.setItem(progressKey, progressOn ? '1' : '0'); } catch { /* ignore */ }
    if (progressOn) showProgress();
    else { progressEl?.remove(); progressEl = null; setProgressBar(null); }
    toast(`progress bar ${progressOn ? 'on' : 'off'}`);
    debugLog('nav', `progress bar ${progressOn ? 'on' : 'off'}`);
  }
  instance.toggleProgress = toggleProgress; // J programmatically
  if (progressOn && !printMode) showProgress();

  // ── ink annotations (W pen / ⇧W laser) — SPEC PRESENTING ──────────────────────────
  // Ephemeral presenter ink on a canvas over the slides: strokes live in
  // design coordinates and redraw at the current scale; every slide change
  // clears them. Never in ?print — like the clock, exclusion is by
  // construction: the annotator is simply never created there.
  let annotator = null;
  if (!printMode) {
    annotator = createAnnotator(instance, root);
    instance.annotate = annotator; // W/⇧W programmatically (headless harness)
  }
  function toggleInk(kind) {
    if (!annotator) return;
    const t = kind === 'laser' ? annotator.laser() : annotator.toggle();
    toast(t === 'pen' ? 'pen on — drag to draw · ⌫ clears · W off'
      : t === 'laser' ? 'laser on — ⇧W off' : 'ink off');
    debugLog('nav', `ink ${t ?? 'off'}`);
  }

  // ── transcript (palette command) — SPEC PRESENTING ───────────────────────────────
  // The deck's full spoken script: every slide's notes segments, in order,
  // in a scrollable overlay (titles jump to their slide) with .txt and .md
  // export — the same segmentation narration and captions use.
  function transcriptData() {
    return (instance._sections || []).map((s, i) => ({
      n: i + 1,
      title: s.querySelector('h1, h2, h3')?.textContent.trim() || `Slide ${i + 1}`,
      segs: narration.notesSegs(i + 1).filter(Boolean),
    }));
  }
  function transcriptString(md) {
    const title = (document.title || 'Deck').trim();
    const out = md ? [`# ${title} — transcript`, ''] : [`${title} — transcript`, ''];
    for (const { n, title: t, segs } of transcriptData()) {
      if (!segs.length) continue;
      out.push(md ? `## ${n}. ${t}` : `${n}. ${t}`, '');
      for (const seg of segs) out.push(seg, '');
    }
    return out.join('\n');
  }
  function downloadTranscript(kind) {
    const md = kind === 'md';
    const url = URL.createObjectURL(new Blob([transcriptString(md)], { type: md ? 'text/markdown' : 'text/plain' }));
    const base = (location.pathname.split('/').pop() || 'deck').replace(/\.html?$/i, '');
    downloadFromUrl(url, `${base}-transcript.${md ? 'md' : 'txt'}`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    debugLog('narr', `transcript exported (.${md ? 'md' : 'txt'})`);
  }
  let transcriptEl = null;
  function toggleTranscript() {
    if (transcriptEl) { transcriptEl.remove(); transcriptEl = null; return; }
    transcriptEl = document.createElement('div');
    transcriptEl.className = 'decklight-narr decklight-transcript';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = 'transcript — the deck’s spoken notes · Esc closes';
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    for (const [label, kind] of [['⬇ export .txt', 'txt'], ['⬇ export .md', 'md']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'narr-prev-btn';
      b.textContent = label;
      b.addEventListener('click', () => downloadTranscript(kind));
      actions.appendChild(b);
    }
    card.append(head, actions);
    for (const { n, title, segs } of transcriptData()) {
      if (!segs.length) continue;
      const sec = document.createElement('div');
      sec.className = 'tr-slide';
      const t = document.createElement('div');
      t.className = 'tr-title';
      t.textContent = `${n} · ${title}`;
      t.title = 'jump to this slide';
      t.addEventListener('click', () => { toggleTranscript(); instance.goto(n, 0, { force: true }); });
      sec.appendChild(t);
      for (const seg of segs) {
        const p = document.createElement('p');
        p.className = 'tr-seg';
        p.textContent = seg;
        sec.appendChild(p);
      }
      card.appendChild(sec);
    }
    transcriptEl.appendChild(card);
    closeOnBackdrop(transcriptEl, toggleTranscript);
    root.appendChild(transcriptEl);
  }
  instance.transcript = { open: toggleTranscript, text: () => transcriptString(false), markdown: () => transcriptString(true) };
  // a reading surface — it traps navigation while it is up
  overlays.register({
    isOpen: () => !!transcriptEl,
    close: toggleTranscript,
    keydown: (e) => e.key === 'Escape' && (toggleTranscript(), true),
  });

  return {
    toggleClock,
    toggleProgress,
    toggleInk,
    toggleTranscript,
    /** The ink surface, or null when no tool has ever been picked up. */
    get annotator() { return annotator; },
    /** Palette labels ask what is currently on. */
    status: () => ({ clockOn, progressOn }),
  };
}
