#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The live-editing deck server behind `decklight author` (SPEC PRESENTING
// author mode). Not a command of its own anymore — the dispatcher refuses
// `edit` out loud — author spawns this module directly:
//
//   node cli/edit.mjs <deck.html> [--port 8788] [--git | --no-git]
//                     [--commit-every <seconds>] [--agent <name>]
//
// It binds 127.0.0.1 and nothing else. The phone remote used to be here behind
// `--remote`, which meant a clicker cost you an editing server on the LAN;
// `decklight present --remote` hosts it now, with no edit surface to widen
// (PRESENT#REMOTE). Both flags are refused out loud rather than ignored.
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /edit/ping            → { ok, deck, undo, redo, git, agents, agentBusy, wizards }
//   GET  /edit/events          → SSE; `reload` on deck change, `agent` job status
//   POST /edit/notes           → { slide, text }           rewrite that slide's notes
//   POST /edit/layout          → { slide, layout }         write data-layout to the file
//   GET  /edit/element/source  → ?slide=&index=            an element's outerHTML, fresh from the file
//   POST /edit/element/remove  → { slide, index }          delete that element
//   POST /edit/element/content → { slide, index, html }    replace its outerHTML
//   POST /edit/element/effect  → { slide, index, effect }  write data-build (null strips it)
//   POST /edit/undo            → step the deck file back through the edit history
//   POST /edit/redo            → step it forward again
//   POST /edit/agent           → { prompt, agent? }        one-shot AI agent edit
//   POST /edit/shutdown        → final autocommit, then exit — same as Ctrl-C, so a
//                                port conflict can take over an old session cleanly
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
// `decklight author` asks interactively before passing --git down.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, watch, existsSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { agentCommand, detectAgents, agentUnavailable, preferredAgent, setPreferredAgent } from './agents.mjs';
import { exitWhenOrphaned } from './supervise.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { NOTES_ASIDE, locateSlide, sectionChildRanges } from '../tools/deck-html.mjs';
import { deckHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';
import { escapeHtml, sseChannel, staticFiles, listenTakingOverIfNeeded, allowEditRequest } from './serve.mjs';
import { configureEngine, loadCredentials, forgetCredentials, redactAnswers, validateSchema, provenance, BRIDGE_ADDR, CONFIGURED, UNREACHABLE, PREREQUISITE } from './wizard.mjs';

// The `/edit/*` surface answers loopback only — but "loopback" is the wrong
// boundary for the threat (#222). The dangerous caller is not off-machine: it
// is the user's own browser, where any open tab can `fetch()` this port. Binding
// 127.0.0.1 does nothing about that, and a wildcard `access-control-allow-origin`
// actively invites it. So every request is gated by `allowEditRequest` on its
// `Origin` (below), and CORS is echoed per request rather than granted to `*` —
// a foreign site's `fetch` never reaches a handler. The one origin still let
// through besides loopback is `null`: a file://-opened deck probes this server
// directly, and the SPEC keeps that double-click path (PRESENTING).
const corsHeadersFor = (origin) => ({
  ...(origin !== undefined ? { 'access-control-allow-origin': origin } : {}),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  vary: 'Origin',
});

// ── remote access & static serving: extracted to serve.mjs / remote.mjs ────
// (PRESENT_SERVER in MARKETPLACE.md: `decklight present` reuses the same core
// with the /edit/* routes ABSENT, not merely refused.) Re-exported here so
// existing importers — the tests, init.mjs — and SPEC citations keep working.
export { isLoopback, lanAddress, escapeHtml } from './serve.mjs';

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

/** Look up element `index` (raw child position) on slide `slide`, or throw. */
function locateElement(html, slide, index) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const ranges = sectionChildRanges(seg);
  const r = ranges[index];
  if (!r) throw new Error(`slide ${slide}: no element at index ${index} (has ${ranges.length})`);
  return { parts, idx, seg, r };
}

