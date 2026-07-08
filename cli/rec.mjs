#!/usr/bin/env node
/**
 * decklight-rec — record truthful terminal casts for Decklight decks (SPEC §7.1/§7.2).
 *
 *   decklight rec <script.term.yaml> [-o out.cast.json] [--allow-fail] [--quiet]
 *   decklight refresh <dir | cast.json…> [--allow-fail]
 *
 * How a step boundary is detected (the sentinel technique):
 *   All commands run in ONE persistent PTY shell session. For each step we
 *   write two lines to the PTY: the command itself, then
 *   `printf '<GS>DECKLIGHT:%d:<GS>\n' $?`. The shell doesn't read the second
 *   line until the foreground command has finished, so the moment the
 *   GS-delimited marker shows up in the output stream *is* the step boundary,
 *   and it carries the command's exit code. Terminal echo is switched off
 *   (`stty -echo`) during session setup, so neither the typed command nor the
 *   sentinel line pollutes the captured output — the player re-types commands
 *   itself from the cast. Setup noise (shell banner, stty) is discarded by
 *   waiting for a READY marker before recording begins.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ASCII group separator delimits sentinels — vanishingly unlikely in real
// output. The input we write to the PTY stays pure ASCII (raw control bytes
// would be eaten by ZLE keybindings before setup lands): printf's octal
// escape `\035` generates the GS byte shell-side.
const GS = '\x1d';
const GS_OCTAL = '\\035';
const STEP_MARK = new RegExp(`${GS}DECKLIGHT:(-?\\d+):${GS}`);
const READY_MARK = `${GS}DECKLIGHT-READY${GS}`;

// ---------------------------------------------------------------- utilities

function fail(msg) {
  process.stderr.write(`decklight rec: ${msg}\n`);
  process.exit(1);
}

function loadDeps() {
  let yaml, pty;
  try { yaml = require('js-yaml'); } catch { fail('js-yaml is not installed — run: npm install js-yaml'); }
  try {
    // npm strips the exec bit from node-pty's prebuilt spawn-helper on some
    // installs, which surfaces as a cryptic "posix_spawnp failed". Self-heal.
    const helperDir = path.dirname(require.resolve('node-pty/package.json'));
    const helper = path.join(helperDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) {
      const mode = fs.statSync(helper).mode;
      if (!(mode & 0o111)) fs.chmodSync(helper, mode | 0o755);
    }
    pty = require('node-pty');
  } catch (e) { fail(`node-pty is not installed or failed to load (${e.message}) — run: npm install node-pty`); }
  return { yaml, pty };
}

function expandHome(p) {
  if (!p) return p;
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** `$NAME` (optionally with a suffix like "\n") resolves against the session
 *  env; anything else is a literal. */
function resolveSecret(v, env) {
  const m = v.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
  if (!m) return v;
  const val = env[m[1]];
  if (val === undefined) throw new Error(`secret env var ${m[1]} is not set`);
  return val + v.slice(m[0].length);
}

/**
 * Clamp inter-event gaps to `maxIdle` seconds across a merged, time-sorted
 * event list (outputs and inputs share one clock, so they are clamped
 * together). Events: [{t, …}] — returns the same objects with adjusted `t`.
 */
function clampIdle(events, maxIdle) {
  if (!(maxIdle > 0)) return events;
  let shift = 0;
  let prev = 0;
  for (const ev of events.sort((a, b) => a.t - b.t)) {
    const gap = ev.t - prev;
    if (gap > maxIdle) shift += gap - maxIdle;
    prev = ev.t;
    ev.t = round3(ev.t - shift);
  }
  return events;
}

function shellArgs(shellPath) {
  const base = path.basename(shellPath);
  if (base === 'zsh') return ['-f'];                       // no rc files
  if (base === 'bash') return ['--norc', '--noprofile'];
  return [];
}

