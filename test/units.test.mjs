// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The unit library — templates, agent skills and import adapters
// (MARKETPLACE.md UNITS#REST), all three over one install seam in cli/units.mjs.
//
// Two properties get most of the attention here, because they are the ones a
// refactor would quietly break:
//
//   OFFLINE. Registering is not fetching (SPEC MARKETPLACE_REGISTRY). Every
//   lookup on the `init` and `import` paths reads the cache, so those tests
//   run with fetch replaced by a throw — not to check for an error message,
//   but to prove the call is never made.
//
//   ALL OR NOTHING. An install fetches everything before it writes anything,
//   so a refusal or a dropped connection leaves the library as it was. A
//   half-installed unit is worse than a missing one, because it looks present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNIT_TYPES, unitDir, unitPath, listUnits, findUnit, catalogEntries,
  catalogEntriesOfType, adapterFor, installUnit, removeUnit, UnitError,
  installedVoices,
} from '../cli/units.mjs';
import { validateManifest, KNOWN_TYPES, INSTALL_HINT } from '../cli/marketplace.mjs';
import { templateDeck, titleTemplate } from '../cli/init.mjs';
import { adapterOffer } from '../cli/import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const tmp = (p) => mkdtempSync(path.join(tmpdir(), `decklight-${p}-`));

const TEMPLATE_HTML = `<!doctype html><html><head><title>Pitch</title></head>
<body><div class="decklight"><section><h1>Pitch</h1></section></div></body></html>`;

const ENTRIES = [
  { name: 'startup-pitch', type: 'template', source: 'templates/startup-pitch.html', description: 'a 10-slide pitch' },
  { name: 'note-taking', type: 'skill', source: 'skills/note-taking' },
  { name: 'marp-import', type: 'importer', source: 'importers/marp', extensions: ['.marp', '.md'], apiVersion: 1 },
];

/** A local marketplace on disk, registered into a fresh config home. */
function market({ entries = ENTRIES, home = tmp('units-home') } = {}) {
  const root = tmp('units-market');
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'),
    JSON.stringify({ name: 'cat', entries }, null, 2));

  mkdirSync(path.join(root, 'templates'), { recursive: true });
  writeFileSync(path.join(root, 'templates/startup-pitch.html'), TEMPLATE_HTML);
  mkdirSync(path.join(root, 'skills/note-taking'), { recursive: true });
  writeFileSync(path.join(root, 'skills/note-taking/SKILL.md'), '# Note taking\n');
  writeFileSync(path.join(root, 'skills/note-taking/reference.md'), 'reference\n');
  mkdirSync(path.join(root, 'importers/marp'), { recursive: true });
  // A real default export (EXTENSIONS_ADAPTERS): bytes in, one HTML string of
  // section markup out — enough for the execution tests below to prove the
  // adapter actually ran, not merely that it installed.
  writeFileSync(path.join(root, 'importers/marp/importer.mjs'),
    'export default async function importAdapter(bytes) {\n'
    + '  const body = bytes.toString("utf8").trim();\n'
    + '  return body.split(/\\n(?=# )/).map((chunk) => {\n'
    + '    const [heading, ...rest] = chunk.split("\\n");\n'
    + '    return `<section><h2>${heading.replace(/^#\\s*/, "")}</h2>${rest.join(" ").trim()}</section>`;\n'
    + '  }).join("\\n");\n'
    + '}\n');

  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { home, root, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

const run = (args, home, cwd) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args],
        { encoding: 'utf8', cwd, env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

/** A fetch that fails the test if it is ever called. */
const noNetwork = () => { throw new Error('the network was touched on an offline path'); };

/** Like `run`, but combines stdout+stderr regardless of exit code — `import`'s
 *  own success summary is printed to stderr (piped output stays clean), which
 *  `run`'s stdout-only success case would otherwise miss. */
const runCombined = (args, home, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, DECKLIGHT_HOME: home } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

// ── the declared shapes ────────────────────────────────────────────────────

test('an importer entry must declare the extensions it reads', () => {
  // Not decoration: it is what lets `import talk.marp` name the adapter from
  // the cache alone, with no network.
  const bad = validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'marp-import', type: 'importer', source: 'a/b' }],
  }, null, 2));
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'entries[0].extensions');
  assert.match(bad.errors[0].msg, /missing/);
  assert.ok(bad.errors[0].line > 1, 'the error carries the line, like every other manifest error');

  const good = validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'marp-import', type: 'importer', source: 'a/b', extensions: ['.marp'], apiVersion: 1 }],
  }));
  assert.ok(good.ok, JSON.stringify(good.errors));
});

