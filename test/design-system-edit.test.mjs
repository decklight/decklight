// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Editing a design-system slide in the FILE (SPEC DESIGN_SYSTEMS, #624): the
// guard that keeps an element in its slot, and the layout picker's writes —
// convert, switch, remove, insert — as pure transforms, then through the
// edit server with its one undo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, stop } from './helpers.mjs';
import {
  slotWriteProblem, applySystemLayout, insertSystemLayoutSlide, describeLayoutChange, slideLayoutOf,
} from '../cli/design-system-edit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const DIVIDER = { ref: 'acme/section-divider', id: 'section-divider', slots: [
  { name: 'kicker', hint: 'p' }, { name: 'title', hint: 'h1,h2', required: true }, { name: 'subtitle', hint: 'p' }, { name: 'body', hint: '', default: true },
] };
const STATEMENT = { ref: 'acme/statement', id: 'statement', slots: [{ name: 'title', hint: 'h2', required: true }, { name: 'body', hint: '', default: true }] };

const deck = (...sections) => `<!doctype html><html><head><title>T</title>
<script type="application/json" data-decklight-config>{"decklight":"0.9.0","theme":"aurora","designSystems":["acme@acme-mkt"]}</script>
</head><body><div class="decklight">
${sections.join('\n')}
</div></body></html>
`;
const PLAIN = `  <section class="plain">
    <h2>A title</h2>
    <p>A kicker-ish line</p>
    <ul><li>one</li></ul>
    <aside class="notes">say it</aside>
  </section>`;

test('convert: hints assign slots in the layout\'s order, an existing data-slot is kept, leftovers go to the default', () => {
  const r = applySystemLayout(deck(PLAIN), 1, DIVIDER);
  assert.equal(r.mode, 'convert');
  assert.equal(slideLayoutOf(r.html, 1), 'acme/section-divider');
  assert.match(r.html, /<h2 data-slot="title">A title<\/h2>/);
  assert.match(r.html, /<p data-slot="kicker">A kicker-ish line<\/p>/);
  assert.match(r.html, /<ul><li>one<\/li><\/ul>/, 'a leftover carries no slot — the engine lands it in the default slot');
  assert.match(r.html, /<aside class="notes">say it<\/aside>/, 'notes are never assigned');
  assert.deepEqual(r.moved.map((m) => [m.tag, m.slot]), [['p', 'kicker'], ['h2', 'title'], ['ul', 'body']]);
  assert.equal(describeLayoutChange(r, DIVIDER.ref), 'now acme/section-divider · p → kicker (hint p) · h2 → title (hint h1,h2) · ul → body (the default slot)');
  const kept = applySystemLayout(deck(PLAIN.replace('<p>A kicker', '<p data-slot="subtitle">A kicker')), 1, DIVIDER);
  assert.match(kept.html, /<p data-slot="subtitle">A kicker-ish line<\/p>/, 'what the author already slotted stays put');
});

test('switch: only the attribute moves, content stays by slot name, and slots the new layout lacks are said', () => {
  const converted = applySystemLayout(deck(PLAIN), 1, DIVIDER).html;
  const r = applySystemLayout(converted, 1, STATEMENT);
  assert.equal(r.mode, 'switch');
  assert.equal(slideLayoutOf(r.html, 1), 'acme/statement');
  assert.match(r.html, /<p data-slot="kicker">A kicker-ish line<\/p>/, 'content is never rewritten on a switch');
  assert.deepEqual(r.lacking, ['kicker']);
  assert.match(describeLayoutChange(r, STATEMENT.ref), /acme\/statement has no "kicker" slot — that content shows in the unslotted box/);
});

test('remove: back to a plain slide, data-slot attributes left (harmless, and what a later convert reads)', () => {
  const converted = applySystemLayout(deck(PLAIN), 1, DIVIDER).html;
  const r = applySystemLayout(converted, 1, null);
  assert.equal(r.mode, 'remove');
  assert.equal(slideLayoutOf(r.html, 1), '');
  assert.match(r.html, /<section class="plain">/);
  assert.match(r.html, /<h2 data-slot="title">A title<\/h2>/);
});

test('insert: a new slide after slide N, its required slots by their hints, the rest left to the layout\'s defaults', () => {
  const out = insertSystemLayoutSlide(deck(PLAIN), 1, DIVIDER);
  assert.match(out, /<section data-layout="acme\/section-divider">\n\s*<h1 data-slot="title">Title<\/h1>\n\s*<aside class="notes"><\/aside>\n\s*<\/section>/);
  assert.equal(slideLayoutOf(out, 2), 'acme/section-divider');
});