function setupLine(shellBase) {
  const common = `stty -echo; printf '${GS_OCTAL}DECKLIGHT-READY${GS_OCTAL}\\n'`;
  if (shellBase === 'zsh') return `unsetopt zle prompt_cr prompt_sp banghist 2>/dev/null; PS1=''; PROMPT=''; PS2=''; PROMPT2=''; ${common}\n`;
  return `PS1=''; PS2=''; ${common}\n`;
}

// ---------------------------------------------------------------- recording

/**
 * Execute every step of a parsed script in one PTY session.
 * Resolves to the cast's `steps` array; rejects on timeout / shell death /
 * (without allowFail) non-zero exits.
 */
export async function recordScript(script, { scriptDir, allowFail = false, log = () => {} }) {
  const { pty } = loadDeps();
  const shellName = script.shell || path.basename(process.env.SHELL || 'zsh');
  const shellPath = shellName.includes('/') ? shellName : `/bin/${shellName}`;
  if (!fs.existsSync(shellPath)) throw new Error(`shell not found: ${shellPath}`);
  const cols = script.cols ?? 100;
  const rows = script.rows ?? 28;
  const base = scriptDir || process.cwd();
  const cwd = script.cwd ? path.resolve(base, expandHome(script.cwd)) : base;
  if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`);

  const redactions = (script.redact || []).map(r => new RegExp(r, 'g'));
  const redact = s => redactions.reduce((acc, re) => acc.replace(re, '▓▓▓'), s);

  // Scrubbed placeholders in a refreshed cast's env must not shadow the
  // operator's real environment (the secret comes back via process.env).
  const scriptEnv = Object.fromEntries(
    Object.entries(script.env || {}).filter(([, v]) => v !== '▓▓▓'));

  const term = pty.spawn(shellPath, shellArgs(shellPath), {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: {
      ...process.env,
      // Automated recording must never hand control to a pager.
      PAGER: 'cat', GIT_PAGER: 'cat', MANPAGER: 'cat',
      ...scriptEnv,
      TERM: 'xterm-256color',
    },
  });

  let buffer = '';
  let onChunk = null;   // (data) => void — active step's collector
  let shellDead = false;
  let onExitCb = null;
  term.onData(d => { buffer += d; if (onChunk) onChunk(d); });
  term.onExit(() => { shellDead = true; if (onExitCb) onExitCb(); });

  const waitFor = (test, timeoutMs, what, isCancelled) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const m = test();
      if (m) return resolve(m);
      if (isCancelled?.()) return reject(new Error('cancelled'));
      if (shellDead) return reject(new Error(`shell died while waiting for ${what}`));
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });

  try {
    // --- setup phase: silence echo & prompts, then discard everything so far
    term.write(setupLine(path.basename(shellPath)));
    await waitFor(() => buffer.includes(READY_MARK), 10_000, 'shell setup');
    buffer = '';

    const sessionEnv = { ...process.env, ...scriptEnv };
    const maxIdle = script.max_idle ?? 2.0;
    const steps = [];
    for (const [idx, step] of (script.steps || []).entries()) {
      // Pure pause step: sleeps for real (session truthfulness — background
      // state may be advancing) and records a timing marker.
      if (step && typeof step.sleep === 'number' && step.cmd === undefined) {
        await new Promise(r => setTimeout(r, step.sleep * 1000));
        steps.push({ sleep: round3(step.sleep) });
        log(`  ✓ (sleep ${step.sleep}s)`);
        continue;
      }
      // YAML gotcha: `cmd: false` / `cmd: 42` parse as scalars — coerce.
      if (step && (typeof step.cmd === 'boolean' || typeof step.cmd === 'number')) step.cmd = String(step.cmd);
      if (!step || typeof step.cmd !== 'string') throw new Error(`step ${idx + 1}: missing "cmd"`);
      const timeoutMs = (step.timeout ?? 60) * 1000;
      const chunks = [];
      const t0 = process.hrtime.bigint();
      let collected = '';
      onChunk = d => {
        collected += d;
        chunks.push([Number(process.hrtime.bigint() - t0) / 1e9, d]);
      };
      // The command runs as a brace group with the sentinel on the group's
      // closing line. Written as two separate lines, a command that reads
      // stdin (read, logins) would consume the queued sentinel line as its
      // input; inside a brace group the shell's parser consumes the middle
      // lines while parsing, so nothing is buffered for the command's stdin —
      // interact sends are the only input it can see. The lone `}` line also
      // makes trailing `#` comments in cmd harmless.
      term.write(`{\n${step.cmd}\n}; printf '${GS_OCTAL}DECKLIGHT:%d:${GS_OCTAL}\\n' $?\n`);

      // interact: watch output, answer prompts (expect/send) — runs alongside
      // the sentinel wait; secrets are sent for real but recorded as ▓▓▓ and
      // added to this step's redaction set.
      const interacts = Array.isArray(step.interact) ? step.interact : [];
      const inputs = [];
      const stepRedactions = [];
      let interactState = { done: interacts.length === 0, error: null, pending: null, cancelled: false };
      if (interacts.length) {
        (async () => {
          let searchFrom = 0;
          try {
            for (const it of interacts) {
              interactState.pending = it.expect;
              const re = new RegExp(it.expect);
              const found = await waitFor(() => {
                const mm = collected.slice(searchFrom).match(re);
                return mm ? { end: searchFrom + mm.index + mm[0].length } : null;
              }, timeoutMs, `expect /${it.expect}/ in step ${idx + 1} (${step.cmd})`, () => interactState.cancelled);
              searchFrom = found.end;
              let text, display;
              if (it.send && typeof it.send === 'object' && 'secret' in it.send) {
                text = resolveSecret(String(it.send.secret), sessionEnv);
                display = '▓▓▓';
                const bare = text.replace(/\r?\n$/, '');
                if (bare) stepRedactions.push(new RegExp(escapeRegExp(bare), 'g'));
              } else {
                text = String(it.send ?? '');
                display = text;
              }
              inputs.push([round3(Number(process.hrtime.bigint() - t0) / 1e9), display]);
              term.write(text);
              interactState.pending = null;
            }
          } catch (e) {
            if (e.message !== 'cancelled') interactState.error = e;
          }
          interactState.done = true;
        })();
      }

      let m;
      try {
        // wait_for: the step only completes once the output matches (useful
        // to fail fast when an expected banner/state never appears).
        if (step.wait_for) {
          await waitFor(() => collected.match(new RegExp(step.wait_for)), timeoutMs,
            `wait_for /${step.wait_for}/ in step ${idx + 1} (${step.cmd})`);
        }
        m = await waitFor(() => collected.match(STEP_MARK), timeoutMs, `step ${idx + 1} (${step.cmd})`);
      } finally { onChunk = null; interactState.cancelled = true; }
      if (interactState.error) throw interactState.error;
      if (!interactState.done && interactState.pending) {
        const err = `step ${idx + 1} exited before expect /${interactState.pending}/ matched: ${step.cmd}`;
        if (!allowFail) throw new Error(err);
        log(`  ⚠ ${err}`);
      }
      const exit = parseInt(m[1], 10);
      const duration = Number(process.hrtime.bigint() - t0) / 1e9;

      // Trim the sentinel (and anything after it) out of the captured chunks.
      const redactStep = s => stepRedactions.reduce((acc, re) => acc.replace(re, '▓▓▓'), redact(s));
      const cut = collected.search(STEP_MARK);
      const kept = [];
      let seen = 0;
      for (const [t, d] of chunks) {
        if (seen + d.length <= cut) { kept.push([round3(t), redactStep(d)]); seen += d.length; }
        else { const part = d.slice(0, Math.max(0, cut - seen)); if (part) kept.push([round3(t), redactStep(part)]); break; }
      }
      // Drop the trailing prompt-less blank the sentinel's own newline leaves.
      const out = normalizeTail(kept);

      // Idle clamping: outputs and inputs share one clock; clamp them jointly.
      const merged = [
        ...out.map(([t, d]) => ({ t, kind: 'o', d })),
        ...inputs.map(([t, d]) => ({ t, kind: 'i', d })),
      ];
      clampIdle(merged, maxIdle);
      const outClamped = merged.filter(e => e.kind === 'o').map(e => [e.t, e.d]);
      const inClamped = merged.filter(e => e.kind === 'i').map(e => [e.t, e.d]);

      steps.push({
        cmd: step.cmd,
        output: outClamped,
        exit,
        duration: round3(duration),
        ...(step.note ? { note: step.note } : {}),
        ...(step.hide ? { hidden: true } : {}),
        ...(step.type_speed ? { typeSpeed: step.type_speed } : {}),
        ...(inClamped.length ? { input: inClamped } : {}),
      });
      log(`  ✓ ${step.cmd}  (exit ${exit}, ${duration.toFixed(2)}s)`);
      if (exit !== 0 && !allowFail) {
        throw new Error(`step ${idx + 1} exited ${exit}: ${step.cmd}  (use --allow-fail to record failures as content)`);
      }
    }
    return steps;
  } finally {
    try { term.write('exit\n'); } catch { /* already dead */ }
    await new Promise(res => { if (shellDead) return res(); onExitCb = res; setTimeout(res, 1500); });
    try { term.kill(); } catch { /* already dead */ }
  }
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function normalizeTail(chunks) {
  // Strip one trailing "\r\n" (or "\n") that precedes the sentinel line.
  for (let i = chunks.length - 1; i >= 0; i--) {
    const [t, d] = chunks[i];
    if (d === '') { chunks.splice(i, 1); continue; }
    const trimmed = d.replace(/\r?\n$/, '');
    if (trimmed === '') chunks.splice(i, 1); else chunks[i] = [t, trimmed];
    break;
  }
  return chunks;
}

