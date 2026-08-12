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
  FIRST_PARTY, MANIFEST_PATH, MarketplaceError, TRANSFORM_API_VERSION, IMPORTER_API_VERSION,
  ENGINE_API_VERSION, ENGINE_CAPABILITIES, INSTALL_HINT,
  checkoutPath, classifySource, cloneUrl, configHome, ensureFirstPartyRegistered, fetchManifest,
  jsonLineMap, loadCatalog, loadRegistry, parseErrorLine, resolveEntry,
  validateManifest,
} from '../cli/marketplace.mjs';
import { resolveSource } from '../cli/theme.mjs';

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

// ── a transform's apiVersion: independent of decklight's own version ───────
// (SPEC UNIT_COMPAT, MARKETPLACE.md OPEN 2)

const TRANSFORM = `{
  "name": "grammar-pack",
  "entries": [
    { "name": "grammar-check", "type": "transform", "source": "./grammar.mjs", "apiVersion": 1 }
  ]
}
`;

test('a transform entry validates with a positive-integer apiVersion', () => {
  const v = validateManifest(TRANSFORM);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.entries[0].apiVersion, 1);
});

test('a transform with no apiVersion is refused, naming the field', () => {
  const raw = TRANSFORM.replace(', "apiVersion": 1', '');
  const v = validateManifest(raw);
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === 'entries[0].apiVersion');
  assert.ok(e, JSON.stringify(v.errors));
  assert.match(e.msg, /missing/);
});

test('a non-integer or non-positive apiVersion is refused, not silently coerced', () => {
  for (const bad of ['"1"', '0', '-1', '1.5', 'true']) {
    const v = validateManifest(TRANSFORM.replace('"apiVersion": 1', `"apiVersion": ${bad}`));
    assert.equal(v.ok, false, `apiVersion: ${bad} should not validate`);
    assert.match(v.errors.find((x) => x.field === 'entries[0].apiVersion').msg, /positive integer/);
  }
});

test('apiVersion is checked for SHAPE only, never against what this decklight implements', () => {
  // A catalog may declare a contract version ahead of what this decklight
  // currently has — refusing it here would make a manifest written against a
  // newer decklight un-addable, the same reasoning ENTRY_SHAPES already
  // applies to an unrecognised `type`.
  const ahead = TRANSFORM.replace('"apiVersion": 1', `"apiVersion": ${TRANSFORM_API_VERSION + 10}`);
  assert.equal(validateManifest(ahead).ok, true);
});

test('apiVersion names the transform contract, not a decklight version — the field never appears on other kinds', () => {
  assert.equal(TRANSFORM_API_VERSION, 1);
  const v = validateManifest(GOOD); // GOOD has only `theme` entries
  assert.equal(v.ok, true);
  assert.equal(v.manifest.entries[0].apiVersion, undefined);
});

// ── an import adapter's apiVersion: its OWN counter, not TRANSFORM_API_VERSION ──
// (SPEC EXTENSIONS_ADAPTERS, MARKETPLACE.md EXTENSIONS#ADAPTEREXEC)

const IMPORTER = `{
  "name": "marp-pack",
  "entries": [
    { "name": "marp-import", "type": "importer", "source": "./marp.mjs", "extensions": [".marp"], "apiVersion": 1 }
  ]
}
`;

test('an importer entry validates with a positive-integer apiVersion, alongside extensions', () => {
  const v = validateManifest(IMPORTER);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.entries[0].apiVersion, 1);
});

test('an importer with no apiVersion is refused, naming the field — extensions alone is not enough', () => {
  const raw = IMPORTER.replace(', "apiVersion": 1', '');
  const v = validateManifest(raw);
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.field === 'entries[0].apiVersion');
  assert.ok(e, JSON.stringify(v.errors));
  assert.match(e.msg, /missing/);
});

test('an importer apiVersion ahead of what this decklight implements still validates — shape only', () => {
  const ahead = IMPORTER.replace('"apiVersion": 1', `"apiVersion": ${IMPORTER_API_VERSION + 10}`);
  assert.equal(validateManifest(ahead).ok, true);
});

