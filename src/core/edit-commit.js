// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One way to make an edit from the page (SPEC PRESENTING_EDITING).
//
// Every write-mode gesture that changes the deck in place (text, a label, a
// list, a picture, a chart's numbers, a shape, a move, an added element) is
// the same three steps: the page already shows the change, so it asks the
// server for a QUIET write (`quiet: true, from`: no reload here, every other
// page of the deck is told); a refusal is said one way, in the server's words
// or "the edit server is not answering"; and where the page cannot follow the
// file in place, it reloads, the drafts-safe way (drafts.js), onto the slide.
// What is shown, and what is put back on a refusal, stays each gesture's own.

import { boundedFetch } from './devmode.js';

export function createEditCommit(editmode) {
  /** The fields that make a write quiet: this page shows it itself. */
  const inPlace = () => ({ quiet: true, from: editmode.pageId?.() ?? null });
  /** Why a write did not land: the server away, or what it answered. */
  const why = (e) => (editmode.offline?.() ? 'the edit server is not answering' : String(e?.message || e));

  /**
   * One POST, bounded (boundedFetch: a request queued behind a saturated
   * socket pool would otherwise never fail), quiet unless `quiet: false`; its
   * undo counts noted for the bar, a refusal thrown in the server's words.
   * Not tracked: `post` is, and a flow that reads before it writes tracks
   * itself whole.
   */
  async function send(path, body, { quiet = true } = {}) {
    const res = await boundedFetch((editmode.base?.() ?? '') + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(quiet ? { ...body, ...inPlace() } : body),
    });
    const j = await res.json().catch(() => ({}));
    editmode.noteHistory?.(j);
    if (!res.ok || j.ok === false) throw new Error(j.error || `the edit server answered ${res.status}`);
    return j;
  }
  /** A write the undo chord waits for, as it waits for every write. */
  const track = (p) => { editmode.trackWrite?.(p); return p; };

  return {
    inPlace, why, send, track,
    post: (path, body, opts) => track(send(path, body, opts)),
    /** `what` not saved, and why. */
    notSaved: (what, e) => `${what} not saved: ${why(e)}`,
    /** The file has the edit and this page cannot show it: the reload that waits for drafts, onto `slide`. */
    reload(said, { slide = null } = {}) {
      if (Number.isInteger(slide)) location.hash = `#/${slide}/0`;
      if (editmode.reloadWhenSafe) editmode.reloadWhenSafe(said); else location.reload();
    },
  };
}