/** Literal (non-$ENV) secrets must not leak through the embedded script.
 *  $ENV secrets survive verbatim — they resolve at run time, so --refresh
 *  keeps working; a scrubbed literal cannot be replayed (documented). */
function scrubScript(script) {
  const copy = JSON.parse(JSON.stringify(script));
  for (const st of copy.steps || []) {
    for (const it of st.interact || []) {
      if (it.send && typeof it.send === 'object' && 'secret' in it.send) {
        const v = String(it.send.secret);
        const m = v.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
        if (!m) it.send.secret = '▓▓▓';
        // …and a $NAME secret whose value was inlined in the script's own env
        // block must not ride along either.
        else if (copy.env && m[1] in copy.env) copy.env[m[1]] = '▓▓▓';
      }
    }
  }
  return copy;
}

export function buildCast(script, steps, shellName) {
  return {
    decklightCast: 1,
    meta: {
      shell: shellName,
      cols: script.cols ?? 100,
      rows: script.rows ?? 28,
      recorded: new Date().toISOString(),
      prompt: script.prompt ?? '$ ',
    },
    script: scrubScript(script),
    steps,
  };
}

// ------------------------------------------------------------------- export

/**
 * Flatten a decklight cast into asciicast v2 (NDJSON) for the asciinema
 * ecosystem (asciinema play/upload, agg → GIF, asciinema-player embeds).
 * The prompt and typed command are injected as output events (echo was off
 * during capture); step boundaries become `m` marker events; hidden steps
 * are omitted and sleep steps become pure time gaps.
 */
