// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The engine wizard framework (MARKETPLACE.md ENGINES#WIZARD).
//
// Two claims carry this file. The first is that a plugin cannot paint UI into a
// deck — which is what makes "author mode only" enforceable rather than merely
// intended, so most of the schema tests are refusals. The second is that a
// credential goes exactly one place: a 0600 file under the config home, never a
// log line, never the deck, never a bundle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_TYPES, SchemaError, validateSchema, checkAnswers, secretNames,
  credentialsPath, credentialsMode, loadCredentials, saveCredentials, forgetCredentials,
  redactAnswers, configureEngine, CONFIGURED, REJECTED, UNREACHABLE,
} from '../cli/wizard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-wizard-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SCHEMA = {
  engine: 'elevenlabs',
  title: 'ElevenLabs',
  fields: [
    { name: 'apiKey', label: 'API key', type: 'secret', required: true },
    { name: 'voice', label: 'Voice', type: 'choice', options: ['Rachel', 'Adam'] },
  ],
  validate: '/validate',
};

const ANSWERS = { apiKey: 'sk-live-abcdef123456', voice: 'Rachel' };

// ── what a plugin may declare ──────────────────────────────────────────────

test('a well-formed schema is normalized, not merely accepted', () => {
  const s = validateSchema({ engine: 'piper', fields: [{ name: 'model', type: 'path' }] });
  assert.equal(s.title, 'piper', 'a missing title falls back to the engine name');
  assert.deepEqual(s.fields, [{ name: 'model', label: 'model', type: 'path', required: false }],
    'label defaults to the name and required defaults to false — the renderer never sees undefined');
});

test('a plugin cannot ask core to render markup — the whole design in one refusal', () => {
  // If a plugin could put HTML on a slide, "wizard only in author mode" would be
  // a rule the plugin's own markup had to honour. The vocabulary is closed so
  // that it is core's rule instead.
  for (const type of ['html', 'script', 'markdown', 'iframe', 'template', 'raw']) {
    assert.throws(() => validateSchema({ engine: 'x', fields: [{ name: 'f', type }] }),
      (e) => {
        assert.ok(e instanceof SchemaError);
        assert.match(e.message, /is not a field type core renders/);
        assert.match(e.message, new RegExp(FIELD_TYPES.join('|')), 'and it names what IS renderable');
        return true;
      }, type);
  }
});

test('unknown keys are refused, not ignored', () => {
  // Dropping a key silently is how a plugin ships a wizard that asks for less
  // than its author believed it did.
  assert.throws(() => validateSchema({ ...SCHEMA, render: 'custom' }), /unknown key "render"/);
  assert.throws(() => validateSchema({ engine: 'x', fields: [{ name: 'f', type: 'text', onChange: 'x' }] }),
    /unknown key "onChange"/);
});

test('a secret may not carry a default', () => {
  // Either a placeholder that will be pasted over, or a key baked into a
  // catalog. The second is bad enough to refuse the first.
  assert.throws(() => validateSchema({
    engine: 'x', fields: [{ name: 'k', type: 'secret', default: 'sk-oops' }],
  }), /a secret cannot carry a default/);
});

test('the rest of the shape rules, each with its own message', () => {
  const bad = [
    [null, /must be a JSON object/],
    [{ engine: 'has space', fields: [{ name: 'f', type: 'text' }] }, /engine must be a name/],
    [{ engine: 'x' }, /fields must be a non-empty array/],
    [{ engine: 'x', fields: [] }, /non-empty/],
    [{ engine: 'x', fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'text' }] }, /duplicate field name/],
    [{ engine: 'x', fields: [{ name: 'c', type: 'choice' }] }, /a choice field needs options/],
    [{ engine: 'x', fields: [{ name: 't', type: 'text', options: ['a'] }] }, /options only mean something for a choice/],
    [{ engine: 'x', fields: [{ name: 'f', type: 'text' }], validate: 'https://evil/validate' }, /must be a path/],
  ];
  for (const [input, re] of bad) assert.throws(() => validateSchema(input), re, JSON.stringify(input));

  // and a ceiling, because a first-run wizard asking twenty questions is a form
  assert.throws(() => validateSchema({
    engine: 'x', fields: Array.from({ length: 13 }, (_, i) => ({ name: `f${i}`, type: 'text' })),
  }), /12 is the ceiling/);
});

