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
// The phone remote is NOT here (NO_TRUST#REMOTE). It hangs off a second, smaller
// probe — wireRemote, below — because it belongs to a server with no
// edit surface at all, and a clicker should never have cost you one.

import { closeOnBackdrop, selectInList } from './overlay.js';
import { reloadLine } from './debuglog.js';
import { conceptOf, pathFrom } from './colorpicker.js';
import { pickNode } from './pick.js';
import { rangeLabel } from './ranges.js';
import { agentChipText, boundedFetch, commitChipParts, commitChipText, commitChipTone, needsDevMode, pushToastText, shortAge } from './devmode.js';
import { dedentHtml } from './htmlfmt.js';
import { createPreview } from './preview.js';
import { readPref, writePref } from './prefs.js';
import { createDock, reopenPanel } from './dock.js';
import { thinking } from './thinking.js';
import { authoredTop, authoredIndex, pageDesignSystems } from './design-system.js';
import { wordDiff, diffCounts } from './worddiff.js';
import { createFixReview, fixReviewOn, setFixReview, askReviewOn, setAskReview } from './fixreview.js';
import { createWritingPicker, WRITING_TOOLS } from './writing.js';
import { writtenMarks } from '../../tools/sentences.mjs';
import { notesParts, withPart, hasClick, partFor, partLabel, wholeWhy } from './notesparts.js';
import { hljs } from '../code/code.js';
import { UNDO_CHORD } from './undo-chord.js';
import { markdownNodes } from './mdtext.js';
import { aiIcon } from './aiicon.js';

