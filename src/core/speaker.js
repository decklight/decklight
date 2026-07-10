// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Speaker view — SPEC §8. Opened with S; a popup written into about:blank
// (inherits the opener's origin, so the direct window.opener bridge works on
// file:// too — no server needed). Thumbnails are iframes of the same deck
// in ?embedded mode, driven by src hash.

const CLICK_MARK = /⟨CLICK⟩|&lt;CLICK&gt;|<click(?:\s[^>]*)?>(?:<\/click>)?/gi;

export function notesSegments(notesHtml) {
  return (notesHtml || '').split(CLICK_MARK);
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

  const deckUrl = () => {
    const u = new URL(location.href);
    u.searchParams.set('embedded', '');
    u.hash = '';
    return u.href;
  };

  // Bridge lives on the opener. Install it BEFORE writing the popup —
  // document.write parsing runs the popup's script synchronously, so
  // assigning afterwards is a race the popup loses on http (it happened to
  // win on file://). The popup also polls as a second line of defense.
  window.__decklightBridge = {
    subscribe(cb) { instance.__speakerCb = cb; },
    getState: () => speakerState(instance, deckUrl()),
    next: () => instance.next(),
    prev: () => instance.prev(),
  };
  instance.__notifySpeaker = () => {
    if (instance.__speakerCb && !win.closed) instance.__speakerCb(speakerState(instance, deckUrl()));
  };

  const ar = `${instance.config.width} / ${instance.config.height}`;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Decklight — speaker view</title>
<style>
  body { margin:0; background:#111; color:#eee; font:14px/1.5 -apple-system, system-ui, sans-serif;
         display:grid; grid-template-columns: 1.4fr 1fr; grid-template-rows:auto auto 1fr auto; gap:10px; padding:10px; height:100vh; box-sizing:border-box; }
  header { grid-column:1/3; display:flex; gap:16px; align-items:center; }
  #timer { font-size:22px; font-variant-numeric:tabular-nums; }
  #pos { color:#999; }
  button { background:#333; color:#eee; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; }
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
  aside { grid-column:1/3; overflow:auto; background:#1b1b1b; border-radius:8px; padding:14px 16px; font-size:16px; line-height:1.65; }
  aside .seg { opacity:.45; }
  aside .seg.now { opacity:1; background:#2d2d00; outline:2px solid #665; border-radius:4px; }
  aside .seg.said { opacity:.8; }
  .cue { display:inline-block; background:#553; color:#ffc; font-size:11px; border-radius:4px; padding:0 6px; margin:0 4px; }
  footer { grid-column:1/3; color:#888; font-size:12px; display:flex; gap:14px; overflow:auto; white-space:nowrap; }
  footer .step.now { color:#ffc; }
</style></head><body>
<header>
  <span id="timer">00:00</span>
  <button id="resetTimer">reset</button>
  <span id="pos"></span>
  <button id="prev">◀ prev</button>
  <button id="next">next ▶</button>
  <button id="mode" title="S toggles rehearse mode (cue cards instead of prose)">speak</button>
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
  $('#prev').onclick = () => api && api.prev();
  $('#next').onclick = () => api && api.next();
  // speak = full prose notes; rehearse = the deck's aside.rehearse cue cards
  // (same ⟨CLICK⟩ segmentation, a few words per segment). S toggles — from
  // this window or remotely via window.__decklightSpeakerToggle (deck's S).
  let mode = 'speak', lastSt = null;
  window.__decklightSpeakerToggle = () => {
    mode = mode === 'speak' ? 'rehearse' : 'speak';
    document.body.classList.toggle('rehearse', mode === 'rehearse');
    $('#mode').textContent = mode;
    $('#mode').classList.toggle('on', mode === 'rehearse');
    if (lastSt) render(lastSt);
  };
  $('#mode').onclick = window.__decklightSpeakerToggle;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') api && api.next();
    if (e.key === 'ArrowLeft') api && api.prev();
    if (e.key === 's' || e.key === 'S') window.__decklightSpeakerToggle();
  });
  let last = { slide: -1, nextHash: '' };
  function render(st) {
    lastSt = st;
    $('#pos').textContent = 'slide ' + st.slide + ' / ' + st.totalSlides + ' · step ' + st.step + ' / ' + st.totalSteps;
    if (st.slide !== last.slide) $('#cur').src = st.url + '#/' + st.slide + '/999';
    if (st.nextHash !== last.nextHash) $('#nxt').src = st.url + '#' + st.nextHash;
    last = { slide: st.slide, nextHash: st.nextHash };
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
    $('#steps').innerHTML = st.labels.map((l, i) =>
      '<span class="step ' + (i === st.step - 1 ? 'now' : '') + '">' + (i + 1) + '. ' + l + '</span>').join('');
  }
  // The opener assigns the bridge around the same moment this script runs
  // (document.write parsing is synchronous) — poll briefly instead of
  // deciding on a single racy read.
  function connect(tries) {
    api = opener && !opener.closed && opener.__decklightBridge;
    if (api) { api.subscribe(render); render(api.getState()); return; }
    if (tries > 0) return setTimeout(() => connect(tries - 1), 100);
    document.body.innerHTML = '<p style="padding:2em">Lost connection to the deck window.</p>';
  }
  connect(30);
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
  };
}