test('IMPORTER_API_VERSION is its own counter, independent of TRANSFORM_API_VERSION', () => {
  // Equal today (both 1) is fine — what the design owes is that they are two
  // SEPARATE bindings, so bumping the import-adapter contract can never
  // silently move a transform's ceiling too (SPEC EXTENSIONS_ADAPTERS).
  assert.equal(IMPORTER_API_VERSION, 1);
  assert.equal(TRANSFORM_API_VERSION, 1);
});

// ── the pin a code-carrying entry installs against (SPEC UNIT_PINNING) ─────

const HEX64 = 'a'.repeat(64);

test('a well-formed sha256 validates on both code-carrying kinds', () => {
  const t = validateManifest(TRANSFORM.replace('"apiVersion": 1', `"apiVersion": 1, "sha256": "${HEX64}"`));
  assert.equal(t.ok, true, JSON.stringify(t.errors));
  const i = validateManifest(IMPORTER.replace('"apiVersion": 1', `"apiVersion": 1, "sha256": "${HEX64}"`));
  assert.equal(i.ok, true, JSON.stringify(i.errors));
});

test('a malformed sha256 is refused naming the line and the field', () => {
  for (const bad of ['"abc"', `"${'g'.repeat(64)}"`, `"${'A'.repeat(64)}"`, `"${'a'.repeat(63)}"`, '17']) {
    const v = validateManifest(TRANSFORM.replace('"apiVersion": 1', `"apiVersion": 1, "sha256": ${bad}`));
    assert.equal(v.ok, false, `sha256: ${bad} should not validate`);
    const e = v.errors.find((x) => x.field === 'entries[0].sha256');
    assert.ok(e, JSON.stringify(v.errors));
    assert.match(e.msg, /64 lowercase hex/);
    assert.ok(e.line > 1, 'the error carries the line, like every other manifest error');
  }
});

test('an ABSENT sha256 does not invalidate the manifest — the refusal is install-time', () => {
  // Requiring the pin here would refuse a whole catalog over one unpinned
  // transform, costing its theme entries too — the blast-radius reasoning
  // that already leaves an unknown `type` accepted. cli/units.mjs is where
  // an unpinned executable entry is refused, at the moment of risk
  // (test/units.test.mjs).
  assert.equal(validateManifest(TRANSFORM).ok, true);
  assert.equal(validateManifest(IMPORTER).ok, true);
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
  assert.equal(classifySource('file:///srv/mirrors/nord.git', never).kind, 'git');
  assert.equal(classifySource('./local/dir', never).kind, 'local');
  // a path that EXISTS wins over the owner/repo reading — you meant the dir
  assert.equal(classifySource('a/b', { exists: () => true }).kind, 'local');
});

