// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A conversation — SPEC DECK_ANATOMY (#1179).
//
// `<div class="conversation">` holds turns, each an element with `data-role`
// (user, agent, tool, system, or any word, shown as the speaker's label) and
// optionally `data-kind` (thought, tool-call; speech when absent) and
// `data-name` (the tool's name). decklight.css draws the transcript from those
// attributes alone: the label is the turn's `::before`, the user's turns sit on
// one side and everyone else's on the other, so nothing is injected that the
// file does not have. What the runtime adds is three things:
//
//   - a tool's turn (a `tool-call`, or a turn whose role is `tool`) whose words
//     parse as JSON or read as a call (`get_order(4417)`) is coloured as code,
//     its words kept as written for the inline editor (plainTurn);
//   - live, a conversation taller than the room its slide gives it is held to
//     that room and scrolls inside itself, the newest turn in view as it
//     builds, the way a terminal keeps its last line (TERMINAL_PLAYER);
//   - in print (`?print`, `decklight pdf`) it is shown whole, shrunk to fit as
//     `data-fit` code is (CODE_AND_MATH), never cut at the bottom of its box.
//
// Everything is applied synchronously: a headless render paints no frame, so
// nothing here waits for one.

import { highlightText } from '../code/code.js';
import { fitsNow, chainTo, largestFitting, FIT_MIN } from '../code/fit.js';
import { TURN_KINDS, TURN_ROLES, codeLanguage } from '../../tools/conversation.mjs';

export { TURN_KINDS, TURN_ROLES, codeLanguage };

/** What is not a turn: the notes, a script, a template. */
const NOT_A_TURN = 'aside, script, style, template';
/** A conversation's turns, in order. */
export const turnsOf = (conv) => [...(conv?.children ?? [])].filter((c) => !c.matches(NOT_A_TURN));

/** Is `el` a turn of a conversation? */
export const isTurn = (el) => !!el?.parentElement?.classList?.contains('conversation') && !el.matches(NOT_A_TURN);

/** Is `turn` a tool's: a call the agent makes, or what the tool answers? */
export const isToolTurn = (turn) => turn.getAttribute('data-kind') === 'tool-call' || turn.getAttribute('data-role') === 'tool';

/**
 * Colour the tool turns under `root` (a stage, a slide, a conversation) as
 * code. Idempotent: a turn already coloured and not changed since is left; a
 * turn whose words were typed over is coloured again; a turn the author wrote
 * markup in (a `<b>`, a link) is the author's and left as it is.
 */
export function setupConversations(root) {
  if (!root) return;
  const convs = root.matches?.('.conversation') ? [root] : [...(root.querySelectorAll?.('.conversation') ?? [])];
  for (const conv of convs) {
    // scrolled by hand (a wheel, a trackpad): its top edge fades while it is not at its start
    if (!conv.__dlScrollWatch) {
      conv.__dlScrollWatch = true;
      conv.addEventListener('scroll', () => conv.classList.toggle('conversation-scrolled', conv.scrollTop > 1), { passive: true });
    }
    for (const turn of turnsOf(conv)) {
      if (turn.isContentEditable) continue;   // being typed into: its words, as they are
      const was = turn.__dlTurnSource;
      if (was != null && turn.textContent === turn.__dlTurnShown && turn.classList.contains('turn-code')) continue;
      if (was == null && turn.firstElementChild) continue;   // the author's own markup
      const words = turn.textContent;
      const lang = isToolTurn(turn) ? codeLanguage(words) : null;
      const html = lang ? highlightText(dedent(words), lang) : null;
      if (html === null) {
        if (was != null) { turn.textContent = words; delete turn.__dlTurnSource; delete turn.__dlTurnShown; }
        turn.classList.remove('turn-code');
        continue;
      }
      turn.innerHTML = html;
      turn.__dlTurnSource = words;
      turn.__dlTurnShown = turn.textContent;
      turn.classList.add('turn-code');
    }
  }
}

/**
 * Words as a reader sees them in a box of their own: the blank lines round
 * them gone, and the indentation the file's nesting gave every line but the
 * first taken off, so JSON written across lines lines up. Pure.
 */
export function dedent(text) {
  const lines = String(text ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const first = lines[0].replace(/^\s+/, '');
  const rest = lines.slice(1);
  const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
  const cut = Number.isFinite(indent) ? indent : 0;
  return [first, ...rest.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)[0].length)))].join('\n');
}

/**
 * A coloured turn's words put back as plain text, before it is typed into:
 * the inline editor writes what the element holds, and the colouring's spans
 * are the runtime's, never the file's. True when it had any.
 */