export function exportAsciicast(cast) {
  const lines = [];
  const recorded = Date.parse(cast.meta?.recorded ?? '');
  lines.push(JSON.stringify({
    version: 2,
    width: cast.meta?.cols ?? 100,
    height: cast.meta?.rows ?? 28,
    ...(Number.isFinite(recorded) ? { timestamp: Math.floor(recorded / 1000) } : {}),
    env: { SHELL: cast.meta?.shell ?? 'sh', TERM: 'xterm-256color' },
  }));
  let t = 0;
  const ev = (kind, data) => lines.push(JSON.stringify([round3(t), kind, data]));
  const prompt = cast.meta?.prompt ?? '$ ';
  for (const step of cast.steps) {
    if (step.hidden) continue;
    if (step.sleep != null) { t += step.sleep; continue; }
    ev('m', step.cmd);
    ev('o', prompt);
    for (const ch of step.cmd) { t += 0.045; ev('o', ch); } // deterministic typing
    t += 0.12;
    ev('o', '\r\n');
    const events = [
      ...(step.output || []).map(([rt, d]) => [rt, d]),
      ...(step.input || []).map(([rt, d]) => [rt, d.replace(/\r?\n$/, '')]),
    ].sort((a, b) => a[0] - b[0]);
    const base = t;
    for (const [rt, d] of events) { t = base + rt; ev('o', d); }
    ev('o', '\r\n');
    t += 0.5; // breathing room between steps
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------ refresh

function castOutputSignature(steps) {
  return JSON.stringify(steps.map(s => s.sleep != null
    ? ['(sleep)', s.sleep]
    : [s.cmd, s.exit, (s.output || []).map(([, d]) => d).join(''), (s.input || []).map(([, d]) => d).join('')]));
}

async function refresh(targets, { allowFail }) {
  const files = [];
  for (const t of targets) {
    const st = fs.statSync(t, { throwIfNoEntry: false });
    if (!st) fail(`no such file or directory: ${t}`);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(t, { recursive: true })) {
        if (String(f).endsWith('.cast.json')) files.push(path.join(t, String(f)));
      }
    } else files.push(t);
  }
  if (!files.length) fail('no .cast.json files found');

  let changed = 0;
  const drifted = [];
  for (const file of files) {
    const cast = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cast.decklightCast !== 1 || !cast.script) { console.log(`  – ${file}: not a decklight cast with an embedded script, skipped`); continue; }
    process.stdout.write(`re-running ${path.basename(file)}…\n`);
    const steps = await recordScript(cast.script, {
      scriptDir: path.dirname(file), allowFail,
      log: m => process.stdout.write(m + '\n'),
    });
    if (castOutputSignature(steps) !== castOutputSignature(cast.steps)) {
      const next = buildCast(cast.script, steps, cast.meta.shell);
      fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n');
      changed += 1; drifted.push(path.basename(file));
    }
  }
  console.log(`\nre-ran ${files.length} script${files.length === 1 ? '' : 's'}, ${changed} cast${changed === 1 ? '' : 's'} changed${changed ? ':' : '.'}`);
  for (const d of drifted) console.log(`  ${d}  (output drift)`);
}

