#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight, end to end: pack this repo, install the tarball into an empty
// project, and drive the INSTALLED `decklight` bin through one full user
// journey — create, marketplace, author, edit, git, present, bundle, validate,
// open. Runnable manually — `npm run soak` — and deliberately NOT part of
// `npm test` (the *.test.mjs glob) or `npm run verify`: it runs a real npm
// install and takes minutes, and skipping inside the blessed suites would let
// "green" mean "not actually run" (the video-e2e rule).
//
// WHY THIS EXISTS. 923 unit tests and 17 render harnesses were green on 0.3.0,
// which shipped with three bugs none of them could reach — every one of them
// invisible from inside the repo, because every test runs `node
// cli/decklight.mjs` from the working tree:
//
//   · `import` crashed with a raw ENOENT on any install path containing a
//     SPACE (every Windows profile with one). This repo lives at a space-free
//     path — hence the space in the temp dirs below, which is load-bearing.
//   · `present` reported `runtime — DIFFERS from this install's build` on a
//     deck decklight had written seconds earlier. Every render harness passed,
//     because the deck renders perfectly: the divergence is a hash, not a
//     behaviour — hence the ingredients-label assertion, repeated on every deck
//     this journey produces. It is the highest-value line in this file.
//   · The README's own quick start (init then bundle) failed, because init
//     scaffolds an already-self-contained deck — hence step 20, which asserts
//     that refusal rather than tripping over it.
//
// SKIPS. git/npm missing → the whole run skips and exits 0. No Chrome, no
// network → those steps skip by name and the other 22 still run. A skip is
// always printed with its reason, so a green soak can never quietly mean
// "nothing ran".
//
// macOS/Linux for now: it drives node_modules/.bin/decklight, which needs the
// .cmd shim on Windows.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dumpDom } from './harness.mjs';
import { findChrome } from '../tools/chrome.mjs';
import { isPortOpen } from '../cli/port-conflict.mjs';
import { injectBeforeBodyEnd, locateSlide, sectionBodies } from '../tools/deck-html.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.env.DECKLIGHT_SOAK_KEEP === '1';
const TOTAL = 27;

// ── the driver ─────────────────────────────────────────────────────────────

/** A failed assertion, as distinct from a crash. Carries what was expected. */
class SoakFail extends Error {}
const must = (cond, assertion) => { if (!cond) throw new SoakFail(assertion); };

const steps = [];
let n = 0;
/** The last command or server this step touched — what a failure block shows. */
let ctx = null;

const t0 = Date.now();
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function step(name, fn) {
  n += 1;
  const at = Date.now();
  const tag = `[${String(n).padStart(2, '0')}/${TOTAL}]`;
  ctx = null;
  try {
    const out = await fn();
    const ms = Date.now() - at;
    if (out?.skip) {
      steps.push({ n, name, state: 'SKIP', why: out.skip });
      console.log(`${tag} SKIP  ${name.padEnd(52)} — ${out.skip}`);
      return;
    }
    steps.push({ n, name, state: 'ok', ms });
    console.log(`${tag} ok    ${name.padEnd(52)} ${secs(ms)}`);
  } catch (e) {
    steps.push({ n, name, state: 'FAIL', ms: Date.now() - at, error: e });
    console.log(`${tag} FAIL  ${name.padEnd(52)} ${secs(Date.now() - at)}`);
    throw e;
  }
}

