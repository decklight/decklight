// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight present` — the read-only deck server (MARKETPLACE.md
// PRESENT_SERVER). The claims worth testing are negative ones: no editing
// route exists, nothing is written, nothing off-loopback is answered — so most
// of these assert the ABSENCE of a capability, against a real server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CSP } from '../cli/present.mjs';
import { allowRemote } from '../cli/serve.mjs';
import { createRemoteRelay } from '../cli/remote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const SRC = path.resolve(here, '../cli/present.mjs');

const DECK = `<!doctype html>
<html><head><link rel="stylesheet" href="theme.css"></head><body>
  <div class="decklight"><section><h2>Alpha</h2></section></div>
  <script>Decklight.init()</script>
</body></html>
`;

function deckDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-present-'));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  writeFileSync(path.join(dir, 'theme.css'), '.decklight { color: red }');
  return dir;
}

/**
 * Start the server on an ephemeral port; resolve its base URL.
 *
 * DECKLIGHT_HOME points at an empty directory so the presenter's own plugin
 * library (PRESENT#PLUGINS) cannot reach these tests. Several of them assert
 * the deck is served byte for byte, and that is a claim about a machine with
 * nothing installed — on the machine of a developer who installed a timer it
 * would otherwise fail for a reason that has nothing to do with the change
 * they are making.
 */
async function startPresent(t, dir, { deck = 'talk.html', cwd = dir, extraArgs = [] } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-present-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CLI, 'present', deck, '--port', '0', ...extraArgs],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
  t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
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
  return { base, child, log: () => out };
}

/** Every file under `dir`, with size and mtime — the "nothing was written" witness. */
function snapshot(dir) {
  const seen = {};
  const walk = (d, prefix = '') => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, prefix + name + '/');
      else seen[prefix + name] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return seen;
}

// ── the deck plays ─────────────────────────────────────────────────────────

test('present serves the deck at / and its assets alongside', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir);

  const root = await fetch(base + '/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<h2>Alpha<\/h2>/, '/ serves the deck, not a listing');

  const named = await fetch(base + '/talk.html');
  assert.equal(named.status, 200, 'and it is reachable by name too');

  const css = await fetch(base + '/theme.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css');
});

// ── the served root is the deck's, and secrets beside it stay unreachable ──

test('dotfiles beside the deck are refused unconditionally', async (t) => {
  // The ticket's attack (#226): fetch('/.env') same-origin, POST it to any
  // https: host. The read must fail, decoded or percent-encoded.
  const dir = deckDir();
  writeFileSync(path.join(dir, '.env'), 'AWS_SECRET_ACCESS_KEY=hunter2');
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]');
  const { base } = await startPresent(t, dir);

  for (const p of ['/.env', '/.git/config', '/%2e%65%6e%76' /* ".env" */, '/%2Egit/config']) {
    assert.equal((await fetch(base + p)).status, 403, `${p} is refused, not served`);
  }
  // and the deck itself is unaffected
  assert.equal((await fetch(base + '/talk.html')).status, 200);
});