test('extensions must actually be extensions', () => {
  for (const bad of [[], 'marp', [''], ['../etc/passwd'], [4]]) {
    const v = validateManifest(JSON.stringify({
      name: 'cat', entries: [{ name: 'x', type: 'importer', source: 'a', extensions: bad, apiVersion: 1 }],
    }));
    assert.equal(v.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.ok(validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'x', type: 'importer', source: 'a', extensions: ['marp', '.MD'], apiVersion: 1 }],
  })).ok, 'a leading dot is optional and case does not matter');
});

test('an importer entry must declare apiVersion — a v1 adapter is Node code too', () => {
  const bad = validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'marp-import', type: 'importer', source: 'a/b', extensions: ['.marp'] }],
  }, null, 2));
  assert.equal(bad.ok, false);
  const e = bad.errors.find((x) => x.field === 'entries[0].apiVersion');
  assert.ok(e, 'apiVersion missing must be its own named error');
  assert.match(e.msg, /positive integer/);
});

test('an unknown kind is accepted, not refused', () => {
  // A catalog is a file someone else wrote, possibly against a newer
  // decklight. Refusing the whole manifest over one unrecognised kind would
  // make every catalog un-addable the day it grows an entry.
  const v = validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'x', type: 'hologram', source: 'a' }],
  }));
  assert.ok(v.ok);
  assert.ok(!KNOWN_TYPES.includes('hologram'));
});

// ── voices: a reference, never a payload (SPEC VOICE_UNITS) ────────────────

test('a voice entry names an engine and one of its voices', () => {
  const bad = validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'anna', type: 'voice' }],
  }, null, 2));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(),
    ['entries[0].engine', 'entries[0].voiceId']);

  assert.ok(validateManifest(JSON.stringify({
    name: 'cat', entries: [{ name: 'anna', type: 'voice', engine: 'elevenlabs', voiceId: 'v1' }],
  })).ok);
});

test('a voice entry with a source is REFUSED — that is the whole enforcement', () => {
  // The policy is a shape, not an attestation: `source` is the one field
  // through which a cloned voice could arrive as bytes, so it does not exist
  // for this kind. Ignoring it would still let a catalog carry a model that
  // merely never loads.
  const v = validateManifest(JSON.stringify({
    name: 'cat',
    entries: [{ name: 'anna', type: 'voice', engine: 'elevenlabs', voiceId: 'v1', source: 'voices/anna.onnx' }],
  }, null, 2));
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, 'entries[0].source');
  assert.match(v.errors[0].msg, /does not carry one/);
  assert.match(v.errors[0].msg, /VOICE_UNITS/);
});

test('installing a voice fetches NOTHING, and works with no network at all', async () => {
  const m = market({
    entries: [{
      name: 'narrator-anna', type: 'voice', engine: 'elevenlabs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL', label: 'Anna', description: 'a calm narrator',
    }],
  });
  try {
    // fetchImpl throws on any call: the reference path must return before the
    // fetch is REACHABLE, not merely skip it behind a flag.
    const done = await installUnit('voice', 'narrator-anna', m.home, { fetchImpl: noNetwork });
    assert.deepEqual(done.files, [], 'a voice install writes no artifact files');

    const ref = JSON.parse(readFileSync(done.path, 'utf8'));
    assert.equal(ref.engine, 'elevenlabs');
    assert.equal(ref.voiceId, 'EXAVITQu4vr4xnSDxMaL');
    assert.equal(ref.marketplace, 'cat', 'the pointer remembers where it came from');
    assert.ok(!('source' in ref), 'nothing that looks like a payload survives into the library');
    assert.equal(path.extname(done.path), '.json');
  } finally { m.cleanup(); }
});

