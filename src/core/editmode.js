// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Everything the deck can only do while `decklight <deck>`'s edit server is serving
// it: live reload, the notes editor, asking an installed agent for an edit,
// undo/redo over the server's history, and the R dialog that puts the deck back
// to any commit.
//
// One module because they are one capability. All of it hangs off a single
// probe — /deck/ping, answered once at startup — and everything here either
// posts to that server or refuses with the same "you are not in write mode"
// message. Nothing else in the engine needs to know the server exists; layout
// cycling, the one other thing that saves through it, asks available()/base().
//
// The phone remote is NOT here (READ_ONLY#REMOTE). It hangs off a second, smaller
// probe — wireRemote, below — because it belongs to a server with no
// edit surface at all, and a clicker should never have cost you one.

import { closeOnBackdrop, selectInList } from './overlay.js';
import { colorTargets, openColorPicker } from './colorpicker.js';
import { rangeLabel } from './ranges.js';
import { agentChipText, boundedFetch, commitChipText, commitChipTone, needsDevMode, pushToastText, shortAge } from './devmode.js';
import { dedentHtml } from './htmlfmt.js';
import { createPreview } from './preview.js';
import { readPref, writePref } from './prefs.js';
import { createDock } from './dock.js';
import { thinking } from './thinking.js';
import { authoredTop, authoredIndex, pageDesignSystems } from './design-system.js';
import { wordDiff, diffCounts } from './worddiff.js';
import { writtenMarks } from '../../tools/sentences.mjs';
import { hljs } from '../code/code.js';

