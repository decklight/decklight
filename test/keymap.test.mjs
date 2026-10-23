// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The keys, the palette and the help table have to agree.
//
// They are three hand-maintained lists of the same facts, in one file, and they
// drift the way three hand-maintained lists always do. When the narration keys
// were rationalised, an inventory of the three found: `⇧R` bound but missing
// from the help; `⇧V`'s help row still calling it "record offline narration"
// while the palette had renamed the pair; `/` listed TWICE with different
// descriptions; `PageUp`/`PageDown` bound and unlisted; and "Submit review…"
// advertising `S` when bare `S` opens the speaker view.
//
// None of that is catchable by a test that runs the deck — every one of those
// is still a working deck, just one that lies about itself. So this reads the
// three lists out of the source and asserts they say the same thing. It is a
// lint, and it is deliberately strict about the shape of the source it parses:
// a rewrite that defeats the regexes fails loudly here rather than silently
// checking nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '../src/core/engine.js'), 'utf8');

/** The `case 'x': case 'X':` labels of the deck's own key switch. */
function boundKeys() {
  // Anchored on `onKey` FIRST. There are several `switch (e.key)` blocks in this
  // file — the overview overlay has one — and taking the first match found that
  // one instead: nine keys where the deck has thirty. The count assertion below
  // is what turned a silently-wrong lint into a failing one.
  const at = SRC.indexOf('function onKey(');
  assert.ok(at > 0, 'could not find onKey — has the key handler been renamed?');
  const from = SRC.indexOf('switch (e.key) {', at);
  assert.ok(from > at, 'onKey no longer switches on e.key');
  const body = SRC.slice(from, SRC.indexOf('\n    }', from));
  const keys = new Set();
  for (const m of body.matchAll(/case '([^']+)':/g)) keys.add(m[1]);
  assert.ok(keys.size > 20, `only ${keys.size} keys parsed — the regex has stopped matching`);
  return keys;
}

