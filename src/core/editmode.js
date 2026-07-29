// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Everything the deck can only do while `decklight author`'s edit server is serving
// it: live reload, the notes editor, the phone remote, asking an installed
// agent for an edit, undo/redo over the server's history, and the R dialog
// that puts the deck back to any commit.
//
// One module because they are one capability. All of it hangs off a single
// probe — /edit/ping, answered once at startup — and everything here either
// posts to that server or refuses with the same "you are not in author mode"
// message. Nothing else in the engine needs to know the server exists; layout
// cycling, the one other thing that saves through it, asks available()/base().

import { closeOnBackdrop, selectInList } from './overlay.js';
import { needsDevMode } from './devmode.js';

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
  // opened via file:// probe the server at its default localhost port
  // (CORS-open, like the tts bridge) — the printed URL and a double-clicked
  // file both work; config.edit.url overrides. A basename guard refuses to
  // wire up against a server that's editing a DIFFERENT deck.
  let editAvailable = false;
  let editBase = '';
  let editAgents = [];   // [{name, label}] the dev machine can run
  let agentBusy = null;  // {agent, prompt, startedAt} while a one-shot runs
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
          // With --remote on there is a LAN URL worth scanning, so the speaker
          // view can offer its QR (#39). editBase is '' when the deck is served
          // by the edit server itself, hence the origin fallback.
          instance.__remoteQr = j.remote ? `${editBase || location.origin}/remote/qr.svg` : null;
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          const es = new EventSource(base + '/edit/events');
          es.onmessage = () => location.reload();
          // the phone remote (#39): a tap on the controller arrives here as a
          // named event on the stream we are already subscribed to, and moves
          // the deck exactly as the arrow keys would
          es.addEventListener('remote', (ev) => {
            try {
              const { key } = JSON.parse(ev.data);
              if (key === 'next') instance.next();
              else if (key === 'prev') instance.prev();
            } catch { /* malformed event */ }
          });
          es.addEventListener('agent', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.state === 'start') {
                agentBusy = d;
                toast(`🤖 ${d.agent} is editing the deck…`, 2200);
                debugLog('agent', `${d.agent} start: ${(d.prompt || '').slice(0, 80)}`);
              } else if (d.state === 'done') {
                agentBusy = null;
                const status = d.ok ? '' : d.error ? ` — ${d.error}` : ` (exit ${d.code})`;
                toast(d.changed ? `🤖 ${d.agent} edited the deck — Z undoes${status}`
                  : `🤖 ${d.agent} finished — no changes${status}`, 3000);
                debugLog('agent', `${d.agent} done ok=${d.ok} changed=${d.changed}${status}`);
              }
            } catch { /* malformed event */ }
          });
          // …and report back where the deck is, so the phone's readout tracks
          // the deck however it moved — the remote, the keyboard, or a click.
          // Fire-and-forget: a readout that misses a beat must never be able to
          // stall the deck.
          const postPos = () => {
            fetch(editBase + '/remote/pos', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ i: instance.state.slide, n: instance.state.totalSlides }),
            }).catch(() => {});
          };
          instance.on('slide', postPos);
          instance.on('build', postPos);
          postPos();
          debugLog('edit', `live reload connected${base ? ` (${base})` : ''}`
            + (editAgents.length ? ` · agents: ${editAgents.map((a) => a.name).join(', ')}` : ''));
          return;
        } catch { /* not served by the edit server */ }
      }
    })();
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
    let pickedAgent = editAgents[0].name;
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
      sel.addEventListener('change', () => { pickedAgent = sel.value; });
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

  // ----- restore overlay (R) — SPEC PRESENTING ---------------------------------------
  // The git-level sibling of Z/⇧Z: Z takes back a keystroke, R takes back a
  // session. Rows are the deck's commits (from `decklight restore`'s own
  // helper, over the edit server); the preview is that commit's deck rendered
  // for real, because a hash and a subject are not enough to recognise the
  // version you actually want.
  let restoreEl = null, restoreRows = [], restoreSel = 0, restoreDebounce = null;

  function restorePreview(frame, entry) {
    if (entry) frame.src = `${editBase}/edit/at?ref=${encodeURIComponent(entry.hash)}&embedded`;
  }
  function selectRestoreRow(i, immediate) {
    const rows = [...restoreEl.querySelectorAll('.tp-row')];
    if (!rows.length) return;
    restoreSel = selectInList(rows, i, 'tp-selected');
    const entry = restoreRows[restoreSel];
    restoreEl.querySelector('.tp-caption').textContent =
      entry ? `${entry.hash} · ${entry.when} · ${entry.subject}` : '';
    const frame = restoreEl.querySelector('iframe');
    clearTimeout(restoreDebounce);
    // debounced like the finder: holding ↓ must not fire a page load per row
    if (immediate) restorePreview(frame, entry);
    else restoreDebounce = setTimeout(() => restorePreview(frame, entry), 60);
  }
  async function openRestore() {
    if (restoreEl) return closeRestore();
    if (!editAvailable) return toast(needsDevMode('restoring a version', location), 3200);
    let entries = [];
    try {
      const r = await fetch(editBase + '/edit/history');
      const j = await r.json();
      if (!j.ok) return toast(`restore: ${j.error}`, 3000);
      entries = j.entries || [];
    } catch { return toast('restore: could not read the deck history', 3000); }
    if (!entries.length) return toast('restore: git has no record of this deck yet', 3000);
    dismissOthers();
    restoreRows = entries;
    restoreEl = document.createElement('div');
    restoreEl.className = 'decklight-theme-picker decklight-finder decklight-restore';
    restoreEl.innerHTML =
      '<div class="tp-panel">' +
        '<div class="tp-side"><div class="tp-filter">Restore a version — ↑↓ to browse, ⏎ to restore</div>' +
        '<div class="tp-list" role="listbox" aria-label="Deck history"></div></div>' +
        '<div class="tp-preview"><iframe title="Version preview"></iframe>' +
        '<div class="tp-caption"></div></div></div>';
    // Built as nodes, not innerHTML: a commit subject is somebody else's text
    // and may contain anything — textContent escapes it by construction.
    const list = restoreEl.querySelector('.tp-list');
    restoreRows.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.setAttribute('role', 'option');
      const hash = document.createElement('span');
      hash.className = 'rs-hash';
      hash.textContent = e.hash;
      const when = document.createElement('span');
      when.className = 'rs-when';
      when.textContent = e.when;
      row.append(hash, ` ${e.subject} `, when);
      row.addEventListener('click', () => { selectRestoreRow(i, true); commitRestore(); });
      list.appendChild(row);
    });
    closeOnBackdrop(restoreEl, closeRestore);
    root.appendChild(restoreEl);
    selectRestoreRow(0, true);
  }
  function closeRestore() {
    clearTimeout(restoreDebounce);
    restoreEl?.remove();
    restoreEl = null;
  }
  async function commitRestore() {
    const entry = restoreRows[restoreSel];
    if (!entry) return;
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
        case 'Enter': commitRestore(); break;
        case 'Escape': closeRestore(); break;
        default: return false;
      }
      return true;
    },
  });

  return {
    deckHistory,
    toggleEditor,
    toggleAgentAsk,
    /** R, and what the headless overlay harness drives (it has no git server). */
    restore: { open: openRestore, close: closeRestore, list: () => restoreRows.slice() },
    /** Is a dev server actually serving this deck? Layout cycling asks too. */
    available: () => editAvailable,
    /** Its origin ('' when the deck is served BY the edit server). */
    base: () => editBase,
  };
}