// --------------------------------------------------------------------- main

const HELP = `decklight rec — record terminal casts for Decklight decks

Usage:
  decklight rec <script.term.yaml> [-o out.cast.json] [--allow-fail] [--quiet]
  decklight refresh <dir | cast.json…> [--allow-fail]
  decklight export <cast.json> [-o out.cast]         # asciicast v2

Script format (YAML):
  shell: zsh          # default: $SHELL (rc files are skipped: zsh -f / bash --norc)
  cwd: ~/demo         # default: the script's directory
  cols: 100           # PTY size (default 100x28)
  rows: 28
  env: { KEY: val }   # extra environment
  prompt: "$ "        # cosmetic prompt shown by the player
  redact: ["sk-.+"]   # regexes scrubbed from captured output (▓▓▓)
  max_idle: 2.0       # clamp recorded pauses to this many seconds (default 2.0)
  steps:
    - cmd: export STAGE=demo
      hide: true      # runs in the session, never shown in playback
    - cmd: npx wrangler deploy
      timeout: 120    # seconds (default 60)
      wait_for: "Deployed"   # fail fast unless output matches before exit
      note: optional label for the speaker view
      type_speed: 2   # playback typing-speed multiplier for this step
    - sleep: 1.5      # pure pause (really sleeps; timing marker in play mode)
    - cmd: myapp login
      interact:       # answer interactive prompts (expect/send)
        - expect: "Email: "
          send: "demo@example.com\\n"
        - expect: "Password: "
          send: { secret: "$APP_PASSWORD\\n" }   # sent for real, recorded as ▓▓▓

Notes:
  • Commands run sequentially in ONE shell session; state (cd, vars) carries over.
  • Non-zero exits abort unless --allow-fail; timeouts and shell death always abort.
  • Redaction applies to captured output; secret sends auto-redact their value in
    that step's output and are stored as ▓▓▓ in the cast's input record. Prefer the
    $ENV form — a literal secret is scrubbed from the embedded script, which makes
    that cast non-refreshable.
  • --refresh re-executes the script embedded in each cast and rewrites on drift.
  • export writes asciicast v2 for the asciinema ecosystem — e.g. a GIF for docs:
      decklight export demo.cast.json && agg demo.cast demo.gif
`;