const clip = (s, max = 4000) => {
  const text = String(s ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} B truncated)`;
};
/** A CLI transcript is prefixed so it is never mistaken for the soak's voice. */
const quote = (s) => clip(s).split('\n').map((l) => `    | ${l}`).join('\n');

function failureBlock(e) {
  const line = '─'.repeat(72);
  const failed = steps.find((s) => s.state === 'FAIL');
  console.log(`\n${line}`);
  console.log(`FAILED at step ${failed.n}/${TOTAL} — ${failed.name}\n`);
  console.log(`  ${e instanceof SoakFail ? 'assertion' : 'crashed'}: ${e.message}\n`);
  if (ctx?.kind === 'cmd') {
    console.log(`  command:   ${ctx.argv.join(' ')}`);
    console.log(`  cwd:       ${ctx.cwd}`);
    console.log(`  exit:      ${ctx.code}\n`);
    if (ctx.stdout) console.log(`  stdout (${ctx.stdout.length} B):\n${quote(ctx.stdout)}\n`);
    if (ctx.stderr) console.log(`  stderr (${ctx.stderr.length} B):\n${quote(ctx.stderr)}\n`);
  } else if (ctx?.kind === 'server') {
    console.log(`  server:    ${ctx.argv.join(' ')}`);
    console.log(`  log:\n${quote(ctx.log())}\n`);
  }
  if (!(e instanceof SoakFail) && e.stack) console.log(`  ${e.stack.split('\n').slice(1, 4).join('\n  ')}\n`);
  console.log(line);
}

// ── running things ─────────────────────────────────────────────────────────

let SPACE; let HOME; let PROJECT; let PACK; let MARKET; let DL;

const env = () => ({ ...process.env, DECKLIGHT_HOME: HOME });

/**
 * Every command's output passes through here. A raw ENOENT or a node-internal
 * stack frame fails the step that produced it — that is the space-in-the-path
 * net (#275) and the "no command prints a raw stack" convention (#278),
 * enforced once across every command rather than as a step of its own.
 */
const RAW = /\bENOENT\b|\n\s+at .*\(node:internal/;

function sh(argv, { cwd = PROJECT, timeout = 120000, allowFail = false } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: env(), encoding: 'utf8', timeout });
  const out = { kind: 'cmd', argv, cwd, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  out.all = out.stdout + out.stderr;
  ctx = out;
  if (r.error?.code === 'ETIMEDOUT') throw new SoakFail(`exceeded ${timeout / 1000}s`);
  must(!RAW.test(out.all), 'a command printed a raw ENOENT or an internal stack trace');
  if (!allowFail) must(r.status === 0, `expected exit 0, got ${r.status}`);
  return out;
}

const dl = (args, opts) => sh([DL, ...args], opts);

// ── servers ────────────────────────────────────────────────────────────────

const kids = new Set();
const ports = new Set();

/**
 * Spawn a server on --port 0 and learn its port from the line it prints. The
 * port is never guessed: `author` plans its child's URL with a literal 0, so
 * the caller passes the SPECIFIC line to match rather than a bare 127.0.0.1:N.
 */
function startServer(args, re, { timeoutMs = 20000 } = {}) {
  const argv = [DL, ...args];
  const child = spawn(argv[0], argv.slice(1), { cwd: PROJECT, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  kids.add(child);
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  child.on('exit', () => kids.delete(child));
  const server = { kind: 'server', argv, child, log: () => log };
  ctx = server;
  return new Promise((done, bad) => {
    const scan = setInterval(() => {
      const m = log.match(re);
      if (!m) return;
      clearInterval(scan);
      server.port = Number(m[1]);
      server.base = `http://127.0.0.1:${server.port}`;
      ports.add(server.port);
      done(server);
    }, 25);
    child.on('exit', (code) => { clearInterval(scan); bad(new SoakFail(`server exited early (code ${code})`)); });
    setTimeout(() => { clearInterval(scan); bad(new SoakFail(`no server URL after ${timeoutMs / 1000}s`)); }, timeoutMs);
  });
}

const waitExit = (child, ms) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done(true);
  const t = setTimeout(() => done(false), ms);
  child.on('exit', () => { clearTimeout(t); done(true); });
});

const get = (base, path) => fetch(base + path);
const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
const postJson = async (base, path, body) => {
  const r = await post(base, path, body);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, or fail the step naming what was waited for. */
async function until(what, fn, { ms = 15000, every = 250 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new SoakFail(`${what} did not happen within ${ms / 1000}s`);
    await sleep(every);
  }
}

/**
 * What a rendered decklight deck must look like, asserted STRUCTURALLY.
 *
 * A self-contained deck carries its own runtime inline, and that source text
 * mentions `data-overflow` and `<section` itself — so a substring search reads
 * the runtime's source as if it were the page's markup and fails on a deck
 * that is perfectly fine. Every check here is anchored to a real tag.
 */
function mounted(dom, slides) {
  must(dom.includes('decklight-stage'), 'the runtime never mounted');
  const sections = dom.match(/<section\b[^>]*>/g) ?? [];
  must(sections.length >= slides, `expected ${slides} slides in the DOM, matched ${sections.length}`);
  must(sections.some((s) => /\bclass="[^"]*\bactive\b/.test(s)), 'no slide is active');
  must(!sections.some((s) => /\sdata-overflow\b/.test(s)), 'a slide overflows its frame');
}

const git = (args) => spawnSync('git', args, { cwd: PROJECT, encoding: 'utf8' }).stdout ?? '';
const deckPath = () => join(PROJECT, 'deck.html');
const deck = () => readFileSync(deckPath(), 'utf8');

