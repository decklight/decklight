// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Add a marketplace…" — register a catalog without leaving the deck, write
// mode only (SPEC DESIGN_SYSTEMS, PLATFORM MARKETPLACE_REGISTRY).
//
// Three steps in one card. Type what `decklight marketplace add` takes (an
// owner/repo, a git URL, a path), then ⏎. The edit server says what that is
// about to do (the URL it would clone with your credentials, or the directory
// it would read) and the card asks for a second ⏎, as publish does, because
// a clone is network access as you. Only then does the server run the
// command. Afterwards the pickers that list marketplace units are told to ask
// again (`onAdded`), so the new catalog's design systems, themes and fonts are
// there without a reload.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop } from './overlay.js';

const KINDS = [['design-system', 'design system', 'design systems'], ['theme', 'theme', 'themes'], ['font', 'font', 'fonts']];

/** "1 design system, 2 themes" — what the pickers will now show, or ''. */
export function offeredPhrase(counts = {}) {
  return KINDS.filter(([k]) => counts[k] > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`).join(', ');
}

/**
 * `base()` is the edit server's URL, null when there is none (`''` is the
 * commonest server: same-origin). `onAdded(result)` runs after a
 * registration, with the route's answer; `then` (given to `open`) is where
 * the person came from, reopened when it is done.
 */
export function createMarketplaceAdder({ root, base, toast, onAdded = () => {}, debugLog = () => {} }) {
  let el = null, step = 'ask', spec = '', plan = null, error = null, busy = false, then = null;
  const card = () => el?.querySelector('.narr-card');

  function render() {
    const c = card();
    if (!c) return;
    let html = '<div class="narr-head">add a marketplace</div>';
    if (step === 'ask') {
      html += `<input class="narr-input mk-spec" type="text" placeholder="owner/repo, a git URL, or a path" aria-label="Marketplace source" spellcheck="false" autocomplete="off" value="${escapeHtml(spec)}">`;
      if (error) html += `<div class="rec-line rec-warn mk-error">${escapeHtml(error)}</div>`;
      html += '<div class="rec-hint">the forms decklight marketplace add takes · ⏎ next · Esc closes</div>';
    } else if (step === 'confirm') {
      html += `<div class="rec-line mk-does">${escapeHtml(plan.does[0].toUpperCase() + plan.does.slice(1))}</div>`;
      if (plan.registered) html += `<div class="rec-line">already registered as ${escapeHtml(plan.registered)} — this refreshes it</div>`;
      html += `<div class="rec-hint">⏎ ${plan.url ? 'clone it' : 'register it'} · Esc back</div>`;
    } else {
      html += `<div class="rec-line">${plan?.url ? `cloning ${escapeHtml(plan.url)}…` : 'registering…'}</div>`;
    }
    c.innerHTML = html;
    const input = c.querySelector('.mk-spec');
    if (input) {
      input.addEventListener('input', () => { spec = input.value; });
      input.addEventListener('keydown', (e) => {
        // the field holds the keyboard: nothing typed here reaches the deck
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); ask(); } else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    }
  }

  async function post(body) {
    const r = await fetch(`${base()}/deck/edit/marketplace/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error ?? `the edit server answered ${r.status}`);
    return j;
  }

  /** The first ⏎: what would this do? Nothing is fetched to answer it. */
  async function ask() {
    if (busy) return;
    if (!spec.trim()) { error = 'which marketplace? — owner/repo, a git URL, or a path'; return render(); }
    busy = true;
    try {
      plan = (await post({ spec })).plan;
      error = null;
      step = 'confirm';
    } catch (e) {
      error = String(e.message ?? e);
    } finally { busy = false; }
    render();
  }

  /** The second ⏎: run `decklight marketplace add`. */
  async function confirm() {
    if (busy) return;
    busy = true;
    step = 'working';
    render();
    try {
      const j = await post({ spec: plan.spec, confirm: true });
      debugLog('marketplace', `${j.refreshed ? 'refreshed' : 'registered'} ${j.name} from ${j.spec}`);
      const offers = offeredPhrase(j.counts);
      toast(`${j.refreshed ? 'refreshed' : 'registered'} ${j.name ?? j.spec}${offers ? ` — ${offers}` : ' — it offers no design system, theme or font'}`, 6000);
      const back = then;
      close();
      onAdded(j);
      back?.();
    } catch (e) {
      // said in the card, where it can be read whole, and the source kept to fix
      error = String(e.message ?? e);
      step = 'ask';
      render();
    } finally { busy = false; }
  }

  function open({ then: back = null } = {}) {
    if (el) return;
    if (base() === null) { toast('marketplaces are added in write mode — or decklight marketplace add <owner/repo>', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-marketplace-add';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Add a marketplace"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    step = 'ask'; spec = ''; plan = null; error = null; then = back;
    render();
  }

  function close() {
    el?.remove();
    el = null;
    then = null;
  }

  function keydown(e) {
    if (step === 'working') return true;   // the clone finishes, or fails, either way
    if (e.key === 'Escape') {
      if (step === 'confirm') { step = 'ask'; render(); } else close();
      return true;
    }
    if (e.key === 'Enter') { if (step === 'confirm') confirm(); else ask(); return true; }
    return true;   // the card holds the keyboard while it is open
  }

  return { open, close, keydown, isOpen: () => !!el };
}