test('file types a deck cannot use are refused, not served as octet-stream', async (t) => {
  const dir = deckDir();
  writeFileSync(path.join(dir, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----');
  writeFileSync(path.join(dir, 'backup.pem'), '-----BEGIN CERTIFICATE-----');
  writeFileSync(path.join(dir, 'notes.sqlite'), 'SQLite format 3');
  // a deck DOES use video: the MIME table has to know mp4, or spec'd
  // background video (DECK_ANATOMY) would be refused by the same gate
  writeFileSync(path.join(dir, 'clip.mp4'), 'not really video');
  const { base } = await startPresent(t, dir);

  for (const p of ['/id_rsa', '/backup.pem', '/notes.sqlite']) {
    assert.equal((await fetch(base + p)).status, 403, `${p} is refused`);
  }
  const clip = await fetch(base + '/clip.mp4');
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get('content-type'), 'video/mp4');
});

test('--root: a source deck up the tree resolves its assets, and nothing above escapes', async (t) => {
  // A source deck reaches UP for the runtime (demo/showcase.html loads
  // ../dist/decklight.js), which is what --root exists for — the wider
  // exposure is a flag someone typed, never inherited from the cwd. The
  // traversal guard is what keeps the widened root from being a hole.
  const outer = mkdtempSync(path.join(tmpdir(), 'decklight-outer-'));
  mkdirSync(path.join(outer, 'dist'));
  writeFileSync(path.join(outer, 'dist', 'runtime.js'), 'globalThis.Decklight = {}');
  const sub = path.join(outer, 'sub');
  mkdirSync(sub);
  writeFileSync(path.join(sub, 'talk.html'), DECK.replace('theme.css', '../dist/runtime.js'));
  const { base } = await startPresent(t, outer, {
    deck: 'sub/talk.html', cwd: outer, extraArgs: ['--root', '.'],
  });

  assert.equal((await fetch(base + '/sub/talk.html')).status, 200);
  assert.equal((await fetch(base + '/dist/runtime.js')).status, 200, 'the sibling the deck reaches for');
  // above the root is still refused — new URL() normalizes ../ before we see it
  assert.notEqual((await fetch(base + '/../../etc/passwd')).status, 200);
  assert.notEqual((await fetch(base + '/%2e%2e/%2e%2e/etc/passwd')).status, 200);
});

test('without --root, the served root is the deck directory — a source deck cannot reach up', async (t) => {
  const outer = mkdtempSync(path.join(tmpdir(), 'decklight-noroot-'));
  mkdirSync(path.join(outer, 'dist'));
  writeFileSync(path.join(outer, 'dist', 'runtime.js'), 'globalThis.Decklight = {}');
  const sub = path.join(outer, 'sub');
  mkdirSync(sub);
  writeFileSync(path.join(sub, 'talk.html'), DECK.replace('theme.css', '../dist/runtime.js'));
  const { base } = await startPresent(t, outer, { deck: 'sub/talk.html', cwd: outer });

  // the root travelled to the deck's own directory, so the deck is /talk.html…
  assert.equal((await fetch(base + '/talk.html')).status, 200);
  // …and the runtime one level up is simply not in the served tree
  assert.notEqual((await fetch(base + '/dist/runtime.js')).status, 200);
  assert.notEqual((await fetch(base + '/../dist/runtime.js')).status, 200);
});

test('a deck outside the chosen --root is refused, not silently rooted elsewhere', async () => {
  const { execFileSync } = await import('node:child_process');
  const outer = mkdtempSync(path.join(tmpdir(), 'decklight-outside-'));
  writeFileSync(path.join(outer, 'talk.html'), DECK);
  const cwd = mkdtempSync(path.join(tmpdir(), 'decklight-cwd-'));
  let code = 0; let out = '';
  try {
    execFileSync(process.execPath, [CLI, 'present', path.join(outer, 'talk.html'), '--port', '0', '--root', '.'],
      { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 8000 });
  } catch (e) { code = e.status; out = String(e.stderr); }
  rmSync(outer, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /deck must live under --root/);
});

test('a deck presents from any cwd — the root travels with the deck, not the shell', async (t) => {
  // The file-association path (`decklight associate`) launches present from
  // wherever the OS pleases; the served root must not depend on that.
  const dir = deckDir();
  const cwd = mkdtempSync(path.join(tmpdir(), 'decklight-elsewhere-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const { base } = await startPresent(t, dir, { deck: path.join(dir, 'talk.html'), cwd });

  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/theme.css')).status, 200, 'siblings resolve relative to the deck');
});

// ── the CSP is a header, and it is the documented one ──────────────────────

test('every response carries the CSP as an HTTP header', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir);

  for (const p of ['/', '/talk.html', '/theme.css']) {
    const res = await fetch(base + p);
    assert.equal(res.headers.get('content-security-policy'), CSP, `${p} carries the policy`);
  }
});

test('the CSP also rides on errors and the control channels — no uncovered response', async (t) => {
  // The property is "every response", not "every 200" (PRESENT): a 404 page,
  // the control-channel JSON/SSE and the remote controller are all fixed
  // strings or first-party content today, and the header set at one seam is
  // what keeps that true by construction instead of by inspection.
  const dir = deckDir();
  const { base } = await startPresent(t, dir);

  const covered = async (p, init) => {
    const res = await fetch(base + p, init);
    assert.equal(res.headers.get('content-security-policy'), CSP, `${init?.method ?? 'GET'} ${p}`);
    return res;
  };
  assert.equal((await covered('/missing.html')).status, 404);
  assert.equal((await covered('/talk.html', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await covered('/present/ping')).status, 200);
  assert.equal((await covered('/remote')).status, 200, 'the controller is a document — where a policy matters most');
  assert.equal((await covered('/remote/qr.svg')).status, 404, 'without --remote the QR refuses — covered too');

  // the SSE stream: its headers arrive before any event does
  const ctl = new AbortController();
  const sse = await fetch(base + '/present/events', { signal: ctl.signal });
  assert.equal(sse.headers.get('content-security-policy'), CSP, 'GET /present/events');
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  ctl.abort();
});

test('the policy denies by default and opens only what SPEC needs', () => {
  assert.match(CSP, /default-src 'none'/, 'everything not named below is denied');
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /base-uri 'none'/);
  // a credential form pasted into a deck has nowhere to post
  assert.match(CSP, /form-action 'none'/);

  // recorded narration from a bucket, and external background video (PRESENTING)
  assert.match(CSP, /media-src [^;]*https:/);
  // manifest tracks fetch manifest.signed.json from a presigned URL
  assert.match(CSP, /connect-src [^;]*https:/);

  // the theme picker, slide finder and speaker view boot the deck into
  // same-origin iframes — 'none' would break the preview panes
  assert.match(CSP, /frame-src 'self'/);
  assert.match(CSP, /frame-ancestors 'self'/);

  // the local bridges are NOT reachable: live synthesis is an authoring-path
  // engine, and a deck you were emailed probing 127.0.0.1 is a probe
  assert.doesNotMatch(CSP, /127\.0\.0\.1:87/);
});

test('the honest caveat is stated where a user reads it', () => {
  // script-src must carry 'unsafe-inline' — a bundled deck IS inline script —
  // so the usage text has to say the header does not stop code from running.
  assert.match(CSP, /script-src [^;]*'unsafe-inline'/);
  const src = readFileSync(SRC, 'utf8');
  assert.match(src, /does not stop a deck from running/i,
    'usage text refuses to imply the CSP sandboxes the deck');
});

// ── the negative space: no editing surface ─────────────────────────────────

test('no /edit/* route is registered — the source never mentions one', () => {
  const src = readFileSync(SRC, 'utf8');
  // Only the prose may say "/edit/*"; no string literal may route one.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /['"`]\/edit/, 'no /edit path literal survives outside comments');
  // The relay DOES live here now (PRESENT#REMOTE) — that is the whole point of
  // moving it: a clicker should not require an editing server. What must stay
  // true is that it arrived without one, which the /edit/* assertion above and
  // the route tests below cover.
});

test('a POST to /edit/notes is as unknown as a POST to anything else', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir);

  const edit = await fetch(base + '/edit/notes', {
    method: 'POST', body: JSON.stringify({ slide: 1, text: 'pwned' }),
  });
  const nonsense = await fetch(base + '/nonsense', { method: 'POST', body: '{}' });
  assert.equal(edit.status, nonsense.status, 'identical treatment — there is no route to have refused');
  assert.equal(edit.status, 405);

  // and the deck on disk is untouched by the attempt
  assert.equal(readFileSync(path.join(dir, 'talk.html'), 'utf8'), DECK);
});

