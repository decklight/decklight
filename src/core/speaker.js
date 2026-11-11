// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Speaker view — SPEC PRESENTING. Opened with ⌥⏎ / Alt+Enter (S edits the notes); a popup written into about:blank
// (inherits the opener's origin, so the direct window.opener bridge works on
// file:// too — no server needed). Thumbnails are iframes of the same deck
// in ?embedded mode, driven by src hash.

import { readJson, writeJson, readPref, writePref } from './prefs.js';
import { notesMarks, markAudioTags, CLICK_MARK, PAUSE_MARK } from '../../tools/sentences.mjs';

/** Where a deck's rehearsal lives when no edit server can write it into the file. */
// `location` exists in the deck; the unit tests build speakerState without one
const timingsKey = () => 'decklight-timings:' + (typeof location !== 'undefined' ? location.pathname : '');

/**
 * Planned seconds per slide: the deck's own data-timing, else the timings a
 * rehearsal left in this browser, else null. Index 0 is slide 1.
 */
export function plannedTimings(sections, stored = null) {
  const own = sections.map((s) => { const n = Number(s?.dataset?.timing); return Number.isFinite(n) && n > 0 ? n : null; });
  if (own.some((n) => n != null) || !stored) return own;
  return sections.map((_, i) => { const n = Number(stored[i]); return Number.isFinite(n) && n > 0 ? n : null; });
}

/**
 * The notes' type sizes, in px, that A− / A+ step through: the speaker view's
 * notes and the notes card both. A presenter's eyes, not the deck's, so the
 * size is kept per browser (`SPEAKER_FONT_KEY`, `NOTES_FONT_KEY`).
 */
export const FONT_SIZES = [11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48];
export const SPEAKER_FONT_KEY = 'decklight-speaker-font';
export const NOTES_FONT_KEY = 'decklight-notes-font';

/**
 * The next size on `sizes` (ascending, FONT_SIZES) from `size` in `dir` (+1
 * bigger, -1 smaller), held at either end. A size off the ladder (an old or
 * hand-set one) steps to its nearest neighbour that way; anything unreadable
 * is `fallback`. Self-contained, the ladder passed in: the popup's script
 * carries it as source, and a minified build renames anything it closes over.
 */
export function stepFontSize(sizes, size, dir, fallback = 16) {
  const n = Number(size);
  const cur = Number.isFinite(n) && n > 0 ? n : fallback;
  if (dir > 0) return sizes.find((s) => s > cur) ?? sizes[sizes.length - 1];
  if (dir < 0) return [...sizes].reverse().find((s) => s < cur) ?? sizes[0];
  return cur;
}

/** A remembered size, if it is one the ladder could have produced; else `fallback`. */
export function storedFontSize(stored, fallback) {
  const n = Number(stored);
  return Number.isFinite(n) && n >= FONT_SIZES[0] && n <= FONT_SIZES[FONT_SIZES.length - 1] ? n : fallback;
}

/** `mm:ss` — the presenter's clock, never a decimal. */
export const fmtClock = (secs) => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

/** The pace line: how this slide is going against its plan, and the whole talk so far. */
export function paceLine({ slide, spent, planned, total, plannedTotal }) {
  const here = `slide ${slide} · ${fmtClock(spent)}${planned ? ` / ${fmtClock(planned)}` : ''}`;
  const delta = planned ? spent - planned : 0;
  const verdict = !planned ? '' : delta > 5 ? ` · ${fmtClock(delta)} over` : delta < -5 && spent > 0 ? '' : '';
  const sum = `total ${fmtClock(total)}${plannedTotal ? ` / ${fmtClock(plannedTotal)}` : ''}`;
  return { text: `${here}${verdict} · ${sum}`, over: !!planned && delta > 5 };
}

/**
 * Notes markup cut into its ⟨CLICK⟩ segments, every marker spelling read the
 * way narration reads it (`notesMarks`, tools/sentences.mjs) — `[click]`,
 * `<click>`, `&lt;CLICK&gt;` all cut — so the segment the view lights is the
 * one the voice is on. A hold shows as a cue beside CLICK's, and so does an
 * audio tag (`[whispers]`) — direction to read, not words to say. The popup
 * re-balances each segment's markup.
 */
