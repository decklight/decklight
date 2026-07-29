// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight marketplace` — registration without fetching (MARKETPLACES#CORE).
//
// The invariant that outranks every feature here: a marketplace existing must
// never cost a deck a network round-trip. Registration is a filesystem write,
// `list` reads only the cache, and nothing on the deck-load or presenting
// path imports the module at all — the last one is pinned as a test, because
// it is the kind of line a later refactor crosses without noticing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_PARTY, MANIFEST_PATH, MarketplaceError,
  classifySource, configHome, ensureFirstPartyRegistered, fetchManifestText,
  jsonLineMap, loadCatalog, loadRegistry, parseErrorLine, resolveEntry,
  validateManifest,
} from '../cli/marketplace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-marketplace-'));

/** A local marketplace repo: a dir with .decklight/marketplace.json. */
function marketRepo(manifestText) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.decklight'), { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_PATH), manifestText);
  return dir;
}

const GOOD = `{
  "name": "nord-pack",
  "description": "cool blues",
  "entries": [
    { "name": "nord-deep", "type": "theme", "source": "./themes/nord-deep.css", "description": "deep blues" },
    { "name": "frost", "type": "theme", "source": "./themes/frost.css" }
  ]
}
`;

/** Run the real CLI with its config home pointed somewhere disposable. */
const run = (home, ...args) => spawnSync('node', [CLI, 'marketplace', ...args], {
  encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home },
});

// ── the manifest, validated with line numbers ──────────────────────────────

test('a well-formed manifest validates', () => {
  const v = validateManifest(GOOD);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.entries.length, 2);
});

test('a missing entry field is named with its line — not a stack trace', () => {
  // "frost" (line 6) has no type
  const raw = GOOD.replace('"name": "frost", "type": "theme", ', '"name": "frost", ');
  const v = validateManifest(raw);
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === 'entries[1].type');
  assert.ok(e, JSON.stringify(v.errors));
  assert.equal(e.line, 6, 'the line the entry sits on — a missing key has no line of its own');
  assert.match(e.msg, /missing/);
});

test('a field with a bad value is named at ITS line, not the entry line', () => {
  const raw = GOOD.replace('"type": "theme", "source": "./themes/nord-deep.css"',
    '"type": "Theme!",\n      "source": "./themes/nord-deep.css"');
  const v = validateManifest(raw);
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === 'entries[0].type');
  assert.equal(e.line, 5, 'the line carrying the bad value');
  assert.match(e.msg, /lowercase word/);
});

test('a JSON syntax error names its line, for every V8 message form', () => {
  // snippet form ("Unexpected token ... is not valid JSON") carries no
  // position — the line is recovered by locating the context in the raw text
  const doubleComma = GOOD.replace('"deep blues" },', '"deep blues" },,');
  const v1 = validateManifest(doubleComma);
  assert.equal(v1.ok, false);
  assert.equal(v1.errors[0].line, 5, v1.errors[0].msg);
  assert.doesNotMatch(v1.errors[0].msg, /is not valid JSON/, 'the noise is stripped');
  // positional form
  const noColon = GOOD.replace('"description": "cool blues"', '"description" "cool blues"');
  const v2 = validateManifest(noColon);
  assert.equal(v2.ok, false);
  assert.equal(v2.errors[0].line, 3);
  // the explicit "(line N column M)" form some V8s emit
  assert.equal(parseErrorLine('x', { message: 'whatever (line 7 column 2)' }), 7);
});

test('duplicate entry names within one marketplace are refused', () => {
  const raw = GOOD.replace('"name": "frost"', '"name": "nord-deep"');
  const v = validateManifest(raw);
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === 'entries[1].name');
  assert.match(e.msg, /already used by entries\[0\]/);
});

test('a marketplace name that cannot qualify entries is refused', () => {
  const v = validateManifest(GOOD.replace('"nord-pack"', '"nord pack"'));
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, 'name');
  assert.equal(v.errors[0].line, 2);
});

test('jsonLineMap knows where every key and element lives', () => {
  const m = jsonLineMap(GOOD);
  assert.equal(m.get('name'), 2);
  assert.equal(m.get('entries'), 4);
  assert.equal(m.get('entries[0]'), 5);
  assert.equal(m.get('entries[1].name'), 6);
});

// ── sources ────────────────────────────────────────────────────────────────

