#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight edit — the live-editing dev server (SPEC PRESENTING edit mode).
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
import { readFileSync, writeFileSync, watch, existsSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { agentCommand, detectAgents } from './agents.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { NOTES_ASIDE, locateSlide } from '../tools/deck-html.mjs';
import { corsHeaders } from '../tools/bridge.mjs';
import { deckHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';
import { allowRemote, escapeHtml, lanAddress, sseChannel, staticFiles, listenTakingOverIfNeeded } from './serve.mjs';
import { createRemoteRelay } from './remote.mjs';

// file://-opened decks probe http://127.0.0.1:8788 directly (origin "null"),
// exactly like the tts bridge — so the endpoints are CORS-open. The server
// binds 127.0.0.1 only, unless --remote/--host opts it onto the LAN — and
// even then allowRemote (below) keeps the editing surface loopback-only.
const CORS = corsHeaders();

// ── remote access & static serving: extracted to serve.mjs / remote.mjs ────
// (PRESENT_SERVER in MARKETPLACE.md: `decklight present` reuses the same core
// with the /edit/* routes ABSENT, not merely refused.) Re-exported here so
// existing importers — the tests, init.mjs — and SPEC citations keep working.
export { isLoopback, allowRemote, lanAddress, escapeHtml } from './serve.mjs';
export { remoteControllerHtml } from './remote.mjs';

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

  // Declared before the git block below, which reads it to hold the cadence
  // back while a job is in flight.
  let agentJob = null; // { name, prompt, startedAt } — strictly one at a time

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
      // The cadence is the backstop, and it runs in agent mode too: an agent
      // job only ever sees edits IT made, so hand edits — and any agent driven
      // from outside the A flow — would otherwise reach git only via the
      // Ctrl-C bookend, which a crash skips. It is held back while a job is in
      // flight so nothing commits a half-finished agent run.
      setInterval(() => {
        if (shouldCommit(gitMode, { kind: 'timer', agentBusy: !!agentJob })) gitAutocommit(deckPath, root);
      }, commitEvery * 1000).unref();
      console.log(gitMode === 'agent'
        ? `  git: committing ${deckRel} once per agent edit with the agent's own message, every ${commitEvery}s otherwise (and on Ctrl-C)`
        : `  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`);
    }
  }
  const finalCommit = () => { if (gitOn) gitAutocommit(deckPath, root, `decklight: stop editing ${basename(deckPath)}`); };
  process.on('SIGINT', () => { finalCommit(); process.exit(0); });
  process.on('SIGTERM', () => { finalCommit(); process.exit(0); });

  // ── AI agents — one-shot editing tasks from the player (A) ─────────────
  const agentPref = opt('--agent');
  const agents = detectAgents();
  if (agents.length) console.log(`  agents: ${agents.map((a) => a.name).join(', ')} — “Ask agent” (A) is live`);

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  const clients = sseChannel();
  const broadcast = (event, data) => clients.broadcast(event, data);

  // ── the phone remote (#39) — the relay lives in remote.mjs ──────────────
  let actualPort = null;            // filled in once we know what we bound
  const relay = createRemoteRelay({
    deckName: basename(deckPath),
    token,
    remoteUrl: () => `http://${lanAddress() ?? host}:${actualPort}/remote?t=${token}`,
    relayToDeck: broadcast,
    deckCount: () => clients.size,
    CORS,
  });
  let pending = null;
  watch(deckPath, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      clients.raw('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  function runAgent(prompt, name, message) {
    const cmd = agentCommand(name || agentPref, prompt, deckRel);
    if (!cmd) return null;
    // Anything uncommitted at this moment is the PLAYER's work, not the
    // agent's. Sweeping it into its own commit first is what keeps the agent's
    // commit honest: otherwise a hand edit made just before pressing A lands
    // under the agent's message, and a history that misattributes authorship is
    // worse than one that only says "autosave".
    if (gitOn && shouldCommit(gitMode, { kind: 'bookend' })
        && gitAutocommit(deckPath, root, `decklight: save before ${cmd.name} edits ${basename(deckPath)}`)) {
      console.log('  git: committed your outstanding changes first');
    }
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

  const files = staticFiles(root, { index: deckUrl });
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
        clients.add(req, res, CORS);
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
      // none of them writes to the deck file (createRemoteRelay, remote.mjs).
      if (req.method === 'GET' && relay.handle(req, res, url)) return;
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
      if (req.method === 'POST' && relay.handle(req, res, url, body)) return;
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
      // ── static files from the cwd (staticFiles, serve.mjs) ───────────
      if (files(req, res, url)) return;
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


if (isMain(import.meta.url)) editMain(process.argv.slice(2));