export async function recMain(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const allowFail = argv.includes('--allow-fail');
  const quiet = argv.includes('--quiet');
  const rest = argv.filter(a => !['--allow-fail', '--quiet'].includes(a));

  if (rest[0] === '--refresh' || rest[0] === 'refresh') {
    if (rest.length < 2) fail('refresh needs a directory or cast files');
    await refresh(rest.slice(1), { allowFail });
    return;
  }

  if (rest[0] === 'export') {
    const src = rest[1];
    if (!src || !fs.existsSync(src)) fail(`cast not found: ${src}`);
    const cast = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (cast.decklightCast !== 1) fail(`not a decklight cast: ${src}`);
    const eIdx = rest.indexOf('-o');
    const out = eIdx !== -1 && rest[eIdx + 1]
      ? rest[eIdx + 1]
      : src.replace(/\.cast\.json$/, '') + '.cast';
    fs.writeFileSync(out, exportAsciicast(cast));
    if (!quiet) console.log(`wrote ${out}  (asciicast v2 — try: agg ${out} ${out.replace(/\.cast$/, '')}.gif)`);
    return;
  }

  const { yaml } = loadDeps();
  const scriptPath = rest[0];
  if (!scriptPath || !fs.existsSync(scriptPath)) fail(`script not found: ${scriptPath}`);
  const oIdx = rest.indexOf('-o');
  const outPath = oIdx !== -1 && rest[oIdx + 1]
    ? rest[oIdx + 1]
    : scriptPath.replace(/\.term\.ya?ml$/, '').replace(/\.ya?ml$/, '') + '.cast.json';

  const script = yaml.load(fs.readFileSync(scriptPath, 'utf8'));
  if (!script || !Array.isArray(script.steps) || !script.steps.length) fail('script has no steps');

  const shellName = script.shell || path.basename(process.env.SHELL || 'zsh');
  if (!quiet) console.log(`recording ${script.steps.length} step${script.steps.length === 1 ? '' : 's'} in ${shellName}…`);
  const steps = await recordScript(script, {
    scriptDir: path.dirname(path.resolve(scriptPath)),
    allowFail,
    log: m => { if (!quiet) console.log(m); },
  });
  fs.writeFileSync(outPath, JSON.stringify(buildCast(script, steps, shellName), null, 1) + '\n');
  if (!quiet) console.log(`wrote ${outPath}`);
}

// Import-safe: only run the CLI when executed directly (recordScript and
// exportAsciicast are importable for tests/tooling).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) recMain().catch(e => fail(e.message));
