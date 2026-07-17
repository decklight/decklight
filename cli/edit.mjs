#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight edit — the live-editing dev server (SPEC §8 edit mode).
//
//   decklight edit <deck.html> [--port 8788] [--git | --no-git]
//                  [--commit-every <seconds>] [--agent <name>]
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /edit/ping    → { ok, deck, undo, redo, git, agents, agentBusy }
//   GET  /edit/events  → SSE; `reload` on deck change, `agent` job status
//   POST /edit/notes   → { slide, text }           rewrite that slide's notes
//   POST /edit/layout  → { slide, layout }         write data-layout to the file
//   POST /edit/undo    → step the deck file back through the edit history
//   POST /edit/redo    → step it forward again
//   POST /edit/agent   → { prompt, agent? }        one-shot AI agent edit
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
import { spawn, execFileSync } from 'node:child_process';
import { agentCommand, detectAgents } from './agents.mjs';

// file://-opened decks probe http://127.0.0.1:8788 directly (origin "null"),
// exactly like the tts bridge — so the endpoints are CORS-open. The server
// still binds 127.0.0.1 only.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

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
  // top-level sections can't nest, so splitting on the open tag is exact
  const parts = html.split(/(<section\b)/);
  const idx = 2 * slide; // parts[0] preamble, then [tag, content] pairs
  if (!parts[idx]) throw new Error(`no slide ${slide} (deck has ${(parts.length - 1) / 2})`);
  const aside = `<aside class="notes">\n        ${asideInner}\n      </aside>`;
  const seg = parts[idx];
  parts[idx] = /<aside class="notes">[\s\S]*?<\/aside>/.test(seg)
    ? seg.replace(/<aside class="notes">[\s\S]*?<\/aside>/, aside)
    : seg.replace(/<\/section>/, `  ${aside}\n    </section>`);
  return parts.join('');
}

// the same ring the player cycles — the file is the source of truth now
export const LAYOUTS = ['auto', 'centered', 'pinned', 'top', 'split', 'split-flip'];

/** Set (or, for 'auto', remove) slide N's data-layout attribute in the deck html. */
export function setSlideLayout(html, slide, name) {
  if (!LAYOUTS.includes(name)) throw new Error(`unknown layout "${name}"`);
  const parts = html.split(/(<section\b)/);
  const idx = 2 * slide;
  if (!parts[idx]) throw new Error(`no slide ${slide} (deck has ${(parts.length - 1) / 2})`);
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
const git = (gitArgs, cwd) =>
  execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function inGitRepo(dir) {
  try { return git(['rev-parse', '--is-inside-work-tree'], dir) === 'true'; } catch { return false; }
}

// The starter .gitignore a decklight-created repository begins with: generated
// artifacts (screenshot evidence, OS junk, narration audio) stay out of the
// autocommit loop and out of a hasty `git add -A`. Three entries, one comment —
// a starter the player owns from the first commit, not an ignore database.
export const STARTER_GITIGNORE = `.shots/
.DS_Store

# narration audio is bulky — but cloud-generated narration costs money to regenerate; delete this line to version yours
voiceover/
`;

/**
 * Create a git repository in `dir` — the one shared seam for every place
 * decklight creates a repo (`edit`/`dev` with --git today, init's offer per
 * #50). Runs `git init`, then writes the starter .gitignore — after init and
 * before any initial commit the caller makes, so a `git add -A` opening
 * commit picks it up. The repo-creation moment is the only time decklight
 * touches ignore rules: an existing .gitignore is never appended to or
 * merged, and a repository decklight didn't create never gets one. Returns
 * true when the starter file was written. Throws when `git init` fails.
 */
export function createRepo(dir) {
  git(['init'], dir);
  const ignorePath = resolve(dir, '.gitignore');
  if (existsSync(ignorePath)) return false;
  writeFileSync(ignorePath, STARTER_GITIGNORE);
  return true;
}

/** Commit the deck if it changed. Returns true when a commit was made. */
export function gitAutocommit(deckPath, cwd, message = `decklight: autosave ${basename(deckPath)}`) {
  try {
    if (!git(['status', '--porcelain', '--', deckPath], cwd)) return false;
    git(['add', '--', deckPath], cwd);
    try {
      git(['commit', '-m', message, '--', deckPath], cwd);
    } catch (e) {
      // a fresh machine has no git identity — commit anyway rather than
      // silently dropping the safety net, without touching global config
      if (!/user\.(name|email)|tell me who you are/i.test(String(e.stderr || e))) throw e;
      git(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost',
        'commit', '-m', message, '--', deckPath], cwd);
    }
    return true;
  } catch (e) {
    console.error(`  git autocommit failed: ${String(e.stderr || e.message || e).slice(0, 160)}`);
    return false;
  }
}

export async function editMain(args) {
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    console.log(`usage: decklight edit <deck.html> [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (E), per-slide layout (L/⇧L), undo/redo (Z/⇧Z), agent asks (A)
  --git            auto-commit the deck on a regular basis (creates the repo if needed)
  --no-git         never touch git (default outside a repository)
  --commit-every N autocommit cadence in seconds                          [300]
  --agent <name>   preferred AI agent for A (default: first one detected)`);
    return;
  }
  const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const port = Number(opt('--port', 8788));
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
      setInterval(() => gitAutocommit(deckPath, root), commitEvery * 1000).unref();
      console.log(`  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`);
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
  let pending = null;
  watch(deckPath, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const res of clients) res.write('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  function runAgent(prompt, name) {
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
      const url = new URL(req.url, 'http://x');
      const json = (code, obj) => {
        res.writeHead(code, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/edit/ping') {
        return json(200, {
          ok: true, deck: deckUrl, name: basename(deckPath),
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
        const { prompt, agent } = JSON.parse(body);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
        if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
        const cmd = runAgent(prompt.trim(), agent);
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

  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    console.log(`decklight edit on http://127.0.0.1:${actual}${deckUrl} — E notes, L layouts, Z undo, A agent. Ctrl-C stops`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) editMain(process.argv.slice(2));
