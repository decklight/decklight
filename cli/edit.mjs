#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight edit — the live-editing dev server (SPEC §8 edit mode).
//
//   decklight edit <deck.html> [--port 8788] [--git | --no-git]
//                  [--commit-every <seconds>] [--agent <name>]
//                  [--remote] [--host <addr>]
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /edit/ping     → { ok, deck, undo, redo, git, agents, agentBusy }
//   GET  /edit/events   → SSE; `reload` on deck change, `agent` job status
//   POST /edit/notes    → { slide, text }           rewrite that slide's notes
//   POST /edit/layout   → { slide, layout }         write data-layout to the file
//   POST /edit/undo     → step the deck file back through the edit history
//   POST /edit/redo     → step it forward again
//   POST /edit/agent    → { prompt, agent? }        one-shot AI agent edit
//   POST /edit/shutdown → final autocommit, then exit — same as Ctrl-C, so a
//                         port conflict can take over an old session cleanly
//
// Every mutation goes through ONE undo history — snapshots of the whole
// file, held in memory, capped. Undo/redo is deliberately independent of
// git: git commits (below) are the durable record, the history is the
// second-to-second "that ring entry was worse" loop, and neither consumes
// the other. An agent run snapshots before it starts, so Z takes an
// agent's edit back exactly like the player's own.
//
// Git: with --git (or when the deck already sits in a repository and
// --no-git wasn't passed) the server auto-commits the deck on a regular
// basis — every --commit-every seconds when it actually changed, plus a
// final commit on Ctrl-C. --git also creates the repository when none
// exists — seeded with a starter .gitignore (createRepo, below).
// `decklight dev` asks interactively before passing --git down.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, watch, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { agentCommand, detectAgents } from './agents.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { NOTES_ASIDE, locateSlide } from '../tools/deck-html.mjs';
import { corsHeaders } from '../tools/bridge.mjs';
import { resolvePortConflict } from './port-conflict.mjs';
import { qrSvg } from './qr.mjs';
import { deckHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';

// file://-opened decks probe http://127.0.0.1:8788 directly (origin "null"),
// exactly like the tts bridge — so the endpoints are CORS-open. The server
// binds 127.0.0.1 only, unless --remote/--host opts it onto the LAN — and
// even then allowRemote (below) keeps the editing surface loopback-only.
const CORS = corsHeaders();

// ── remote access: the security seam for the phone remote (#39) ────────────
// --remote widens the LISTENER, never the editing surface: off-loopback,
// only /remote/* answers, and only with the per-run token; every /edit/*
// mutation (and the static files) refuses non-loopback callers
// unconditionally, flag or no flag.

/** Loopback caller? IPv4-mapped IPv6 (::ffff:127.0.0.1) counts too. */
export function isLoopback(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/**
 * Pure request classifier: may this request be answered at all?
 * Loopback: always. Off-loopback: only /remote/* paths carrying the per-run
 * token (?t= query or x-decklight-token header) — everything else, all
 * /edit/* mutations included, is refused regardless of any token. `token`
 * is null when --remote is off, which refuses every off-loopback request
 * (defense in depth behind the 127.0.0.1 binding).
 */
export function allowRemote(req, token) {
  if (isLoopback(req.socket?.remoteAddress)) return true;
  if (!token) return false;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return false; }
  // new URL() normalizes dot segments, so /remote/../edit/notes is /edit/notes
  if (url.pathname !== '/remote' && !url.pathname.startsWith('/remote/')) return false;
  const sent = Buffer.from(String(url.searchParams.get('t') ?? req.headers?.['x-decklight-token'] ?? ''));
  const want = Buffer.from(token);
  return sent.length === want.length && timingSafeEqual(sent, want);
}

/** The machine's LAN address — what the printed /remote?t= URL should carry. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') return a.address;
    }
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The phone controller page (#39): a clicker, NOT a second screen — SPEC §11
 * rules out multiplex/follow-along, so this renders no slides, only two big
 * targets and the position readout. Self-contained by necessity: the phone is
 * off-loopback, and every asset it could reference is one more thing the token
 * would have to guard. It carries the token it was opened with into both its
 * POSTs and its SSE subscription.
 */
export function remoteControllerHtml(deckName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(deckName)} — remote</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; height: 100dvh; display: flex; flex-direction: column;
         font: 600 16px/1.3 system-ui, -apple-system, sans-serif; background: #111; color: #eee; }
  header { padding: .9rem 1rem; text-align: center; border-bottom: 1px solid #333; }
  .deck { font-weight: 400; opacity: .6; font-size: .8rem; }
  .pos { font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  main { flex: 1; display: grid; grid-template-rows: 1fr 1fr; gap: .6rem; padding: .6rem; }
  button { font: inherit; font-size: 2rem; border: 0; border-radius: 1rem; color: #eee;
           background: #26262b; touch-action: manipulation; }
  button:active { background: #3a3a44; }
  footer { padding: .5rem; text-align: center; font-size: .7rem; opacity: .5; }
</style>
</head>
<body>
  <header>
    <div class="deck">${escapeHtml(deckName)}</div>
    <div class="pos" id="pos">—</div>
  </header>
  <main>
    <button id="next" aria-label="next">▼ next</button>
    <button id="prev" aria-label="previous">▲ prev</button>
  </main>
  <footer id="state">connecting…</footer>
<script>
  var t = new URLSearchParams(location.search).get('t') || '';
  var q = t ? '?t=' + encodeURIComponent(t) : '';
  var pos = document.getElementById('pos');
  var state = document.getElementById('state');
  function send(key) {
    return fetch('/remote/key' + q, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key }),
    }).catch(function () { state.textContent = 'offline'; });
  }
  document.getElementById('next').onclick = function () { send('next'); };
  document.getElementById('prev').onclick = function () { send('prev'); };
  var es = new EventSource('/remote/events' + q);
  es.addEventListener('pos', function (e) {
    try { var p = JSON.parse(e.data); pos.textContent = p.i + ' / ' + p.n; } catch (err) {}
  });
  es.onopen = function () { state.textContent = 'connected'; };
  es.onerror = function () { state.textContent = 'reconnecting…'; };
</script>
</body>
</html>`;
}

/** ⟨CLICK⟩-separated plain text → the aside's inner HTML (one <p> per segment). */
export function notesTextToAside(text) {
  const segs = text.split(/\s*⟨CLICK⟩\s*/).map((s) => s.replace(/\s+/g, ' ').trim());
  const ps = [];
  segs.forEach((seg, i) => {
    if (i > 0) ps.push('<p>⟨CLICK⟩</p>');
    if (seg) ps.push(`<p>${escapeHtml(seg)}</p>`);
  });
  return ps.join('\n        ');
}

/** Replace (or insert) slide N's <aside class="notes"> in the deck html. */
export function setSlideNotes(html, slide, asideInner) {
  const { parts, idx } = locateSlide(html, slide);
  const aside = `<aside class="notes">\n        ${asideInner}\n      </aside>`;
  const seg = parts[idx];
  parts[idx] = NOTES_ASIDE.test(seg)
    ? seg.replace(NOTES_ASIDE, aside)
    : seg.replace(/<\/section>/, `  ${aside}\n    </section>`);
  return parts.join('');
}

// the same ring the player cycles — the file is the source of truth now
export const LAYOUTS = ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'];

/** Set (or, for 'auto', remove) slide N's data-layout attribute in the deck html. */
export function setSlideLayout(html, slide, name) {
  if (!LAYOUTS.includes(name)) throw new Error(`unknown layout "${name}"`);
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const gt = seg.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed <section> tag`);
  let head = seg.slice(0, gt).replace(/\s+data-layout=("[^"]*"|'[^']*')/, '');
  if (name !== 'auto') head += ` data-layout="${name}"`;
  parts[idx] = head + seg.slice(gt);
  return parts.join('');
}

/**
 * The edit history: whole-file snapshots, in memory, capped. record() the
 * content a mutation is about to replace; undo()/redo() take the CURRENT
 * file content (which may include edits made outside the server — those
 * land on the opposite stack, so nothing is silently lost) and return what
 * to write, or null when the stack is empty.
 */
export function createHistory(limit = 200) {
  const past = [];
  const future = [];
  return {
    record(before) {
      past.push(before);
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      future.push(current);
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(current);
      return future.pop();
    },
    counts() { return { undo: past.length, redo: future.length }; },
  };
}

// ── git: the durable record (the history above is the fast loop) ──────────
// The plumbing lives in git.mjs now; imported for editMain's use below and
// re-exported so long-standing importers (init, the tests) keep finding it
// where edit grew it.
import { inGitRepo, createRepo, STARTER_GITIGNORE, gitAutocommit, resolveGitMode, shouldCommit, commitSubject, oneline } from './git.mjs';
export { inGitRepo, createRepo, STARTER_GITIGNORE, gitAutocommit };

export async function editMain(args) {
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    console.log(`usage: decklight edit <deck.html> [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>]
                      [--remote] [--host <addr>]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (E), per-slide layout (L/⇧L), undo/redo (Z/⇧Z), agent asks (A)
  a taken --port offers to take over that session (on a TTY) or moves on to
  the next free one
  --git            auto-commit the deck on a regular basis (creates the repo if needed)
  --no-git         never touch git (default outside a repository)
  --commit-every N autocommit cadence in seconds (timer mode)             [300]
  --git-mode M     when to commit: timer (a cadence), agent (one commit per
                   agent edit, with the agent's own message), off      [timer]
  --agent <name>   preferred AI agent for A (default: first one detected)
  --remote         also listen on the LAN for the phone remote — off this
                   machine only /remote/* answers, and only with the printed
                   per-run token; /edit/* stays loopback-only regardless
  --host <addr>    the address --remote binds                       [0.0.0.0]`);
    return;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8788));
  // --remote (or a chosen --host) opts the listener onto the LAN; the token
  // is per-run and random — the value the /remote?t= URL carries (#39c)
  const remote = args.includes('--remote') || opt('--host') !== undefined;
  const host = remote ? opt('--host', '0.0.0.0') : '127.0.0.1';
  const token = remote ? randomBytes(16).toString('base64url') : null;
  const root = process.cwd();
  const deckPath = resolve(root, args.find((a) => !a.startsWith('-')));
  if (!existsSync(deckPath)) { console.error(`deck not found: ${deckPath}`); process.exitCode = 1; return; }
  if (!deckPath.startsWith(root + sep)) { console.error('deck must live under the current directory'); process.exitCode = 1; return; }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');
  const deckRel = deckUrl.slice(1);

  const history = createHistory();
  const readDeck = () => readFileSync(deckPath, 'utf8');
  // one door for every mutation: snapshot, then write — so Z always works
  const applyEdit = (next, before = readDeck()) => {
    if (next === before) return false;
    history.record(before);
    writeFileSync(deckPath, next);
    return true;
  };

  // ── git autocommit — the durable record, independent of undo/redo ──────
  const noGit = args.includes('--no-git');
  const wantGit = args.includes('--git');
  const commitEvery = Math.max(5, Number(opt('--commit-every', 300)) || 300);
  // timer (default, unchanged) · agent (one commit per agent edit) · off
  const gitMode = resolveGitMode(args);
  let gitOn = false;
  if (!noGit && (wantGit || inGitRepo(root))) {
    if (!inGitRepo(root)) {
      try {
        const wroteIgnore = createRepo(root);
        console.log(`  git: initialized a repository in ${root}${wroteIgnore ? ' (with a starter .gitignore)' : ''}`);
      } catch (e) {
        console.error(`  git init failed: ${String(e.stderr || e.message || e).slice(0, 160)}`);
      }
    }
    if (inGitRepo(root)) {
      gitOn = true;
      gitAutocommit(deckPath, root, `decklight: start editing ${basename(deckPath)}`);
      // In agent mode the cadence must NOT also fire, or every agent edit gets
      // committed twice — once with its own summary, once as `autosave`.
      if (shouldCommit(gitMode, { kind: 'timer' })) {
        setInterval(() => gitAutocommit(deckPath, root), commitEvery * 1000).unref();
        console.log(`  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`);
      } else {
        console.log(`  git: committing ${deckRel} once per agent edit, with the agent's own message (and on Ctrl-C)`);
      }
    }
  }
  const finalCommit = () => { if (gitOn) gitAutocommit(deckPath, root, `decklight: stop editing ${basename(deckPath)}`); };
  process.on('SIGINT', () => { finalCommit(); process.exit(0); });
  process.on('SIGTERM', () => { finalCommit(); process.exit(0); });

  // ── AI agents — one-shot editing tasks from the player (A) ─────────────
  const agentPref = opt('--agent');
  const agents = detectAgents();
  let agentJob = null; // { name, prompt, startedAt } — strictly one at a time
  if (agents.length) console.log(`  agents: ${agents.map((a) => a.name).join(', ')} — “Ask agent” (A) is live`);

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  const clients = new Set();
  const broadcast = (event, data) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // ── the phone remote (#39) ───────────────────────────────────────────────
  // Two one-way channels, deliberately kept apart from the deck's own stream:
  // a phone has no business receiving `reload` or `agent`, and the deck has no
  // business receiving position echoes of its own movement.
  const remoteClients = new Set();  // phones watching /remote/events
  let lastPos = null;               // the last position the deck reported
  let actualPort = null;            // filled in once we know what we bound
  const remoteUrl = () => `http://${lanAddress() ?? host}:${actualPort}/remote?t=${token}`;
  const pushPos = () => {
    if (!lastPos) return;
    for (const r of remoteClients) r.write(`event: pos\ndata: ${JSON.stringify(lastPos)}\n\n`);
  };
  let pending = null;
  watch(deckPath, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const res of clients) res.write('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  function runAgent(prompt, name, message) {
    const cmd = agentCommand(name || agentPref, prompt, deckRel);
    if (!cmd) return null;
    const before = readDeck();
    agentJob = { agent: cmd.name, label: cmd.label, prompt, startedAt: Date.now() };
    broadcast('agent', { state: 'start', ...agentJob });
    console.log(`  agent: ${cmd.name} ← "${prompt.slice(0, 80)}"`);
    const child = spawn(cmd.bin, cmd.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timeout);
      agentJob = null;
      broadcast('agent', { state: 'done', agent: cmd.name, ok: false, changed: false, error: String(e.message || e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const after = readDeck();
      const changed = after !== before;
      if (changed) history.record(before); // Z takes the agent's edit back
      // One commit per completed agent edit, carrying the agent's own summary
      // — the boundary and the message both come from the work, not a clock.
      // A failed run or one that changed nothing commits nothing.
      if (gitOn && shouldCommit(gitMode, { kind: 'agent', ok: code === 0, changed })) {
        const subject = commitSubject(message ?? prompt, `decklight: ${cmd.name} edited ${basename(deckPath)}`);
        if (gitAutocommit(deckPath, root, subject)) console.log(`  git: committed "${subject}"`);
      }
      agentJob = null;
      broadcast('agent', {
        state: 'done', agent: cmd.name, ok: code === 0, changed, code,
        tail: tail.trim().split('\n').slice(-6).join('\n').slice(-600),
      });
      console.log(`  agent: ${cmd.name} exited (${code}) — deck ${changed ? 'changed' : 'unchanged'}`);
    });
    return cmd;
  }

  const server = createServer(async (req, res) => {
    try {
      // the security seam: off-loopback callers only ever reach /remote/*
      // (with the token) — /edit/* and the static files answer loopback only
      if (!allowRemote(req, token)) {
        console.log(`  refused off-loopback: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        res.writeHead(403, { ...CORS, 'content-type': 'text/plain' });
        return res.end('forbidden: /edit/* answers loopback only; off this machine use /remote/* with the session token');
      }
      const url = new URL(req.url, 'http://x');
      const json = (code, obj) => {
        res.writeHead(code, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/edit/ping') {
        return json(200, {
          ok: true, deck: deckUrl, name: basename(deckPath),
          // the speaker view only offers the QR when there is a LAN URL to scan
          remote: !!token,
          ...history.counts(), git: gitOn,
          agents: agents.map((a) => ({ name: a.name, label: a.label })),
          agentBusy: agentJob && { agent: agentJob.agent, prompt: agentJob.prompt, startedAt: agentJob.startedAt },
        });
      }
      if (req.method === 'GET' && url.pathname === '/edit/events') {
        res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      // ── the deck's durable history (#129): what the R overlay reads ────
      // Loopback-only like every other /edit/* path: this serves arbitrary
      // historical revisions of the deck, which is nobody else's business.
      if (req.method === 'GET' && url.pathname === '/edit/history') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session — there is no history' });
        try { return json(200, { ok: true, entries: deckHistory(deckPath, root) }); }
        catch (e) { return json(500, { ok: false, error: oneline(e) }); }
      }
      if (req.method === 'GET' && url.pathname === '/edit/at') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        try {
          // <base href="/"> because this is served from /edit/, not the root:
          // without it every relative ../dist and ./casts path in the deck
          // would resolve one directory too deep and the preview would be bare.
          const html = withBaseHref(deckAt(deckPath, url.searchParams.get('ref') || '', root));
          res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(html);
        } catch {
          res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
          return res.end('no such revision of this deck');
        }
      }

      // ── the phone remote: controller, its QR, and the readout channel ──
      // These are the ONLY paths allowRemote lets through off-loopback, and
      // none of them writes to the deck file: the phone asks the deck to move,
      // it never edits.
      if (req.method === 'GET' && url.pathname === '/remote') {
        res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(remoteControllerHtml(basename(deckPath)));
      }
      if (req.method === 'GET' && url.pathname === '/remote/qr.svg') {
        // Only meaningful with --remote: without it there is no LAN URL to
        // scan, and a QR encoding 127.0.0.1 would be a lie a phone can't use.
        if (!token) return json(404, { ok: false, error: 'the remote is off — start with --remote' });
        res.writeHead(200, { ...CORS, 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
        return res.end(qrSvg(remoteUrl()));
      }
      if (req.method === 'GET' && url.pathname === '/remote/events') {
        res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        remoteClients.add(res);
        req.on('close', () => remoteClients.delete(res));
        // a phone joining mid-talk should show the right number immediately,
        // not stay blank until the presenter happens to advance
        if (lastPos) res.write(`event: pos\ndata: ${JSON.stringify(lastPos)}\n\n`);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/edit/shutdown') {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // same shutdown a Ctrl-C takes — final autocommit, then actually exit —
        // once the response has cleared the socket, so the asker sees it land
        res.once('finish', () => { finalCommit(); process.exit(0); });
        return;
      }
      if (req.method === 'POST' && /^\/edit\/(undo|redo)$/.test(url.pathname)) {
        const dir = url.pathname.endsWith('undo') ? 'undo' : 'redo';
        const cur = readDeck();
        const content = history[dir](cur);
        if (content === null) return json(409, { ok: false, error: `nothing to ${dir}`, ...history.counts() });
        writeFileSync(deckPath, content);
        console.log(`  ${dir} → ${JSON.stringify(history.counts())}`);
        return json(200, { ok: true, ...history.counts() });
      }
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
      }
      if (req.method === 'POST' && url.pathname === '/edit/restore') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        const { ref } = JSON.parse(body || '{}');
        if (typeof ref !== 'string' || !ref.trim()) throw new Error('bad payload');
        const before = readDeck();
        let result;
        try { result = restoreDeck(deckPath, ref.trim(), root); }
        catch (e) { return json(400, { ok: false, error: oneline(e) }); }
        // Z takes a restore back like any other edit — the git-level move and
        // the keystroke-level stack stay in step rather than disagreeing.
        if (result.changed) history.record(before);
        console.log(`  restored ${basename(deckPath)} to ${result.short}`);
        return json(200, { ok: true, ...result, ...history.counts() });
      }
      // An intermediate commit point: a multi-step agent calls this when IT
      // decides one logical change is finished, so the boundaries follow the
      // work instead of a clock. The message is the agent's, and untrusted.
      if (req.method === 'POST' && url.pathname === '/edit/commit') {
        if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
        const { message } = JSON.parse(body || '{}');
        const subject = commitSubject(message, `decklight: autosave ${basename(deckPath)}`);
        const committed = gitAutocommit(deckPath, root, subject);
        if (committed) console.log(`  git: committed "${subject}"`);
        return json(200, { ok: true, committed, subject });
      }
      if (req.method === 'POST' && url.pathname === '/remote/key') {
        const { key } = JSON.parse(body);
        if (key !== 'next' && key !== 'prev') throw new Error('bad payload');
        // relayed as a named event on the stream the deck ALREADY listens to —
        // no second socket, no WebSockets anywhere in this codebase
        broadcast('remote', { key });
        return json(200, { ok: true, key, decks: clients.size });
      }
      if (req.method === 'POST' && url.pathname === '/remote/pos') {
        const { i, n } = JSON.parse(body);
        if (!Number.isInteger(i) || !Number.isInteger(n)) throw new Error('bad payload');
        lastPos = { i, n };
        pushPos();
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/edit/notes') {
        const { slide, text } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string') throw new Error('bad payload');
        applyEdit(setSlideNotes(readDeck(), slide, notesTextToAside(text)));
        console.log(`  notes saved: slide ${slide} (${text.length} chars)`);
        return json(200, { ok: true, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/layout') {
        const { slide, layout } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || typeof layout !== 'string') throw new Error('bad payload');
        const changed = applyEdit(setSlideLayout(readDeck(), slide, layout));
        if (changed) console.log(`  layout saved: slide ${slide} → ${layout}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/agent') {
        const { prompt, agent, message } = JSON.parse(body);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
        if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
        const cmd = runAgent(prompt.trim(), agent, message);
        if (!cmd) return json(400, { ok: false, error: agent ? `agent "${agent}" not detected` : 'no agent CLI detected (claude, codex, bob, …)' });
        return json(200, { ok: true, agent: cmd.name, label: cmd.label });
      }
      // ── static files from the cwd ────────────────────────────────────
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? deckUrl : decodeURIComponent(url.pathname);
        const file = resolve(root, '.' + rel);
        if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); return res.end('forbidden'); }
        if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(readFileSync(file));
      }
      res.writeHead(405);
      res.end();
    } catch (e) {
      console.error(`  edit error: ${String(e).slice(0, 120)}`);
      if (!res.headersSent) res.writeHead(400, CORS);
      res.end(String(e.message || e));
    }
  });

  const actual = await listenTakingOverIfNeeded(server, port, host);
  actualPort = actual; // the QR can only be built once we know what we bound
  console.log(`decklight edit on http://127.0.0.1:${actual}${deckUrl} — E notes, L layouts, Z undo, A agent. Ctrl-C stops`);
  if (token) {
    console.log(`  remote: listening on ${host} — http://${lanAddress() ?? host}:${actual}/remote?t=${token}`);
    console.log('  off this machine only /remote/* answers (with that token); /edit/* stays loopback-only');
  }
}

/**
 * Bind `server` to `port` on `host`. On EADDRINUSE, work out who's there
 * (resolvePortConflict) — on a TTY that's an interactive choice, otherwise
 * the port silently bumps — and retry until something binds. Returns the
 * port actually bound (server.address().port, so :0 still reports its
 * OS-assigned port).
 */
async function listenTakingOverIfNeeded(server, port, host = '127.0.0.1') {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  let rl;
  const ask = tty ? (q) => (rl ??= createInterface({ input: process.stdin, output: process.stdout })).question(q) : undefined;
  try {
    for (;;) {
      try {
        return await new Promise((res, rej) => {
          const onError = (e) => { server.off('listening', onListening); rej(e); };
          const onListening = () => { server.off('error', onError); res(server.address().port); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        port = await resolvePortConflict(port, { ask, log: console.log });
      }
    }
  } finally {
    rl?.close();
  }
}

if (isMain(import.meta.url)) editMain(process.argv.slice(2));
