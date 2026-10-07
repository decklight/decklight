// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Trust (SPEC PRESENTING): the answer to "do you trust where this deck came
// from?" is remembered against the bytes of the script it was about, so an
// unchanged script never asks again and a changed one always does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditDeck } from '../cli/audit.mjs';
import { scriptHash, isTrusted, remember, forget, trustFile } from '../cli/trust.mjs';

const deck = (script, attr = '') => `<!doctype html><html><body><div class="decklight"><section${attr}><h2>One</h2></section></div>`
  + `<script>Decklight.init()</script>${script}</body></html>`;

test('the hash is the findings, in file order, and nothing else', () => {
  const a = deck('<script>console.log(1)</script>');
  const b = deck('<script>console.log(1)</script>').replace('<h2>One</h2>', '<h2>Two</h2>');
  const c = deck('<script>console.log(2)</script>');
  const h = (html) => scriptHash(html, auditDeck(html));
  assert.equal(h(a), h(b), 'a slide edit leaves the hash alone — the question was about the script');
  assert.notEqual(h(a), h(c), 'a changed script is a new question');
  assert.notEqual(h(a), h(deck('<script>console.log(1)</script>', ' onclick="x()"')), 'an executable attribute counts');
  assert.equal(h(deck('')), h(deck('').replace('One', 'Three')), 'a deck with nothing to account for hashes the same empty finding set');
});

test('remember, ask, forget — in the config home, as one file', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-trust-'));
  const html = deck('<script>window.x = 1</script>');
  const hash = scriptHash(html, auditDeck(html));
  assert.equal(isTrusted('/a/talk.html', hash, home), false, 'nothing is trusted to begin with');
  remember('/a/talk.html', hash, home);
  assert.ok(existsSync(trustFile(home)));
  assert.equal(isTrusted('/a/talk.html', hash, home), true);
  assert.equal(isTrusted('/a/talk.html', 'other', home), false, 'a different script is not covered by the old yes');
  assert.equal(isTrusted('/b/talk.html', hash, home), false, 'nor is the same script at another path');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(trustFile(home), 'utf8'))), ['/a/talk.html']);
  assert.equal(forget('/a/talk.html', home), true);
  assert.equal(isTrusted('/a/talk.html', hash, home), false);
  assert.equal(forget('/a/talk.html', home), false, 'forgetting twice says there was nothing');
});
