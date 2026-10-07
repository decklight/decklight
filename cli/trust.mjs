// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Trust (SPEC PRESENTING): a deck that runs code of its own asks, once, whether
// its source is trusted. The answer is remembered against the BYTES of that
// code — every unaccounted script block and every executable attribute the
// ingredients label names, in file order — so a deck whose script changed
// asks again, and a deck whose author added nothing executable never asks.
// Nothing here decides anything: the label finds, the person answers, this
// remembers.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configHome } from './marketplace.mjs';

/** The bytes the question is about, hashed: the label's findings, in file order. */
export function scriptHash(html, report) {
  const found = [...report.unaccounted, ...report.handlers].sort((a, b) => a.start - b.start);
  const h = createHash('sha256');
  for (const f of found) h.update(html.slice(f.start, f.end)).update('\n\0\n');
  return h.digest('hex');
}

export const trustFile = (home = configHome()) => join(home, 'trust.json');

function readStore(home) {
  try { return JSON.parse(readFileSync(trustFile(home), 'utf8')); } catch { return {}; }
}

/** Was this deck's script, as it is now, trusted before? */
export function isTrusted(deckPath, hash, home = configHome()) {
  return readStore(home)[deckPath] === hash;
}

/** Remember the answer, against these bytes. A later change to the script asks again. */
export function remember(deckPath, hash, home = configHome()) {
  const store = readStore(home);
  store[deckPath] = hash;
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(trustFile(home), JSON.stringify(store, null, 2) + '\n');
}

/** Take the answer back. */
export function forget(deckPath, home = configHome()) {
  const store = readStore(home);
  if (!(deckPath in store)) return false;
  delete store[deckPath];
  writeFileSync(trustFile(home), JSON.stringify(store, null, 2) + '\n');
  return true;
}

const USAGE = `usage: decklight trust list
       decklight trust forget <deck.html>
  the decks whose script you said you trust (SPEC PRESENTING): a yes to the
  question \`decklight <deck>\` asks when a deck runs code of its own, kept
  against the bytes of that code in ${trustFile()}.
  list      every deck remembered, with the hash of the script it was said about
  forget D  ask again next time D is opened`;

export async function trustMain(argv = []) {
  const [verb, deck] = argv.filter((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h') || !verb) { console.log(USAGE); return 0; }
  if (verb === 'list') {
    const store = readStore(configHome());
    const keys = Object.keys(store);
    if (!keys.length) { console.log('no deck is trusted yet — decklight <deck> asks when one runs code of its own'); return 0; }
    for (const k of keys) console.log(`${k}  ${store[k].slice(0, 12)}`);
    return 0;
  }
  if (verb === 'forget') {
    if (!deck) { console.error('decklight trust forget: which deck?'); return 1; }
    const { resolve } = await import('node:path');
    const { realpathSync } = await import('node:fs');
    let key = resolve(deck);
    try { key = realpathSync(key); } catch { /* a deck that is gone is still forgettable by its path */ }
    if (forget(key)) { console.log(`forgot ${key} — the next open asks again`); return 0; }
    console.log(`${key} was not trusted`);
    return 0;
  }
  console.error(`decklight trust: unknown verb "${verb}"\n${USAGE}`);
  return 1;
}
