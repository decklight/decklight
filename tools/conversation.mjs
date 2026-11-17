// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A conversation's vocabulary (SPEC DECK_ANATOMY, #1179), shared by the
// runtime (src/core/conversation.js), the edit server's turn writes
// (cli/edit.mjs setConversationTurn) and the element menu's Turn ▸, so the
// three agree on what a turn may be. Pure; it ships in the runtime bundle.

/** The kinds a turn may be (`data-kind`): speech is the default, written as no attribute. */
export const TURN_KINDS = ['speech', 'thought', 'tool-call'];
/** The roles Turn ▸ offers; any other word is a role too, shown as the turn's label. */
export const TURN_ROLES = ['user', 'agent', 'tool', 'system'];
/** A role as an author may write one: a word, the label it shows. */
export const ROLE_WORD = /^[A-Za-z][\w-]{0,23}$/;

/** A call as an agent writes one: a name, its arguments in brackets. */
const CALL = /^([A-Za-z_$][\w$.:-]*)\s*\([\s\S]*\)\s*;?$/;

/** The tool a call names (`get_order(4417)` → `get_order`), or null. */
export function callName(text) {
  return CALL.exec(String(text ?? '').trim())?.[1] ?? null;
}

/**
 * The language a tool turn's words are coloured as: `json` when they parse
 * as a JSON object or array, `javascript` when they read as a call, null when
 * they are words.
 */
export function codeLanguage(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^[[{]/.test(t)) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
  }
  return CALL.test(t) ? 'javascript' : null;
}

/**
 * Who speaks after a turn of `role` and `kind`, for "Add a turn after": the
 * agent answers the user, the tool answers the agent's call, the agent reads
 * the tool's answer, and the user answers the agent; any other role speaks
 * again.
 */
export function nextTurnRole(role, kind = null) {
  if (role === 'agent') return kind === 'tool-call' ? 'tool' : 'user';
  if (role === 'user' || role === 'tool') return 'agent';
  if (role === 'system') return 'user';
  return role || 'user';
}