/** Wire the dev-server features to a deck. */
export function createEditMode({
  root, config, params, printMode, toast, progress, debugLog, debugReload = () => {}, overlays, instance,
  notesSegs, notesDraft = (sl) => notesSegs(sl).join('\n\n⟨CLICK⟩\n\n'), renderTheme = () => ({}), previewQuery = () => '?embedded',
  knownConcepts = () => [],
  captionsOn = () => false, toggleCaptions = null,
  choiceCard = null,
  speak = null,
}) {
  // ── write mode + live reload — SPEC PRESENTING ───────────────────────────────────
  // Served by the edit server: the deck subscribes to /deck/events and
  // reloads whenever the file changes on disk (any editor works — the
  // #/slide/step hash restores the position). S opens a notes editor whose
  // Save writes the current slide's aside back through the server. Decks
  // opened via file:// probe the server at its default localhost port — the
  // printed URL and a double-clicked file both work; config.edit.url overrides.
  // A basename guard refuses to wire up against a server that's editing a
  // DIFFERENT deck. Nothing here sends a token: the server authorizes on the
  // request's Origin, which the browser stamps for us — a served deck's is its
  // own loopback origin, a file:// deck's is `null`, and both are admitted
  // while a foreign tab's fetch is refused server-side (#222, cli/serve.mjs).
  let editAvailable = false;
  let locked = false;     // the deck's lock (PRESENTING): the server's state, mirrored here
  let served = false;     // a server answered the probe, with trust or without
  let noTrust = false;   // …and it was without trust
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
  // never grows the node, and `--no-trust` never reaches this code at all.
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
  document.addEventListener('fullscreenchange', () => { paintCommitChip(); paintSlideNum(); });
  // The slide you are on, top right, while editing is on (PRESENTING): the
  // number an author needs the whole time the file is theirs to change, in
  // the theme's accent, above the commit chip. It goes with the lock and
  // with fullscreen, which is a rehearsal.
  let slideNum = null;
  function paintSlideNum() {
    const show = editAvailable && !printMode && !document.fullscreenElement;
    root.classList.toggle('has-slide-num', show);
    if (!show) { slideNum?.remove(); slideNum = null; return; }
    if (!slideNum) {
      slideNum = document.createElement('div');
      slideNum.className = 'decklight-slide-num';
      slideNum.setAttribute('aria-hidden', 'true');
      root.appendChild(slideNum);
    }
    slideNum.textContent = `${instance.state.slide} / ${instance.state.totalSlides}`;
  }
  instance.on('slide', paintSlideNum);
  function paintCommitChip() {
    const text = commitChipText(commitNow);
    // fullscreen is a rehearsal: nothing about git belongs on that screen
    const show = !!text && !document.fullscreenElement;
    root.classList.toggle('has-commit-chip', show);
    if (!show) { commitChip?.remove(); commitChip = null; return; }
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
    // the slide counts first, each in its colour, then the sentence
    const parts = commitChipParts(commitNow);
    commitChip.textContent = '⌥ ';
    for (const s of parts.slides) {
      const c = document.createElement('span');
      c.className = `cc-sl cc-sl-${s.kind}`;
      c.textContent = s.text;
      commitChip.append(c, ' ');
    }
    commitChip.append(parts.slides.length ? `· ${parts.text}` : parts.text);
    commitChip.setAttribute('aria-label', text);
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
  async function openCommit({ draft = null } = {}) {
    if (commitEl) return closeCommit();
    if (!editAvailable) { toast(cannot('committing'), 3200); return; }
    const state = (await refreshCommit()) ?? commitNow;
    if (!state?.canWrite) { toast('this session is not committing — open the deck with --git', 3000); return; }
    overlays.opening();
    commitEl = document.createElement('div');
    commitEl.className = 'decklight-narr decklight-commit';
    commitEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Commit"></div>';
    closeOnBackdrop(commitEl, closeCommit);
    root.appendChild(commitEl);
    const card = commitEl.querySelector('.narr-card');
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    // real buttons, one size: the window's own Enter (which commits) never
    // hears a key pressed on one, so Enter on Tag tags and on Push pushes
    const button = (cls, text) => {
      const b = el('button', `cm-btn ${cls}`, text);
      b.type = 'button';
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
      return b;
    };
    // a section: its name on the left of a rule, then its rows
    const section = (cls, name) => {
      const sec = el('div', `cm-sec ${cls}`);
      sec.append(el('div', 'cm-label', name));
      return sec;
    };
    // a typing surface: the deck must not advance under it, but ⌘K still
    // reaches the deck so the shortcut that opened the window closes it
    // Esc closes the window from inside a box too: the deck's key handler
    // never hears a key typed into a field, so a box that swallows Esc is a
    // window that cannot be closed from the keyboard where the caret is
    const typing = (box, onSubmit) => box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeCommit(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) return;
      e.stopPropagation();
    });

    // Three steps, in the order they happen, each a labelled section with its
    // one button at the same right edge: commit the work, tag a commit,
    // push them. Commit is the only filled button; it is the window's point.
    // The window is named for the branch the work lands on: the sections
    // already say what each step is.
    const head = el('div', 'narr-head', state.push?.branch ? `git · ${state.push.branch}` : 'git');
    const what = el('div', 'cm-what');
    // the same work in slides, each count in its colour (painted below)
    const slidesEl = el('div', 'cm-slides');
    slidesEl.hidden = true;
    const input = el('textarea', 'narr-input cm-input');
    input.rows = 3;
    input.placeholder = 'what changed, in one line…';
    // The agent's proposal when it is several commits: one row each, the
    // subject editable, where it lands beside it. Hidden until there is one.
    const planEl = el('div', 'cm-plan');
    planEl.hidden = true;
    const row = el('div', 'cm-line cm-actions');
    // Asked of the agent installed on this machine, and only when pressed —
    // so the button says, before it is pressed, where the changes will go. The
    // agent is named because it is a real program with a real provider behind
    // it: most pass what they are given on to their service. With no agent,
    // or a session started with --no-commit-messages, the button says so
    // rather than offering what the server can only refuse, and the reason
    // (which does not fit on a button) goes on the hint line when pressed.
    const who = state.describer;
    const write = button('cm-write cm-quiet', '');
    // the AI sparkle, then the words: textContent would take the icon away
    const writeLabel = (text) => write.replaceChildren(aiIcon(), text);
    writeLabel(who ? 'write it for me' : state.subjectsOff ? 'write it for me — off' : 'write it for me — no agent');
    if (!who) write.classList.add('cm-off');
    if (who) {
      write.title = `Sends the deck's uncommitted changes to ${who.name} (${who.label}), the agent installed`
        + ' on this machine, which may pass them to its provider. It proposes one commit, or several when the changes are separate ideas.';
    }
    const single = button('cm-single cm-quiet', 'as one commit');
    single.hidden = true;
    single.title = 'set the proposed commits aside and write one message for all of it';
    const go = button('cm-go cm-primary', 'Commit');
    // the message's own tools sit on its label line, where they act
    const msgHead = el('div', 'cm-line cm-msg-head');
    const msgTools = el('span', 'cm-tools');
    msgTools.append(single, write);
    msgHead.append(el('span', 'cm-sub', 'message'), msgTools);
    row.append(el('span', 'cm-keys', '⌘⏎'), go);
    // what only exists while there is something to commit
    const body = el('div', 'cm-body');
    body.append(msgHead, input, planEl, row);
    const secCommit = section('cm-sec-commit', 'commit');
    secCommit.append(what, slidesEl, body);

    // Tag and push: what happens to the work once it is committed. Both read
    // the status route's `tags` and `push`, and both work with nothing to
    // commit — tagging what is there, pushing what is not on the remote yet.
    const tagRow = el('div', 'cm-line cm-tagrow');
    const tagInput = el('input', 'narr-input cm-tag');
    tagInput.type = 'text';
    tagInput.placeholder = 'tag the last commit, e.g. v1.0';
    tagInput.setAttribute('aria-label', 'Tag name');
    const tagGo = button('cm-tag-go', 'Tag');
    const tagsNow = el('span', 'cm-tags');
    tagRow.append(tagInput, tagGo);
    const secTag = section('cm-sec-tag', 'tag');
    secTag.append(tagRow, tagsNow);
    const pushRow = el('div', 'cm-line cm-pushrow');
    const pushWhat = el('span', 'cm-push-what');
    const pushGo = button('cm-push-go', 'Push');
    pushRow.append(pushWhat, pushGo);
    const secPush = section('cm-sec-push', 'push');
    secPush.append(pushRow);

    const hint = el('div', 'rec-hint', 'Esc closes · the work is snapshotted either way');
    card.append(head, secCommit, secTag, secPush, hint);

    let now = state;
    const paintWhat = () => {
      const dirty = !!now.dirty;
      body.hidden = !dirty;
      slidesEl.hidden = true;
      if (!dirty) { planEl.hidden = true; what.textContent = 'nothing to commit — the deck matches its last commit'; return; }
      const n = Number(now.lines) || 0;
      const mins = Math.floor((Number(now.sinceMs) || 0) / 60000);
      // WHICH files: the sidecar rides the deck's commits (REVIEW), and a
      // resolve the author pressed R for is "1 line in talk.review.jsonl",
      // not a line in a deck that did not change
      const files = Array.isArray(now.files) && now.files.length ? now.files : [now.deck || 'the deck'];
      const where = files.length === 1 ? files[0] : `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
      what.textContent = `${n ? `${n} line${n === 1 ? '' : 's'}` : 'changes'} in ${where}`
        + (mins >= 1 ? `, ${mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`} old` : '');
      // and in slides, each count in its colour: changed, added, removed —
      // all three, a zero dimmed, so the line reads the same way every time
      const sl = now.slides;
      if (sl && (sl.changed || sl.added || sl.removed)) {
        const total = sl.changed + sl.added + sl.removed;
        slidesEl.textContent = '';
        slidesEl.append(el('span', 'cm-sl-head', `${total === 1 ? '1 slide' : `${total} slides`}`));
        for (const k of ['changed', 'added', 'removed']) {
          const c = el('span', `cm-sl cm-sl-${k}`, `${sl[k]} ${k}`);
          if (!sl[k]) c.classList.add('cm-sl-zero');
          slidesEl.append(c);
        }
        slidesEl.hidden = false;
      }
    };
    const paintTagsAndPush = () => {
      const tags = Array.isArray(now.tags) ? now.tags : [];
      // with Push tags off (Settings…) a tag made here is not going anywhere
      // on Push, and the window says so rather than letting it look sent
      tagsNow.textContent = tags.length ? `on it: ${tags.join(', ')}${pushTagsOn() ? '' : ' · not pushed'}` : '';
      tagsNow.hidden = !tags.length;
      const p = now.push;
      const n = Number(p?.ahead) || 0;
      // nothing to send: no commit ahead, a branch already there, and no tag
      // that Push would carry — the button is off rather than a no-op
      const idle = !!p && !p.blocked && !n && p.state !== 'no-upstream' && !(tags.length && pushTagsOn());
      pushGo.classList.toggle('cm-off', !p || !!p.blocked);
      pushGo.disabled = idle;
      if (!p) { pushWhat.textContent = 'git cannot say where this branch stands'; return; }
      if (p.blocked) { pushWhat.textContent = p.blocked; return; }
      const commits = `${n} commit${n === 1 ? '' : 's'}`;
      pushWhat.textContent = p.state === 'no-upstream'
        ? `${p.branch} is not on ${p.remote} yet${n ? ` · ↑${commits}` : ''}`
        : n ? `↑${commits} not on ${p.upstream}` : `up to date with ${p.upstream}`;
    };
    paintWhat();
    paintTagsAndPush();
    setTimeout(() => (now.dirty ? input : tagInput).focus(), 0);

    // The agent's draft. Never overwrites what you have already typed: it is a
    // proposal, and a proposal that eats your sentence is not one. While it is
    // being written the box says so where the subject will land, and the
    // button with it — moving, so a slow agent never reads as a stuck window.
    const placeholder = input.placeholder;
    const HINT = hint.textContent;
    const say = (text) => { hint.textContent = text; hint.classList.add('cm-why'); };
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
    let plan = null;   // { base, commits: [{ subject, units, take }], units } while several are proposed
    // the button says how many of the proposed commits a press makes: all of
    // them, some of them (an unticked one stays uncommitted), or none
    const planLabel = (p) => {
      const n = p.commits.length;
      const k = p.commits.filter((c) => c.take).length;
      return k === n ? (n === 1 ? 'Commit' : `Commit all ${n}`) : k ? `Commit ${k} of ${n}` : 'Commit';
    };
    const paintGo = () => {
      go.textContent = plan ? planLabel(plan) : 'Commit';
      go.disabled = !!plan && !plan.commits.some((c) => c.take);
    };
    // where a commit lands: its units' slides as one run ("slides 5-6"),
    // and any file that is not a slide (the sidecar) by its name
    const unitsWhere = (ids) => {
      const byId = new Map((plan?.units ?? []).map((u) => [u.id, u]));
      const units = ids.map((id) => byId.get(id)).filter(Boolean);
      const slides = [...new Set(units.flatMap((u) => u.slides ?? []))].sort((a, b) => a - b);
      const other = [...new Set(units.filter((u) => !u.slides?.length).map((u) => u.where).filter(Boolean))];
      const run = slides.every((n, i) => i === 0 || n === slides[i - 1] + 1);
      const said = !slides.length ? [] : slides.length === 1 ? [`slide ${slides[0]}`]
        : [run ? `slides ${slides[0]}-${slides[slides.length - 1]}` : `slides ${slides.join(', ')}`];
      return [...said, ...other].join(' · ');
    };
    const showPlan = (p) => {
      plan = p;
      planEl.textContent = '';
      planEl.hidden = !p;
      input.hidden = !!p;
      single.hidden = !p;
      if (!p) { paintGo(); return; }
      p.commits.forEach((c, i) => {
        const line = el('div', 'cm-plan-row');
        // ticked: this one is made now; unticked: it stays uncommitted, and
        // the window offers it again once the others have landed
        if (c.take === undefined) c.take = true;
        const pick = el('input', 'cm-plan-take');
        pick.type = 'checkbox';
        pick.checked = c.take;
        pick.title = 'commit this one now — untick it to leave it uncommitted';
        pick.setAttribute('aria-label', `Include commit ${i + 1}`);
        pick.addEventListener('change', () => {
          c.take = pick.checked;
          line.classList.toggle('cm-plan-off', !c.take);
          paintGo();
        });
        line.classList.toggle('cm-plan-off', !c.take);
        const box = el('input', 'narr-input cm-plan-subject');
        box.type = 'text';
        box.value = c.subject;
        box.placeholder = 'what this commit changed…';
        box.setAttribute('aria-label', `Commit ${i + 1} of ${p.commits.length}`);
        box.addEventListener('input', () => { c.subject = box.value; });
        typing(box, () => commit());
        line.append(pick, el('span', 'cm-plan-n', String(i + 1)), box, el('span', 'cm-plan-where', unitsWhere(c.units)));
        planEl.append(line);
      });
      paintGo();
      setTimeout(() => planEl.querySelector('input')?.focus(), 0);
    };
    // "one commit": the proposal set aside, its first subject offered in the box
    single.addEventListener('click', () => {
      const first = plan?.commits?.[0]?.subject ?? '';
      showPlan(null);
      if (first && !input.value.trim()) input.value = first;
      input.focus();
    });
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
        let r = await fetch(editBase + '/deck/edit/commit/plan', { method: 'POST' });
        let j = await r.json();
        // a first commit cannot be cut against nothing: it is one subject
        if (j?.code === 'FIRST') {
          r = await fetch(editBase + '/deck/edit/commit/subject', { method: 'POST' });
          j = await r.json();
          if (j?.ok) j = { ok: true, commits: j.subject ? [{ subject: j.subject, units: [] }] : [] };
        }
        if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        if (!commitEl) return;
        const commits = Array.isArray(j.commits) ? j.commits : [];
        if (j.unread) debugLog('git', `couldn't read the agent's answer: ${JSON.stringify(String(j.answer ?? ''))}`);
        if (commits.length > 1) {
          showPlan({ base: j.base, units: j.units ?? [], commits: commits.map((c) => ({ subject: String(c.subject ?? ''), units: c.units ?? [] })) });
          writeLabel('write it again');
        } else {
          showPlan(null);
          const subject = commits[0]?.subject;
          if (subject && !input.value.trim()) input.value = subject;
          // "nothing to say" is for a tree with nothing to describe; an answer
          // the server could not read says so (#908)
          if (subject) writeLabel('write it again'); else write.textContent = j.unread ? "couldn't read the agent's answer" : 'nothing to say about it';
        }
      } catch (e) {
        // the whole sentence, where there is room for it — a reason cut at forty
        // characters on a button is a reason nobody can act on
        if (commitEl) {
          write.textContent = "couldn't write one";
          say(String(e.message || e));
        }
      } finally {
        stop();
        write.classList.remove('cm-thinking');
        input.placeholder = placeholder;
        commitAsking = false;
      }
    };
    write.addEventListener('click', ask);
    // a reviewed fix drafted its own message (#907): offered, editable, not committed
    if (draft && state.dirty) { input.value = draft; input.rows = Math.min(8, Math.max(3, draft.split('\n').length)); }
    else if (state.messages && who && state.dirty) ask();   // drafted on open only with --commit-messages

    // After a commit the window stays when there is somewhere to push it —
    // commit, then push, is one visit — and closes when there is not.
    // A commit that left work out (unticked rows) keeps the window too, with
    // those rows offered again, re-cut against the new HEAD by the server.
    const landed = (j, text) => {
      commitNow = { ...j, nag: false };
      paintCommitChip();
      toast(text, 2600);
      const more = !!j.dirty;
      if (!more && (!j.push || j.push.blocked)) { closeCommit(); return; }
      now = { ...now, ...j, dirty: more };
      input.value = '';
      paintWhat();
      showPlan(j.left ? { base: j.left.base, units: j.left.units ?? [], commits: j.left.commits.map((c) => ({ subject: String(c.subject ?? ''), units: c.units ?? [] })) } : null);
      if (more && !j.left) writeLabel('write it again');
      what.textContent = more ? `${text} · the rest is still uncommitted` : text;
      paintTagsAndPush();
      setTimeout(() => (more ? (planEl.querySelector('.cm-plan-subject') ?? input) : pushGo).focus(), 0);
    };
    const commit = async () => {
      if (!now.dirty) return;
      const several = plan;
      const message = input.value.trim();
      const taking = several ? several.commits.filter((c) => c.take) : [];
      if (several && !taking.length) return;
      if (several ? taking.some((c) => !c.subject.trim()) : !message) {
        (several ? [...planEl.querySelectorAll('.cm-plan-row:not(.cm-plan-off) .cm-plan-subject')].find((b) => !b.value.trim()) : input)?.focus();
        return;
      }
      go.textContent = 'committing…';
      try {
        const r = several
          ? await fetch(editBase + '/deck/edit/commit/split', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base: several.base, commits: several.commits.map((c) => ({ message: c.subject.trim(), units: c.units, skip: !c.take })) }),
          })
          : await fetch(editBase + '/deck/edit/commit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message }),
          });
        const j = await r.json();
        if (!j?.ok) {
          // the work moved while the agent was thinking: its plan is for other work
          if (j?.code === 'STALE') { showPlan(null); writeLabel('write it again'); }
          throw new Error(j?.error || `HTTP ${r.status}`);
        }
        if (!j.committed) { closeCommit(); toast('nothing to commit', 2600); return; }
        debugLog('git', several ? `commit: ${j.count} commits` : `commit: ${j.subject}`);
        landed(j, several && j.count > 1 ? `committed ${j.count} — "${j.subjects[0]}" and ${j.count - 1} more` : `committed — "${j.subject}"`);
      } catch (e) {
        paintGo();
        say(`couldn't commit — ${String(e.message || e)}`);
      }
    };
    go.addEventListener('click', commit);
    typing(input, commit);

    const tag = async () => {
      const name = tagInput.value.trim();
      if (!name) { tagInput.focus(); return; }
      tagGo.textContent = 'tagging…';
      try {
        const r = await fetch(editBase + '/deck/edit/commit/tag', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
        });
        const j = await r.json();
        if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        now = { ...now, tags: j.tags, push: j.push };
        tagInput.value = '';
        paintTagsAndPush();
        toast(`tagged ${j.tag} — Push sends it with the branch`, 2600);
        debugLog('git', `tag: ${j.tag}`);
      } catch (e) {
        say(`couldn't tag — ${String(e.message || e)}`);
      } finally { tagGo.textContent = 'Tag'; }
    };
    tagGo.addEventListener('click', tag);
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeCommit(); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); tag(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) return;
      e.stopPropagation();
    });

    let pushingNow = false;
    const push = async () => {
      if (pushingNow) return;
      if (!now.push || now.push.blocked) { if (now.push?.blocked) say(now.push.blocked); return; }
      pushingNow = true;
      const stop = thinking((text) => { pushGo.textContent = text; }, { label: 'pushing' });
      try {
        const r = await fetch(editBase + '/deck/edit/commit/push', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tags: pushTagsOn() }),
        });
        const j = await r.json();
        if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        now = { ...now, tags: j.tags, push: j.push };
        paintTagsAndPush();
        toast(`pushed ${j.branch} to ${j.remote}${j.pushedTags === false ? ' · tags kept here' : ''}`, 2600);
        debugLog('git', `push: ${j.branch} → ${j.remote}`);
      } catch (e) {
        say(`couldn't push — ${String(e.message || e)}`);
      } finally {
        stop();
        pushGo.textContent = 'Push';
        pushingNow = false;
      }
    };
    pushGo.addEventListener('click', push);

    overlaysCommit ??= overlays.register({
      isOpen: () => !!commitEl,
      close: closeCommit,
      keydown(e) {
        if (e.key === 'Escape') { closeCommit(); return true; }
        if (/^(input|textarea|button)$/i.test(e.target?.tagName ?? '')) return false;
        if (e.key === 'Enter') {
          const b = commitEl?.querySelector('.cm-go');
          if (b && !b.closest('[hidden]')) b.click();
          return true;
        }
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
  let probed = false;   // the probe has answered, either way
  const settled = new Promise((r) => { probeSettled = () => { probed = true; r(); }; });
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
          // The one server in no-trust mode: nothing here edits, and the
          // page wires up what a deck opened without trust gets (the clicker, the
          // upstream readout) and nothing else. Every affordance gated on
          // `available()` keeps saying it needs write mode, because it does.
          if (j.noTrust) {
            served = true;
            noTrust = true;
            probeSettled();
            await wireRemote(base, j);
            return;
          }
          served = true;
          editBase = base;
          locked = j.locked === true;
          editAvailable = !locked;
          paintLockChip();
          syncEditing();   // editing is on from the moment write mode answers
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
          // Said once per session, and only when there is enough of it to be
          // worth interrupting for. A session that STARTS forty commits behind
          // hears it immediately rather than waiting for the next commit.
          const pushMsg = pushToastText(j.remote);
          if (pushMsg) { pushToastShown = true; toast(pushMsg, 4200); }
          // What is uncommitted, as of this load: a deck reopened mid-session
          // shows the chip immediately instead of waiting for the next tick.
          if (j.commit) { commitNow = j.commit; paintCommitChip(); }
          agentBusy = j.agentBusy || null; // an agent may already be mid-run across a reload
          // …and so may an export, an enhancement or a review: the palette's
          // Stop row offers to stop it whether or not this page started it
          exportBusy = j.exportBusy || null;
          enhanceBusy = !!j.enhanceBusy;
          reviewBusy = !!j.reviewBusy;
          agentAsks = Array.isArray(j.agentAsks) ? j.agentAsks : [];
          if (agentBusy) toast(`${agentBusy.agent} is editing the deck…`, 2000);
          // The chip is restored too, with the SERVER's startedAt — a reload
          // mid-run is exactly when "is it still going?" is hardest to answer.
          paintAgentChip();
          reopenAgentAsk();   // a docked agent card open before the reload is open after it
          reopenNotes();      // …and the notes card a save reloaded, where the author was
          reopenContentEditor();   // …and the HTML editor, on the element its ⌘⏎ saved
          reopenPanel(root);       // …and whichever other panel held the slot (the inspector)
          const es = new EventSource(base + '/deck/events');
          // the server says what wrote the file; the debug log keeps it across the reload
          es.onmessage = (ev) => { debugReload(reloadLine(ev.data, PAGE_ID)); location.reload(); };
          // the lock turned, in this tab or another: every page follows
          es.addEventListener('lock', (ev) => {
            try { setLocked(JSON.parse(ev.data).locked === true); } catch { /* malformed */ }
          });
          // The phone remote is the server's in either mode (NO_TRUST#REMOTE):
          // with --remote, write mode gets the clicker and the QR too.
          wireClicker(base, es, j);
          // A notes save is not a reload: every open view of the deck gets
          // the slide's new notes and puts them in place (narration, the
          // speaker view, a notes card left open in another tab)
          // the deck's theme, picked on another page: follow it, no reload
          es.addEventListener('theme', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.from !== PAGE_ID && typeof d.theme === 'string') root.dispatchEvent(new CustomEvent('decklight:theme', { detail: { theme: d.theme } }));
            } catch { /* malformed: the next reload settles it */ }
          });
          // colours or type picked in another page's inspector, written in
          // place there: this page has the old ones, and reloads for the new
          es.addEventListener('styles', (ev) => {
            try { if (JSON.parse(ev.data).from !== PAGE_ID) location.reload(); } catch { /* malformed: the next reload settles it */ }
          });
          // text, code or a label saved in place on another page: this page
          // has the old words, and reloads for the new
          es.addEventListener('content', (ev) => {
            try { if (JSON.parse(ev.data).from !== PAGE_ID) location.reload(); } catch { /* malformed: the next reload settles it */ }
          });
          // a layout picked on another page: put it on the slide here, no reload
          es.addEventListener('layout', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.from !== PAGE_ID) root.dispatchEvent(new CustomEvent('decklight:layout', { detail: { slide: d.slide, layout: d.layout } }));
            } catch { /* malformed: the next reload settles it */ }
          });
          // the deck's concept colours, pinned on another page: repaint here, no reload (#718)
          es.addEventListener('concepts', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.from !== PAGE_ID && d.concepts && typeof d.concepts === 'object') root.dispatchEvent(new CustomEvent('decklight:concepts', { detail: { concepts: d.concepts } }));
            } catch { /* malformed: the next reload settles it */ }
          });
          // a quick fix under review was adjusted by the agent (#907)
          es.addEventListener('candidate', (ev) => {
            try { fixReview.update(JSON.parse(ev.data)); } catch { /* malformed: Esc and fix again */ }
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
                // a fix held for review (#907): nothing landed, the review opens on it
                if (d.candidate) {
                  if (!d.candidate.adjusted) {
                    toast(`🤖 ${d.agent} proposed an edit — review it before it lands${status}`, 3000);
                    fixReview.open(d.candidate.id);
                  }
                } else toast(d.stopped ? `🤖 ${d.agent} stopped${d.changed ? ` — what it had written stays, ${UNDO_CHORD} undoes` : ' — no changes'}`
                  : d.changed ? `🤖 ${d.agent} edited the deck — ${UNDO_CHORD} undoes${status}`
                    : `🤖 ${d.agent} finished — no changes${status}`, d.stopped && d.changed ? 5200 : 3000);
                debugLog('agent', `${d.agent} done ok=${d.ok} changed=${d.changed}${status}`);
                // A recording the edit orphaned or staled — held longer and on
                // its own line, because it is the one thing here you might act
                // on and it is easy to miss behind the ordinary "edited" toast.
                // The voice folders that followed the slides it added, removed
                // or moved (#920), or could not, are said with it.
                const voiceLines = [d.voicesStuck, d.voicesFollowed && `🎙 ${d.voicesFollowed}`, d.recordingWarning]
                  .filter((l) => typeof l === 'string' && l);
                if (voiceLines.length) {
                  toast(voiceLines.join(' · '), 9000);
                  for (const l of voiceLines) debugLog('agent', l);
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
          // The agent review (cli/agent-review.mjs): progress, then the findings, for Check deck…
          es.addEventListener('review', (ev) => {
            try { reviewEvent(JSON.parse(ev.data)); } catch { /* malformed event */ }
          });
          // The marketplace auto-check landed (MARKETPLACES_SCREEN): the deck offers what it found
          es.addEventListener('marketplaces', (ev) => {
            let d = {};
            try { d = JSON.parse(ev.data); } catch { /* malformed event */ }
            debugLog('marketplace', `auto-check: ${d.summary ?? 'answered'}`);
            for (const fn of marketplaceListeners) fn(d);
          });
          // Progress for a long export — the row that started it is still on
          // screen, so this rewrites that row rather than adding one per slide.
          es.addEventListener('export', (ev) => {
            try {
              const d = JSON.parse(ev.data);
              if (d.state === 'start') exportBusy = { kind: d.kind, what: d.what };
              else if (d.state === 'done') exportBusy = null;
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
          // a quick fix waiting for review when this page loaded: back to it (#907)
          if (j.candidate?.id) fixReview.open(j.candidate.id);
          else commitDraftAfterReload();
          loadReview().then((r) => { for (const fn of reviewListeners) fn(r); });
          return;
        } catch { /* not served by the edit server */ }
      }
      probeSettled();   // asked everything, wired up nothing
    })();
  }

  // ── the lock (PRESENTING) ─────────────────────────────────────────────────
  // Editing is on from the moment write mode answers; the lock is the one
  // switch that turns changes off, to avoid making one by mistake, and back
  // on. The state is the SERVER's (POST /deck/edit/lock), so every tab and
  // the agent see the same thing; this is what the page shows of it: a chip
  // while locked, the bar gone, and every author affordance saying so, since
  // `available()` is false until it is lifted.
  /**
   * Why this page cannot write right now, for a toast. Three answers, in the
   * order they are true: the deck is locked (your own, and a click away),
   * it was opened without trust (the flag's doing, and the flag's to undo),
   * or nothing serves it that takes edits (the command to run).
   */
  function cannot(what) {
    // Every write reloads every page, and a key pressed in the moment between
    // the reload and the new page's probe answering finds no server YET: that
    // is not "run decklight", it is "one moment".
    if (!probed) return `one moment — the deck is still connecting to its server; ${what} again`;
    if (served && locked) return `the deck is locked — unlock it from the palette or the 🔒 chip, then ${what}`;
    if (served && noTrust) return `this deck is open without trust — ${what} needs write mode: open it again and say you trust it, or pass --trust`;
    return needsDevMode(what, location);
  }
  let lockChip = null;
  function paintLockChip() {
    if (!locked || !served || noTrust) { lockChip?.remove(); lockChip = null; return; }
    if (!lockChip) {
      lockChip = document.createElement('div');
      lockChip.className = 'decklight-lock-chip';
      lockChip.setAttribute('role', 'status');
      lockChip.tabIndex = 0;
      lockChip.title = 'the deck is locked: nothing you do here changes the file — click to unlock';
      const flip = () => toggleLock();
      lockChip.addEventListener('click', flip);
      lockChip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      root.appendChild(lockChip);
    }
    lockChip.textContent = '🔒 locked — click to unlock';
  }
  function setLocked(on) {
    if (on === locked) return;
    locked = on;
    editAvailable = served && !noTrust && !locked;
    syncEditing();   // the bar and its selection go with the capability
    paintLockChip();
    for (const fn of lockListeners) fn(locked);
    toast(locked ? 'deck locked — nothing changes the file until you unlock it' : 'deck unlocked', 2600);
  }
  const lockListeners = new Set();
  /** Flip the lock on the server; every page, this one included, follows the channel. */
  async function toggleLock(want = !locked) {
    if (!served || noTrust) { toast('this deck is open without trust (--no-trust) — there is no lock to turn', 3000); return; }
    try {
      const r = await fetch(editBase + '/deck/edit/lock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked: want }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      setLocked(j.locked === true);
    } catch (e) {
      toast(`could not ${want ? 'lock' : 'unlock'} the deck — ${e.message}`, 4000);
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
  // ── the deck update overlay (H, no-trust mode) — SPEC NO_TRUST#UPSTREAM ─────
  //
  // The author's H is the deck's own history. A PRESENTED deck has no history
  // to show — there is no edit server and no /deck/edit/history/at to preview a commit with
  // — so the same key answers the question that IS live there: has the person
  // who wrote this pushed anything since I cloned it?
  //
  // It never draws on the slides. no-trust mode is right that the audience cannot
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
        if (out.reload) { debugReload('git pull'); return location.reload(); }
        // A pull that DEGRADED the label does not reload itself: swapping the
        // bytes executes nothing, so the choice to show them can wait for a
        // second, informed click.
        await renderUpstream({ ...out, commits: [], message: out.message });
        if (out.state === 'pulled') button('show it anyway', () => { debugReload('git pull — shown anyway'); location.reload(); });
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

  /** The clicker: the phone's taps arrive on the deck's stream, the position goes back. Either mode. */
  function wireClicker(base, es, j) {
    instance.__remoteQr = j.phone ? `${base || location.origin}/deck/remote/qr.svg` : null;
    es.addEventListener('remote', (ev) => {
      try {
        const { key } = JSON.parse(ev.data);
        // the voice recorder takes the tap while a beat is being captured (#848)
        if (instance.__recorder?.remote(key)) return;
        if (key === 'next') instance.next();
        else if (key === 'prev') instance.prev();
      } catch { /* malformed event */ }
    });
    const postPos = () => {
      fetch(base + '/deck/remote/pos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `rec`: the beat the voice recorder is capturing, or null — the phone
        // shows it, so recording needs no glance at the laptop (#848)
        body: JSON.stringify({ i: instance.state.slide, n: instance.state.totalSlides, rec: instance.__recorder?.state ?? null }),
      }).catch(() => {});
    };
    if (instance.__recorder) instance.__recorder.onChange = postPos;
    instance.on('slide', postPos);
    instance.on('build', postPos);
    postPos();
  }

  async function wireRemote(base, j) {
    try {
      // H in no-trust mode. The routes only exist when the deck is a tracked
      // file in a clone with an upstream, so this base is enough to tell: a
      // deck that is not one gets a 404/405 and H says so, rather than the
      // overlay existing and being permanently empty.
      deckBase = base;
      presenting = true;
      const es = new EventSource(base + '/deck/events');
      // No `onmessage` handler: the unnamed `reload` message is write mode's,
      // and no-trust mode never sends one — it serves the audited bytes.
      wireClicker(base, es, j);
      debugLog('remote', `remote connected${base ? ` (${base})` : ''} — no edit surface`);
    } catch { /* not served */ }
  }

  // ── edits in flight ──────────────────────────────────────────────────────
  // Undo queues behind a write that has not landed yet. Every gesture that edits
  // the deck answers asynchronously — a double-click save fetches the element's
  // source before it posts, a slide op waits on the server — and a Z pressed in
  // that window reached the server FIRST: "nothing to undo", and then the edit
  // landed anyway, un-undoable from where the author stood. Agent runs are not
  // tracked: they can take minutes, and Z must not wait on one.
  const inflight = new Set();
  // …and whoever shows the deck's state (Check deck…) hears that one landed,
  // so a list of problems is read again after the write that may have fixed one
  const writeListeners = new Set();
  function trackWrite(p) {
    inflight.add(p);
    const done = () => { inflight.delete(p); for (const fn of writeListeners) { try { fn(); } catch { /* a listener's own */ } } };
    p.then(done, done);
    return p;
  }
  // Bounded: a write queued behind a saturated socket pool would otherwise hold
  // Z hostage forever, and its own catch path (the "save failed" toast) would
  // never run — see boundedFetch.
  const writeFetch = (url, init) => trackWrite(boundedFetch(url, init));

  // ── a quick fix, reviewed before it lands (#907, fixreview.js) ───────────
  // Check deck…'s fixes are held by the server as a candidate; this is the
  // two-pane view that walks it, decides it slide by slide and applies it.
  const fixReview = createFixReview({
    root, overlays, toast, base: () => editBase, previewQuery, captionsOn, toggleCaptions, writeFetch, speak,
  });
  const FIX_COMMIT_KEY = 'decklight-fix-commit:' + location.pathname;
  /** The page a reviewed apply reloaded: the commit window, its message drafted. */
  function commitDraftAfterReload() {
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(FIX_COMMIT_KEY) || 'null'); sessionStorage.removeItem(FIX_COMMIT_KEY); } catch { /* nothing kept */ }
    if (!kept?.subject || Date.now() - kept.at > 30000) return;
    debugLog('check', `reviewed fix applied — ${kept.said ?? kept.subject}`);
    if (!commitNow?.canWrite) return;   // no git in this session: the toast before the reload said it all
    openCommit({ draft: kept.body ? `${kept.subject}\n\n${kept.body}` : kept.subject });
  }
  function toggleFixReview() {
    const on = !fixReviewOn();
    setFixReview(on);
    toast(on ? 'quick fixes: reviewed side by side before they land' : 'quick fixes: land at once, as one undo entry and one commit', 2800);
  }
  function toggleAskReview() {
    const on = !askReviewOn();
    setAskReview(on);
    toast(on ? 'agent asks: reviewed side by side before they land' : 'agent asks: land at once, as one undo entry and one commit', 2800);
  }

  // undo/redo (Z / ⇧Z) — the dev server's edit history: layout picks, notes
  // saves, and agent runs all snapshot into ONE stack, wholly independent of
  // the git autocommits. The server writes the restored file; its watcher
  // then reloads every browser (the hash keeps the position).
  async function deckHistory(dir) {
    if (!editAvailable) {
      toast(cannot(dir), 3200);
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
    getEl: () => agentEl,
    closeLabel: 'close (esc)',
    name: 'Agent',
    open: () => { if (!agentEl) toggleAgentAsk(); },
    close: () => { if (agentEl) toggleAgentAsk(); },
    // with no agent CLI it still opens when there is something to show: a
    // migration decklight ran itself is recorded here (DESIGN_SYSTEM_MIGRATIONS)
    available: () => editAvailable && (editAgents.length > 0 || agentAsks.length > 0),
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
    if (open && !agentEl && !agentDock.isFloat() && (editAgents.length || agentAsks.length)) toggleAgentAsk();
  }
  /** One past ask, as the card lists it: where it was asked, what, and what came of it. */
  function askRow(a) {
    const row = document.createElement('div');
    row.className = `agent-ask agent-ask-${a.state === 'running' ? 'running' : a.ok ? 'ok' : 'failed'}`;
    const meta = document.createElement('div');
    meta.className = 'agent-ask-meta';
    const at = new Date(a.startedAt || Date.now());
    meta.textContent = [a.slide ? `slide ${a.slide}` : null, a.title, a.agent,
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
    if (a.state === 'running') out.textContent = `working…${a.activity ? ` ${a.activity}` : ''}`;
    else {
      out.textContent = a.error ? `failed — ${a.error}` : !a.ok ? `failed (exit ${a.code ?? '?'})` : a.kind === 'explain' ? 'explained — nothing changed' : a.changed ? (a.kind === 'migrate' ? 'migrated the deck' : a.kind === 'fix' ? 'fixed the deck' : 'edited the deck') : 'no changes';
      // what the agent said, in the markdown it said it in: **bold** shown
      // bold, never as asterisks (mdtext.js builds nodes, never markup)
      const tail = (a.tail || '').trim();
      if (tail) {
        const md = document.createElement('div');
        md.className = 'agent-ask-md';
        md.append(...markdownNodes(tail));
        out.append(md);
      }
      // the way on from an explanation: the fix, one click away
      if (a.kind === 'explain' && a.ok && a.follow) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'agent-ask-fix';
        fix.append(aiIcon(), 'Fix it');
        fix.title = 'the agent makes the fix: one edit, one undo entry, one commit';
        fix.addEventListener('click', () => askAgent({ ...a.follow, review: true }));
        out.append(fix);
      }
      // what the run created beside the deck and left there, kept out of its commit
      if (a.left?.length) out.append(Object.assign(document.createElement('div'), { textContent: `left beside the deck, not committed: ${a.left.join(', ')}` }));
    }
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
      toast(cannot('asking an agent'), 3200);
      return;
    }
    if (!editAgents.length && !agentAsks.length) {
      toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600);
      return;
    }
    const canAsk = editAgents.length > 0;
    const { el, card } = typingCard('agent', agentDock,
      canAsk ? 'ask an agent — edits the deck file · ⌘⏎ sends' : 'what decklight ran — no agent CLI on this machine to ask', toggleAgentAsk);
    agentEl = el;
    // what was asked this session and what came of it — newest at the bottom,
    // right above where the next one is typed
    const log = document.createElement('div');
    log.className = 'agent-log';
    if (!canAsk) {
      // nothing to type to: the log alone, for what this server ran itself
      paintAsks = () => {
        log.replaceChildren(...agentAsks.map(askRow));
        log.scrollTop = log.scrollHeight;
      };
      paintAsks();
      card.append(log);
      unmountAgent = mountTypingCard(el, agentDock);
      if (!agentDock.isFloat()) rememberAgentOpen(true);
      return;
    }
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
        paintModel();
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
    // The model it runs on (#918), remembered per agent beside the preference
    // and for decklight's runs only: empty is the agent's own default. An
    // agent whose CLI has no model flag shows the field disabled and says so,
    // rather than taking a value it would ignore.
    const model = document.createElement('input');
    model.className = 'narr-input agent-model';
    model.spellcheck = false;
    model.size = 12;
    model.setAttribute('aria-label', 'model');
    const suggest = document.createElement('datalist');
    suggest.id = 'decklight-agent-models';
    model.setAttribute('list', suggest.id);
    function paintModel() {
      const a = editAgents.find((x) => x.name === pickedAgent);
      const can = a?.takesModel !== false;
      model.disabled = !can;
      model.value = can && typeof a?.model === 'string' ? a.model : '';
      model.placeholder = can ? 'default model' : 'no model flag';
      model.title = can
        ? `the model ${a?.label ?? 'the agent'} runs on for decklight — empty for its own default`
        : `${a?.label ?? 'this agent'} takes no model flag: it runs on its own default`;
      suggest.replaceChildren(...(Array.isArray(a?.suggest) ? a.suggest : []).map((m) => {
        const o = document.createElement('option');
        o.value = m;
        return o;
      }));
    }
    model.addEventListener('change', async () => {
      const a = editAgents.find((x) => x.name === pickedAgent);
      if (!a || a.takesModel === false) return;
      const wanted = model.value.trim() || null;
      try {
        const res = await fetch(editBase + '/deck/edit/agent/model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: a.name, model: wanted }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || res.status);
        a.model = j.model ?? null;
        toast(`${a.label}: ${a.model ? `runs on ${a.model}` : 'its own default model'}`, 1800);
        debugLog('agent', `${a.name} model → ${a.model ?? 'default'}`);
      } catch (e) {
        toast(`model not saved: ${String(e.message || e).slice(0, 60)}`, 2200);
      }
      paintModel();
    });
    model.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { model.blur(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleAgentAsk(); e.preventDefault(); }
      e.stopPropagation();
    });
    paintModel();
    actions.append(model, suggest);
    const send = async () => {
      const prompt = ta.value.trim();
      if (!prompt) return;
      if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return; }
      try {
        // held for review unless Settings → Review agent asks is off (#907)
        const sent = await postAgentJob(editBase + '/deck/edit/agent', { prompt, agent: pickedAgent, slide: instance.state.slide, ...(askReviewOn() ? { review: true } : {}) });
        if (!sent) { ta.focus(); return; }   // the skill card closed: the ask stays typed
        const { res, j } = sent;
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

  /**
   * Migrate (DESIGN_SYSTEM_MIGRATIONS): move the deck onto the version of a
   * design system this machine serves — from the behind toast, or the
   * marketplace update's what's new. A job watched in the agent panel, which
   * opens docked on it and stays open across the reload the migration
   * causes: the agent's ask when the migration has a skill and an agent is
   * installed, the server's own entry otherwise. A skill the agent does not
   * have yet is offered first (`postAgentJob`). Answers whether it started.
   */
  async function migrateDesignSystem(ref) {
    if (!editAvailable) { toast(cannot('migrating a design system'), 3200); return false; }
    if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return false; }
    const wasOpen = !!agentEl;
    rememberAgentOpen(true);   // before the request: the reload may beat its answer
    try {
      const sent = await postAgentJob(editBase + '/deck/edit/design-system/migrate',
        { ref, ...(preferredAgent && editAgents.some((a) => a.name === preferredAgent) ? { agent: preferredAgent } : {}) }, writeFetch);
      if (!sent) { if (!wasOpen) rememberAgentOpen(false); return false; }
      const { res, j } = sent;
      if (!res.ok || !j.ok) throw new Error(j.error || res.status);
      debugLog('design-system', `migrate ${ref}: ${j.nothing ? 'nothing to do' : `by ${j.by}${j.agent ? ` (${j.agent})` : ''}`}`);
      if (j.nothing) { if (!wasOpen) rememberAgentOpen(false); toast(j.said, 3200); return true; }
      // the server's own run is over by its answer: listed even if its event has not landed yet
      if (j.ask && !agentAsks.some((x) => x.id === j.ask.id)) agentAsks.push(j.ask);
      if (!agentEl) toggleAgentAsk();
      else paintAsks?.();
      return true;
    } catch (e) {
      if (!wasOpen) rememberAgentOpen(false);
      toast(`migrate failed — ${String(e.message || e).slice(0, 120)}`, 6000);
      return false;
    }
  }

  /**
   * Where the skills an agent job needs go, when the agent does not have
   * them yet (#893): every project (the one recommended), this project, or
   * not now, and the job goes ahead with what the agent has. Resolves to the
   * answer, or null when the card was closed without one.
   */
  function chooseSkillPlace({ agent = null, skills = [], places = [] }) {
    if (!choiceCard) return Promise.resolve('none');
    const who = editAgents.find((a) => a.name === agent)?.label ?? agent ?? 'your agent';
    const names = skills.map((x) => (x === 'decklight' ? 'Decklight’s skill' : `the ${x} skill`)).join(' and ');
    const at = (k) => places.map((p) => p[k]).join(', ');
    return new Promise((done) => {
      choiceCard.open({
        title: `install ${names} for ${who}?`,
        lines: [`${who} reads ${skills.length === 1 ? 'it' : 'them'} for this, and does not have ${skills.length === 1 ? 'it' : 'them'} yet`],
        rows: [
          { value: 'global', label: 'Every project', note: `${at('global')} · recommended` },
          { value: 'project', label: 'This project only', note: at('project') },
          { value: 'none', label: 'Not now', note: 'nothing is installed, and this goes ahead without it' },
        ],
        current: 'global',
        onPick: done,
        onCancel: () => done(null),
      });
    });
  }

  /**
   * POST an agent job with the skills it needs offered first: the server
   * answers `choose: 'skill'` when the agent lacks one (only to a page that
   * says it can ask, `offer`), the card asks where it goes, and the job is
   * posted again with the answer. Resolves to `{ res, j }`, or null when the
   * card was closed and nothing was sent.
   */
  async function postAgentJob(url, body, send = fetch) {
    const post = (extra) => send(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }),
    });
    let res = await post({ offer: true });
    let j = await res.json().catch(() => ({}));
    if (res.ok && j.choose === 'skill') {
      const place = await chooseSkillPlace(j);
      if (!place) return null;
      res = await post({ place });
      j = await res.json().catch(() => ({}));
    }
    return { res, j };
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
    notesCaughtUp?.(slide);
    // the page that saved keeps its box exactly as typed: only the others follow
    if (from !== PAGE_ID) notesRefresh?.(slide);
    instance._notify();
  }
  // A save reloads the page (the server's watcher), which used to close the
  // card on every save that worked and leave it open on every one that did
  // not. The save records where the author was; the reload reopens the card
  // there (#646). Esc or × — closing on purpose — never leaves the record.
  const NOTES_OPEN_KEY = 'decklight-notes-open:' + location.pathname;
  // The quiet time after which the open card writes itself (PRESENTING): a
  // preference of the person typing, so per browser and not per deck. 0 is
  // off, and the card then saves on leaving only, as it did before.
  const NOTES_QUIET_KEY = 'decklight-notes-quiet';
  const NOTES_QUIET_STEPS = [250, 500, 1000, 2000, 0];
  const NOTES_QUIET_DEFAULT = 500;
  const notesQuiet = () => {
    const v = Number(readPref(NOTES_QUIET_KEY));
    return readPref(NOTES_QUIET_KEY) !== null && NOTES_QUIET_STEPS.includes(v) ? v : NOTES_QUIET_DEFAULT;
  };
  const notesQuietLabel = (ms = notesQuiet()) => (ms ? `${ms} ms after typing stops` : 'on leaving only');
  function cycleNotesQuiet() {
    const next = NOTES_QUIET_STEPS[(NOTES_QUIET_STEPS.indexOf(notesQuiet()) + 1) % NOTES_QUIET_STEPS.length];
    writePref(NOTES_QUIET_KEY, next === NOTES_QUIET_DEFAULT ? null : String(next));
    toast(`notes autosave: ${notesQuietLabel(next)}`, 2200);
    return next;
  }
  const forgetNotesOpen = () => { try { sessionStorage.removeItem(NOTES_OPEN_KEY); } catch { /* no storage */ } };
  // Whole slide or per build: what the card shows (PRESENTING). Per build,
  // only the part of the notes the [click] lines give the build on screen.
  // A preference of the person editing, so per browser, like the quiet time.
  const NOTES_VIEW_KEY = 'decklight-notes-view';
  const notesPerBuild = () => readPref(NOTES_VIEW_KEY) === 'build';
  let unmountEditor = null;
  let notesFollow = null;   // re-points a clean notes card at the slide on screen
  let notesCaughtUp = null; // this page's notes now show the card's last save
  let notesPassage = null;  // the open card's selection or build part, for a tool that takes a passage
  let notesReadOnly = false; // the card opened with no edit server behind it
  // A DRAWER, not a dialog: the notes open docked along the bottom, the deck
  // stays navigable above them, and they save themselves (below). The dock
  // buttons still move it anywhere, remembered per deck.
  const notesDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    getEl: () => editEl,
    closeLabel: 'close (esc)',
    defaultMode: 'bottom',
    name: 'Notes',
    open: () => { if (!editEl) toggleEditor(); },
    close: () => { if (editEl) toggleEditor(); },
  });
  let notesDirty = null;     // does the open card hold edits the file does not have?
  let notesClosing = false;  // a close that is saving first
  // Docked, the deck stays navigable beside the notes card, so the card
  // follows the slide, once anything unsaved in it is written.
  instance.on('slide', () => notesFollow?.());
  // …and, per build, the build: each one has its own part of the notes
  instance.on('build', () => notesFollow?.());
  // Who is waiting for the notes card to close: the recorder, which sent the
  // author here to fix a slide's [click]s and reopens once they are done (#929).
  const notesClosed = new Set();
  /** The notes card on slide `sl`: the deck goes there, and a card already open follows it. */
  function editNotesFor(sl) {
    instance.goto(sl, 0);
    if (!editEl) toggleEditor();
    editEl?.querySelector('textarea.edit-notes')?.focus();
  }
  function toggleEditor() {
    if (editEl) {
      // A card holding edits saves them on the way out, and closes once they
      // are written; a save that fails leaves it open, still marked unsaved,
      // because closing would be the one way to lose what was typed.
      if (!notesClosing && notesSave && notesDirty?.()) {
        notesClosing = true;
        notesSave().then(() => { notesClosing = false; if (editEl && !notesDirty?.()) toggleEditor(); });
        return;
      }
      unmountEditor(); editEl = null; unmountEditor = null; notesFollow = null; notesCaughtUp = null; notesSave = null; notesRefresh = null; notesDirty = null; forgetNotesOpen();
      for (const fn of [...notesClosed]) { notesClosed.delete(fn); fn(); }
      return;
    }
    // With no edit server behind the deck — without trust, a file —
    // the same card opens READ-ONLY: the notes to read, following the slide,
    // and nothing that could look like it saves. `decklight <deck>` edits them.
    const notesRO = notesReadOnly = !editAvailable;
    let sl = instance.state.slide;
    // Per build, the box holds one part of the notes (`shown.part`), and a
    // save writes it back into its place; null is the whole slide. Which part
    // is fixed when the box is filled, not read off the deck at save time:
    // the build may have moved on by then, and the words belong where they
    // were written.
    let perBuild = !notesRO && notesPerBuild();
    let shown = { part: null, why: 'none', count: 1, step: 0, builds: 0 };
    // The slide's script as this card last saved it, until the page's own
    // notes show it (the server sends them back a moment after the save
    // answers): a part saved, then the next build's part filled and saved
    // in that moment, must not write the first one back as it was.
    let pending = null;
    notesCaughtUp = (slide) => { if (pending?.sl === slide) pending = null; };
    const draftNow = () => (pending?.sl === sl ? pending.script : writtenMarks(notesDraft(sl)));
    const where = () => {
      const parts = notesParts(draftNow());
      const builds = instance._records?.[sl - 1]?.groups.length ?? 0;
      const step = sl === instance.state.slide ? instance.state.step : 0;
      const at = perBuild ? partFor(step, builds, parts.length) : { part: null, why: 'whole' };
      return { ...at, parts, count: parts.length, step, builds };
    };
    const heading = () => {
      if (notesRO) return `notes — slide ${sl} · read-only (write mode edits them)`;
      const why = perBuild && shown.part == null ? wholeWhy(shown.why, shown) : '';
      const which = shown.part != null ? ` · ${partLabel(shown.part, shown.count)}` : why ? ` · whole slide: ${why}` : '';
      return `notes — slide ${sl}${which} · saves itself`;
    };
    const { el, card, title } = typingCard('notes', notesDock, heading(), toggleEditor);
    editEl = el;
    const ta = document.createElement('textarea');
    ta.className = 'narr-input edit-notes';
    // the markers as the author writes them — [click], [pause] — never ⟨…⟩ —
    // and the paragraphs as the author laid them out, a blank line apart
    const notesText = () => {
      shown = where();
      return shown.part == null ? draftNow() : shown.parts[shown.part];
    };
    let loaded = ta.value = notesText();
    title.textContent = heading();
    // …and as the card opened on this slide: what ↺ reset goes back to. Not
    // the last save — the card writes itself whenever the typing stops, so
    // the box IS the last save most of the time, and a reset against it
    // would have nothing to drop.
    let opened = loaded;
    ta.spellcheck = false;
    ta.readOnly = notesRO;
    if (notesRO) ta.classList.add('edit-notes-readonly');
    let syncChanged = () => {};   // the reset / before-after buttons, once they exist (not read-only)
    let saving = false;           // a save in flight: the mark says "saving…"
    let autosaving = false;       // …and it is the quiet time's own: "autosaving…"
    let justSaved = 0;            // an autosave that landed: the mark says so for a moment, in place of a toast
    if (!notesRO) notesDirty = () => ta.value !== loaded;
    notesFollow = () => {
      if (instance.state.slide === sl && (!perBuild || where().part === shown.part)) return;
      // Edits go to the slide they were written for, and the card moves on
      // once they are written. A save that fails leaves it where it was,
      // marked unsaved, with the slide it belongs to in its heading.
      if (ta.value !== loaded) {
        if (!notesRO && !saving) save().then(() => { if (ta.value === loaded) notesFollow?.(); });
        return;
      }
      sl = instance.state.slide;
      opened = loaded = ta.value = notesText();
      title.textContent = heading();
      syncChanged();
      syncQuickView();
    };
    let syncView = () => {};   // the whole slide / per build switch, once it exists
    let syncQuickView = () => {};   // the quick actions' labels, which follow what the box shows
    let unmountQuick = () => {};
    // What the quick actions and the picker can rewrite short of the whole
    // slide: the words selected in the box, else (per build) the build's
    // part. `at`/`length` are in the box, `from`/`to` in the slide's whole
    // script; the server finds the words by their text, the offsets a hint.
    notesPassage = () => {
      if (ta.hidden) return null;   // the changes view is up
      const v = ta.value;
      const lead = v.length - v.trimStart().length;
      // where the box's first word sits in the slide's whole script
      const base = shown.part == null ? lead
        : withPart(notesParts(draftNow()), shown.part, '\u0000').indexOf('\u0000');
      const inScript = (i) => base + (i - lead);
      const raw = v.slice(ta.selectionStart, ta.selectionEnd);
      const text = raw.trim();
      if (text) {
        const at = ta.selectionStart + raw.length - raw.trimStart().length;
        const words = text.split(/\s+/).length;
        return { scope: 'selection', slide: sl, text, at, length: text.length, from: inScript(at), to: inScript(at) + text.length,
          label: `the selection · ${words} word${words === 1 ? '' : 's'}`,
          flavor: `“${text.length > 40 ? `${text.slice(0, 38).trimEnd()}…` : text}”` };
      }
      if (shown.part == null || !v.trim()) return null;
      const part = v.trim();
      return { scope: 'build', slide: sl, text: part, at: lead, length: part.length, from: inScript(lead), to: inScript(lead) + part.length,
        label: `this build · ${partLabel(shown.part, shown.count)}`, flavor: 'its part of the notes, the rest as it is' };
    };
    // Whole slide or per build. Edits in the box go first, into the view they
    // were typed in; a save that fails leaves the card as it was.
    async function setView(build, { remember = true } = {}) {
      if (remember) writePref(NOTES_VIEW_KEY, build ? 'build' : null);
      if (build === perBuild) return;
      if (ta.value !== loaded) {
        if (!saving) await save();
        if (ta.value !== loaded) return;
      }
      perBuild = build;
      opened = loaded = ta.value = notesText();
      title.textContent = heading();
      syncView();
      syncChanged();
      syncQuickView();
      ta.focus();
    }
    // the box as the slide's whole script: per build, its part put back in
    // place among the notes as they are now, every [click] around it kept
    const scriptOf = (text) => (shown.part == null ? text
      : withPart(notesParts(draftNow()), shown.part, text));
    // this slide's notes changed under the card (saved from another tab):
    // follow them, unless the box holds edits of its own
    notesRefresh = (slide) => {
      if (slide !== sl || saving) return;
      const fresh = notesText();
      if (ta.value === loaded) opened = ta.value = fresh;   // followed: the new starting point
      loaded = fresh;
      syncChanged();
    };
    const save = async ({ auto = false } = {}) => {
      saving = true;
      autosaving = auto;
      syncChanged();
      try { sessionStorage.setItem(NOTES_OPEN_KEY, JSON.stringify({ slide: sl, caret: ta.selectionStart, scroll: ta.scrollTop, t: Date.now() })); } catch { /* no storage: the card closes, as before */ }
      // what goes is what the box held when the save left: typed into (or
      // reset) meanwhile, the box differs from the file once it lands, and
      // the quiet time writes it again
      const text = ta.value;
      const script = scriptOf(text);
      const split = shown.part != null && hasClick(text);   // a [click] typed into one build's part
      pending = { sl, script };
      try {
        const res = await writeFetch(editBase + '/deck/edit/slide/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide: sl, text: script, from: PAGE_ID }),
        });
        if (!res.ok) throw new Error(await res.text());
        const j = await res.json().catch(() => ({}));
        // nothing written (the box matches the file once normalised) means no
        // reload is coming: say so, rather than "reloading" forever (#646)
        if (j.changed === false) {
          forgetNotesOpen();   // no reload is coming
          pending = null;      // …nor any notes sent back
          saving = false;
          loaded = text;
          syncChanged();
          if (ta.value !== loaded) armAutosave();
          toast('nothing to save — the notes already match the file', 2600);
          return;
        }
        debugLog('edit', `notes ${auto ? 'auto' : ''}saved — slide ${sl}`);
        // written, and IN PLACE: no reload is coming (the server sends every
        // page the new notes instead), so the card simply stays as it is
        saving = false;
        loaded = text;
        if (j.inPlace) forgetNotesOpen();
        // an autosave says so by the mark, not a toast: one every pause in
        // the typing would be a toast every sentence
        if (auto && j.inPlace) {
          clearTimeout(justSaved);
          justSaved = setTimeout(() => { justSaved = 0; syncChanged(); }, 1600);
        } else toast(j.inPlace ? 'notes saved' : 'notes saved — reloading', 1800);
        // a [click] typed into a build's part moved the split: the whole
        // slide, so the author sees where the builds now fall
        if (split && ta.value === loaded) {
          setView(false, { remember: false });
          toast('a [click] moved the split: the whole slide, to see where the builds fall', 3200);
        }
        syncChanged();
        if (ta.value !== loaded) armAutosave();
      } catch (e) {
        // long enough to read: the save did NOT happen, and the box still holds the text
        forgetNotesOpen();
        pending = null;
        saving = false;
        syncChanged();   // still unsaved, and the mark says so
        toast(`save failed: ${String(e.message || e).slice(0, 90)}`, 6000);
      }
    };
    if (!notesRO) notesSave = save;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { if (!notesRO) save(); e.preventDefault(); }
      else if (e.key === 'Escape') { toggleEditor(); e.preventDefault(); }
      // read-only, a box with the caret in it must not eat the deck's keys:
      // → still advances, and the notes follow the slide
      if (!notesRO) e.stopPropagation();
    });
    if (notesRO) {
      card.append(ta);
      unmountEditor = mountTypingCard(el, notesDock);
      return;
    }
    // Leaving the card saves it: a press on the slide, or the window losing
    // focus to another. Not a focus event: the card's own machinery drops
    // focus all the time (a button disabled while drafting, the box hidden
    // behind the changes view), and none of that is the author leaving.
    const leaving = () => { if (!saving && ta.value !== loaded) save(); };
    const onPress = (e) => { if (!el.contains(e.target)) leaving(); };
    root.addEventListener('pointerdown', onPress, true);
    window.addEventListener('blur', leaving);
    // …and so does a pause in the typing: once the box has been quiet for
    // the settings' quiet time (500 ms unless changed; Settings → Notes
    // autosave), it is written, and the mark says "autosaving…" while it
    // goes. There is no save button: a card that writes itself when you
    // stop typing has nothing for one to do that ⌘⏎ does not.
    let quietTimer = 0;
    const armAutosave = () => {
      clearTimeout(quietTimer);
      const ms = notesQuiet();
      if (!ms) return;
      quietTimer = setTimeout(() => { if (!saving && ta.value !== loaded) save({ auto: true }); }, ms);
    };
    const unmountLeaving = () => {
      clearTimeout(quietTimer);
      clearTimeout(justSaved);
      root.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('blur', leaving);
    };
    // The toolbar: what the box shows and how to undo it on the left, the
    // agent's rewrites on the right.
    //
    // ✎ edit / ⇄ changes is a switch, not a button that names the other
    // view: the lit half is what is on screen. Changes is the notes AS THE
    // CARD OPENED on this slide (`opened`) against the box, word by word,
    // the same starting point ↺ reset goes back to. Not the last save: the
    // card writes itself whenever the typing stops, so against the last save
    // there was nearly never anything to show.
    const actions = document.createElement('div');
    actions.className = 'tr-actions notes-bar';
    const tools = document.createElement('div');
    tools.className = 'notes-tools';
    const views = document.createElement('div');
    views.className = 'notes-views';
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'show');
    const diffEl = document.createElement('div');
    diffEl.className = 'notes-diff';
    diffEl.hidden = true;
    diffEl.tabIndex = 0;
    const button = (cls, text, tip) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `narr-prev-btn notes-btn ${cls}`;
      b.textContent = text;
      if (tip) b.title = tip;
      return b;
    };
    const editBtn = button('notes-edit', '✎ edit', 'the notes, to type into');
    const diffBtn = button('notes-compare', '⇄ changes', 'what changed since this card opened on this slide, word by word');
    const resetBtn = button('notes-reset', '↺ reset',
      'back to the notes as the card opened on this slide — drops every change made since, typed or rewritten by the agent, and writes them back');
    views.append(editBtn, diffBtn);
    const showDiff = (on) => {
      diffEl.hidden = !on;
      ta.hidden = on;
      if (on) {
        const runs = wordDiff(opened, ta.value);
        const { removed, added } = diffCounts(runs);
        diffEl.replaceChildren();
        const head = document.createElement('div');
        head.className = 'notes-diff-head';
        head.textContent = `since this card opened · −${removed} +${added} word${added === 1 ? '' : 's'} · ↺ reset puts it back`;
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
      editBtn.classList.toggle('narr-sel', !on);
      diffBtn.classList.toggle('narr-sel', on);
      editBtn.setAttribute('aria-pressed', String(!on));
      diffBtn.setAttribute('aria-pressed', String(on));
    };
    // ● unsaved beside the heading while the box differs from the file —
    // at full strength, the heading itself dimmed — and saving… in flight
    const mark = Object.assign(document.createElement('span'), { className: 'notes-dirty-mark',
      title: 'written on its own once you stop typing (Settings → Notes autosave), when you leave the box, move to another slide, or close the card — ⌘⏎ saves now' });
    title.after(mark);
    syncChanged = () => {
      const changed = ta.value !== loaded;
      const edited = ta.value !== opened;
      mark.textContent = saving ? (autosaving ? 'autosaving…' : 'saving…') : changed ? '● unsaved' : justSaved ? 'saved' : '';
      mark.classList.toggle('notes-saved-mark', !saving && !changed && !!justSaved);
      mark.hidden = !mark.textContent;
      resetBtn.disabled = !edited;
      diffBtn.disabled = !edited;
      if (!edited && !diffEl.hidden) showDiff(false);
    };
    resetBtn.addEventListener('click', () => {
      clearTimeout(quietTimer);
      ta.value = opened;
      showDiff(false);
      syncChanged();
      // the file has moved on (the quiet time wrote the typing, or the
      // agent's rewrite saved itself): put it back too, the quiet way — the
      // mark says it; a save in flight lands first, and the box differing
      // from what it wrote is written again after it
      if (ta.value !== loaded && !saving) save({ auto: true });
      toast('back to the notes as the card opened on this slide', 2200);
    });
    editBtn.addEventListener('click', () => showDiff(false));
    diffBtn.addEventListener('click', () => showDiff(true));
    // Whole slide / per build: a switch like the one beside it, the lit half
    // what the box holds. Per build follows the build on screen (→ steps it),
    // and is remembered for the next card; a switch made with edits in the
    // box saves them first, into the view they were typed in.
    const scopes = document.createElement('div');
    scopes.className = 'notes-views notes-scope';
    scopes.setAttribute('role', 'group');
    scopes.setAttribute('aria-label', 'notes for');
    const wholeBtn = button('notes-whole', 'whole slide', 'all of this slide\'s notes, every [click] line in them');
    const buildBtn = button('notes-per-build', 'per build',
      'only the part of the notes for the build on screen: the [click] lines decide what belongs to which build, and → / ← step it');
    scopes.append(wholeBtn, buildBtn);
    syncView = () => {
      wholeBtn.classList.toggle('narr-sel', !perBuild);
      buildBtn.classList.toggle('narr-sel', perBuild);
      wholeBtn.setAttribute('aria-pressed', String(!perBuild));
      buildBtn.setAttribute('aria-pressed', String(perBuild));
    };
    wholeBtn.addEventListener('click', () => setView(false));
    buildBtn.addEventListener('click', () => setView(true));
    diffEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { save(); e.preventDefault(); }
      else if (e.key === 'Escape') { showDiff(false); e.preventDefault(); }
      e.stopPropagation();
    });
    ta.addEventListener('input', () => { syncChanged(); armAutosave(); });
    tools.append(views, scopes, resetBtn);
    actions.append(tools);
    showDiff(false);
    syncView();
    syncChanged();
    // The writing tools (src/core/writing.js, cli/enhance.mjs): two quick
    // actions that run at once on what the card shows, and Writing tools…,
    // the picker, for every tool and scope. The box is saved first, so the
    // agent reads the notes as the file holds them, and the answer is HELD
    // for review (#907): the review opens over the card, and nothing lands
    // until it is applied.
    //
    // Rewrite follows the box: with words selected it rewrites only them
    // (and says so, on the button and while it runs); per build, with none
    // selected, only the build's part; otherwise the slide's notes.
    // Match slide always reads the whole slide's notes against the slide.
    if (editAgents.length) {
      const agent = editAgents.find((a) => a.name === preferredAgent) ?? editAgents[0];
      const rewrites = document.createElement('div');
      rewrites.className = 'notes-rewrites';
      const sends = 'The box is saved first; what comes back is reviewed before it lands. '
        + `The notes are sent to ${agent.label}, which may pass them to its provider.`;
      const quick = (cls, text, tip) => {
        const b = button(`notes-quick ${cls}`, '', tip);
        const label = Object.assign(document.createElement('span'), { className: 'notes-quick-label', textContent: text });
        b.append(aiIcon(), label);
        return { b, label };
      };
      const rewrite = quick('notes-rewrite', 'Rewrite', '');
      const match = quick('notes-match-slide', 'Match slide', '');
      const btn = button('notes-writing', 'Writing tools…',
        `every writing tool, and which slides it runs on: ${agent.label} rewrites the notes (or the slide's text). ${sends}`);
      // what the box is rewriting while a run goes: the selection's words, or the build
      const running = Object.assign(document.createElement('span'), { className: 'notes-running', hidden: true });
      const syncQuick = () => {
        const p = notesPassage?.();
        const busy = !running.hidden;
        rewrite.label.textContent = p?.scope === 'selection' ? 'Rewrite selection' : 'Rewrite';
        rewrite.b.title = `${p?.scope === 'selection' ? 'rewrites only the selected words, the notes around them as they are'
          : p?.scope === 'build' ? `rewrites ${partLabel(shown.part, shown.count)} only, the rest of the slide's notes as they are`
            : 'rewrites this slide\'s notes'}: the same meaning, said more clearly. ${sends}`;
        match.b.title = `rewords this slide's notes to agree with what the slide shows: its terms, names, numbers and order. `
          + `Always the whole slide's notes${p ? ', whatever is selected or shown' : ''}. ${sends}`;
        rewrite.b.disabled = match.b.disabled = busy;
      };
      const firstSave = async () => {
        if (ta.value !== loaded) await save();
        return ta.value === loaded;   // a save that failed said so
      };
      rewrite.b.addEventListener('click', async () => {
        const p = notesPassage?.();
        if (!(await firstSave())) return;
        // the selection stays lit while the box has the focus, and the mark says what is being rewritten
        if (p?.scope === 'selection') { ta.focus(); ta.setSelectionRange(p.at, p.at + p.length); }
        await enhanceScript(p ? p.scope : 'slide', { kind: 'rewrite', passage: p });
        // started (not refused, nor another run's): the mark says what is being rewritten until it ends
        if (p && enhanceRun?.passage === p) {
          running.textContent = `rewriting ${p.scope === 'selection' ? `the selection: ${p.flavor}` : partLabel(shown.part, shown.count)}…`;
          running.hidden = false;
          syncQuick();
        }
      });
      match.b.addEventListener('click', async () => {
        if (await firstSave()) enhanceScript('slide', { kind: 'match-slide' });
      });
      btn.addEventListener('click', () => openWriting({ before: firstSave }));
      const onRunEnd = () => { running.hidden = true; syncQuick(); };
      enhanceEnded.add(onRunEnd);
      unmountQuick = () => { enhanceEnded.delete(onRunEnd); document.removeEventListener('selectionchange', syncQuick); };
      // the label follows the selection as it is made
      document.addEventListener('selectionchange', syncQuick);
      for (const ev of ['select', 'input', 'keyup', 'mouseup']) ta.addEventListener(ev, syncQuick);
      const sep = Object.assign(document.createElement('span'), { className: 'notes-sep', textContent: '·' });
      rewrites.append(rewrite.b, match.b, sep, btn, running);
      actions.appendChild(rewrites);
      syncQuickView = syncQuick;
      syncQuick();
    }
    card.append(ta, diffEl, actions);
    const unmountCard = mountTypingCard(el, notesDock);
    unmountEditor = () => { unmountCard(); unmountLeaving(); unmountQuick(); notesPassage = null; };
    setTimeout(() => ta.focus(), 0);
  }

  // ── editing (on by default) + its right-click menu — SPEC PRESENTING, #112 ──
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

  /**
   * Editing follows the capability: on whenever this page may write the deck
   * (write mode answered, and the deck is not locked), off the moment it may
   * not. There is no key for it — the lock is the one switch.
   */
  function syncEditing() {
    const want = editAvailable;
    paintSlideNum();   // the capability's badge, on or off with it
    if (want === elementEditOn) return;
    elementEditOn = want;
    if (!want) closeElementMenu();
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
    // `node` is what the click means inside the block: the deepest drawn node
    // in a diagram (pick.js), the block itself anywhere else
    return { sec, slide, index: child ? authoredIndex(sec, child) : null, top: child, clicked: node, node: child ? pickNode(child, node) : null };
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
    } else if (menuView === 'concept') {
      // Concept ▸ (SPEC SVG_DIAGRAMS, #718): the shape's data-concept — one of
      // the names the deck already uses, a new one, or none
      rows.push({ label: '← back', back: true, run: () => { menuView = 'main'; renderElementMenu(); } });
      const here = conceptOf(menuTarget.top, menuTarget.clicked);
      const names = [...new Set([...knownConcepts(), ...(here?.name ? [here.name] : [])])];
      for (const name of names) rows.push({ label: `${here?.name === name ? '● ' : '○ '}${name}`, run: () => commitConcept(here?.name === name ? null : name) });
      rows.push({ label: 'New concept…', input: true, run: () => askConceptName() });
      if (here?.name) rows.push({ label: 'none (detach)', run: () => commitConcept(null) });
      // the whole list, from where the question came up: colours, pins, which slides use each (Concept colors…)
      if (editConcepts) rows.push({ label: 'Edit concepts…', run: () => { closeElementMenu(); editConcepts(here?.name ?? null); } });
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
      if (editAgents.length) rows.push({ label: 'Writing tools…', run: () => { closeElementMenu(); openWriting(); } });
      rows.push({ label: 'Slide ▸', run: () => { menuView = 'slide'; renderElementMenu(); } });
    } else {
      const nested = menuTarget.node && menuTarget.node !== menuTarget.top;
      // No notes row here: the notes are the slide's, not the element's, and
      // the background right-click, S, the bar's Notes and the palette all
      // open them. On an element the row only pushed what the click was about
      // (remove, content, colours, type) one line further down.
      if (inspectHook) rows.push({ label: 'Inspect', run: () => openInspect() });
      rows.push({ label: nested ? `Remove this ${menuTarget.node.tagName.toLowerCase()}` : 'Remove element', run: () => commitRemove() });
      if (nested) rows.push({ label: `Remove the whole ${menuTarget.top.tagName.toLowerCase()}`, run: () => commitRemove(menuTarget, { whole: true }) });
      rows.push({ label: 'Edit content (HTML)', run: () => { closeElementMenu(); openElementContentEditor(menuTarget); } });
      if (editAgents.length) rows.push({ label: 'Writing tools…', run: () => { closeElementMenu(); openWriting({ group: 'text' }); } });
      rows.push({ label: 'Colors…', run: () => openInspect('colors') });
      rows.push({ label: 'Type…', run: () => openInspect('type') });
      // the format painter: this shape's look onto another (style-clip.js)
      if (styleClip) {
        const target = menuTarget;
        rows.push({ label: 'Copy style', key: styleClip.keys.copy, run: () => { closeElementMenu(); styleClip.copy(target); } });
        if (styleClip.has()) rows.push({ label: 'Paste style', key: styleClip.keys.paste, run: () => { closeElementMenu(); styleClip.paste(target); } });
      }
      if (conceptOf(menuTarget.top, menuTarget.clicked)) rows.push({ label: 'Concept ▸', run: () => { menuView = 'concept'; renderElementMenu(); } });
      rows.push({ label: 'Add text effect ▸', run: () => { menuView = 'effects'; renderElementMenu(); } });
      rows.push({ label: 'Slide ▸', run: () => { menuView = 'slide'; renderElementMenu(); } });
    }
    menuRows = rows;
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'cm-row' + (r.back ? ' cm-back' : '');
      row.setAttribute('role', 'option');
      row.textContent = r.label;
      if (r.key) row.append(Object.assign(document.createElement('span'), { className: 'cm-key', textContent: r.key }));
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
    if (!editAvailable) { toast(cannot('editing slides'), 3200); return; }
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
        delete: `slide ${slide} deleted — ${UNDO_CHORD} takes it back`,
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

  async function commitRemove(target = menuTarget, { whole = false } = {}) {
    const { slide, index } = target;
    closeElementMenu();
    if (index === null) { toast('nothing selected to remove', 2000); return; }
    // a node picked inside a diagram goes alone, by the file's path to it
    const node = whole ? null : target.node && target.node !== target.top ? target.node : null;
    const path = node ? pathFrom(target.top, node) : null;
    if (node && !path) { toast('that node is the engine’s, not the file’s — nothing to remove', 2600); return; }
    try {
      const res = await writeFetch(editBase + '/deck/edit/element/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(path ? { slide, index, path, tag: node.tagName.toLowerCase() } : { slide, index }),
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

  // "Concept ▸" — the shape's data-concept (SPEC SVG_DIAGRAMS, #718): set on
  // the shape, or taken off the element that carries it (a group's, when the
  // shape has it from its group). One POST, one undo entry; the reload the
  // write brings repaints the shape in its concept's slot.
  async function commitConcept(name) {
    const { slide, index, top, clicked } = menuTarget;
    const here = conceptOf(top, clicked);
    closeElementMenu();
    if (!here) { toast('nothing here to name — right-click a shape in a diagram', 2600); return; }
    if (name !== null && !/^[a-z][a-z0-9-]{0,40}$/i.test(name)) { toast('a concept is a name: letters, digits and dashes, starting with a letter', 3200); return; }
    // the engine's concept tools write it in place and offer the look-alikes;
    // without them (a harness), the old one-shape write and its reload
    if (conceptTools) { await conceptTools.attach([here.el], name); return; }
    await postConcept({ slide, index, path: here.path, tag: here.tag, concept: name }, name);
  }
  let conceptTools = null;
  let styleClip = null;   // copy style / paste style (style-clip.js), handed in by the engine
  let editConcepts = null;   // the engine's door to Concept colors… (`fn(name)`), for the Concept ▸ submenu
  /**
   * Where a shape's concept lives in the FILE: `{ slide, index, path, tag,
   * name, el }` for the element that carries (or would carry) its
   * `data-concept`, the group's when the shape has it from its group. Null off
   * a diagram, or on a slide with no per-element mapping.
   */
  function conceptTarget(shape) {
    const t = elementTargetOf(shape);
    if (!t?.top || t.index === null) return null;
    // a shape (or its label) resolves to whatever holds its concept; the holder itself (a group) is its own answer
    const path = shape.hasAttribute?.('data-concept') ? pathFrom(t.top, shape) : null;
    const here = path ? { name: shape.getAttribute('data-concept'), el: shape, path, tag: shape.tagName.toLowerCase() } : conceptOf(t.top, shape);
    return here ? { slide: t.slide, index: t.index, path: here.path, tag: here.tag, name: here.name, el: here.el } : null;
  }
  /**
   * `data-concept` on many elements, in place and in ONE write (`Z` takes the
   * batch back): `targets` from conceptTarget, `concept` a name or null. The
   * page that asked already shows it (the caller repaints); every other page
   * reloads. Resolves to the number written, or throws with the server's word.
   */
  async function writeConcepts(targets, concept) {
    const items = targets.map(({ slide, index, path, tag }) => ({ slide, index, path, tag }));
    const p = (async () => {
      const res = await writeFetch(editBase + '/deck/edit/element/concepts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, concept, quiet: true, from: PAGE_ID }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `the edit server answered ${res.status}`);
      return j;
    })();
    trackWrite(p);
    return p;
  }
  async function postConcept({ slide, index, path, tag, concept }, name) {
    try {
      const res = await writeFetch(editBase + '/deck/edit/element/concept', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slide, index, path, tag, concept }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.status);
      toast(!j.changed ? 'concept unchanged' : name === null ? `detached from its concept — reloading · ${UNDO_CHORD} takes it back` : `now the “${name}” concept — reloading · ${UNDO_CHORD} takes it back`);
    } catch (e) {
      toast(`concept not saved: ${String(e.message || e).slice(0, 90)}`, 3400);
    }
  }
  /** "New concept…": a name typed into the menu itself; ⏎ sets it, Esc goes back. */
  function askConceptName() {
    const list = menuEl?.querySelector('.cm-list');
    if (!list) return;
    list.textContent = '';
    const row = document.createElement('div');
    row.className = 'cm-row cm-input';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'concept name — agent, tools, data…'; input.setAttribute('aria-label', 'New concept name');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) commitConcept(v); }
      else if (e.key === 'Escape') { e.preventDefault(); menuView = 'concept'; renderElementMenu(); }
    });
    row.appendChild(input);
    list.appendChild(row);
    menuRows = [];
    input.focus();
  }

  // "Inspect", "Colors…" and "Type…" (PRESENTING): one panel, the inspector,
  // whose Colors and Type tabs are the colour card's editors. The engine owns
  // the inspector and hands this module the door to it.
  let inspectHook = null;
  function openInspect(tab = 'info') {
    const target = menuTarget;
    closeElementMenu();
    inspectHook?.(target, tab);
  }

  /**
   * A colour or type pick from the inspector, saved IN PLACE: the page already
   * shows it, so the write is quiet and nothing reloads (the panel stays
   * open); every other page of the deck is told, and reloads. One POST and one
   * undo entry per pick.
   */
  async function saveStyles({ slide, index, edits, concept = null }) {
    const res = await writeFetch(editBase + '/deck/edit/element/style', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slide, index, edits, concept, quiet: true, from: PAGE_ID }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.status);
    return j;
  }

  // "Edit content (HTML)" — the element's raw outerHTML, read fresh from the
  // FILE (never the live DOM: the engine mutates elements in place, so what
  // the player sees is not what a Save should write back over).
  let contentEl = null;
  let inspectorOpen = null;   // set by the engine: back to the inspector from here
  let contentTarget = null;   // the element on the slide, outlined while its source is open
  let onEditorResize = null;
  // Beside the slide, not over it (#530): the review and sources panels'
  // placement, shared (dock.js). Docked, the slide stays whole and navigable
  // next to the editor — you change a `y=` while looking at the box it moves.
  const editorDock = createDock({
    root,
    reflow: () => instance._reflow?.(),
    getEl: () => contentEl,
    closeLabel: 'close (esc)',
    // in the slot, so it takes the place of whatever panel was open; not a
    // tab, since it opens on an element and a tab would have nothing to open
    name: 'HTML', tab: false,
    close: () => closeContentEditor(),
  });
  // The editor open when its save reloads the deck is open after it, on the
  // same element (#807): the save remembers where it was, per tab, and the
  // reload reads it back. Closed on purpose, it is forgotten.
  const EDITOR_OPEN_KEY = 'decklight-editor-open:' + location.pathname;
  const forgetEditorOpen = () => { try { sessionStorage.removeItem(EDITOR_OPEN_KEY); } catch { /* no storage */ } };
  function reopenContentEditor() {
    let rec = null;
    try { rec = JSON.parse(sessionStorage.getItem(EDITOR_OPEN_KEY) ?? 'null'); } catch { /* no storage */ }
    forgetEditorOpen();
    // a minute is a save's reload; anything older is a different session
    if (!rec || Date.now() - rec.t > 60000 || contentEl || rec.slide !== instance.state.slide) return;
    const sec = instance._sections[rec.slide - 1];
    if (!sec || !sec.children?.[rec.index]) return;
    openElementContentEditor({ sec, slide: rec.slide, index: rec.index });
  }
  function closeContentEditor() {
    forgetEditorOpen();
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
    // back to the inspector on the same element, in the same slot: the two
    // read as tabs of one place (inspector.js offers HTML the other way)
    if (inspectorOpen) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'ins-tab ed-to-inspector';
      back.textContent = '← Inspector';
      back.title = 'back to the inspector, on this element';
      back.addEventListener('click', (e) => { e.stopPropagation(); closeContentEditor(); inspectorOpen(); });
      head.prepend(back);
    }
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
        try { sessionStorage.setItem(EDITOR_OPEN_KEY, JSON.stringify({ slide, index, t: Date.now() })); } catch { /* no storage: the reload closes it, as before */ }
        const res = await writeFetch(editBase + '/deck/edit/element/content', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slide, index, html: ta.value }),
        });
        if (!res.ok) throw new Error(await res.text());
        toast('element content saved — reloading');
      } catch (e) {
        forgetEditorOpen();   // no reload is coming
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
    isOpen: () => !!contentEl,
    close: closeContentEditor,
    panel: true,
    // floating, it is the modal it always was; docked, the deck's keys work
    // whenever the caret is not in the textarea (which stops its own keys)
    modal: () => editorDock.isFloat(),
    keydown: (e) => e.key === 'Escape' && (closeContentEditor(), true),
  });

  // ----- the versions overlay (H) — SPEC PRESENTING -------------------------
  // The git-level sibling of the undo chord: ⌘Z takes back an edit, H takes
  // back a session. Rows are the deck's commits (from `decklight restore`'s own
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
  // The build on that slide, and how many it has. Only the frame knows the
  // count — it reports it after every move (engine.js `_reportToParent`) — so
  // it is null from the moment the preview leaves a slide until it hears.
  let previewStep = 0, previewSteps = null;
  let previewDoc = null; // the commit the preview frame is showing, by hash
  let previewEntry = null; // the ROW the preview belongs to (a removed slide shows its parent)
  const preview = createPreview({
    docOf: (t) => t.doc,
    // in the theme on screen: an old version opens on ITS configured theme,
    // and the history is for seeing what changed, not the theme it had then
    // the slide rides the URL (`#/N`, the deck's deep link): a new document
    // used to open on slide 1 and only then hear where to go, which never
    // mattered while every version opened on slide 1 — but a slide the
    // version REMOVED is shown from the one before it, at its old number
    srcFor: (t) => `${editBase}/deck/edit/history/at?ref=${encodeURIComponent(t.doc)}&${previewQuery().replace(/^\?/, '')}`
      + `${captionsOn() ? '&captions' : ''}#/${t.slide || 1}/${t.step || 0}`,
    messageFor: (t) => ({ __decklightPreview: { goto: [t.slide, t.step || 0] } }),
  });
  // "Its last build" without knowing how many there are: the deck clamps a
  // step to the slide's own count, so asking for more than any slide has lands
  // on the final one, and the frame's report says which that was.
  const LAST_BUILD = 9999;
  /** Point the preview at build `step` of `slide` of `doc`. */
  function aim(doc, slide, step) {
    if (doc !== previewDoc || slide !== previewSlide) previewSteps = null;
    previewDoc = doc;
    previewSlide = slide;
    previewStep = step;
    const frame = restoreEl?.querySelector('iframe');
    if (frame && doc) preview.show(frame, { doc, slide, step });
    renderNav();
  }
  /** The frame saying where it is. A report from a slide it has since been sent away from is stale. */
  function onPreviewState(e) {
    const m = e.data?.__decklightPreviewState;
    const frame = restoreEl?.querySelector('iframe');
    if (!m || !frame || e.source !== frame.contentWindow || m.slide !== previewSlide) return;
    previewStep = m.step;
    previewSteps = m.steps;
    renderNav();
  }
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
  // Push tags (Settings…): whether the commit window's Push sends the
  // annotated tags with the branch. On unless turned off, per deck, because a
  // tag is often a release name for one repo and a scratch mark in another.
  const PUSH_TAGS_KEY = 'decklight-push-tags:' + location.pathname;
  const pushTagsOn = () => readPref(PUSH_TAGS_KEY) !== 'off';
  function setPushTags(on) {
    writePref(PUSH_TAGS_KEY, on ? null : 'off');
    toast(on ? 'push: the branch and its tags' : 'push: the branch only — tags stay on this machine', 2600);
  }
  // The more-info line under the preview — hash · age · subject · counts — is
  // the selected row said again in a sentence: off until asked for, since it
  // repeats a row you can read, right under the slide you are judging. Per
  // BROWSER, not per deck. It used to be "captions", a CC button on C: the
  // mark everyone reads as CLOSED captions, which the preview had none of (a
  // preview was embedded, and embedded showed no captions), so the button
  // looked broken to anyone who pressed it for the voice's words. C and CC
  // are the real captions now (applyHistoryCaptions, below).
  const HISTORY_DETAILS_KEY = 'decklight-history-details';
  const historyDetailsOn = () => readPref(HISTORY_DETAILS_KEY) === '1';
  function applyHistoryDetails() {
    if (!restoreEl) return;
    const on = historyDetailsOn();
    restoreEl.querySelector('.tp-caption').hidden = !on;
    const b = restoreEl.querySelector('.hs-details');
    b.setAttribute('aria-checked', String(on));
    b.title = `the selected version in a sentence under the preview — hash, age, subject, slide and line counts (I ${on ? 'hides' : 'shows'} it)`;
  }
  // Closed captions, for real this time: the version's own notes for the slide
  // on screen, in the preview's caption bar. Not a setting of the history's:
  // the deck's captions (C), which the preview follows, so C here flips the
  // same switch C flips everywhere else, and an author reading the notes
  // under the live deck reads them under every version too.
  function applyHistoryCaptions() {
    if (!restoreEl) return;
    const b = restoreEl.querySelector('.hs-cc');
    if (!b) return;
    const on = captionsOn();
    b.setAttribute('aria-checked', String(on));
    b.title = `this version's notes under the slide (C ${on ? 'hides' : 'shows'} them)`;
  }
  function toggleHistoryCaptions() {
    if (!toggleCaptions) return;
    toggleCaptions();
    applyHistoryCaptions();
    const frame = restoreEl?.querySelector('iframe');
    const say = () => frame?.contentWindow?.postMessage({ __decklightPreview: { captions: captionsOn() } }, '*');
    say();
    // a frame still loading was asked for its src before the flip: tell it again once it is up
    frame?.addEventListener('load', say, { once: true });
  }
  function toggleHistoryDetails() {
    writePref(HISTORY_DETAILS_KEY, historyDetailsOn() ? '0' : '1');
    applyHistoryDetails();
  }

  // "All slides" or "changes" (D): the transport walks every slide of the
  // version, or only the ones it changed, added or removed against the one
  // before it — the slides a version is ABOUT. A removed slide exists only in
  // the version before, so it is shown from there. Per browser, like the
  // captions: it is how you read history, not a fact about a deck.
  const HISTORY_CHANGES_KEY = 'decklight-history-changes';
  const historyChangesOn = () => readPref(HISTORY_CHANGES_KEY) === '1';
  const changesOf = new Map();   // hash → the server's answer, or the promise of it
  let stopAt = 0;
  async function loadChanges(entry) {
    if (!changesOf.has(entry.hash)) {
      changesOf.set(entry.hash, fetch(`${editBase}/deck/edit/history/changes?ref=${encodeURIComponent(entry.hash)}`)
        .then((r) => r.json()).then((j) => (j?.ok ? j : null)).catch(() => null)
        .then((j) => { changesOf.set(entry.hash, j); return j; }));
    }
    return changesOf.get(entry.hash);
  }
  /** The selected version's changes, when they are here and the view wants them. */
  function currentChanges() {
    const entry = restoreRows[restoreSel];
    const c = entry && changesOf.get(entry.hash);
    return historyChangesOn() && c && !(c instanceof Promise) ? c : null;
  }
  function applyHistoryChanges() {
    const b = restoreEl?.querySelector('.hs-only');
    if (!b) return;
    const on = historyChangesOn();
    b.setAttribute('aria-checked', String(on));
    b.title = `walk only the slides this version changed, added or removed (D ${on ? 'shows every slide' : 'turns it on'})`;
  }
  function toggleHistoryChanges() {
    writePref(HISTORY_CHANGES_KEY, historyChangesOn() ? '0' : '1');
    applyHistoryChanges();
    const frame = restoreEl?.querySelector('iframe');
    if (frame) { stopAt = 0; previewSlide = 1; previewStep = 0; restorePreview(frame, restoreRows[restoreSel], { force: true }); }
  }
  /** Show stop `i` of the selected version's changes, on its first build (or its last). */
  function showStop(i, { atEnd = false, step } = {}) {
    const c = currentChanges();
    if (!c || !restoreEl?.querySelector('iframe')) return;
    const entry = restoreRows[restoreSel];
    stopAt = Math.max(0, Math.min(i, c.stops.length - 1));
    const stop = c.stops[stopAt];
    // a slide this version removed is only in the one before it
    const doc = stop?.kind === 'removed' && c.parent ? c.parent : entry.hash;
    aim(doc, stop ? (stop.kind === 'removed' ? stop.was : stop.slide) : 1, step ?? (atEnd ? LAST_BUILD : 0));
  }

  // Stroke icons in the shape of the transport controls everyone already
  // knows. Constant markup, so innerHTML is the same call the touch chrome
  // makes for its own icons — nothing here comes from the deck or from git.
  // Single chevrons step a build, doubles skip a slide, barred ones go to an end.
  const NAV_ICON = {
    first: '<path d="M17 6l-6 6 6 6"/><path d="M7 6v12"/>',
    prevSlide: '<path d="M12 6l-6 6 6 6"/><path d="M19 6l-6 6 6 6"/>',
    prev: '<path d="M15 6l-6 6 6 6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    nextSlide: '<path d="M5 6l6 6-6 6"/><path d="M12 6l6 6-6 6"/>',
    last: '<path d="M7 6l6 6-6 6"/><path d="M17 6v12"/>',
  };
  const NAV_LABEL = {
    first: 'first slide (Home)', prevSlide: 'previous slide (⇧←)', prev: 'previous build (←)',
    next: 'next build (→)', nextSlide: 'next slide (⇧→)', last: 'last slide (End)',
  };
  const navSvg = (d) => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round"'
    + ` stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  /** Slides in the selected version, or 0 when this row is past STAT_DEPTH. */
  const previewTotal = () => Number(restoreRows[restoreSel]?.slides) || 0;

  function previewGoto(n, { atEnd = false } = {}) {
    if (currentChanges()) return showStop(n - 1, { atEnd });
    const total = previewTotal();
    aim(previewDoc, Math.max(1, total ? Math.min(n, total) : n), atEnd ? LAST_BUILD : 0);
  }
  function renderNav() {
    const nav = restoreEl?.querySelector('.hs-nav');
    if (!nav) return;
    const kind = restoreEl.querySelector('.hs-kind');
    const c = currentChanges();
    const total = previewTotal();
    const n = c ? c.stops.length : 0;
    const stop = c?.stops[stopAt];
    // With no slide count for this row (past the stat depth) the buttons still
    // work — they just cannot know where the end is, so none of them is greyed
    // out. Guessing a limit would strand somebody one slide short of it.
    const atStart = c ? stopAt <= 0 : previewSlide <= 1;
    const atEnd = c ? stopAt >= n - 1 : !!total && previewSlide >= total;
    // the builds only once the frame has said how many: before that a count
    // would be a guess, and a slide with none has nothing to step
    const builds = previewSteps ? ` · build ${Math.min(previewStep, previewSteps)} / ${previewSteps}` : '';
    nav.querySelector('.hs-pos').textContent = c
      ? (n ? `change ${stopAt + 1} / ${n}${builds}` : 'no slide changed')
      : `slide ${previewSlide}${total ? ` / ${total}` : ''}${builds}`;
    kind.hidden = !stop;
    kind.className = `hs-kind${stop ? ` hs-k-${stop.kind}` : ''}`;
    kind.textContent = !stop ? '' : stop.kind === 'removed' ? `slide ${stop.was} removed`
      : `slide ${stop.slide} ${stop.kind}`;
    const lastBuild = previewSteps != null && previewStep >= previewSteps;
    for (const b of nav.querySelectorAll('.hs-btn[data-go]')) {
      const at = b.dataset.go;
      b.disabled = (!!c && !n)
        || (atStart && (at === 'first' || at === 'prevSlide' || (at === 'prev' && previewStep <= 0)))
        || (atEnd && (at === 'last' || at === 'nextSlide' || (at === 'next' && lastBuild)));
    }
  }
  /** The next or previous slide (or change), on its first build — or its last, walking back. */
  function slideBy(d, { atEnd = false } = {}) {
    const c = currentChanges();
    if (c) {
      if (stopAt + d >= 0 && stopAt + d < c.stops.length) showStop(stopAt + d, { atEnd });
      return;
    }
    const total = previewTotal();
    if (previewSlide + d >= 1 && (!total || previewSlide + d <= total)) previewGoto(previewSlide + d, { atEnd });
  }
  /**
   * One build, the way → and ← step a talk: through the slide's builds, then on
   * to the next slide's first — or back to the previous one's last.
   */
  function stepBy(d) {
    if (d > 0 && previewSteps != null && previewStep < previewSteps) return aim(previewDoc, previewSlide, previewStep + 1);
    if (d < 0 && previewStep > 0) {
      return aim(previewDoc, previewSlide, Math.min(previewStep, previewSteps ?? previewStep) - 1);
    }
    slideBy(d, { atEnd: d < 0 });
  }
  function navTo(where) {
    if (where === 'prev') return stepBy(-1);
    if (where === 'next') return stepBy(+1);
    if (where === 'prevSlide') return slideBy(-1);
    if (where === 'nextSlide') return slideBy(+1);
    const c = currentChanges();
    if (c) return showStop(where === 'first' ? 0 : c.stops.length - 1);
    if (where === 'first') return previewGoto(1);
    return previewGoto(previewTotal() || previewSlide + 1);
  }

  async function restorePreview(frame, entry, { force = false } = {}) {
    if (!entry) return;
    if (historyChangesOn()) {
      const fresh = force || entry.hash !== previewEntry;
      previewEntry = entry.hash;
      const c = await loadChanges(entry);
      // the row moved on while the answer was on its way
      if (restoreRows[restoreSel] !== entry || !restoreEl) return;
      if (c) return fresh ? showStop(0) : showStop(stopAt, { step: previewStep });
      // no answer (git could not say): fall back to every slide, quietly
    }
    previewEntry = entry.hash;
    // a row re-selected is a message, not a reload — the same short-circuit the
    // finder and the pickers have always had
    const same = entry.hash === previewDoc;
    aim(entry.hash, same ? previewSlide : 1, same ? previewStep : 0);
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
      return toast(`the progress bar moved to J — ${cannot('history')}`, 3800);
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
          ['first', 'prevSlide', 'prev'].map((k) => navBtn(k)).join('') +
          '<span class="hs-pos" aria-live="polite"></span>' +
          ['next', 'nextSlide', 'last'].map((k) => navBtn(k)).join('') +
        '</div>' +
        '<div class="hs-kind" hidden></div>' +
        '<div class="tp-caption"></div>' +
        // Two rows, because they are two kinds of control: the transport moves
        // through the version, these change what you see of it. Each switch
        // keeps ONE label and shows its state in the box: "all slides" that
        // turned into "changes" when pressed read as a state to some and as
        // an action to others, and "CC" and "details" said too little.
        '<div class="hs-view" role="group" aria-label="View">' +
          viewSwitch('hs-only', 'changed slides only', 'D') +
          (toggleCaptions ? viewSwitch('hs-cc', 'captions', 'C') : '') +
          viewSwitch('hs-details', 'more info', 'I') +
        '</div></div></div>';
    // textContent for both: a branch name is arbitrary text, and the title is
    // built from a mode rather than pasted in.
    // Short on purpose. This bar is `white-space: nowrap`, so its text is the
    // rail's min-content width — the long version of this string is literally
    // what collapsed the preview to 57px. The keys it drops are all on screen:
    // the transport draws ←→, the switches name D, C and I, and ⏎/Esc are in
    // the confirmation card.
    restoreEl.querySelector('.tp-filter').textContent = 'History — ↑↓ browse · ←→ build · ⇧←→ slide · ⏎ restore';
    const remoteEl = restoreEl.querySelector('.hs-remote');
    // The server sends the sentence ready-made — cli/git.mjs spawns git and the
    // runtime cannot import it, so the words live in one place on that side.
    if (remote?.line) remoteEl.textContent = remote.line;
    else remoteEl.remove();
    for (const b of restoreEl.querySelectorAll('.hs-btn[data-go]')) {
      b.addEventListener('click', () => navTo(b.dataset.go));
    }
    restoreEl.querySelector('.hs-details').addEventListener('click', toggleHistoryDetails);
    applyHistoryDetails();
    restoreEl.querySelector('.hs-cc')?.addEventListener('click', toggleHistoryCaptions);
    applyHistoryCaptions();
    restoreEl.querySelector('.hs-only').addEventListener('click', toggleHistoryChanges);
    applyHistoryChanges();
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
    window.addEventListener('message', onPreviewState);
    selectRestoreRow(0, true);
  }
  function viewSwitch(cls, label, key) {
    return `<button type="button" role="switch" aria-checked="false" class="hs-switch ${cls}">`
      + `<span class="hs-box" aria-hidden="true"></span>${label}<kbd>${key}</kbd></button>`;
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
    window.removeEventListener('message', onPreviewState);
    restoreEl?.remove();
    restoreEl = null;
    restoreArmed = false;
    previewDoc = null;
    previewEntry = null;
    previewStep = 0;
    previewSteps = null;
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
      toast(`restored ${entry.hash} — ${UNDO_CHORD} takes it back`, 2600);
    } catch { toast('restore failed: the edit server did not answer', 3000); }
  }
  // typing surfaces — the textarea handles its own keys. Floating, each is
  // the modal it always was; docked, the deck's keys work whenever the caret
  // is not in the textarea.
  overlays.register({
    isOpen: () => !!editEl,
    close: toggleEditor,
    panel: true,
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
    panel: true,
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
        // ←→ a build at a time, as in the talk; ⇧ for a whole slide
        case 'ArrowLeft': navTo(e.shiftKey ? 'prevSlide' : 'prev'); break;
        case 'ArrowRight': navTo(e.shiftKey ? 'nextSlide' : 'next'); break;
        case 'Home': navTo('first'); break;
        case 'End': navTo('last'); break;
        // I, as in more info; C is the deck's closed captions, which the
        // preview now shows: the version's own notes under its slide
        case 'i': case 'I': toggleHistoryDetails(); break;
        case 'c': case 'C': toggleHistoryCaptions(); break;
        case 'd': case 'D': toggleHistoryChanges(); break;
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
    // The gate. In `--no-trust`, in a bundled deck, or on file:// with no author
    // server, there is nothing to post a credential TO — and a prompt that
    // collected one anyway would be a phishing form with a deck around it.
    if (!editAvailable) {
      toast(cannot('configuring an engine'), 3200);
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

  // ── stopping a long job (PRESENTING) ─────────────────────────────────────
  // A video is minutes, an agent run up to ten, and one started on the wrong
  // slides used to be a choice between waiting it out and killing the edit
  // server. The palette offers a Stop row while one runs — this page's, or
  // one another page (or this one, before a reload) started, which is what
  // the `…Busy` flags mirror from /deck/ping and the event stream.
  const STOP_HOW = '/ → Stop to stop it';
  let exportBusy = null;   // { kind, what } while the server exports
  let enhanceBusy = false; // …rewrites the script
  let reviewBusy = false;  // …reviews the deck
  /** The job a Stop row would stop, as `{ label, path, run }` (`run`: this page's progress row for it), or null when nothing runs. */
  function running() {
    // not `editAvailable`: that is false while the deck is locked, and a stop
    // writes nothing, so the server answers it locked or not
    if (!served || noTrust) return null;
    const ex = exportRun ?? exportBusy;
    if (ex && ex.kind !== 'bundle') {
      return { label: `Stop the ${ex.what} export`, path: '/deck/edit/export/stop', run: exportRun?.run };
    }
    if (agentBusy) return { label: `Stop ${agentBusy.agent}'s edit`, path: '/deck/edit/agent/stop' };
    if (enhanceRun || enhanceBusy) return { label: 'Stop rewriting the script', path: '/deck/edit/agent/stop', run: enhanceRun?.run };
    if (reviewRun || reviewBusy) return { label: 'Stop the agent review', path: '/deck/edit/agent/stop', run: reviewRun?.run };
    return null;
  }
  async function stopRunning() {
    const job = running();
    if (!job) { toast('nothing is running'); return; }
    try {
      const r = await fetch(editBase + job.path, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      // The job's own row (or the agent's toast) says when it has stopped,
      // which can be before this answer lands; until then the row says the
      // stop was heard, since a render takes a moment to clear up.
      job.run?.update('stopping…');
      debugLog('stop', job.label);
    } catch (e) {
      toast(`could not stop it — ${e.message}`, 4000);
    }
  }
  // what `audio` a bundle carries its narration as, when it is not as recorded
  const AUDIO_HOW = { aac: 'AAC', opus: 'Opus' };
  /**
   * How big the bundle would be (GET /deck/edit/export/estimate): the file without
   * its audio, and what each way of carrying the audio adds — of one chapter,
   * when `module` (its number) is given. Null when the server cannot say; the
   * reason is toasted, since bundling would hit it too.
   */
  async function bundleEstimate({ module = null } = {}) {
    try {
      // in the theme on screen, which is what the export will bundle in
      const { theme } = renderTheme() ?? {};
      const r = await fetch(editBase + '/deck/edit/export/estimate?kind=bundle' + (theme ? `&theme=${encodeURIComponent(theme)}` : '')
        + (module != null ? `&module=${module}` : ''));
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

  // What a bundle's card repeats of the notes `decklight bundle` prints after
  // the file: which chapter went in, and where the narration audio is.
  const BUNDLE_SAYS = /^(module \d+ of \d+:|narration audio:)/;
  async function exportDeck(kind, { slides = null, voice = null, format = null, quality = null, subtitles = null, face = null, audio = false, module = null } = {}) {
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
    if (markConfirmed(theme, { kind, opts: { slides, voice, format, quality, subtitles, face, audio, module } })) return;
    const doing = kind === 'video'
      ? `${voicing ? 'voicing and rendering' : 'rendering'} a video of ${rangeLabel(slides)}${older}`
      : `exporting ${kind === 'bundle' && module != null ? `module ${module} ` : ''}to ${what}`
        + `${audio ? `, with the narration audio${AUDIO_HOW[audio] ? ` as ${AUDIO_HOW[audio]}` : ''}` : ''}`;
    // a bundle is seconds; anything else can be stopped, and says how
    const run = progress(`${doing} — this takes a moment…${kind === 'bundle' ? '' : ` (${STOP_HOW})`}`);
    exportRun = { run, what, doing, kind };
    try {
      const r = await fetch(editBase + '/deck/edit/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          ...(theme ? { theme } : gen ? { gen } : {}),
          ...(kind === 'video' ? { slides, format, quality, subtitles, ...(face ? { face } : {}), ...videoVoice(voice) } : {}),
          ...(kind === 'bundle' && audio ? { audio } : {}),
          ...(kind === 'bundle' && module != null ? { module } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.unmarked) {
        armMark(j.unmarked, theme, run, { bundles: kind === 'bundle' });
        return;
      }
      if (j.stopped) {
        run.done(`stopped — no ${what} written${j.voiced ? ` · the slides already voiced are kept in ${j.voiced}/` : ''}`, j.voiced ? 6000 : undefined);
        debugLog('export', `${kind} stopped`);
        return;
      }
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      const says = (j.notes ?? []).filter((n) => BUNDLE_SAYS.test(n));
      run.done(`wrote ${j.file}${j.seconds ? ` (${j.seconds}s)` : ''}${j.subtitles ? ` · subtitles in ${j.subtitles}` : ''}`
        + `${j.voiced ? ` — its voice is in ${j.voiced}/` : ''}${says.map((n) => ` · ${n}`).join('')}`, says.length ? 9000 : undefined);
      debugLog('export', `${kind} → ${j.file}`);
    } catch (e) {
      run.done(`could not export to ${what} — ${e.message}`, 5200);
      debugLog('export', `${kind} failed: ${e.message}`);
    } finally {
      exportRun = null;
    }
  }

  // ── the voiceover script, rewritten by the agent ──────────────────────────
  // Three rewrites (cli/enhance.mjs, SPEC PRESENTING): `tags` gives it the audio
  // tags ElevenLabs v4 performs, same words; `spoken` writes it for the ear —
  // terse notes turned into sentences a person would say; `match-slide`
  // rewords it to agree with what the slide shows. The agent drafts
  // (read-only), decklight checks and writes. One run at a time; `scope` is
  // 'slide', 'module' (the data-module chapter this slide is in) or 'all'.
  let enhanceRun = null;
  const enhanceEnded = new Set();   // told when a run ends, however it ends: the notes card's "rewriting…" mark
  const endEnhance = () => { enhanceRun = null; for (const fn of [...enhanceEnded]) fn(); };
  const REWRITES = {
    rewrite: { doing: 'rewriting', with: '', drafting: 'rewriting it', done: (x) => `rewrote ${x}` },
    tags: { doing: 'enhancing', with: ' with ElevenLabs audio tags', drafting: 'drafting audio tags', done: (x) => `enhanced ${x}` },
    spoken: { doing: 'writing for the ear', with: '', drafting: 'rewriting it as spoken sentences', done: (x) => `wrote ${x} for the ear` },
    'match-slide': { doing: 'matching the script to the slide', with: '', drafting: 'reading the slide', done: (x) => `matched ${x} to the slide` },
    // the slide's own text (cli/rewrite.mjs, PRESENTING_WRITING)
    tighten: { doing: 'tightening', with: '', drafting: 'tightening the slide text', done: (x) => `tightened ${x}`, text: true },
    typos: { doing: 'fixing typos and grammar', with: '', drafting: 'reading the slide text', done: (x) => `fixed ${x}`, text: true },
    match: { doing: 'matching the slide text to the script', with: '', drafting: 'reading the notes', done: (x) => `matched ${x} to the script`, text: true },
    custom: { doing: 'rewriting the slide text', with: '', drafting: 'rewriting the slide text', done: (x) => `rewrote ${x}`, text: true },
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
  // The Writing picker: which tool, which slides, then the run (writing.js)
  const writing = createWritingPicker({
    root, overlays, toast,
    tools: () => (editAvailable && editAgents.length ? WRITING_TOOLS : []),
    // the open notes card's selection or build part leads the scopes, for a tool that takes one
    where: () => ({ slide: instance.state.slide, total: instance.state.totalSlides, module: moduleOf(instance.state.slide), passage: notesPassage?.() ?? null }),
    agent: () => { const a = editAgents.find((x) => x.name === preferredAgent) ?? editAgents[0]; return a ? { label: a.label, model: a.model ?? null } : null; },
    run: (tool, scope, { instruction = '', passage = null } = {}) => enhanceScript(scope, { kind: tool.kind, instruction, passage }),
  });
  /** The picker, from any entry point: the notes editor, the V panel, the palette, the slide's menu. */
  function openWriting(opts = {}) {
    if (!editAvailable) { toast(cannot('rewriting the notes'), 3200); return; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return; }
    writing.open(opts);
  }
  /**
   * A writing tool, run: the notes (`tags`, `spoken` → /deck/edit/enhance) or
   * the slide's own text (`tighten`, `typos`, `match`, `custom` →
   * /deck/edit/rewrite), over this slide, its module or the deck. Either way
   * the answer is held for review (#907); the run itself only reports.
   */
  async function enhanceScript(scope = 'slide', { kind = 'tags', instruction = '', passage = null } = {}) {
    const k = REWRITES[kind] ?? REWRITES.tags;
    if (!editAvailable) { toast(cannot(k.text ? 'rewriting the slide text' : kind !== 'tags' ? 'rewriting the notes' : 'enhancing the script'), 3200); return; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return; }
    if (enhanceRun) { toast('the agent is already rewriting — one run at a time'); return; }
    // a passage (the notes card's selection, or a build's part) is of its own slide
    const part = (scope === 'selection' || scope === 'build') && passage ? passage : null;
    const slide = part?.slide ?? instance.state.slide;
    const mod = scope === 'module' ? moduleOf(slide) : null;
    if (scope === 'module' && !mod) { toast('this slide is not in a module — the deck marks none before it (data-module)', 4000); return; }
    const slides = scope === 'all' ? 'all'
      : mod ? Array.from({ length: mod.to - mod.from + 1 }, (_, i) => mod.from + i) : [slide];
    const noun = k.text ? 'text' : 'script';
    const what = part ? `${part.scope === 'selection' ? 'the selection in' : `${part.label.replace('this build · ', '')} of`} slide ${slide}'s ${noun}`
      : scope === 'all' ? `every slide's ${noun}`
        : mod ? `the “${mod.title}” module (slides ${mod.from}–${mod.to})` : `slide ${slide}'s ${noun}`;
    const run = progress(`${k.doing}: ${what}${k.with} — asking the agent… (${STOP_HOW})`);
    enhanceRun = { run, what, kind, passage: part };
    try {
      const r = await fetch(editBase + (k.text ? '/deck/edit/rewrite' : '/deck/edit/enhance'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(k.text ? { slides, tool: kind, instruction }
          : { slides, kind, ...(part ? { passage: { from: part.from, to: part.to, text: part.text } } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      enhanceRun.of = j.of;
      run.update(`${k.doing}: ${what} — ${j.label || j.agent} is ${k.drafting} (read-only)…`);
      debugLog('enhance', `${kind}: ${j.of} slide(s) → ${j.agent}`);
    } catch (e) {
      run.done(`could not rewrite ${what} — ${e.message}`, 5200);
      endEnhance();
    }
  }
  /** What a finished run says, in one line. */
  function enhanceSummary(d) {
    const k = REWRITES[d.kind] ?? REWRITES.tags;
    if (d.stopped) return 'stopped — the script is as it was';
    if (!d.ok) return `could not rewrite the script — ${d.error}`;
    const n = d.changed.length;
    const parts = [n ? `${k.done(n === 1 ? `slide ${d.changed[0]}` : `${n} slides`)} — ${d.candidate ? 'review it before it lands' : `${UNDO_CHORD} undoes`}` : 'no slide changed'];
    if (d.failed.length) {
      parts.push(d.failed.length === 1 ? `slide ${d.failed[0].slide} left as it was: ${d.failed[0].why}`
        : `${d.failed.length} left as they were (the agent's answer did not pass the check)`);
    }
    if (d.stale.length) parts.push(`${d.stale.length === 1 ? `slide ${d.stale[0]}` : `${d.stale.length} slides`} edited meanwhile, kept`);
    return parts.join(' · ');
  }
  function enhanceEvent(d) {
    if (d.state === 'start') enhanceBusy = true;
    else if (d.state === 'done') enhanceBusy = false;
    if (d.state === 'slide' && enhanceRun) {
      enhanceRun.run.update(`${(REWRITES[enhanceRun.kind] ?? REWRITES.tags).doing}: ${enhanceRun.what} — ${d.done} of ${d.of} slide${d.of === 1 ? '' : 's'}…`);
    } else if (d.state === 'done') {
      const line = enhanceSummary(d);
      if (enhanceRun) enhanceRun.run.done(line, 6000); else toast(line, 6000);
      endEnhance();
      debugLog('enhance', line);
      // held for review (#907): nothing landed, the review opens on it
      if (d.candidate?.id) fixReview.open(d.candidate.id);
    }
  }
  // ── the agent review (Check deck…, SPEC PRESENTING) ────────────────────────
  // The agent reads the deck, read-only, against cli/agent-review.mjs's rules;
  // the server checks every answer and keeps the findings. This page fetches
  // them on every connect (a fix reloads it) and hands them to Check deck…,
  // where `f` on one sends its prepared instruction to the A agent.
  let reviewRun = null;
  let review = { reviewed: false, findings: [] };
  const reviewListeners = new Set();
  // told when the marketplace auto-check a starting server ran lands
  const marketplaceListeners = new Set();
  async function loadReview() {
    try {
      const j = await (await fetch(editBase + '/deck/edit/review')).json();
      if (j?.ok) review = { reviewed: !!j.reviewed, findings: Array.isArray(j.findings) ? j.findings : [], failed: j.failed ?? [], agent: j.agent };
    } catch { /* no server: no findings */ }
    return review;
  }
  async function reviewDeck() {
    if (!editAvailable) { toast(cannot('reviewing the deck'), 3200); return; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return; }
    if (reviewRun) { toast('the agent is already reviewing the deck — one review at a time'); return; }
    const run = progress(`agent review: asking the agent… (${STOP_HOW})`);
    reviewRun = { run };
    try {
      const r = await fetch(editBase + '/deck/edit/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the server said ${r.status}`);
      run.update(`agent review: ${j.label || j.agent} is reading the deck (read-only)…`);
      debugLog('review', `${j.of} batch(es) → ${j.agent}`);
    } catch (e) {
      run.done(`could not review the deck — ${e.message}`, 5200);
      reviewRun = null;
    }
  }
  async function reviewEvent(d) {
    if (d.state === 'start') reviewBusy = true;
    else if (d.state === 'done') reviewBusy = false;
    if (d.state === 'batch' && reviewRun) {
      reviewRun.run.update(`agent review: ${d.done} of ${d.of} part${d.of === 1 ? '' : 's'} read · ${d.found} finding${d.found === 1 ? '' : 's'} so far…`);
    } else if (d.state === 'done') {
      const line = d.stopped ? 'agent review stopped — Check deck… keeps what the last one found'
        : !d.ok ? `could not review the deck — ${d.error}`
        : `agent review: ${d.found ? `${d.found} finding${d.found === 1 ? '' : 's'}, in Check deck…` : 'nothing to improve'}`
          + (d.failed?.length ? ` · ${d.failed.length} part${d.failed.length === 1 ? '' : 's'} went unanswered` : '');
      if (reviewRun) reviewRun.run.done(line, 6000); else toast(line, 6000);
      reviewRun = null;
      debugLog('review', line);
      if (d.ok) { await loadReview(); for (const fn of reviewListeners) fn(review); }
    }
  }
  /**
   * An ask to the A agent prepared elsewhere — a review finding's instruction,
   * a Check deck… judgement fix: an ordinary edit (one undo entry, one commit
   * under `message`), watched in the agent panel, which opens docked on it
   * the way Migrate's does. Answers whether it was sent.
   */
  async function askAgent({ prompt, slide, message, review = false, rule = null }) {
    if (!editAvailable) { toast(cannot('fixing it'), 3200); return false; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return false; }
    if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return false; }
    try {
      // a quick fix is held for the review view unless Settings turned that off (#907)
      const held = review && fixReviewOn();
      const sent = await postAgentJob(editBase + '/deck/edit/agent',
        { prompt, slide, message, ...(held ? { review: true, rule } : {}), ...(preferredAgent && editAgents.some((a) => a.name === preferredAgent) ? { agent: preferredAgent } : {}) });
      if (!sent) return false;
      const { res, j } = sent;
      if (!res.ok) throw new Error(j.error || res.status);
      debugLog('agent', `${message ?? 'ask'} → ${j.agent}`);
      // progress lands as SSE 'agent' events, as for any ask; the reload follows the save
      rememberAgentOpen(true);
      if (!agentEl) toggleAgentAsk(); else paintAsks?.();
      return true;
    } catch (e) {
      toast(`could not ask for the fix: ${String(e.message || e).slice(0, 60)}`, 2600);
      return false;
    }
  }
  /**
   * Check deck…'s Explain further: the same agent, asked read-only (the server's
   * `explain`), answering in the agent panel. Nothing is written, no undo entry,
   * no commit. `follow` is the fix the panel offers once the answer is in.
   * Answers whether it was sent.
   */
  async function explainAgent({ prompt, slide, message, follow = null }) {
    if (!editAvailable) { toast(cannot('explaining it'), 3200); return false; }
    if (!editAgents.length) { toast('no agent CLI detected on the dev machine (claude, codex, bob, …)', 2600); return false; }
    if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return false; }
    try {
      const sent = await postAgentJob(editBase + '/deck/edit/agent',
        { prompt, slide, message, explain: true, ...(follow ? { follow } : {}), ...(preferredAgent && editAgents.some((a) => a.name === preferredAgent) ? { agent: preferredAgent } : {}) });
      if (!sent) return false;
      const { res, j } = sent;
      if (!res.ok) throw new Error(j.error || res.status);
      debugLog('agent', `${message ?? 'explain'} → ${j.agent} (read-only)`);
      rememberAgentOpen(true);
      if (!agentEl) toggleAgentAsk(); else paintAsks?.();
      return true;
    } catch (e) {
      toast(`could not ask for the explanation: ${String(e.message || e).slice(0, 60)}`, 2600);
      return false;
    }
  }
  /** `f` on an agent-review finding: its prepared instruction, as an A edit held for the review first (#907). */
  const fixFinding = (f) => askAgent({ prompt: f.prompt, slide: f.slide, message: `review: ${f.label} on slide ${f.slide}`, review: true, rule: f.rule ?? null });

  /**
   * A quick fix Check deck… offers for one of `decklight check`'s findings
   * (PRESENTING_EDITING): applied by the server (`POST /deck/edit/check/fix`,
   * cli/check-fixes.mjs) as one undo step and one commit, and recorded in the
   * agent panel's log as an entry by decklight. `ds-behind` is Migrate. The
   * answer is the route's, or null when nothing was done.
   */
  async function fixProblem({ rule, slide = null, ref = null, all = false, review = false }) {
    if (!editAvailable) { toast(cannot('fixing it'), 3200); return null; }
    if (agentBusy) { toast(`${agentBusy.agent} is still working on the last ask`, 2200); return null; }
    if (rule === 'ds-behind') return (await migrateDesignSystem(ref)) ? { ok: true } : null;
    try {
      const res = await writeFetch(editBase + '/deck/edit/check/fix', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rule, slide, ref, all, ...(review && fixReviewOn() ? { review: true } : {}), ...(preferredAgent && editAgents.some((a) => a.name === preferredAgent) ? { agent: preferredAgent } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      // held for review (#907): nothing was written, the review opens on it
      if (res.ok && j.ok && j.held) {
        debugLog('check', `fix ${rule} held for review: ${j.said}`);
        fixReview.open(j.candidate.id);
        return j;
      }
      // the server's own entry is over by its answer: listed even if its event has not landed yet
      if (j.ask && !agentAsks.some((x) => x.id === j.ask.id)) { agentAsks.push(j.ask); paintAsks?.(); }
      if (!res.ok || !j.ok) throw new Error(j.error || res.status);
      debugLog('check', `fix ${rule}${slide ? ` on slide ${slide}` : all ? ' on every slide' : ''}: ${j.said}`);
      toast(j.changed ? `${j.said} — ${UNDO_CHORD} undoes · logged in the agent panel` : j.said, 3200);
      if (j.reload) location.reload();   // nothing in the deck changed, but what the page links did
      return j;
    } catch (e) {
      toast(`could not fix ${rule} — ${String(e.message || e).slice(0, 120)}`, 5000);
      return null;
    }
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
    /** The long job a Stop row would stop — `{ label }` — or null (the palette's Stop row). */
    running: () => { const j = running(); return j && { label: j.label }; },
    stopRunning,
    /** Settings… → Push tags: does Push send the annotated tags with the branch. */
    pushTags: pushTagsOn,
    setPushTags,
    notesQuiet,
    notesQuietLabel,
    cycleNotesQuiet,
    /** Hold undo/redo until this write lands — the gestures in authoring.js post outside this module. */
    trackWrite,
    toggleEditor,
    /** The notes card for another module: open it on a slide, ask if it is open, be told once it closes. */
    notesFor: { open: editNotesFor, isOpen: () => !!editEl, onClose: (fn) => { notesClosed.add(fn); } },
    toggleAgentAsk,
    /** Migrate the deck onto a design system's new version, watched in the agent panel. */
    migrateDesignSystem,
    /** E — arm/disarm the right-click element menu (#112). Refuses outside write mode. */
    /** Is editing on? The palette's own on/off label and the editing bar ask. */
    elementEditOn: () => elementEditOn,
    /** Be told when E turns editing on or off. */
    onElementEditChange: (fn) => { elementEditListeners.add(fn); },
    /** What a click addresses: `{ sec, slide, index, top, clicked }`, or null. */
    elementTargetOf,
    /** The element's HTML in the content editor (the inspector's HTML tab). */
    editContent: (t) => { if (t && t.index != null) openElementContentEditor(t); },
    /** The inspector's own door, so the content editor can go back to it. */
    setInspectorOpener(fn) { inspectorOpen = fn; },
    /** The element menu, opened at a point by something other than a right-click: the bar's ⋯ handle and Slide ▾. */
    openElementMenuAt: (x, y, target, view = 'main', opts = {}) => { if (!elementEditOn) return; overlays.opening(); openElementMenu(x, y, target, view, opts); },
    /** Remove the element a target names: ⌫ on a selection. */
    removeElement: (target) => commitRemove(target),
    /** The engine's door to the inspector: `fn(target, tab)` for the menu's Inspect, Colors… and Type…. */
    setInspect: (fn) => { inspectHook = fn; },
    /** A pick from the inspector's Colors or Type tab, written in place. */
    saveStyles: (body) => { const p = saveStyles(body); trackWrite(p); return p; },
    /** Take a shape's concept off (the Colors tab's notice): in place through the concept tools, else with a reload. */
    detachConcept: (t) => (conceptTools && t.el ? conceptTools.attach([t.el], null) : postConcept({ ...t, concept: null }, null)),
    /** Where a shape's concept lives in the file (`conceptTarget`), and the in-place batch write (`writeConcepts`). */
    conceptTarget,
    writeConcepts,
    /** The engine's concept tools (concept-tools.js): the menu's Concept ▸ writes through them. */
    setConceptTools: (t) => { conceptTools = t; },
    /** The engine's style clipboard (style-clip.js): the menu's Copy style and Paste style rows. */
    setStyleClip: (c) => { styleClip = c; },
    /** The door to the concept list (Concept colors…), opened on a concept: the submenu's Edit concepts…. */
    setEditConcepts: (fn) => { editConcepts = fn; },
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
    /** Can this page change the deck? False with no server and in no-trust mode. */
    available: () => editAvailable,
    /** Did a server answer at all, and in which mode? */
    served: () => served,
    noTrust: () => noTrust,
    /** Why this page cannot write right now — locked, without trust, or no server — for a toast. */
    cannot,
    /** The lock (PRESENTING): its state, flipping it, and being told. */
    locked: () => locked,
    toggleLock,
    onLockChange: (fn) => { lockListeners.add(fn); },
    /** Resolves once the probe has an answer either way — see `settled`. */
    settled: () => { if (printMode || params.has('embedded')) probeSettled(); return settled; },
    /** This page's id, so a write it made and the server echoes is told from another page's. */
    pageId: () => PAGE_ID,
    /** Has the probe answered yet, either way? A door pressed before it has waits rather than refuses. */
    probed: () => probed,
    /** Its origin ('' when the deck is served BY the edit server); null without trust. */
    base: () => (noTrust ? null : editBase),
    /** K: the commit window — what changed, what to call it, one button. */
    commit: { open: openCommit, close: closeCommit, state: () => commitNow },
    /** The palette's hand-over rows: 'pptx' | 'pdf' | 'pdf-notes' | 'pdf-handout'. */
    exportDeck,
    bundleEstimate,
    enhanceScript,
    openWriting,
    moduleOf,
    /** The agent review: run it, its findings that still hold, a fix for one, and a word when they change. */
    reviewDeck,
    reviewFindings: () => review.findings,
    fixFinding,
    onReview: (fn) => { reviewListeners.add(fn); },
    /** Be told when the marketplace auto-check's answer lands (MARKETPLACES_SCREEN). */
    onMarketplaces: (fn) => { marketplaceListeners.add(fn); },
    /** Check deck…'s fixes: the server's own (`fixProblem`), and an ask to the A agent (`askAgent`); which agents there are; a word when a write lands. */
    fixProblem,
    askAgent,
    explainAgent,
    /** The review a quick fix opens (#907): its state for a probe, and Settings → Review quick fixes. */
    fixReview,
    reviewFixes: fixReviewOn,
    reviewAsks: askReviewOn,
    toggleAskReview,
    toggleFixReview,
    agents: () => editAgents.slice(),
    onWrite: (fn) => { writeListeners.add(fn); },
    /** The Publish row: the first call asks and arms, the second publishes. */
    publishDeck,
  };
}
