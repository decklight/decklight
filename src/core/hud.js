// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The presenter's heads-up display: the four things you can layer over the
// slides while you talk. The clock and the progress hairline (palette rows),
// the ink tools (W pen, ⇧W laser). The transcript is read in the speaker view.
//
// They share a shape rather than any state. Each is off by default, each
// remembers its setting per deck in localStorage, each mounts one element
// under the root and takes it away again, and none of them is ever rendered
// in ?print. That shape was repeated four times in the middle of engine.js,
// between the deck's own scaling and its narration.

import { createAnnotator } from './annotate.js';
import { readPref, writePref } from './prefs.js';

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
  clockOn = readPref(clockKey) === '1';
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
    writePref(clockKey, clockOn ? '1' : '0');
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

  // ── progress bar (palette) — SPEC PRESENTING ─────────────────────────────────────
  // A hairline along the bottom edge whose width IS the position in the deck —
  // the shape of the talk at a glance, without counting slides. A passive
  // readout of state.slide/step (the fraction _updateChrome computes); it
  // never drives navigation or auto-advance.
  // Off by default; persists per deck. Never rendered in ?print.
  const progressKey = 'decklight-progress:' + location.pathname;
  let progressOn = false;
  progressOn = readPref(progressKey) === '1';
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
    writePref(progressKey, progressOn ? '1' : '0');
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

  // ── transcript — SPEC PRESENTING ───────────────────────────────────────────────
  // The deck's full spoken script: every slide's notes segments, in order,
  // with .txt and .md export — the same segmentation narration and captions
  // use. Read in the speaker view's script view.
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
  // The transcript is READ in the speaker view now (its script view: every
  // slide's notes, the current one lit), not in a card over the slides: notes
  // had four places to be read, and a card over the deck is the one a
  // presenter cannot use while presenting (ROADMAP section 3). The text, the
  // markdown and the two exports stay here; `open` hands over to the speaker
  // view, which the engine wires in (`openScript`).
  let openScript = () => {};
  instance.transcript = {
    open: () => openScript(),
    text: () => transcriptString(false),
    markdown: () => transcriptString(true),
    data: transcriptData,
    download: downloadTranscript,
    /** The engine's speaker view, so `open` reaches it (engine.js). */
    setOpener(fn) { openScript = fn; },
  };

  return {
    toggleClock,
    toggleProgress,
    toggleInk,
    /** The ink surface, or null when no tool has ever been picked up. */
    get annotator() { return annotator; },
    /** Palette labels ask what is currently on. */
    status: () => ({ clockOn, progressOn }),
  };
}