/** Every `{ label, hint }` the command palette offers. */
function paletteRows() {
  const from = SRC.indexOf('function paletteCommands(');
  assert.ok(from > 0, 'could not find paletteCommands');
  const body = SRC.slice(from, SRC.indexOf('\n  }', from));
  const rows = [];
  for (const m of body.matchAll(/\{\s*label:\s*(`[^`]*`|'[^']*')([^}]*?)\}/gs)) {
    // a hint may be a literal or a platform chord added to one ('K · ' + COMMIT_CHORD)
    const hint = /hint:\s*('([^']*)'|[A-Z_]+)/.exec(m[2]);
    const run = /run:\s*(?:\(\)\s*=>\s*)?([\w.?]+(?:\([^()]*\))?)/.exec(m[2]);
    rows.push({ label: m[1].slice(1, -1), hint: hint ? hint[2] ?? hint[1] : null, run: run ? run[1] : null });
  }
  assert.ok(rows.length > 20, `only ${rows.length} palette rows parsed`);
  return rows;
}

/** Every `<tr><td>KEY</td><td>what it does</td></tr>` in the ? overlay. */
function helpRows() {
  const rows = [];
  for (const m of SRC.matchAll(/<tr><td>([^<]+)<\/td><td>([^<]*)<\/td><\/tr>/g)) {
    rows.push({ key: m[1].trim(), what: m[2].trim() });
  }
  assert.ok(rows.length > 20, `only ${rows.length} help rows parsed`);
  return rows;
}

// A help row may name several keys at once ("→ / PageDown", "L / ⇧L", ", / .").
const namesIn = (cell) => cell.split('/').map((s) => s.trim()).filter(Boolean);

test('the help table lists each key once', () => {
  // `/` was listed twice, with two different descriptions — the kind of thing
  // nobody notices because both rows are individually correct.
  const seen = new Map();
  for (const { key } of helpRows()) {
    for (const name of namesIn(key)) seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const twice = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(twice, [], `these keys appear more than once in the help: ${twice.join(', ')}`);
});

test('every letter key the deck answers is in the help', () => {
  // Letters only: the switch also carries Escape, Backspace, Enter and the
  // punctuation cycles, which the help covers in prose or deliberately omits.
  const help = new Set();
  for (const { key } of helpRows()) for (const n of namesIn(key)) help.add(n.toUpperCase());
  const missing = [...boundKeys()]
    .filter((k) => /^[a-z]$/.test(k))
    .map((k) => k.toUpperCase())
    .filter((k) => !help.has(k));
  assert.deepEqual(missing, [],
    `bound but undocumented — the ⇧R case exactly: ${missing.join(', ')}`);
});

test('the help never names a key nothing answers', () => {
  // The other direction: `N` and `⇧V` stayed in the help after the narration
  // keys moved, which is worse than an omission — it is an instruction that
  // does nothing.
  const bound = boundKeys();
  const stale = [];
  for (const { key } of helpRows()) {
    for (const n of namesIn(key)) {
      const bare = n.replace(/^⇧/, '');
      if (!/^[A-Za-z]$/.test(bare)) continue;          // only letters are checkable this way
      if (!bound.has(bare.toLowerCase()) && !bound.has(bare.toUpperCase())) stale.push(n);
    }
  }
  assert.deepEqual(stale, [], `the help promises keys nothing handles: ${stale.join(', ')}`);
});

test('every palette hint names a key that exists', () => {
  // "Submit review…" advertised `S`, but bare S opens the speaker view — the row
  // is reachable only from the palette itself. A hint that lies is worse than
  // no hint, because it teaches a keystroke that does something else.
  const bound = boundKeys();
  const wrong = [];
  for (const { label, hint } of paletteRows()) {
    if (!hint) continue;
    // 'K · ⌘K', ', · .': every key a hint names is checked
    for (const name of hint.split('·').map((s) => s.trim())) {
      const bare = name.replace(/^[⇧⌃⌘]+/, '');
      if (!/^[A-Za-z]$/.test(bare)) continue;          // ⎵, ⏎, Home, `, [ · ] …
      if (!bound.has(bare.toLowerCase()) && !bound.has(bare.toUpperCase())) {
        wrong.push(`${label} → ${hint}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `palette hints naming unbound keys: ${wrong.join(' · ')}`);
});

test('the narration keys are the ones the rationalisation settled on', () => {
  // The specific shape this change chose, pinned so a later edit has to mean it:
  // ⎵ is the verb, V is the panel, and N / ⇧V / ⇧R are free.
  const bound = boundKeys();
  assert.ok(bound.has(' '), 'space is no longer a case in the key switch');
  assert.ok(bound.has('v') && bound.has('V'), 'V is not bound');
  assert.ok(!bound.has('n') && !bound.has('N'), 'N is bound again — it was freed');
  assert.match(SRC, /case ' ':[\s\S]{0,600}voiceInPlay/,
    'space no longer asks whether the VOICE IS IN PLAY before taking the key — '
    + 'the wider "deck has a voice" test let it start narration over a presenter');
  // …and the help says so
  const help = helpRows();
  assert.ok(help.some((r) => r.key === '⎵' && /voice|narration/i.test(r.what)),
    'the help does not explain what space does');
  assert.ok(help.some((r) => r.key === 'V' && /narration/i.test(r.what)),
    'the help does not explain what V opens');
});

test('no bare letter in the deck\'s key switch writes the file', () => {
  // L cycled the layout and Z / ⇧Z undid and redid, all on a bare press, so a
  // stray key while presenting in write mode changed the file. The undo chord
  // (⌘Z / Ctrl+Z, handled above the switch) and the bar's buttons do it now.
  const at = SRC.indexOf('function onKey(');
  const from = SRC.indexOf('switch (e.key) {', at);
  const body = SRC.slice(from, SRC.indexOf('\n    }', from));
  const writers = [];
  for (const m of body.matchAll(/case '([a-zA-Z])':[^\n]*/g)) {
    if (/deckHistory|cycleLayout|slideOp|setHidden/.test(m[0])) writers.push(m[1]);
  }
  assert.deepEqual(writers, [], `bare letters that write the file: ${writers.join(', ')}`);
});

test('one key per action: the aliases and the palette-only toggles stay unbound', () => {
  // R was history's second key, P was ⎵'s, J toggled the progress bar and D
  // the debug log. Each is a palette row now; a letter that comes back has to
  // mean it, and has to come off this list.
  const bound = boundKeys();
  for (const k of ['r', 'p', 'j', 'd', 'l', 'z']) {
    assert.ok(!bound.has(k) && !bound.has(k.toUpperCase()), `${k.toUpperCase()} is bound again`);
  }
});

test('the help says which keys answer only in a context', () => {
  // ⏎ and ⌫ on a selection, the formatting chords while typing, the
  // overview's N · D · ⌫ and the inspector's E were bound and listed nowhere.
  const ctx = [...SRC.matchAll(/<tr class="help-ctx"><td>([^<]+)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m[2]);
  for (const want of [/selected element/, /while editing text: bold/, /in the overview/, /in the inspector/]) {
    assert.ok(ctx.some((t) => want.test(t)), `no context row matching ${want}`);
  }
});

test('⇧F shows and hides the arrows and the slide number in fullscreen, and the help says so', () => {
  assert.match(SRC, /case 'f': case 'F': if \(e\.shiftKey\) setFsChrome\(/, '⇧F is not the fullscreen-chrome toggle');
  assert.ok(helpRows().some((r) => r.key === '⇧F' && /arrows and the slide number in fullscreen/.test(r.what)), 'no ⇧F row in the help');
});

test('a palette row whose command has a key shows the key', () => {
  // The palette is where a key is learned: a row that does what O does and
  // does not say O teaches nothing. Each bare key in onKey that makes one
  // call is matched to the rows that make the same call.
  const at = SRC.indexOf('function onKey(');
  const from = SRC.indexOf('switch (e.key) {', at);
  const body = SRC.slice(from, SRC.indexOf('\n    }', from));
  const keyed = new Map();
  for (const m of body.matchAll(/((?:case '[^']+':\s*)+)([\w.?]+\([^()]*\));\s*break;/g)) {
    keyed.set(m[2].replace(/\(\)$/, ''), [...m[1].matchAll(/case '([^']+)'/g)].map((c) => c[1]));
  }
  assert.ok(keyed.size > 15, `only ${keyed.size} keyed calls parsed`);
  const bare = [];
  for (const { label, hint, run } of paletteRows()) {
    if (!run || hint) continue;
    const keys = keyed.get(run.replace(/\(\)$/, ''));
    if (keys) bare.push(`${label} (${keys.join(' ')})`);
  }
  assert.deepEqual(bare, [], `palette rows with a key and no hint: ${bare.join(' · ')}`);
});
