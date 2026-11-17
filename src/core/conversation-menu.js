// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn ▸ on the element menu (PRESENTING_EDITING): a conversation's turn
 * (DECK_ANATOMY) given another speaker or kind, a turn added after it, or it
 * removed. Each is one write through `POST /deck/edit/element/turn`, one undo;
 * the page follows the file as it follows any slide changed on disk. A turn's
 * words are typed in place with a double-click, as any text's are.
 */

import { pathFrom } from './colorpicker.js';
import { createEditCommit } from './edit-commit.js';
import { TURN_KINDS, TURN_ROLES } from '../../tools/conversation.mjs';

const KIND_LABEL = { speech: 'Speech', thought: 'Thought', 'tool-call': 'Tool call' };

/** The turn a menu target means: the selected node's turn of a conversation, inside its top; null off one. */
export function turnOf(t) {
  // the node selected inside the block, else what the click landed on (a first click selects the conversation whole)
  for (const n of [t?.node, t?.clicked]) {
    const turn = n && t.top?.contains(n) ? n.closest?.('.conversation > :not(aside, script, style, template)') : null;
    if (turn && t.top.contains(turn)) return turn;
  }
  return null;
}

export function createConversationMenu({ editmode, toast }) {
  const em = () => editmode();
  const commit = createEditCommit({ base: () => em()?.base?.() ?? '', pageId: () => em()?.pageId?.(), offline: () => em()?.offline?.(),
    noteHistory: (j) => em()?.noteHistory?.(j), trackWrite: (p) => em()?.trackWrite?.(p) });

  /** The menu's rows for a target: who speaks and what kind, each ticked, then add and remove; [] off a turn. */
  function rows(t, close) {
    const turn = turnOf(t);
    if (!turn || !em()?.available?.()) return [];
    const role = turn.getAttribute('data-role') ?? '';
    const kind = turn.getAttribute('data-kind') || 'speech';
    const roles = TURN_ROLES.includes(role) || !role ? TURN_ROLES : [...TURN_ROLES, role];
    const out = [{ head: 'Who speaks' }];
    for (const r of roles) out.push({ label: `${r === role ? '✓ ' : ''}${r}`, run: () => { close(); if (r !== role) write(t, 'role', r); } });
    out.push({ head: 'Kind' });
    for (const k of TURN_KINDS) out.push({ label: `${k === kind ? '✓ ' : ''}${KIND_LABEL[k]}`, run: () => { close(); if (k !== kind) write(t, 'kind', k); } });
    out.push({ sep: true });
    out.push({ label: 'Add a turn after', run: () => { close(); write(t, 'add'); } });
    const alone = turn.parentElement.querySelectorAll(':scope > :not(aside, script, style, template)').length <= 1;
    out.push(alone
      ? { label: 'Remove this turn', disabled: true, run: () => toast('a conversation keeps one turn: remove the conversation instead', 3200) }
      : { label: 'Remove this turn', run: () => { close(); write(t, 'remove'); } });
    return out;
  }

  /** One turn edit, written: `op` role, kind, add or remove. */
  async function write(t, op, value = null) {
    const turn = turnOf(t);
    if (!turn || t.index == null) return false;
    const path = pathFrom(t.top, turn);
    if (!path?.length) { toast('that turn is the engine’s, not the file’s', 2600); return false; }
    try {
      await commit.post('/deck/edit/element/turn', { slide: t.slide, index: t.index, path, tag: turn.tagName.toLowerCase(), op, value }, { quiet: false });
      toast(op === 'add' ? 'a turn added after it: double-click it to type its words'
        : op === 'remove' ? 'turn removed'
          : op === 'role' ? `now said by ${value}` : `now a ${KIND_LABEL[value].toLowerCase()}`, 2400);
      return true;
    } catch (e) {
      toast(`turn not changed: ${commit.why(e)}`, 6000);
      return false;
    }
  }

  return { rows, write, turnOf };
}
