// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Presenter-library plugins (MARKETPLACE.md PRESENT#PLUGINS).
//
// The claim that matters is not "a plugin can add a timer" — it is everything
// a plugin CANNOT do, and everything that stays unchanged when one is
// installed. So most of this asserts absence: the label does not grow, the
// policy does not widen, no route appears, and a deck with no plugins is
// served byte for byte as before.
//
// The structural half of the scope rule — that a plugin's code physically
// cannot reach a slide — is not testable here, because it is a browser
// property rather than a string property. test/plugin-render.mjs proves it in
// a real Chrome against a real bundled deck, with a hostile plugin smuggled
// past both checks below. These tests cover the parts that ARE strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

import {
  SLOTS, NEEDS, MANIFEST_KEYS, validateManifest, readManifest, pluginLint,
  loadPlugin, loadLibrary, chromeMarkup, injectChrome, pluginsDir, PluginError,
} from '../cli/plugin.mjs';
import { CSP } from '../cli/present.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const DECK = `<!doctype html>
<html><head></head><body>
  <div class="decklight"><div class="decklight-stage"><section><h2>Alpha</h2>
    <aside class="notes">the quiet part</aside></section></div></div>
  <script>Decklight.init()</script>
</body></html>
`;

const GOOD_MANIFEST = { name: 'timer', slot: 'corner-br', needs: ['position'], version: '1.0.0' };
const GOOD_SOURCE = 'decklight.on(function (s) { document.body.textContent = s.elapsed; });';

const tmp = (prefix) => {
  const d = mkdtempSync(path.join(tmpdir(), `decklight-${prefix}-`));
  return d;
};

/** A config home with `plugins` installed into it. */
function homeWith(plugins) {
  const home = tmp('plugin-home');
  for (const [name, { manifest, source }] of Object.entries(plugins)) {
    const dir = path.join(pluginsDir(home), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(dir, 'plugin.js'), source);
  }
  return home;
}

// ── the manifest vocabulary, and the refusal that names why ────────────────

test('a manifest asking for slide content is refused, and the refusal says why', () => {
  for (const asked of ['slides', 'dom', 'content', 'document']) {
    const v = validateManifest({ ...GOOD_MANIFEST, needs: [asked] });
    assert.equal(v.ok, false, `needs: ["${asked}"] must be refused`);
    const [e] = v.errors;
    assert.equal(e.field, 'needs');
    assert.match(e.msg, /chrome only/, 'the refusal names the rule');
    assert.match(e.msg, /deterministic artifact/, 'the refusal names the reason');
    assert.match(e.msg, new RegExp(asked), 'the refusal names what was asked for');
  }
});

test('needs is a closed vocabulary', () => {
  for (const n of NEEDS) assert.ok(validateManifest({ ...GOOD_MANIFEST, needs: [n] }).ok, n);
  assert.equal(validateManifest({ ...GOOD_MANIFEST, needs: ['position', 'slides'] }).ok, false,
    'one bad entry among good ones is still refused');
});

test('an unknown manifest key is refused, never ignored', () => {
  // ENGINES#WIZARD's rule: a silently dropped key is a plugin asking for less
  // than its author believed it was asking for.
  const v = validateManifest({ ...GOOD_MANIFEST, capabilities: ['everything'] });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, 'capabilities');
  assert.match(v.errors[0].msg, /unknown key/);
  assert.match(v.errors[0].msg, new RegExp(MANIFEST_KEYS[0]), 'it lists what IS allowed');
});

test('slot is a closed vocabulary, so a plugin cannot place itself over the slides', () => {
  for (const slot of SLOTS) assert.ok(validateManifest({ ...GOOD_MANIFEST, slot }).ok, slot);
  const v = validateManifest({ ...GOOD_MANIFEST, slot: 'fullscreen' });
  assert.equal(v.ok, false);
  assert.match(v.errors[0].msg, /closed/);
});

test('a frame cannot be sized to cover the deck', () => {
  assert.ok(validateManifest({ ...GOOD_MANIFEST, width: 400, height: 300 }).ok);
  for (const big of [{ width: 4000 }, { height: 2000 }]) {
    const v = validateManifest({ ...GOOD_MANIFEST, ...big });
    assert.equal(v.ok, false);
    assert.match(v.errors[0].msg, /cover over the slides/);
  }
});

test('a manifest defaults to position only — notes are never implicit', () => {
  const v = validateManifest({ name: 'timer', slot: 'corner-br' });
  assert.ok(v.ok);
  assert.deepEqual(v.manifest.needs, ['position']);
  assert.equal(v.manifest.title, 'timer');
});

test('a manifest whose name disagrees with its directory is refused', () => {
  const v = validateManifest({ ...GOOD_MANIFEST, name: 'other' }, { name: 'timer' });
  assert.equal(v.ok, false);
  assert.match(v.errors[0].msg, /does not match the directory/);
});

test('unparseable JSON is a field error, not a stack', () => {
  const v = readManifest('{ "name": "timer", }');
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].field, '(json)');
});

// ── the lint, which is a courtesy and not the boundary ─────────────────────

test('the lint names a reach outside the frame, with its line', () => {
  const src = 'var a = 1;\nvar t = parent.document.title;\n';
  const [hit] = pluginLint(src);
  assert.equal(hit.line, 2);
  assert.match(hit.why, /parent document/);
});

test('the lint passes chrome that stays in its frame', () => {
  assert.deepEqual(pluginLint(GOOD_SOURCE), []);
  assert.deepEqual(pluginLint('document.querySelector("#mine").textContent = "hi";'), []);
});

test('loadPlugin refuses a reaching plugin and explains where it actually runs', () => {
  const home = homeWith({ grabby: { manifest: { name: 'grabby', slot: 'corner-tl' }, source: 'parent.document.body.remove();' } });
  assert.throws(() => loadPlugin(path.join(pluginsDir(home), 'grabby')), (e) => {
    assert.ok(e instanceof PluginError);
    assert.match(e.message, /sandboxed frame with an opaque origin/);
    assert.match(e.message, /needs: \["position", "notes"\]/);
    return true;
  });
  rmTemp(home);
});

// ── the library ────────────────────────────────────────────────────────────

test('a broken plugin is skipped with a reason, never fatal', () => {
  // The PRESENT#STRICT argument: nothing about a timer should cost someone
  // their talk ten minutes before they give it.
  const home = homeWith({
    timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE },
    grabby: { manifest: { name: 'grabby', slot: 'corner-tl' }, source: 'parent.document.title;' },
    bogus: { manifest: { name: 'bogus', slot: 'nowhere' }, source: '' },
  });
  const { plugins, refused } = loadLibrary(home);
  assert.deepEqual(plugins.map((p) => p.name), ['timer']);
  assert.deepEqual(refused.map((r) => r.name).sort(), ['bogus', 'grabby']);
  rmTemp(home);
});

test('an empty or absent library is empty, not an error', () => {
  assert.deepEqual(loadLibrary(tmp('plugin-empty')), { plugins: [], refused: [] });
});

// ── the markup ─────────────────────────────────────────────────────────────

const one = (over = {}) => ({
  name: 'timer', title: 'Timer', slot: 'corner-br', needs: ['position'],
  width: 200, height: 96, source: GOOD_SOURCE, ...over,
});

test('the frame is sandboxed WITHOUT allow-same-origin', () => {
  // The single attribute the whole ticket rests on. allow-same-origin here
  // would hand the plugin the deck's document and undo everything.
  const html = chromeMarkup([one()]);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test('a plugin is embedded as srcdoc — no route to fetch it from', () => {
  const html = chromeMarkup([one()]);
  assert.match(html, /srcdoc="/);
  assert.doesNotMatch(html, /<iframe[^>]*\ssrc=/, 'no src attribute means no request means no route');
});

test('a plugin source with quotes and script tags survives the attribute', () => {
  const nasty = `var s = "he said \\"hi\\"";\nvar t = '</script><img src=x onerror=alert(1)>';`;
  const html = chromeMarkup([one({ source: nasty })]);
  // Every quote inside srcdoc is escaped, so the attribute cannot be closed
  // early and the payload cannot break out into the deck's document.
  const srcdoc = /srcdoc="([^"]*)"/.exec(html);
  assert.ok(srcdoc, 'the srcdoc attribute is well formed and closes exactly once');
  assert.match(srcdoc[1], /&quot;/, 'quotes are entities, so the attribute cannot be closed early');
  assert.doesNotMatch(srcdoc[1], /[<>]/, 'no raw angle brackets to be mistaken for markup');
  // Outside the one attribute, none of the payload exists at all.
  const outside = html.replace(/srcdoc="[^"]*"/g, 'srcdoc=""');
  assert.doesNotMatch(outside, /<img|onerror|he said/, 'the payload never lands in the deck as markup');
});

test('only a plugin that declared notes is named to the host as reading them', () => {
  const html = chromeMarkup([one(), one({ name: 'prompter', needs: ['position', 'notes'] })]);
  assert.match(html, /var notes=\["prompter"\]/, 'the timer is not in the notes list');
});

test('no plugins means no markup at all', () => {
  assert.equal(chromeMarkup([]), '');
});

test('injectChrome with no plugins returns its input byte for byte', () => {
  // The acceptance criterion: present with nothing installed behaves exactly
  // as it did before this feature existed.
  assert.equal(injectChrome(DECK, []), DECK);
});

test('the chrome splices before the LAST </body>', () => {
  // A bundled deck carries the string twice — the inlined runtime has one in
  // its own source — and splicing at the first corrupts the engine.
  const doubled = `<script>var s = "</body>";</script>\n${DECK}`;
  const out = injectChrome(doubled, [one()]);
  assert.match(out, /decklight-chrome[\s\S]*<\/body>\s*<\/html>/);
  assert.equal(out.indexOf('decklight-chrome') > out.indexOf('var s ='), true);
});

// ── present: what must not change ──────────────────────────────────────────

function deckDir() {
  const dir = tmp('plugin-present');
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  return dir;
}

async function startPresent(t, dir, home, extraArgs = []) {
  const child = spawn(process.execPath, [CLI, 'present', 'talk.html', '--port', '0', ...extraArgs],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
  t.after(() => { child.kill('SIGKILL'); rmTemp(dir); rmTemp(home); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('present exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout waiting for present:\n' + out)); }, 10000);
  });
  return { base, log: () => out };
}

test('with no plugins installed the deck is served byte for byte', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir, tmp('plugin-empty-home'));
  assert.equal(await (await fetch(base + '/')).text(), DECK);
});

test('an installed plugin reaches the deck as chrome, and the deck is untouched', async (t) => {
  const dir = deckDir();
  const home = homeWith({ timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE } });
  const { base, log } = await startPresent(t, dir, home);

  const served = await (await fetch(base + '/')).text();
  assert.match(served, /decklight-chrome/, 'the chrome is there');
  assert.match(served, /sandbox="allow-scripts"/);
  assert.ok(served.startsWith(DECK.slice(0, DECK.indexOf('</body>'))),
    'every byte of the deck is still there, in order, ahead of the chrome');
  assert.equal(readFileSync(path.join(dir, 'talk.html'), 'utf8'), DECK, 'the file on disk is untouched');
  assert.match(log(), /chrome: timer \(corner-br\) — yours, not in the deck/);
});

test('--no-plugins presents without the library', async (t) => {
  const dir = deckDir();
  const home = homeWith({ timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE } });
  const { base } = await startPresent(t, dir, home, ['--no-plugins']);
  assert.equal(await (await fetch(base + '/')).text(), DECK);
});

test('a plugin does not widen the CSP or register a route', async (t) => {
  const dir = deckDir();
  const home = homeWith({ timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE } });
  const { base } = await startPresent(t, dir, home);

  const res = await fetch(base + '/');
  assert.equal(res.headers.get('content-security-policy'), CSP,
    'the policy is the same string a deck with no plugins is served under');

  // A plugin is srcdoc, so there is nothing to serve it from. These paths are
  // as unknown as any other — the same answer /anything gets.
  for (const p of ['/plugin/timer', '/plugins/timer/plugin.js', '/plugin/timer/plugin.json']) {
    assert.equal((await fetch(base + p)).status, 404, `${p} is not a route`);
    assert.equal((await fetch(base + p, { method: 'POST' })).status, 405, `POST ${p} is not a route`);
  }
});

test('the ingredients label does not count a plugin', async (t) => {
  const dir = deckDir();
  const bare = execFileSync(process.execPath, [CLI, 'present', 'talk.html', '--check'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: tmp('plugin-empty-home') } });
  const withPlugin = execFileSync(process.execPath, [CLI, 'present', 'talk.html', '--check'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: homeWith({ timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE } }) } });
  // The label is an inventory of the FILE. A plugin is not in the file, so
  // installing one must not move a single number in it.
  assert.equal(withPlugin, bare);
  assert.doesNotMatch(withPlugin, /timer/);
  rmTemp(dir);
  t.diagnostic('label unchanged by an installed plugin');
});

test('strict mode does not strip the chrome it was handed', async (t) => {
  const dir = tmp('plugin-strict');
  writeFileSync(path.join(dir, 'talk.html'), DECK.replace('</body>', '<script>window.x=1</script></body>'));
  const home = homeWith({ timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE } });
  const child = spawn(process.execPath, [CLI, 'present', 'talk.html', '--port', '0'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
  t.after(() => { child.kill('SIGKILL'); rmTemp(dir); rmTemp(home); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout:\n' + out)); }, 10000);
  });
  const served = await (await fetch(base + '/')).text();
  assert.match(out, /serving strict/, 'the unaccounted block turned strict on');
  assert.doesNotMatch(served, /window\.x=1/, 'the unaccounted block is gone');
  assert.match(served, /decklight-chrome/, 'the chrome survived — it is injected after the strip');
});

// ── the command ────────────────────────────────────────────────────────────

const run = (args, home, opts = {}) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, 'plugin', ...args],
        { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], ...opts }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

test('plugin list says which plugins read your speaker notes', () => {
  const home = homeWith({
    timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE },
    prompter: { manifest: { name: 'prompter', slot: 'edge-bottom', needs: ['position', 'notes'] }, source: GOOD_SOURCE },
  });
  const { out } = run(['list'], home);
  assert.match(out, /prompter.*your speaker notes/s);
  assert.doesNotMatch(out.split('\n').find((l) => l.startsWith('timer')) ?? '', /speaker notes/);
  rmTemp(home);
});

test('plugin check passes good chrome and refuses a reaching plugin', () => {
  const home = homeWith({
    timer: { manifest: GOOD_MANIFEST, source: GOOD_SOURCE },
    grabby: { manifest: { name: 'grabby', slot: 'corner-tl' }, source: 'parent.document.write("x")' },
  });
  const ok = run(['check', 'timer'], home);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /✔ timer/);

  const bad = run(['check', 'grabby'], home);
  assert.equal(bad.code, 1, 'a plugin CI can gate on this');
  assert.match(bad.out, /reaches outside its frame/);
  rmTemp(home);
});

test('plugin add installs from a registered marketplace, and remove takes it away', () => {
  const home = tmp('plugin-mkt-home');
  const market = tmp('plugin-market');
  mkdirSync(path.join(market, '.decklight'), { recursive: true });
  writeFileSync(path.join(market, '.decklight/marketplace.json'), JSON.stringify({
    name: 'local',
    entries: [
      { name: 'timer', type: 'plugin', source: 'plugins/timer', description: 'a talk timer' },
      { name: 'nord', type: 'theme', source: 'themes/nord.css' },
    ],
  }));
  mkdirSync(path.join(market, 'plugins/timer'), { recursive: true });
  writeFileSync(path.join(market, 'plugins/timer/plugin.json'), JSON.stringify(GOOD_MANIFEST));
  writeFileSync(path.join(market, 'plugins/timer/plugin.js'), GOOD_SOURCE);

  execFileSync(process.execPath, [CLI, 'marketplace', 'add', market],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });

  const added = run(['add', 'timer'], home);
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /installed timer/);
  assert.match(added.out, /bundle never will/, 'it says where the plugin does and does not go');
  assert.ok(existsSync(path.join(pluginsDir(home), 'timer/plugin.js')));

  // A theme is not a plugin, and the refusal says which it is.
  const wrong = run(['add', 'nord'], home);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /is a theme, not a plugin/);

  assert.equal(run(['remove', 'timer'], home).code, 0);
  assert.ok(!existsSync(path.join(pluginsDir(home), 'timer')));
  rmTemp(home);
  rmTemp(market);
});

test('plugin add refuses a content-touching plugin and installs nothing', () => {
  const home = tmp('plugin-refuse-home');
  const market = tmp('plugin-refuse-market');
  mkdirSync(path.join(market, '.decklight'), { recursive: true });
  writeFileSync(path.join(market, '.decklight/marketplace.json'), JSON.stringify({
    name: 'local', entries: [{ name: 'grabby', type: 'plugin', source: 'plugins/grabby' }],
  }));
  mkdirSync(path.join(market, 'plugins/grabby'), { recursive: true });
  writeFileSync(path.join(market, 'plugins/grabby/plugin.json'),
    JSON.stringify({ name: 'grabby', slot: 'corner-tl', needs: ['position', 'slides'] }));
  writeFileSync(path.join(market, 'plugins/grabby/plugin.js'), GOOD_SOURCE);

  execFileSync(process.execPath, [CLI, 'marketplace', 'add', market],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });

  const { code, out } = run(['add', 'grabby'], home);
  assert.equal(code, 1);
  assert.match(out, /chrome only/);
  assert.match(out, /was NOT installed/);
  assert.ok(!existsSync(path.join(pluginsDir(home), 'grabby')), 'nothing was written on the refusing path');
  rmTemp(home);
  rmTemp(market);
});
