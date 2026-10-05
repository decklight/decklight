// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A bare `decklight`, on a terminal.
 *
 * It used to print forty commands. The person who types nothing but the
 * program's name is asking "what now?", and the answer depends on where they
 * are standing: a directory with no deck wants one started, a directory with
 * one deck wants it opened, a directory with several wants a choice. Each is
 * a question with a default, and every answer lands in a command that already
 * exists — this file starts nothing of its own.
 *
 * Off a terminal there is nobody to ask, and the dispatcher prints the short
 * help instead of ever reaching this.
 */

import { createInterface } from 'node:readline/promises';
import { findDeck } from './history.mjs';
import { shortHelp } from './commands.mjs';

/** What a bare `decklight` should do here — pure over what the directory holds. */
export function planStart({ decks = [], tty = false } = {}) {
  if (!tty) return { action: 'help' };
  if (!decks.length) return { action: 'offer-init' };
  if (decks.length === 1) return { action: 'offer-open', deck: decks[0] };
  return { action: 'choose', decks };
}

/**
 * Which way in an `[Enter/r/q]` answer picks. Enter is write mode — the deck
 * in front of you is far more often one you are working on than one you were
 * sent; `r` (or `p`, for the fingers that remember "present") is read-only.
 */
export function pickVerb(answer) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (!a || a.startsWith('a') || a.startsWith('e') || a.startsWith('w') || a.startsWith('o')) return 'write';
  if (a.startsWith('p') || a.startsWith('r')) return 'read-only';
  return null;
}

/** Which of `decks` a numbered answer names; Enter is the first, nonsense is null. */
export function pickDeck(answer, decks) {
  const a = String(answer ?? '').trim();
  if (!a) return decks[0] ?? null;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= decks.length) return decks[n - 1];
  return decks.find((d) => d === a || d.toLowerCase() === a.toLowerCase()) ?? null;
}

export async function startMain(argv = [], {
  cwd = process.cwd(),
  tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out = process.stdout,
  ask = null,
  run = {},
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(shortHelp());
    return 0;
  }
  const plan = planStart({ decks: findDeck(cwd).decks, tty });
  if (plan.action === 'help') { out.write(shortHelp()); return 0; }

  // one readline for every question; EOF anywhere is "no", never a hang
  const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  let gone = false;
  rl?.once('close', () => { gone = true; });
  const question = async (q) => {
    if (ask) return String(await ask(q) ?? '');
    if (gone) return null;
    return new Promise((res) => {
      rl.once('close', () => res(null));
      rl.question(q).then(res, () => res(null));
    });
  };
  const yes = (a, dflt = true) => (a === null ? false : !a.trim() ? dflt : /^y/i.test(a.trim()));
  const launch = {
    init: run.init ?? (async (args) => (await import('./init.mjs')).initMain(args)),
    write: run.write ?? (async (args) => (await import('./open.mjs')).openMain(args)),
    'read-only': run['read-only'] ?? (async (args) => (await import('./open.mjs')).openMain(args)),
  };

  try {
    if (plan.action === 'offer-init') {
      const a = await question('no decklight deck in this directory — start one here? [Y/n] ');
      if (!yes(a)) { out.write(`\n${shortHelp()}`); return 0; }
      rl?.close();
      return (await launch.init([])) ?? 0;
    }

    let deck = plan.deck;
    if (plan.action === 'choose') {
      out.write(`${plan.decks.length} decks here:\n`);
      plan.decks.forEach((d, i) => out.write(`  ${i + 1}) ${d}\n`));
      const a = await question(`which one? [1] `);
      deck = a === null ? null : pickDeck(a, plan.decks);
      if (!deck) { out.write('nothing opened\n'); return 0; }
    } else {
      out.write(`found ${deck}\n`);
    }
    const a = await question('  open it — live reload, edits from the browser, an AI agent on A      r) read-only — no way to change it\n  [Enter/r/q] ');
    const verb = a === null ? null : pickVerb(a);
    if (!verb) { out.write('nothing opened\n'); return 0; }
    rl?.close();
    return (await launch[verb](verb === 'write' ? [deck, '--open'] : [deck, '--read-only'])) ?? 0;
  } finally {
    rl?.close();
  }
}