// ── the fixtures this journey writes ───────────────────────────────────────

const SOAK_SECTION = `
    <section>
      <h2>Soak slide</h2>
      <p data-build="fade">added by writing the file, the way an agent does</p>
    </section>
`;

const linkedDeck = (h1) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Linked Deck</title>
  <link rel="stylesheet" href="node_modules/decklight/dist/decklight.css">
  <link rel="stylesheet" href="node_modules/decklight/themes/aurora.css">
</head>
<body>
  <div class="decklight">
    <section><h1>${h1}</h1></section>
    <section><h2>Second</h2><ul data-build><li>one</li><li>two</li></ul></section>
  </div>
  <script src="node_modules/decklight/dist/decklight.js"></script>
  <script>Decklight.init({});</script>
</body>
</html>
`;

/** The marketplace fixture: a real git repo, cloned over file:// like any remote. */
function buildMarket() {
  mkdirSync(join(MARKET, '.decklight'), { recursive: true });
  mkdirSync(join(MARKET, 'templates'), { recursive: true });
  writeFileSync(join(MARKET, '.decklight', 'marketplace.json'), `${JSON.stringify({
    name: 'soak-market',
    description: "the soak's own catalog",
    entries: [{
      name: 'soak-pitch',
      type: 'template',
      source: './templates/soak-pitch.html',
      description: 'a two-slide pitch',
    }],
  }, null, 2)}\n`);
  writeFileSync(join(MARKET, 'templates', 'soak-pitch.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pitch</title></head>
<body><div class="decklight">
  <section><h1>Pitch</h1></section>
  <section><h2>The ask</h2></section>
</div></body></html>
`);
  const g = (...args) => spawnSync('git', args, { cwd: MARKET, encoding: 'utf8' });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=soak', '-c', 'user.email=soak@example.com', 'commit', '-qm', 'catalog');
}

// ── preflight ──────────────────────────────────────────────────────────────

const have = (bin, arg = '--version') => {
  try { execOk(bin, arg); return true; } catch { return false; }
};
function execOk(bin, arg) {
  const r = spawnSync(bin, [arg], { stdio: 'ignore' });
  if (r.error || r.status !== 0) throw new Error('no');
}