export function notesSegments(notesHtml) {
  return notesMarks(notesHtml || '').split(CLICK_MARK).map((seg) => markAudioTags(seg, (w) => `<span class="cue tag">${w}</span>`)
    .replaceAll(PAUSE_MARK, '<span class="cue">PAUSE</span>'));
}

/**
 * What a key pressed in the speaker window asks for (PRESENTING): `'toggle'`
 * (speak ⇄ rehearse: S, or the ⌥⏎ that opened it), `'bigger'` / `'smaller'`
 * (the notes' type size: + and −), `'deck'` (the deck's own key, sent on to
 * it), or null. A clicker plugged into the laptop types
 * into whichever window has focus, and at a lectern that is this one: so
 * every key a clicker sends (→ ← ⎵ PageDown PageUp Home End, B and . for a
 * black screen) does here exactly what it does in the deck, by being the
 * deck's key. Self-contained: the popup's script carries it as source.
 */
export function speakerKeyAction({ key, shiftKey = false, altKey = false, metaKey = false, ctrlKey = false }) {
  if (metaKey || ctrlKey) return null;
  if (key === 's' || key === 'S' || (altKey && key === 'Enter')) return 'toggle';
  if (altKey) return null;
  // the notes' type size, as A+ / A− do: + (or =, its unshifted key) and −
  if (key === '+' || key === '=') return 'bigger';
  if (key === '-' || key === '_') return 'smaller';
  const deckKeys = ['ArrowRight', 'ArrowLeft', ' ', 'PageDown', 'PageUp', 'Home', 'End', 'b', 'B', '.'];
  return deckKeys.includes(key) ? 'deck' : null;
}

/**
 * The deck's side of the speaker view: what the popup reads and drives,
 * installed on the deck's window. On every load, not only when the popup is
 * opened: a deck that reloads (write mode's live reload) installs it again,
 * and the popup that was open finds the new one and carries on, where it
 * used to go on showing the slide from before the reload.
 */
export function installSpeakerBridge(instance) {
  const deckUrl = () => {
    const u = new URL(location.href);
    u.searchParams.set('embedded', '');
    // slides swapped in place by an outside edit (editmode.js): a new address,
    // so the previews load the deck again rather than show the old slides
    if (instance._deckRev) u.searchParams.set('rev', String(instance._deckRev));
    u.hash = '';
    return u.href;
  };
  window.__decklightBridge = {
    // the popup says which window it is, so the deck can bring it forward
    // again after a reload it did not open it in
    subscribe(cb, win = null) {
      instance.__speakerCb = cb;
      if (win) instance.__speakerWin = win;
    },
    /**
     * The rehearsal's result, onto the deck: into the file through the author
     * server when one owns it, else into this browser — and the speaker view
     * is told which, because "saved" means two different things.
     */
    async saveTimings(seconds) {
      const timings = seconds.map((s, i) => ({ slide: i + 1, seconds: Math.round(s || 0) })).filter((t) => t.seconds > 0);
      if (instance.__saveTimings) { await instance.__saveTimings(timings); return 'deck'; }
      writeJson(timingsKey(), seconds.map((s) => Math.round(s || 0)));
      return 'browser';
    },
    getState: () => speakerState(instance, deckUrl()),
    // the notes' type size, kept on the deck's side: on file:// the popup's
    // own storage may be out of reach, the deck's is the one the next popup reads
    saveFontSize: (px) => { writePref(SPEAKER_FONT_KEY, px); },
    next: () => instance.next(),
    prev: () => instance.prev(),
    nextSlide: () => instance.nextSlide(),
    prevSlide: () => instance.prevSlide(),
    // a key the speaker window sends on (speakerKeyAction): the deck's own
    // handler takes it, so blackout, ⎵ and the voice behave as they do here
    press: ({ key, shiftKey = false }) => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    },
    // the script view: every slide's notes, and a slide to go to from it
    transcript: () => instance.transcript?.data?.() ?? [],
    goto: (n) => instance.goto(n, 0, { force: true }),
  };
  instance.__notifySpeaker = () => {
    const w = instance.__speakerWin;
    if (!instance.__speakerCb || !w || w.closed) return;
    try { instance.__speakerCb(speakerState(instance, deckUrl())); } catch { /* a popup mid-close */ }
  };
  return deckUrl;
}