/** Wire the dev-server features to a deck. */
export function createEditMode({
  root, config, params, printMode, toast, progress, debugLog, overlays, instance,
  notesSegs, notesDraft = (sl) => notesSegs(sl).join('\n\n⟨CLICK⟩\n\n'), renderTheme = () => ({}), previewQuery = () => '?embedded',
}) {
  // ── edit mode (E) + live reload — SPEC PRESENTING ────────────────────────────────
  // Served by the edit server: the deck subscribes to /deck/events and
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
  let served = false;     // a server answered the probe, read-only or not
  let readOnly = false;   // …and it was the read-only one
  let locked = false;     // write mode, with changes turned off
  let editBase = '';
  let editAgents = [];   // [{name, label, installed}] the dev machine can run
  let preferredAgent = null; // the one A reaches for, remembered server-side (#125)
  let editWizards = [];  // [{name, qualified, title}] engines a marketplace declares a wizard for
  let agentBusy = null;  // {agent, prompt, startedAt} while a one-shot runs
  // This session's asks, oldest first, each with the slide it was asked from
  // and what came of it — kept by the edit server (an agent's edit reloads
  // the page), mirrored here from /deck/ping and the 'agent' events.
  let agentAsks = [];
  let paintAsks = null;  // set while the agent card is open
  let pushToastShown = false;  // at most one push nudge per session, by construction

  // The chip that says an agent is STILL working. A toast cannot: it expires,
  // and the job does not. This lives as long as the run does, and ticks, so the
  // difference between "thinking" and "wedged" is visible without pressing A to
  // ask. Built lazily and removed outright — a deck that never asks an agent
  // never grows the node, and `--read-only` never reaches this code at all.
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
  // ── the commit chip and the commit window (SPEC PRESENTING) ─────────────────
  // The deck no longer commits itself on a clock; a snapshot does the saving
  // and this does the asking. The chip is a statement, not a modal: it never
  // takes the keyboard, and clicking it (or K) opens the window where the
  // message is written. It is also the ONE place the state of the work is
  // read: on screen, quietly, the whole time the deck differs from its last
  // commit (what changed, and the key), louder once the server asks.
  let commitNow = null;   // last {dirty, lines, sinceMs, nag, canWrite, messages}
  let commitChip = null;
  function paintCommitChip() {
    const text = commitChipText(commitNow);
    if (!text) { commitChip?.remove(); commitChip = null; return; }
    if (!commitChip) {
      commitChip = document.createElement('div');
      commitChip.className = 'decklight-commit-chip';
      commitChip.setAttribute('role', 'status');
      commitChip.setAttribute('aria-live', 'polite');
      commitChip.tabIndex = 0;
      const open = () => openCommit();
      commitChip.addEventListener('click', open);
      commitChip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      root.appendChild(commitChip);
    }
    commitChip.textContent = `⌥ ${text}`;
    commitChip.dataset.tone = commitChipTone(commitNow);
    commitChip.title = 'what has changed since the last commit — click or K to commit it; the work is snapshotted either way';
  }
  /** Ask the server what is uncommitted, then paint. */
  async function refreshCommit() {
    // `editAvailable`, not a truthy base: '' IS the base for a deck served over
    // http, where every fetch is same-origin — the flag is what says whether a
    // server answered (see the note on editBase above).
    if (!editAvailable) return null;
    try {
      const r = await fetch(editBase + '/deck/edit/commit');
      const j = await r.json();
      if (j?.ok) { commitNow = j; paintCommitChip(); return j; }
    } catch { /* the chip simply says nothing */ }
    return null;
  }

  /**
   * The commit window: what changed, what to call it, and one button.
   *
   * A real overlay rather than a prompt() because the message is the point —
   * it wants room, a second look, and the option of asking the agent for a
   * first draft. With `--commit-messages` on, that draft is fetched the moment
   * the window opens, so the common case is: press K, read the sentence, press
   * ⌘⏎. The box is EDITABLE the whole time; a generated subject is a proposal.
   */
  let commitEl = null;
  let commitAsking = false;
  function closeCommit() { commitEl?.remove(); commitEl = null; commitAsking = false; }
  async function openCommit() {
    if (commitEl) return closeCommit();
    if (!editAvailable) { toast(needsDevMode('committing', location), 3200); return; }
    const state = (await refreshCommit()) ?? commitNow;
    if (!state?.canWrite) { toast('this session is not committing — open the deck with --git', 3000); return; }
    if (!state.dirty) { toast('nothing to commit — the deck matches its last commit', 2400); return; }
    overlays.opening();
    commitEl = document.createElement('div');
    commitEl.className = 'decklight-narr decklight-commit';
    commitEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Commit"></div>';
    closeOnBackdrop(commitEl, closeCommit);
    root.appendChild(commitEl);
    const card = commitEl.querySelector('.narr-card');

    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = 'commit';
    const what = document.createElement('div');
    what.className = 'cm-what';
    const n = Number(state.lines) || 0;
    const mins = Math.floor((Number(state.sinceMs) || 0) / 60000);
    what.textContent = `${n ? `${n} line${n === 1 ? '' : 's'}` : 'changes'} in ${state.deck || 'the deck'}`
      + (mins >= 1 ? `, ${mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`} old` : '');
    const input = document.createElement('textarea');
    input.className = 'narr-input cm-input';
    input.rows = 3;
    input.placeholder = 'what changed, in one line…';
    const row = document.createElement('div');
    row.className = 'cm-row';
    const write = document.createElement('div');
    write.className = 'narr-row narr-sel cm-write';
    write.setAttribute('role', 'button');
    write.tabIndex = 0;
    // Asked of the agent installed on this machine, and only when pressed —
    // so the button says, before it is pressed, where the changes will go. The
    // agent is named because it is a real program with a real provider behind
    // it: most pass what they are given on to their service. With no agent,
    // or a session started with --no-commit-messages, the button says so
    // rather than offering what the server can only refuse, and the reason
    // (which does not fit on a button) goes on the hint line when pressed.
    const who = state.describer;
    write.textContent = who ? 'write one for me'
      : state.subjectsOff ? 'write one for me — off' : 'write one for me — no agent';
    if (!who) write.classList.add('cm-off');
    if (who) {
      write.title = `Sends the deck's uncommitted changes to ${who.name} (${who.label}), the agent installed`
        + ' on this machine, which may pass them to its provider.';
    }
    const go = document.createElement('div');
    go.className = 'narr-row narr-sel cm-go';
    go.setAttribute('role', 'button');
    go.tabIndex = 0;
    go.textContent = 'Commit';
    row.append(write, go);
    const hint = document.createElement('div');
    hint.className = 'rec-hint';
    hint.textContent = '⌘⏎ commits · Esc closes — the work is snapshotted either way';
    card.append(head, what, input, row, hint);
    setTimeout(() => input.focus(), 0);

    // The agent's draft. Never overwrites what you have already typed: it is a
    // proposal, and a proposal that eats your sentence is not one. While it is
    // being written the box says so where the subject will land, and the
    // button with it — moving, so a slow agent never reads as a stuck window.
    const placeholder = input.placeholder;
    const HINT = hint.textContent;
    // the commands in it are set as unbreakable runs: a flag split at its
    // hyphen across two lines is a command nobody can copy
    const explainWhyNot = () => {
      hint.textContent = '';
      const cmd = (t) => { const c = document.createElement('span'); c.className = 'cm-cmd'; c.textContent = t; return c; };
      if (state.subjectsOff) {
        hint.append('this session was started with ', cmd('--no-commit-messages'), ' — restart without it to have one written');
      } else {
        hint.append('no agent is installed on this machine to write one — ', cmd('decklight doctor'), ' lists the ones it can use');
      }
      hint.classList.add('cm-why');
    };
    const ask = async () => {
      if (!who) { explainWhyNot(); return; }
      if (commitAsking) return;
      hint.textContent = HINT;
      hint.classList.remove('cm-why');
      commitAsking = true;
      write.classList.add('cm-thinking');
      const stop = thinking((text) => {
        write.textContent = text;
        input.placeholder = text;
      });
      try {
        const r = await fetch(editBase + '/deck/edit/commit/subject', { method: 'POST' });
        const j = await r.json();
        if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        if (!commitEl) return;
        if (j.subject && !input.value.trim()) input.value = j.subject;
        write.textContent = j.subject ? 'write another' : 'nothing to say about it';
      } catch (e) {
        // the whole sentence, where there is room for it — a reason cut at forty
        // characters on a button is a reason nobody can act on
        if (commitEl) {
          write.textContent = "couldn't write one";
          hint.textContent = String(e.message || e);
          hint.classList.add('cm-why');
        }
      } finally {
        stop();
        write.classList.remove('cm-thinking');
        input.placeholder = placeholder;
        commitAsking = false;
      }
    };
    write.addEventListener('click', ask);
    if (state.messages && who) ask();   // drafted on open only with --commit-messages

    const commit = async () => {
      const message = input.value.trim();
      if (!message) { input.focus(); return; }
      go.textContent = 'committing…';
      try {
        const r = await fetch(editBase + '/deck/edit/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        const j = await r.json();
        if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        closeCommit();
        commitNow = j.committed ? { ...j, nag: false } : commitNow;
        paintCommitChip();
        toast(j.committed ? `committed — "${j.subject}"` : 'nothing to commit', 2600);
        debugLog('git', j.committed ? `commit: ${j.subject}` : 'commit: nothing to do');
      } catch (e) {
        go.textContent = `couldn't commit — ${String(e.message || e).slice(0, 40)}`;
      }
    };
    go.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      // ⌘K reaches the deck even from in here, so the shortcut that opened this
      // window also closes it. Everything else is stopped: the box is a typing
      // surface and the deck must not advance under it — but a modifier combo
      // is not typing, and swallowing the one key the header advertises would
      // make the alias a one-way door.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) return;
      e.stopPropagation();
    });
    overlaysCommit ??= overlays.register({
      isOpen: () => !!commitEl,
      close: closeCommit,
      keydown(e) {
        if (e.key === 'Escape') { closeCommit(); return true; }
        if (/^(input|textarea)$/i.test(e.target?.tagName ?? '')) return false;
        if (e.key === 'Enter') { commitEl?.querySelector('.cm-go')?.click(); return true; }
        if (e.key === 'k' || e.key === 'K') { closeCommit(); return true; }
        return false;
      },
    });
  }
  let overlaysCommit = null;

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
          const r = await fetch(base + '/deck/ping');
          if (!r.ok) continue;
          const j = await r.json();
          if (!j?.ok) continue;
          const here = decodeURIComponent(location.pathname.split('/').pop() || '');
          if (here && j.name && here !== j.name) {
            debugLog('edit', `server edits ${j.name}, this deck is ${here} — not wiring up`);
            continue;
          }
          // The one server, read-only: nothing here edits, and the page wires
          // up what a presented deck gets (the clicker, the upstream readout)
          // and nothing else. Every affordance gated on `available()` keeps
          // saying it needs write mode, because it does.
          if (j.readOnly) {
            served = true;
            readOnly = true;
            probeSettled();
            await wireRemote(base, j);
            return;
          }
          served = true;
          editBase = base;
          locked = j.locked === true;
          editAvailable = !locked;
          paintLockChip();
          // The speaker view saves rehearsal timings through this (PRESENTING
          // REHEARSAL_TIMINGS); with no edit server it is undefined and the
          // timings stay in the browser instead.
          instance.__saveTimings = async (timings) => {
            const res = await writeFetch(editBase + '/deck/edit/timings', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timings }),
            });
            if (!res.ok) throw new Error(await res.text());
            debugLog('edit', `rehearsal timings saved — ${timings.length} slides`);
          };
          editAgents = Array.isArray(j.agents) ? j.agents : [];
          preferredAgent = typeof j.preferredAgent === 'string' ? j.preferredAgent : null;
          editWizards = Array.isArray(j.wizards) ? j.wizards : [];
          // No QR and no clicker on this path: the edit server binds
          // 127.0.0.1 and serves no /deck/remote/* at all (READ_ONLY#REMOTE). A deck
          // being AUTHORED has a keyboard in front of it; a deck being
          // PRESENTED is what wireRemote wires up.
          // Said once per session, and only when there is enough of it to be
          // worth interrupting for. A session that STARTS forty commits behind
          // hears it immediately rather than waiting for the next commit.
          const pushMsg = pushToastText(j.remote);
          if (pushMsg) { pushToastShown = true; toast(pushMsg, 4200); }
          // What is uncommitted, as of this load: a deck reopened mid-session
          // shows the chip immediately instead of waiting for the next tick.
          if (j.commit) { commitNow = j.commit; paintCommitChip(); }
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          agentAsks = Array.isArray(j.agentAsks) ? j.agentAsks : [];
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          // The chip is restored too, with the SERVER's startedAt — a reload
          // mid-run is exactly when "is it still going?" is hardest to answer.
          paintAgentChip();
          reopenAgentAsk();   // a docked agent card open before the reload is open after it
          reopenNotes();      // …and the notes card a save reloaded, where the author was
          const es = new EventSource(base + '/deck/events');
          es.onmessage = () => location.reload();
          // A notes save is not a reload: every open view of the deck gets
          // the slide's new notes and puts them in place (narration, the
          // speaker view, a notes card left open in another tab)
          // the lock turned, in this tab or another: every page follows
          es.addEventListener('lock', (ev) => {
            try { setLocked(JSON.parse(ev.data).locked === true); } catch { /* malformed */ }
          });
          es.addEventListener('notes', (ev) => {
            try { const { slide, aside, from } = JSON.parse(ev.data); patchNotes(slide, aside, from); } catch { /* malformed: the next reload settles it */ }
          });
          es.addEventListener('commit', (ev) => {
            try {
              commitNow = JSON.parse(ev.data);
              paintCommitChip();
              debugLog('git', `uncommitted: ${commitNow.lines} lines`);
            } catch { /* the chip keeps whatever it last knew */ }
          });
          es.addEventListener('agent', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              const ask = agentAsks.find((a) => a.id != null && a.id === (d.id ?? agentBusy?.id));
              if (d.state === 'activity') {
                if (agentBusy) { agentBusy.activity = d.text; paintAgentChip(); }
                if (ask) ask.activity = d.text;
                debugLog('agent', `activity: ${d.text}`);
              } else if (d.state === 'start') {
                agentBusy = d;
                if (!ask) agentAsks.push({ ...d, state: 'running' });
                paintAgentChip();
                toast(`🤖 ${d.agent} is editing the deck…`, 2200);
                debugLog('agent', `${d.agent} start: ${(d.prompt || '').slice(0, 80)}`);
              } else if (d.state === 'done') {
                agentBusy = null;
                if (ask) Object.assign(ask, d, { finishedAt: Date.now() });
                paintAgentChip();
                const status = d.ok ? '' : d.error ? ` — ${d.error}` : ` (exit ${d.code})`;
                toast(d.changed ? `🤖 ${d.agent} edited the deck — Z undoes${status}`
                  : `🤖 ${d.agent} finished — no changes${status}`, 3000);
                debugLog('agent', `${d.agent} done ok=${d.ok} changed=${d.changed}${status}`);
                // A recording the edit orphaned or staled — held longer and on
                // its own line, because it is the one thing here you might act
                // on and it is easy to miss behind the ordinary "edited" toast.
                if (typeof d.recordingWarning === 'string') {
                  toast(d.recordingWarning, 9000);
                  debugLog('agent', d.recordingWarning);
                }
              }
              paintAsks?.();
            } catch { /* malformed event */ }
          });
          // A script enhancement, slide by slide (cli/enhance.mjs). Its last
          // event lands just before the reload its write causes, so the summary
          // is kept for the page that loads next as well as said here.
          es.addEventListener('enhance', (ev) => {
            try { enhanceEvent(JSON.parse(ev.data)); } catch { /* malformed event */ }
          });
          // Progress for a long export — the row that started it is still on
          // screen, so this rewrites that row rather than adding one per slide.
          es.addEventListener('export', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.state === 'slide' && exportRun) {
                exportRun.run.update(`${exportRun.doing} — ${d.phase === 'voice' ? 'voicing ' : ''}slide ${d.n} of ${d.of}…`);
              }
              debugLog('export', `${d.kind} ${d.state}${d.n ? ` ${d.n}/${d.of}` : ''}`);
            } catch { /* malformed event */ }
          });
          debugLog('edit', `live reload connected${base ? ` (${base})` : ''}`
            + (editAgents.length ? ` · agents: ${editAgents.map((a) => a.name).join(', ')}` : ''));
          probeSettled();
          resumeHandover();
          enhanceSummaryAfterReload();
          return;
        } catch { /* not served by the edit server */ }
      }
      probeSettled();   // asked everything, wired up nothing
    })();
  }

  // ── the editing lock (PRESENTING) ─────────────────────────────────────────
  // Started in write mode, the author can turn changes off to avoid making
  // one by mistake, and back on. The state is the SERVER's (POST /deck/edit/lock),
  // so every tab and the agent see the same thing; this is what the page
  // shows of it: a chip while locked, and every author affordance gone, since
  // `available()` is false until it is lifted.
  let lockChip = null;
  function paintLockChip() {
    if (!locked || !served || readOnly) { lockChip?.remove(); lockChip = null; return; }
    if (!lockChip) {
      lockChip = document.createElement('div');
      lockChip.className = 'decklight-lock-chip';
      lockChip.setAttribute('role', 'status');
      lockChip.tabIndex = 0;
      lockChip.title = 'editing is locked: nothing you do here changes the file — click to unlock';
      const flip = () => toggleLock();
      lockChip.addEventListener('click', flip);
      lockChip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      root.appendChild(lockChip);
    }
    lockChip.textContent = '🔒 read-only — click to unlock';
  }
  function setLocked(on) {
    if (on === locked) return;
    locked = on;
    editAvailable = served && !readOnly && !locked;
    // the editing bar and its selection go with the capability
    if (locked && elementEditOn) toggleElementEdit({ force: true });
    paintLockChip();
    for (const fn of lockListeners) fn(locked);
    toast(locked ? 'editing locked — nothing changes the file until you unlock it' : 'editing unlocked', 2600);
  }
  const lockListeners = new Set();
  /** Flip the lock on the server; every page, this one included, follows the channel. */
  async function toggleLock(want = !locked) {
    if (!served || readOnly) { toast('this deck was opened read-only — there is no editing to unlock', 3000); return; }
    try {
      const r = await fetch(editBase + '/deck/edit/lock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked: want }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      setLocked(j.locked === true);
    } catch (e) {
      toast(`could not ${want ? 'lock' : 'unlock'} editing — ${e.message}`, 4000);
    }
  }

  /**
   * The presenting control channel: `remote` events in, position echoes out.
   *
   * Deliberately a separate, smaller function rather than a flag threaded
   * through the edit path above. The two servers differ in what they are
   * ALLOWED to do, and a shared code path with a boolean in it is how a
   * presenting server quietly acquires an editing capability later.
   */
  // ── the deck update overlay (H, read-only mode) — SPEC READ_ONLY#UPSTREAM ─────
  //
  // The author's H is the deck's own history. A PRESENTED deck has no history
  // to show — there is no edit server and no /deck/edit/history/at to preview a commit with
  // — so the same key answers the question that IS live there: has the person
  // who wrote this pushed anything since I cloned it?
  //
  // It never draws on the slides. read-only.mjs is right that the audience cannot
  // act on any of this, and this is an overlay somebody opened, not a banner.
  // `''` is a REAL value here — it is the base for a deck served over http,
  // where every fetch is same-origin — so a separate flag says whether we are
  // presenting. `!deckBase` would read the empty string as "not wired" and
  // send H down the author path on exactly the decks this exists for.
  let deckBase = null;
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
      await renderUpstream(await postUpstream('/deck/upstream/check'));
    });
    if (status.state === 'behind' && status.pull?.offered) {
      button('update the deck', async () => {
        actions.textContent = 'pulling…';
        const out = await postUpstream('/deck/upstream/pull');
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
      const r = await fetch(deckBase + path, { method: 'POST' });
      return await r.json();
    } catch { return { state: 'error', message: 'the presenting server did not answer' }; }
  }

  async function openUpstream() {
    if (upEl) return closeUpstream();
    let status;
    try {
      const r = await fetch(deckBase + '/deck/upstream');
      if (!r.ok) return toast('this deck is not a tracked file in a git clone — nothing to update from', 3400);
      status = await r.json();
    } catch { return toast('deck update: the presenting server did not answer', 3000); }
    overlays.opening();
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
    transient: true,
    keydown: (e) => e.key === 'Escape' && (closeUpstream(), true),
  });

  async function wireRemote(base, j) {
    try {
      instance.__remoteQr = j.remote ? `${base || location.origin}/deck/remote/qr.svg` : null;
      // H in read-only mode. The routes only exist when the deck is a tracked
      // file in a clone with an upstream, so this base is enough to tell: a
      // deck that is not one gets a 404/405 and H says so, rather than the
      // overlay existing and being permanently empty.
      deckBase = base;
      presenting = true;
      const es = new EventSource(base + '/deck/events');
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
        fetch(base + '/deck/remote/pos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ i: instance.state.slide, n: instance.state.totalSlides }),
        }).catch(() => {});
      };
      instance.on('slide', postPos);
      instance.on('build', postPos);
      postPos();
      debugLog('remote', `remote connected${base ? ` (${base})` : ''} — no edit surface`);
    } catch { /* not served by present either */ }
  }

  // ── edits in flight ──────────────────────────────────────────────────────
  // Undo queues behind a write that has not landed yet. Every gesture that edits
  // the deck answers asynchronously — a double-click save fetches the element's
  // source before it posts, a slide op waits on the server — and a Z pressed in
  // that window reached the server FIRST: "nothing to undo", and then the edit
  // landed anyway, un-undoable from where the author stood. Agent runs are not
  // tracked: they can take minutes, and Z must not wait on one.
  const inflight = new Set();
  function trackWrite(p) {
    inflight.add(p);
    const done = () => inflight.delete(p);
    p.then(done, done);
    return p;
  }
  // Bounded: a write queued behind a saturated socket pool would otherwise hold
  // Z hostage forever, and its own catch path (the "save failed" toast) would
  // never run — see boundedFetch.
  const writeFetch = (url, init) => trackWrite(boundedFetch(url, init));

  // undo/redo (Z / ⇧Z) — the dev server's edit history: layout picks, notes
  // saves, and agent runs all snapshot into ONE stack, wholly independent of
  // the git autocommits. The server writes the restored file; its watcher
  // then reloads every browser (the hash keeps the position).
  async function deckHistory(dir) {
    if (!editAvailable) {
      toast(needsDevMode(dir, location), 3200);
      return;
    }
    if (inflight.size) await Promise.allSettled([...inflight]);
    try {
      const res = await fetch(editBase + '/deck/edit/' + dir, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || `${dir} failed`); return; }
      toast(`${dir} — ${j.undo} back · ${j.redo} forward`);
      debugLog('edit', `${dir} → ${j.undo} back, ${j.redo} forward`);
    } catch {
      toast(`${dir} failed — is the dev server still up?`, 2200);
    }
  }

  // The two typing cards — the agent ask and the notes editor — sit BESIDE
  // the slide like the content editor (dock.js): float, or docked to an edge
  // with the stage reflowing away from the gutter, each remembered per deck
  // under its own key. Docked, you write a slide's notes while reading the
  // slide, or ask the agent about it while it is on screen.
  function typingCard(kind, dock, heading, onClose) {
    const el = document.createElement('div');
    el.className = `decklight-narr decklight-dockable decklight-editor decklight-${kind}`;
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    const title = Object.assign(document.createElement('span'), { className: 'ed-heading', textContent: heading });
    head.append(title, dock.controls(onClose));
    dock.wireHeader(head);
    card.append(head);
    el.append(card);
    return { el, card, title };
  }
  function mountTypingCard(el, dock) {
    root.appendChild(el);
    // no backdrop to click: a dockable card dims nothing (the × and Esc close)
    dock.reserveGutter();
    const onResize = () => dock.reserveGutter();
    window.addEventListener('resize', onResize);
    return () => {
      el.remove();
      window.removeEventListener('resize', onResize);
      dock.release();   // or the stage keeps reflowing around a gutter nothing sits in
    };
  }

  // ask an agent (A) — hand an installed coding agent (claude, codex, bob, …)
  // a one-shot editing task; the file watcher reloads the deck when it saves,
  // and the server snapshots first so Z takes the agent's edit back.
  let agentEl = null;
  let unmountAgent = null;
  const agentDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    key: 'decklight-agent-dock:' + location.pathname,
    getEl: () => agentEl,
    closeLabel: 'close (esc)',
  });
  // A DOCKED card stays open across the reload an agent's edit causes: the
  // author asked from beside the slide and is waiting beside it for the
  // answer. Per tab, like the dock itself is per deck.
  const AGENT_OPEN_KEY = 'decklight-agent-open:' + location.pathname;
  const rememberAgentOpen = (open) => {
    try { if (open) sessionStorage.setItem(AGENT_OPEN_KEY, '1'); else sessionStorage.removeItem(AGENT_OPEN_KEY); } catch { /* no storage: it just closes */ }
  };
  /** After a save's reload: the notes card back open where the author was, caret and scroll included (#646). */
  function reopenNotes() {
    let rec = null;
    try { rec = JSON.parse(sessionStorage.getItem(NOTES_OPEN_KEY) ?? 'null'); } catch { /* no storage */ }
    forgetNotesOpen();
    // a minute is a save's reload; anything older is a different session
    if (!rec || Date.now() - rec.t > 60000 || rec.slide !== instance.state.slide || editEl) return;
    toggleEditor();
    const ta = editEl?.querySelector('textarea.edit-notes');
    if (!ta) return;
    ta.focus();
    const at = Math.min(Number(rec.caret) || 0, ta.value.length);
    ta.setSelectionRange(at, at);
    ta.scrollTop = Number(rec.scroll) || 0;
  }
  function reopenAgentAsk() {
    let open = false;
    try { open = sessionStorage.getItem(AGENT_OPEN_KEY) === '1'; } catch { /* no storage */ }
    if (open && !agentEl && !agentDock.isFloat() && editAgents.length) toggleAgentAsk();
  }
  /** One past ask, as the card lists it: where it was asked, what, and what came of it. */
  function askRow(a) {
    const row = document.createElement('div');
    row.className = `agent-ask agent-ask-${a.state === 'running' ? 'running' : a.ok ? 'ok' : 'failed'}`;
    const meta = document.createElement('div');
    meta.className = 'agent-ask-meta';
    const at = new Date(a.startedAt || Date.now());
    meta.textContent = [a.slide ? `slide ${a.slide}` : null, a.agent,
      `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`].filter(Boolean).join(' · ');
    if (a.slide) {
      // the slide it was asked about is one click away
      meta.classList.add('agent-ask-link');
      meta.title = `go to slide ${a.slide}`;
      meta.addEventListener('click', () => instance.goto(a.slide, 0));
    }
    const said = document.createElement('div');
    said.className = 'agent-ask-prompt';
    said.textContent = a.prompt;   // textContent: the user's words are not markup
    const out = document.createElement('div');
    out.className = 'agent-ask-out';
    out.textContent = a.state === 'running'
      ? `working…${a.activity ? ` ${a.activity}` : ''}`
      : [a.error ? `failed — ${a.error}` : !a.ok ? `failed (exit ${a.code ?? '?'})` : a.changed ? 'edited the deck' : 'no changes',
        (a.tail || '').trim()].filter(Boolean).join('\n');
    row.append(meta, said, out);
    return row;
  }
  function toggleAgentAsk() {
    if (agentEl) {
      unmountAgent(); agentEl = null; unmountAgent = null; paintAsks = null;
      rememberAgentOpen(false);
      return;
    }
    if (!editAvailable) {
      toast(needsDevMode('asking an agent', location), 3200);
      return;
    }
    if (!editAgents.length) {
      toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600);
      return;
    }
    const { el, card } = typingCard('agent', agentDock,
      'ask an agent — edits the deck file · ⌘⏎ sends', toggleAgentAsk);
    agentEl = el;
    // what was asked this session and what came of it — newest at the bottom,
    // right above where the next one is typed
    const log = document.createElement('div');
    log.className = 'agent-log';
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
        fetch(editBase + '/deck/edit/agent/prefer', {
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
      if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return; }
      try {
        const res = await fetch(editBase + '/deck/edit/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, agent: pickedAgent, slide: instance.state.slide }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || res.status);
        // Docked, the card stays: the ask joins its log and the answer lands
        // under it. Floating, it is a modal in the way of the slide — it goes.
        if (agentDock.isFloat()) toggleAgentAsk();
        else { ta.value = ''; rememberAgentOpen(true); }
        // progress lands as SSE 'agent' events → toasts and the log; the reload follows the save
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
    paintAsks = () => {
      log.replaceChildren(...agentAsks.map(askRow));
      log.hidden = !agentAsks.length;
      btn.disabled = !!agentBusy;
      log.scrollTop = log.scrollHeight;
    };
    paintAsks();
    card.append(log, ta, actions);
    unmountAgent = mountTypingCard(el, agentDock);
    if (!agentDock.isFloat()) rememberAgentOpen(true);
    setTimeout(() => ta.focus(), 0);
  }

  let editEl = null;
  let notesSave = null;      // the open card's save, when it can save — what ⌘⏎ reaches from anywhere (#646)
  let notesRefresh = null;   // the open card, told its slide's notes changed under it (another tab saved)
  /**
   * A slide's notes, replaced in this page as the edit server wrote them
   * (the `notes` event). The aside is the server's own markup, built from
   * the saved text. Narration reads it fresh (its memo keys on the markup),
   * the speaker view is nudged to re-read it, and an open card on that
   * slide follows unless it holds something unsaved.
   */
  const PAGE_ID = Math.random().toString(36).slice(2, 12);   // which page a notes save came from
  function patchNotes(slide, asideInner, from = null) {
    const sec = instance._sections?.[slide - 1];
    if (!sec || typeof asideInner !== 'string') return;
    let aside = sec.querySelector(':scope > aside.notes');
    if (!aside) {
      aside = document.createElement('aside');
      aside.className = 'notes';
      sec.appendChild(aside);
    }
    aside.innerHTML = asideInner;
    // the page that saved keeps its box exactly as typed: only the others follow
    if (from !== PAGE_ID) notesRefresh?.(slide);
    instance._notify();
  }
  // A save reloads the page (the server's watcher), which used to close the
  // card on every save that worked and leave it open on every one that did
  // not. The save records where the author was; the reload reopens the card
  // there (#646). Esc or × — closing on purpose — never leaves the record.
  const NOTES_OPEN_KEY = 'decklight-notes-open:' + location.pathname;
  const forgetNotesOpen = () => { try { sessionStorage.removeItem(NOTES_OPEN_KEY); } catch { /* no storage */ } };
  let unmountEditor = null;
  let notesFollow = null;   // re-points a clean notes card at the slide on screen
  let notesReadOnly = false; // the card opened with no edit server behind it
  // A DRAWER, not a dialog: the notes open docked along the bottom, the deck
  // stays navigable above them, and they save themselves (below). The dock
  // buttons still move it anywhere, remembered per deck.
  const notesDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    key: 'decklight-notes-dock:' + location.pathname,
    getEl: () => editEl,
    closeLabel: 'close (esc)',
    defaultMode: 'bottom',
  });
  let notesDirty = null;     // does the open card hold edits the file does not have?
  let notesDrafted = null;   // …and are they an agent's draft, to be read before they are written?
  let notesClosing = false;  // a close that is saving first
  // Docked, the deck stays navigable beside the notes card, so the card
  // follows the slide — but only while it holds nothing unsaved: a draft
  // stays with the slide it was written for, and its heading still says which.
  instance.on('slide', () => notesFollow?.());
  function toggleEditor() {
    if (editEl) {
      // A card holding edits saves them on the way out, and closes once they
      // are written; a save that fails leaves it open, still marked unsaved,
      // because closing would be the one way to lose what was typed.
      if (notesSave && notesDirty?.() && notesDrafted?.()) {
        toast('the agent\'s draft is unsaved — ⌘⏎ saves it, ↺ reset drops it', 4200);
        return;
      }
      if (!notesClosing && notesSave && notesDirty?.()) {
        notesClosing = true;
        notesSave().then(() => { notesClosing = false; if (editEl && !notesDirty?.()) toggleEditor(); });
        return;
      }
      unmountEditor(); editEl = null; unmountEditor = null; notesFollow = null; notesSave = null; notesRefresh = null; notesDirty = null; notesDrafted = null; forgetNotesOpen();
      return;
    }
    // With no edit server behind the deck — read-only, a file —
    // the same card opens READ-ONLY: the notes to read, following the slide,
    // and nothing that could look like it saves. `decklight <deck>` edits them.
    const readOnly = notesReadOnly = !editAvailable;
    let sl = instance.state.slide;
    const heading = () => (readOnly
      ? `notes — slide ${sl} · read-only (write mode edits them)`
      : `notes — slide ${sl} · saves itself`);
    const { el, card, title } = typingCard('notes', notesDock, heading(), toggleEditor);
    editEl = el;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    // the markers as the author writes them — [click], [pause] — never ⟨…⟩ —
    // and the paragraphs as the author laid them out, a blank line apart
    const notesText = () => writtenMarks(notesDraft(sl));
    let loaded = ta.value = notesText();
    ta.spellcheck = false;
    ta.readOnly = readOnly;
    if (readOnly) ta.classList.add('edit-notes-readonly');
    let syncChanged = () => {};   // the reset / before-after buttons, once they exist (not read-only)
    let saving = false;           // a save in flight: the mark says "saving…" 
    let drafted = false;          // the box holds an agent's draft, to be read before it is written
    if (!readOnly) notesDirty = () => ta.value !== loaded;
    if (!readOnly) notesDrafted = () => drafted;
    notesFollow = () => {
      if (instance.state.slide === sl) return;
      // Edits go to the slide they were written for, and the card moves on
      // once they are written. A save that fails leaves it where it was,
      // marked unsaved, with the slide it belongs to in its heading.
      if (ta.value !== loaded) {
        // …but an agent's draft stays with the slide it was drafted for,
        // unwritten, until it has been read
        if (!readOnly && !saving && !drafted) save().then(() => { if (ta.value === loaded) notesFollow?.(); });
        return;
      }
      sl = instance.state.slide;
      loaded = ta.value = notesText();
      title.textContent = heading();
      syncChanged();
    };
    // this slide's notes changed under the card (saved from another tab):
    // follow them, unless the box holds edits of its own
    notesRefresh = (slide) => {
      if (slide !== sl || saving) return;
      const fresh = notesText();
      if (ta.value === loaded) ta.value = fresh;
      loaded = fresh;
      syncChanged();
    };
    const save = async () => {
      saving = true;
      syncChanged();
      try { sessionStorage.setItem(NOTES_OPEN_KEY, JSON.stringify({ slide: sl, caret: ta.selectionStart, scroll: ta.scrollTop, t: Date.now() })); } catch { /* no storage: the card closes, as before */ }
      try {
        const res = await writeFetch(editBase + '/deck/edit/slide/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide: sl, text: ta.value, from: PAGE_ID }),
        });
        if (!res.ok) throw new Error(await res.text());
        const j = await res.json().catch(() => ({}));
        // nothing written (the box matches the file once normalised) means no
        // reload is coming: say so, rather than "reloading" forever (#646)
        if (j.changed === false) {
          forgetNotesOpen();   // no reload is coming
          saving = false;
          drafted = false;
          loaded = ta.value;
          syncChanged();
          toast('nothing to save — the notes already match the file', 2600);
          return;
        }
        debugLog('edit', `notes saved — slide ${sl}`);
        // written, and IN PLACE: no reload is coming (the server sends every
        // page the new notes instead), so the card simply stays as it is
        saving = false;
        drafted = false;
        loaded = ta.value;
        if (j.inPlace) forgetNotesOpen();
        syncChanged();
        toast(j.inPlace ? 'notes saved' : 'notes saved — reloading', 1800);
      } catch (e) {
        // long enough to read: the save did NOT happen, and the box still holds the text
        forgetNotesOpen();
        saving = false;
        syncChanged();   // still unsaved, and the mark says so
        toast(`save failed: ${String(e.message || e).slice(0, 90)}`, 6000);
      }
    };
    if (!readOnly) notesSave = save;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { if (!readOnly) save(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleEditor(); e.preventDefault(); }
      // read-only, a box with the caret in it must not eat the deck's keys:
      // → still advances, and the notes follow the slide
      if (!readOnly) e.stopPropagation();
    });
    if (readOnly) {
      card.append(ta);
      unmountEditor = mountTypingCard(el, notesDock);
      return;
    }
    // Leaving the card saves it: a press on the slide, or the window losing
    // focus to another. Not a focus event: the card's own machinery drops
    // focus all the time (a button disabled while drafting, the box hidden
    // behind the before/after view), and none of that is the author leaving.
    // An agent's draft is never saved this way (`drafted`): it landed in the
    // box to be read, and only ⌘⏎ or the button writes it.
    const leaving = () => { if (!saving && !drafted && ta.value !== loaded) save(); };
    const onPress = (e) => { if (!el.contains(e.target)) leaving(); };
    root.addEventListener('pointerdown', onPress, true);
    window.addEventListener('blur', leaving);
    const unmountLeaving = () => { root.removeEventListener('pointerdown', onPress, true); window.removeEventListener('blur', leaving); };
    const actions = document.createElement('div');
    actions.className = 'tr-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'narr-prev-btn';
    btn.textContent = '💾 save now';
    btn.addEventListener('click', save);
    actions.appendChild(btn);
    // ↺ reset and ⇄ before / after: both against the notes AS LAST SAVED
    // (`loaded` — the page reloads after every save, so the deck's own notes
    // are the file's). Reset drops every change in the box, typed or drafted
    // by the agent; before/after shows them, word by word, before ⌘⏎ writes
    // them. Neither does anything while the box says what the file says.
    const diffEl = document.createElement('div');
    diffEl.className = 'notes-diff';
    diffEl.hidden = true;
    diffEl.tabIndex = 0;
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'narr-prev-btn notes-reset';
    resetBtn.textContent = '↺ reset';
    resetBtn.title = 'back to the notes as last saved — drops every change in this box, typed or drafted';
    const diffBtn = document.createElement('button');
    diffBtn.type = 'button';
    diffBtn.className = 'narr-prev-btn notes-compare';
    diffBtn.title = 'what saving would change: the notes as last saved, and this box, word by word';
    const showDiff = (on) => {
      diffEl.hidden = !on;
      ta.hidden = on;
      if (on) {
        const runs = wordDiff(loaded, ta.value);
        const { removed, added } = diffCounts(runs);
        diffEl.replaceChildren();
        const head = document.createElement('div');
        head.className = 'notes-diff-head';
        head.textContent = `before → after · −${removed} +${added} word${added === 1 ? '' : 's'} · ⌘⏎ saves the after`;
        const body = document.createElement('div');
        body.className = 'notes-diff-body';
        // built as nodes: the notes are text, and an agent's answer is somebody else's
        for (const r of runs) {
          const span = document.createElement(r.op === '-' ? 'del' : r.op === '+' ? 'ins' : 'span');
          span.textContent = r.text;
          body.appendChild(span);
        }
        diffEl.append(head, body);
        diffEl.focus();
      } else ta.focus();
      diffBtn.textContent = on ? '✎ back to editing' : '⇄ before / after';
      diffBtn.classList.toggle('narr-sel', on);
    };
    // ● unsaved beside the heading while the box differs from the file —
    // at full strength, the heading itself dimmed — and saving… in flight
    const mark = Object.assign(document.createElement('span'), { className: 'notes-dirty-mark',
      title: 'saved when you leave the box, move to another slide, or close the card — ⌘⏎ saves now' });
    title.after(mark);
    syncChanged = () => {
      const changed = ta.value !== loaded;
      mark.textContent = saving ? 'saving…' : changed ? '● unsaved' : '';
      mark.hidden = !mark.textContent;
      resetBtn.disabled = !changed;
      diffBtn.disabled = !changed && diffEl.hidden;
      if (!changed && !diffEl.hidden) showDiff(false);
    };
    resetBtn.addEventListener('click', () => {
      ta.value = loaded;
      drafted = false;
      diffBtn.classList.remove('notes-fresh');
      showDiff(false);
      syncChanged();
      toast('back to the notes as last saved', 2200);
    });
    diffBtn.addEventListener('click', () => { diffBtn.classList.remove('notes-fresh'); showDiff(diffEl.hidden); });
    diffEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { save(); e.preventDefault(); }
      else if (e.key === 'Escape') { showDiff(false); e.preventDefault(); }
      e.stopPropagation();
    });
    ta.addEventListener('input', () => { drafted = false; syncChanged(); });   // typed into, the draft is the author's own
    actions.append(resetBtn, diffBtn);
    showDiff(false);
    syncChanged();
    // Two rewrites by the agent (cli/enhance.mjs), each for this slide, its
    // module, or the whole deck:
    //   ✨ add audio tags — the tags ElevenLabs v4 performs, same words;
    //   🗣 write it for the ear — terse notes as sentences a person would say.
    // THIS SLIDE lands in the box — to read, edit, and save with ⌘⏎, or not;
    // nothing is written by pressing it. A module or the deck is rewritten in
    // the file in one edit, which Z takes back.
    if (editAgents.length) {
      const agent = editAgents.find((a) => a.name === preferredAgent) ?? editAgents[0];
      const REWRITE_BUTTONS = [
        { kind: 'tags', label: '✨ add audio tags', drafting: 'drafting',
          title: `${agent.label} drafts ElevenLabs v4 audio tags ([thoughtful], [sighs]) into the notes, `
            + 'with the prompt ElevenLabs publishes for it. Every word, [click] and [pause] must survive, or nothing changes.',
          none: 'found nothing to add', landed: 'audio tags added' },
        { kind: 'spoken', label: '🗣 write it for the ear', drafting: 'rewriting',
          title: `${agent.label} rewrites terse notes as sentences a person would say out loud — `
            + '"Fluffed a line? Backspace retakes it." becomes "And if you fluff a line, just press Backspace to take it again." '
            + 'Every [click] and [pause] must survive, and the length stay in proportion, or nothing changes.',
          none: 'found nothing to rewrite', landed: 'rewritten for the ear' },
      ];
      // the box, rewritten in place — the one scope that writes nothing
      const rewriteBox = async (b, btn) => {
        const text = ta.value;
        if (!text.trim()) { toast('nothing to rewrite — the notes are empty'); return; }
        btn.disabled = true;
        ta.readOnly = true;   // the answer is to THIS text; typing meanwhile would be overwritten
        const stop = thinking((t) => { btn.textContent = `${b.label.split(' ')[0]} ${t}`; }, { label: b.drafting });
        try {
          const r = await fetch(editBase + '/deck/edit/enhance/text', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, kind: b.kind }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
          if (!j.changed) toast(`${j.label || j.agent} ${b.none}`, 3200);
          else {
            ta.value = j.text;
            drafted = true;
            syncChanged();
            // fresh: the button that shows what just changed, lit until looked at
            diffBtn.classList.add('notes-fresh');
            toast(`${b.landed} — ⇄ before / after shows what changed · ⌘⏎ saves · ↺ reset drops it`, 6000);
          }
          debugLog('enhance', `notes editor (${b.kind}): ${j.changed ? 'drafted' : 'nothing to change'}`);
        } catch (e) {
          toast(`nothing changed — ${String(e.message || e)}`, 6000);
        } finally {
          stop();
          btn.textContent = b.label;
          btn.disabled = false;
          ta.readOnly = false;
          ta.focus();
        }
      };
      // which slides: this one (the box), its module, or the whole deck
      const chooseScope = (b, btn) => {
        const mod = moduleOf(sl);
        const row = document.createElement('div');
        row.className = 'tr-actions notes-scope';
        const opt = (text, title, go) => {
          const o = document.createElement('button');
          o.type = 'button';
          o.className = 'narr-prev-btn';
          o.textContent = text;
          if (title) o.title = title;
          o.addEventListener('click', () => { row.remove(); actions.hidden = false; go(); });
          row.appendChild(o);
          return o;
        };
        const writesFile = (scope) => () => {
          if (ta.value !== loaded) { toast('save or leave this slide\'s edits first (⌘⏎ saves, Esc leaves) — this rewrites the file', 5000); return; }
          toggleEditor();
          enhanceScript(scope, { kind: b.kind });
        };
        opt(`this slide`, 'into the box above — read it, then ⌘⏎ saves', () => rewriteBox(b, btn)).classList.add('narr-sel');
        if (mod) opt(`module “${mod.title}” · ${mod.to - mod.from + 1}`, `slides ${mod.from}–${mod.to}, in the file — Z undoes`, writesFile('module'));
        opt(`whole deck · ${instance.state.totalSlides}`, 'every slide with notes, in the file — Z undoes', writesFile('all'));
        opt('✕', 'never mind', () => {});
        const hint = document.createElement('span');
        hint.className = 'notes-scope-what';
        hint.textContent = `${b.label} —`;
        row.prepend(hint);
        actions.hidden = true;
        actions.after(row);
        row.querySelector('.narr-sel')?.focus();
      };
      for (const b of REWRITE_BUTTONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `narr-prev-btn notes-${b.kind === 'tags' ? 'enhance' : 'spoken'}`;
        btn.textContent = b.label;
        btn.title = `${b.title} The notes are sent to that agent, which may pass them to its provider.`;
        btn.addEventListener('click', () => chooseScope(b, btn));
        actions.appendChild(btn);
      }
    }
    card.append(ta, diffEl, actions);
    const unmountCard = mountTypingCard(el, notesDock);
    unmountEditor = () => { unmountCard(); unmountLeaving(); };
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
  // who wants to know when E turns editing on or off: the editing bar (editbar.js)
  const elementEditListeners = new Set();

  function toggleElementEdit({ force = false } = {}) {
    if (force) { if (!elementEditOn) return; }
    else if (!editAvailable) {
      toast(locked ? 'editing is locked — unlock it from the palette or the lock chip' : needsDevMode('editing', location), 3200);
      return;
    }
    elementEditOn = force ? false : !elementEditOn;
    closeElementMenu();
    toast(elementEditOn ? 'editing — click to select, double-click text to change it, E when finished' : 'editing finished', 2600);
    for (const fn of elementEditListeners) fn(elementEditOn);
  }

  /**
   * What a click on `node` addresses (SPEC PRESENTING, element edit mode):
   * the slide, the authored top-level element containing the click (`top`,
   * null on the bare background) and its index in the FILE. Null off a
   * slide, and on a slide with no per-element source mapping, which is told.
   */
  function elementTargetOf(node) {
    const sec = node?.closest?.('section');
    const slide = sec ? instance._sections.indexOf(sec) + 1 : 0;
    if (!sec || !slide) return null;
    // No per-element source mapping exists for a markdown-authored slide (its
    // content lived in a <script type="text/template"> the browser never
    // parsed) — same reason a removed-markdown slide has nothing for the
    // notes editor to key off either.
    if (sec.hasAttribute('data-markdown-removed')) {
      toast('this slide has no per-element source mapping (data-markdown, removed in 0.3.0) — edit the file directly', 3400);
      return null;
    }
    const child = topLevelChild(sec, node);
    return { sec, slide, index: child ? authoredIndex(sec, child) : null, top: child, clicked: node };
  }

  /** The direct child of `sec` that contains `target`, or null for the bare background (target IS sec). */
  // the authored element a right-click addresses (SPEC DESIGN_SYSTEMS): on an
  // expanded design-system slide, the slot content wherever it was put — the
  // layout's decoration addresses nothing, and the index is the FILE's
  const topLevelChild = (sec, target) => authoredTop(sec, target);

  root.addEventListener('contextmenu', (e) => {
    if (!elementEditOn) return;
    if (!e.target.closest('section')) return; // not a real slide section — leave the OS menu alone
    e.preventDefault();
    const target = elementTargetOf(e.target);
    if (!target) return;
    overlays.opening();
    openElementMenu(e.clientX, e.clientY, target);
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
    } else if (menuView === 'slide') {
      // opened from the bar's Slide ▾ there is nothing to go back to
      if (!menuTarget.fromBar) rows.push({ label: '← back', back: true, run: () => { menuView = 'main'; renderElementMenu(); } });
      rows.push({ label: 'New slide after this one', run: () => { closeElementMenu(); slideOp('new'); } });
      rows.push({ label: 'Duplicate this slide', run: () => { closeElementMenu(); slideOp('duplicate'); } });
      rows.push({ label: 'Move slide up', run: () => { closeElementMenu(); slideOp('up'); } });
      rows.push({ label: 'Move slide down', run: () => { closeElementMenu(); slideOp('down'); } });
      rows.push({ label: 'Delete this slide', run: () => { closeElementMenu(); slideOp('delete'); } });
    } else if (menuTarget.index === null) {
      rows.push({ label: 'Edit speaker notes', run: () => { closeElementMenu(); toggleEditor(); } });
      rows.push({ label: 'Slide ▸', run: () => { menuView = 'slide'; renderElementMenu(); } });
    } else {
      rows.push({ label: 'Edit speaker notes', run: () => { closeElementMenu(); toggleEditor(); } });
      rows.push({ label: 'Remove element', run: () => commitRemove() });
      rows.push({ label: 'Edit content (HTML)', run: () => { closeElementMenu(); openElementContentEditor(menuTarget); } });
      rows.push({ label: 'Colors…', run: openColors });
      rows.push({ label: 'Add text effect ▸', run: () => { menuView = 'effects'; renderElementMenu(); } });
      rows.push({ label: 'Slide ▸', run: () => { menuView = 'slide'; renderElementMenu(); } });
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

  function openElementMenu(x, y, target, view = 'main', { above = false } = {}) {
    menuTarget = target;
    menuView = view;
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
    // `above`: the point is the menu's bottom edge, for a menu that opens up from the editing bar
    const top = Math.min(y - rect.top - (above ? card.offsetHeight : 0), rect.height - card.offsetHeight - 4);
    card.style.left = Math.max(4, left) + 'px';
    card.style.top = Math.max(4, top) + 'px';
    closeOnBackdrop(menuEl, closeElementMenu);
  }

  /**
   * The five things you do to a slide as a whole — new, duplicate, delete, up,
   * down (SPEC PRESENTING, write mode). Until now every one of them meant
   * opening the HTML in a text editor; the starter deck's own notes said
   * "duplicate the section for more". One POST, one undo entry; the server
   * answers with the slide to be on afterwards, and the hash is moved there
   * before the file watcher's reload lands, so the reload opens on it.
   */
  async function slideOp(op, { slide = instance.state.slide, to = null } = {}) {
    if (!editAvailable) { toast(needsDevMode('editing slides', location), 3200); return; }
    try {
      const res = await writeFetch(editBase + '/deck/edit/slide', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, slide, ...(op === 'move' ? { to } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || String(res.status));
      const said = {
        new: `new slide added after ${slide}`,
        duplicate: `slide ${slide} duplicated`,
        delete: `slide ${slide} deleted — Z takes it back`,
        up: `slide ${slide} moved up`,
        down: `slide ${slide} moved down`,
        move: `slide ${slide} moved to ${to}`,
      }[op] ?? 'done';
      toast(`${said} — reloading`, 2000);
      if (Number.isInteger(j.slide)) location.hash = `#/${j.slide}/0`;
    } catch (e) {
      toast(`could not ${op === 'new' ? 'add a slide' : `${op} the slide`}: ${String(e.message || e).slice(0, 80)}`, 3000);
      throw e;
    }
  }

  async function commitRemove(target = menuTarget) {
    const { slide, index } = target;
    closeElementMenu();
    if (index === null) { toast('nothing selected to remove', 2000); return; }
    try {
      const res = await writeFetch(editBase + '/deck/edit/element/remove', {
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
      const res = await writeFetch(editBase + '/deck/edit/element/effect', {
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

  // "Colors…" — the background of the shape under the click and the text on
  // it (colorpicker.js). The card takes the menu's place at the same point;
  // what it saves is one POST and one undo entry for the pair.
  let colorCard = null;
  const colorDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    key: 'decklight-colors-dock:' + location.pathname,
    getEl: () => colorCard?.el ?? null,
    closeLabel: 'close (esc)',
  });
  function openColors() {
    const { slide, index, top, clicked } = menuTarget;
    closeElementMenu();
    colorCard?.close();   // a second shape: the first one's preview goes back before this one's starts
    const targets = colorTargets(top, clicked);
    if (!targets) { toast('nothing here to color — right-click a shape, its label, or a block', 2600); return; }
    overlays.opening();
    colorCard = openColorPicker({
      root, dock: colorDock, targets,
      // the deck's design systems' palettes follow the theme's (SPEC DESIGN_SYSTEMS)
      systems: [...pageDesignSystems().values()],
      onClose: () => { colorCard = null; },
      onApply: async (edits) => {
        try {
          const res = await writeFetch(editBase + '/deck/edit/element/style', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slide, index, edits }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || res.status);
          toast(j.changed ? 'colors saved — reloading · Z takes them back' : 'colors unchanged');
        } catch (e) {
          for (const t of [...targets.fill, ...targets.text]) t.el.style.removeProperty(t.prop);
          toast(`colors not saved: ${String(e.message || e).slice(0, 90)}`, 3400);
        }
      },
    });
  }

  // "Edit content (HTML)" — the element's raw outerHTML, read fresh from the
  // FILE (never the live DOM: the engine mutates elements in place, so what
  // the player sees is not what a Save should write back over).
  let contentEl = null;
  let contentTarget = null;   // the element on the slide, outlined while its source is open
  let onEditorResize = null;
  // Beside the slide, not over it (#530): the review and sources panels'
  // placement, shared (dock.js). Docked, the slide stays whole and navigable
  // next to the editor — you change a `y=` while looking at the box it moves.
  const editorDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    key: 'decklight-editor-dock:' + location.pathname,
    getEl: () => contentEl,
    closeLabel: 'close (esc)',
  });
  function closeContentEditor() {
    contentEl?.remove(); contentEl = null;
    contentTarget?.classList.remove('dl-editing'); contentTarget = null;
    if (onEditorResize) { window.removeEventListener('resize', onEditorResize); onEditorResize = null; }
    editorDock.release();   // or the stage keeps reflowing around a gutter nothing sits in
  }
  function openElementContentEditor({ sec, slide, index }) {
    contentEl = document.createElement('div');
    contentEl.className = 'decklight-narr decklight-dockable decklight-editor';
    const card = document.createElement('div');
    card.className = 'narr-card';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.append(Object.assign(document.createElement('span'), {
      className: 'ed-heading', textContent: `edit content — slide ${slide}, element ${index} · ⌘⏎ saves`,
    }));
    head.append(editorDock.controls(closeContentEditor));
    editorDock.wireHeader(head);
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
    // The textarea's scrollbar, when it is a classic one, narrows its text by
    // a scrollbar's width; the painted layer has none (overflow hidden), so
    // it pads by the same amount and the two wrap identically. Re-measured
    // whenever the box changes size — a dock, a resize — or the content grows
    // past the fold and the scrollbar appears.
    const syncGutter = () => { pre.style.paddingRight = `${12 + (ta.offsetWidth - ta.clientWidth)}px`; };
    ta.addEventListener('input', () => { repaint(); syncGutter(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncGutter).observe(ta);
    ta.addEventListener('scroll', () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    });
    const save = async () => {
      try {
        const res = await writeFetch(editBase + '/deck/edit/element/content', {
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
    root.appendChild(contentEl);
    // no backdrop to click: a dockable panel dims nothing (the × and Esc close)
    editorDock.reserveGutter();
    onEditorResize = () => editorDock.reserveGutter();
    window.addEventListener('resize', onEditorResize);
    // the element under edit keeps the same outline a double-click edit gets
    contentTarget = index === null ? null : (sec?.children?.[index] ?? null);
    contentTarget?.classList.add('dl-editing');
    (async () => {
      try {
        // Bounded, so a request the browser never sends (every socket to this
        // origin pinned by another tab's live reload) reaches the catch below
        // and its toast, rather than leaving the textarea on `loading…` for good.
        const res = await boundedFetch(`${editBase}/deck/edit/element/source?slide=${slide}&index=${index}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || res.status);
        // Dedented, so the element reads at its own depth rather than at the
        // depth it happened to sit at in the file. Never re-indented: adding a
        // line break between inline elements adds a visible space, and this
        // editor writes straight back over the deck (SPEC `DECK_ANATOMY`).
        ta.value = dedentHtml(j.html);
        ta.disabled = false;
        repaint();
        syncGutter();
        ta.focus();
        // At the TOP, caret first: focus() lands after the last character and
        // scrolls to it, which opened a long element at its end (#529).
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
        pre.scrollTop = 0;
      } catch (e) {
        ta.value = '';
        toast(`could not read the element's source: ${String(e.message || e).slice(0, 60)}`, 2600);
      }
    })();
  }

  overlays.register({
    isOpen: () => !!menuEl,
    close: closeElementMenu,
    transient: true,
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
    isOpen: () => !!colorCard,
    close: () => colorCard?.close(),
    // floating it is over the slide and owns the keyboard; docked it sits
    // beside it and the deck's keys work (the card stops its own — colorpicker.js)
    modal: () => colorDock.isFloat(),
    keydown(e) {
      if (e.key === 'Escape') colorCard.close();
      else if (e.key === 'Enter' && colorDock.isFloat()) colorCard.apply();
      else return false;
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!contentEl,
    close: closeContentEditor,
    // floating, it is the modal it always was; docked, the deck's keys work
    // whenever the caret is not in the textarea (which stops its own keys)
    modal: () => editorDock.isFloat(),
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
  let previewSlide = 1;
  let previewDoc = null; // the commit the preview frame is showing, by hash
  const preview = createPreview({
    docOf: (t) => t.doc,
    // in the theme on screen: an old version opens on ITS configured theme,
    // and the history is for seeing what changed, not the theme it had then
    srcFor: (t) => `${editBase}/deck/edit/history/at?ref=${encodeURIComponent(t.doc)}&${previewQuery().replace(/^\?/, '')}`,
    messageFor: (t) => ({ __decklightPreview: { goto: [t.slide, 0] } }),
  });
  // Armed, not fired. `⏎` on a row used to restore it on the spot, and a CLICK
  // did too — which is a keystroke and a half between browsing your history and
  // rewriting the deck on disk. Restoring is recoverable (it only ever adds a
  // commit), but "recoverable" is not the same as "intended", and the whole
  // point of a history is that you were looking rather than deciding.
  let restoreArmed = false;
  // The caption under the preview — hash · age · subject · counts — is the
  // selected row said again in a sentence. Useful when the rail is too narrow
  // to read, noise when it is not, and it sits right under the slide you are
  // trying to judge, so it is off until asked for. Per BROWSER, not per deck:
  // it is how you like this overlay, not a fact about any one deck.
  const HISTORY_CAPTIONS_KEY = 'decklight-history-captions';
  const historyCaptionsOn = () => readPref(HISTORY_CAPTIONS_KEY) === '1';
  function applyHistoryCaptions() {
    if (!restoreEl) return;
    const on = historyCaptionsOn();
    restoreEl.querySelector('.tp-caption').hidden = !on;
    const b = restoreEl.querySelector('.hs-cc');
    b.setAttribute('aria-pressed', String(on));
    b.title = `${on ? 'hide' : 'show'} captions (C)`;
  }
  function toggleHistoryCaptions() {
    writePref(HISTORY_CAPTIONS_KEY, historyCaptionsOn() ? '0' : '1');
    applyHistoryCaptions();
  }

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
    if (frame && previewDoc) preview.show(frame, { doc: previewDoc, slide: previewSlide });
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
    for (const b of nav.querySelectorAll('.hs-btn[data-go]')) {
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
    // a row re-selected is a message, not a reload — the same short-circuit the
    // finder and the pickers have always had
    if (entry.hash !== previewDoc) previewSlide = 1;
    previewDoc = entry.hash;
    preview.show(frame, { doc: previewDoc, slide: previewSlide });
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
      const r = await fetch(editBase + '/deck/edit/history');
      const j = await r.json();
      if (!j.ok) return toast(`${label}: ${j.error}`, 3000);
      entries = j.entries || [];
      remote = j.remote || null;
    } catch { return toast(`${label}: could not read the deck history`, 3000); }
    if (!entries.length) return toast(`${label}: git has no record of this deck yet`, 3000);
    overlays.opening();
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
          '<button type="button" class="hs-btn hs-cc" aria-label="captions (C)">CC</button>' +
        '</div>' +
        '<div class="tp-caption"></div></div></div>';
    // textContent for both: a branch name is arbitrary text, and the title is
    // built from a mode rather than pasted in.
    // Short on purpose. This bar is `white-space: nowrap`, so its text is the
    // rail's min-content width — the long version of this string is literally
    // what collapsed the preview to 57px. The keys it drops are all on screen:
    // the transport draws ←→, and ⏎/Esc are in the confirmation card.
    restoreEl.querySelector('.tp-filter').textContent = 'History — ↑↓ browse · ←→ preview · ⏎ restore · C\u00a0captions';
    const remoteEl = restoreEl.querySelector('.hs-remote');
    // The server sends the sentence ready-made — cli/git.mjs spawns git and the
    // runtime cannot import it, so the words live in one place on that side.
    if (remote?.line) remoteEl.textContent = remote.line;
    else remoteEl.remove();
    for (const b of restoreEl.querySelectorAll('.hs-btn[data-go]')) {
      b.addEventListener('click', () => navTo(b.dataset.go));
    }
    restoreEl.querySelector('.hs-cc').addEventListener('click', toggleHistoryCaptions);
    applyHistoryCaptions();
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
    previewDoc = null;
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
      const r = await writeFetch(editBase + '/deck/edit/restore', {
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
  // typing surfaces — the textarea handles its own keys. Floating, each is
  // the modal it always was; docked, the deck's keys work whenever the caret
  // is not in the textarea.
  overlays.register({
    isOpen: () => !!editEl,
    close: toggleEditor,
    // read-only (no edit server) it is never modal: nothing in it is being
    // written, so → and the rest go on to the deck, floating or docked
    modal: () => !notesReadOnly && notesDock.isFloat(),
    keydown: (e) => e.key === 'Escape' && (toggleEditor(), true),
    // ⌘⏎ from anywhere while the card is up (engine.js); the read-only card has none
    save: () => (notesSave ? (notesSave(), true) : false),
  });
  overlays.register({
    isOpen: () => !!agentEl,
    close: toggleAgentAsk,
    modal: () => agentDock.isFloat(),
    keydown: (e) => e.key === 'Escape' && (toggleAgentAsk(), true),
  });
  overlays.register({
    isOpen: () => !!restoreEl,
    close: closeRestore,
    transient: true,
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
        // the deck's own captions key, meaning the same thing one layer up
        case 'c': case 'C': toggleHistoryCaptions(); break;
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
  // anything a catalog supplied — which is what makes "the wizard is write-mode
  // only" a rule core enforces rather than one a plugin's own markup would have
  // had to honour.
  let wizEl = null;
  function closeWizard() { wizEl?.remove(); wizEl = null; }

  async function openWizard(engine) {
    if (wizEl) { closeWizard(); return; }
    // The gate. In `--read-only`, in a bundled deck, or on file:// with no author
    // server, there is nothing to post a credential TO — and a prompt that
    // collected one anyway would be a phishing form with a deck around it.
    if (!editAvailable) {
      toast(needsDevMode('configuring an engine', location), 3200);
      return;
    }
    let schema, prov;
    try {
      const r = await fetch(`${editBase}/deck/edit/wizard?engine=${encodeURIComponent(engine)}`);
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
    } catch { toast('the edit server did not answer', 2600); return; }

    overlays.opening();
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
        const r = await fetch(`${editBase}/deck/edit/wizard`, {
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
        status.textContent = `could not reach the edit server — ${String(e.message || e).slice(0, 50)}`;
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

  // ── the hand-over exports (PRESENTING) ───────────────────────────────────
  //
  // `decklight pptx` and `decklight pdf` need Node and a headless Chrome, so
  // the deck cannot write these files itself — it asks the edit server to
  // run the command, the same door `A` uses for an agent, and what a row
  // writes is exactly what the command line writes.
  //
  // They take seconds per slide, so the row narrates: it says what it is doing
  // before anything happens, keeps saying it as the server reports each slide
  // over the SSE channel the agent chip already rides, and names the file at
  // the end. A silent wait reads as a dead row — which is why the progress
  // toast is one row rewritten rather than a toast per slide.
  const EXPORTS = {
    pptx: 'PowerPoint',
    pdf: 'PDF',
    'pdf-notes': 'PDF with notes',
    'pdf-handout': 'PDF handout',
    video: 'video',
    bundle: 'one file',
  };
  let exportRun = null;
  // what `audio` a bundle carries its narration as, when it is not as recorded
  const AUDIO_HOW = { aac: 'AAC', opus: 'Opus' };
  /**
   * How big the bundle would be (GET /deck/edit/export/estimate): the file without
   * its audio, and what each way of carrying the audio adds. Null when the
   * server cannot say; the reason is toasted, since bundling would hit it too.
   */
  async function bundleEstimate() {
    try {
      // in the theme on screen, which is what the export will bundle in
      const { theme } = renderTheme() ?? {};
      const r = await fetch(editBase + '/deck/edit/export/estimate?kind=bundle' + (theme ? `&theme=${encodeURIComponent(theme)}` : ''));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      return j;
    } catch (e) {
      toast(`could not bundle — ${e.message}`, 5200);
      return null;
    }
  }
  // The voice picked on the export card, as the route spells it. No choice at
  // all sends none, which leaves the command's own default: a voiceover/ beside
  // the deck if there is one.
  const videoVoice = (voice) => (voice?.kind === 'recorded' ? { narration: voice.dir }
    : voice?.kind === 'live' ? { synthesize: { engine: voice.engine, model: voice.model, voice: voice.voice, style: voice.style, dir: voice.dir } }
      : voice?.kind === 'silent' ? { silent: true } : {});
  // ── an unmarked marketplace theme on screen at hand-over ─────────────────
  //
  // A file handed over in a theme the deck does not mark would be a file the
  // deck itself cannot reproduce (SPEC THEME_DISTRIBUTION), so the server
  // refuses with `{ unmarked }` and the row ARMS, the way publishing does:
  // choosing it again marks the theme and carries on. Nothing is written to
  // the deck without that second press. Marking rewrites the deck, and the
  // watcher reloads the page — so what was asked for is handed across the
  // reload in sessionStorage and resumed once the page is back.
  const RESUME_KEY = 'decklight-resume-handover:' + location.pathname;
  let markArmed = null; // { ref, theme, at }
  function armMark(ref, theme, run, { bundles = false } = {}) {
    markArmed = { ref, theme, at: Date.now() };
    // A bundle (or a publish, which bundles) leaves an unmarked theme out, so
    // that is what it says; a render needs the mark for the deck to have it.
    run.done(bundles
      ? `${ref} is not marked, so it would not be part of the bundle — choose this again to mark it and bundle`
      : `${ref} is not marked for this deck — choose this again to mark it and carry on`, 9000);
    debugLog('export', `${ref} unmarked — armed`);
  }
  /** True when this press is the confirmation: the mark is sent and the hand-over resumes after the reload. */
  function markConfirmed(theme, resume) {
    const armed = markArmed;
    if (!armed || armed.theme !== theme || Date.now() - armed.at > PUBLISH_ARM_MS) {
      markArmed = null;
      return false;
    }
    markArmed = null;
    (async () => {
      try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...resume, at: Date.now() })); } catch { /* no storage: marks, does not resume */ }
      try {
        const r = await fetch(editBase + '/deck/edit/theme/mark', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref: armed.ref, marked: true }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
        toast(`${armed.ref} marked — carrying on once the deck reloads`, 4000);
      } catch (e) {
        try { sessionStorage.removeItem(RESUME_KEY); } catch { /* nothing to clear */ }
        toast(`could not mark ${armed.ref} — ${e.message}`, 5200);
      }
    })();
    return true;
  }
  /** After the reload a mark caused: pick the hand-over up where it stopped. */
  function resumeHandover() {
    let job = null;
    try {
      job = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      sessionStorage.removeItem(RESUME_KEY);
    } catch { return; }
    if (!job || Date.now() - job.at > 60000) return;
    if (job.publish) publishNow();
    else if (job.kind) exportDeck(job.kind, job.opts ?? {});
  }

  async function exportDeck(kind, { slides = null, voice = null, format = null, quality = null, subtitles = null, audio = false } = {}) {
    const what = EXPORTS[kind];
    if (!what) return;
    // The server refuses a second export too (one browser, one output path);
    // this is the same answer without the round trip.
    if (exportRun) { toast('already exporting — one at a time'); return; }
    // A video is of SOMETHING — a range, a voice — and takes minutes, so the row
    // says which slides it is rendering rather than just that it is busy.
    const voicing = kind === 'video' && voice?.kind === 'live';
    const older = kind === 'video' && voice?.kind === 'recorded' && voice.stale > 0
      ? (voice.engine
        ? ` — re-voicing ${voice.stale} slide${voice.stale === 1 ? '' : 's'} from older notes first, in its own voice`
        : ` — its voice was recorded from older notes on ${voice.stale} slide${voice.stale === 1 ? '' : 's'}`)
      : '';
    // In the theme on screen (#547). The render is a fresh browser that cannot
    // see this one's pick, so it is TOLD: without this it opened on the deck's
    // default — or on its first inline theme block. A theme with a name the
    // deck knows goes by name; one that lives only in this browser (a saved
    // custom theme, an unsaved roll) goes as its tokens.
    const { theme, gen } = renderTheme() ?? {};
    if (markConfirmed(theme, { kind, opts: { slides, voice, format, quality, subtitles, audio } })) return;
    const doing = kind === 'video'
      ? `${voicing ? 'voicing and rendering' : 'rendering'} a video of ${rangeLabel(slides)}${older}`
      : `exporting to ${what}${audio ? `, with the narration audio${AUDIO_HOW[audio] ? ` as ${AUDIO_HOW[audio]}` : ''}` : ''}`;
    const run = progress(`${doing} — this takes a moment…`);
    exportRun = { run, what, doing };
    try {
      const r = await fetch(editBase + '/deck/edit/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          ...(theme ? { theme } : gen ? { gen } : {}),
          ...(kind === 'video' ? { slides, format, quality, subtitles, ...videoVoice(voice) } : {}),
          ...(kind === 'bundle' && audio ? { audio } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.unmarked) {
        armMark(j.unmarked, theme, run, { bundles: kind === 'bundle' });
        return;
      }
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      run.done(`wrote ${j.file}${j.seconds ? ` (${j.seconds}s)` : ''}${j.subtitles ? ` · subtitles in ${j.subtitles}` : ''}`
        + `${j.voiced ? ` — its voice is in ${j.voiced}/` : ''}`);
      debugLog('export', `${kind} → ${j.file}`);
    } catch (e) {
      run.done(`could not export to ${what} — ${e.message}`, 5200);
      debugLog('export', `${kind} failed: ${e.message}`);
    } finally {
      exportRun = null;
    }
  }

  // ── the voiceover script, rewritten by the agent ──────────────────────────
  // Two rewrites (cli/enhance.mjs, SPEC PRESENTING): `tags` gives it the audio
  // tags ElevenLabs v4 performs, same words; `spoken` writes it for the ear —
  // terse notes turned into sentences a person would say. The agent drafts
  // (read-only), decklight checks and writes. One run at a time; `scope` is
  // 'slide', 'module' (the data-module chapter this slide is in) or 'all'.
  let enhanceRun = null;
  const ENHANCE_DONE_KEY = 'decklight-enhance-done:' + location.pathname;
  const REWRITES = {
    tags: { doing: 'enhancing', with: ' with ElevenLabs audio tags', drafting: 'drafting audio tags', done: (x) => `enhanced ${x}` },
    spoken: { doing: 'writing for the ear', with: '', drafting: 'rewriting it as spoken sentences', done: (x) => `wrote ${x} for the ear` },
  };
  /**
   * The chapter slide `n` is in — `{ title, from, to }` from the deck's
   * `data-module` markers (DECK_ANATOMY) — or null when the deck has none, or
   * the slide comes before the first.
   */
  function moduleOf(n = instance.state.slide) {
    const secs = [...(instance._sections ?? [])];
    let from = 0, title = null;
    secs.forEach((sec, i) => { if (i + 1 <= n && sec.hasAttribute('data-module')) { from = i + 1; title = sec.getAttribute('data-module'); } });
    if (!from) return null;
    let to = secs.length;
    for (let i = from; i < secs.length; i++) if (secs[i].hasAttribute('data-module')) { to = i; break; }
    return { title, from, to };
  }
  async function enhanceScript(scope = 'slide', { kind = 'tags' } = {}) {
    if (!editAvailable) { toast(needsDevMode(kind === 'spoken' ? 'rewriting the notes' : 'enhancing the script', location), 3200); return; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return; }
    if (enhanceRun) { toast('the agent is already rewriting the script — one run at a time'); return; }
    const k = REWRITES[kind] ?? REWRITES.tags;
    const slide = instance.state.slide;
    const mod = scope === 'module' ? moduleOf(slide) : null;
    if (scope === 'module' && !mod) { toast('this slide is not in a module — the deck marks none before it (data-module)', 4000); return; }
    const slides = scope === 'all' ? 'all'
      : mod ? Array.from({ length: mod.to - mod.from + 1 }, (_, i) => mod.from + i) : [slide];
    const what = scope === 'all' ? 'every slide\'s script'
      : mod ? `the “${mod.title}” module (slides ${mod.from}–${mod.to})` : `slide ${slide}'s script`;
    const run = progress(`${k.doing}: ${what}${k.with} — asking the agent…`);
    enhanceRun = { run, what, kind };
    try {
      const r = await fetch(editBase + '/deck/edit/enhance', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slides, kind }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      enhanceRun.of = j.of;
      run.update(`${k.doing}: ${what} — ${j.label || j.agent} is ${k.drafting} (read-only)…`);
      debugLog('enhance', `${kind}: ${j.of} slide(s) → ${j.agent}`);
    } catch (e) {
      run.done(`could not rewrite ${what} — ${e.message}`, 5200);
      enhanceRun = null;
    }
  }
  /** What a finished run says, in one line. */
  function enhanceSummary(d) {
    const k = REWRITES[d.kind] ?? REWRITES.tags;
    if (!d.ok) return `could not rewrite the script — ${d.error}`;
    const n = d.changed.length;
    const parts = [n ? `${k.done(n === 1 ? `slide ${d.changed[0]}` : `${n} slides`)} — Z undoes` : 'no slide changed'];
    if (d.failed.length) {
      parts.push(d.failed.length === 1 ? `slide ${d.failed[0].slide} left as it was: ${d.failed[0].why}`
        : `${d.failed.length} left as they were (the agent's answer did not pass the check)`);
    }
    if (d.stale.length) parts.push(`${d.stale.length === 1 ? `slide ${d.stale[0]}` : `${d.stale.length} slides`} edited meanwhile, kept`);
    return parts.join(' · ');
  }
  function enhanceEvent(d) {
    if (d.state === 'slide' && enhanceRun) {
      enhanceRun.run.update(`${(REWRITES[enhanceRun.kind] ?? REWRITES.tags).doing}: ${enhanceRun.what} — ${d.done} of ${d.of} slide${d.of === 1 ? '' : 's'}…`);
    } else if (d.state === 'done') {
      const line = enhanceSummary(d);
      if (enhanceRun) enhanceRun.run.done(line, 6000); else toast(line, 6000);
      enhanceRun = null;
      debugLog('enhance', line);
      // a write reloads the page a moment from now — say it again there
      if (d.ok && d.changed.length) {
        try { sessionStorage.setItem(ENHANCE_DONE_KEY, JSON.stringify({ line, at: Date.now() })); } catch { /* said once */ }
      }
    }
  }
  function enhanceSummaryAfterReload() {
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(ENHANCE_DONE_KEY) || 'null'); sessionStorage.removeItem(ENHANCE_DONE_KEY); } catch { /* nothing kept */ }
    if (kept && Date.now() - kept.at < 15000) toast(kept.line, 6000);
  }

  // ── publishing: the one row that reaches off this machine ────────────────
  //
  // Every other hand-over row writes a file next to the deck. This one pushes
  // a page anybody can read, and `Z` does not take that back — so the row is
  // two presses. The first asks the server what publishing WOULD do and says
  // it: the remote, the branch, the URL somebody will be sent. The second,
  // within the arming window, does it. Doing nothing disarms it, which is the
  // cheapest possible "no".
  const PUBLISH_ARM_MS = 20000;
  let publishArmed = 0;
  let publishPlan = null;
  // The confirmed half, on its own: a publish resumed after marking its theme
  // has been confirmed already, and does not ask twice.
  async function publishNow() {
    const { theme } = renderTheme() ?? {};
    if (markConfirmed(theme, { publish: true })) return;
    // The plan already said whether this deck still needs flattening, so the
    // line describes what is actually about to happen rather than the longer
    // of the two things it might be.
    const run = progress(publishPlan?.bundled === false
      ? 'publishing — pushing the deck…'
      : 'publishing — bundling the deck and pushing it…');
    try {
      const r = await fetch(editBase + '/deck/edit/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // the theme on screen is the one the published page opens on
        body: JSON.stringify(theme ? { theme } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (j.unmarked) { armMark(j.unmarked, theme, run, { bundles: true }); return; }
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      run.done(j.url ? `published — ${j.url}` : `published — pushed to ${j.remote} ${j.branch}`, 9000);
      debugLog('publish', j.url ?? `${j.remote} ${j.branch}`);
    } catch (e) {
      run.done(`could not publish — ${e.message}`, 6000);
      debugLog('publish', `failed: ${e.message}`);
    }
  }
  async function publishDeck() {
    // Confirmed already, and stopped only to ask about an unmarked theme: this
    // press answers that question, not the "publish?" one again.
    const markPending = markArmed?.ref && Date.now() - markArmed.at < PUBLISH_ARM_MS;
    if (markPending || (publishArmed && Date.now() - publishArmed < PUBLISH_ARM_MS)) {
      publishArmed = 0;
      await publishNow();
      return;
    }
    try {
      const r = await fetch(editBase + '/deck/edit/publish/plan');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      // Never arm something that cannot happen: publish signs the deck and
      // refuses rather than publishing it unsigned, so a machine that cannot
      // is told now — not after a confirmation the publish was never going to
      // honour. The sentence is the SERVER's, shown as it arrived: the runtime
      // is not allowed to know what does the signing (test/sign.test.mjs).
      if (!j.signing) { toast(`cannot publish — ${j.why}`, 8000); return; }
      publishArmed = Date.now();
      publishPlan = j;
      toast(`publish to ${j.remote} ${j.branch}${j.url ? ` → ${j.url}` : ''}?`
        + ' — pick the row again to confirm', 8000);
    } catch (e) {
      toast(`could not publish — ${e.message}`, 5200);
    }
  }

  return {
    deckHistory,
    /** Hold undo/redo until this write lands — the gestures in authoring.js post outside this module. */
    trackWrite,
    toggleEditor,
    toggleAgentAsk,
    /** E — arm/disarm the right-click element menu (#112). Refuses outside write mode. */
    toggleElementEdit,
    /** Is editing on? The palette's own on/off label and the editing bar ask. */
    elementEditOn: () => elementEditOn,
    /** Be told when E turns editing on or off. */
    onElementEditChange: (fn) => { elementEditListeners.add(fn); },
    /** What a click addresses: `{ sec, slide, index, top, clicked }`, or null. */
    elementTargetOf,
    /** The element menu, opened at a point by something other than a right-click: the bar's ⋯ handle and Slide ▾. */
    openElementMenuAt: (x, y, target, view = 'main', opts = {}) => { if (!elementEditOn) return; overlays.opening(); openElementMenu(x, y, target, view, opts); },
    /** Remove the element a target names: ⌫ on a selection. */
    removeElement: (target) => commitRemove(target),
    /** New / duplicate / delete / up / down on a slide (the current one by default), and `move` to a position — the palette's rows, the menu, the overview. */
    slideOp,
    /** Open an engine's wizard (ENGINES#WIZARD). Refuses outside write mode. */
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
    // — where there is no edit server and no /deck/edit/history/at to preview a commit with —
    // it is "has the author pushed anything since I cloned this".
    history: {
      open: () => (!editAvailable && presenting ? openUpstream() : openHistory()),
      close: () => { closeRestore(); closeUpstream(); },
      list: () => restoreRows.slice(),
    },
    restore: { open: openHistory, close: closeRestore, list: () => restoreRows.slice() },
    /** Can this page change the deck? False with no server, under the read-only server, and while locked. */
    available: () => editAvailable,
    /** Did a server answer at all, and was it the read-only one? The lock row and chip ask. */
    served: () => served,
    readOnly: () => readOnly,
    /** The editing lock (PRESENTING): its state, flipping it, and being told. */
    locked: () => locked,
    toggleLock,
    onLockChange: (fn) => { lockListeners.add(fn); },
    /** Resolves once the probe has an answer either way — see `settled`. */
    settled: () => { if (printMode || params.has('embedded')) probeSettled(); return settled; },
    /** Its origin ('' when the deck is served BY the edit server); null under the read-only one. */
    base: () => (readOnly ? null : editBase),
    /** K: the commit window — what changed, what to call it, one button. */
    commit: { open: openCommit, close: closeCommit, state: () => commitNow },
    /** The palette's hand-over rows: 'pptx' | 'pdf' | 'pdf-notes' | 'pdf-handout'. */
    exportDeck,
    bundleEstimate,
    enhanceScript,
    moduleOf,
    /** The Publish row: the first call asks and arms, the second publishes. */
    publishDeck,
  };
}