test('every method but GET is refused, on any path', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir);

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(base + '/talk.html', { method, ...(method === 'DELETE' ? {} : { body: '{}' }) });
    assert.equal(res.status, 405, `${method} /talk.html`);
  }
});

test('nothing is written — the directory is byte-identical after a session', async (t) => {
  const dir = deckDir();
  const before = snapshot(dir);
  const { base } = await startPresent(t, dir);

  await fetch(base + '/');
  await fetch(base + '/theme.css');
  await fetch(base + '/edit/notes', { method: 'POST', body: '{"slide":1,"text":"x"}' });
  await fetch(base + '/edit/layout', { method: 'POST', body: '{"slide":1,"layout":"split"}' });
  await fetch(base + '/missing.html');

  assert.deepEqual(snapshot(dir), before, 'no file created, changed, or touched');
});

// ── the audited bytes are the served bytes (#235) ──────────────────────────

test('a disk edit after startup never reaches the audience — the deck serves from the audited bytes', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir);
  assert.match(await (await fetch(base + '/talk.html')).text(), /<h2>Alpha<\/h2>/);

  // Someone with write access edits the deck under the running server. The
  // verdict in the terminal — and the presenter's decision to open the deck —
  // is already spent on the old bytes, so the new ones must never ride it.
  writeFileSync(path.join(dir, 'talk.html'),
    DECK.replace('</body>', '<script>/*smuggled after the verdict*/</script></body>'));

  // Every spelling of the deck's URL still answers with the bytes the label
  // described — including a percent-encoded one, which resolves to the same
  // file and must not slip past into a fresh disk read.
  for (const p of ['/', '/talk.html', '/%74alk.html']) {
    const text = await (await fetch(base + p)).text();
    assert.doesNotMatch(text, /smuggled/, `${p} never serves bytes the audit did not read`);
    assert.match(text, /<h2>Alpha<\/h2>/, `${p} serves the audited deck`);
  }

  // The boundary: the label is an inventory of the DECK, so only the deck is
  // pinned — a file beside it is read per request, exactly as before.
  writeFileSync(path.join(dir, 'theme.css'), '.decklight { color: blue }');
  assert.match(await (await fetch(base + '/theme.css')).text(), /blue/);
});

