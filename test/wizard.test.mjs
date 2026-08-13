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
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_TYPES, SchemaError, validateSchema, checkAnswers, secretNames,
  credentialsPath, credentialsMode, loadCredentials, saveCredentials, forgetCredentials,
  redactAnswers, configureEngine, provenance, BRIDGE_ADDR, CONFIGURED, REJECTED, UNREACHABLE,
  PREREQUISITE, REQUIRE_KINDS, unmetRequirements, requirementLine,
  restrictFile, protectionOf, aclGrantees, STORAGE_NOTE, qualifiedUser,
} from '../cli/wizard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-wizard-'));
  process.on('exit', () => rmTemp(dir));
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

/** This machine, for the assertions that differ by platform rather than skip. */
const WINDOWS = process.platform === 'win32';

/** What icacls actually says about `file` — evidence for a failing assertion. */
const acl = (file) => {
  try { return execFileSync('icacls', [file], { encoding: 'utf8' }).trim(); }
  catch (e) { return `icacls failed: ${e.message}`; }
};

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

// ── provenance: the one line the plugin cannot write (#232) ────────────────

test('provenance names the asker and the destination in words the schema did not choose', () => {
  // A field labelled "OpenAI API key" plus a validate endpoint is a phishing
  // form when the label is the only thing on screen — the same untrusted party
  // wrote the question and receives the answer. The provenance pair is what
  // the card shows against that, so it must carry the registry's name for the
  // entry and the real destination, and no free plugin text at all.
  const p = provenance(validateSchema(SCHEMA), 'elevenlabs@voices');
  assert.equal(p.askedBy, 'asked by elevenlabs@voices');
  assert.match(p.sentTo, new RegExp(`${BRIDGE_ADDR.replaceAll('.', '\\.')}/validate`),
    'the declared endpoint is shown as the address answers actually go to');
  assert.match(p.sentTo, new RegExp(`credentials\\.json \\(${STORAGE_NOTE[WINDOWS ? 'win32' : 'posix']}\\)`),
    'and where they land afterwards, named with the protection THIS platform has');
  assert.doesNotMatch(p.askedBy + p.sentTo, /ElevenLabs|API key/,
    'the plugin\'s own title and labels never leak into the trusted line');
});

test('provenance without an endpoint says the answers stay on this machine', () => {
  const p = provenance(validateSchema({ engine: 'piper', fields: [{ name: 'model', type: 'path' }] }), 'piper@voices');
  assert.match(p.sentTo, /stay on this machine/);
  assert.doesNotMatch(p.sentTo, /bridge|8787/, 'no endpoint, no bridge to mention');
});

test('provenance names every declared endpoint — install as well as validate', () => {
  const p = provenance(validateSchema({
    engine: 'x', fields: [{ name: 'k', type: 'secret' }], validate: '/v', install: '/i',
  }), 'x@m');
  assert.match(p.sentTo, new RegExp(`${BRIDGE_ADDR.replaceAll('.', '\\.')}/v and ${BRIDGE_ADDR.replaceAll('.', '\\.')}/i`));
});

