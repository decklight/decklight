// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn into ▸ on the element menu (PRESENTING_EDITING): the selected text
 * block made Text, a Heading, a Small heading, a Quote, Bullets or Numbered.
 *
 * The block's SOURCE is read from the file (never the DOM the engine
 * decorated), retagged (block-kind.js) and written back through
 * `POST /deck/edit/element/content`, as a list's edits are: one write, one
 * undo. The write is the file's, and the page follows it as it follows any
 * slide changed on disk. A build that can no longer mean what it did is said.
 */

import { retagBlock, kindOf, kindsFor, KINDS } from './block-kind.js';
import { elementAt } from './list-edit.js';
import { pathFrom } from './colorpicker.js';
import { createEditCommit } from './edit-commit.js';

const BLOCKS = 'p, h1, h2, h3, h4, blockquote, ul, ol';

export function createTurnInto({ instance, editmode, toast }) {
  const em = () => editmode();
  const commit = createEditCommit({ base: () => em()?.base?.() ?? '', pageId: () => em()?.pageId?.(), offline: () => em()?.offline?.(),
    noteHistory: (j) => em()?.noteHistory?.(j), trackWrite: (p) => em()?.trackWrite?.(p) });

  /** The block a target means: the node selected, or the list a selected point is in, inside its top. */
  function blockOf(t) {
    if (!t?.top) return null;
    const n = t.node && t.top.contains(t.node) ? t.node : t.top;
    const b = n.matches?.('li') ? n.closest('ul, ol') : n.closest?.(BLOCKS);
    return b && t.top.contains(b) && kindOf(b.tagName) && !b.closest('aside, pre, svg, table') ? b : null;
  }
  /** Is `b` the slide's title: its first heading, the one every list names it by. */
  const isTitle = (b, sec) => b.matches('h1, h2') && [...sec.querySelectorAll('h1, h2')].find((h) => !h.closest('aside')) === b;

  /** The menu's rows for a target: the kinds, its own ticked, a title's greyed with why; [] off a text block. */
  function rows(t, close) {
    const b = blockOf(t);
    if (!b || !em()?.available?.()) return [];
    const kinds = kindsFor(b.tagName, { isTitle: isTitle(b, t.sec) });
    const out = kinds.map((k) => ({
      label: `${k.current ? '✓ ' : ''}${k.label}`, current: k.current, disabled: !!k.disabled,
      run: k.disabled ? () => toast(k.disabled, 3200) : () => { close(); if (!k.current) turn(t, k.kind); },
    }));
    if (kinds.some((k) => k.disabled)) out.unshift({ head: 'the slide’s title stays a heading' });
    return out;
  }

  /** Make the block `t` means kind `kind`: its source read, retagged, written in one write. */
  async function turn(t, kind) {
    const b = blockOf(t);
    if (!b || t.index == null) return false;
    const path = b === t.top ? [] : pathFrom(t.top, b);
    if (!path) { toast('that block is the engine’s, not the file’s', 2600); return false; }
    const tag = b.tagName.toLowerCase();
    try {
      const res = await fetch(`${em()?.base?.() ?? ''}/deck/edit/element/source?slide=${t.slide}&index=${t.index}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || 'no source for this element');
      const at = elementAt(j.html, path, tag);
      if (!at) throw new Error(`the file has no <${tag}> where this block is: the deck has changed`);
      const out = retagBlock(at.html, kind);
      await commit.post('/deck/edit/element/content', { slide: t.slide, index: t.index, html: at.replace(out.html) }, { quiet: false });
      const said = out.build === 'one' ? ': its build is now one step, the quote arriving whole'
        : out.build === 'each' ? ': its build is now one step a point' : '';
      const label = KINDS.find(([k]) => k === kind)?.[1].toLowerCase() ?? kind;
      toast(`turned into ${label}${out.blocks > 1 ? `, ${out.blocks} blocks` : ''}${said}`, said ? 4200 : 2200);
      return true;
    } catch (e) {
      toast(`not turned: ${commit.why(e)}`, 6000);
      return false;
    }
  }

  return { rows, turn, blockOf };
}