test('the module imports no filesystem writer at all', () => {
  // Cheaper and stricter than watching for a write: if it cannot write, it
  // cannot be made to write by a later edit that forgets why.
  const src = readFileSync(SRC, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync/,
    'no write primitive is imported or called');
});

// ── arguments ──────────────────────────────────────────────────────────────

test('--help prints the policy it will enforce, and exits 0', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [CLI, 'present', '--help'], { encoding: 'utf8' });
  assert.match(out, /usage: decklight present/);
  assert.match(out, /default-src 'none'/, 'the actual policy, not a description of one');
  assert.match(out, /--port/);
});

/** A port nothing is listening on right now — bind :0, read it, let it go. */
async function freePort() {
  const { createServer } = await import('node:net');
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('--port binds the port asked for, and Ctrl-C exits clean', async (t) => {
  const dir = deckDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();

  const child = spawn(process.execPath, [CLI, 'present', 'talk.html', '--port', String(port)],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const scan = setInterval(() => { if (out.includes(`127.0.0.1:${port}`)) { clearInterval(scan); resolve(); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error(`never bound ${port}:\n${out}`)); }, 8000);
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/talk.html`)).status, 200,
    'serving on the requested port, not a bumped one');

  const code = await new Promise((resolve) => {
    child.on('exit', (c, sig) => resolve(c ?? sig));
    child.kill('SIGINT');
  });
  assert.equal(code, 0, 'Ctrl-C exits 0 — not on a signal, not through a stack trace');
});

test('a deck that is not there is named, not stack-traced', async () => {
  const { execFileSync } = await import('node:child_process');
  let code = 0; let out = '';
  try {
    execFileSync(process.execPath, [CLI, 'present', 'nope.html'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; out = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(out, /deck not found: .*nope\.html/);
});

// ── the phone remote lives here now (PRESENT#REMOTE) ───────────────────────

test('--remote hosts the clicker, and still registers no /edit/* route', async (t) => {
  const dir = deckDir();
  const { base, log } = await startPresent(t, dir, { extraArgs: ['--remote'] });

  // the presenting control channel exists…
  const ping = await (await fetch(base + '/present/ping')).json();
  assert.deepEqual(ping, { ok: true, name: 'talk.html', remote: true, present: true });
  assert.equal(ping.agents, undefined, 'and reports no agent roster — there is nothing here that runs one');

  // …the controller and its QR are served…
  assert.equal((await fetch(base + '/remote')).status, 200);
  assert.equal((await fetch(base + '/remote/qr.svg')).status, 200);

  // …a tap relays to the deck…
  const key = await (await fetch(base + '/remote/key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"next"}',
  })).json();
  assert.equal(key.ok, true);
  assert.equal(key.key, 'next');

  // …and the whole point: no editing surface came along with it.
  for (const p of ['/edit/notes', '/edit/layout', '/edit/undo', '/edit/commit', '/edit/shutdown']) {
    const res = await fetch(base + p, { method: 'POST', body: '{}' });
    assert.equal(res.status, 405, `${p} is unknown, not refused`);
  }
  assert.equal((await fetch(base + '/edit/ping')).status, 404, 'not even a ping to identify an editor');

  assert.match(log(), /ONLY \/remote\/\* answers/i);
  assert.equal(readFileSync(path.join(dir, 'talk.html'), 'utf8'), DECK, 'and nothing was written');
});

// The classifier itself. It moved here with the remote: the author server used
// to call it too, and now binds 127.0.0.1 with no flag that widens it, so this
// is the only server whose requests it decides.
const reqOf = (addr, url, headers = {}) => ({ socket: { remoteAddress: addr }, url, headers });

test('allowRemote: loopback always answers — token or no token, any path', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10']) {
    assert.equal(allowRemote(reqOf(addr, '/talk.html'), null), true, addr);
    assert.equal(allowRemote(reqOf(addr, '/present/ping'), 'tok'), true, addr);
    assert.equal(allowRemote(reqOf(addr, '/remote/pos'), null), true, addr);
  }
});

test('allowRemote: off-loopback, only /remote/* — and only with the right token', () => {
  const LAN = '192.168.1.23';
  // the /remote?t= URL the phone will carry, and its sub-paths
  assert.equal(allowRemote(reqOf(LAN, '/remote?t=tok'), 'tok'), true);
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t=tok'), 'tok'), true);
  // the token can ride a header too (fetches from the controller page)
  assert.equal(allowRemote(reqOf(LAN, '/remote/state', { 'x-decklight-token': 'tok' }), 'tok'), true);
  // wrong token, missing token: refused
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t=nope'), 'tok'), false);
  assert.equal(allowRemote(reqOf(LAN, '/remote/state'), 'tok'), false);
  // no --remote (token null): nothing off-loopback answers at all
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t='), null), false);
  assert.equal(allowRemote(reqOf(LAN, '/remote?t=null'), null), false);
});

test('allowRemote: the deck itself refuses off-loopback UNCONDITIONALLY', () => {
  const LAN = '10.0.0.7';
  // --remote widens the listener for the clicker and nothing else: the deck and
  // every file beside it stay unreachable from the LAN, token or no token.
  for (const p of ['/talk.html', '/theme.css', '/present/ping', '/present/events']) {
    assert.equal(allowRemote(reqOf(LAN, `${p}?t=tok`), 'tok'), false, p);
  }
  // path tricks normalize before the check, and a prefix is not a directory
  assert.equal(allowRemote(reqOf(LAN, '/remote/../talk.html?t=tok'), 'tok'), false);
  assert.equal(allowRemote(reqOf(LAN, '/remotely?t=tok'), 'tok'), false);
});

test('the controller is a self-contained page — no asset a phone could not reach', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir, { extraArgs: ['--remote'] });
  const res = await fetch(base + '/remote');
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /id="next"/);
  assert.match(html, /id="prev"/);
  assert.match(html, /id="pos"/);
  // a phone is off-loopback: anything it fetches from elsewhere is a hole
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheet');
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i, 'no external script or image');
  // SPEC NON_GOALS — a clicker, not a second screen
  assert.doesNotMatch(html, /class="decklight"/, 'the phone renders no slides');
});

test('the QR refuses to encode a URL a phone cannot use', async (t) => {
  // Without --remote there is no LAN listener, so a QR would encode 127.0.0.1 —
  // a code that scans cleanly and then goes nowhere is worse than no code.
  const dir = deckDir();
  const { base } = await startPresent(t, dir);
  const res = await fetch(base + '/remote/qr.svg');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /--remote/, 'and it names the flag that would make it real');
});

test('a locally-presented deck still gets its position readout', async (t) => {
  // /present/ping and /present/events are the deck's channel and are loopback
  // business, so they answer with or without --remote; only the LAN listener is
  // what --remote adds.
  const dir = deckDir();
  const { base } = await startPresent(t, dir);
  assert.equal((await (await fetch(base + '/present/ping')).json()).remote, false);
  const pos = await fetch(base + '/remote/pos', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"i":2,"n":9}',
  });
  assert.equal(pos.status, 200);
});

test('POST /remote/pos is deck→phones only — an off-loopback caller is refused, not rebroadcast', () => {
  // The deck is the one thing that knows the position and it reports from
  // this machine. A phone — or anyone who obtained the QR token — posting a
  // fabricated {i,n} would desync the readout every other phone shows, and a
  // phone has no reason to post one at all.
  const relay = createRemoteRelay({
    deckName: 'talk.html', token: 'tok', remoteUrl: () => 'http://x',
    relayToDeck: () => {}, deckCount: () => 1, CORS: {},
  });
  const answer = (addr, method, path, body = '') => {
    const out = { code: null, chunks: [] };
    const res = {
      writeHead: (code) => { out.code = code; },
      write: (c) => out.chunks.push(String(c)),
      end: (c) => { if (c) out.chunks.push(String(c)); },
    };
    relay.handle({ method, socket: { remoteAddress: addr }, on: () => {} }, res, new URL('http://127.0.0.1' + path), body);
    return out;
  };

  // a phone subscribes to the readout stream…
  const phone = answer('192.168.1.23', 'GET', '/remote/events');
  // …and another LAN caller, token in hand, tries to fabricate the position
  const forged = answer('192.168.1.99', 'POST', '/remote/pos', '{"i":99,"n":99}');
  assert.equal(forged.code, 403, 'refused — pos is not a phone-facing input');
  assert.ok(!phone.chunks.some((c) => c.includes('event: pos')), 'and nothing reached the phones');

  // the deck itself, over loopback, still lands and reaches the phone
  const deck = answer('127.0.0.1', 'POST', '/remote/pos', '{"i":2,"n":9}');
  assert.equal(deck.code, 200);
  assert.ok(phone.chunks.some((c) => c.includes('"i":2')), 'the readout shows the real position');
});

test('the remote never writes, and a malformed payload is refused not crashed', async (t) => {
  const dir = deckDir();
  const before = snapshot(dir);
  const { base } = await startPresent(t, dir, { extraArgs: ['--remote'] });

  for (const body of ['{"key":"rm -rf"}', '{"i":"nope"}', 'not json at all', '']) {
    const res = await fetch(base + '/remote/key', { method: 'POST', body });
    assert.ok(res.status >= 400, `refused: ${body}`);
  }
  assert.deepEqual(snapshot(dir), before, 'no file created, changed, or touched');
});