test('a source spec is read the way a human meant it', () => {
  const never = { exists: () => false };
  assert.deepEqual(classifySource('decklight/marketplace', never),
    { kind: 'github', owner: 'decklight', repo: 'marketplace', spec: 'decklight/marketplace' });
  assert.equal(classifySource('https://github.com/a/b.git', never).kind, 'github');
  assert.equal(classifySource('https://github.com/a/b.git', never).repo, 'b');
  assert.equal(classifySource('git@example.com:a/b.git', never).kind, 'git');
  assert.equal(classifySource('https://gitlab.com/a/b.git', never).kind, 'git');
  assert.equal(classifySource('./local/dir', never).kind, 'local');
  // a path that EXISTS wins over the owner/repo reading — you meant the dir
  assert.equal(classifySource('a/b', { exists: () => true }).kind, 'local');
});

test('a fetch failure is fast and says which marketplace and why', async () => {
  const src = classifySource('ghost/catalog', { exists: () => false });
  await assert.rejects(
    fetchManifestText(src, { fetchImpl: () => Promise.reject(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })) }),
    (e) => e instanceof MarketplaceError && /ghost\/catalog/.test(e.message) && /ENOTFOUND/.test(e.message),
  );
  await assert.rejects(
    fetchManifestText(src, { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    (e) => /ghost\/catalog has no \.decklight\/marketplace\.json \(HTTP 404\)/.test(e.message),
  );
});

test('a local source that is not a marketplace repo says so', async () => {
  const dir = tmp();
  await assert.rejects(fetchManifestText(classifySource(dir)),
    (e) => e instanceof MarketplaceError && /is it a marketplace repo\?/.test(e.message));
});

// ── registered, not fetched ────────────────────────────────────────────────

test('first run registers the first-party marketplace with ZERO network', () => {
  const home = tmp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the network was touched at registration'); };
  try {
    assert.equal(ensureFirstPartyRegistered(home), true);
  } finally {
    globalThis.fetch = realFetch;
  }
  const reg = loadRegistry(home);
  assert.equal(reg.marketplaces[FIRST_PARTY.name].source, FIRST_PARTY.source);
  assert.equal(loadCatalog(FIRST_PARTY.name, home), null, 'registered, NOT fetched — no cached manifest');
  assert.equal(ensureFirstPartyRegistered(home), false, 'first run happens once');
});

test('removing the first-party marketplace is respected, not undone', () => {
  const home = tmp();
  assert.equal(run(home, 'list').status, 0); // first run: auto-registers
  assert.equal(run(home, 'remove', 'decklight').status, 0);
  const r = run(home, 'list'); // any later command must NOT bring it back
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /first-party/);
});

test('nothing on the deck-load or presenting path imports the marketplace', () => {
  // MARKETPLACE.md MARKETPLACES: a deck on conference wifi, a plane, or
  // air-gapped behaves identically — so the runtime and every deck-serving
  // path must be incapable of a marketplace fetch, not merely disinclined.
  const files = [
    ...fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter((f) => /\.(js|mjs)$/.test(f)).map((f) => path.join('src', f)),
    'cli/serve.mjs', 'cli/edit.mjs', 'cli/dev.mjs', 'cli/bundle.mjs', 'cli/upgrade.mjs',
  ];
  assert.ok(files.length > 10, 'the sweep found the runtime');
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, /marketplace\.mjs|raw\.githubusercontent/,
      `${f} reaches for the marketplace — the registered-not-fetched invariant`);
  }
});

// ── the CLI, end to end ────────────────────────────────────────────────────

test('fresh home: first-party appears in list as registered-not-fetched', () => {
  const home = tmp();
  const r = run(home, 'list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^decklight \(first-party\) {2}decklight\/marketplace — registered, not fetched/m);
  assert.match(r.stdout, /marketplace update decklight/, 'and says how to fetch it');
  assert.ok(fs.existsSync(path.join(home, 'marketplaces.json')));
});

test('add a local repo, list both catalogs offline with qualified names', () => {
  const home = tmp();
  const repo = marketRepo(GOOD);
  const add = run(home, 'add', repo);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /registered nord-pack .* 2 entries: nord-deep@nord-pack, frost@nord-pack/);
  assert.ok(fs.existsSync(path.join(home, 'marketplaces', 'nord-pack.json')), 'the cached manifest');

  const list = run(home, 'list');
  assert.match(list.stdout, /registered, not fetched/, 'first-party still not fetched');
  assert.match(list.stdout, /nord-deep@nord-pack {2}theme — deep blues/);
  assert.match(list.stdout, /frost@nord-pack {2}theme/);
});

