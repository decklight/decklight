#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight, end to end: pack this repo, install the tarball into an empty
// project, and drive the INSTALLED `decklight` bin through one full user
// journey — create, import, marketplace, author, edit, git, present, bundle,
// transform, pdf, publish, validate, open — plus a sweep of the whole command
// roster. Runnable manually — `npm run soak` — and NOT part of
// `npm test` (the *.test.mjs glob) or `npm run verify`: it runs a real npm
// install and takes minutes, and skipping inside the blessed suites would let
// "green" mean "not actually run" (the video-e2e rule).
//
// WHY THIS EXISTS. 923 unit tests and 17 render harnesses were green on 0.3.0,
// which shipped with three bugs none of them could reach — every one of them
// invisible from inside the repo, because every test runs `node
// cli/decklight.mjs` from the working tree:
//
//   · `import` crashed with a raw ENOENT on any path containing a SPACE (every
//     Windows profile with one). This repo lives at a space-free path — hence
//     the space in both the temp dirs and the imported fixture's name below,
//     which is load-bearing rather than decorative.
//   · `present` reported `runtime — DIFFERS from this install's build` on a
//     deck decklight had written seconds earlier — an IMPORTED one. Every
//     render harness passed, because the deck renders perfectly: the
//     divergence is a hash, not a behaviour. Hence the ingredients-label
//     assertion, repeated on every deck this journey produces. It is the
//     highest-value line in this file.
//   · The README's own quick start (init then bundle) failed, because init
//     scaffolds an already-self-contained deck — hence the step that asserts
//     that refusal rather than tripping over it.
//
// Two of those three lived in `import`, which is why it is a leg here and not
// left to test/import-render.mjs: that harness renders an imported deck from
// the working tree, and neither bug was about rendering or reachable from
// inside the repo.
//
// SKIPS. git/npm missing → the whole run skips and exits 0. No Chrome, no
// network, no ffmpeg, no toolchain for node-pty → those steps skip by name and
// the rest still run. A skip is always printed with its reason, so a green soak
// can never quietly mean "nothing ran".
//
// PLATFORMS. Every decision about the operating system lives in
// test/soak-platform.mjs, pure over an injected `platform` and covered by
// test/soak-platform.test.mjs — the .cmd shims Windows needs, the file:// URL a
// drive letter needs, and which synthesiser can make narration. That module
// exists because this one is a SCRIPT (importing it runs the journey), so its
// own branches are unreachable to a test, and the Windows ones are unreachable
// to this machine besides.
//
// Windows support here is WRITTEN AND UNIT-TESTED, NEVER EXECUTED. The run says
// so on its own banner. A green soak that quietly implied a platform had been
// proven would be worse than not supporting it.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dumpDom } from './harness.mjs';
import { findChrome } from '../tools/chrome.mjs';
import { isPortOpen } from '../cli/port-conflict.mjs';
import { injectBeforeBodyEnd, locateSlide, sectionBodies } from '../tools/deck-html.mjs';
import { ffprobeArgs, TAIL_SECONDS } from '../tools/video.mjs';
import {
  cliCommand, npmCommand, gitFileUrl, narrator, narrateArgs, unverifiedPlatform,
} from './soak-platform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.env.DECKLIGHT_SOAK_KEEP === '1';
/**
 * A decklight that actually shipped, for the cross-version upgrade leg.
 *
 * Pinned rather than `@latest` on purpose: `latest` is usually the version in
 * this working tree, and upgrading a deck that is already current proves
 * nothing. Bump it when this stops being an interesting ancestor — 0.2.0 is
 * one THEME_BROWSE#SPLIT ago, so its decks carry themes this build no longer
 * ships, which is the harder half of the upgrade.
 */
const OLDER_RELEASE = '0.2.0';
const TOTAL = 50;

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

function sh(argv, { cwd = PROJECT, timeout = 120000, allowFail = false, shell = false } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: env(), encoding: 'utf8', timeout, shell });
  const out = { kind: 'cmd', argv, cwd, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  out.all = out.stdout + out.stderr;
  ctx = out;
  if (r.error?.code === 'ETIMEDOUT') throw new SoakFail(`exceeded ${timeout / 1000}s`);
  must(!RAW.test(out.all), 'a command printed a raw ENOENT or an internal stack trace');
  if (!allowFail) must(r.status === 0, `expected exit 0, got ${r.status}`);
  return out;
}

/** The installed CLI — the `.cmd` shim on Windows, which needs a shell. */
const dl = (args, opts) => sh([DL.bin, ...args], { ...opts, shell: DL.shell });

// ── servers ────────────────────────────────────────────────────────────────

const kids = new Set();
const ports = new Set();

/**
 * Spawn a server on --port 0 and learn its port from the line it prints. The
 * port is never guessed: `author` plans its child's URL with a literal 0, so
 * the caller passes the SPECIFIC line to match rather than a bare 127.0.0.1:N.
 */
