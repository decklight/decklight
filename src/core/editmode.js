// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Everything the deck can only do while `decklight author`'s edit server is serving
// it: live reload, the notes editor, asking an installed agent for an edit,
// undo/redo over the server's history, and the R dialog that puts the deck back
// to any commit.
//
// One module because they are one capability. All of it hangs off a single
// probe — /edit/ping, answered once at startup — and everything here either
// posts to that server or refuses with the same "you are not in author mode"
// message. Nothing else in the engine needs to know the server exists; layout
// cycling, the one other thing that saves through it, asks available()/base().
//
// The phone remote is NOT here (PRESENT#REMOTE). It hangs off a second, smaller
// probe — wirePresentRemote, below — because it belongs to a server with no
// edit surface at all, and a clicker should never have cost you one.

import { closeOnBackdrop, selectInList } from './overlay.js';
import { agentChipText, needsDevMode, pushToastText, shortAge } from './devmode.js';
import { dedentHtml } from './htmlfmt.js';
import { hljs } from '../code/code.js';

/**
 * Wire the dev-server features to a deck.
 *
 * `dismissOthers` is the engine's "an overlay is opening" callback: the R
 * dialog shares the stage with the theme picker, the slide finder and the
 * palette, and the engine owns two of those three.
 */
export function createEditMode({
  root, config, params, printMode, toast, debugLog, overlays, instance,
  notesSegs, dismissOthers,
}) {
  // ── edit mode (E) + live reload — SPEC PRESENTING ────────────────────────────────
  // Served by the edit server: the deck subscribes to /edit/events and
  // reloads whenever the file changes on disk (any editor works — the
  // #/slide/step hash restores the position). E opens a notes editor whose
  // Save writes the current slide's aside back through the server. Decks
  // opened via file:// probe the server at its default localhost port — the
  // printed URL and a double-clicked file both work; config.edit.url overrides.
  // A basename guard refuses to wire up against a server that's editing a
  // DIFFERENT deck. Nothing here sends a token: the server authorizes on the
  // request's Origin, which the browser stamps for us — a served deck's is its
  // own loopback origin, a file:// deck's is `null`, and both are admitted
  // while a foreign tab's fetch is refused server-side (#222, cli/serve.mjs).
  let editAvailable = false;
  let editBase = '';
  let editAgents = [];   // [{name, label, installed}] the dev machine can run
  let preferredAgent = null; // the one A reaches for, remembered server-side (#125)
  let editWizards = [];  // [{name, qualified, title}] engines a marketplace declares a wizard for
  let agentBusy = null;  // {agent, prompt, startedAt} while a one-shot runs
  let pushToastShown = false;  // at most one push nudge per session, by construction

  // The chip that says an agent is STILL working. A toast cannot: it expires,
  // and the job does not. This lives as long as the run does, and ticks, so the
  // difference between "thinking" and "wedged" is visible without pressing A to
  // ask. Built lazily and removed outright — a deck that never asks an agent
  // never grows the node, and `present` never reaches this code at all.
  let agentChip = null;
  let agentTick = 0;
  function paintAgentChip() {
    const text = agentChipText(agentBusy);
    if (!text) {
      clearInterval(agentTick);
      agentTick = 0;
      agentChip?.remove();
      agentChip = null;
      return;
    }
    if (!agentChip) {
      agentChip = document.createElement('div');
      agentChip.className = 'decklight-agent-chip';
      // A live region, so a screen reader is told an agent started working
      // without having to be watching the corner. Polite: it is status, and it
      // must not interrupt what is being read.
      agentChip.setAttribute('role', 'status');
      agentChip.setAttribute('aria-live', 'polite');
      root.appendChild(agentChip);
    }
    // textContent, never innerHTML: `agent` is a name from the server and
    // `prompt` is the user's own words, and neither is markup.
    agentChip.textContent = `🤖 ${text}`;
    agentChip.title = agentBusy.prompt ? `asked: ${agentBusy.prompt}` : '';
    if (!agentTick) agentTick = setInterval(paintAgentChip, 1000);
  }
  // Resolves when the probe has finished asking — WIRED UP OR NOT. `available()`
  // is false for both "no server" and "have not asked yet", and a caller that
  // cannot tell those apart makes the wrong choice for the wrong reason: the
  // recorder read it 700ms after load and sent a whole take to the download
  // folder because the answer had not arrived, not because there was no server.
  let probeSettled;
  const settled = new Promise((r) => { probeSettled = r; });
  if (!printMode && !params.has('embedded')) {
    const bases = config.edit?.url ? [config.edit.url]
      : /^https?:$/.test(location.protocol) ? [''] : ['http://127.0.0.1:8788'];
    (async () => {
      for (const base of bases) {
        try {
          const r = await fetch(base + '/edit/ping');
          if (!r.ok) continue;
          const j = await r.json();
          if (!j?.ok) continue;
          const here = decodeURIComponent(location.pathname.split('/').pop() || '');
          if (here && j.name && here !== j.name) {
            debugLog('edit', `server edits ${j.name}, this deck is ${here} — not wiring up`);
            continue;
          }
          editBase = base;
          editAvailable = true;
          editAgents = Array.isArray(j.agents) ? j.agents : [];
          preferredAgent = typeof j.preferredAgent === 'string' ? j.preferredAgent : null;
          editWizards = Array.isArray(j.wizards) ? j.wizards : [];
          // No QR and no clicker on this path: the author server binds
          // 127.0.0.1 and serves no /remote/* at all (PRESENT#REMOTE). A deck
          // being AUTHORED has a keyboard in front of it; a deck being
          // PRESENTED is what wirePresentRemote wires up.
          // Said once per session, and only when there is enough of it to be
          // worth interrupting for. A session that STARTS forty commits behind
          // hears it immediately rather than waiting for the next commit.
          const pushMsg = pushToastText(j.remote);
          if (pushMsg) { pushToastShown = true; toast(pushMsg, 4200); }
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          // The chip is restored too, with the SERVER's startedAt — a reload
          // mid-run is exactly when "is it still going?" is hardest to answer.
          paintAgentChip();
          const es = new EventSource(base + '/edit/events');
          es.onmessage = () => location.reload();
          es.addEventListener('agent', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.state === 'activity') {
                if (agentBusy) { agentBusy.activity = d.text; paintAgentChip(); }
                debugLog('agent', `activity: ${d.text}`);
              } else if (d.state === 'start') {
                agentBusy = d;
                paintAgentChip();
                toast(`🤖 ${d.agent} is editing the deck…`, 2200);
                debugLog('agent', `${d.agent} start: ${(d.prompt || '').slice(0, 80)}`);
              } else if (d.state === 'done') {
                agentBusy = null;
                paintAgentChip();
                const status = d.ok ? '' : d.error ? ` — ${d.error}` : ` (exit ${d.code})`;
                toast(d.changed ? `🤖 ${d.agent} edited the deck — Z undoes${status}`
                  : `🤖 ${d.agent} finished — no changes${status}`, 3000);
                debugLog('agent', `${d.agent} done ok=${d.ok} changed=${d.changed}${status}`);
              }
            } catch { /* malformed event */ }
          });
          debugLog('edit', `live reload connected${base ? ` (${base})` : ''}`
            + (editAgents.length ? ` · agents: ${editAgents.map((a) => a.name).join(', ')}` : ''));
          probeSettled();
          return;
        } catch { /* not served by the edit server */ }
      }
      probeSettled();   // asked everything, wired up nothing
      // Not authored, but possibly PRESENTED (PRESENT#REMOTE): `decklight
      // present --remote` hosts the phone remote with no edit surface at all, so
      // the deck wires up the clicker and the position readout and NOTHING else.
      // `editAvailable` stays false on purpose — every affordance gated on it (E,
      // A, Z, layout picks) must still say it needs author mode, because it does.
      await wirePresentRemote();
    })();
  }

  /**
   * The presenting control channel: `remote` events in, position echoes out.
   *
   * Deliberately a separate, smaller function rather than a flag threaded
   * through the edit path above. The two servers differ in what they are
   * ALLOWED to do, and a shared code path with a boolean in it is how a
   * presenting server quietly acquires an editing capability later.
   */
  // ── the deck update overlay (H, present mode) — SPEC PRESENT#UPSTREAM ─────
  //
  // The author's H is the deck's own history. A PRESENTED deck has no history
  // to show — there is no edit server and no /edit/at to preview a commit with
  // — so the same key answers the question that IS live there: has the person
  // who wrote this pushed anything since I cloned it?
  //
  // It never draws on the slides. present.mjs is right that the audience cannot
  // act on any of this, and this is an overlay somebody opened, not a banner.
  // `''` is a REAL value here — it is the base for a deck served over http,
  // where every fetch is same-origin — so a separate flag says whether we are
  // presenting. `!presentBase` would read the empty string as "not wired" and
  // send H down the author path on exactly the decks this exists for.
  let presentBase = null;
  let presenting = false;
  let upEl = null;

  function closeUpstream() { upEl?.remove(); upEl = null; }

  function upstreamRow(text, cls) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;   // a commit subject is somebody else's text
    return d;
  }

  async function renderUpstream(status) {
    const list = upEl?.querySelector('.tp-list');
    if (!list) return;
    list.textContent = '';
    list.appendChild(upstreamRow(status.message ?? status.state, 'hs-remote'));
    for (const c of status.commits ?? []) {
      list.appendChild(upstreamRow(`${c.hash}  ${c.subject}`, 'tp-row'));
    }
    const actions = upEl.querySelector('.up-actions');
    actions.textContent = '';
    const button = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'narr-prev-btn';
      b.textContent = label;
      b.addEventListener('click', run);
      actions.appendChild(b);
      return b;
    };
    button('check now', async () => {
      actions.textContent = 'checking…';
      await renderUpstream(await postUpstream('/present/upstream/check'));
    });
    if (status.state === 'behind' && status.pull?.offered) {
      button('update the deck', async () => {
        actions.textContent = 'pulling…';
        const out = await postUpstream('/present/upstream/pull');
        if (out.reload) return location.reload();
        // A pull that DEGRADED the label does not reload itself: swapping the
        // bytes executes nothing, so the choice to show them can wait for a
        // second, informed click.
        await renderUpstream({ ...out, commits: [], message: out.message });
        if (out.state === 'pulled') button('show it anyway', () => location.reload());
      });
    } else if (status.pull && !status.pull.offered && status.state === 'behind') {
      actions.appendChild(upstreamRow(`update control off — ${status.pull.reason}`, 'hs-remote'));
    }
  }

  async function postUpstream(path) {
    try {
      const r = await fetch(presentBase + path, { method: 'POST' });
      return await r.json();
    } catch { return { state: 'error', message: 'the presenting server did not answer' }; }
  }

  async function openUpstream() {
    if (upEl) return closeUpstream();
    let status;
    try {
      const r = await fetch(presentBase + '/present/upstream');
      if (!r.ok) return toast('this deck is not a tracked file in a git clone — nothing to update from', 3400);
      status = await r.json();
    } catch { return toast('deck update: the presenting server did not answer', 3000); }
    dismissOthers();
    upEl = document.createElement('div');
    upEl.className = 'decklight-theme-picker decklight-finder decklight-restore decklight-history';
    upEl.innerHTML =
      '<div class="tp-panel"><div class="tp-side">'
      + '<div class="tp-filter">Deck update — Esc closes</div>'
      + '<div class="tp-list" role="listbox" aria-label="Upstream commits"></div>'
      + '<div class="up-actions tr-actions"></div></div></div>';
    closeOnBackdrop(upEl, closeUpstream);
    root.appendChild(upEl);
    await renderUpstream(status);
  }

  overlays.register({
    isOpen: () => !!upEl,
    close: closeUpstream,
    keydown: (e) => e.key === 'Escape' && (closeUpstream(), true),
  });

  async function wirePresentRemote() {
    const base = /^https?:$/.test(location.protocol) ? '' : 'http://127.0.0.1:8790';
    try {
      const r = await fetch(base + '/present/ping');
      if (!r.ok) return;
      const j = await r.json();
      if (!j?.ok || !j.present) return;
      const here = decodeURIComponent(location.pathname.split('/').pop() || '');
      if (here && j.name && here !== j.name) {
        debugLog('present', `server presents ${j.name}, this deck is ${here} — not wiring up`);
        return;
      }
      instance.__remoteQr = j.remote ? `${base || location.origin}/remote/qr.svg` : null;
      // H in present mode. The routes only exist when the deck is a tracked
      // file in a clone with an upstream, so this base is enough to tell: a
      // deck that is not one gets a 404/405 and H says so, rather than the
      // overlay existing and being permanently empty.
      presentBase = base;
      presenting = true;
      const es = new EventSource(base + '/present/events');
      es.addEventListener('remote', (ev) => {
        try {
          const { key } = JSON.parse(ev.data);
          if (key === 'next') instance.next();
          else if (key === 'prev') instance.prev();
        } catch { /* malformed event */ }
      });
      // No `onmessage` handler: the unnamed `reload` message is the edit
      // server's, and a presenting server has no file watcher to send one.
      const postPos = () => {
        fetch(base + '/remote/pos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ i: instance.state.slide, n: instance.state.totalSlides }),
        }).catch(() => {});
      };
      instance.on('slide', postPos);
      instance.on('build', postPos);
      postPos();
      debugLog('present', `remote connected${base ? ` (${base})` : ''} — no edit surface`);
    } catch { /* not served by present either */ }
  }

  // undo/redo (Z / ⇧Z) — the dev server's edit history: layout picks, notes
  // saves, and agent runs all snapshot into ONE stack, wholly independent of
  // the git autocommits. The server writes the restored file; its watcher
  // then reloads every browser (the hash keeps the position).
  async function deckHistory(dir) {
    if (!editAvailable) {
      toast(needsDevMode(dir, location), 3200);
      return;
    }
    try {
      const res = await fetch(editBase + '/edit/' + dir, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || `${dir} failed`); return; }
      toast(`${dir} — ${j.undo} back · ${j.redo} forward`);
      debugLog('edit', `${dir} → ${j.undo} back, ${j.redo} forward`);
    } catch {
      toast(`${dir} failed — is the dev server still up?`, 2200);
    }
  }

  // ask an agent (A) — hand an installed coding agent (claude, codex, bob, …)
  // a one-shot editing task; the file watcher reloads the deck when it saves,
  // and the server snapshots first so Z takes the agent's edit back.
  let agentEl = null;
  function toggleAgentAsk() {
    if (agentEl) { agentEl.remove(); agentEl = null; return; }
    if (!editAvailable) {
      toast(needsDevMode('asking an agent', location), 3200);
      return;
    }
    if (!editAgents.length) {
      toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600);
      return;
    }
    if (agentBusy) {
      toast(`${agentBusy.agent} is still working on the last ask`, 2200);
      return;
    }
    agentEl = document.createElement('div');
    agentEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `ask an agent — edits the deck file · ⌘⏎ sends · Esc closes`;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    ta.placeholder = `e.g. "make slide ${instance.state.slide} a split layout with the diagram on the left"`;
    ta.spellcheck = false;
    // Opens on the remembered agent, not on whichever was detected first —
    // the point of remembering one (#125). A preference naming an agent this
    // machine no longer has is ignored rather than offered.
    let pickedAgent = (preferredAgent && editAgents.some((a) => a.name === preferredAgent))
      ? preferredAgent
      : editAgents[0].name;
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    if (editAgents.length > 1) {
      const sel = document.createElement('select');
      sel.className = 'narr-prev-btn';
      for (const a of editAgents) {
        const o = document.createElement('option');
        o.value = a.name;
        o.textContent = a.label;
        sel.appendChild(o);
      }
      sel.value = pickedAgent;
      // Changing the agent REMEMBERS it: the next session's A opens here too.
      // Fire-and-forget — a preference that failed to save must not block the
      // ask the presenter actually came to make.
      sel.addEventListener('change', () => {
        pickedAgent = sel.value;
        preferredAgent = sel.value;
        fetch(editBase + '/edit/agent/prefer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: sel.value }),
        }).catch(() => {});
        debugLog('agent', `preferred agent → ${sel.value}`);
      });
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      actions.appendChild(sel);
    }
    const send = async () => {
      const prompt = ta.value.trim();
      if (!prompt) return;
      try {
        const res = await fetch(editBase + '/edit/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, agent: pickedAgent }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || res.status);
        toggleAgentAsk();
        // progress lands as SSE 'agent' events → toasts; the reload follows the save
      } catch (e) {
        toast(`ask failed: ${String(e.message || e).slice(0, 60)}`, 2200);
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { send(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleAgentAsk(); e.preventDefault(); }
      e.stopPropagation();
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '🤖 send to agent';
    btn.addEventListener('click', send);
    actions.appendChild(btn);
    card.append(head, ta, actions);
    agentEl.appendChild(card);
    closeOnBackdrop(agentEl, toggleAgentAsk);
    root.appendChild(agentEl);
    setTimeout(() => ta.focus(), 0);
  }
  let editEl = null;
  function toggleEditor() {
    if (editEl) { editEl.remove(); editEl = null; return; }
    const sl = instance.state.slide;
    if (!editAvailable) {
      toast(needsDevMode('editing notes', location), 3200);
      return;
    }
    editEl = document.createElement('div');
    editEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `edit notes — slide ${sl} · ⌘⏎ saves · Esc closes`;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    ta.value = notesSegs(sl).filter((s, i, a) => s || i < a.length).join('\n\n⟨CLICK⟩\n\n');
    ta.spellcheck = false;
    const save = async () => {
      try {
        const res = await fetch(editBase + '/edit/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide: sl, text: ta.value }),
        });
        if (!res.ok) throw new Error(await res.text());
        debugLog('edit', `notes saved — slide ${sl}`);
        toast('notes saved — reloading');
        // the server's watcher broadcasts the reload; nothing else to do
      } catch (e) {
        toast(`save failed: ${String(e.message || e).slice(0, 60)}`);
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { save(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleEditor(); e.preventDefault(); }
      e.stopPropagation();
    });
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '💾 save to file';
    btn.addEventListener('click', save);
    actions.appendChild(btn);
    card.append(head, ta, actions);
    editEl.appendChild(card);
    closeOnBackdrop(editEl, toggleEditor);
    root.appendChild(editEl);
    setTimeout(() => ta.focus(), 0);
  }

  // ── element edit mode (E) + its right-click menu — SPEC PRESENTING, #112 ──
  // E only ARMS the mode; the actual editing surface is right-clicking the
  // current slide. A specific element gets the full menu (notes / remove /
  // edit content / add a text effect); the bare slide background gets only
  // "Edit speaker notes" — which is why E no longer opens it directly, that
  // moved to the background row. The notes ROW reuses toggleEditor() itself
  // rather than a second copy of it.
  //
  // The first CURSOR-ANCHORED overlay in the engine: every other one — theme
  // picker, palette, notes editor — is a centered, dimmed backdrop card. This
  // one gets a transparent backdrop (dimming would hide the very slide the
  // menu is about) and a card positioned at the click, not centered — see
  // .decklight-ctxmenu in decklight.css. closeOnBackdrop/selectInList still
  // apply unchanged: nothing about them assumes a dimmed, centered overlay.
  const TEXT_EFFECTS = ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight'];
  let elementEditOn = false;
  let menuEl = null, menuRows = [], menuSel = 0, menuView = 'main', menuTarget = null;

  function toggleElementEdit() {
    if (!editAvailable) {
      toast(needsDevMode('editing an element', location), 3200);
      return;
    }
    elementEditOn = !elementEditOn;
    closeElementMenu();
    toast(elementEditOn ? 'element edit mode on — right-click a slide element' : 'element edit mode off', 2200);
  }

  /** The direct child of `sec` that contains `target`, or null for the bare background (target IS sec). */
  function topLevelChild(sec, target) {
    let el = target;
    while (el && el !== sec && el.parentElement !== sec) el = el.parentElement;
    return el && el !== sec ? el : null;
  }

  root.addEventListener('contextmenu', (e) => {
    if (!elementEditOn) return;
    const sec = e.target.closest('section');
    const slide = sec ? instance._sections.indexOf(sec) + 1 : 0;
    if (!sec || !slide) return; // not a real slide section — leave the OS menu alone
    e.preventDefault();
    // No per-element source mapping exists for a markdown-authored slide (its
    // content lived in a <script type="text/template"> the browser never
    // parsed) — same reason a removed-markdown slide has nothing for the
    // notes editor to key off either.
    if (sec.hasAttribute('data-markdown-removed')) {
      toast('this slide has no per-element source mapping (data-markdown, removed in 0.3.0) — edit the file directly', 3400);
      return;
    }
    const child = topLevelChild(sec, e.target);
    const index = child ? [...sec.children].indexOf(child) : null;
    dismissOthers?.();
    openElementMenu(e.clientX, e.clientY, { sec, slide, index });
  });

  function closeElementMenu() {
    menuEl?.remove();
    menuEl = null;
    menuView = 'main';
  }

  function renderElementMenu() {
    const list = menuEl.querySelector('.cm-list');
    list.textContent = '';
    const rows = [];
    if (menuView === 'effects') {
      rows.push({ label: '← back', back: true, run: () => { menuView = 'main'; renderElementMenu(); } });
      for (const fx of TEXT_EFFECTS) rows.push({ label: fx, run: () => commitEffect(fx) });
      // 'none' is a real, explicit build step (still one more advance reveals
      // the element) — distinct from "remove effect", which strips data-build.
      rows.push({ label: 'none (instant)', run: () => commitEffect('none') });
      rows.push({ label: 'remove effect', run: () => commitEffect(null) });
    } else if (menuTarget.index === null) {
      rows.push({ label: 'Edit speaker notes', run: () => { closeElementMenu(); toggleEditor(); } });
    } else {
      rows.push({ label: 'Edit speaker notes', run: () => { closeElementMenu(); toggleEditor(); } });
      rows.push({ label: 'Remove element', run: commitRemove });
      rows.push({ label: 'Edit content (HTML)', run: () => { closeElementMenu(); openElementContentEditor(menuTarget); } });
      rows.push({ label: 'Add text effect ▸', run: () => { menuView = 'effects'; renderElementMenu(); } });
    }
    menuRows = rows;
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'cm-row' + (r.back ? ' cm-back' : '');
      row.setAttribute('role', 'option');
      row.textContent = r.label;
      row.addEventListener('mouseenter', () => selectElementRow(i, false));
      row.addEventListener('click', r.run);
      list.appendChild(row);
    });
    selectElementRow(0, false);
  }

  function selectElementRow(i, scroll) {
    const rows = menuEl.querySelectorAll('.cm-row');
    if (!rows.length) return;
    menuSel = selectInList(rows, i, 'cm-selected', { scroll });
  }

  function openElementMenu(x, y, target) {
    menuTarget = target;
    menuView = 'main';
    menuEl = document.createElement('div');
    menuEl.className = 'decklight-ctxmenu';
    const card = document.createElement('div');
    card.className = 'cm-card';
    const list = document.createElement('div');
    list.className = 'cm-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Element edit menu');
    card.appendChild(list);
    menuEl.appendChild(card);
    root.appendChild(menuEl);
    renderElementMenu();
    // Anchored at the click, but never pushed off the deck's own box — a menu
    // that opens partway off-screen is not "cursor-anchored", it is broken.
    const rect = root.getBoundingClientRect();
    const left = Math.min(x - rect.left, rect.width - card.offsetWidth - 4);
    const top = Math.min(y - rect.top, rect.height - card.offsetHeight - 4);
    card.style.left = Math.max(4, left) + 'px';
    card.style.top = Math.max(4, top) + 'px';
    closeOnBackdrop(menuEl, closeElementMenu);
  }

  async function commitRemove() {
    const { slide, index } = menuTarget;
    closeElementMenu();
    try {
      const res = await fetch(editBase + '/edit/element/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slide, index }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.status);
      toast(j.changed ? 'element removed — reloading' : 'nothing to remove');
    } catch (e) {
      toast(`remove failed: ${String(e.message || e).slice(0, 60)}`, 2200);
    }
  }

  async function commitEffect(effect) {
    const { slide, index } = menuTarget;
    closeElementMenu();
    try {
      const res = await fetch(editBase + '/edit/element/effect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slide, index, effect }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.status);
      toast(effect === null ? 'effect removed — reloading' : `effect: ${effect} — reloading`);
    } catch (e) {
      toast(`effect save failed: ${String(e.message || e).slice(0, 60)}`, 2200);
    }
  }

  // "Edit content (HTML)" — the element's raw outerHTML, read fresh from the
  // FILE (never the live DOM: the engine mutates elements in place, so what
  // the player sees is not what a Save should write back over).
  let contentEl = null;
  function closeContentEditor() { contentEl?.remove(); contentEl = null; }
  function openElementContentEditor({ slide, index }) {
    contentEl = document.createElement('div');
    contentEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `edit content — slide ${slide}, element ${index} · ⌘⏎ saves · Esc closes`;
    // A textarea cannot render markup, so the highlighting is a <pre> BEHIND a
    // textarea whose own text is transparent — the standard shape, and the only
    // one that keeps a real caret, real selection, real undo and real IME.
    // The two must agree on font, size, line-height, padding, wrapping and
    // tab-size or the layers drift apart mid-line; `.edit-code pre` and
    // `.edit-code textarea` inherit all of it from the same rule for exactly
    // that reason.
    const wrap = document.createElement('div');
    wrap.className = 'edit-code';
    const pre = document.createElement('pre');
    pre.setAttribute('aria-hidden', 'true');   // the textarea is the real control
    const code = document.createElement('code');
    code.className = 'hljs language-xml';
    pre.appendChild(code);
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    ta.value = 'loading…';
    ta.disabled = true;
    ta.spellcheck = false;
    wrap.append(pre, ta);

    // The highlighter is the one already bundled for code slides (13 languages,
    // xml aliased to html) — so this costs no bytes. A trailing newline gets a
    // space so the last line still paints; without it the layers disagree by
    // one line at the bottom of the box.
    const repaint = () => {
      code.innerHTML = hljs.highlight(`${ta.value}\n`, { language: 'xml' }).value;
    };
    ta.addEventListener('input', repaint);
    ta.addEventListener('scroll', () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    });
    const save = async () => {
      try {
        const res = await fetch(editBase + '/edit/element/content', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide, index, html: ta.value }),
        });
        if (!res.ok) throw new Error(await res.text());
        toast('element content saved — reloading');
      } catch (e) {
        toast(`save failed: ${String(e.message || e).slice(0, 60)}`);
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { save(); e.preventDefault(); }
      else if (e.key === 'Escape') { closeContentEditor(); e.preventDefault(); }
      e.stopPropagation();
    });
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '💾 save to file';
    btn.addEventListener('click', save);
    actions.appendChild(btn);
    card.append(head, wrap, actions);
    contentEl.appendChild(card);
    closeOnBackdrop(contentEl, closeContentEditor);
    root.appendChild(contentEl);
    (async () => {
      try {
        const res = await fetch(`${editBase}/edit/element/source?slide=${slide}&index=${index}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || res.status);
        // Dedented, so the element reads at its own depth rather than at the
        // depth it happened to sit at in the file. Never re-indented: adding a
        // line break between inline elements adds a visible space, and this
        // editor writes straight back over the deck (SPEC `DECK_ANATOMY`).
        ta.value = dedentHtml(j.html);
        ta.disabled = false;
        repaint();
        ta.focus();
      } catch (e) {
        ta.value = '';
        toast(`could not read the element's source: ${String(e.message || e).slice(0, 60)}`, 2600);
      }
    })();
  }

  overlays.register({
    isOpen: () => !!menuEl,
    close: closeElementMenu,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectElementRow(menuSel + 1, true); break;
        case 'ArrowUp': selectElementRow(menuSel - 1, true); break;
        case 'Enter': menuRows[menuSel]?.run(); break;
        case 'Escape': closeElementMenu(); break;
        default: return false;
      }
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!contentEl,
    close: closeContentEditor,
    keydown: (e) => e.key === 'Escape' && (closeContentEditor(), true),
  });

  // ----- the versions overlay (R restores, H reads) — SPEC PRESENTING ---------
  // The git-level sibling of Z/⇧Z: Z takes back a keystroke, R takes back a
  // session. Rows are the deck's commits (from `decklight restore`'s own
  // helper, over the edit server); the preview is that commit's deck rendered
  // for real, because a hash and a subject are not enough to recognise the
  // version you actually want.
  //
  // ONE OVERLAY, TWO DOORS. `H` opens it as a readout — it adds the ↑ marks and
  // the branch's standing against its remote — and `R` opens it as the thing
  // that takes you back. They share their data, their markup, their preview,
  // their debounce and their keyboard, and the only differences are a title, a
  // footer and some marks. Two copies of ninety lines is how they end up
  // disagreeing about what a commit subject looks like six months from now.
  let restoreEl = null, restoreRows = [], restoreSel = 0, restoreDebounce = null;
  // The preview's own position, and the handshake that lets us move it without
  // reloading it. A bundled deck is most of a megabyte; stepping a slide by
  // setting `src` to a new hash would re-parse all of it, and the arrows would
  // feel broken. `?embedded` decks accept a `goto` from their parent (the same
  // one the slide finder uses), so once the frame is up we only ever message it.
  let previewSlide = 1, previewReady = false, previewPending = null;
  // Armed, not fired. `⏎` on a row used to restore it on the spot, and a CLICK
  // did too — which is a keystroke and a half between browsing your history and
  // rewriting the deck on disk. Restoring is recoverable (it only ever adds a
  // commit), but "recoverable" is not the same as "intended", and the whole
  // point of a history is that you were looking rather than deciding.
  let restoreArmed = false;

  // Stroke icons in the shape of the transport controls everyone already
  // knows. Constant markup, so innerHTML is the same call the touch chrome
  // makes for its own icons — nothing here comes from the deck or from git.
  const NAV_ICON = {
    first: '<path d="M17 6l-6 6 6 6"/><path d="M7 6v12"/>',
    prev: '<path d="M15 6l-6 6 6 6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    last: '<path d="M7 6l6 6-6 6"/><path d="M17 6v12"/>',
  };
  const NAV_LABEL = {
    first: 'first slide (Home)', prev: 'previous slide (←)',
    next: 'next slide (→)', last: 'last slide (End)',
  };
  const navSvg = (d) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round"'
    + ` stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  /** Slides in the selected version, or 0 when this row is past STAT_DEPTH. */
  const previewTotal = () => Number(restoreRows[restoreSel]?.slides) || 0;

  function previewGoto(n) {
    const total = previewTotal();
    previewSlide = Math.max(1, total ? Math.min(n, total) : n);
    const frame = restoreEl?.querySelector('iframe');
    if (!previewReady) previewPending = previewSlide;
    else frame?.contentWindow?.postMessage({ __decklightPreview: { goto: [previewSlide, 0] } }, '*');
    renderNav();
  }
  function renderNav() {
    const nav = restoreEl?.querySelector('.hs-nav');
    if (!nav) return;
    const total = previewTotal();
    // With no slide count for this row (past the stat depth) the buttons still
    // work — they just cannot know where the end is, so none of them is greyed
    // out. Guessing a limit would strand somebody one slide short of it.
    nav.querySelector('.hs-pos').textContent = total ? `${previewSlide} / ${total}` : `${previewSlide}`;
    for (const b of nav.querySelectorAll('.hs-btn')) {
      const at = b.dataset.go;
      b.disabled = (previewSlide <= 1 && (at === 'first' || at === 'prev'))
        || (!!total && previewSlide >= total && (at === 'next' || at === 'last'));
    }
  }
  function navTo(where) {
    if (where === 'first') return previewGoto(1);
    if (where === 'prev') return previewGoto(previewSlide - 1);
    if (where === 'next') return previewGoto(previewSlide + 1);
    return previewGoto(previewTotal() || previewSlide + 1);
  }

  function restorePreview(frame, entry) {
    if (!entry) return;
    previewReady = false;
    previewPending = null;
    previewSlide = 1;
    frame.addEventListener('load', () => {
      previewReady = true;
      if (previewPending != null) { const n = previewPending; previewPending = null; previewGoto(n); }
    }, { once: true });
    frame.src = `${editBase}/edit/at?ref=${encodeURIComponent(entry.hash)}&embedded`;
    renderNav();
  }
  function selectRestoreRow(i, immediate) {
    const rows = [...restoreEl.querySelectorAll('.tp-row')];
    if (!rows.length) return;
    disarmRestore();
    restoreSel = selectInList(rows, i, 'tp-selected');
    const entry = restoreRows[restoreSel];
    // The caption spells out what the row's badges abbreviate — the badges are
    // for scanning the column, this is for reading the one you landed on.
    restoreEl.querySelector('.tp-caption').textContent = entry
      ? `${entry.hash} · ${entry.when} · ${entry.subject}${statSentence(entry)}` : '';
    const frame = restoreEl.querySelector('iframe');
    clearTimeout(restoreDebounce);
    // debounced like the finder: holding ↓ must not fire a page load per row
    if (immediate) restorePreview(frame, entry);
    else restoreDebounce = setTimeout(() => restorePreview(frame, entry), 60);
  }
  function statSentence(e) {
    const bits = [];
    if (Number.isFinite(e.slides)) bits.push(`${e.slides} slide${e.slides === 1 ? '' : 's'}`);
    // Same rule as the badges: a zero side is left out rather than printed as
    // `−0`, so the two readouts of the same commit say the same thing.
    const diff = [e.add ? `+${e.add}` : '', e.del ? `−${e.del}` : ''].filter(Boolean);
    if (diff.length) bits.push(`${diff.join(' ')} lines`);
    return bits.length ? ` · ${bits.join(' · ')}` : '';
  }
  async function openHistory() {
    if (restoreEl) return closeRestore();
    // The migration string, and it is load-bearing for one release at least: H
    // used to be the progress bar, it worked offline and mid-talk, and somebody
    // reaching for it during a presentation must be told where it went rather
    // than getting a shrug.
    if (!editAvailable) {
      return toast(`the progress bar moved to J — ${needsDevMode('history', location)}`, 3800);
    }
    const label = 'history';
    let entries = [];
    let remote = null;
    try {
      const r = await fetch(editBase + '/edit/history');
      const j = await r.json();
      if (!j.ok) return toast(`${label}: ${j.error}`, 3000);
      entries = j.entries || [];
      remote = j.remote || null;
    } catch { return toast(`${label}: could not read the deck history`, 3000); }
    if (!entries.length) return toast(`${label}: git has no record of this deck yet`, 3000);
    dismissOthers();
    restoreRows = entries;
    restoreArmed = false;
    restoreEl = document.createElement('div');
    restoreEl.className = 'decklight-theme-picker decklight-finder decklight-restore decklight-history';
    restoreEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter"></div>' +
        '<div class="hs-remote"></div>' +
        '<div class="tp-list" role="listbox" aria-label="Deck history"></div>' +
        '<div class="hs-confirm" hidden></div></div>' +
        '<div class="tp-preview"><iframe title="Version preview"></iframe>' +
        '<div class="hs-nav" role="group" aria-label="Preview navigation">' +
          ['first', 'prev'].map((k) => navBtn(k)).join('') +
          '<span class="hs-pos" aria-live="polite"></span>' +
          ['next', 'last'].map((k) => navBtn(k)).join('') +
        '</div>' +
        '<div class="tp-caption"></div></div></div>';
    // textContent for both: a branch name is arbitrary text, and the title is
    // built from a mode rather than pasted in.
    // Short on purpose. This bar is `white-space: nowrap`, so its text is the
    // rail's min-content width — the long version of this string is literally
    // what collapsed the preview to 57px. The keys it drops are all on screen:
    // the transport draws ←→, and ⏎/Esc are in the confirmation card.
    restoreEl.querySelector('.tp-filter').textContent = 'History — ↑↓ browse · ←→ preview · ⏎ restore';
    const remoteEl = restoreEl.querySelector('.hs-remote');
    // The server sends the sentence ready-made — cli/git.mjs spawns git and the
    // runtime cannot import it, so the words live in one place on that side.
    if (remote?.line) remoteEl.textContent = remote.line;
    else remoteEl.remove();
    for (const b of restoreEl.querySelectorAll('.hs-btn')) {
      b.addEventListener('click', () => navTo(b.dataset.go));
    }
    // Built as nodes, not innerHTML: a commit subject is somebody else's text
    // and may contain anything — textContent escapes it by construction.
    const list = restoreEl.querySelector('.tp-list');
    restoreRows.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.setAttribute('role', 'option');
      // TWO LINES, and the reason is structural rather than aesthetic. On one
      // line the row carried four things that all wanted room — hash, subject,
      // badges, age — so the column's min-content width was the sum of them,
      // and a flex column cannot shrink below that. `flex: 0 0 300px` became a
      // suggestion its own content could veto, and the preview got what was
      // left: 57px. With the subject on its own line under `min-width: 0`,
      // nothing in this rail wants to be wide, and the preview's size stops
      // being an accident of how somebody worded a commit message.
      const subject = document.createElement('span');
      subject.className = 'rs-subject';
      subject.textContent = e.subject;
      const meta = document.createElement('span');
      meta.className = 'hs-meta';
      const hash = document.createElement('span');
      hash.className = 'rs-hash';
      hash.textContent = e.hash;
      meta.append(hash, statBadges(e));
      // The ↑ is only shown where it means something: `pushed === false` is
      // "this exists nowhere but here", while null is "not a question worth
      // answering" (no remote, or git could not say).
      if (e.pushed === false) {
        const up = document.createElement('span');
        up.className = 'hs-push';
        up.title = 'only on this machine';
        up.textContent = '↑';
        meta.append(up);
      }
      const when = document.createElement('span');
      when.className = 'rs-when';
      when.title = e.when;          // the long form is one hover away
      when.textContent = shortAge(e.when);
      meta.append(when);
      row.append(subject, meta);
      // A click SELECTS and asks. It used to restore, which meant a mis-aimed
      // click on a list you opened to read rewrote the deck.
      row.addEventListener('click', () => { selectRestoreRow(i, true); armRestore(); });
      list.appendChild(row);
    });
    closeOnBackdrop(restoreEl, closeRestore);
    root.appendChild(restoreEl);
    selectRestoreRow(0, true);
  }
  function navBtn(k) {
    return `<button type="button" class="hs-btn" data-go="${k}" title="${NAV_LABEL[k]}"`
      + ` aria-label="${NAV_LABEL[k]}">${navSvg(NAV_ICON[k])}</button>`;
  }
  /**
   * What this version was, and what it changed: a slide count and the line
   * counts, in the two colours everybody already reads as added and removed.
   *
   * A zero side is omitted rather than shown as `−0`: every commit that only
   * adds would carry a red zero, and the eye stops trusting the colour.
   */
  function statBadges(e) {
    const wrap = document.createElement('span');
    wrap.className = 'hs-stat';
    if (Number.isFinite(e.slides)) {
      const sl = document.createElement('span');
      sl.className = 'hs-slides';
      sl.title = `${e.slides} slide${e.slides === 1 ? '' : 's'} in this version`;
      sl.textContent = String(e.slides);
      wrap.append(sl);
    }
    if (e.add) {
      const add = document.createElement('span');
      add.className = 'hs-add';
      add.title = `${e.add} line${e.add === 1 ? '' : 's'} added`;
      add.textContent = `+${e.add}`;
      wrap.append(add);
    }
    if (e.del) {
      const del = document.createElement('span');
      del.className = 'hs-del';
      del.title = `${e.del} line${e.del === 1 ? '' : 's'} removed`;
      del.textContent = `−${e.del}`;
      wrap.append(del);
    }
    return wrap;
  }
  function closeRestore() {
    clearTimeout(restoreDebounce);
    restoreEl?.remove();
    restoreEl = null;
    restoreArmed = false;
    previewReady = false;
    previewPending = null;
  }

  /**
   * Ask before writing. The card names the version, says what restoring will
   * do, and — the part that matters — says what it will NOT do: history is
   * never rewritten, so the deck you are on right now stays in this same list.
   * That sentence is why the confirmation can be one keystroke rather than a
   * typed hash.
   */
  function armRestore() {
    const entry = restoreRows[restoreSel];
    if (!entry) return;
    restoreArmed = true;
    const card = restoreEl.querySelector('.hs-confirm');
    card.hidden = false;
    card.textContent = '';
    const q = document.createElement('div');
    q.className = 'hs-q';
    q.append('restore ', Object.assign(document.createElement('span'), {
      className: 'hs-q-hash', textContent: entry.hash }),
      Object.assign(document.createElement('span'), {
        className: 'hs-q-sub', textContent: ` ${entry.subject}` }), '?');
    const why = document.createElement('div');
    why.className = 'hs-why';
    why.textContent = `${(Number.isFinite(entry.slides) ? `${entry.slides} slides. ` : '')}`
      + 'Written as a NEW commit — nothing is rewritten, and where you are now stays in this list.';
    const row = document.createElement('div');
    row.className = 'hs-buttons';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'hs-yes';
    yes.textContent = 'restore this version';
    yes.addEventListener('click', commitRestore);
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'hs-no';
    no.textContent = 'cancel';
    no.addEventListener('click', disarmRestore);
    row.append(yes, no);
    const keys = document.createElement('div');
    keys.className = 'hs-keys';
    keys.textContent = '⏎ confirms · Esc cancels';
    card.append(q, why, row, keys);
  }
  function disarmRestore() {
    restoreArmed = false;
    const card = restoreEl?.querySelector('.hs-confirm');
    if (card) { card.hidden = true; card.textContent = ''; }
  }
  async function commitRestore() {
    const entry = restoreRows[restoreSel];
    if (!entry || !restoreArmed) return;
    closeRestore();
    try {
      const r = await fetch(editBase + '/edit/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: entry.hash }),
      });
      const j = await r.json();
      if (!j.ok) return toast(`restore failed: ${j.error}`, 3000);
      if (!j.changed) return toast(`already at ${entry.hash}`, 2000);
      // the write lands on disk; the watcher's reload brings the deck back up
      toast(`restored ${entry.hash} — Z takes it back`, 2600);
    } catch { toast('restore failed: the edit server did not answer', 3000); }
  }
  // typing surfaces — the textarea handles its own keys
  overlays.register({
    isOpen: () => !!editEl,
    close: toggleEditor,
    keydown: (e) => e.key === 'Escape' && (toggleEditor(), true),
  });
  overlays.register({
    isOpen: () => !!agentEl,
    close: toggleAgentAsk,
    keydown: (e) => e.key === 'Escape' && (toggleAgentAsk(), true),
  });
  overlays.register({
    isOpen: () => !!restoreEl,
    close: closeRestore,
    keydown(e) {
      switch (e.key) {
        case 'ArrowDown': selectRestoreRow(restoreSel + 1, false); break;
        case 'ArrowUp': selectRestoreRow(restoreSel - 1, false); break;
        // ←→ and Home/End drive the PREVIEW, which has no chrome of its own.
        // They used to fall through to the deck behind the overlay, which
        // moved a presentation nobody could see.
        case 'ArrowLeft': navTo('prev'); break;
        case 'ArrowRight': navTo('next'); break;
        case 'Home': navTo('first'); break;
        case 'End': navTo('last'); break;
        // Two steps, and the first one is not a write: ⏎ asks, ⏎ again does it.
        case 'Enter': restoreArmed ? commitRestore() : armRestore(); break;
        // Esc backs out of the question before it backs out of the overlay —
        // cancelling a restore must not also close the history you were reading.
        case 'Escape': restoreArmed ? disarmRestore() : closeRestore(); break;
        default: return false;
      }
      return true;
    },
  });


  // ── the engine wizard (MARKETPLACE.md ENGINES#WIZARD) ────────────────────
  //
  // Core renders; the plugin only declared. Everything below builds inputs from
  // a vetted schema with createElement and textContent — never innerHTML from
  // anything a catalog supplied — which is what makes "the wizard is author-mode
  // only" a rule core enforces rather than one a plugin's own markup would have
  // had to honour.
  let wizEl = null;
  function closeWizard() { wizEl?.remove(); wizEl = null; }

  async function openWizard(engine) {
    if (wizEl) { closeWizard(); return; }
    // The gate. In `present`, in a bundled deck, or on file:// with no author
    // server, there is nothing to post a credential TO — and a prompt that
    // collected one anyway would be a phishing form with a deck around it.
    if (!editAvailable) {
      toast(needsDevMode('configuring an engine', location), 3200);
      return;
    }
    let schema, prov;
    try {
      const r = await fetch(`${editBase}/edit/wizard?engine=${encodeURIComponent(engine)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.schema) { toast(j.error || `no wizard for ${engine}`, 3200); return; }
      // No provenance, no form (#232). Every string the schema itself puts on
      // screen — title, labels — was written by the plugin, so a card that
      // cannot say who is asking and where the answer goes in someone else's
      // words must not collect an answer at all.
      if (typeof j.from !== 'string' || !j.from
          || typeof j.provenance?.askedBy !== 'string' || typeof j.provenance?.sentTo !== 'string') {
        toast(`the server did not say who is asking for these answers — not prompting`, 3200);
        return;
      }
      schema = j.schema;
      prov = j.provenance;
    } catch { toast('the author server did not answer', 2600); return; }

    dismissOthers?.();
    wizEl = document.createElement('div');
    wizEl.className = 'decklight-narr decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `${schema.title} — ⌘⏎ saves · Esc closes`;
    // The provenance line (#232), above the first input: the title above and
    // every label below are the plugin's own words, so core states who is
    // asking (the registry's qualified name) and where the answer goes before
    // anything can be typed. textContent like everything else here — this line
    // in particular must never render markup a catalog supplied.
    const src = document.createElement('div');
    src.className = 'wiz-src';
    const who = document.createElement('div');
    who.textContent = prov.askedBy;
    const dest = document.createElement('div');
    dest.textContent = prov.sentTo;
    src.append(who, dest);
    card.append(head, src);

    const inputs = new Map();
    for (const f of schema.fields) {
      const row = document.createElement('label');
      row.className = 'tr-actions';
      const name = document.createElement('span');
      name.textContent = f.required ? `${f.label} *` : f.label;
      let input;
      if (f.type === 'choice') {
        input = document.createElement('select');
        for (const o of f.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          input.append(opt);
        }
        if (f.default) input.value = f.default;
      } else if (f.type === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = f.default === true;
      } else {
        input = document.createElement('input');
        // A secret is a password field so it is not read over a shoulder, not
        // captured by a screen recorder, and not autofilled from elsewhere.
        input.type = f.type === 'secret' ? 'password' : 'text';
        input.autocomplete = f.type === 'secret' ? 'off' : 'on';
        input.spellcheck = false;
        if (f.default !== undefined) input.value = String(f.default);
      }
      input.className = 'narr-input';
      inputs.set(f.name, { field: f, input });
      row.append(name, input);
      card.append(row);
    }

    const status = document.createElement('div');
    status.className = 'narr-head';
    const save = document.createElement('button');
    save.className = 'narr-prev-btn';
    save.textContent = 'save';
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    actions.append(save);
    card.append(actions, status);
    wizEl.append(card);
    root.append(wizEl);
    inputs.values().next().value?.input.focus();

    async function submit() {
      const answers = {};
      for (const [k, { field, input }] of inputs) {
        const v = field.type === 'boolean' ? input.checked : input.value;
        if (v !== '' && v !== undefined) answers[k] = v;
      }
      save.disabled = true;
      status.textContent = 'checking…';
      try {
        const r = await fetch(`${editBase}/edit/wizard`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ engine: schema.engine, answers }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          // The two failures stay two on screen as well as on the wire: one
          // says try again later, the other says fix what you typed.
          // Three states on screen as well as on the wire (ENGINES#LIPSYNC):
          // one says wait, one says fix what you typed, and one says this
          // machine is missing something no answer here can supply.
          status.textContent = j.state === 'unreachable'
            ? `could not reach it — ${j.error ?? 'try again'}`
            : j.state === 'prerequisite'
              ? `not ready on this machine — ${j.error ?? 'something it needs is missing'}`
              : `not accepted — ${j.error ?? 'check the answers'}`;
          save.disabled = false;
          return;
        }
        // j.stored is redacted by the server; nothing here ever holds the value
        // again once it has been posted.
        debugLog('wizard', `${schema.engine} configured: ${JSON.stringify(j.stored)}`);
        closeWizard();
        toast(`${schema.title} configured`, 2200);
      } catch (e) {
        status.textContent = `could not reach the author server — ${String(e.message || e).slice(0, 50)}`;
        save.disabled = false;
      }
    }
    save.addEventListener('click', submit);
    wizEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
  }

  overlays.register({
    isOpen: () => !!wizEl,
    close: closeWizard,
    keydown: (e) => e.key === 'Escape' && (closeWizard(), true),
  });

  return {
    deckHistory,
    toggleEditor,
    toggleAgentAsk,
    /** E — arm/disarm the right-click element menu (#112). Refuses outside author mode. */
    toggleElementEdit,
    /** Is element edit mode currently armed? The palette's own on/off label asks. */
    elementEditOn: () => elementEditOn,
    /** Open an engine's wizard (ENGINES#WIZARD). Refuses outside author mode. */
    wizard: openWizard,
    /** What the server's ping said a wizard can configure — the palette's Configure rows. */
    wizards: () => editWizards.slice(),
    /** R, and what the headless overlay harness drives (it has no git server). */
    // ONE feature. Restoring is something you do FROM the history, not a
    // separate thing with its own overlay, its own list and its own name for a
    // commit — which is what it was, and the two had already started to differ.
    // `restore` stays as a name so `R` and anything holding a reference keep
    // working; it opens the history, because that is where restoring lives now.
    // ONE KEY, and it answers the question that is live where you pressed it.
    // Authoring, that is "what have I changed, and what is unpushed". Presenting
    // — where there is no edit server and no /edit/at to preview a commit with —
    // it is "has the author pushed anything since I cloned this".
    history: {
      open: () => (!editAvailable && presenting ? openUpstream() : openHistory()),
      close: () => { closeRestore(); closeUpstream(); },
      list: () => restoreRows.slice(),
    },
    restore: { open: openHistory, close: closeRestore, list: () => restoreRows.slice() },
    /** Is a dev server actually serving this deck? Layout cycling asks too. */
    available: () => editAvailable,
    /** Resolves once the probe has an answer either way — see `settled`. */
    settled: () => { if (printMode || params.has('embedded')) probeSettled(); return settled; },
    /** Its origin ('' when the deck is served BY the edit server). */
    base: () => editBase,
  };
}