test('a malformed manifest fails add naming line and field — no stack trace', () => {
  const home = tmp();
  const repo = marketRepo(GOOD.replace('"name": "frost", "type": "theme", ', '"name": "frost", '));
  const r = run(home, 'add', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 6: entries\[1\]\.type — missing/);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'a typo in a manifest is not an internal error');
  assert.equal(fs.existsSync(path.join(home, 'marketplaces', 'nord-pack.json')), false, 'nothing registered');
});

test('update refreshes the cache from the source', () => {
  const home = tmp();
  const repo = marketRepo(GOOD);
  run(home, 'add', repo);
  fs.writeFileSync(path.join(repo, MANIFEST_PATH),
    GOOD.replace('"cool blues"', '"cooler blues"').replace('"frost"', '"frost-2"'));
  const r = run(home, 'update', 'nord-pack');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated nord-pack — 2 entries: .*frost-2@nord-pack/);
  assert.match(run(home, 'list').stdout, /frost-2@nord-pack/);
});

test('update of an unfetchable marketplace names it, fast, and keeps the cache', () => {
  const home = tmp();
  const repo = marketRepo(GOOD);
  run(home, 'add', repo);
  fs.rmSync(repo, { recursive: true, force: true }); // the source is gone
  const r = run(home, 'update', 'nord-pack');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nord-pack/);
  assert.match(r.stderr, /cached copy is untouched/);
  assert.match(run(home, 'list').stdout, /nord-deep@nord-pack/, 'list still serves the cache');
});

test('remove unregisters; an unknown name is an error that names the fix', () => {
  const home = tmp();
  const repo = marketRepo(GOOD);
  run(home, 'add', repo);
  const r = run(home, 'remove', 'nord-pack');
  assert.equal(r.status, 0);
  assert.doesNotMatch(run(home, 'list').stdout, /nord-pack/);
  assert.equal(fs.existsSync(path.join(home, 'marketplaces', 'nord-pack.json')), false);
  assert.equal(run(home, 'remove', 'nord-pack').status, 1);
  assert.equal(run(home, 'update', 'ghost').status, 1);
});

test('two marketplaces may not silently share a registry name', () => {
  const home = tmp();
  run(home, 'add', marketRepo(GOOD));
  const r = run(home, 'add', marketRepo(GOOD)); // same manifest name, other source
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already registered from/);
  assert.match(r.stderr, /--name/, 'and says how to have both');
  const named = run(home, 'add', marketRepo(GOOD), '--name', 'nord-pack-2');
  assert.equal(named.status, 0, named.stderr);
  assert.match(run(home, 'list').stdout, /nord-deep@nord-pack-2/);
});

// ── qualified names ────────────────────────────────────────────────────────

test('a bare name in two marketplaces is ambiguous, never silently resolved', () => {
  const a = { entries: [{ name: 'nord-deep', type: 'theme', source: 'x.css' }] };
  const b = { entries: [{ name: 'nord-deep', type: 'theme', source: 'y.css' }] };
  assert.throws(() => resolveEntry('nord-deep', { a, b }),
    (e) => e instanceof MarketplaceError && /ambiguous/.test(e.message)
      && /nord-deep@a/.test(e.message) && /nord-deep@b/.test(e.message));
  // qualification resolves it
  assert.equal(resolveEntry('nord-deep@b', { a, b }).entry.source, 'y.css');
  // a bare name in exactly one marketplace is fine
  assert.equal(resolveEntry('nord-deep', { a }).qualified, 'nord-deep@a');
  assert.throws(() => resolveEntry('ghost', { a, b }), /no "ghost" in any registered marketplace/);
  assert.throws(() => resolveEntry('x@ghost', { a, b }), /no marketplace "ghost" is registered/);
});

// ── the config home ────────────────────────────────────────────────────────

test('DECKLIGHT_HOME overrides ~/.decklight', () => {
  assert.equal(configHome({ DECKLIGHT_HOME: '/x/y' }), '/x/y');
  assert.equal(configHome({}), path.join(os.homedir(), '.decklight'));
});