/** Remove slide N's element at raw child index `index` (title included). */
export function removeSlideElement(html, slide, index) {
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  parts[idx] = seg.slice(0, r.start) + seg.slice(r.end);
  return parts.join('');
}

/** Replace slide N's element at raw child index `index` with `outerHtml` verbatim. */
export function setSlideElementHtml(html, slide, index, outerHtml) {
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  parts[idx] = seg.slice(0, r.start) + outerHtml + seg.slice(r.end);
  return parts.join('');
}

// The spec's 7 entrance styles (MOTION), plus 'none' — an explicit, instant
// build step, distinct from having no data-build attribute at all: one more
// advance still reveals the element, it just has no animation.
export const BUILD_EFFECTS = ['fade', 'fade-up', 'fade-down', 'zoom', 'pop', 'draw', 'highlight', 'none'];

/**
 * Set slide N's element `index`'s build/entrance effect, or — when `effect`
 * is `null` — strip `data-build` entirely (the menu's separate "remove
 * effect" action).
 */
export function setSlideElementBuild(html, slide, index, effect) {
  if (effect !== null && !BUILD_EFFECTS.includes(effect)) throw new Error(`unknown build effect "${effect}"`);
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  const el = seg.slice(r.start, r.end);
  const gt = el.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed element at index ${index}`);
  let head = el.slice(0, gt).replace(/\s+data-build=("[^"]*"|'[^']*')/, '');
  if (effect !== null) head += ` data-build="${effect}"`;
  parts[idx] = seg.slice(0, r.start) + head + el.slice(gt) + seg.slice(r.end);
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
    console.log(`usage: node cli/edit.mjs <deck.html> [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (right-click a slide's background), per-slide layout (L/⇧L),
  element edit mode (E, then right-click an element), undo/redo (Z/⇧Z), agent asks (A)
  a taken --port offers to take over that session (on a TTY) or moves on to
  the next free one
  --git            auto-commit the deck on a regular basis (creates the repo if needed)
  --no-git         never touch git (default outside a repository)
  --commit-every N autocommit cadence in seconds (timer mode)             [300]
  --git-mode M     when to commit: timer (a cadence), agent (one commit per
                   agent edit, with the agent's own message), off      [timer]
  --agent <name>   preferred AI agent for A (default: first one detected)
  the server binds 127.0.0.1 only; for a phone remote use decklight present`);
    return;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8788));
  // Refused out loud, not ignored (PRESENT#REMOTE). Someone typing --remote
  // wants a clicker; silently binding loopback would leave them holding a phone
  // that never connects and no idea why. `present` is where the remote went,
  // and the reason it went is worth saying at the moment it is asked for.
  const gone = ['--remote', '--host'].filter((f) => args.some((a) => a === f || a.startsWith(f + '=')));
  if (gone.length) {
    console.error(`author no longer takes ${gone.join(' or ')} — the phone remote moved to \`decklight present\`.`);
    console.error('  A clicker used to cost you an editing server on the LAN: /edit/notes, /edit/layout and');
    console.error('  /edit/agent were reachable from the same run you were not watching. present has no edit');
    console.error('  surface to widen, so that is where it lives.');
    console.error(`\n  decklight present ${args.find((a) => !a.startsWith('-')) ?? '<deck.html>'} --remote`);
    process.exitCode = 2;
    return;
  }
  const host = '127.0.0.1';
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
  // Precedence, like every other saved choice: the flag wins, then what was
  // remembered (#125), then the first detected agent.
  let agentPref = opt('--agent') ?? preferredAgent();
  const agents = detectAgents();
  if (agents.length) {
    const mark = (a) => a.name + (a.name === agentPref ? ' (preferred)' : '') + (a.installed ? ' (installed)' : '');
    console.log(`  agents: ${agents.map(mark).join(', ')} — “Ask agent” (A) is live`);
  }
  // A remembered agent that is not on this machine is said ONCE, at startup,
  // rather than discovered at the moment someone presses A mid-talk.
  if (agentPref && !agents.some((a) => a.name === agentPref)) {
    console.log(`  agent: ${agentUnavailable(agentPref, agents)}`);
  }

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  const clients = sseChannel();
  const broadcast = (event, data) => clients.broadcast(event, data);

  // ── the catalogs, read from cache and never fetched ──────────────────────
  const catalogMap = async () => {
    const { loadRegistry, loadCatalog } = await import('./marketplace.mjs');
    const out = {};
    for (const name of Object.keys(loadRegistry().marketplaces ?? {})) {
      const loaded = loadCatalog(name);
      if (loaded?.ok) out[name] = loaded.manifest;
    }
    return out;
  };
  /** Every theme entry a registered marketplace offers, qualified. */
  const browsableThemes = async () => {
    const { loadRegistry, loadCatalog } = await import('./marketplace.mjs');
    const registered = Object.keys(loadRegistry().marketplaces ?? {});
    const themes = [];
    // Registered-but-never-fetched is the FIRST-RUN state, not an error — the
    // first-party marketplace is deliberately in it — so it is reported as
    // something the presenter can act on (`marketplace update <name>`) rather
    // than as an empty list that looks like an empty marketplace.
    const stale = [];
    for (const market of registered) {
      const loaded = loadCatalog(market);
      if (!loaded) { stale.push(market); continue; }
      if (!loaded.ok) { stale.push(market); continue; }
      for (const e of loaded.manifest.entries ?? []) {
        if (e.type !== 'theme') continue;
        themes.push({
          name: e.name, marketplace: market, qualified: `${e.name}@${market}`,
          description: e.description ?? '', source: e.source,
        });
      }
    }
    return { themes, stale };
  };
  /**
   * Every entry a registered marketplace declares a wizard for, qualified.
   * Advertised in /edit/ping beside the agents: the palette's Configure rows
   * come from here, so a player never has to guess an engine name to ask
   * /edit/wizard about (ENGINES#WIZARD).
   */
  const configurableEngines = async () => {
    const { loadRegistry, loadCatalog } = await import('./marketplace.mjs');
    const engines = [];
    for (const market of Object.keys(loadRegistry().marketplaces ?? {})) {
      const loaded = loadCatalog(market);
      if (!loaded?.ok) continue;
      for (const e of loaded.manifest.entries ?? []) {
        if (!e.wizard) continue;
        // The title is display-only; a malformed schema still gets listed, so
        // opening it surfaces validateSchema's refusal instead of silence.
        engines.push({
          name: e.name, qualified: `${e.name}@${market}`,
          title: typeof e.wizard.title === 'string' ? e.wizard.title : e.name,
        });
      }
    }
    return engines;
  };

  // ── the engine wizard: where a schema comes from, and who checks answers ─
  // Both injected into configureEngine rather than reached for inside it: this
  // server knows how catalogs are read, and cli/wizard.mjs has no business
  // knowing — which is also what lets the framework be tested without a
  // network or a real key.
  const wizardEntry = async (engine) => {
    const { resolveEntry, MarketplaceError } = await import('./marketplace.mjs');
    // resolveEntry is the seam every install surface goes through — its docblock
    // names the engine wizard as one of them — so `elevenlabs@voices` works, and
    // a bare name that exists in two marketplaces is reported as ambiguous
    // rather than silently resolved to whichever was registered first.
    // loadCatalog returns the VALIDATION result, not the manifest — a cached
    // catalog that no longer validates has no entries to offer, which is the
    // right answer rather than a crash. catalogMap does that unwrapping once.
    try {
      const hit = resolveEntry(engine, await catalogMap());
      // The whole hit, not just the entry: `qualified` is what the wizard's
      // provenance line shows as the asker (#232), and it has to come from the
      // registry rather than from anything the schema itself declares.
      return hit.entry.wizard ? hit : null;
    } catch (e) {
      if (e instanceof MarketplaceError) return null;
      throw e;
    }
  };
  const wizardSchemaFor = async (engine) => {
    const hit = await wizardEntry(engine);
    if (!hit) throw new Error(`no wizard declared for "${engine}" in any registered marketplace`);
    return hit.entry.wizard;
  };
  /**
   * Ask the engine's own bridge whether the answers work.
   *
   * The plugin declares a PATH, never an origin — a schema that could name where
   * to send a freshly pasted key would be a credential exfiltration primitive
   * with a config file for a delivery mechanism. So the origin is this machine,
   * and the plugin only chooses the path on it.
   */
  const wizardValidate = async (schema, answers) => {
    if (!schema.validate) return true;
    // BRIDGE_ADDR is shared with provenance() so the destination the player
    // showed the presenter and the one this line posts to cannot drift apart.
    const r = await fetch(`http://${BRIDGE_ADDR}${schema.validate}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: schema.engine, answers }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j?.ok === true;
  };

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
    // The CSRF gate (#222), before anything runs. A same-machine browser tab is
    // the threat, not an off-machine caller, so the check is the request's
    // `Origin`, not its socket address. A foreign origin is refused here —
    // before the body is read, before any file is written, before an agent is
    // spawned — and refused WITHOUT permissive CORS, so the page cannot even
    // read the refusal. Loopback origins, `null` (file://), and the header's
    // absence (the CLI, the port-conflict probe, curl) pass.
    const origin = req.headers.origin;
    const CORS = corsHeadersFor(origin);
    if (!allowEditRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden: the author edit surface answers this machine only, and not a foreign web origin');
      return;
    }
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
          // which one A reaches for, so the picker opens on it rather than
          // defaulting to the first detected agent every session (#125)
          preferredAgent: agentPref ?? null,
          agentBusy: agentJob && { agent: agentJob.agent, prompt: agentJob.prompt, startedAt: agentJob.startedAt },
          wizards: await configurableEngines(),
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
      // ── element edit mode (E, right-click a slide element) — #112 ─────
      // Reads the element's outerHTML fresh from the FILE, never the live
      // DOM: the engine mutates elements in place (pinned-title classes,
      // namespaced SVG ids, chart/code/math subtree replacement), so the DOM
      // the player sees is not what a Save should write back over.
      if (req.method === 'GET' && url.pathname === '/edit/element/source') {
        const slide = Number(url.searchParams.get('slide'));
        const index = Number(url.searchParams.get('index'));
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) {
          return json(400, { ok: false, error: 'bad payload' });
        }
        try {
          const { parts, idx, r } = locateElement(readDeck(), slide, index);
          return json(200, { ok: true, html: parts[idx].slice(r.start, r.end) });
        } catch (e) {
          return json(404, { ok: false, error: oneline(e) });
        }
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
      // ── theme Browse (THEME_BROWSE#UI) ─────────────────────────────────
      // What the picker's Browse entry lists. Cache-only by construction: this
      // reads the catalogs `marketplace update` already fetched and never
      // fetches one itself, so a deck on a plane lists what it has and says so
      // rather than hanging on a network that is not there.
      if (req.method === 'GET' && url.pathname === '/edit/theme/browse') {
        const { themes, stale } = await browsableThemes();
        return json(200, { ok: true, themes, stale, cacheOnly: true });
      }
      // Installing goes through `theme add`'s own functions — validation, the
      // WCAG gates, the block shape — so a theme refused on the command line is
      // refused here, by the same code, for the same reason.
      if (req.method === 'POST' && url.pathname === '/edit/theme/add') {
        const { ref, name: asName } = JSON.parse(body || '{}');
        if (typeof ref !== 'string' || !ref.trim()) return json(400, { ok: false, error: 'which theme?' });
        const { resolveEntry, MarketplaceError } = await import('./marketplace.mjs');
        const { fetchTheme, installTheme, resolveSource } = await import('./theme.mjs');
        const { validateTheme, themeNameFrom, validThemeName } = await import('../tools/theme-check.mjs');

        let hit;
        try { hit = resolveEntry(ref.trim(), await catalogMap()); }
        catch (e) {
          if (e instanceof MarketplaceError) return json(404, { ok: false, error: e.message });
          throw e;
        }
        if (hit.entry.type !== 'theme') {
          return json(400, { ok: false, error: `"${hit.qualified}" is a ${hit.entry.type}, not a theme` });
        }
        const name = asName || hit.entry.name;
        if (!validThemeName(name)) return json(400, { ok: false, error: `not a usable theme name: "${name}"` });

        // A manifest's `source` is relative to its MARKETPLACE, not to whoever
        // is installing — resolveSource is where that is worked out, and it lives
        // in theme.mjs because fetching an artifact and fetching a catalog are
        // different permissions on this path.
        const { loadRegistry } = await import('./marketplace.mjs');
        const market = loadRegistry().marketplaces?.[hit.marketplace];
        const src = resolveSource(hit.entry.source, market?.source);
        let css;
        try { css = await fetchTheme(src); }
        catch (e) { return json(502, { ok: false, error: `could not read ${src}: ${oneline(e)}` }); }

        const check = validateTheme(css);
        if (!check.ok) {
          // The deck is left byte-for-byte unchanged: a picker that could leave
          // a deck carrying a broken theme would be worse than no picker.
          return json(400, { ok: false, error: `${name} fails the theme contract`, problems: check.errors ?? [] });
        }
        const before = readDeck();
        const out = installTheme(before, name, css);
        if (!out.html) return json(500, { ok: false, error: 'the deck has no </head> to install into' });
        history.record(before);   // Z takes an install back like any other edit
        writeFileSync(deckPath, out.html);
        console.log(`  theme: ${out.replaced ? 'replaced' : 'installed'} ${name} from ${hit.qualified}`);
        return json(200, { ok: true, name, from: hit.qualified, replaced: out.replaced, ...history.counts() });
      }
      // ── the engine wizard (ENGINES#WIZARD) ─────────────────────────────
      // The schema the player renders. Validated on the way OUT as well as on
      // the way in: a catalog is a file someone else wrote, and handing the
      // renderer a schema core has not vetted is how "core renders, a plugin
      // declares" becomes "core renders whatever a plugin sent".
      if (req.method === 'GET' && url.pathname === '/edit/wizard') {
        const engine = url.searchParams.get('engine') ?? '';
        const hit = await wizardEntry(engine);
        if (!hit) return json(404, { ok: false, error: `no wizard declared for "${engine}"` });
        try {
          const schema = validateSchema(hit.entry.wizard);
          // Provenance rides BESIDE the schema, never inside it (#232): `from`
          // is the registry's name for the entry and the sentence pair is
          // derived here from the vetted schema, so the card can say who is
          // asking and where the answer goes in words the plugin did not write.
          return json(200, { ok: true, schema, from: hit.qualified, provenance: provenance(schema, hit.qualified) });
        } catch (e) {
          return json(400, { ok: false, error: `${engine} declares a wizard core cannot render: ${e.message}` });
        }
      }
      // Author-mode only, and that is structural rather than checked: this
      // server answers loopback alone, and `present` registers nothing like
      // these at all. A credential prompt in a deck you were emailed has
      // nowhere to post.
      if (req.method === 'POST' && url.pathname === '/edit/wizard') {
        const { engine, answers } = JSON.parse(body);
        if (typeof engine !== 'string') return json(400, { ok: false, error: 'which engine?' });
        // "No such engine" is a third answer, not one of the two failures. It is
        // not an outage to wait out and not a refusal by a provider — it is a
        // marketplace that was never added, and the fix is named.
        if (!(await wizardEntry(engine))) {
          return json(404, { ok: false, state: 'unknown',
            error: `no engine named "${engine}" declares a wizard in any registered marketplace — try: decklight marketplace add <owner/repo>` });
        }
        const r = await configureEngine(engine, answers, {
          fetchSchema: wizardSchemaFor,
          validateAnswers: wizardValidate,
        });
        if (r.state !== CONFIGURED) {
          // The three failures stay three: 503 for "could not reach", 400 for
          // "that was refused", and 412 for "this machine is missing something"
          // (ENGINES#LIPSYNC). A presenter whose key is wrong must not be told
          // to check their network, and one who is missing rhubarb must not be
          // told to check their key — the status code says which it is too.
          const code = r.state === UNREACHABLE ? 503 : r.state === PREREQUISITE ? 412 : 400;
          return json(code, { ok: false, state: r.state, error: r.reason, ...(r.unmet ? { unmet: r.unmet } : {}) });
        }
        // Redacted on the way out, always — the response is the one place a key
        // could leak back into a page, a devtools log, or a screen recording.
        console.log(`  wizard: ${engine} configured (${r.file})`);
        return json(200, { ok: true, state: r.state, engine, stored: r.stored });
      }
      if (req.method === 'POST' && url.pathname === '/edit/wizard/forget') {
        const { engine } = JSON.parse(body);
        if (typeof engine !== 'string') return json(400, { ok: false, error: 'which engine?' });
        const had = forgetCredentials(engine);
        console.log(`  wizard: ${engine} ${had ? 'forgotten' : 'was not configured'}`);
        return json(200, { ok: true, forgotten: had });
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
      // ── element edit mode (E, right-click a slide element) — #112 ─────
      // Same door as layout/notes: a pure (html, slide, index, …) → html
      // transform, through applyEdit, onto the ONE undo/redo stack.
      if (req.method === 'POST' && url.pathname === '/edit/element/remove') {
        const { slide, index } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0) throw new Error('bad payload');
        const changed = applyEdit(removeSlideElement(readDeck(), slide, index));
        if (changed) console.log(`  element removed: slide ${slide} #${index}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/element/content') {
        const { slide, index, html } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0 || typeof html !== 'string') {
          throw new Error('bad payload');
        }
        const changed = applyEdit(setSlideElementHtml(readDeck(), slide, index, html));
        if (changed) console.log(`  element content saved: slide ${slide} #${index}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      if (req.method === 'POST' && url.pathname === '/edit/element/effect') {
        const { slide, index, effect } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || !Number.isInteger(index) || index < 0
            || (effect !== null && typeof effect !== 'string')) {
          throw new Error('bad payload');
        }
        const changed = applyEdit(setSlideElementBuild(readDeck(), slide, index, effect));
        if (changed) console.log(`  element effect saved: slide ${slide} #${index} → ${effect ?? '(removed)'}`);
        return json(200, { ok: true, changed, ...history.counts() });
      }
      // Remember which agent A should reach for (#125, SPEC AGENT_UNITS). A
      // preference is a choice about this machine, not about the deck, so it
      // is written beside the unit library and never into the file.
      if (req.method === 'POST' && url.pathname === '/edit/agent/prefer') {
        const { agent } = JSON.parse(body);
        if (agent !== null && typeof agent !== 'string') throw new Error('bad payload');
        if (agent && !agents.some((a) => a.name === agent)) {
          return json(400, { ok: false, error: agentUnavailable(agent, agents) });
        }
        setPreferredAgent(agent);
        agentPref = agent ?? undefined;
        console.log(`  agent: ${agent ? `${agent} remembered as preferred` : 'preference cleared'}`);
        return json(200, { ok: true, preferredAgent: agent ?? null });
      }
      if (req.method === 'POST' && url.pathname === '/edit/agent') {
        const { prompt, agent, message } = JSON.parse(body);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
        if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
        const cmd = runAgent(prompt.trim(), agent, message);
        if (!cmd) return json(400, { ok: false, error: agentUnavailable(agent ?? agentPref, agents) });
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
  console.log(`decklight author on http://127.0.0.1:${actual}${deckUrl} — E element edit mode, L layouts, Z undo, A agent. Ctrl-C stops`);
}


if (isMain(import.meta.url)) {
  // author spawns this module directly, so the leash the dispatcher used to
  // arm is armed here — a no-op unless a supervising parent set it up.
  exitWhenOrphaned();
  editMain(process.argv.slice(2));
}