test('installed voices are offered only on the engine they name', () => {
  const home = tmp('voices-home');
  try {
    mkdirSync(unitDir('voice', home), { recursive: true });
    const put = (name, body) => writeFileSync(unitPath('voice', name, home), body);
    put('anna', JSON.stringify({ name: 'anna', engine: 'elevenlabs', voiceId: 'v1', label: 'Anna', marketplace: 'cat' }));
    put('bob', JSON.stringify({ name: 'bob', engine: 'gemini', voiceId: 'Puck' }));
    put('broken', '{ not json');
    put('idless', JSON.stringify({ name: 'idless', engine: 'elevenlabs' }));

    const eleven = installedVoices('elevenlabs', home);
    assert.deepEqual(eleven.map((v) => v.name), ['anna'],
      'a reference is only an answer on the engine it names, and a broken pointer costs the roster nothing');
    assert.equal(eleven[0].label, 'Anna');
    assert.deepEqual(installedVoices('gemini', home).map((v) => v.label), ['bob'],
      'a voice with no label falls back to its name');
    assert.deepEqual(installedVoices('', home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('voice add refuses a catalog entry of another kind, like every other unit', async () => {
  const m = market();
  try {
    await assert.rejects(() => installUnit('voice', 'startup-pitch', m.home, { fetchImpl: noNetwork }),
      (e) => e instanceof UnitError && /is a template, not a voice/.test(e.message));
  } finally { m.cleanup(); }
});

test('every installable type has an install hint, and every hint a real command', () => {
  for (const type of Object.keys(UNIT_TYPES)) {
    assert.ok(INSTALL_HINT[type], `${type} needs a hint — marketplace list prints it`);
  }
  // The kinds with a null hint are real but installed elsewhere or not yet;
  // that distinction is the whole point of listing them at all.
  assert.ok(INSTALL_HINT.transform, 'transforms install now that EXTENSIONS#LOADER runs them');
  assert.ok(INSTALL_HINT.voice, 'voices install now that VOICE_UNITS settled likeness and consent');
});

test('marketplace list groups entries by kind and names how to install each', () => {
  const m = market();
  const { out } = run(['marketplace', 'list'], m.home);
  assert.match(out, /template {2}—/, 'kinds are headings');
  assert.match(out, /decklight template add <name>/);
  assert.match(out, /decklight importer add <name>/);
  // The entry sits under its kind, not in a flat list.
  assert.match(out, /template.*\n\s+startup-pitch@cat/);
  m.cleanup();
});

test('marketplace list marks a kind this decklight cannot install', () => {
  const m = market({ entries: [{ name: 'x', type: 'hologram', source: 'a' }] });
  const { out } = run(['marketplace', 'list'], m.home);
  assert.match(out, /hologram \(this decklight does not install this kind\)/);
  m.cleanup();
});

// ── the library ────────────────────────────────────────────────────────────

test('each type lands in its own directory, single-file or not', async () => {
  const m = market();
  await installUnit('template', 'startup-pitch', m.home);
  await installUnit('skill', 'note-taking', m.home);

  assert.equal(unitPath('template', 'startup-pitch', m.home), path.join(m.home, 'templates/startup-pitch.html'));
  assert.equal(unitPath('skill', 'note-taking', m.home), path.join(m.home, 'skills/note-taking'));
  assert.equal(readFileSync(unitPath('template', 'startup-pitch', m.home), 'utf8'), TEMPLATE_HTML);
  assert.ok(existsSync(path.join(m.home, 'skills/note-taking/SKILL.md')));
  assert.ok(existsSync(path.join(m.home, 'skills/note-taking/reference.md')), 'an optional file is taken when present');

  assert.deepEqual(listUnits('template', m.home).map((u) => u.name), ['startup-pitch']);
  assert.deepEqual(listUnits('importer', m.home), [], 'an absent directory is empty, not an error');
  m.cleanup();
});

test('installing the wrong kind is refused, and names the right command', async () => {
  const m = market();
  await assert.rejects(() => installUnit('template', 'marp-import', m.home), (e) => {
    assert.ok(e instanceof UnitError);
    assert.match(e.message, /is a importer, not a template/);
    assert.match(e.message, /decklight importer add marp-import/);
    return true;
  });
  assert.equal(listUnits('template', m.home).length, 0, 'nothing was written');
  m.cleanup();
});

test('a failed fetch writes nothing at all', async () => {
  const m = market({
    entries: [{ name: 'note-taking', type: 'skill', source: 'skills/gone' }],
  });
  await assert.rejects(() => installUnit('skill', 'note-taking', m.home), /no such file/);
  assert.ok(!existsSync(unitPath('skill', 'note-taking', m.home)),
    'a half-installed unit is worse than a missing one — it looks present');
  m.cleanup();
});

test('remove takes a unit away, and refuses one that is not there', async () => {
  const m = market();
  await installUnit('template', 'startup-pitch', m.home);
  removeUnit('template', 'startup-pitch', m.home);
  assert.equal(findUnit('template', 'startup-pitch', m.home), null);
  assert.throws(() => removeUnit('template', 'startup-pitch', m.home), /no template "startup-pitch" installed/);
  m.cleanup();
});

test('installing needs a FETCHED catalog, and says registering is not that', async () => {
  const home = tmp('units-bare');
  await assert.rejects(() => installUnit('template', 'anything', home), (e) => {
    assert.match(e.message, /registering is not fetching/);
    return true;
  });
  rmSync(home, { recursive: true, force: true });
});

// ── offline: the lookups never reach the network ───────────────────────────

test('catalog lookups read the cache and never fetch', () => {
  const m = market();
  const saved = globalThis.fetch;
  globalThis.fetch = noNetwork;
  try {
    assert.equal(catalogEntries(m.home).length, ENTRIES.length);
    assert.deepEqual(catalogEntriesOfType('template', m.home).map((e) => e.qualified), ['startup-pitch@cat']);
    assert.equal(adapterFor('.marp', m.home).name, 'marp-import');
    assert.equal(findUnit('template', 'startup-pitch', m.home), null);
    assert.deepEqual(listUnits('skill', m.home), []);
  } finally { globalThis.fetch = saved; }
  m.cleanup();
});

test('adapterFor matches on extension, case and dot insensitively', () => {
  const m = market();
  for (const ext of ['.marp', '.MARP', '.md']) {
    assert.equal(adapterFor(ext, m.home)?.name, 'marp-import', ext);
  }
  assert.equal(adapterFor('.pptx', m.home), null, 'a format decklight reads itself has no adapter');
  assert.equal(adapterFor('', m.home), null);
  m.cleanup();
});

// ── templates on the init path ─────────────────────────────────────────────

const lookTemplate = (name, home) => templateDeck(name, {
  home,
  listInstalled: (n, h) => findUnit('template', n, h),
  offered: (h) => catalogEntriesOfType('template', h),
});

test('templateDeck returns the refusal rather than ending the process', () => {
  const m = market();
  const offeredOnly = lookTemplate('startup-pitch', m.home);
  assert.equal(offeredOnly.ok, false);
  assert.match(offeredOnly.message, /decklight template add startup-pitch@cat/);
  assert.match(offeredOnly.message, /init does not\n {2}reach the network/);

  const nowhere = lookTemplate('no-such-thing', m.home);
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.message, /no registered marketplace offers one/);
  assert.match(nowhere.message, /available: startup-pitch@cat/, 'it names what there IS');
  m.cleanup();
});

test('templateDeck reads an installed template', async () => {
  const m = market();
  await installUnit('template', 'startup-pitch', m.home);
  const got = lookTemplate('startup-pitch', m.home);
  assert.equal(got.ok, true);
  assert.equal(got.html, TEMPLATE_HTML);
  m.cleanup();
});

test('titleTemplate replaces the title and first h1, and nothing else', () => {
  const out = titleTemplate(TEMPLATE_HTML, 'Acme Seed Round');
  assert.match(out, /<title>Acme Seed Round<\/title>/);
  assert.match(out, /<h1>Acme Seed Round<\/h1>/);
  assert.match(out, /class="decklight"/, 'the template is otherwise untouched');
});

test('titleTemplate escapes, and survives a title full of $ patterns', () => {
  // A string replacement would expand $& into the matched text. The & is then
  // HTML-escaped like any other, which is why this reads $&amp; and not $&.
  // Expansion would have spliced "<title>Pitch</title>" back in where $& is.
  const dollars = titleTemplate(TEMPLATE_HTML, '$& $1 $`');
  assert.match(dollars, /<title>\$&amp; \$1 \$`<\/title>/);
  assert.doesNotMatch(dollars, /Pitch/);
  assert.match(titleTemplate(TEMPLATE_HTML, '<script>x</script>'), /<title>&lt;script&gt;/);
});

test('titleTemplate leaves a template with no h1 alone', () => {
  const noH1 = '<!doctype html><title>Kept</title><body><section><h2>Only</h2></section>';
  const out = titleTemplate(noH1, 'New');
  assert.match(out, /<title>New<\/title>/);
  assert.match(out, /<h2>Only<\/h2>/);
});

test('init --from scaffolds the installed template, end to end', async () => {
  const m = market();
  const work = tmp('units-work');
  await installUnit('template', 'startup-pitch', m.home);

  const { code, out } = run(['init', 'Acme Seed Round', '--from', 'startup-pitch', '--no-skill', '--no-git'], m.home, work);
  assert.equal(code, 0, out);
  const deck = readFileSync(path.join(work, 'deck.html'), 'utf8');
  assert.match(deck, /<h1>Acme Seed Round<\/h1>/);
  assert.match(deck, /from template startup-pitch/.test(out) ? /.*/ : /never/, 'the note says where it came from');
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

test('init --from names the install command when the template is only offered', () => {
  const m = market();
  const work = tmp('units-work2');
  const { code, out } = run(['init', 'X', '--from', 'startup-pitch', '--no-skill', '--no-git'], m.home, work);
  assert.equal(code, 1);
  assert.match(out, /decklight template add startup-pitch@cat/);
  assert.ok(!existsSync(path.join(work, 'deck.html')), 'nothing was scaffolded');
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

test('init --from and --themes are mutually exclusive', () => {
  const m = market();
  const work = tmp('units-work3');
  const { code, out } = run(['init', 'X', '--from', 'p', '--themes', 'aurora', '--no-skill', '--no-git'], m.home, work);
  assert.equal(code, 1);
  assert.match(out, /mutually exclusive/);
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

test('init without --from is exactly what it was', () => {
  const m = market();
  const work = tmp('units-work4');
  const { code } = run(['init', 'Plain', '--no-skill', '--no-git'], m.home, work);
  assert.equal(code, 0);
  const deck = readFileSync(path.join(work, 'deck.html'), 'utf8');
  assert.match(deck, /data-decklight-runtime="js"/, 'the starter deck still inlines the runtime');
  assert.match(deck, /<h1>Plain<\/h1>/);
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

// ── importers on the import path ───────────────────────────────────────────

test('import names the adapter for an extension it cannot read', async () => {
  const m = market();
  const lines = (await adapterOffer('talk.marp', { home: m.home })).join('\n');
  assert.match(lines, /don't know how to read talk\.marp/);
  assert.match(lines, /no adapter for \.marp — marp-import@cat reads it/);
  assert.match(lines, /decklight importer add marp-import@cat/);
  m.cleanup();
});

test('an installed adapter actually runs — decklight import produces a deck (EXTENSIONS#ADAPTEREXEC)', async () => {
  const m = market();
  await installUnit('importer', 'marp-import', m.home);
  const work = tmp('units-adapter-run');
  const src = path.join(work, 'talk.marp');
  writeFileSync(src, '# Slide one\n\nfirst body\n\n# Slide two\n\nsecond body\n');
  try {
    const { code, out } = runCombined(['import', src], m.home, work);
    assert.equal(code, 0, out);
    assert.match(out, /reading talk\.marp with marp-import/);
    assert.match(out, /2 slide\(s\).*imported via marp-import/);
    const deck = readFileSync(path.join(work, 'talk.html'), 'utf8');
    assert.match(deck, /<section><h2>Slide one<\/h2>first body<\/section>/);
    assert.match(deck, /<section><h2>Slide two<\/h2>second body<\/section>/);
    assert.match(deck, /data-decklight-runtime="js"/, 'still the standard init output shape');
  } finally { rmSync(work, { recursive: true, force: true }); m.cleanup(); }
});

test('an installed adapter that fails its own contract is refused cleanly, not left half-written', async () => {
  const m = market({
    entries: [{ name: 'broken-import', type: 'importer', source: 'importers/broken', extensions: ['.marp'], apiVersion: 1 }],
  });
  mkdirSync(path.join(m.root, 'importers/broken'), { recursive: true });
  writeFileSync(path.join(m.root, 'importers/broken/importer.mjs'),
    'export default async function importAdapter() { throw new Error("bad markup"); }\n');
  await installUnit('importer', 'broken-import', m.home);
  const work = tmp('units-adapter-throws');
  const src = path.join(work, 'talk.marp');
  writeFileSync(src, '# Slide one\n');
  try {
    const { code, out } = runCombined(['import', src], m.home, work);
    assert.equal(code, 1, out);
    assert.match(out, /importer "broken-import" threw: bad markup/);
    assert.ok(!existsSync(path.join(work, 'talk.html')), 'nothing was written');
  } finally { rmSync(work, { recursive: true, force: true }); m.cleanup(); }
});

test('with nothing cached, import says exactly what it always said', async () => {
  const home = tmp('units-offline');
  const saved = globalThis.fetch;
  globalThis.fetch = noNetwork;
  try {
    const lines = await adapterOffer('talk.marp', { home });
    assert.deepEqual(lines, [
      "decklight import: don't know how to read talk.marp",
      '  supported: .pptx, .key (macOS), or a Google Slides URL',
    ], 'no command that worked offline starts needing the network');
  } finally { globalThis.fetch = saved; }
  rmSync(home, { recursive: true, force: true });
});

test('a file with no extension gets no adapter talk', async () => {
  const m = market();
  const lines = await adapterOffer('Makefile', { home: m.home });
  assert.equal(lines.length, 2);
  m.cleanup();
});

// ── skills sit alongside the authoring skill ───────────────────────────────

test('a marketplace skill installs without touching the authoring skill', () => {
  const m = market();
  const work = tmp('units-skills');
  assert.equal(run(['skills', 'claude', '--dir', '.'], m.home, work).code, 0);
  assert.equal(run(['skills', 'add', 'note-taking'], m.home, work).code, 0);

  assert.ok(existsSync(path.join(work, '.claude/skills/decklight/SKILL.md')),
    'the authoring skill is where it always was');
  assert.ok(existsSync(path.join(m.home, 'skills/note-taking/SKILL.md')),
    'the marketplace skill is in the library, a different place entirely');

  // And re-running the authoring install does not disturb the other one.
  assert.equal(run(['skills', 'claude', '--dir', '.', '--force'], m.home, work).code, 0);
  assert.ok(existsSync(path.join(m.home, 'skills/note-taking/SKILL.md')));
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

test('skills still installs for a named agent, and add/list/remove do not shadow one', () => {
  const m = market();
  const work = tmp('units-skills2');
  assert.equal(run(['skills', 'list'], m.home, work).code, 0, 'list is a subcommand');
  const bad = run(['skills', 'nosuchagent'], m.home, work);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /unknown agent/, 'a non-verb positional is still an agent name');
  rmSync(work, { recursive: true, force: true });
  m.cleanup();
});

// ── the shared command ─────────────────────────────────────────────────────

test('template list shows installed and offered separately', async () => {
  const m = market();
  let { out } = run(['template', 'list'], m.home);
  assert.match(out, /available \(decklight template add <name>\)/);
  assert.match(out, /startup-pitch@cat/);

  await installUnit('template', 'startup-pitch', m.home);
  ({ out } = run(['template', 'list'], m.home));
  assert.match(out, /^startup-pitch/m, 'installed units lead');
  assert.doesNotMatch(out, /available/, 'nothing left to offer');
  m.cleanup();
});

test('every unit command shares one help shape', () => {
  for (const type of Object.keys(UNIT_TYPES)) {
    const { out } = run([type === 'skill' ? 'skills' : type, '--help'], tmp('units-help'));
    if (type === 'skill') continue; // `skills --help` is the agent command's own
    assert.match(out, new RegExp(`decklight ${type} <add\\|list\\|remove>`));
    assert.match(out, /registering a marketplace is not fetching/i);
  }
});

test('unknown subcommands and missing names are refused, not crashed', () => {
  const home = tmp('units-bad');
  assert.equal(run(['template', 'frobnicate'], home).code, 1);
  assert.equal(run(['template', 'add'], home).code, 1);
  assert.equal(run(['importer', 'remove'], home).code, 1);
  assert.match(run(['template', 'frobnicate'], home).out, /unknown subcommand/);
  rmSync(home, { recursive: true, force: true });
});