if (!have('git') || !have('npm')) {
  console.log('soak: SKIP — git and npm must both be on PATH');
  process.exit(0);
}
// findChrome() is the NON-fatal probe; chromeBin() would exit the process.
const HAVE_CHROME = Boolean(findChrome());
const HAVE_NET = spawnSync('git',
  ['ls-remote', '--exit-code', 'https://github.com/decklight/decklight-plugins-official', 'HEAD'],
  { stdio: 'ignore', timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).status === 0;

// ── the journey ────────────────────────────────────────────────────────────

SPACE = mkdtempSync(join(tmpdir(), 'decklight soak '));   // the space is the point
HOME = join(SPACE, 'home');
PROJECT = join(SPACE, 'project');
PACK = join(SPACE, 'pack');
// No space here on purpose: MARKET is the source of a file:// git URL, and an
// unencoded space in a URL is a git-side variable this test is not isolating.
MARKET = mkdtempSync(join(tmpdir(), 'decklight-soak-market-'));
for (const d of [HOME, PROJECT, PACK]) mkdirSync(d, { recursive: true });

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
let tarball;
let authorSrv = null;
let failed = false;

console.log(`decklight soak — ${version}, into "${PROJECT}"`);
console.log(`  chrome ${HAVE_CHROME ? 'yes' : 'no'} · network ${HAVE_NET ? 'yes' : 'no'}\n`);

try {
  // ── install ──────────────────────────────────────────────────────────────
  await step('the repo packs into a tarball', () => {
    sh(['npm', 'run', 'build'], { cwd: root, timeout: 300000 });
    const out = sh(['npm', 'pack', '--pack-destination', PACK], { cwd: root, timeout: 300000 });
    tarball = join(PACK, `decklight-${version}.tgz`);
    must(existsSync(tarball), `npm pack did not produce ${tarball}\n${out.all}`);
    must(statSync(tarball).size > 100_000, 'the tarball is suspiciously small');
  });

  await step('it installs into an empty project', () => {
    writeFileSync(join(PROJECT, 'package.json'), `${JSON.stringify({
      name: 'decklight-soak-consumer', private: true, version: '0.0.0',
    }, null, 2)}\n`);
    // A real user's .gitignore. `init` runs `git add -A`, so this is what keeps
    // node_modules out of their very first commit — asserted in step 5.
    writeFileSync(join(PROJECT, '.gitignore'), 'node_modules/\n');
    sh(['npm', 'install', tarball, '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock'],
      { timeout: 300000 });
    DL = join(PROJECT, 'node_modules', '.bin', 'decklight');
    must(existsSync(DL), 'node_modules/.bin/decklight is missing — the bin field or files: regressed');
    for (const f of ['dist/decklight.js', 'dist/decklight.css', 'themes/aurora.css', 'SPEC.md']) {
      must(existsSync(join(PROJECT, 'node_modules', 'decklight', f)), `the tarball is missing ${f}`);
    }
  });

  await step('the installed bin reports its version', () => {
    const r = sh([DL, '--version']);
    must(r.stdout.trim() === `decklight ${version}`, `stdout was ${JSON.stringify(r.stdout)}`);
    // --version returns before the `decklight <v>` stderr banner every other
    // command prints; a regression that moved the banner up shows here.
    must(r.stderr === '', `--version wrote to stderr: ${JSON.stringify(r.stderr)}`);
  });

  // ── create ───────────────────────────────────────────────────────────────
  await step('init scaffolds a deck and a repo', () => {
    dl(['init', 'Soak Deck', '-o', 'deck.html', '--themes', 'aurora,midnight', '--git', '--no-skill']);
    const html = deck();
    must(html.includes('<title>Soak Deck</title>'), 'the title argument did not reach the deck');
    must(sectionBodies(html).length === 2, `expected 2 slides, got ${sectionBodies(html).length}`);
    must(html.includes('<style data-theme="aurora"'), 'aurora was not inlined');
    must(html.includes('<style data-theme="midnight"'), 'midnight was not inlined');
    must(/data-decklight-runtime="js"/.test(html), 'the runtime is not marked');
  });

  await step('the repo tracks the deck and not node_modules', () => {
    must(git(['rev-parse', '--is-inside-work-tree']).trim() === 'true', 'init did not create a repo');
    const tracked = git(['ls-files']).split('\n').filter(Boolean);
    must(tracked.includes('deck.html'), 'the deck is not tracked');
    must(!tracked.some((f) => f.startsWith('node_modules/')), 'node_modules landed in the first commit');
    // initRepo has no identity fallback (unlike gitAutocommit), so on a machine
    // with no git identity it stages without committing — a supported state.
    if (spawnSync('git', ['config', 'user.email'], { cwd: PROJECT }).status === 0) {
      must(git(['log', '-1', '--format=%s']).trim() === 'decklight init', 'the init commit is missing');
    }
  });

  await step('the ingredients label vouches for the runtime', () => {
    const r = dl(['present', 'deck.html', '--check']);
    must(r.all.includes('identical to this install'),
      'the label does not say the runtime is identical to this install (the 0.3.0 near-miss)');
    must(/0 unaccounted script blocks/.test(r.all), 'the deck carries unaccounted script');
    must(/0 inline handlers/.test(r.all), 'the deck carries inline handlers');
  });

  // ── marketplace ──────────────────────────────────────────────────────────
  await step('first run registers without fetching', () => {
    const reg = JSON.parse(readFileSync(join(HOME, 'marketplaces.json'), 'utf8'));
    must(reg.marketplaces?.decklight, 'the first-party marketplace was not registered on first run');
    must(!existsSync(join(HOME, 'marketplaces', 'decklight.json')),
      'a catalog was fetched at registration — registered is not fetched (SPEC MARKETPLACE_REGISTRY)');
  });

  await step('a marketplace is cloned and kept', () => {
    buildMarket();
    const r = dl(['marketplace', 'add', `file://${MARKET}`]);
    must(/registered soak-market/.test(r.all), 'the catalog was not registered');
    must(/cloned to .*marketplaces[/\\]soak-market/.test(r.all), 'no checkout was reported');
    const checkout = join(HOME, 'marketplaces', 'soak-market');
    must(existsSync(join(checkout, 'templates', 'soak-pitch.html')), "the entry's files are not in the checkout");
    must(!existsSync(join(checkout, '.git')), 'the checkout kept a .git — it is a checkout, not a repository');
    must(!readdirSync(join(HOME, 'marketplaces')).some((f) => f.startsWith('.staging')),
      'a staging directory survived');
  });

  await step('an entry installs from that checkout', () => {
    dl(['template', 'add', 'soak-pitch@soak-market']);
    const installed = join(HOME, 'templates', 'soak-pitch.html');
    must(existsSync(installed), 'the template did not land in the library');
    must(readFileSync(installed, 'utf8') === readFileSync(join(MARKET, 'templates', 'soak-pitch.html'), 'utf8'),
      'the installed bytes differ from the marketplace');
  });

  await step('the first-party catalog fetches', () => {
    if (!HAVE_NET) return { skip: 'no network' };
    const r = dl(['marketplace', 'update', 'decklight'], { timeout: 120000 });
    must(/(fetched|updated) decklight — \d+ entr/.test(r.all), 'the catalog did not come back');
    return undefined;
  });

  // ── author ───────────────────────────────────────────────────────────────
  await step('author starts and takes the repo', async () => {
    authorSrv = await startServer(
      ['author', 'deck.html', '--port', '0', '--git', '--commit-every', '5'],
      /decklight author on http:\/\/127\.0\.0\.1:(\d+)/,
    );
    const ping = await (await get(authorSrv.base, '/edit/ping')).json();
    must(ping.ok === true && ping.name === 'deck.html', `ping said ${JSON.stringify(ping)}`);
    must(ping.git === true, 'author did not pick up the repository init created');
    must(ping.undo === 0 && ping.redo === 0, 'a fresh session started with history');
    // Not asserted here: the `start editing` bookend. gitAutocommit no-ops on a
    // clean tree, and init has just committed — so the opening bookend
    // correctly commits nothing. What it means for git to be ON is the line
    // author prints, and the closing bookend in step 17, which does have work.
    must(/git: committing deck\.html .* every 5s/.test(authorSrv.log()),
      'author did not announce the commit policy it was given');
  });

  await step('a slide is added by writing the file', async () => {
    // There is no endpoint that adds a slide: the deck file IS the API, which
    // is what an agent uses (cli/skill-content.mjs). ORDER MATTERS — the
    // watcher broadcasts `reload` but never records history, so this write has
    // to happen BEFORE any server-side edit; step 14 asserts the slide survives
    // an undo, which is what would break if these steps were reordered.
    const sse = (async () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`${authorSrv.base}/edit/events`, { signal: ctrl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return false;
          buf += dec.decode(value, { stream: true });
          if (/^data: reload$/m.test(buf)) { ctrl.abort(); return true; }
        }
      } catch { return false; }
    })();
    await sleep(400);   // let the SSE connection establish before the write

    // Split on <section> rather than searching for the last </section>: the
    // inlined runtime carries markup of its own.
    const { parts, idx } = locateSlide(deck(), 2);
    const close = parts[idx].indexOf('</section>') + '</section>'.length;
    parts[idx] = parts[idx].slice(0, close) + SOAK_SECTION + parts[idx].slice(close);
    writeFileSync(deckPath(), parts.join(''));

    must(sectionBodies(deck()).length === 3, `expected 3 slides, got ${sectionBodies(deck()).length}`);
    must(await sse, 'the author server did not broadcast a reload for the file change');
    const src = await until('the server could address the new slide', async () => {
      const r = await get(authorSrv.base, '/edit/element/source?slide=3&index=0');
      return r.status === 200 ? (await r.json()).html : null;
    }, { ms: 5000 });
    must(src.includes('Soak slide'), `the server read back ${JSON.stringify(src)}`);
  });

  await step('slides edit over the author API', async () => {
    const notes = await postJson(authorSrv.base, '/edit/notes', { slide: 3, text: 'first beat\n⟨CLICK⟩\nsecond beat' });
    must(notes.status === 200, `notes returned ${notes.status}`);
    must(/<aside class="notes">[\s\S]*first beat/.test(deck()), 'the notes did not reach the file');

    const layout = await postJson(authorSrv.base, '/edit/layout', { slide: 3, layout: 'split' });
    must(layout.status === 200 && layout.body.changed === true, `layout returned ${JSON.stringify(layout)}`);
    must(/<section data-layout="split"/.test(deck()), 'data-layout did not reach the file');

    const content = await postJson(authorSrv.base, '/edit/element/content',
      { slide: 3, index: 1, html: '<p data-build="fade">edited by the soak</p>' });
    must(content.status === 200, `element/content returned ${content.status}`);
    must(deck().includes('edited by the soak'), 'the element edit did not reach the file');

    const effect = await postJson(authorSrv.base, '/edit/element/effect', { slide: 3, index: 1, effect: 'zoom' });
    must(effect.status === 200, `element/effect returned ${effect.status}`);
    must(deck().includes('data-build="zoom"'), 'the build effect did not reach the file');

    // A refused edit must leave the deck byte-identical.
    const before = deck();
    const bad = await post(authorSrv.base, '/edit/layout', { slide: 3, layout: 'diagonal' });
    must(bad.status !== 200, 'an unknown layout was accepted');
    must(deck() === before, 'a refused edit changed the deck');
  });

  await step('undo and redo round-trip, keeping the slide', async () => {
    const undo = await postJson(authorSrv.base, '/edit/undo', {});
    must(undo.status === 200, `undo returned ${undo.status}`);
    must(deck().includes('data-build="fade"'), 'undo did not step the effect back');
    // The load-bearing one: a direct file write is invisible to the history, so
    // undoing past it must not swallow the slide it added.
    must(sectionBodies(deck()).length === 3, 'undo swallowed the slide added by writing the file');
    const redo = await postJson(authorSrv.base, '/edit/redo', {});
    must(redo.status === 200, `redo returned ${redo.status}`);
    must(deck().includes('data-build="zoom"'), 'redo did not step forward again');
  });

  await step('an explicit commit lands, and repeats as a no-op', async () => {
    const first = await postJson(authorSrv.base, '/edit/commit', { message: 'soak: three slides, edited' });
    must(first.status === 200 && first.body.committed === true, `commit returned ${JSON.stringify(first.body)}`);
    must(git(['log', '-1', '--format=%s']).trim() === 'soak: three slides, edited', 'the subject did not land');
    must(git(['status', '--porcelain', '--', 'deck.html']).trim() === '', 'the deck is still dirty after a commit');
    const again = await postJson(authorSrv.base, '/edit/commit', { message: 'soak: nothing to say' });
    must(again.body.committed === false, 'a clean tree produced a second commit');
  });

  await step('the autosave cadence fires', async () => {
    await postJson(authorSrv.base, '/edit/notes', { slide: 1, text: 'touched for the timer' });
    // --commit-every 5 is the floor max(5, …) allows; 3× that before failing.
    await until('an autosave commit', () => git(['log', '--format=%s']).includes('decklight: autosave deck.html'),
      { ms: 15000, every: 500 });
  });

  await step('author exits cleanly and lets go', async () => {
    const hist = await (await get(authorSrv.base, '/edit/history')).json();
    must(hist.ok && hist.entries.length >= 3, `history had ${hist.entries?.length} entries`);
    // Leave real work uncommitted on purpose: the closing bookend's whole job
    // is that quitting does not lose the last thing you typed.
    await postJson(authorSrv.base, '/edit/notes', { slide: 2, text: 'typed just before quitting' });
    must(git(['status', '--porcelain', '--', 'deck.html']).trim() !== '', 'the setup for this step did not dirty the deck');

    await post(authorSrv.base, '/edit/shutdown', {}).catch(() => {});   // it hangs up as it exits
    must(await waitExit(authorSrv.child, 8000), 'author did not exit after /edit/shutdown');
    must(git(['log', '-1', '--format=%s']).trim() === 'decklight: stop editing deck.html',
      'the closing bookend commit is missing');
    must(git(['status', '--porcelain', '--', 'deck.html']).trim() === '',
      'quitting left the last edit uncommitted');
    must(git(['show', 'HEAD:deck.html']).includes('typed just before quitting'),
      'the closing commit does not contain the last edit');
    must((await isPortOpen(authorSrv.port)) === false, 'the edit port is still bound — an orphan survived');
    authorSrv = null;
  });

  // ── present ──────────────────────────────────────────────────────────────
  let presentSrv = null;
  await step('present serves the deck and nothing else', async () => {
    presentSrv = await startServer(['present', 'deck.html', '--port', '0'], /http:\/\/127\.0\.0\.1:(\d+)/,
      { timeoutMs: 15000 });
    await until('the ingredients label', () => /ingredients/.test(presentSrv.log()), { ms: 5000 });
    must(presentSrv.log().includes('identical to this install'), 'the label does not vouch for the runtime');
    must(!presentSrv.log().includes('serving strict'),
      'present went strict on a deck decklight itself wrote');

    const before = statSync(deckPath());
    const res = await get(presentSrv.base, '/');
    must(res.headers.get('content-security-policy')?.includes("default-src 'none'"),
      'the CSP header is missing from a present response');
    must((await res.text()) === deck(), 'the served bytes differ from the file on disk');
    must((await get(presentSrv.base, '/edit/ping')).status >= 400, '/edit/ping answered under present');
    must((await post(presentSrv.base, '/edit/notes', { slide: 1, text: 'x' })).status >= 400,
      'present accepted an edit');
    const after = statSync(deckPath());
    must(before.size === after.size && before.mtimeMs === after.mtimeMs, 'present touched the deck');
  });

  await step('the deck renders', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    // Rendered from FILE, not from the running present server — and that is a
    // constraint, not a preference: a deck SERVED BY PRESENT can never be
    // dumped under `--virtual-time-budget`, by design. `/present/ping` answers
    // `{present:true}`, so the runtime opens an EventSource on
    // `/present/events` for the phone remote (PRESENT#REMOTE, `editmode.js`
    // wirePresentRemote), that stream never ends, and Chrome's virtual clock
    // does not advance while a fetch is pending — so the dump never returns.
    // Over file:// the ping finds nothing and the stream is never opened.
    //
    // file:// is the stronger claim anyway: it is what "double-click it and it
    // presents" means. The wall-clock `timeout` below is the backstop, since a
    // hang is the one failure a soak must never have.
    //
    // No probe splice either — present strips unaccounted script, so a spliced
    // probe would be removed and report nothing. Assert on the dumped DOM.
    const dom = dumpDom(pathToFileURL(deckPath()).href,
      { budget: 8000, quietStderr: true, who: 'soak', timeout: 60000 });
    mounted(dom, 3);
    must(dom.includes('Soak slide'), 'the slide added during the session is not in the rendered deck');
    return undefined;
  });

  await step('present lets go of its port', async () => {
    presentSrv.child.kill('SIGTERM');
    must(await waitExit(presentSrv.child, 5000), 'present did not exit on SIGTERM');
    must((await isPortOpen(presentSrv.port)) === false, 'the present port is still bound');
  });

  // ── bundle, validate, open ───────────────────────────────────────────────
  await step('bundle refuses an init-scaffolded deck', () => {
    const before = deck();
    const r = dl(['bundle', 'deck.html'], { allowFail: true });
    must(r.code !== 0, 'bundle accepted a deck whose themes are already inline');
    must(r.all.includes('already self-contained'), 'the refusal does not say why');
    must(r.all.includes('decklight upgrade'), 'the refusal does not name the command that does apply');
    must(deck() === before, 'the refused bundle touched the deck');
  });

  await step('upgrade is a no-op on a current deck', () => {
    const before = deck();
    const r = dl(['upgrade', 'deck.html']);
    must(/already current/.test(r.all), `upgrade rewrote a deck this install just wrote: ${r.stdout}`);
    must(!existsSync(`${deckPath()}.bak`), 'a no-op upgrade still wrote a backup');
    must(deck() === before, 'a no-op upgrade changed the deck');
  });

  await step('a stale deck is spotted, then upgraded', () => {
    // Make the deck stale the way a decklight update does: leave the marked
    // runtime block in place but change its bytes. This is the 0.3.0 bug's
    // exact shape — a deck that renders perfectly and whose runtime is not the
    // one installed — so it exercises the label's NEGATIVE case, which every
    // other step only ever sees pass.
    const stale = deck().replace(/(<script data-decklight-runtime="js">)[\s\S]*?(<\/script>)/,
      '$1/* an older build */$2');
    must(stale !== deck(), 'the runtime block marker was not found — has it been renamed?');
    writeFileSync(deckPath(), stale);

    const before = dl(['present', 'deck.html', '--check'], { allowFail: true });
    must(/DIFFERS from this install/.test(before.all),
      'the label did not notice a runtime that is not this install — the 0.3.0 near-miss, undetected');

    dl(['upgrade', 'deck.html', '--dry-run']);
    must(!existsSync(`${deckPath()}.bak`), '--dry-run wrote a backup');
    dl(['upgrade', 'deck.html']);
    must(existsSync(`${deckPath()}.bak`), 'upgrade did not write a backup');

    const after = dl(['present', 'deck.html', '--check']);
    must(after.all.includes('identical to this install'), 'the upgraded runtime still is not this install');
    locateSlide(deck(), 3);   // throws if the added slide did not survive
    must(deck().includes('edited by the soak'), 'the element edit did not survive the upgrade');
    must(deck().includes('typed just before quitting'), 'the last edit did not survive the upgrade');
  });

  await step('a linked deck bundles to one file', () => {
    writeFileSync(join(PROJECT, 'linked.html'), linkedDeck('Linked and bundled'));
    dl(['bundle', 'linked.html', '-o', 'linked bundle.html']);   // a space in the output name too
    const out = readFileSync(join(PROJECT, 'linked bundle.html'), 'utf8');
    must(out.includes('<style data-theme="aurora"'), 'the theme was not inlined');
    must(!/<link\s+rel="stylesheet"/i.test(out), 'the bundle still links a stylesheet');
    must(!/<script\s+src=/i.test(out), 'the bundle still loads an external script');
    must(out.length > 100_000, 'the bundle is suspiciously small');
  });

  await step('present --check validates the bundle', () => {
    const r = dl(['present', 'linked bundle.html', '--check']);
    must(r.all.includes('identical to this install'), 'the bundled runtime is not this install');
    must(/0 unaccounted script blocks/.test(r.all), 'the bundle carries unaccounted script');
    must(/0 inline handlers/.test(r.all), 'the bundle carries inline handlers');
  });

  await step('and the check bites when it should', () => {
    const src = readFileSync(join(PROJECT, 'linked bundle.html'), 'utf8');
    // injectBeforeBodyEnd, not a replace: the inlined runtime carries a literal
    // </body> in its speaker-view template.
    writeFileSync(join(PROJECT, 'tampered.html'), injectBeforeBodyEnd(src, '<script>window.__soak = 1;</script>'));
    const r = dl(['present', 'tampered.html', '--check'], { allowFail: true });
    must(r.code === 1, `--check passed a tampered deck (exit ${r.code}) — the gate is decoration`);
    must(/1 unaccounted script block/.test(r.all), 'the report does not name the spliced script');
  });

  await step('the bundle opens by double-click', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    // No server, no sibling files, a path containing a space, and deliberately
    // WITHOUT --allow-file-access-from-files: a self-contained deck must need
    // none. This is the whole promise of `bundle` in one assertion.
    const local = dumpDom(pathToFileURL(join(PROJECT, 'linked bundle.html')).href,
      { budget: 8000, quietStderr: true, who: 'soak', timeout: 60000 });
    mounted(local, 2);
    must(local.includes('Linked and bundled'), 'the deck content is missing over file://');
    return undefined;
  });
} catch (e) {
  failed = true;
  failureBlock(e);
} finally {
  // ── teardown: nothing survives, and a leak is a failure ──────────────────
  if (authorSrv) await post(authorSrv.base, '/edit/shutdown', {}).catch(() => {});
  for (const child of [...kids]) {
    child.kill('SIGTERM');
    if (!(await waitExit(child, 2000))) child.kill('SIGKILL');
  }
  const leaked = [];
  for (const port of ports) if (await isPortOpen(port)) leaked.push(port);
  for (const port of leaked) console.log(`soak: WARNING — port ${port} is still bound after teardown`);
  // A step count that drifts from TOTAL only misprints a tag, which is exactly
  // why it would never get fixed — so it is loud, and it is a failure.
  const miscounted = !failed && steps.length !== TOTAL;
  if (miscounted) console.log(`soak: WARNING — ran ${steps.length} steps but announces ${TOTAL}; update TOTAL`);

  const ok = steps.filter((s) => s.state === 'ok').length;
  const skipped = steps.filter((s) => s.state === 'SKIP');
  console.log('');
  if (failed) {
    console.log(`decklight soak: FAILED at ${steps.find((s) => s.state === 'FAIL').n}/${TOTAL}`
      + `  ·  ${ok} ok · ${skipped.length} skipped · 1 failed · ${secs(Date.now() - t0)}`);
    for (const s of steps.slice(steps.findIndex((x) => x.state === 'FAIL') + 1)) console.log(`—     ${s.name}`);
    console.log(`  not reached: ${TOTAL - steps.length} more step(s)`);
  } else {
    console.log(`decklight soak: PASS — ${ok} ok · ${skipped.length} skipped · 0 failed · ${secs(Date.now() - t0)}`);
  }
  if (skipped.length) console.log(`  skipped: ${skipped.map((s) => `${s.n} (${s.why})`).join(' · ')}`);

  if (KEEP) {
    console.log(`\n  kept: ${SPACE}\n  kept: ${MARKET}`);
  } else {
    if (failed) console.log(`\n  (DECKLIGHT_SOAK_KEEP=1 keeps ${SPACE} for a post-mortem)`);
    rmSync(SPACE, { recursive: true, force: true });
    rmSync(MARKET, { recursive: true, force: true });
  }
  process.exit(failed || leaked.length || miscounted ? 1 : 0);
}
