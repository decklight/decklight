// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Open in your editor (PRESENTING_EDITING): from a slide or an element on
// screen to its place in the deck FILE, in the author's code editor.
//
//   GET  /deck/edit/editor   the saved choice and what this machine offers
//   POST /deck/edit/editor   { editor, template? }: remember the choice
//   POST /deck/edit/open     { slide, index?, path?, tag? }: open the deck
//                            at that slide's <section>, or at that element
//
// The address is the one every element route takes (cli/edit-address.mjs):
// a slide, an element's raw index among the section's children, and for a
// node inside it the file's `path` below it and the `tag` the page saw. The
// line and column come from the file's own offsets, so a path the file does
// not have is stale (409), never a guess.
//
// Nothing of the request reaches the command but the line and the column,
// numbers the server computed itself. The program is the author's saved
// choice, the file is always the deck being served, and it is started as an
// argument array without a shell (cli/code-editor.mjs). The two POSTs answer
// this server's own page only (isOwnOrigin): a plugin's sandboxed frame or
// another loopback page cannot set a command, nor start one.

import { locateSlide } from '../tools/deck-html.mjs';
import { locateElement, nodeAt, checkPath } from './edit-address.mjs';
import { detectEditors, loadEditorChoice, saveEditorChoice, checkChoice, choiceLabel, editorCommand, launchEditor } from './code-editor.mjs';

/** Line and column (both from 1) of `offset` in `text`: columns count characters, a tab one. */
export function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: (before.match(/\n/g)?.length ?? 0) + 1, column: [...before.slice(lineStart)].length + 1 };
}

/**
 * Where an address starts in the deck file: `{ offset, line, column }` of
 * slide `slide`'s `<section`, or with `index` of that element's open tag, or
 * with `path` of the node there. A slide or an index the file does not have
 * throws; a path it does not have, or a tag that is not the page's, is STALE.
 */
export function sourcePosition(html, { slide, index = null, path = null, tag = null }) {
  const { parts, idx } = locateSlide(html, slide);
  // parts: [preamble, '<section', body1, '<section', body2, …]
  const sectionAt = parts.slice(0, idx - 1).join('').length;
  if (index === null) return { offset: sectionAt, ...lineColumn(html, sectionAt) };
  const { seg, r } = locateElement(html, slide, index);
  const bodyAt = sectionAt + parts[idx - 1].length;
  const el = seg.slice(r.start, r.end);
  const at = nodeAt(el, path ? checkPath(path) : [], { slide, index, tag });
  const offset = bodyAt + r.start + at.start;
  return { offset, ...lineColumn(html, offset) };
}

/**
 * The three routes, given what they need of the edit server: the deck's
 * text and path, the gate that says a request is this server's own page,
 * and (for the tests) the environment the editor is looked up in and the
 * spawner that starts it.
 */
export function registerOpenRoutes(routes, {
  readDeck, deckPath, ownOrigin, env = process.env, spawn, platform = process.platform, exists, log = console.log,
}) {
  const where = { env, platform, ...(exists ? { exists } : {}) };
  const state = () => {
    const chosen = loadEditorChoice(env);
    return {
      chosen: chosen ? { ...chosen, label: choiceLabel(chosen, { env }) } : null,
      editors: detectEditors(where),
    };
  };
  const refuseForeign = (req, json) => {
    if (ownOrigin(req)) return false;
    json(403, { ok: false, error: 'only this deck\'s own page can open your editor' });
    return true;
  };

  /** `GET /deck/edit/editor`: what is chosen, and what the chooser lists. */
  function editorStateRoute({ json }) {
    return json(200, { ok: true, ...state() });
  }

  /** `POST /deck/edit/editor` `{ editor, template? }`: remember it; `{ editor: null }` forgets it. */
  function editorSaveRoute({ req, body, json }) {
    if (refuseForeign(req, json)) return;
    const asked = JSON.parse(body || '{}');
    if (asked?.editor === null) {
      saveEditorChoice(null, env);
      log('  editor: choice forgotten');
      return json(200, { ok: true, ...state() });
    }
    let choice;
    try { choice = checkChoice(asked); } catch (e) { return json(400, { ok: false, error: String(e.message || e) }); }
    // a named editor this machine does not have is not a choice to keep
    const offered = detectEditors(where).find((e) => e.id === choice.editor);
    if (!offered) return json(400, { ok: false, error: `${choiceLabel(choice, { env })} is not on this machine` });
    if (offered.blocked) return json(400, { ok: false, error: offered.blocked });
    saveEditorChoice(choice, env);
    log(`  editor: ${choiceLabel(choice, { env })} remembered`);
    return json(200, { ok: true, ...state() });
  }

  /**
   * `POST /deck/edit/open` `{ slide, index?, path?, tag? }`: the deck opened
   * in the saved editor at that place. 409 for an address the file does not
   * have (stale, like the other element routes); 428 with `choose: true`
   * before an editor is chosen; 422 with `reason` when the chosen one cannot
   * be started from here (not installed, a terminal editor).
   */
  async function openRoute({ req, body, json }) {
    if (refuseForeign(req, json)) return;
    const { slide, index = null, path = null, tag = null } = JSON.parse(body || '{}');
    if (!Number.isInteger(slide) || slide < 1 || (index !== null && (!Number.isInteger(index) || index < 0))
        || (path !== null && !Array.isArray(path)) || (path !== null && index === null) || (tag !== null && typeof tag !== 'string')) {
      return json(400, { ok: false, error: 'bad payload' });
    }
    let pos;
    try {
      pos = sourcePosition(readDeck(), { slide, index, path, tag });
    } catch (e) {
      if (e.code === 'STALE' || /^no slide \d|no element at index/.test(e.message)) {
        return json(409, { ok: false, stale: true, error: String(e.message || e).split('\n')[0] });
      }
      if (e.message === 'bad path') return json(400, { ok: false, error: 'bad payload' });
      throw e;
    }
    const choice = loadEditorChoice(env);
    if (!choice) return json(428, { ok: false, choose: true, error: 'choose your code editor first', ...state() });
    const cmd = editorCommand(choice, { file: deckPath, line: pos.line, column: pos.column }, where);
    if (!cmd.ok) return json(422, { ok: false, reason: cmd.reason, error: cmd.error, ...state() });
    const started = await launchEditor(cmd, { ...(spawn ? { spawn } : {}) });
    if (!started.ok) {
      return json(422, { ok: false, reason: 'missing', error: `${cmd.label} did not start: ${started.error}`, ...state() });
    }
    log(`  editor: slide ${slide}${index === null ? '' : ` #${index}${path?.length ? ` › ${path.join('.')}` : ''}`} opened in ${cmd.label} at line ${pos.line}`);
    return json(200, { ok: true, line: pos.line, column: pos.column, editor: cmd.label });
  }

  routes.set('GET /deck/edit/editor', editorStateRoute);
  routes.set('POST /deck/edit/editor', editorSaveRoute);
  routes.set('POST /deck/edit/open', openRoute);
  return routes;
}