test('every remote spec is a CLONE — owner/repo is shorthand for one, not for a raw host', () => {
  // The private-marketplace bug started here: `owner/repo` used to mean an
  // unauthenticated fetch of raw.githubusercontent.com, which cannot see a
  // private repo at all. A clone uses the caller's own git credentials, so
  // the shorthand and the git URL now reach the same place the same way.
  const never = { exists: () => false };
  assert.equal(cloneUrl(classifySource('acme/catalog', never)), 'https://github.com/acme/catalog.git');
  assert.equal(cloneUrl(classifySource('https://github.com/acme/catalog', never)), 'https://github.com/acme/catalog.git');
  assert.equal(cloneUrl(classifySource('git@github.com:acme/catalog.git', never)), 'git@github.com:acme/catalog.git');
  const src = fs.readFileSync(path.join(root, 'cli', 'marketplace.mjs'), 'utf8');
  assert.doesNotMatch(src, /raw\.githubusercontent\.com\/\$\{/, 'no raw-content URL is built anywhere');
});

/** An exec that fails `git clone` and answers `git credential fill` as told. */
const gitStub = ({ credential, stderr = 'remote: Repository not found.\n' }) => (cmd, args) => {
  if (args[0] === 'credential') {
    if (!credential) throw Object.assign(new Error('exit 128'), { stderr: 'could not read Username' });
    return 'protocol=https\nhost=github.com\nusername=x\npassword=SECRET\n';
  }
  throw Object.assign(new Error('exit 128'), { stderr });
};

test('a clone failure is fast, says why, and names what a private repo needs', async () => {
  // The failure a private GitHub marketplace actually hits now. It may not
  // read as "you got the repo wrong": on a machine with no credential for the
  // host, the clone went out anonymous, and that is the sentence to say.
  const src = classifySource('acme/private-catalog', { exists: () => false });
  const e = await fetchManifest(src, { exec: gitStub({ credential: false }), stagingIn: tmp() })
    .then(() => null, (err) => err);
  assert.ok(e instanceof MarketplaceError);
  assert.match(e.message, /git clone https:\/\/github\.com\/acme\/private-catalog\.git failed/);
  assert.match(e.message, /Repository not found/, 'git gets to say what happened');
  assert.match(e.message, /git has no credential for github\.com/);
  assert.match(e.message, /gh auth setup-git/, 'the setup instructions, where they apply');
  assert.match(e.message, /decklight marketplace add git@github\.com:acme\/private-catalog\.git/);
});

test('the setup instructions are withheld from a machine that is already set up', async () => {
  // Advice that is wrong half the time teaches people to skim the last line of
  // an error. Reading `credential.helper` out of the config would be wrong
  // exactly here: macOS ships a global osxkeychain helper, so "configured" is
  // true on a machine that has never stored a GitHub credential. `git
  // credential fill` answers the question that was actually asked.
  const src = classifySource('acme/typo-catalog', { exists: () => false });
  const e = await fetchManifest(src, { exec: gitStub({ credential: true }), stagingIn: tmp() })
    .then(() => null, (err) => err);
  assert.match(e.message, /git does have a credential for github\.com/);
  assert.match(e.message, /not a setup problem/);
  assert.doesNotMatch(e.message, /gh auth setup-git/, 'no instructions for a step already taken');
  assert.doesNotMatch(e.message, /SECRET/, 'and the credential itself is never read back out');
  assert.match(e.message, /git@github\.com:acme\/typo-catalog\.git/, 'the SSH route is still offered');
});

test('an SSH URL is answered with the key, never with helper setup', async () => {
  // A helper is not in the picture for SSH — the key is the credential, so
  // pointing at `gh auth setup-git` would send someone down the wrong path.
  const src = classifySource('git@github.com:acme/private-catalog.git');
  const e = await fetchManifest(src, {
    exec: gitStub({ credential: false, stderr: 'Permission denied (publickey).' }), stagingIn: tmp(),
  }).then(() => null, (err) => err);
  assert.match(e.message, /Permission denied \(publickey\)/);
  assert.match(e.message, /ssh -T git@github\.com/);
  assert.doesNotMatch(e.message, /gh auth setup-git/);
});

test('offline is answered as offline, never as a credentials problem', async () => {
  const src = classifySource('acme/catalog', { exists: () => false });
  const offline = () => {
    throw Object.assign(new Error('exit 128'),
      { stderr: "fatal: unable to access 'https://github.com/acme/catalog.git/': Could not resolve host: github.com" });
  };
  const e = await fetchManifest(src, { exec: offline, stagingIn: tmp() }).then(() => null, (err) => err);
  assert.match(e.message, /offline\?/);
  assert.doesNotMatch(e.message, /credential helper/, 'a plane is not a missing credential');
});

test('a failed clone leaves no staging directory behind', async () => {
  const staging = tmp();
  const boom = () => { throw Object.assign(new Error('exit 128'), { stderr: 'fatal: could not read Username' }); };
  await assert.rejects(fetchManifest(classifySource('acme/x', { exists: () => false }),
    { exec: boom, stagingIn: staging }));
  assert.deepEqual(fs.readdirSync(staging), [], 'nothing half-cloned survives a failure');
});

test('a local source that is not a marketplace repo says so', async () => {
  const dir = tmp();
  await assert.rejects(fetchManifest(classifySource(dir)),
    (e) => e instanceof MarketplaceError && /is it a marketplace repo\?/.test(e.message));
});

test('a local marketplace is read in place — no clone, no checkout', async () => {
  const got = await fetchManifest(classifySource(marketRepo(GOOD)));
  assert.equal(got.checkout, null, "somebody's working tree is not copied into the config home");
  assert.equal(got.commit, null);
  assert.equal(validateManifest(got.raw).ok, true);
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

test('nothing on the deck-load or presenting path can FETCH from a marketplace', () => {
  // MARKETPLACE.md MARKETPLACES: a deck on conference wifi, a plane, or
  // air-gapped behaves identically — so the runtime and every deck-serving path
  // must be incapable of a marketplace fetch, not merely disinclined.
  //
  // This used to forbid importing cli/marketplace.mjs at all, which was the
  // right approximation until something on this path legitimately needed to
  // READ the local cache: the engine wizard (ENGINES#WIZARD) resolves an engine
  // through `resolveEntry`, whose own docblock names it as a caller. A cached
  // JSON read is exactly as offline-identical as no read at all, so forbidding
  // it protected nothing — and the ways around it (a second file that does the
  // import, an injected lookup) would have moved the capability without
  // changing it, which is worse than naming what is actually forbidden.
  //
  // So: fetching is forbidden, and the fetching functions are named. The
  // registered-not-fetched invariant is intact; `marketplace update` is still
  // the only thing that reaches the network, and it is not on this path.
  const FETCHERS = /fetchManifest|cloneMarketplace|raw\.githubusercontent|marketplaceMain/;
  const files = [
    ...fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter((f) => /\.(js|mjs)$/.test(f)).map((f) => path.join('src', f)),
    'cli/serve.mjs', 'cli/edit.mjs', 'cli/dev.mjs', 'cli/bundle.mjs', 'cli/upgrade.mjs',
    // cli/plugin.mjs is on the presenting path (present injects presenter
    // chrome from the local library, PRESENT#PLUGINS). It reads the catalog
    // CACHE to resolve `plugin add`, which is the same considered read the
    // wizard makes; what it must never grow is a catalog fetch, and this is
    // where that is held.
    'cli/present.mjs', 'cli/wizard.mjs', 'cli/plugin.mjs',
  ];
  assert.ok(files.length > 10, 'the sweep found the runtime');
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, FETCHERS,
      `${f} could fetch from a marketplace — the registered-not-fetched invariant`);
  }

  // And the runtime still may not import the module at all: a browser has no
  // config home to read, so any mention there would be a mistake rather than a
  // considered read.
  for (const f of files.filter((x) => x.startsWith('src/'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /marketplace\.mjs/,
      `${f} is runtime — it has no filesystem to read a catalog from`);
  }
});


// ── the CLI, end to end ────────────────────────────────────────────────────

test('fresh home: first-party appears in list as registered-not-fetched', () => {
  const home = tmp();
  const r = run(home, 'list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^decklight \(first-party\) {2}decklight\/decklight-plugins-official — registered, not fetched/m);
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
  // Entries are grouped under their KIND, with the install command for that
  // kind on the heading (UNITS#REST) — what you can do with an entry depends
  // entirely on what kind it is, and a flat list of names hides that.
  assert.match(list.stdout, /^ {2}theme {2}— {2}decklight theme add/m);
  assert.match(list.stdout, /^ {4}nord-deep@nord-pack — deep blues$/m);
  assert.match(list.stdout, /^ {4}frost@nord-pack$/m);
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

// ── the checkout: entries come from the clone, not from a second fetch ─────
// (MARKETPLACES#CLONE, #286)

/** A marketplace as a REAL git repo, clonable over file:// like any remote. */
function gitMarketRepo(manifestText, files = {}) {
  const dir = marketRepo(manifestText);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'catalog');
  return { dir, url: `file://${dir}`, commit: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}

const TEMPLATES = `{
  "name": "nord-pack",
  "entries": [
    { "name": "pitch", "type": "template", "source": "./templates/pitch.html" }
  ]
}
`;
const PITCH = '<!doctype html><html><head><title>Pitch</title></head>'
  + '<body><div class="decklight"><section><h1>Pitch</h1></section></div></body></html>';

test('adding a remote marketplace keeps the clone its entries install from', () => {
  const home = tmp();
  const repo = gitMarketRepo(TEMPLATES, { 'templates/pitch.html': PITCH });
  const add = run(home, 'add', repo.url);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(fs.existsSync(path.join(home, 'marketplaces', 'nord-pack.json')), 'the cached manifest');
  const checkout = checkoutPath(home, 'nord-pack');
  assert.ok(fs.existsSync(path.join(checkout, 'templates/pitch.html')), "and the entry's own files");
  assert.equal(fs.existsSync(path.join(checkout, '.git')), false,
    'a checkout, not a repository — nothing ever pulls into it');
  assert.match(add.stdout, new RegExp(`cloned to ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(add.stdout, new RegExp(repo.commit().slice(0, 7)), 'and says which commit this catalog is');
  assert.equal(loadRegistry(home).marketplaces['nord-pack'].commit, repo.commit());
  assert.deepEqual(fs.readdirSync(path.join(home, 'marketplaces')).filter((f) => f.startsWith('.staging')), [],
    'staging is a moment, not a directory that accumulates');
});

test('installing an entry from a remote marketplace reads the checkout — no second fetch', () => {
  // The bug this closes: the manifest was read one way (a clone, with the
  // caller's credentials) and every artifact another (an anonymous URL), so a
  // private catalog listed correctly and 404'd on every install. A file:// remote
  // makes that impossible to fake — there is no host to fetch the entry from.
  const home = tmp();
  const repo = gitMarketRepo(TEMPLATES, { 'templates/pitch.html': PITCH });
  assert.equal(run(home, 'add', repo.url).status, 0);
  const r = spawnSync('node', [CLI, 'template', 'add', 'pitch@nord-pack'],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(home, 'templates', 'pitch.html'), 'utf8'), PITCH);
});

test('update re-clones: the catalog and the files move together', () => {
  const home = tmp();
  const repo = gitMarketRepo(TEMPLATES, { 'templates/pitch.html': PITCH });
  assert.equal(run(home, 'add', repo.url).status, 0);

  const next = PITCH.replace('Pitch', 'Pitch v2');
  fs.writeFileSync(path.join(repo.dir, 'templates/pitch.html'), next);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'v2'],
    { cwd: repo.dir, stdio: ['ignore', 'pipe', 'pipe'] });

  const up = run(home, 'update', 'nord-pack');
  assert.equal(up.status, 0, up.stderr);
  assert.equal(fs.readFileSync(path.join(checkoutPath(home, 'nord-pack'), 'templates/pitch.html'), 'utf8'), next);
  assert.equal(loadRegistry(home).marketplaces['nord-pack'].commit, repo.commit(), 'the registry follows');
  assert.match(run(home, 'list').stdout, new RegExp(`@${repo.commit().slice(0, 7)}`));
});

test('a failed update keeps BOTH halves of what is on disk — manifest and checkout', () => {
  const home = tmp();
  const repo = gitMarketRepo(TEMPLATES, { 'templates/pitch.html': PITCH });
  assert.equal(run(home, 'add', repo.url).status, 0);
  fs.rmSync(repo.dir, { recursive: true, force: true });   // the source is gone

  const r = run(home, 'update', 'nord-pack');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cached copy is untouched/);
  assert.equal(fs.readFileSync(path.join(checkoutPath(home, 'nord-pack'), 'templates/pitch.html'), 'utf8'), PITCH,
    'a clone is adopted only once it validates, so an install still works after a failed update');
  assert.match(run(home, 'list').stdout, /pitch@nord-pack/);
});

test('remove drops the checkout too — unregistering leaves nothing behind', () => {
  const home = tmp();
  const repo = gitMarketRepo(TEMPLATES, { 'templates/pitch.html': PITCH });
  run(home, 'add', repo.url);
  assert.equal(run(home, 'remove', 'nord-pack').status, 0);
  assert.equal(fs.existsSync(checkoutPath(home, 'nord-pack')), false);
  assert.equal(fs.existsSync(path.join(home, 'marketplaces', 'nord-pack.json')), false);
});

test("an entry's source resolves against the checkout, the local dir, or nothing at all", () => {
  const home = tmp();
  fs.mkdirSync(checkoutPath(home, 'nord-pack'), { recursive: true });
  const at = (source, market) => resolveSource(source, market, home);

  assert.equal(at('./themes/x.css', { name: 'nord-pack', source: 'acme/catalog' }),
    path.join(checkoutPath(home, 'nord-pack'), 'themes/x.css'));
  // an absolute URL entry is still its own address — a gist, a release asset
  assert.equal(at('https://gist.github.com/x.css', { name: 'nord-pack', source: 'acme/catalog' }),
    'https://gist.github.com/x.css');
  // a local marketplace has no checkout: its own directory is the checkout
  const dir = marketRepo(GOOD);
  assert.equal(at('./themes/x.css', { name: 'local-pack', source: dir }), path.join(dir, 'themes/x.css'));
  // registered from a remote source with nothing cloned yet — a named refusal,
  // never a fetch that would only have worked for a public repo
  assert.throws(() => at('./themes/x.css', { name: 'ghost', source: 'acme/catalog' }),
    (e) => e instanceof MarketplaceError && /no local checkout/.test(e.message)
      && /decklight marketplace update ghost/.test(e.message));
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

// ── an engine entry (SPEC ENGINE_UNITS, #267) ──────────────────────────────

const ENGINE = `{
  "name": "voices",
  "entries": [
    { "name": "azure-tts", "type": "engine", "source": "./azure.mjs", "apiVersion": 1, "capability": "tts" }
  ]
}
`;

test('an engine entry validates with an apiVersion and a capability', () => {
  const v = validateManifest(ENGINE);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.manifest.entries[0].capability, 'tts');
});

test('an engine entry with NEITHER field still validates — that is the wizard-declaration shape', () => {
  // `engine` wears one type for two jobs: a unit that carries a module, and a
  // catalog declaring a wizard for an engine decklight already ships
  // (ENGINES#WIZARD, `{name, type, source, wizard}`). The second has no
  // contract version and no capability, and making them mandatory here would
  // invalidate its whole catalog — so the absence is refused at INSTALL
  // instead (test/units.test.mjs), where only a real unit reaches it.
  for (const drop of [', "apiVersion": 1', ', "capability": "tts"']) {
    assert.equal(validateManifest(ENGINE.replace(drop, '')).ok, true, `dropping ${drop} must still validate`);
  }
  const wizardOnly = `{ "name": "voices", "entries": [
    { "name": "elevenlabs", "type": "engine", "source": "./e.mjs" } ] }`;
  assert.equal(validateManifest(wizardOnly).ok, true);
});

test('an engine capability is checked for SHAPE only — a kind this decklight cannot run stays addable', () => {
  // The refusal belongs at LOAD time (test/loader.test.mjs), where it can name
  // the one engine; refusing here would invalidate the whole catalog and take
  // its themes down with it.
  const unknown = ENGINE.replace('"capability": "tts"', '"capability": "transcription"');
  assert.equal(validateManifest(unknown).ok, true);
  assert.equal(ENGINE_CAPABILITIES.includes('transcription'), false, 'and this decklight does NOT run it');
  // the two it DOES run, so a future third does not silently widen the gate
  assert.deepEqual(ENGINE_CAPABILITIES, ['tts', 'lipsync']);

  const ahead = ENGINE.replace('"apiVersion": 1', `"apiVersion": ${ENGINE_API_VERSION + 10}`);
  assert.equal(validateManifest(ahead).ok, true);
});

test('a malformed capability is refused, not silently coerced', () => {
  for (const bad of ['""', '"TTS"', '"9lives"', '42', 'null']) {
    const v = validateManifest(ENGINE.replace('"capability": "tts"', `"capability": ${bad}`));
    assert.equal(v.ok, false, `capability: ${bad} should not validate`);
    assert.match(v.errors.find((x) => x.field === 'entries[0].capability').msg, /affordance/);
  }
});

test('engine stopped being a kind nothing installs — the hint names a real command', () => {
  // It was `null`, which marketplace.mjs documents as "real but nothing
  // installs it here yet" (#267 is what changed that).
  assert.match(INSTALL_HINT.engine, /decklight engine add/);
});