test('answers are checked against the schema, and every problem is reported at once', () => {
  const s = validateSchema(SCHEMA);
  assert.deepEqual(checkAnswers(s, ANSWERS), { ok: true, errors: [] });

  const r = checkAnswers(s, { voice: 'Nobody', extra: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3, 'missing required, bad choice, and unknown field — all three');
  assert.ok(r.errors.some((e) => /API key: required/.test(e)));
  assert.ok(r.errors.some((e) => /not one of Rachel, Adam/.test(e)));
  assert.ok(r.errors.some((e) => /not a field this engine asks for/.test(e)));
});

// ── where a credential goes, and where it must not ─────────────────────────

test('credentials are written 0600, and stay 0600 on rewrite', () => {
  const home = tmp();
  const file = saveCredentials('elevenlabs', ANSWERS, home);
  assert.equal(file, credentialsPath(home));
  assert.equal(credentialsMode(home), 0o600);

  // A file left world-readable by anything else must not stay that way: the
  // mode argument to writeFileSync is ignored for a path that already exists,
  // which is exactly the trap this asserts against.
  chmodSync(file, 0o644);
  saveCredentials('piper', { model: 'en_US-ryan' }, home);
  assert.equal(credentialsMode(home), 0o600, 'the write re-tightens it');
  assert.deepEqual(Object.keys(loadCredentials(home)).sort(), ['elevenlabs', 'piper'],
    'and one engine does not clobber another');
});

test('a missing credentials file is first run, not an error', () => {
  assert.deepEqual(loadCredentials(tmp()), {});
  assert.equal(credentialsMode(tmp()), null);
  assert.equal(forgetCredentials('elevenlabs', tmp()), false);
});

test('forgetting an engine leaves the others alone', () => {
  const home = tmp();
  saveCredentials('a', { k: '1' }, home);
  saveCredentials('b', { k: '2' }, home);
  assert.equal(forgetCredentials('a', home), true);
  assert.deepEqual(Object.keys(loadCredentials(home)), ['b']);
  assert.equal(forgetCredentials('a', home), false, 'and says so the second time');
});

test('redaction is one function, and it never lets a secret through', () => {
  const s = validateSchema(SCHEMA);
  assert.deepEqual(secretNames(s), new Set(['apiKey']));
  const shown = redactAnswers(s, ANSWERS);
  assert.equal(shown.voice, 'Rachel', 'ordinary config is printable — hiding it would just be unhelpful');
  assert.equal(shown.apiKey, 'set (20 chars)');
  assert.doesNotMatch(JSON.stringify(shown), /sk-live/, 'the value itself never appears');
  assert.equal(redactAnswers(s, { apiKey: '' }).apiKey, 'unset');
});

// ── install and configure: one flow, two named failures ────────────────────

const fetchSchema = async () => SCHEMA;

test('a good run stores the answers and reports them redacted', async () => {
  const home = tmp();
  const r = await configureEngine('elevenlabs', ANSWERS, {
    home, fetchSchema, validateAnswers: async () => true,
  });
  assert.equal(r.state, CONFIGURED);
  assert.equal(loadCredentials(home).elevenlabs.apiKey, ANSWERS.apiKey, 'stored verbatim…');
  assert.equal(r.stored.apiKey, 'set (20 chars)', '…and reported redacted');
});

test('unreachable and rejected are DIFFERENT answers, with different fixes', async () => {
  const home = tmp();

  const offline = await configureEngine('elevenlabs', ANSWERS, {
    home, fetchSchema: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(offline.state, UNREACHABLE);
  assert.match(offline.reason, /could not reach the marketplace/);

  const badKey = await configureEngine('elevenlabs', ANSWERS, {
    home, fetchSchema, validateAnswers: async () => false,
  });
  assert.equal(badKey.state, REJECTED);
  assert.match(badKey.reason, /did not accept those answers/);
  assert.doesNotMatch(badKey.reason, /reach|network|offline/i,
    'a wrong key must not send someone to check their network');

  const providerDown = await configureEngine('elevenlabs', ANSWERS, {
    home, fetchSchema, validateAnswers: async () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(providerDown.state, UNREACHABLE, 'and a provider we could not ask is not a provider that said no');

  assert.deepEqual(loadCredentials(home), {}, 'nothing was stored on any failing path');
});

test('a malformed schema is the plugin\'s fault, not an outage', async () => {
  const r = await configureEngine('x', {}, {
    home: tmp(), fetchSchema: async () => ({ engine: 'x', fields: [{ name: 'f', type: 'html' }] }),
  });
  assert.equal(r.state, REJECTED, 'not UNREACHABLE — waiting will not fix it');
  assert.match(r.reason, /declares a wizard core cannot render/);
});

test('answers that fail the schema never reach the provider or the disk', async () => {
  const home = tmp();
  let asked = false;
  const r = await configureEngine('elevenlabs', { voice: 'Nobody' }, {
    home, fetchSchema, validateAnswers: async () => { asked = true; return true; },
  });
  assert.equal(r.state, REJECTED);
  assert.equal(asked, false, 'no point spending a network call on answers we know are wrong');
  assert.deepEqual(loadCredentials(home), {});
});

// ── the invariants that outlive this module ────────────────────────────────

test('no credential can reach a deck: bundle never reads the credentials file', () => {
  const src = readFileSync(path.join(ROOT, 'cli/bundle.mjs'), 'utf8');
  assert.doesNotMatch(src, /credentials|loadCredentials|wizard\.mjs/,
    'a key that reached a deck would travel with it');
  const out = path.join(tmp(), 'out.html');
  execFileSync(process.execPath, [CLI, 'bundle', path.join(ROOT, 'demo/intro.html'), '-o', out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.doesNotMatch(readFileSync(out, 'utf8'), /credentials\.json|apiKey/,
    'and the bundled deck mentions neither the file nor a field name');
});

test('present registers nothing of this — a credential prompt in an emailed deck is phishing', () => {
  const src = readFileSync(path.join(ROOT, 'cli/present.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /wizard|credential/i,
    'the read-only viewer has no wizard surface at all, which is why it cannot grow one by default');
});

test('the store is the config home ENGINES decided on, beside the registry', () => {
  const home = tmp();
  assert.equal(credentialsPath(home), path.join(home, 'credentials.json'));
  saveCredentials('x', { k: '1' }, home);
  assert.ok(existsSync(path.join(home, 'credentials.json')));
  writeFileSync(path.join(home, 'marketplaces.json'), '{}');
  assert.ok(existsSync(path.join(home, 'credentials.json')), 'the two coexist — one directory, two files');
});