test('provenance refuses a bare name — an unqualified asker is not an identity', () => {
  // Two marketplaces can both carry an "elevenlabs"; only name@marketplace
  // says which one is asking, so a caller that lost the qualification is a bug.
  assert.throws(() => provenance(validateSchema(SCHEMA), 'elevenlabs'), SchemaError);
  assert.throws(() => provenance(validateSchema(SCHEMA), ''), SchemaError);
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

/**
 * The credential file is restricted TO THIS ACCOUNT on whatever machine runs
 * this, and the assertion is per-platform rather than skipped (#308).
 *
 * `0600` was decklight's whole answer to "who else can read your ElevenLabs
 * key", and on Windows it is a number with no meaning — the file used to carry
 * whatever ACL the profile handed it, which is usually adequate and was not
 * something decklight did, while the CLI printed `(0600)` anyway. Now an
 * explicit ACL is set there, so both platforms have an answer and both can be
 * asserted. What cannot be asserted is that a machine HAS ACLs — a FAT volume
 * or a stripped image has none — so the Windows branch accepts `inherited` as
 * an outcome and insists only that decklight then SAYS so.
 */
test('credentials are restricted to this account, and re-restricted on rewrite', () => {
  const home = tmp();
  const { file, protection } = saveCredentials('elevenlabs', ANSWERS, home);
  assert.equal(file, credentialsPath(home));

  if (WINDOWS) {
    assert.match(protection.label, /Windows ACL|icacls/, 'never a POSIX mode on Windows');
    assert.doesNotMatch(protection.label, /0600/);
    // The point of the restriction, and the assertion that could only ever run
    // here. It carries the ACL itself, because a bare "expected private, got
    // open" from a machine nobody can attach to is not a fixable failure.
    assert.equal(protection.state, 'private',
      `only this account may read a pasted key — ${protection.label}`
      + `${protection.why ? `\nicacls said: ${protection.why}` : ''}`
      + `\nrunning as ${process.env.USERDOMAIN}\\${process.env.USERNAME}\n${acl(file)}`);
  } else {
    assert.deepEqual(protection, { state: 'private', label: '0600', why: null });
    assert.equal(credentialsMode(home), 0o600);
    // A file left world-readable by anything else must not stay that way: the
    // mode argument to writeFileSync is ignored for a path that already exists,
    // which is exactly the trap this asserts against.
    chmodSync(file, 0o644);
  }

  const again = saveCredentials('piper', { model: 'en_US-ryan' }, home);
  assert.deepEqual(again.protection, protection, 'the write re-tightens it');
  assert.deepEqual(Object.keys(loadCredentials(home)).sort(), ['elevenlabs', 'piper'],
    'and one engine does not clobber another');
});

test('what decklight says about the file is read BACK off the file', () => {
  // The #308 defect in one assertion: the claim used to be a constant, so it
  // could not be wrong on the platform where it was.
  const home = tmp();
  const { file } = saveCredentials('elevenlabs', ANSWERS, home);
  if (WINDOWS) {
    const p = protectionOf(file);
    assert.equal(p.state, 'private', `${p.label}\n${acl(file)}`);
    assert.equal(restrictFile(file).how, 'acl', 'and the restriction itself reports success');
  } else {
    chmodSync(file, 0o644);
    const p = protectionOf(file);
    assert.equal(p.state, 'open', 'a loosened file reports as loosened');
    assert.match(p.label, /0644/);
    assert.match(p.label, /readable by more than you/);
  }
  assert.deepEqual(protectionOf(credentialsPath(tmp())), { state: 'absent', label: 'nothing stored' });
});

test('on Windows the restriction is an explicit ACL, not a mode', () => {
  // Reachable from any machine, because the branch it covers is the one this
  // repo's POSIX runners can never execute — the tools/local-voice.mjs rule.
  const calls = [];
  const r = restrictFile('C:\\home\\credentials.json', {
    platform: 'win32', user: () => 'jo', env: { USERDOMAIN: 'DESKTOP' },
    exec: (bin, args) => { calls.push([bin, args]); },
    chmod: () => { throw new Error('chmod means nothing on Windows'); },
  });
  assert.deepEqual(r, { how: 'acl', who: 'DESKTOP\\jo', why: null });
  // /grant:r puts back exactly one principal, /inheritance:r drops what the
  // profile handed down — together that is "only the person who pasted it".
  // Two calls, GRANT FIRST: they fail separately, and the other order can leave
  // a file with an empty DACL that decklight itself cannot read.
  assert.deepEqual(calls, [
    ['icacls', ['C:\\home\\credentials.json', '/grant:r', 'DESKTOP\\jo:F']],
    ['icacls', ['C:\\home\\credentials.json', '/inheritance:r']],
  ]);
  // The account is named the way Windows names it, because icacls fails the
  // whole call on a principal it cannot resolve.
  assert.equal(qualifiedUser(() => 'jo', {}), 'jo', 'with no domain, the bare name');
  assert.equal(qualifiedUser(() => 'DOM\\jo', { USERDOMAIN: 'OTHER' }), 'DOM\\jo',
    'an already-qualified name is left alone');
});

test('a grant that lands but an inheritance drop that does not is PARTIAL, not silent', () => {
  // The file is then no worse than the profile left it, and decklight can still
  // read it — which is exactly why the grant goes first.
  const r = restrictFile('C:\\x', {
    platform: 'win32', user: () => 'jo', env: {},
    exec: (bin, args) => { if (args.includes('/inheritance:r')) throw new Error('Access is denied.'); },
  });
  assert.equal(r.how, 'partial');
  assert.match(r.why, /Access is denied/, 'and it keeps what the system said');
});

test('a machine that cannot set an ACL is told so, not told 0600', () => {
  // FAT volumes, network shares, a stripped image with no icacls: not an
  // error, but not a protection decklight may claim either.
  const r = restrictFile('C:\\x', {
    platform: 'win32', env: {}, exec: () => { throw new Error('ENOENT icacls'); },
  });
  assert.equal(r.how, 'inherited');
  assert.match(r.why, /ENOENT icacls/);
});

test('the ACL is read back, and anyone else on it is named', () => {
  const file = 'C:\\Users\\Jo Bloggs\\.decklight\\credentials.json';
  // Real icacls output: the path is on the first line ahead of the first
  // principal, and it has a SPACE in it — which is why the parser strips the
  // path by name rather than splitting on whitespace.
  const shared = `${file} NT AUTHORITY\\SYSTEM:(F)\r\n`
    + '                                     BUILTIN\\Administrators:(F)\r\n'
    + '                                     DESKTOP\\jo:(F)\r\n\r\n'
    + 'Successfully processed 1 files; Failed processing 0 files\r\n';
  assert.deepEqual(aclGrantees(shared, file),
    ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', 'DESKTOP\\jo']);

  const opts = (out) => ({
    platform: 'win32', exists: () => true, user: () => 'jo', exec: () => out,
  });
  const open = protectionOf(file, opts(shared));
  assert.equal(open.state, 'open');
  assert.match(open.label, /BUILTIN\\Administrators/, 'whoever else can read it is named');

  const mine = protectionOf(file, opts(`${file} DESKTOP\\jo:(F)\r\n`));
  assert.deepEqual(mine, { state: 'private', label: 'Windows ACL — restricted to jo' });
  // and a fully-qualified grantee is the same identity, not another principal
  assert.equal(protectionOf(file, opts(`${file} DESKTOP\\jo:(F)\r\n`)).state, 'private');
});

test('an unreadable ACL is reported as unknown rather than as protected', () => {
  const p = protectionOf('C:\\x', {
    platform: 'win32', exists: () => true, user: () => 'jo',
    exec: () => { throw new Error('access denied'); },
  });
  assert.equal(p.state, 'unknown');
  assert.match(p.label, /icacls could not read it/);
});

test('the destination line names the protection THIS platform actually has', () => {
  const schema = validateSchema(SCHEMA);
  assert.match(provenance(schema, 'elevenlabs@voices', { platform: 'linux' }).sentTo,
    /credentials\.json \(0600\)/);
  const win = provenance(schema, 'elevenlabs@voices', { platform: 'win32' }).sentTo;
  assert.match(win, /locked to your Windows account/);
  assert.doesNotMatch(win, /0600/,
    'printing a POSIX mode on a machine that has none is the whole of #308');
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

// ── the endpoints, against a real author server and a real catalog ─────────

const EDIT = path.join(ROOT, 'cli/edit.mjs');

/** A local marketplace whose entry declares a wizard. */
function catalogHome(wizard) {
  const repo = tmp();
  writeFileSync(path.join(repo, 'talk.txt'), 'x');
  const dl = path.join(repo, '.decklight');
  execFileSync('mkdir', ['-p', dl]);
  writeFileSync(path.join(dl, 'marketplace.json'), JSON.stringify({
    name: 'voices',
    entries: [
      { name: 'elevenlabs', type: 'engine', source: './e.mjs', wizard },
      // no wizard declared — must never be advertised as configurable
      { name: 'plain', type: 'engine', source: './p.mjs' },
    ],
  }, null, 2));

  const home = tmp();
  const env = { ...process.env, DECKLIGHT_HOME: home };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync(process.execPath, [CLI, 'marketplace', 'update', 'voices'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  return home;
}

const DECK = '<!doctype html><html><body><div class="decklight"><section><h2>A</h2></section></div>'
  + '<script>Decklight.init()</script></body></html>\n';

async function startAuthor(t, home) {
  const dir = tmp();
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const child = execFileSync ? null : null;
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], {
    cwd: dir, env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proc.kill('SIGKILL'));
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    proc.on('exit', () => { clearInterval(scan); reject(new Error('author exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`timeout:\n${out}`)); }, 10000);
  });
  return { base, dir, log: () => out };
}

test('the author server hands the player a VETTED schema, or refuses to', async (t) => {
  const home = catalogHome({
    engine: 'elevenlabs', title: 'ElevenLabs', validate: '/validate',
    fields: [{ name: 'apiKey', type: 'secret', required: true }],
  });
  const { base } = await startAuthor(t, home);

  const got = await (await fetch(`${base}/edit/wizard?engine=elevenlabs`)).json();
  assert.equal(got.ok, true);
  assert.equal(got.schema.title, 'ElevenLabs');
  assert.deepEqual(got.schema.fields[0], { name: 'apiKey', label: 'apiKey', type: 'secret', required: true });

  // Provenance rides beside the schema (#232): the asker is the REGISTRY's
  // qualified name for the entry, not anything the schema declared, and the
  // destination names the endpoint answers will actually be posted to.
  assert.equal(got.from, 'elevenlabs@voices');
  assert.deepEqual(got.provenance, provenance(got.schema, 'elevenlabs@voices'),
    'one wording, derived by the same function the unit tests pin down');
  assert.match(got.provenance.sentTo, /\/validate/);

  const missing = await fetch(`${base}/edit/wizard?engine=nope`);
  assert.equal(missing.status, 404);
});

test('ping advertises what a wizard can configure — the palette rows come from here', async (t) => {
  // Without this list the player half is unreachable: nothing in a deck knows
  // an engine name to ask /edit/wizard about, so openWizard has no caller.
  const home = catalogHome({ engine: 'elevenlabs', title: 'ElevenLabs', fields: [{ name: 'apiKey', type: 'secret', required: true }] });
  const { base } = await startAuthor(t, home);
  const ping = await (await fetch(`${base}/edit/ping`)).json();
  assert.deepEqual(ping.wizards, [{ name: 'elevenlabs', qualified: 'elevenlabs@voices', title: 'ElevenLabs' }],
    'qualified so the player names it unambiguously, titled so the palette can label the row — and the wizardless entry is not offered');
});

test('a catalog declaring a field core cannot render is refused on the way OUT', async (t) => {
  // A catalog is a file someone else wrote. Handing the renderer a schema core
  // has not vetted is how "core renders, a plugin declares" quietly becomes
  // "core renders whatever a plugin sent".
  // The entry is named elevenlabs; what it DECLARES is the unrenderable thing.
  const home = catalogHome({ engine: 'elevenlabs', fields: [{ name: 'x', type: 'html' }] });
  const { base } = await startAuthor(t, home);
  const r = await fetch(`${base}/edit/wizard?engine=elevenlabs`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /cannot render/);
});

test('a configured engine is stored restricted, and the response is redacted', async (t) => {
  const home = catalogHome({ engine: 'elevenlabs', fields: [{ name: 'apiKey', type: 'secret', required: true }] });
  const { base, log } = await startAuthor(t, home);

  const r = await fetch(`${base}/edit/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'elevenlabs', answers: { apiKey: 'sk-live-secret-value' } }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stored.apiKey, 'set (20 chars)');
  assert.doesNotMatch(JSON.stringify(j), /sk-live/, 'the response is the one place a key could leak back into a page');
  assert.doesNotMatch(log(), /sk-live/, 'and the terminal never sees it either');

  assert.equal(loadCredentials(home).elevenlabs.apiKey, 'sk-live-secret-value');
  const stored = protectionOf(credentialsPath(home));
  assert.equal(stored.state, 'private',
    `a key posted through the server lands restricted — ${stored.label}`
    + `${WINDOWS ? `\n${acl(credentialsPath(home))}` : ''}`);
  if (!WINDOWS) assert.equal(credentialsMode(home), 0o600);
  assert.match(log(), new RegExp(`configured .*${stored.label.replaceAll(/[.*+?^${}()|[\]\\—]/g, '\\$&')}`),
    'and the server logs what is actually protecting it, not what it hoped');

  // and forgetting works through the same surface
  const f = await fetch(`${base}/edit/wizard/forget`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'elevenlabs' }),
  });
  assert.equal((await f.json()).forgotten, true);
  assert.deepEqual(loadCredentials(home), {});
});

test('an engine no marketplace declares is a third answer, not one of the two failures', async (t) => {
  const home = catalogHome({ engine: 'elevenlabs', fields: [{ name: 'k', type: 'secret' }] });
  const { base } = await startAuthor(t, home);
  const r = await fetch(`${base}/edit/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'ghost', answers: {} }),
  });
  assert.equal(r.status, 404, 'not 503 and not 400 — nothing is down and nothing was refused');
  const j = await r.json();
  assert.equal(j.state, 'unknown');
  assert.match(j.error, /marketplace add/, 'and the fix is named');
});

test('bad answers come back 400 with the schema\'s own complaint', async (t) => {
  const home = catalogHome({
    engine: 'elevenlabs',
    fields: [{ name: 'apiKey', type: 'secret', required: true }, { name: 'voice', type: 'choice', options: ['Rachel'] }],
  });
  const { base } = await startAuthor(t, home);
  const r = await fetch(`${base}/edit/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'elevenlabs', answers: { voice: 'Nobody' } }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.state, 'rejected');
  assert.match(j.error, /required/);
  assert.match(j.error, /not one of Rachel/);
  assert.deepEqual(loadCredentials(home), {}, 'and nothing was stored');
});

test('the player gate: the overlay refuses without an author server', () => {
  // The runtime asks editAvailable before it renders a single input, and the
  // refusal is the same needsDevMode line every other author-only affordance
  // uses. A prompt that collected a credential with nowhere to post it would be
  // a phishing form with a deck around it.
  const src = readFileSync(path.join(ROOT, 'src/core/editmode.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openWizard'), src.indexOf('overlays.register({\n    isOpen: () => !!wizEl'));
  assert.match(fn, /if \(!editAvailable\)/, 'gated before anything is built');
  assert.ok(fn.indexOf('if (!editAvailable)') < fn.indexOf('createElement'),
    'and gated BEFORE the first element, not after the form is on screen');
  assert.match(fn, /needsDevMode/);
  assert.doesNotMatch(fn, /innerHTML/, 'core builds inputs, it never sets markup a catalog supplied');
  assert.match(fn, /type = f\.type === 'secret' \? 'password'/, 'a secret is not read over a shoulder');

  // #232: the provenance gate and the provenance line. A response without
  // askedBy/sentTo is refused before a single element exists, and what IS
  // rendered goes in as textContent — this line above all must never carry
  // markup a catalog chose.
  assert.match(fn, /j\.provenance\?\.askedBy/, 'the player demands provenance, it does not default it');
  assert.ok(fn.indexOf('j.provenance?.askedBy') < fn.indexOf('createElement'),
    'and demands it BEFORE anything is built');
  assert.match(fn, /wiz-src/, 'the card carries the provenance element');
  assert.match(fn, /who\.textContent = prov\.askedBy/);
  assert.match(fn, /dest\.textContent = prov\.sentTo/);
  assert.ok(fn.indexOf('wiz-src') < fn.indexOf('inputs.set'),
    'shown above the fields — read before anything can be typed');
});

// ── non-credential prerequisites (SPEC ENGINE_PREREQUISITES, #268) ─────────
//
// TTS made two failure states look like enough, because a key is the only
// thing a TTS provider ever needs. Lipsync is the case that proves otherwise:
// rhubarb is a BINARY, Wav2Lip is a python checkout plus model WEIGHTS, and
// only Veo is the paste-a-key shape. An engine that cannot run on this
// machine must not be told its key was the problem — and must not have a key
// collected for it at all.

const LIPSYNC_SCHEMA = {
  engine: 'wav2lip',
  title: 'Wav2Lip',
  requires: [
    { kind: 'binary', name: 'rhubarb', hint: 'brew install rhubarb-lip-sync' },
    { kind: 'file', name: '/models/wav2lip.pth', hint: 'download the checkpoint' },
  ],
  fields: [{ name: 'device', label: 'Device', type: 'choice', options: ['cpu', 'cuda'] }],
};

test('a schema may declare binary and file prerequisites, and nothing else', () => {
  const s = validateSchema(LIPSYNC_SCHEMA);
  assert.deepEqual(s.requires.map((r) => r.kind), ['binary', 'file']);
  assert.equal(s.requires[0].hint, 'brew install rhubarb-lip-sync');
  assert.deepEqual([...REQUIRE_KINDS], ['binary', 'file']);

  // the vocabulary is CLOSED, exactly like FIELD_TYPES — a prerequisite core
  // cannot check is refused by name rather than ignored
  for (const kind of ['script', 'shell', 'download', 'docker']) {
    assert.throws(() => validateSchema({ ...LIPSYNC_SCHEMA, requires: [{ kind, name: 'x' }] }),
      (e) => e instanceof SchemaError && /is not a prerequisite core can check/.test(e.message));
  }
  assert.throws(() => validateSchema({ ...LIPSYNC_SCHEMA, requires: [{ kind: 'binary', name: 'x', run: 'rm -rf /' }] }),
    (e) => e instanceof SchemaError && /only: kind, name, hint/.test(e.message));
});

test('a hint is prose a human reads — capped, and never a thing core runs', () => {
  assert.throws(() => validateSchema({ ...LIPSYNC_SCHEMA, requires: [{ kind: 'binary', name: 'x', hint: 'y'.repeat(201) }] }),
    (e) => e instanceof SchemaError && /≤200 chars/.test(e.message));
  // The design claim behind that cap: the schema carries no field naming
  // something to EXECUTE. `install` is a bridge PATH (checked elsewhere), and
  // a prerequisite's only free text is displayed. If this ever gains a
  // "command core runs", the wizard becomes an RCE primitive with a config
  // file for a delivery mechanism (MARKETPLACE.md WHY).
  const s = validateSchema(LIPSYNC_SCHEMA);
  for (const r of s.requires) assert.deepEqual(Object.keys(r).sort(), ['hint', 'kind', 'name']);
});

test('unmetRequirements probes the machine, and is pure enough to test without one', () => {
  const all = validateSchema(LIPSYNC_SCHEMA);
  // nothing present
  assert.deepEqual(
    unmetRequirements(all, { hasBin: () => false, exists: () => false }).map((r) => r.name),
    ['rhubarb', '/models/wav2lip.pth']);
  // the binary arrives, the weights have not
  assert.deepEqual(
    unmetRequirements(all, { hasBin: () => true, exists: () => false }).map((r) => r.name),
    ['/models/wav2lip.pth']);
  // everything present → the engine can run
  assert.deepEqual(unmetRequirements(all, { hasBin: () => true, exists: () => true }), []);
  // a schema with no requires is trivially satisfied
  assert.deepEqual(unmetRequirements({ engine: 'x' }, {}), []);

  assert.match(requirementLine(all.requires[0]), /command "rhubarb" is missing — brew install/);
  assert.match(requirementLine({ kind: 'file', name: '/w.pth' }), /file "\/w\.pth" is missing/);
});

test('an unmet prerequisite is its OWN state — no key collected, nothing written', async () => {
  const home = tmp();
  let saved = false;
  const r = await configureEngine('wav2lip', { device: 'cuda' }, {
    home,
    fetchSchema: async () => LIPSYNC_SCHEMA,
    validateAnswers: async () => { throw new Error('must not be reached'); },
    save: () => { saved = true; return { file: 'x', protection: { state: 'private', label: '0600' } }; },
    probes: { hasBin: () => false, exists: () => false },
  });
  assert.equal(r.state, PREREQUISITE);
  assert.notEqual(r.state, REJECTED, 'not "your key is wrong"');
  assert.notEqual(r.state, UNREACHABLE, 'and not "try again later"');
  assert.match(r.reason, /rhubarb/);
  assert.match(r.reason, /brew install rhubarb-lip-sync/, 'the fix is named');
  assert.deepEqual(r.unmet.map((x) => x.name), ['rhubarb', '/models/wav2lip.pth']);
  assert.equal(saved, false, 'nothing is stored for an engine that cannot run');
});

test('once the prerequisites are met, the same schema configures normally', async () => {
  const home = tmp();
  const r = await configureEngine('wav2lip', { device: 'cuda' }, {
    home,
    fetchSchema: async () => LIPSYNC_SCHEMA,
    validateAnswers: async () => true,
    probes: { hasBin: () => true, exists: () => true },
  });
  assert.equal(r.state, CONFIGURED);
  assert.deepEqual(r.stored, { device: 'cuda' });
});

test('the prerequisite gate runs BEFORE the network — an outage cannot mask it', async () => {
  const home = tmp();
  let reached = false;
  const r = await configureEngine('wav2lip', { device: 'cpu' }, {
    home,
    fetchSchema: async () => ({ ...LIPSYNC_SCHEMA, validate: '/check' }),
    validateAnswers: async () => { reached = true; throw new Error('network down'); },
    save: () => ({ file: 'x', protection: { state: 'private', label: '0600' } }),
    probes: { hasBin: () => false, exists: () => true },
  });
  assert.equal(r.state, PREREQUISITE);
  assert.equal(reached, false, 'the provider was never called');
});