export function openSpeakerView(instance) {
  const FEATURES = 'width=1100,height=700';
  let win = window.open('', 'decklight-speaker', FEATURES);
  if (!win) return null;
  // Reloading the deck (e.g. an IDE's reload-on-save) orphans an open speaker
  // popup: the named-window lookup still finds it, but its realm is dead and
  // on file:// its inherited opaque origin no longer matches — document
  // access throws SecurityError and the old flow died mid-write, leaving the
  // popup blank or frozen. openSpeakerView only runs when no live popup is
  // tracked, so ANY discovered window with content is an orphan: close it
  // and take a fresh one.
  let orphaned = false;
  try { orphaned = win.document.body ? win.document.body.childNodes.length > 0 : false; }
  catch { orphaned = true; }
  if (orphaned) {
    try { win.close(); } catch { /* cross-origin close is allowed; be safe */ }
    win = window.open('', 'decklight-speaker', FEATURES);
    if (!win) return null;
    try { void win.document; } catch { return null; } // still blocked — give up cleanly
  }

  // Bridge lives on the opener. Install it BEFORE writing the popup —
  // document.write parsing runs the popup's script synchronously, so
  // assigning afterwards is a race the popup loses on http (it happened to
  // win on file://). The popup also polls as a second line of defense.
  installSpeakerBridge(instance);
  instance.__speakerWin = win;

  const ar = `${instance.config.width} / ${instance.config.height}`;
  const fontPx = storedFontSize(readPref(SPEAKER_FONT_KEY), 16);
  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Decklight — speaker view</title>
<style>
  body { margin:0; background:#111; color:#eee; font:14px/1.5 -apple-system, system-ui, sans-serif;
         display:grid; grid-template-columns: 1.4fr 1fr; grid-template-rows:auto auto 1fr auto; gap:10px; padding:10px; height:100vh; box-sizing:border-box; }
  header { grid-column:1/3; display:flex; gap:16px; align-items:center; }
  /* the phone-remote QR (#39): parked at the end of the header, out of the
     way, and click-to-enlarge because a 72px code is hard to scan across a
     lectern. Enlarging dims the room with a giant box-shadow rather than
     adding a backdrop element. */
  #qr { margin-left:auto; width:72px; height:72px; background:#fff; padding:3px;
        border-radius:6px; cursor:zoom-in; image-rendering:pixelated; }
  #qr.big { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            width:min(70vw,70vh); height:min(70vw,70vh); z-index:10; cursor:zoom-out;
            box-shadow:0 0 0 100vmax rgba(0,0,0,.8); }
  #timer { font-size:22px; font-variant-numeric:tabular-nums; }
  .pace { font-variant-numeric:tabular-nums; opacity:.8; }
  .pace.over { color:#e5484d; opacity:1; }
  #rec.on { background:#e5484d; color:#fff; }
  #pos { color:#999; }
  button { background:#333; color:#eee; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; }
  #lost { color:#ffb4b4; background:#4a1d1d; border-radius:6px; padding:3px 10px; font-size:12px; }
  #mode { margin-left:auto; text-transform:uppercase; font-size:11px; letter-spacing:.09em; }
  #mode.on { background:#5c4d00; color:#ffe38a; }
  /* rehearse mode: cue cards, not prose — one cue per line, same type size */
  body.rehearse aside { font-weight:600; }
  body.rehearse aside .seg { display:block; margin:.35em 0; }
  .thumbs { display:flex; flex-direction:column; gap:10px; min-height:0; align-items:start; }
  /* Panes keep the presentation's aspect ratio: width-driven, capped so a
     short window can't push the notes off screen. */
  .thumb { width:min(100%, calc(42vh * (${ar}))); aspect-ratio:${ar}; border:1px solid #333; border-radius:8px; overflow:hidden; position:relative; }
  .thumb .tag { position:absolute; top:6px; left:8px; z-index:2; background:#0009; padding:1px 8px; border-radius:4px; font-size:11px; }
  iframe { width:100%; height:100%; border:0; background:#000; }
  aside { grid-column:1/3; overflow:auto; background:#1b1b1b; border-radius:8px; padding:14px 16px; font-size:var(--notes-px, 16px); line-height:1.65; }
  /* A− / A+: the notes' type size, the rest of the view stays put */
  .size { display:inline-flex; }
  .size button { border-radius:0; padding:6px 10px; }
  .size button:first-child { border-radius:6px 0 0 6px; border-right:1px solid #222; }
  .size button:last-child { border-radius:0 6px 6px 0; }
  .size button:disabled { opacity:.4; cursor:default; }
  aside .seg { opacity:.45; }
  aside .seg.now { opacity:1; background:#2d2d00; outline:2px solid #665; border-radius:4px; }
  aside .seg.said { opacity:.8; }
  .cue { display:inline-block; background:#553; color:#ffc; font-size:max(11px, .65em); border-radius:4px; padding:0 6px; margin:0 4px; }
  .cue.tag { background:#354; color:#dfe; font-style:italic; }
  /* the script view (SPEC PRESENTING_CHROME, the transcript): the whole deck's
     notes in the notes pane, the slide on screen lit and kept in view */
  #script.on { background:#173a5c; color:#cfe6ff; }
  .sc-slide { margin:0 0 1.1em; opacity:.6; }
  .sc-slide.now { opacity:1; }
  .sc-title { font-weight:700; cursor:pointer; color:#9ecbff; margin-bottom:.2em; }
  .sc-slide.now .sc-title { color:#ffe38a; }
  .sc-title:hover { text-decoration:underline; }
  .sc-seg { margin:.25em 0; }
  footer { grid-column:1/3; color:#888; font-size:12px; display:flex; gap:14px; overflow:auto; white-space:nowrap; }
  footer .step.now { color:#ffc; }
</style></head><body>
<header>
  <span id="timer">00:00</span>
  <button id="resetTimer">reset</button>
  <span id="pos"></span>
  <button id="prev" title="previous build (←); ⇧← the previous slide">◀ prev</button>
  <button id="next" title="next build (→); ⇧→ the next slide">next ▶</button>
  <button id="mode" title="S or ⌥⏎ toggles rehearse mode (cue cards instead of prose)">speak</button>
  <span id="lost" hidden></span>
  <span class="size" role="group" aria-label="notes text size"><button id="smaller" title="smaller notes text (−)" aria-label="smaller notes text">A−</button><button id="bigger" title="bigger notes text (+)" aria-label="bigger notes text">A+</button></span>
  <button id="script" title="the whole deck's notes, the slide on screen lit; a slide's title goes there">script</button>
  <button id="rec" title="record how long each slide takes, then save the timings onto the deck">⏱ rehearse timings</button>
  <span id="pace" class="pace"></span>
  <img id="qr" alt="scan to use your phone as a remote" title="scan to use your phone as a remote — click to enlarge" hidden>
</header>
<div class="thumbs">
  <div class="thumb"><span class="tag">current</span><iframe id="cur"></iframe></div>
</div>
<div class="thumbs">
  <div class="thumb"><span class="tag">next</span><iframe id="nxt"></iframe></div>
</div>
<aside id="notes"></aside>
<footer id="steps"></footer>
<script>
  const opener = window.opener;
  let api = null;
  const $ = (s) => document.querySelector(s);
  const start = Date.now();
  let t0 = start;
  setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#timer').textContent = String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  }, 500);
  $('#resetTimer').onclick = () => { t0 = Date.now(); };
  // ── rehearsal timings: seconds per slide while recording, saved on stop ──
  const rec = { on: false, since: 0, cur: null, spent: [] };
  const fmt = (s) => String(Math.floor(s/60)).padStart(2,'0') + ':' + String(Math.floor(s%60)).padStart(2,'0');
  let plan = [];
  const tick = () => {
    if (!rec.on || rec.cur == null) return;
    const live = rec.spent.slice(); live[rec.cur - 1] = (live[rec.cur - 1] || 0) + (Date.now() - rec.since) / 1000;
    const planned = plan[rec.cur - 1] || 0;
    const total = live.reduce((a, b) => a + (b || 0), 0);
    const plannedTotal = plan.reduce((a, b) => a + (b || 0), 0);
    const spent = live[rec.cur - 1] || 0;
    const over = planned && spent - planned > 5;
    $('#pace').textContent = 'slide ' + rec.cur + ' · ' + fmt(spent) + (planned ? ' / ' + fmt(planned) : '')
      + (over ? ' · ' + fmt(spent - planned) + ' over' : '') + ' · total ' + fmt(total) + (plannedTotal ? ' / ' + fmt(plannedTotal) : '');
    $('#pace').classList.toggle('over', !!over);
  };
  setInterval(tick, 500);
  const arrive = (slide) => {
    if (!rec.on) return;
    if (rec.cur != null) rec.spent[rec.cur - 1] = (rec.spent[rec.cur - 1] || 0) + (Date.now() - rec.since) / 1000;
    rec.cur = slide; rec.since = Date.now();
  };
  // Start/stop from the button, or from the deck's palette via
  // window.__decklightSpeakerRec (like __decklightSpeakerToggle for ⌥⏎).
  // start === true only ever starts: a palette row that opened this window
  // to begin a rehearsal must not stop one already running.
  const toggleRec = async (start) => {
    if (!rec.on) {
      rec.on = true; rec.spent = []; rec.cur = null; if (lastSt) arrive(lastSt.slide);
      $('#rec').classList.add('on'); $('#rec').textContent = '⏹ stop & save timings';
      $('#pace').textContent = 'recording — ⏹ stop & save when the run is over';
      return;
    }
    if (start === true) return;
    arrive(null); rec.on = false;
    $('#rec').classList.remove('on'); $('#rec').textContent = '⏱ rehearse timings';
    try {
      const where = api ? await api.saveTimings(rec.spent) : 'nowhere';
      $('#pace').textContent = where === 'deck' ? 'timings saved onto the deck' : where === 'browser' ? 'timings kept in this browser (no edit server to write the deck)' : 'timings not saved';
      $('#pace').classList.remove('over');
    } catch (e) { $('#pace').textContent = 'could not save timings: ' + String(e.message || e); }
  };
  $('#rec').onclick = () => toggleRec();
  window.__decklightSpeakerRec = toggleRec;
  $('#prev').onclick = () => api && api.prev();
  $('#next').onclick = () => api && api.next();
  // speak = full prose notes; rehearse = the deck's aside.rehearse cue cards
  // (same ⟨CLICK⟩ segmentation, a few words per segment). S toggles — from
  // this window or remotely via window.__decklightSpeakerToggle (the deck's ⌥⏎).
  let mode = 'speak', lastSt = null;
  window.__decklightSpeakerToggle = () => {
    mode = mode === 'speak' ? 'rehearse' : 'speak';
    document.body.classList.toggle('rehearse', mode === 'rehearse');
    $('#mode').textContent = mode;
    $('#mode').classList.toggle('on', mode === 'rehearse');
    if (lastSt) render(lastSt);
  };
  $('#mode').onclick = window.__decklightSpeakerToggle;
  // the script view: the deck's whole transcript in the notes pane. On from
  // the button, or from the deck's palette (Transcript…) through
  // window.__decklightSpeakerScript(true), which only ever turns it on.
  let script = false;
  window.__decklightSpeakerScript = (on) => {
    script = on === true ? true : !script;
    $('#script').classList.toggle('on', script);
    if (lastSt) render(lastSt);
  };
  $('#script').onclick = () => window.__decklightSpeakerScript();
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function renderScript(st) {
    const data = (api && api.transcript ? api.transcript() : []).filter((d) => d.segs.length);
    $('#notes').innerHTML = data.map((d) => '<div class="sc-slide' + (d.n === st.slide ? ' now' : '') + '" data-n="' + d.n + '">'
      + '<div class="sc-title">' + d.n + ' · ' + esc(d.title) + '</div>'
      + d.segs.map((g) => '<p class="sc-seg">' + esc(g) + '</p>').join('') + '</div>').join('')
      || '<p>this deck has no speaker notes</p>';
    $('#notes').querySelectorAll('.sc-title').forEach((t) => {
      t.onclick = () => api && api.goto(Number(t.parentNode.dataset.n));
    });
    const now = $('#notes .sc-slide.now');
    if (now) now.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('#qr').onclick = () => $('#qr').classList.toggle('big');
  // the notes' type size: A− / A+, or − / + from the keyboard; remembered on
  // the deck's side (api.saveFontSize) so the next speaker view opens at it
  const FONT_SIZES = ${JSON.stringify(FONT_SIZES)};
  const stepFontSize = ${stepFontSize.toString()};
  let fontPx = ${fontPx};
  const applyFont = () => {
    document.body.style.setProperty('--notes-px', fontPx + 'px');
    $('#smaller').disabled = fontPx <= FONT_SIZES[0];
    $('#bigger').disabled = fontPx >= FONT_SIZES[FONT_SIZES.length - 1];
  };
  const resize = (dir) => {
    fontPx = stepFontSize(FONT_SIZES, fontPx, dir);
    applyFont();
    try { if (api && api.saveFontSize) api.saveFontSize(fontPx); } catch { /* a deck mid-reload: the size still holds here */ }
    const now = $('#notes .seg.now, #notes .sc-slide.now');
    if (now) now.scrollIntoView({ block: 'nearest' });
  };
  $('#smaller').onclick = () => resize(-1);
  $('#bigger').onclick = () => resize(1);
  applyFont();
  // The deck's keys, here too: a clicker types into this window at a lectern.
  // S here, or the same ⌥⏎ that opened this window: speak ⇄ rehearse.
  const speakerKeyAction = ${speakerKeyAction.toString()};
  document.addEventListener('keydown', (e) => {
    const act = speakerKeyAction(e);
    if (act === 'toggle') { window.__decklightSpeakerToggle(); e.preventDefault(); }
    else if (act === 'bigger' || act === 'smaller') { resize(act === 'bigger' ? 1 : -1); e.preventDefault(); }
    else if (act === 'deck' && api) {
      if (api.press) api.press({ key: e.key, shiftKey: e.shiftKey });
      // a deck from before the bridge took keys: the arrows it always had
      else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') (e.shiftKey && api.nextSlide ? api.nextSlide() : api.next());
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') (e.shiftKey && api.prevSlide ? api.prevSlide() : api.prev());
      e.preventDefault();
    }
  });
  let last = { slide: -1, step: -1, nextHash: '' };
  function render(st) {
    plan = st.timings || [];
    if (st.slide !== last.slide) arrive(st.slide);
    lastSt = st;
    $('#pos').textContent = 'slide ' + st.slide + ' / ' + st.totalSlides + ' · step ' + st.step + ' / ' + st.totalSteps;
    // CURRENT is what the audience sees: the slide at the step the deck is on,
    // not the slide fully built. Only the fragment changes, so the pane steps
    // through its builds in place instead of reloading.
    // A new url is the deck changed in place: both panes load it again.
    if (st.slide !== last.slide || st.step !== last.step || st.url !== last.url) $('#cur').src = st.url + '#/' + st.slide + '/' + st.step;
    if (st.nextHash !== last.nextHash || st.url !== last.url) $('#nxt').src = st.url + '#' + st.nextHash;
    last = { slide: st.slide, step: st.step, nextHash: st.nextHash, url: st.url };
    if (script) { renderScript(st); } else {
    const segs = (mode === 'rehearse' && st.rehearseSegments) ? st.rehearseSegments : st.notesSegments;
    // Splitting on ⟨CLICK⟩ can cut through a paragraph, leaving fragments
    // with dangling open tags that would swallow the following segments —
    // re-serialize each fragment so every segment is balanced markup.
    const bal = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.innerHTML; };
    $('#notes').innerHTML = segs.map((s, i) => {
      const cls = i < st.step ? 'said' : i === st.step ? 'now' : '';
      return '<span class="seg ' + cls + '">' + bal(s) + '</span>' + (i < segs.length - 1 ? '<span class="cue">CLICK</span>' : '');
    }).join('');
    // Keep the live segment on screen as builds land: rehearse mode centers
    // the current cue; prose just scrolls when the segment would otherwise
    // be out of view.
    const now = $('#notes .seg.now');
    if (now) now.scrollIntoView({ block: mode === 'rehearse' ? 'center' : 'nearest', behavior: 'smooth' });
    }
    // Only set src once: reassigning it every render would refetch the QR on
    // every build step, and a flickering code is one nobody can scan.
    const qr = $('#qr');
    if (st.qr) {
      if (qr.getAttribute('src') !== st.qr) qr.setAttribute('src', st.qr);
      qr.hidden = false;
    } else {
      qr.hidden = true;
      qr.classList.remove('big');
    }
    $('#steps').innerHTML = st.labels.map((l, i) =>
      '<span class="step ' + (i === st.step - 1 ? 'now' : '') + '">' + (i + 1) + '. ' + l + '</span>').join('');
  }
  // The opener assigns the bridge around the same moment this script runs
  // (document.write parsing is synchronous) — poll briefly instead of
  // deciding on a single racy read.
  // A lost deck is SAID, in the header, never shown as the slide it was on.
  const lost = (why) => { $('#lost').textContent = why; $('#lost').hidden = false; };
  const found = () => { $('#lost').hidden = true; };
  function connect(tries) {
    api = opener && !opener.closed && opener.__decklightBridge;
    if (api) { api.subscribe(render, window); render(api.getState()); return; }
    if (tries > 0) return setTimeout(() => connect(tries - 1), 100);
    lost('not connected to the deck window');
  }
  connect(30);
  // The deck reloaded (write mode reloads it whenever the file changes): its
  // new page installs a new bridge, and this window picks it up and goes on,
  // rather than staying on the slide it last heard about. On file://, a
  // reloaded deck is out of reach for good, and that is said instead.
  setInterval(() => {
    let b = null;
    try {
      if (!opener || opener.closed) { lost('the deck window was closed'); return; }
      b = opener.__decklightBridge;
    } catch { lost('the deck reloaded and this window cannot reach it: press S in the deck for a fresh one'); return; }
    if (!b) { lost('the deck is reloading…'); return; }
    if (b !== api) {
      api = b;
      try { api.subscribe(render, window); render(api.getState()); found(); } catch { lost('could not reconnect to the deck'); }
    } else found();
  }, 1000);
</script>
</body></html>`);
  win.document.close();

  return win;
}

export function speakerState(instance, url) {
  const { slide, step, totalSlides } = instance.state;
  const rec = instance._records[slide - 1];
  const totalSteps = rec ? rec.groups.length : 0;
  const nextHash = step < totalSteps ? `/${slide}/${step + 1}`
    : slide < totalSlides ? `/${slide + 1}/0` : `/${slide}/${step}`;
  const notesEl = instance._sections[slide - 1]?.querySelector('aside.notes');
  const rehearseEl = instance._sections[slide - 1]?.querySelector('aside.rehearse');
  return {
    slide, step, totalSlides, totalSteps, url,
    nextHash,
    notesSegments: notesSegments(notesEl ? notesEl.innerHTML : ''),
    rehearseSegments: rehearseEl ? notesSegments(rehearseEl.innerHTML) : null,
    labels: instance._stepLabels(slide - 1),
    // planned seconds per slide (REHEARSAL_TIMINGS): the deck's, else this browser's
    timings: plannedTimings(instance._sections, readJson(timingsKey())),
    // The phone-remote QR, or null when the remote is off (#39) — editmode's
    // no-trust wiring sets it from /deck/ping (NO_TRUST#REMOTE); the edit
    // server serves no /deck/remote/* at all, so a deck in write mode never offers one.
    qr: instance.__remoteQr ?? null,
  };
}