test('the guard: an edit on a design-system slide keeps the element\'s slot — or is refused', () => {
  const converted = applySystemLayout(deck(PLAIN), 1, DIVIDER).html;
  assert.match(slotWriteProblem(converted, 1, 0, '<h2>New title</h2>'), /fills the "title" slot .* keep data-slot="title"/);
  assert.equal(slotWriteProblem(converted, 1, 0, '<h2 data-slot="title">New title</h2>'), null);
  assert.equal(slotWriteProblem(converted, 1, 0, '<h2 data-slot="subtitle">Moved</h2>'), null, 'moving to another slot is a choice, not a loss');
  assert.equal(slotWriteProblem(converted, 1, 2, '<ul><li>x</li></ul>'), null, 'an unslotted element has no slot to lose');
  assert.equal(slotWriteProblem(deck(PLAIN), 1, 0, '<h2>x</h2>'), null, 'a plain slide is not guarded');
});

// ── through the edit server ─────────────────────────────────────────────

function home(t) {
  const dir = scratch('ds-edit', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(path.join(here, 'fixtures', 'design-systems', 'ok'), path.join(repo, 'systems', 'acme'), { recursive: true });
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name: 'acme-mkt', entries: [
    { name: 'acme', type: 'design-system', source: 'systems/acme', version: '1.2.0', apiVersion: 1 },
  ] }));
  execFileSync(process.execPath, [path.join(ROOT, 'cli/decklight.mjs'), 'marketplace', 'add', repo], { env: { ...process.env, DECKLIGHT_HOME: h }, stdio: 'ignore' });
  return h;
}

async function startEditingTour(t, h, body) {
  const dir = scratch('ds-edit-author', t);
  writeFileSync(path.join(dir, 'deck.html'), body);
  const proc = spawn(process.execPath, [path.join(ROOT, 'cli/edit.mjs'), 'deck.html', '--port', '0', '--no-git'], {
    cwd: dir, env: { ...process.env, DECKLIGHT_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(proc));
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    proc.on('exit', () => { clearInterval(scan); reject(new Error(`open exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`timeout:\n${out}`)); }, 10000);
  });
  return { base, deck: path.join(dir, 'deck.html') };
}
const post = async (base, route, body) => { const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };

test('POST /deck/edit/slide/system-layout: convert, switch, insert and remove — each one undo, the layout read from the package', async (t) => {
  const h = home(t);
  const { base, deck: deckPath } = await startEditingTour(t, h, deck(PLAIN));
  const original = readFileSync(deckPath, 'utf8');
  const convert = await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: 'acme/section-divider' });
  assert.equal(convert.status, 200, JSON.stringify(convert));
  assert.equal(convert.mode, 'convert');
  assert.match(convert.said, /h2 → title \(hint h1,h2\)/);
  assert.match(readFileSync(deckPath, 'utf8'), /<h2 data-slot="title">A title<\/h2>/);
  const sw = await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: 'acme/statement' });
  assert.deepEqual(sw.lacking, ['kicker']);
  const ins = await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: 'acme/statement', insert: true });
  assert.equal(ins.inserted, 2);
  assert.equal(slideLayoutOf(readFileSync(deckPath, 'utf8'), 2), 'acme/statement');
  const rm = await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: null });
  assert.equal(rm.mode, 'remove');
  for (let i = 0; i < 4; i++) await post(base, '/deck/edit/undo', {});
  assert.equal(readFileSync(deckPath, 'utf8'), original, 'four actions, four undos, back to the start');
  // what the server will not do, said
  assert.match((await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: 'acme/nope' })).error, /acme@acme-mkt has no layout "nope" — it has section-divider, statement/);
  assert.match((await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: 'other/x' })).error, /does not use a design system called "other"/);
  assert.equal((await post(base, '/deck/edit/slide/system-layout', { slide: 1, layout: null, insert: true })).status, 400);
  assert.equal(readFileSync(deckPath, 'utf8'), original);
});

test('POST /deck/edit/element/content refuses a write that drops data-slot on a design-system slide', async (t) => {
  const h = home(t);
  const converted = applySystemLayout(deck(PLAIN), 1, DIVIDER).html;
  const { base, deck: deckPath } = await startEditingTour(t, h, converted);
  const refused = await post(base, '/deck/edit/element/content', { slide: 1, index: 0, html: '<h2>Lost its slot</h2>' });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /keep data-slot="title"/);
  assert.equal(readFileSync(deckPath, 'utf8'), converted);
  const ok = await post(base, '/deck/edit/element/content', { slide: 1, index: 0, html: '<h2 data-slot="title">A better title</h2>' });
  assert.equal(ok.status, 200);
  assert.match(readFileSync(deckPath, 'utf8'), /<h2 data-slot="title">A better title<\/h2>/, 'only the slot\'s element changed');
});
