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
  // opened via file:// probe the server at its default localhost port — the
  // printed URL and a double-clicked file both work; config.edit.url overrides.
  // A basename guard refuses to wire up against a server that's editing a
  // DIFFERENT deck. Nothing here sends a token: the server authorizes on the
  // request's Origin, which the browser stamps for us — a served deck's is its
  // own loopback origin, a file:// deck's is `null`, and both are admitted
  // while a foreign tab's fetch is refused server-side (#222, cli/serve.mjs).
  let editAvailable = false;
  let editBase = '';
  let editAgents = [];   // [{name, label}] the dev machine can run
  let editWizards = [];  // [{name, qualified, title}] engines a marketplace declares a wizard for
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
          editWizards = Array.isArray(j.wizards) ? j.wizards : [];
          // No QR and no clicker on this path: the author server binds
          // 127.0.0.1 and serves no /remote/* at all (PRESENT#REMOTE). A deck
          // being AUTHORED has a keyboard in front of it; a deck being
          // PRESENTED is what wirePresentRemote wires up.
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          const es = new EventSource(base + '/edit/events');
          es.onmessage = () => location.reload();
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
          debugLog('edit', `live reload connected${base ? ` (${base})` : ''}`
            + (editAgents.length ? ` · agents: ${editAgents.map((a) => a.name).join(', ')}` : ''));
          return;
        } catch { /* not served by the edit server */ }
      }
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
          status.textContent = j.state === 'unreachable'
            ? `could not reach it — ${j.error ?? 'try again'}`
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
    /** Open an engine's wizard (ENGINES#WIZARD). Refuses outside author mode. */
    wizard: openWizard,
    /** What the server's ping said a wizard can configure — the palette's Configure rows. */
    wizards: () => editWizards.slice(),
    /** R, and what the headless overlay harness drives (it has no git server). */
    restore: { open: openRestore, close: closeRestore, list: () => restoreRows.slice() },
    /** Is a dev server actually serving this deck? Layout cycling asks too. */
    available: () => editAvailable,
    /** Its origin ('' when the deck is served BY the edit server). */
    base: () => editBase,
  };
}