export function plainTurn(el) {
  if (el?.__dlTurnSource == null) return false;
  el.textContent = el.__dlTurnSource;
  delete el.__dlTurnSource;
  delete el.__dlTurnShown;
  el.classList.remove('turn-code');
  return true;
}

// ── room: held to the slide live, whole and shrunk in print ─────────────────

/** Live: the conversation held to the room its slide gives it, scrolling inside past that. */
function holdToRoom(conv, section) {
  conv.style.removeProperty('max-height');
  conv.style.removeProperty('font-size');
  conv.removeAttribute('data-fit-scale');
  const chain = chainTo(conv.parentElement, section);
  if (fitsNow([], chain)) return;
  const natural = conv.scrollHeight;
  const at = (k) => { conv.style.maxHeight = `${Math.max(1, Math.floor(natural * k))}px`; };
  const k = largestFitting((s) => { at(s); return fitsNow([], chain); }, { min: 0.1, max: 1 });
  at(k);
}

/** Print: the whole conversation, every turn, at the largest size that fits (CODE_AND_MATH's data-fit). */
function shrinkWhole(conv, section) {
  conv.style.removeProperty('max-height');
  conv.style.removeProperty('font-size');
  const chain = chainTo(conv.parentElement, section);
  const parentPx = parseFloat(getComputedStyle(conv.parentElement).fontSize) || 16;
  const basePx = parseFloat(getComputedStyle(conv).fontSize) || 16;
  const apply = (s) => conv.style.setProperty('font-size', `${(basePx * s / parentPx).toFixed(4)}em`);
  const k = largestFitting((s) => { apply(s); return fitsNow([], chain); }, { min: FIT_MIN, max: 1 });
  if (k === 1) conv.style.removeProperty('font-size');
  else apply(k);
  conv.setAttribute('data-fit-scale', k === 1 ? '1' : k.toFixed(3));
}

/**
 * Size every conversation on `section`: held to the slide and scrolled to its
 * newest turn live, whole and shrunk to fit in print. Run with the overflow
 * guardrail (engine.js checkOverflow), so it follows every change of the
 * slide's shape. A slide that is not laid out is left alone.
 */
export function fitConversations(section) {
  if (!section?.offsetWidth) return;
  const convs = [...section.querySelectorAll('.conversation')].filter((c) => !c.parentElement?.closest('.conversation'));
  if (!convs.length) return;
  const print = !!section.closest('.decklight-print');
  section.classList.add('dl-fit-measure');
  try {
    for (const conv of convs) (print ? shrinkWhole : holdToRoom)(conv, section);
  } finally {
    section.classList.remove('dl-fit-measure');
  }
  if (!print) for (const conv of convs) showNewest(conv);
}

/**
 * The turn a conversation keeps in view: the one its build just brought (or
 * the one a highlight build lights), else the last one shown; null when it
 * does not build, or nothing has arrived yet.
 */
export function newestTurn(conv) {
  const turns = turnsOf(conv);
  const state = (t) => t.getAttribute('data-build-state') ?? t.closest('.build-step')?.getAttribute('data-build-state') ?? null;
  if (!turns.some((t) => state(t) !== null)) return null;
  const current = turns.filter((t) => state(t) === 'current');
  if (current.length) return current.at(-1);
  return turns.filter((t) => state(t) === 'done').at(-1) ?? null;
}

/**
 * Scroll `conv` so its newest turn is in view at its bottom (TERMINAL_PLAYER's
 * scroll-to-newest), a turn taller than the box from its start; a
 * conversation that does not build, or has shown nothing yet, from its top.
 * Set at once, never smoothed: a frame may never come.
 */
export function showNewest(conv) {
  if (!conv) return;
  const turn = conv.scrollHeight > conv.clientHeight + 1 ? newestTurn(conv) : null;
  let top = 0;
  if (turn) {
    const cs = getComputedStyle(conv);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const bottom = turn.offsetTop + turn.offsetHeight + padBottom - conv.clientHeight;
    top = Math.max(0, Math.min(bottom, turn.offsetTop - padTop));
  }
  conv.scrollTop = top;
  conv.classList.toggle('conversation-scrolled', conv.scrollTop > 1);
}

/** Every conversation on `section` scrolled to its newest turn (a build, a slide arriving). */
export function showNewestIn(section) {
  if (!section || section.closest('.decklight-print')) return;
  section.querySelectorAll('.conversation').forEach(showNewest);
}