function startServer(args, re, { timeoutMs = 20000 } = {}) {
  const argv = [DL.bin, ...args];
  const child = spawn(argv[0], argv.slice(1),
    { cwd: PROJECT, env: env(), stdio: ['pipe', 'pipe', 'pipe'], shell: DL.shell });
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

/**
 * How loud a file actually is, in dB — ffmpeg's own measurement.
 *
 * The difference between "there is an audio stream" and "there is a voice on
 * it" is the whole question here: a silent render still carries a track, by
 * design, so a stream count can never tell the two apart. Digital silence
 * measures around -91 dB (or -inf); speech lands tens of dB above that.
 */
function meanVolumeDb(file) {
  const r = sh(['ffmpeg', '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { allowFail: true });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.all);
  must(m, `ffmpeg reported no mean_volume for ${file}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
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

/**
 * A build-time transform (SPEC EXTENSIONS_TRANSFORMS): HTML in, HTML out. It
 * leaves a marker rather than transforming anything real, because what is under
 * test is that decklight fetched, pinned, installed and RAN somebody else's
 * Node code — not what the code did.
 */
const TRANSFORM_MJS = 'export default async function transform(html) {\n'
  + '  return html.replace("</body>", "<!-- soak-transform ran -->\\n</body>");\n'
  + '}\n';

/**
 * A presenter plugin (SPEC PRESENT#PLUGINS): two files, and the whole point is
 * where they do NOT go. It is chrome — it renders in a sandboxed frame with an
 * opaque origin, `present` layers it on at serve time, and `bundle` cannot see
 * it, so a deck someone else opens is the same deck whatever this machine has
 * installed.
 */
const PLUGIN_JSON = `${JSON.stringify({
  name: 'soak-timer',
  title: 'Soak Timer',
  slot: 'corner-br',
  needs: ['position', 'notes'],
  version: '1.0.0',
  description: 'counts slides; chrome, never in the deck',
}, null, 2)}\n`;
// Nothing here reaches for the stage or the notes DOM — `needs: ["notes"]` is
// how a plugin asks, and the lint refuses the other route.
const PLUGIN_JS = 'decklight.on(function (state) {\n'
  + "  document.body.textContent = 'soak-timer ' + state.index + '/' + state.total;\n"
  + '});\n';

/** An import adapter and a speech engine: the two pinned kinds nothing else covers. */
const IMPORTER_MJS = 'export default async function importDeck() {\n'
  + "  return { slides: [{ html: '<h1>Soak</h1>' }] };\n"
  + '}\n';
const ENGINE_MJS = 'export default function createEngine() {\n'
  + "  return { async synth() { throw new Error('the soak never speaks'); } };\n"
  + '}\n';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The marketplace fixture: a real git repo, cloned over file:// like any remote. */
function buildMarket() {
  mkdirSync(join(MARKET, '.decklight'), { recursive: true });
  mkdirSync(join(MARKET, 'templates'), { recursive: true });
  mkdirSync(join(MARKET, 'transforms'), { recursive: true });
  mkdirSync(join(MARKET, 'plugins', 'soak-timer'), { recursive: true });
  mkdirSync(join(MARKET, 'themes'), { recursive: true });
  mkdirSync(join(MARKET, 'importers', 'soak-importer'), { recursive: true });
  mkdirSync(join(MARKET, 'engines'), { recursive: true });
  writeFileSync(join(MARKET, 'transforms', 'marker.mjs'), TRANSFORM_MJS);
  writeFileSync(join(MARKET, 'plugins', 'soak-timer', 'plugin.json'), PLUGIN_JSON);
  writeFileSync(join(MARKET, 'plugins', 'soak-timer', 'plugin.js'), PLUGIN_JS);
  writeFileSync(join(MARKET, 'importers', 'soak-importer', 'importer.mjs'), IMPORTER_MJS);
  writeFileSync(join(MARKET, 'engines', 'soak-engine.mjs'), ENGINE_MJS);
  // A real theme, not a hand-written one: the token contract is 57 required
  // tokens and a set of contrast gates, and a fixture that drifts out of it
  // would fail the theme step for a reason that has nothing to do with the
  // marketplace path being tested.
  copyFileSync(join(root, 'themes', 'aurora.css'), join(MARKET, 'themes', 'soak-theme.css'));
  writeFileSync(join(MARKET, '.decklight', 'marketplace.json'), `${JSON.stringify({
    name: 'soak-market',
    description: "the soak's own catalog",
    entries: [{
      name: 'soak-pitch',
      type: 'template',
      source: './templates/soak-pitch.html',
      description: 'a two-slide pitch',
    }, {
      // Node code, so it carries the digest of the module's bytes and installs
      // only against it (SPEC UNIT_PINNING).
      name: 'soak-transform',
      type: 'transform',
      source: './transforms/marker.mjs',
      apiVersion: 1,
      sha256: sha256(TRANSFORM_MJS),
      description: 'leaves a marker in the bundle',
    }, {
      // The same module with NO pin, and with a WRONG one. Both must be
      // refused, and at different moments: no pin before anything is read, a
      // bad pin after the read and before any write.
      name: 'soak-unpinned',
      type: 'transform',
      source: './transforms/marker.mjs',
      apiVersion: 1,
      description: 'must never install',
    }, {
      name: 'soak-badpin',
      type: 'transform',
      source: './transforms/marker.mjs',
      apiVersion: 1,
      sha256: 'b'.repeat(64),
      description: 'must never install',
    }, {
      // A reference, not a payload (SPEC VOICE_UNITS): no `source` at all, so
      // installing it fetches nothing. The one add that works offline.
      name: 'soak-voice',
      type: 'voice',
      engine: 'elevenlabs',
      voiceId: 'soak-voice-id',
      description: 'a pointer, never a model',
    }, {
      // Presenter chrome — a directory of two files, and the one unit kind
      // whose whole contract is about where it does NOT end up.
      name: 'soak-timer',
      type: 'plugin',
      source: './plugins/soak-timer',
      description: 'a timer in the corner',
    }, {
      // The kind the author server installs into a DECK rather than into the
      // library, and the one marketplace consumer #289 left untested.
      name: 'soak-theme',
      type: 'theme',
      source: './themes/soak-theme.css',
      description: 'a theme that passes the contract',
    }, {
      // The remaining three kinds, so `list` and `remove` are exercised across
      // all six rather than across the three this journey happened to install.
      // An agent is a DESCRIPTOR (SPEC AGENT_UNITS) — no source, so no code.
      name: 'soak-agent',
      type: 'agent',
      bin: 'soak-agent',
      args: ['-p', '{prompt}'],
      description: 'a descriptor, never code',
    }, {
      name: 'soak-importer',
      type: 'importer',
      source: './importers/soak-importer',
      extensions: ['.soak'],
      apiVersion: 1,
      sha256: sha256(IMPORTER_MJS),
      description: 'an adapter for a format decklight cannot read',
    }, {
      name: 'soak-engine',
      type: 'engine',
      source: './engines/soak-engine.mjs',
      apiVersion: 1,
      capability: 'tts',
      sha256: sha256(ENGINE_MJS),
      description: 'a speech engine that never speaks',
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
const HAVE_FFMPEG = have('ffmpeg', '-version') && have('ffprobe', '-version');
// An offline speech synthesiser to MAKE narration with — not decklight's own
// TTS, which needs an engine and a key. macOS ships `say`; where there is none,
// the narrated leg skips rather than pretending silence is a voice.
const VOICE = (() => {
  const n = narrator();
  if (!n) return null;
  const [bin, args] = narrateArgs(process.platform, join(tmpdir(), `decklight-soak-probe.${n.ext}`), 'probe');
  return spawnSync(bin, args, { stdio: 'ignore', timeout: 30000 }).status === 0 ? n : null;
})();
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
const NPM = npmCommand();
let tarball;
let installedThemes = 0;
let authorSrv = null;
let failed = false;

console.log(`decklight soak — ${version}, into "${PROJECT}"`);
console.log(`  ${process.platform} · chrome ${HAVE_CHROME ? 'yes' : 'no'} · network ${HAVE_NET ? 'yes' : 'no'}`
  + ` · ffmpeg ${HAVE_FFMPEG ? 'yes' : 'no'} · voice ${VOICE ? VOICE.kind : 'no'}`);
// Windows support here was written and unit-tested (test/soak-platform.test.mjs)
// and has never been EXECUTED — there is no Windows machine behind it. A green
// run that quietly implied otherwise would be worse than no run at all.
if (unverifiedPlatform()) {
  console.log('  NOTE: this platform\'s support has never been run — a failure here may be the soak, not decklight');
}
console.log('');

try {
  // ── install ──────────────────────────────────────────────────────────────
  await step('the repo packs into a tarball', () => {
    sh([NPM.bin, 'run', 'build'], { cwd: root, timeout: 300000, shell: NPM.shell });
    const out = sh([NPM.bin, 'pack', '--pack-destination', PACK], { cwd: root, timeout: 300000, shell: NPM.shell });
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
    sh([NPM.bin, 'install', tarball, '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock'],
      { timeout: 300000, shell: NPM.shell });
    DL = cliCommand(PROJECT);
    must(existsSync(DL.bin), `${DL.bin} is missing — the bin field or files: regressed`);
    installedThemes = readdirSync(join(PROJECT, 'node_modules', 'decklight', 'themes'))
      .filter((f) => f.endsWith('.css')).length;
    for (const f of ['dist/decklight.js', 'dist/decklight.css', 'themes/aurora.css', 'SPEC.md']) {
      must(existsSync(join(PROJECT, 'node_modules', 'decklight', f)), `the tarball is missing ${f}`);
    }
  });

  await step('the installed bin reports its version', () => {
    const r = dl(['--version']);
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

  await step('the authoring skill installs into the project', () => {
    // `init --no-skill` skipped it, so this is the command on its own. The
    // skill ships inside every scaffolded deck and is the first thing an agent
    // reads, which makes its front matter a claim about the package — and one
    // that has gone stale twice (test/doc-rot.test.mjs). Here it is checked
    // against the INSTALLED tree rather than against the working copy.
    const r = dl(['skills', 'claude']);
    must(/installed the Decklight skill/.test(r.all), `skills said: ${r.all}`);
    const skill = join(PROJECT, '.claude', 'skills', 'decklight', 'SKILL.md');
    must(existsSync(skill), 'no SKILL.md landed in the project');
    must(existsSync(join(PROJECT, '.claude', 'skills', 'decklight', 'reference.md')),
      'the skill lost the reference it points at');
    const text = readFileSync(skill, 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    must(front, 'the skill has no front matter — an agent indexes it by that');
    must(/^name: decklight$/m.test(front[1]), 'the skill does not name itself');
    const claimed = /(\d+) built-in themes/.exec(front[1]);
    must(claimed, "the skill's description no longer counts the themes");
    const shipped = readdirSync(join(PROJECT, 'node_modules', 'decklight', 'themes'))
      .filter((f) => f.endsWith('.css')).length;
    must(Number(claimed[1]) === shipped,
      `the skill advertises ${claimed[1]} themes and the package ships ${shipped}`);
  });

  await step('the ingredients label vouches for the runtime', () => {
    const r = dl(['present', 'deck.html', '--check']);
    must(r.all.includes('identical to this install'),
      'the label does not say the runtime is identical to this install (the 0.3.0 near-miss)');
    must(/0 unaccounted script blocks/.test(r.all), 'the deck carries unaccounted script');
    must(/0 inline handlers/.test(r.all), 'the deck carries inline handlers');
  });

  // ── the other way in: an existing deck ───────────────────────────────────
  // This leg is where TWO of the three 0.3.0 bugs actually lived, and neither
  // was reachable from inside the repo: `import` crashed with a raw ENOENT
  // whenever the path had a space in it, and the deck it wrote reported its
  // runtime as DIFFERING from the install that had just written it — a hash
  // divergence, invisible to a render harness because the deck renders fine.
  await step('an existing deck is brought across', () => {
    // The fixture is copied in under a name WITH A SPACE: the input path is the
    // other half of the space problem, beside the install path everything here
    // already runs from.
    copyFileSync(join(root, 'test', 'fixtures', 'sample.pptx'), join(PROJECT, 'Q3 review.pptx'));
    const r = dl(['import', 'Q3 review.pptx']);
    // The output name is SLUGGED from the source, not copied from it: a deck
    // called "Q3 review.pptx" lands as q3-review.html. Pinned rather than
    // worked around — it is what a user will look for on disk.
    const out = join(PROJECT, 'q3-review.html');
    must(existsSync(out), `import wrote no deck at ${out} — it said: ${r.all}`);
    must(!existsSync(join(PROJECT, 'Q3 review.html')), 'import stopped slugging the output name');
    const html = readFileSync(out, 'utf8');
    must(sectionBodies(html).length >= 3, `expected the fixture's slides, got ${sectionBodies(html).length}`);
    must(/<h1[^>]*>/.test(html), 'the title slide did not come across as an h1');
    must(/<aside class="notes">/.test(html), 'speaker notes did not come across');
    must(/src="data:image\//.test(html), 'the image was not inlined — the deck is not self-contained');
  });

  await step("the imported deck's runtime is this install's", () => {
    // THE assertion this leg exists for. 0.3.0 shipped an `import` that inlined
    // the runtime through its own copy of a transform which escaped `</script`
    // but not `<!--`, so every imported deck rendered perfectly and hashed
    // differently. Only the label can see that.
    const r = dl(['present', 'q3-review.html', '--check']);
    must(r.all.includes('identical to this install'),
      'an imported deck reports a runtime that is not this install — the 0.3.0 bug, exactly');
    must(/0 unaccounted script blocks/.test(r.all), 'the imported deck carries unaccounted script');
    must(/0 inline handlers/.test(r.all), 'the imported deck carries inline handlers');
  });

  await step('the imported deck renders', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    const dom = dumpDom(pathToFileURL(join(PROJECT, 'q3-review.html')).href,
      { budget: 8000, quietStderr: true, who: 'soak', timeout: 60000 });
    mounted(dom, 3);
    return undefined;
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
    const r = dl(['marketplace', 'add', gitFileUrl(MARKET)]);
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

  await step('a voice installs offline, as a pointer', () => {
    // The one add that fetches nothing: a voice entry carries no `source`, so
    // there is no code path by which a model could arrive (SPEC VOICE_UNITS).
    dl(['voice', 'add', 'soak-voice@soak-market']);
    const ref = JSON.parse(readFileSync(join(HOME, 'voices', 'soak-voice.json'), 'utf8'));
    must(ref.engine === 'elevenlabs' && ref.voiceId === 'soak-voice-id', `the pointer says ${JSON.stringify(ref)}`);
    must(!('source' in ref), 'something that looks like a payload survived into the library');
  });

  await step('the admission gate lints, loads, and prints the pin', () => {
    // `extension check` is what a marketplace runs before admitting a
    // transform, and the digest it prints is the `sha256` the catalog entry
    // carries — so this asserts the gate and the pin are the SAME number. If
    // they ever drift, every install below is pinned to something the gate
    // never saw.
    const src = join(MARKET, 'transforms', 'marker.mjs');
    // The lint half needs no browser: a module that fetches is refused before
    // anything is rendered, which is why this assertion runs everywhere.
    const hostile = join(SPACE, 'hostile.mjs');
    writeFileSync(hostile, 'export default async (h) => (await fetch("http://x")).text();\n');
    const no = dl(['extension', 'check', hostile], { allowFail: true });
    must(no.code !== 0, 'a transform that calls fetch() was admitted');
    must(/fetch/.test(no.all), `the refusal does not name what it found: ${no.all}`);

    if (!HAVE_CHROME) return { skip: 'no Chrome — the load half of the gate cannot run' };
    const r = dl(['extension', 'check', src]);
    must(/lints clean/.test(r.all), `the gate did not pass a clean transform: ${r.all}`);
    const printed = /sha256: ([0-9a-f]{64})/.exec(r.all);
    must(printed, 'the gate printed no digest — there is nothing for a catalog to pin to');
    must(printed[1] === sha256(TRANSFORM_MJS),
      'the digest the gate prints is not the one the catalog pins');
    return undefined;
  });

  await step('every unit kind installs from the catalog', () => {
    // The three the journey does not otherwise reach. An agent is a descriptor
    // and installs offline; an importer and an engine are Node code and install
    // only against their pins — the same UNIT_PINNING gate the step below
    // proves the refusals of.
    dl(['agent', 'add', 'soak-agent@soak-market']);
    dl(['importer', 'add', 'soak-importer@soak-market']);
    dl(['engine', 'add', 'soak-engine@soak-market']);
    for (const [dir, file] of [['agents', 'soak-agent.json'], ['importers', join('soak-importer', 'importer.mjs')],
      ['engines', 'soak-engine.mjs']]) {
      must(existsSync(join(HOME, dir, file)), `${dir}/${file} did not land in the library`);
    }
    const descriptor = JSON.parse(readFileSync(join(HOME, 'agents', 'soak-agent.json'), 'utf8'));
    must(descriptor.bin === 'soak-agent' && descriptor.args.includes('{prompt}'),
      `the agent descriptor says ${JSON.stringify(descriptor)}`);
    must(readFileSync(join(HOME, 'engines', 'soak-engine.mjs'), 'utf8') === ENGINE_MJS,
      'the installed engine differs from the bytes its pin covered');
  });

  await step('code installs only against its digest', () => {
    // SPEC UNIT_PINNING, both refusals — and they land at different moments: no
    // pin is refused before anything is read, a wrong pin after the read and
    // before any write, so neither can leave a half-installed unit behind.
    const unpinned = dl(['transform', 'add', 'soak-unpinned@soak-market'], { allowFail: true });
    must(unpinned.code !== 0, 'an unpinned transform installed');
    must(/carries no sha256/.test(unpinned.all), `the refusal does not name the pin: ${unpinned.all}`);

    const bad = dl(['transform', 'add', 'soak-badpin@soak-market'], { allowFail: true });
    must(bad.code !== 0, 'a transform whose bytes miss its pin installed');
    must(/does not match the catalog's pin/.test(bad.all), `the refusal does not name the mismatch: ${bad.all}`);
    must(!existsSync(join(HOME, 'transforms', 'soak-badpin.mjs')), 'a refused install still wrote a file');

    dl(['transform', 'add', 'soak-transform@soak-market']);
    must(existsSync(join(HOME, 'transforms', 'soak-transform.mjs')), 'the pinned transform did not install');
  });

  await step('a second add refreshes rather than duplicating', () => {
    // Every run so far has had a fresh DECKLIGHT_HOME; a real one accumulates.
    const again = dl(['marketplace', 'add', gitFileUrl(MARKET)]);
    must(/refreshed soak-market/.test(again.all), `re-adding said: ${again.stdout}`);
    dl(['template', 'add', 'soak-pitch@soak-market']);   // re-installing a unit is the update path
    // And init will not quietly clobber the deck this journey has been editing.
    const clobber = dl(['init', 'Second Deck', '-o', 'deck.html'], { allowFail: true });
    must(clobber.code !== 0, 'init overwrote an existing deck');
    must(/decklight upgrade/.test(clobber.all), 'the refusal does not name what to do instead');
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

  await step('a theme installs into the deck through the author server', async () => {
    // The Browse path (`POST /edit/theme/add`) — the one marketplace consumer
    // the rest of this journey skips, and exactly what #289 rewrote when it
    // moved entry resolution into a checkout. A theme is the only kind that
    // installs into the DECK rather than into the library.
    const before = deck();
    const wrong = await postJson(authorSrv.base, '/edit/theme/add', { ref: 'soak-pitch@soak-market' });
    must(wrong.status === 400, `a template was accepted as a theme (${wrong.status})`);
    must(/not a theme/.test(wrong.body?.error ?? ''), `the refusal says: ${wrong.body?.error}`);
    must(deck() === before, 'a refused theme install touched the deck');

    const ok = await postJson(authorSrv.base, '/edit/theme/add', { ref: 'soak-theme@soak-market' });
    must(ok.status === 200, `theme add returned ${ok.status}: ${JSON.stringify(ok.body)}`);
    must(ok.body?.name === 'soak-theme' && ok.body?.from === 'soak-theme@soak-market',
      `the response says ${JSON.stringify(ok.body)}`);
    must(/<style data-theme="soak-theme"/.test(deck()), 'the theme did not land in the deck');
    // POLLED, not read once. The route logs BEFORE it responds, but the log
    // reaches this process over a pipe — so a response can arrive before the
    // parent's `data` event has fired, and reading the buffer immediately is a
    // race this step lost on its third run. Every other server assertion here
    // already waits; this one was written as if stdout were synchronous.
    await until('the server to say where the theme came from',
      () => /theme: installed soak-theme from soak-theme@soak-market/.test(authorSrv.log()),
      { ms: 5000 });

    // And back out again: an install goes on the same undo stack as any other
    // edit, which is both the claim in the route and how this step leaves the
    // deck exactly as the twenty steps after it expect to find it.
    const undo = await postJson(authorSrv.base, '/edit/undo', {});
    must(undo.status === 200, `undo returned ${undo.status}`);
    must(deck() === before, 'Z did not take the theme install back');
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

  await step('restore walks the history back, and forward again', () => {
    // The author leg built real history and nothing has used it. `restore` is
    // the way back to any of it, and its promise is that going back is not
    // destructive: the version is written as a NEW commit on top, so
    // overshooting costs nothing — which is also what lets this step put the
    // deck back exactly as it found it.
    const list = dl(['restore', 'deck.html']);
    const commits = git(['rev-list', 'HEAD']).trim().split('\n').filter(Boolean);
    must(commits.length >= 3, `only ${commits.length} commits to walk back through`);
    must(list.all.includes(commits[0].slice(0, 7)), 'the listing does not name the tip');
    const first = commits.at(-1);

    const tip = deck();
    dl(['restore', 'deck.html', first]);
    must(sectionBodies(deck()).length === 2, 'the deck did not go back to what init wrote');
    must(!deck().includes('Soak slide'), 'the slide added during the session survived the restore');
    const back = git(['rev-list', 'HEAD']).trim().split('\n').filter(Boolean);
    must(back.length === commits.length + 1, 'restoring did not commit — history was rewritten');
    must(back.includes(commits[0]), 'the commit restored away from is gone from the history');

    dl(['restore', 'deck.html', commits[0]]);
    must(deck() === tip, 'restoring forward did not put the deck back');
    // Scoped to the deck: restore touches that file and nothing else, and by
    // now the project also holds an installed skill and an imported deck that
    // were never meant to be committed.
    must(git(['status', '--porcelain', '--', 'deck.html']).trim() === '',
      'restore left the deck uncommitted');
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

  await step('a deck from an older decklight upgrades', () => {
    if (!HAVE_NET) return { skip: 'no network — the older release could not be installed' };
    // The step above makes a deck stale by editing its runtime block, which
    // proves the label NOTICES. This is the real thing: a deck scaffolded by a
    // decklight that shipped, upgraded by the one in this tarball. Nothing
    // else in the repo tests across versions, and `upgrade` exists for exactly
    // this — a deck written months ago, opened today.
    const oldProject = join(SPACE, 'old project');   // a space here too
    mkdirSync(oldProject, { recursive: true });
    writeFileSync(join(oldProject, 'package.json'), `${JSON.stringify({
      name: 'decklight-soak-old', private: true, version: '0.0.0',
    }, null, 2)}\n`);
    // A REAL published release, pinned rather than `@latest`: latest is often
    // the version in this working tree, and a deck that is already current
    // proves nothing. Bump it when 0.2.0 stops being an interesting ancestor.
    const dep = sh([NPM.bin, 'install', `decklight@${OLDER_RELEASE}`, '--omit=optional',
      '--no-audit', '--no-fund', '--no-package-lock'],
    { cwd: oldProject, timeout: 300000, allowFail: true, shell: NPM.shell });
    if (dep.code !== 0) return { skip: `decklight@${OLDER_RELEASE} would not install` };

    const oldCli = cliCommand(oldProject);
    must(existsSync(oldCli.bin), `decklight@${OLDER_RELEASE} installed no bin`);
    sh([oldCli.bin, 'init', 'Old Deck'], { cwd: oldProject, shell: oldCli.shell });
    const scaffolded = join(oldProject, 'deck.html');
    must(existsSync(scaffolded), `decklight@${OLDER_RELEASE} scaffolded no deck`);

    const aged = join(PROJECT, 'from-an-older-decklight.html');
    copyFileSync(scaffolded, aged);
    const themesThen = (readFileSync(aged, 'utf8').match(/<style data-theme="/g) ?? []).length;
    must(themesThen > 0, 'the older deck inlined no themes');

    // This install must SEE that the deck is not its own.
    const before = dl(['present', 'from-an-older-decklight.html', '--check'], { allowFail: true });
    must(/DIFFERS from this install/.test(before.all),
      `a deck from ${OLDER_RELEASE} was not reported as differing from this build: ${before.all}`);

    const up = dl(['upgrade', 'from-an-older-decklight.html']);
    const after = dl(['present', 'from-an-older-decklight.html', '--check']);
    must(after.all.includes('identical to this install'),
      `upgrade did not bring a ${OLDER_RELEASE} deck up to this build: ${after.all}`);

    // What the author wrote survives, and so does every theme they had — even
    // the ones this decklight no longer ships. 0.2.0 inlined 62; the packs
    // THEME_BROWSE#SPLIT moved to the marketplace are kept as they were, with a
    // warning naming them, rather than silently dropped (SPEC PRESENTING).
    const now = readFileSync(aged, 'utf8');
    must(/<title>Old Deck<\/title>/.test(now), 'the deck lost its title');
    const themesNow = (now.match(/<style data-theme="/g) ?? []).length;
    must(themesNow === themesThen,
      `upgrade changed the theme count (${themesThen} → ${themesNow}) — a theme it no longer ships must be kept, not dropped`);
    if (themesThen > installedThemes) {
      must(/not in this install|no longer|kept/i.test(up.all),
        `upgrade kept ${themesThen - installedThemes} theme(s) this build does not ship without saying so: ${up.all}`);
    }
    return undefined;
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

  await step('a presenter plugin is yours, not the deck\'s', () => {
    // A plugin is the one thing decklight installs that is deliberately NOT
    // part of any deck: it is your chrome, layered on at serve time, and a deck
    // you send someone plays the same whatever you have installed. The library
    // is the whole boundary, so this step is about where the files land.
    const check = dl(['plugin', 'check', join(MARKET, 'plugins', 'soak-timer')]);
    must(/soak-timer — corner-br/.test(check.all), `plugin check said: ${check.all}`);
    must(/bundle will not/.test(check.all), 'the check does not state the boundary it enforces');

    const add = dl(['plugin', 'add', 'soak-timer@soak-market']);
    must(/it is yours, not the deck's/.test(add.all), `plugin add said: ${add.all}`);
    must(/reads your speaker notes/.test(add.all),
      'a plugin that declared needs: ["notes"] was installed without saying so');
    const dir = join(HOME, 'plugins', 'soak-timer');
    must(existsSync(join(dir, 'plugin.json')) && existsSync(join(dir, 'plugin.js')),
      'the plugin did not land in the library');
    must(!deck().includes('soak-timer'), 'installing a plugin touched the deck');

    const list = dl(['plugin', 'list']);
    must(/soak-timer/.test(list.all) && /your speaker notes/.test(list.all),
      `plugin list said: ${list.all}`);
  });

  await step('present layers the chrome on, and bundle never sees it', async () => {
    // The asymmetry in one step. `present` injects the plugin into what it
    // SERVES — the file on disk is untouched — and a bundle made a moment later
    // does not carry a byte of it.
    const before = statSync(join(PROJECT, 'linked.html'));
    const srv = await startServer(['present', 'linked.html', '--port', '0'], /http:\/\/127\.0\.0\.1:(\d+)/,
      { timeoutMs: 15000 });
    await until('the chrome line', () => /chrome: soak-timer/.test(srv.log()), { ms: 5000 });
    must(/chrome: soak-timer \(corner-br\) — yours, not in the deck/.test(srv.log()),
      `present said: ${srv.log()}`);
    must(/reads your speaker notes/.test(srv.log()),
      'the plugin reading notes was not reported under the label');
    must(!/ingredients[\s\S]*soak-timer/.test(srv.log().split('chrome:')[0]),
      'a plugin was counted in the ingredients label — the label describes the FILE');

    const served = await (await get(srv.base, '/')).text();
    must(served.includes('soak-timer'), 'present did not layer the chrome on');
    const onDisk = readFileSync(join(PROJECT, 'linked.html'), 'utf8');
    must(!onDisk.includes('soak-timer'), 'present wrote the chrome into the deck');
    const after = statSync(join(PROJECT, 'linked.html'));
    must(before.size === after.size && before.mtimeMs === after.mtimeMs, 'present touched the deck');

    srv.child.kill('SIGTERM');
    must(await waitExit(srv.child, 5000), 'present did not exit on SIGTERM');
    must((await isPortOpen(srv.port)) === false, 'the present port is still bound');

    // And the half that would travel: bundle with the plugin installed.
    dl(['bundle', 'linked.html', '-o', 'unplugged.html']);
    must(!readFileSync(join(PROJECT, 'unplugged.html'), 'utf8').includes('soak-timer'),
      'a bundle carried a presenter plugin — it would travel with the deck');
  });

  await step('an installed transform runs at bundle time', () => {
    // The one place decklight runs somebody else's Node code, unsandboxed, at
    // author privilege (EXTENSIONS#LOADER). Installing it was an earlier step's
    // business; this is whether it actually RAN.
    const r = dl(['bundle', 'linked.html', '--transform', 'soak-transform', '-o', 'transformed.html']);
    must(readFileSync(join(PROJECT, 'transformed.html'), 'utf8').includes('<!-- soak-transform ran -->'),
      'the transform did not touch the output');
    must(/soak-transform/.test(r.all), 'the summary does not say which transform ran');
    const ghost = dl(['bundle', 'linked.html', '--transform', 'not-installed', '-o', 'x.html'], { allowFail: true });
    must(ghost.code !== 0, 'bundle accepted a transform that is not installed');
  });

  await step('a deck prints to PDF', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    // Chrome again, but reached the way a user reaches it — and handed paths
    // with spaces on both sides, which is the shape the #275 crash had.
    dl(['pdf', 'linked bundle.html', '-o', 'slides out.pdf'], { timeout: 180000 });
    const pdf = readFileSync(join(PROJECT, 'slides out.pdf'));
    must(pdf.subarray(0, 5).toString() === '%PDF-', 'the output is not a PDF');
    must(pdf.length > 10_000, `the PDF is suspiciously small (${pdf.length} B)`);
    return undefined;
  });

  await step('publish pushes a site without touching the tree', () => {
    // A bare repo IS a git remote, so the whole plumbing — hash-object, mktree,
    // commit-tree, push — runs with no network and no GitHub. What is asserted
    // is the promise that makes publish safe to run mid-talk: your working
    // tree, your index and your checked-out branch are never touched.
    const bare = join(SPACE, 'pages.git');
    sh(['git', 'init', '--bare', '-q', bare], { cwd: SPACE });
    sh(['git', 'remote', 'add', 'pages', bare]);
    const branchBefore = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const statusBefore = git(['status', '--porcelain']);

    const r = dl(['publish', 'deck.html', '--remote', 'pages', '--no-sign', '--no-bundle']);
    must(/pushed \w+ → pages refs\/heads\/gh-pages/.test(r.all), `publish said: ${r.all}`);
    // A remote that is not GitHub must not have a Pages URL invented for it.
    must(/remote is not GitHub/.test(r.all), 'publish guessed a Pages URL for a remote that has none');

    const landed = sh(['git', `--git-dir=${bare}`, 'ls-tree', '-r', '--name-only', 'gh-pages'])
      .stdout.split('\n').filter(Boolean);
    must(landed.includes('index.html') && landed.includes('.nojekyll'),
      `the published branch holds ${JSON.stringify(landed)}`);

    must(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === branchBefore, 'publish moved the checked-out branch');
    must(git(['rev-parse', 'HEAD']).trim() === headBefore, 'publish committed on the current branch');
    must(git(['status', '--porcelain']) === statusBefore, 'publish touched the working tree or the index');
  });

  await step('every command answers --help, and refuses by name', () => {
    // The journey exercises a dozen commands; this sweeps the roster. `--help`
    // must exit 0 everywhere, and a bad input must be a NAMED refusal rather
    // than a stack — the one failure convention (#278), across the whole
    // surface rather than the few paths this journey happens to walk. It found
    // `video` answering --help on stderr with exit 1 on its first run (#294).
    for (const cmd of ['init', 'import', 'bundle', 'upgrade', 'pdf', 'present', 'author', 'publish',
      'theme', 'marketplace', 'plugin', 'template', 'skills', 'importer', 'transform', 'engine',
      'voice', 'agent', 'extension', 'restore', 'rec', 'tts', 'lipsync', 'video', 'report-bug', 'associate']) {
      const r = dl([cmd, '--help']);
      must(r.stdout.length > 40, `${cmd} --help printed almost nothing to stdout`);
    }
    for (const [args, want] of [
      [['present', 'nope.html'], /present:/],
      [['import', 'deck.html'], /import:/],
      [['marketplace', 'add', SPACE], /marketplace add:/],
      [['theme', 'check', 'nope.css'], /theme check:/],
      [['template', 'add', 'ghost-unit'], /template add:/],
      [['upgrade', 'nope.html'], /upgrade:/],
    ]) {
      const r = dl(args, { allowFail: true });
      must(r.code !== 0, `decklight ${args.join(' ')} exited 0`);
      must(want.test(r.all), `the refusal for "${args.join(' ')}" is not named: ${r.all.slice(0, 200)}`);
    }
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

  // ── the two capabilities that need more than Node ────────────────────────
  await step('recording says what it needs, before it needs it', () => {
    // The install above is `--omit=optional`, which is what CI does and what
    // most users get — so this is the state a real machine is in the first time
    // it tries to record. The refusal must NAME the missing package and the
    // command that installs it (the ENGINES pattern: offer at the point of
    // failure, not a setup step nobody performs in advance).
    copyFileSync(join(root, 'test', 'fixtures', 'smoke.term.yaml'), join(PROJECT, 'smoke.term.yaml'));
    const r = dl(['rec', 'smoke.term.yaml'], { allowFail: true });
    must(r.code !== 0, 'rec ran without its optional dependencies');
    must(/js-yaml|node-pty/.test(r.all), `the refusal does not name what is missing: ${r.all}`);
    must(/npm install/.test(r.all), 'the refusal does not name the command that fixes it');
  });

  await step('a terminal cast records in a real PTY', () => {
    // node-pty is a native module: on a machine without a toolchain this is a
    // skip, not a failure — but where it DOES install, the cast is recorded by
    // running the commands for real, so the output in a deck is captured rather
    // than typed (SPEC TERMINAL_RECORDINGS).
    const dep = sh([NPM.bin, 'install', 'node-pty', 'js-yaml', '--no-audit', '--no-fund', '--no-package-lock'],
      { timeout: 300000, allowFail: true, shell: NPM.shell });
    if (dep.code !== 0) return { skip: 'node-pty would not install (no build toolchain?)' };

    dl(['rec', 'smoke.term.yaml', '-o', 'demo cast.json'], { timeout: 180000 });
    const cast = JSON.parse(readFileSync(join(PROJECT, 'demo cast.json'), 'utf8'));
    must(Array.isArray(cast.steps) && cast.steps.length === 3, `the cast has ${cast.steps?.length} steps`);
    must(cast.steps[0].cmd.includes('echo "hello decklight"'), 'the first command is not the one scripted');
    // Recorded, not transcribed: the OUTPUT has to be what the shell actually said.
    const out = JSON.stringify(cast.steps[0].out ?? cast.steps[0]);
    must(/hello decklight/.test(out), `the recorded output does not carry the command's real output: ${out.slice(0, 200)}`);
    // And the ANSI colours of step 2 survive as data rather than being stripped.
    must(/\[|\\u001b\[|31m/.test(JSON.stringify(cast.steps[1])), 'the colour escapes did not survive');
    return undefined;
  });

  await step('a silent deck still films, and still carries audio', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    if (!HAVE_FFMPEG) return { skip: 'no ffmpeg/ffprobe (apt install ffmpeg / brew install ffmpeg)' };
    // Chrome AND ffmpeg, driven by the installed bin: the deck is served over
    // loopback rooted at the cwd (never file://), captured frame by frame, and
    // muxed. With no narration every slide holds --hold seconds over silence,
    // so a 2-slide deck at --hold 1 is ~2s — and ffprobe, not decklight, is
    // what vouches for the result.
    writeFileSync(join(PROJECT, 'film.html'), linkedDeck('Filmed'));
    const r = dl(['video', 'film.html', '-o', 'talk out.mp4', '--hold', '1', '--fps', '10'], { timeout: 300000 });
    const mp4 = join(PROJECT, 'talk out.mp4');
    must(existsSync(mp4), 'no mp4 was written');

    // ffprobe, not decklight, is what vouches for the result — and the duration
    // question is asked with decklight's own arg builder, so the soak cannot
    // drift from what the product asks.
    // Slide 2 carries a two-item build, and a silent slide gives every build its
    // own frame at the slide's hold: 1s + (2 builds + the finished slide) × 1s.
    const seconds = Number(sh(['ffprobe', ...ffprobeArgs(mp4)]).stdout.trim());
    must(seconds > 3.4 && seconds < 4.8, `expected ~4s of video, got ${seconds}s`);
    const streams = sh(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_type',
      '-of', 'csv=p=0', mp4]).stdout.trim().split('\n');
    must(streams.some((s) => s.startsWith('h264,video')), `no h264 video stream: ${streams}`);
    // A silent deck still carries an audio track, so the timeline stays
    // continuous when a narrated slide is added later.
    must(streams.some((s) => s.endsWith(',audio')), `no audio stream: ${streams}`);
    // …and that track is SILENT, which is the whole point of this step: the
    // next one is the same deck with a voice on it.
    must(meanVolumeDb(mp4) < -60, 'a deck with no narration produced audible sound');

    // The deck's second slide has a two-item build, and a silent render gives
    // every step its own frame — so there are more frames than slides, and the
    // hold is SPLIT across them, leaving the film exactly as long as its holds.
    must(/frames/.test(r.all), `the render did not step the builds: ${r.all}`);

    // --build-hold paces the build-up frames alone — here, quicker than the
    // slides, which is what it exists for.
    dl(['video', 'film.html', '-o', 'quicker.mp4', '--hold', '1', '--fps', '10', '--build-hold', '0.25'],
      { timeout: 300000 });
    const quicker = Number(sh(['ffprobe', ...ffprobeArgs(join(PROJECT, 'quicker.mp4'))]).stdout.trim());
    must(quicker < seconds - 0.5,
      `--build-hold did not change the build pace (${seconds}s default vs ${quicker}s)`);
    return undefined;
  });

  await step('a narrated deck follows its voice', () => {
    if (!HAVE_CHROME) return { skip: 'no Chrome — install one, or point $CHROME at it' };
    if (!HAVE_FFMPEG) return { skip: 'no ffmpeg/ffprobe (apt install ffmpeg / brew install ffmpeg)' };
    if (!VOICE) return { skip: 'no offline voice to narrate with (macOS `say`, Windows SAPI)' };

    // Narration decklight did not synthesise: a `voiceover/` directory beside
    // the deck with a manifest, which is exactly what `video --voiceover` (or
    // tools/voiceover.mjs) leaves behind. That seam is what lets this run with
    // no TTS engine, no key and no network — the synthesis is a different
    // capability, and this step is about what VIDEO does with the audio.
    const vo = join(PROJECT, 'voiceover');
    mkdirSync(vo, { recursive: true });
    const raw = join(vo, `slide-01.${VOICE.ext}`);
    const m4a = join(vo, 'slide-01.m4a');
    const [vbin, vargs] = narrateArgs(process.platform, raw,
      'Welcome to the soak test. This slide is narrated by a real voice.');
    sh([vbin, ...vargs], { timeout: 120000 });
    sh(['ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-c:a', 'aac', '-b:a', '96k', m4a]);
    rmSync(raw, { force: true });
    // Slide 1 speaks, slide 2 is null — a deck is usually part narrated, and
    // the timeline has to handle both in one pass.
    writeFileSync(join(vo, 'manifest.json'), `${JSON.stringify({
      slides: [{ file: 'slide-01.m4a', hash: 'soak' }, null],
    }, null, 2)}\n`);

    const spoken = Number(sh(['ffprobe', ...ffprobeArgs(m4a)]).stdout.trim());
    must(spoken > 1, `the narration is only ${spoken}s — too short to tell anything from`);

    const out = join(PROJECT, 'narrated talk.mp4');
    const r = dl(['video', 'film.html', '-o', 'narrated talk.mp4', '--hold', '1', '--fps', '10'],
      { timeout: 300000 });
    must(/1 narrated/.test(r.all), `video did not report the narration it found: ${r.all}`);

    // THE assertion: a narrated slide holds for the audio's REAL duration plus
    // the tail, not for --hold. So the film is as long as the voice is, and
    // asserting that against a measured `spoken` means this cannot be satisfied
    // by a fixed guess.
    const seconds = Number(sh(['ffprobe', ...ffprobeArgs(out)]).stdout.trim());
    // Slide 1 is narrated: one still, its audio + the tail. Slide 2 is silent
    // and carries a two-item build, so it is three frames of --hold — narrated
    // slides are timed by their voice, silent ones by the knob, in one film.
    const silent = 1 * 3;
    const expected = spoken + TAIL_SECONDS + silent;
    must(Math.abs(seconds - expected) < 0.75,
      `expected ~${expected.toFixed(2)}s (${spoken.toFixed(2)}s of voice + ${TAIL_SECONDS}s tail`
      + ` + ${silent}s of built slide), got ${seconds}s`);
    // And the track is audible. The silent render above measures below -60 dB;
    // if this one did too, the voice never reached the mux.
    const db = meanVolumeDb(out);
    must(db > -50, `the narrated mp4 is silent (mean volume ${db} dB) — the voice never reached the mux`);
    return undefined;
  });

  await step('every kind lists what it installed, and removes it', () => {
    // Only `add` was ever exercised. These are the two verbs a user reaches for
    // when something is wrong, and the library is the one place decklight
    // writes that a release could quietly break the shape of.
    const units = [['template', 'soak-pitch'], ['transform', 'soak-transform'], ['voice', 'soak-voice'],
      ['agent', 'soak-agent'], ['importer', 'soak-importer'], ['engine', 'soak-engine']];
    for (const [kind, name] of units) {
      const listed = dl([kind, 'list']);
      must(listed.all.includes(name), `${kind} list does not name ${name}: ${listed.all}`);
      must(listed.all.includes('soak-market'), `${kind} list forgot where ${name} came from`);
    }
    for (const [kind, name] of units) {
      const gone = dl([kind, 'remove', name]);
      must(new RegExp(`removed ${name}`).test(gone.all), `${kind} remove said: ${gone.all}`);
      must(!dl([kind, 'list']).all.includes(`${name} `), `${name} is still listed after removal`);
    }
    // The plugin library is separate from the unit library, and has the same
    // two verbs over it.
    dl(['plugin', 'remove', 'soak-timer']);
    must(!existsSync(join(HOME, 'plugins', 'soak-timer')), 'the plugin survived its removal');
    must(/no presenter plugins installed/.test(dl(['plugin', 'list']).all),
      'plugin list still reports chrome that is gone');
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
