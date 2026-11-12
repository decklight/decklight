// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Open in your editor (SPEC PRESENTING_EDITING): from a slide or an element
// on screen to its line in the deck file, in the author's code editor.
//
// The palette's "Open this slide in your editor", the element menu's "Open in
// your editor" and the slide menu's row all come here. The page sends the
// address the element routes take (slide, raw index, the file's path below it
// and the tag) and the server works out the line and starts the editor the
// author chose (cli/edit-open.mjs). The first time, the server says no editor
// is chosen yet, and the page asks once: a short card listing the editors this
// machine has. The choice is the author's, kept by the server for every deck,
// and Settings → Code editor changes it.
//
// What goes wrong is said with the action that mends it (another editor),
// never with a command to copy.

import { boundedFetch } from './devmode.js';

export function createOpenInEditor({ editmode, choiceCard, toast, actionToast = null, debugLog = () => {} }) {
  let chosen;   // undefined: not asked yet; null: nothing chosen; else { editor, label, template? }

  /** One call to the edit server: its JSON and its status, or a throw when it is not answering. */
  async function call(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await boundedFetch((editmode.base?.() ?? '') + path, init);
    const j = await res.json().catch(() => ({}));
    if (j && 'chosen' in j) chosen = j.chosen;
    return { ...j, status: res.status };
  }
  const usable = () => editmode.served?.() && !editmode.noTrust?.();
  const why = (e) => (editmode.offline?.() ? 'the edit server is not answering' : String(e?.message || e));

  /** What Settings shows: the editor chosen, asked of the server once. */
  async function refresh() {
    if (!usable()) return null;
    try { await call('/deck/edit/editor'); } catch (e) { debugLog('edit', `editor state: ${why(e)}`); }
    return chosen ?? null;
  }

  /** A command of your own, typed once: its words, with {file}, {line} and {column} filled in by the server. */
  function askTemplate() {
    const was = chosen?.editor === 'custom' ? chosen.template : 'myeditor --goto {file}:{line}:{column}';
    const typed = window.prompt?.('Your editor\'s command. Decklight fills in {file}, {line} and {column}, and runs it without a shell:', was);
    return typeof typed === 'string' && typed.trim() ? typed.trim() : null;
  }

  /**
   * The chooser: the editors this machine has, a terminal one dimmed with
   * the reason, and a command of your own. Resolves to the choice saved, or
   * null when the card closed without one or the server refused it.
   */
  async function choose(known = null) {
    if (!usable()) { toast(editmode.cannot?.('choosing your editor') ?? 'choosing your editor needs write mode', 3200); return null; }
    let list = known?.editors;
    if (!list) {
      try { list = (await call('/deck/edit/editor')).editors; } catch (e) { toast(`could not list your editors: ${why(e)}`, 5000); return null; }
    }
    if (!list?.length) return null;
    return new Promise((resolve) => {
      choiceCard.open({
        title: 'Open the deck in which editor?',
        lines: ['Asked once, for every deck. Settings → Code editor changes it.'],
        rows: list.map((e) => ({ label: e.label, value: e.id, note: e.note, blocked: e.blocked })),
        current: chosen?.editor ?? null,
        onCancel: () => resolve(null),
        onPick: async (id) => {
          const body = { editor: id };
          if (id === 'custom') {
            body.template = askTemplate();
            if (!body.template) { resolve(null); return; }
          }
          try {
            const j = await call('/deck/edit/editor', body);
            if (!j.ok) { toast(`that editor was not kept: ${j.error || j.status}`, 6000); resolve(null); return; }
            toast(`code editor: ${j.chosen.label}`, 2200);
            resolve(j.chosen);
          } catch (e) { toast(`that editor was not kept: ${why(e)}`, 6000); resolve(null); }
        },
      });
    });
  }

  /** A refusal said with what mends it: choosing another editor. */
  function sayWithChoice(msg) {
    if (!actionToast) { toast(`${msg} — choose another in Settings → Code editor`, 7000); return; }
    actionToast(msg, [['Choose another editor', () => { choose(); }]]);
  }

  /**
   * Open the deck at `addr` (`{ slide, index?, path?, tag? }`); `what` names
   * it in what the page says ("slide 3", "the element").
   */
  async function open(addr, what) {
    if (!usable()) { toast(editmode.cannot?.('opening it in your editor') ?? 'opening the deck in your editor needs write mode', 3200); return false; }
    try {
      let j = await call('/deck/edit/open', addr);
      if (j.status === 428 && j.choose) {
        if (!await choose(j)) return false;
        j = await call('/deck/edit/open', addr);
      }
      if (j.ok) { toast(`${what} opened in ${j.editor}, line ${j.line}`, 2400); return true; }
      if (j.stale) toast(`${what} is not where the page last saw it in the file — reload and try again`, 5000);
      else if (j.status === 422) sayWithChoice(`could not open your editor: ${j.error}`);
      else toast(`could not open your editor: ${j.error || `the edit server answered ${j.status}`}`, 6000);
    } catch (e) {
      toast(`could not open your editor: ${why(e)}`, 6000);
    }
    return false;
  }

  return {
    open,
    /** The slide on screen, at its <section>. */
    openSlide: (slide) => open({ slide }, `slide ${slide}`),
    choose: () => choose(),
    refresh,
    /** The chosen editor's name for Settings, or null (none yet, or not asked). */
    label: () => chosen?.label ?? null,
  };
}
