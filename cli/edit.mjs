#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The live-editing deck server behind `decklight <deck>` (SPEC PRESENTING
// write mode). Not a command of its own anymore — the dispatcher refuses
// `edit` out loud — `open` spawns this module directly:
//
//   node cli/edit.mjs <deck.html> [--port 8788] [--git | --no-git]
//                     [--commit-every <seconds>] [--agent <name>] [--commit-messages]
//
// It binds 127.0.0.1 and nothing else. The phone remote used to be here behind
// `--remote`, which meant a clicker cost you an editing server on the LAN;
// `decklight <deck.html> --no-trust --remote` hosts it now, with no edit surface to widen
// (NO_TRUST#REMOTE). Both flags are refused out loud rather than ignored.
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /deck/ping            → { ok, deck, undo, redo, git, agents, agentBusy, wizards }
//   GET  /deck/events          → SSE; `reload` on deck change, `agent` job status
//   POST /deck/edit/slide/notes           → { slide, text }           rewrite that slide's notes
//   POST /deck/edit/timings         → { timings: [{ slide, seconds }] }  rehearsed times onto the sections
//   POST /deck/edit/slide/layout          → { slide, layout }         write data-layout to the file
//   POST /deck/edit/slide/hidden          → { slide, hidden }         data-hidden on or off (HIDDEN_SLIDES)
//   POST /deck/edit/export          → { kind }   write the deck out as a file (the palette's hand-over rows)
//   POST /deck/edit/export/stop     → stop that export part-way: its children killed, nothing half-written left
//   GET  /deck/edit/publish/plan    → where publishing would put this deck, without putting it there
//   POST /deck/edit/publish         → bundle the deck and push it (the palette's Publish row)
//   GET  /deck/edit/export/estimate → ?kind=bundle&theme=  how big that file would be, before it is written
//   GET  /deck/edit/element/source  → ?slide=&index=            an element's outerHTML, fresh from the file
//   POST /deck/edit/element/remove  → { slide, index }          delete that element
//   POST /deck/edit/element/content → { slide, index, html }    replace its outerHTML
//   POST /deck/edit/element/effect  → { slide, index, effect }  write data-build (null strips it)
//   POST /deck/edit/undo            → step the deck file back through the edit history
//   POST /deck/edit/redo            → step it forward again
//   POST /deck/edit/agent           → { prompt, agent?, slide?, offer?, place? } one-shot AI agent edit, the skill offered first
//   GET  /deck/edit/candidate       → the quick fix held for review (#907): its changes, slide by slide
//   GET  /deck/edit/candidate/at    → ?id=&side=before|after  either side of it, as a page
//   POST /deck/edit/candidate/apply → { id, take, rejected }  the approved slides, one undo entry
//   POST /deck/edit/candidate/adjust → { id, key, comment }   one slide of it back to the agent
//   POST /deck/edit/candidate/discard → { id }  drop it; the deck was never touched
//   POST /deck/edit/agent/stop      → stop the agent job in flight: that edit, an enhancement or a review
//   POST /deck/edit/enhance         → { slides: [n…]|'all', agent?, kind? } audio tags ('tags') or written for the ear ('spoken'), held for review
//   POST /deck/edit/rewrite         → { slides: [n…]|'all', tool, instruction?, agent? } the slide's own text: tighten, typos, match, custom (cli/rewrite.mjs), held for review
//   POST /deck/edit/review          → { agent? } the agent reads the deck, read-only, for Check deck…'s agent review (writes nothing)
//   GET  /deck/edit/review          → the last review's findings that still hold, each with the prompt that fixes it
//   POST /deck/edit/shutdown        → final autocommit, then exit — same as Ctrl-C, so a
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
// --no-git wasn't passed) the server snapshots the deck silently on
// refs/decklight/wip and commits it when you say so (K) — an agent's own
// edit commits itself; --git-mode timer keeps the old commit-every-N-seconds
// cadence with a final commit on Ctrl-C. --git also creates the repository when none
// exists — seeded with a starter .gitignore (createRepo, below).
// `decklight <deck>` asks interactively before passing --git down.

import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, watch, existsSync, rmSync } from 'node:fs';
// Every write of the DECK goes through this rather than writeFileSync: the
// edit server rewrites the whole file on every small edit, and a truncate
// that is interrupted leaves a prefix of a talk where the talk was.
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { resolve, relative, dirname, sep, basename } from 'node:path';
import { VIDEO_FORMATS, VIDEO_QUALITIES, VIDEO_SUBTITLES, VIDEO_FACE, valuesOf } from '../tools/video-options.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { agentAsk, agentCommand, agentModel, applyModelFlags, detectAgents, agentUnavailable, preferredAgent, setPreferredAgent, setAgentModel, takesModel, MODEL_ENV, claudeActivity } from './agents.mjs';
import { exitWhenOrphaned } from './supervise.mjs';
import { readyLine } from './banner.mjs';

/**
 * Say a startup fact.
 *
 * Under `open` (DECKLIGHT_BANNER) it becomes a row on the one banner author
 * prints, so it cannot land above the URL. Run standalone — `decklight edit` —
 * it prints the line it always printed, which is why every call passes both:
 * the SHORT text a banner row wants, and the full sentence a bare terminal
 * needs because it has no banner to sit under. `mark` is the banner's: 'ok'
 * for something installed and on (a green tick), 'warn' for something to fix.
 */
const startup = (key, text, human, mark) => {
  if (process.env.DECKLIGHT_BANNER) console.log(readyLine({ key, text, ...(mark ? { mark } : {}) }));
  else console.log(human);
};
import { argReader, firstPositional, isMain, parsePort, badPort } from '../tools/args.mjs';
import { runMain, afterOutput } from './util.mjs';
import { PKG, AGENTS_MARKER, skillVersionOf } from './skill-content.mjs';
import { selfCommand } from './pkg.mjs';
import { slidesSinceHead, slideRenumber } from './commit-split.mjs';
import { semverCompare } from '../tools/semver.mjs';

// The flags that take a value, so the deck can be found past them. `--git-mode`
// was missing, so `edit.mjs --git-mode agent deck.html` refused a deck called
// "agent". (`decklight <deck>` builds this argv itself and was never affected.)
const VALUE_FLAGS = ['--port', '--commit-every', '--agent', '--agent-model', '--agent-ask-model', '--git-mode', '--tts-port', '--lipsync-port',
  '--host', '--root', '--branch', '--into', '--upstream-every'];
import { NOTES_ASIDE, locateSlide, sectionChildRanges, elementChildRanges, splitOpenTag } from '../tools/deck-html.mjs';
import { canonMarks, writtenMarks, CLICK_MARK } from '../tools/sentences.mjs';
import { configBlock, hasEmbeddedRuntime, linkRuntime } from './runtime-link.mjs';
import { linkReferences } from './deck-refs.mjs';
import { slideTexts, priorSlideTexts, staleSlides, trackDrift } from '../tools/narration-manifest.mjs';
import { applyPlans, voiceFolders, realignMoves, planFolder, planMoves, planSteps, movesRenumber, trackScripts, followedSaid } from '../tools/voice-renumber.mjs';
// The routes that rewrite a slide, which took three of editMain's bindings and
// nothing else with them. The import back — edit-slides reaches here for the
// pure transforms — is a deliberate static cycle and not a dynamic one: this
// module ends in a top-level `await` (the isMain boot below), so a
// `await import('./edit-slides.mjs')` from inside editMain would wait on an
// evaluation that is waiting on IT, and the server would never come up.
// A static cycle has no such moment: both bodies are function declarations,
// hoisted before either runs, and nothing is read until a request arrives.
import { registerSlideRoutes } from './edit-slides.mjs';
// The route groups split out after it, imported the same way and for the same
// reason: the deck's look (themes, design systems, fonts), and handing the
// deck over (export, publish, the inspector's read), and git (the commit
// window, the deck's history, restore).
import { registerLookRoutes, runMarketplace, autoCheckInBackground } from './edit-look.mjs';
import { registerHandoverRoutes } from './edit-handover.mjs';
import { registerGitRoutes } from './edit-git.mjs';
import { registerFixReviewRoutes, adjustPrompt } from './fix-review.mjs';
// the boot-call locator audit and upgrade share — three commands, one answer
// about which <script> is the init call
import { classifyScripts, auditDeck, formatLabel, stripUnaccounted } from './audit.mjs';
// The no-trust mode's own ingredients (PRESENTING): the signature beside a
// deck, the .decklight container, the presenter's chrome, the upstream of a
// clone, and the phone remote. None of them writes.
import { randomBytes } from 'node:crypto';
import { verifyFile, verifyBytes, formatSignature, isVerified, UNSIGNED, TAMPERED, VERIFIED } from './sign.mjs';
import { isContainer, readContainer, formatManifest } from './deckfile.mjs';
import { loadLibrary, injectChrome } from './plugin.mjs';
import {
  SAFE_CONFIG, canPull, checkUpstream, resolveInterval, resolveUpstream, runGit, upstreamSuppressed,
} from './upstream.mjs';
import { createRemoteRelay } from './remote.mjs';
import { corsHeaders, readBody } from '../tools/bridge.mjs';
import { reviewPathFor, parseReview, serializeRecord, newId } from './review-store.mjs';
import { createReviewRoutes } from './review-routes.mjs';
import { createDeckRoutes } from './deck-routes.mjs';
// The arbiters of what a comment IS, shared with the no-trust mode so two
// writers cannot put two shapes into one union-merged file.
import { commentProblem, reviewRecord } from './review-routes.mjs';
import { foldReview } from '../tools/review-anchor.mjs';
import { recordingImpact, impactWarning, slidesFromFiles } from '../tools/recording-impact.mjs';
import { indexDeckFile, slideTextOf, knowsCommit } from './comments.mjs';
import { deckAt } from './restore.mjs';
import { escapeHtml, staticFiles, listenTakingOverIfNeeded, allowEditRequest, allowRemote, lanAddress, isOwnOrigin, CSP } from './serve.mjs';
import { reviewsWaiting, reviewLine, reviewCheckSuppressed } from './review-remote.mjs';
import { configureEngine, loadCredentials, forgetCredentials, redactAnswers, validateSchema, provenance, BRIDGE_ADDR, CONFIGURED, UNREACHABLE, PREREQUISITE } from './wizard.mjs';

// The `/deck/edit/*` surface answers loopback only — but "loopback" is the wrong
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
// (NO_TRUST in MARKETPLACE.md: `decklight <deck> --no-trust` reuses the same core
// with the /deck/edit/* routes ABSENT, not merely refused.) Re-exported here so
// existing importers — the tests, init.mjs — and SPEC citations keep working.
export { isLoopback, lanAddress, escapeHtml } from './serve.mjs';

/**
 * Click-separated plain text → the aside's inner HTML: one <p> per paragraph
 * — a blank line apart, as the author wrote them; saving never merges them —
 * and a `<p>[click]</p>` between beats. Every marker spelling is read
 * (`[click]`, `<click>`, `⟨CLICK⟩`…) and each is written back the one way
 * decklight writes them, in square brackets.
 */
export function notesTextToAside(text) {
  const ps = [];
  canonMarks(text).split(CLICK_MARK).forEach((seg, i) => {
    if (i > 0) ps.push('<p>[click]</p>');
    for (const para of writtenMarks(seg).split(/\n[ \t]*\n/)) {
      const p = para.replace(/\s+/g, ' ').trim();
      if (p) ps.push(`<p>${escapeHtml(p)}</p>`);
    }
  });
  return ps.join('\n        ');
}

/** Replace (or insert) slide N's <aside class="notes"> in the deck html. */
export function setSlideNotes(html, slide, asideInner) {
  const { parts, idx } = locateSlide(html, slide);
  const aside = `<aside class="notes">\n        ${asideInner}\n      </aside>`;
  const seg = parts[idx];
  parts[idx] = NOTES_ASIDE.test(seg)
    // FUNCTION replacers: the notes are the author's text, and a string
    // replacement would read `$1`, `$&`, `` $` `` and `$'` in it as patterns —
    // "$1M" spliced the slide's whole old notes in where it was typed (#646)
    ? seg.replace(NOTES_ASIDE, () => aside)
    : seg.replace(/<\/section>/, () => `  ${aside}\n    </section>`);
  return parts.join('');
}

/**
 * A slide's sources as the aside's inner HTML (`SLIDE_SOURCES`), or `null`
 * when there is nothing left to write.
 *
 * Link hrefs are restricted to the schemes a reference can honestly be:
 * `javascript:` and `data:` are executable, and this aside travels — a slide
 * taken from a marketplace template carries its sources into your deck, so an
 * editor that will write an executable link is an editor that will eventually
 * write somebody else's.
 */
export function sourcesToAside({ facts = [], links = [] } = {}, dropped = []) {
  const clean = (u) => (/^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(String(u).trim()) ? String(u).trim() : null);
  const pairs = facts.filter(([k, v]) => String(k).trim() && String(v).trim());
  const refs = links.filter((l) => {
    if (!String(l?.title ?? '').trim()) return false;
    if (clean(l?.href)) return true;
    // a link that will not be written is a link the author has to hear about:
    // an empty row is just an empty row, a rejected scheme is a decision
    if (String(l?.href ?? '').trim()) dropped.push(String(l.href).trim());
    return false;
  });
  if (!pairs.length && !refs.length) return null;
  const dl = pairs.length
    ? `<dl>${pairs.map(([k, v]) => `<dt>${escapeHtml(k.trim())}</dt><dd>${escapeHtml(v.trim())}</dd>`).join('')}</dl>`
    : '';
  const ul = refs.length
    ? ['<ul>', ...refs.map((l) => `          <li><a href="${escapeHtml(clean(l.href))}">${escapeHtml(String(l.title).trim())}</a>`
      + `${String(l.note ?? '').trim() ? ` — ${escapeHtml(String(l.note).trim())}` : ''}</li>`), '        </ul>'].join('\n')
    : '';
  return [dl, ul].filter(Boolean).join('\n        ');
}

/** Replace, insert, or remove slide N's `<aside class="sources">`. */
export function setSlideSources(html, slide, asideInner) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const existing = /\n?\s*<aside class="sources">[\s\S]*?<\/aside>/;
  if (!asideInner) {
    parts[idx] = seg.replace(existing, '');
    return parts.join('');
  }
  const aside = `<aside class="sources">\n        ${asideInner}\n      </aside>`;
  parts[idx] = existing.test(seg)
    ? seg.replace(existing, () => `\n      ${aside}`)   // the author's text: never a replacement pattern (#646)
    : seg.replace(/<\/section>/, () => `  ${aside}\n    </section>`);
  return parts.join('');
}

// the same ring the player cycles — the file is the source of truth now
/**
 * Is this deck already one file — nothing left for the bundler to flatten?
 *
 * `decklight bundle` asks exactly this and refuses when the answer is yes, so
 * the publish route asks it FIRST and passes `--no-bundle` rather than handing
 * a presenter a refusal about a flag. An init-scaffolded deck is this case,
 * which makes it the common one rather than the corner.
 */
export const alreadyOneFile = (html) =>
  !/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*themes\/[\w-]+\.css["']/i.test(html)
  && /<style\b[^>]*\bdata-theme\b/i.test(html)
  // an imported deck with a derived theme embeds that theme and nothing else
  // (#520): the runtime is still to be bundled in
  && hasEmbeddedRuntime(html);

/**
 * The files the palette's hand-over rows can ask for (PRESENTING). Each is one
 * of decklight's own commands, named the way the deck names it to the presenter
 * — `what` IS the wording in the toast, so the row, the terminal line and the
 * message log all say the same words.
 */
export const EXPORT_KINDS = {
  pptx: { what: 'PowerPoint', variant: null },
  pdf: { what: 'PDF', variant: '' },
  'pdf-notes': { what: 'PDF with notes', variant: 'notes' },
  'pdf-handout': { what: 'PDF handout', variant: 'handout' },
  video: { what: 'video', variant: null },
  // the self-contained file `decklight bundle` writes — every marked theme in
  // it, opening on the theme on screen
  bundle: { what: 'one file', variant: null },
};

/**
 * The preview frame's failure, as a page rather than as a bare line of text.
 *
 * This frame is 700px of dark chrome inside the history dialog, and a
 * plain-text body rendered in it reads as a black rectangle — which is how
 * #508 looked to everyone who hit it. Styled here, in the server's own words,
 * so the panel needs no failure branch of its own: whatever went wrong is
 * legible in the place somebody is already looking.
 */
export function previewError(why) {
  return `<!doctype html><meta charset="utf-8"><title>preview unavailable</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh;
    background: #16181d; color: #e8eaee; font: 14px/1.6 system-ui, sans-serif; }
  .box { max-width: 34em; padding: 24px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  p { margin: 0; opacity: .7; }
</style>
<div class="box"><h1>this version could not be previewed</h1><p>${escapeHtml(why)}</p></div>
`;
}

/**
 * What is wrong with a video export request, or null. Every field comes from a
 * page, so every one is checked before anything runs.
 *
 * - `slides` is the command's own `--slides` spelling; `format`, `quality` and
 *   `subtitles` its `--format`, `--quality` and `--subtitles`; `face: 'off'`
 *   its `--no-face`.
 * - The voice is ONE of three: `narration` names a recorded folder (inside the
 *   deck's directory, holding a manifest or whole-slide audio — a render that cannot find its audio
 *   should refuse, not come out silent); `synthesize` asks for the live voice
 *   to be voiced into a folder first; `silent` is silence by name. None of them
 *   is the command's own default: a `voiceover/` beside the deck if there is one.
 * - A synthesized voice never lands on a take somebody recorded. A folder that
 *   already holds audio is refreshed only when its manifest says it was this
 *   engine and this voice; anything else — a manifest for another voice, or
 *   audio with no manifest at all, which is what your own voice leaves — refuses.
 */
export function videoExportProblem({ slides, narration, synthesize, silent, format, quality, subtitles, face, allowStale } = {}, deckDir) {
  if (allowStale != null && typeof allowStale !== 'boolean') return 'allowStale is yes or no';
  // the card's rows and the command's flags read one list (src/core/video-options.js)
  for (const [field, value, list] of [['format', format, VIDEO_FORMATS], ['quality', quality, VIDEO_QUALITIES], ['subtitles', subtitles, VIDEO_SUBTITLES], ['face', face, VIDEO_FACE]]) {
    if (value != null && !valuesOf(list).includes(value)) return `${field} must be ${valuesOf(list).join(', ')}`;
  }
  if (slides != null && slides !== '' && !(typeof slides === 'string' && /^\d+(?:-\d+)?$/.test(slides))) {
    return 'slides must be a-b or a single slide number';
  }
  const given = [narration, synthesize, silent].filter((v) => v != null && v !== '' && v !== false);
  if (given.length > 1) return 'one voice at a time — a recorded track, a synthesized one, or silence';
  if (synthesize != null) {
    if (typeof synthesize !== 'object') return 'synthesize names an engine, a voice and a folder';
    const { engine, model, voice, style, dir } = synthesize;
    if (typeof engine !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(engine)) return 'name the engine to synthesize with';
    for (const [field, value, max] of [['model', model, 200], ['voice', voice, 200], ['style', style, 2000]]) {
      if (value != null && (typeof value !== 'string' || value.length > max || /\p{Cc}/u.test(value))) {
        return `the ${field} is not one this server will pass on`;
      }
    }
    const bad = folderProblem(dir, deckDir, 'the synthesized voice');
    if (bad) return bad;
    const at = resolve(deckDir, dir);
    let audio = [];
    try { audio = readdirSync(at).filter((f) => /^slide-\d+(-\d+)?\.(wav|m4a|mp3)$/.test(f)); } catch { /* a new folder */ }
    if (audio.length) {
      let m = null;
      try { m = JSON.parse(readFileSync(resolve(at, 'manifest.json'), 'utf8')); } catch { /* recorded by hand */ }
      if (!m || m.engine !== engine || (m.voice ?? null) !== (voice ?? null)) {
        return `${dir}/ already holds ${m?.voice ? `${m.voice}'s recording` : 'a recording'} — synthesizing into it would replace it`;
      }
    }
    return null;
  }
  if (narration == null || narration === '') return null;
  const bad = folderProblem(narration, deckDir, 'the narration');
  if (bad) return bad;
  // a manifest, or the audio itself: your own voice leaves no manifest, and
  // `decklight video` reads the files (folderNarration)
  let audio = false;
  try { audio = readdirSync(resolve(deckDir, narration)).some((f) => /^slide-\d+\.(wav|m4a|mp3)$/.test(f)); } catch { /* no folder */ }
  if (!audio && !existsSync(resolve(deckDir, narration, 'manifest.json'))) {
    return `no recorded narration in ${narration}/ — record the deck first (V → ＋ Add a voice…)`;
  }
  return null;
}

/** A folder named by a page: relative, inside the deck's own directory. */
function folderProblem(dir, deckDir, what) {
  if (typeof dir !== 'string' || !dir || dir.length > 200 || /^[a-z][a-z0-9+.-]*:/i.test(dir)) {
    return `${what} is a folder beside the deck, not a URL`;
  }
  const at = resolve(deckDir, dir);
  if (!at.startsWith(resolve(deckDir) + sep)) return `${what} folder must be inside the deck's folder (${dir})`;
  return null;
}

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
 * Write a rehearsed time onto a slide: `data-timing="42"` (seconds, whole).
 * `null` or 0 removes it. The attribute is the deck's memory of a rehearsal
 * (PRESENTING REHEARSAL_TIMINGS) and travels with the file, so the next
 * speaker view can show planned against actual.
 */
export function setSlideTiming(html, slide, seconds) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const gt = seg.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed <section> tag`);
  let head = seg.slice(0, gt).replace(/\s+data-timing=("[^"]*"|'[^']*')/, '');
  const n = Math.round(Number(seconds));
  if (Number.isFinite(n) && n > 0) head += ` data-timing="${n}"`;
  parts[idx] = head + seg.slice(gt);
  return parts.join('');
}

/**
 * Hide a slide from the talk, or show it again: `data-hidden` on the section
 * (DECK_ANATOMY HIDDEN_SLIDES). The slide keeps its number and its place in
 * the file — only the audience loses it. Same door as layout and timings.
 */
export function setSlideHidden(html, slide, hidden) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const gt = seg.indexOf('>');
  if (gt < 0) throw new Error(`slide ${slide}: malformed <section> tag`);
  let head = seg.slice(0, gt).replace(/\s+data-hidden(?:=("[^"]*"|'[^']*'))?(?=[\s>\/]|$)/, '');
  if (hidden) head += ' data-hidden';
  parts[idx] = head + seg.slice(gt);
  return parts.join('');
}

/** Look up element `index` (raw child position) on slide `slide`, or throw. */
export function locateElement(html, slide, index) {
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

/**
 * Remove ONE element inside slide N's element `index` (PRESENTING, a shape
 * selected inside a diagram): the node at `path`, addressed and checked the
 * way setElementStyles addresses one. `[]` is refused, since that is the
 * whole element and removeSlideElement's job. A node alone on its line takes
 * the line with it, so the file is left without a blank one.
 */
export function removeNestedElement(html, slide, index, { path, tag }) {
  if (!Array.isArray(path) || !path.length || path.length > 16 || path.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('bad path');
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  const el = seg.slice(r.start, r.end);
  let start = 0; let end = el.length;
  for (const n of path) {
    const kid = elementChildRanges(el.slice(start, end))[n];
    if (!kid) throw stale(`slide ${slide} #${index}: the file has no element at ${path.join('.')} — reload and try again`);
    end = start + kid.end; start += kid.start;
  }
  const found = /^<([a-zA-Z][\w:-]*)/.exec(el.slice(start, end))?.[1]?.toLowerCase();
  if (tag && found !== String(tag).toLowerCase()) throw stale(`slide ${slide} #${index}: the page found <${tag}> at ${path.join('.')}, the file has <${found}> — reload and try again`);
  const lineStart = el.lastIndexOf('\n', start - 1) + 1;
  const nl = el.indexOf('\n', end);
  const lineEnd = nl < 0 ? el.length : nl;
  if (/^[ \t]*$/.test(el.slice(lineStart, start)) && /^[ \t]*$/.test(el.slice(end, lineEnd)) && nl >= 0) { start = lineStart; end = nl + 1; }
  parts[idx] = seg.slice(0, r.start) + el.slice(0, start) + el.slice(end) + seg.slice(r.end);
  return parts.join('');
}

/**
 * The colours a page may ask this server to write (PRESENTING, element edit
 * mode): a theme token by reference — `var(--d-fill-3)`, so the deck stays
 * theme-aware — a design system's token with ONE hex fallback,
 * `var(--acme-blue, #0056f9)` (SPEC DESIGN_SYSTEMS: the colour survives the
 * design system going missing), or a literal hex colour. Nothing else — no
 * nested var(), no other characters: the value lands inside a style
 * attribute, and a style attribute is markup.
 */
const STYLE_VALUE = /^(?:var\(--[a-z][a-z0-9-]{0,40}(?:,\s?#[0-9a-f]{3,8})?\)|#[0-9a-f]{3,8})$/i;
const STYLE_PROPS = new Set(['fill', 'color', 'background-color', 'stroke', 'border-color']);
// a stroke's width (#717): a number in px, unitless on a shape the way SVG
// reads it, `px` on a box the way CSS does — never anything that is not one
const WIDTH_PROPS = new Set(['stroke-width', 'border-width']);
const WIDTH_VALUE = /^(?:\d{1,2}(?:\.\d{1,2})?)(?:px)?$/;
// the colour card's Type side: the size in px (deck units: the stage is
// scaled, not the text), a weight in hundreds, one of the theme's three font
// roles by reference (never a family name, so the type follows `T` and a
// deck's marked fonts), and where a line sits. Each a closed shape.
const TYPE_VALUES = {
  'font-size': /^(?:[1-9]\d{0,2}(?:\.\d)?)px$/,
  'font-weight': /^[1-9]00$/,
  'font-family': /^var\(--font-(?:heading|body|mono)\)$/,
  'font-style': /^(?:normal|italic)$/,
  'text-anchor': /^(?:start|middle|end)$/,
  'text-align': /^(?:left|center|right)$/,
};
const kindOf = (prop) => (STYLE_PROPS.has(prop) ? 'colour' : WIDTH_PROPS.has(prop) ? 'width' : Object.hasOwn(TYPE_VALUES, prop) ? prop.replace('-', ' ') : null);
const valueShape = (prop) => (STYLE_PROPS.has(prop) ? STYLE_VALUE : WIDTH_PROPS.has(prop) ? WIDTH_VALUE : TYPE_VALUES[prop]);

/** The page and the file disagree about what is where: a 409, not a bad request. */
const stale = (message) => Object.assign(new Error(message), { code: 'STALE' });

/** `style` text with `prop` set to `value` (null: taken off) — its old declaration replaced, the rest kept in order. */
export function withStyleProp(style, prop, value) {
  const kept = String(style ?? '').split(';').map((d) => d.trim()).filter(Boolean)
    .filter((d) => d.slice(0, d.indexOf(':')).trim().toLowerCase() !== prop);
  return (value === null ? kept : [...kept, `${prop}: ${value}`]).join('; ');
}

/**
 * Set style properties on elements INSIDE slide N's element `index` — a shape
 * in a diagram and the text on it, in one edit (so `Z` takes both back).
 *
 * Each edit is `{ path, tag, prop, value }`: `path` is the element's
 * child-index path below the slide's top-level element (`[]` is that element
 * itself), counted over the FILE's elements, and `tag` is what the page found
 * there — the live DOM is not the file (the engine adds nodes of its own), so
 * a path that lands on a different tag is refused rather than recoloured.
 * Only the open tag's `style` attribute is touched, textually: every other
 * attribute — `viewBox` and its capitals included — survives byte for byte.
 * A `value` of null takes the declaration back off, and a `style` left empty
 * goes with it. A slot token picked on a nested box still takes its panel's
 * tone (SVG_DIAGRAMS): the pick names the colour family, the engine keeps it
 * legible where it sits — `data-nest="off"` in the markup is the opt-out.
 */
export function setElementStyles(html, slide, index, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 40) throw new Error('bad edits');
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  let el = seg.slice(r.start, r.end);
  // each edit re-walks from the top: the one before it changed the offsets
  for (const e of edits) {
    if (!Array.isArray(e?.path) || e.path.length > 16 || e.path.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('bad path');
    const kind = kindOf(e.prop);
    if (!kind) throw new Error(`not a property this server writes: ${String(e.prop).slice(0, 40)}`);
    if (e.value !== null && (typeof e.value !== 'string' || !valueShape(e.prop).test(e.value))) throw new Error(`not a ${kind} this server writes: ${String(e.value).slice(0, 40)}`);
    let start = 0; let end = el.length;
    for (const n of e.path) {
      const kids = elementChildRanges(el.slice(start, end));
      const kid = kids[n];
      if (!kid) throw stale(`slide ${slide} #${index}: the file has no element at ${e.path.join('.')} — the engine drew this one, or the deck changed; reload and try again`);
      end = start + kid.end; start += kid.start;
    }
    const node = el.slice(start, end);
    const tag = /^<([a-zA-Z][\w:-]*)/.exec(node)?.[1]?.toLowerCase();
    if (e.tag && tag !== String(e.tag).toLowerCase()) {
      throw stale(`slide ${slide} #${index}: the page found <${e.tag}> at ${e.path.join('.') || 'the element'}, the file has <${tag}> — reload and try again`);
    }
    const { attrs, close, rest } = splitOpenTag(node);
    const styleM = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const style = withStyleProp(styleM ? (styleM[2] ?? styleM[3]) : '', e.prop, e.value).replace(/"/g, "'");
    const attr = style ? ` style="${style}"` : '';
    const head = styleM ? attrs.replace(styleM[0], () => attr) : attrs + attr;
    el = el.slice(0, start) + head + close + rest + el.slice(end);
  }
  parts[idx] = seg.slice(0, r.start) + el + seg.slice(r.end);
  return parts.join('');
}

/**
 * Set or remove ONE attribute on an element below slide N's child `index`,
 * addressed the way setElementStyles addresses one (`path` below the
 * element, `tag` as the page saw it). What this server writes this way is a
 * closed set — `data-concept` (SVG_DIAGRAMS, #718) — with a value that is a
 * name and nothing else; null takes the attribute off.
 */
const ATTR_NAMES = new Set(['data-concept']);
const ATTR_VALUE = /^[a-z][a-z0-9-]{0,40}$/i;
export function setElementAttr(html, slide, index, { path, tag, name, value }) {
  if (!Array.isArray(path) || path.length > 16 || path.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('bad path');
  if (!ATTR_NAMES.has(name)) throw new Error(`not an attribute this server writes: ${name}`);
  if (value !== null && (typeof value !== 'string' || !ATTR_VALUE.test(value))) throw new Error(`not a name: ${String(value).slice(0, 40)}`);
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  let el = seg.slice(r.start, r.end);
  let start = 0; let end = el.length;
  for (const n of path) {
    const kid = elementChildRanges(el.slice(start, end))[n];
    if (!kid) throw stale(`slide ${slide} #${index}: the file has no element at ${path.join('.')} — reload and try again`);
    end = start + kid.end; start += kid.start;
  }
  const node = el.slice(start, end);
  const found = /^<([a-zA-Z][\w:-]*)/.exec(node)?.[1]?.toLowerCase();
  if (tag && found !== String(tag).toLowerCase()) throw stale(`slide ${slide} #${index}: the page found <${tag}> at ${path.join('.') || 'the element'}, the file has <${found}> — reload and try again`);
  const { attrs, close, rest } = splitOpenTag(node);
  const re = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i');
  const head = value === null ? attrs.replace(re, '') : (re.test(attrs) ? attrs.replace(re, () => ` ${name}="${value}"`) : `${attrs} ${name}="${value}"`);
  el = el.slice(0, start) + head + close + rest + el.slice(end);
  parts[idx] = seg.slice(0, r.start) + el + seg.slice(r.end);
  return parts.join('');
}

/** The text a run of markup reads as: the entities a label is likely to carry, decoded. */
const decodeText = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
});
const sameWords = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

/**
 * Replace the words of ONE diagram label (SVG_DIAGRAMS): the `<text>` or
 * `<tspan>` at `path` below slide N's element `index`, addressed the way
 * setElementStyles addresses a shape. Only what is between its tags changes,
 * and only when that is words: a `<text>` holding `<tspan>` lines is refused,
 * since each line is its own label. `was` is what the page showed there, and
 * a file that says something else is stale (a 409), not overwritten. The
 * whitespace the file has around the words is kept, and `<`, `>` and `&` are
 * escaped on the way in, so the markup around the label survives byte for
 * byte. One line, because SVG text does not wrap.
 */
const LABEL_TAGS = new Set(['text', 'tspan']);
export function setElementText(html, slide, index, { path, tag, was, text }) {
  if (!Array.isArray(path) || path.length > 16 || path.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('bad path');
  if (typeof text !== 'string' || text.length > 400 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('a label is one line of at most 400 characters');
  if (typeof was !== 'string') throw new Error('bad payload');
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  let el = seg.slice(r.start, r.end);
  let start = 0; let end = el.length;
  for (const n of path) {
    const kid = elementChildRanges(el.slice(start, end))[n];
    if (!kid) throw stale(`slide ${slide} #${index}: the file has no element at ${path.join('.')} — reload and try again`);
    end = start + kid.end; start += kid.start;
  }
  const node = el.slice(start, end);
  const found = /^<([a-zA-Z][\w:-]*)/.exec(node)?.[1]?.toLowerCase();
  if (tag && found !== String(tag).toLowerCase()) throw stale(`slide ${slide} #${index}: the page found <${tag}> at ${path.join('.') || 'the element'}, the file has <${found}> — reload and try again`);
  if (!LABEL_TAGS.has(found)) throw new Error(`not a diagram label: <${found}>`);
  const { attrs, close, rest } = splitOpenTag(node);
  const closeAt = rest.toLowerCase().lastIndexOf(`</${found}`);
  if (close.endsWith('/>') || closeAt < 0) throw new Error(`<${found}> has no words to edit`);
  const inner = rest.slice(0, closeAt);
  if (/<(?!!--)/.test(inner)) throw new Error(`this <${found}> holds other elements — edit one line at a time`);
  if (!sameWords(decodeText(inner.replace(/<!--[\s\S]*?-->/g, '')), was)) {
    throw stale(`slide ${slide} #${index}: the file's label is not the one the page showed — reload and try again`);
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lead = /^\s*/.exec(inner)[0]; const trail = /\s*$/.exec(inner)[0];
  const words = inner.trim() ? lead + escaped + trail : escaped;
  el = el.slice(0, start) + attrs + close + words + rest.slice(closeAt) + el.slice(end);
  parts[idx] = seg.slice(0, r.start) + el + seg.slice(r.end);
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
/**
 * Skip one JS string literal starting at `i` (which is its quote). Returns the
 * index of the closing quote, or the end of the text if it never closes.
 *
 * The whole reason the walkers below are walkers and not regexes: a config
 * carrying `{ alt: "Acme (Inc)" }` or `{ title: "a } b" }` closes nothing, and
 * a regex counting brackets reads both as structure. `cli/audit.mjs` learned
 * this first (isBootCall); this is the same rule applied to the object.
 */
function skipString(text, i) {
  const q = text[i];
  for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
  return i;
}

/**
 * Skip one JS comment starting at `i` (which is its `/`). Returns the index of
 * the comment's last character, or `i` unchanged when this `/` is not a
 * comment at all (division, a lone slash in whatever).
 *
 * The walkers below skip strings and skipped nothing else — so a deck whose
 * boot call carried a commented-out earlier track (`// narration: { files:
 * 'old' }` — exactly what an author leaves behind) had that key
 * FOUND, the splice landed inside the comment, and the UI said ✓ while the
 * deck played nothing. An unbalanced `)` in a comment likewise ended
 * initArgument's span early, and a splice into a truncated span corrupts the
 * file rather than missing it.
 */
function skipComment(text, i) {
  if (text[i] !== '/') return i;
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i + 2);
    return nl === -1 ? text.length : nl;
  }
  if (text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 1;
  }
  return i;
}

/**
 * The `Decklight.init(…)` argument in `html`: where it starts and ends.
 *
 * Located through the same classifier `audit` and `upgrade` use, so all three
 * agree on which `<script>` is the boot call rather than each finding its own.
 * Returns null when the deck has no boot call at all.
 */
export function initArgument(html) {
  const boot = classifyScripts(html).find((b) => b.kind === 'boot');
  if (!boot) return null;
  const inner = html.slice(boot.start, boot.end);
  const m = /Decklight\s*\.\s*init\s*\(/.exec(inner);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(inner, i); continue; }
    if (c === '/') { const j = skipComment(inner, i); if (j !== i) { i = j; continue; } }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      return { start: boot.start + open + 1, end: boot.start + i };
    }
  }
  return null;
}

/**
 * Where a TOP-LEVEL key's value sits inside an object literal, or null.
 *
 * Depth-aware and string-aware: a `narration:` nested inside `character: {…}`
 * is not this object's key, and `{ note: "narration: off" }` is not a key at
 * all. Both are things a plausible deck contains.
 */
function objectKey(obj, key) {
  const re = new RegExp(`^${key}\\s*:`);
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(obj, i); continue; }
    if (c === '/') { const j = skipComment(obj, i); if (j !== i) { i = j; continue; } }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (depth !== 1) continue;
    // The boundary is checked against the PREVIOUS character, not folded into
    // the regex: `^` matches the start of every slice, so the old
    // `(^|[{,\\s])` form let `mynarration:` match at its own `n`.
    if (i > 0 && !/[{,\s]/.test(obj[i - 1])) continue;
    const m = re.exec(obj.slice(i, i + key.length + 2));
    if (!m) continue;
    // the value runs to the comma or closing brace at THIS depth
    let j = i + m[0].length;
    let d = 0;
    for (; j < obj.length; j++) {
      const v = obj[j];
      if (v === '"' || v === "'" || v === '`') { j = skipString(obj, j); continue; }
      if (v === '/') { const k2 = skipComment(obj, j); if (k2 !== j) { j = k2; continue; } }
      if (v === '{' || v === '[' || v === '(') d++;
      else if (v === '}' || v === ']' || v === ')') { if (d === 0) break; d--; }
      else if (v === ',' && d === 0) break;
    }
    return { from: i, to: j, valueFrom: i + m[0].length };
  }
  return null;
}

/**
 * The span of each top-level element of an array literal, `[` … `]` included
 * in the input. String- and depth-aware for the same reason everything else
 * here is: `[{ label: 'a, b' }]` is one element, not two.
 */
function arrayEntries(arr) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(arr, i); continue; }
    if (c === '/') { const j = skipComment(arr, i); if (j !== i) { i = j; continue; } }
    if (c === '{' || c === '[' || c === '(') {
      if (depth === 1 && start === -1) start = i;
      depth++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 1 && start !== -1) { out.push({ from: start, to: i + 1 }); start = -1; }
      continue;
    }
    if (depth === 1 && start === -1 && !/[\s,]/.test(c)) start = i;
    if (depth === 1 && start !== -1 && c === ',') { out.push({ from: start, to: i }); start = -1; }
  }
  if (start !== -1) out.push({ from: start, to: arr.lastIndexOf(']') });
  return out;
}

/**
 * An entry literal with `track`'s keys written into it and every other key
 * left exactly as it was typed (#926). Each key is set in place where the
 * entry already has it, and appended where it does not — so `segments: true`,
 * a label, a comment, anything the author added by hand, survives an update
 * that did not mention it.
 */
function mergeLiteral(entry, track) {
  let out = entry;
  for (const [k, v] of Object.entries(track)) {
    if (v === undefined || v === null) continue;
    const val = narrationLiteral({ [k]: v }).slice(2 + k.length + 2, -2);
    const span = objectKey(out, k);
    if (span) {
      const old = out.slice(span.valueFrom, span.to);
      out = out.slice(0, span.valueFrom) + ` ${val}${/\s*$/.exec(old)[0]}` + out.slice(span.to);
    } else {
      const close = out.lastIndexOf('}');
      const head = out.slice(0, close).replace(/[\s,]*$/, '');
      out = `${head}${head.endsWith('{') ? ' ' : ', '}${k}: ${val} ${out.slice(close)}`;
    }
  }
  return out;
}

/** `{ files: 'voiceover', ext: 'wav', segments: true }`, as a person writes it. */
export function narrationLiteral(cfg) {
  const parts = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}: ${typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : v}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Point the deck's own config at a track that was just recorded.
 *
 * The recorder writes the files and then had to ask you to paste a config line
 * into the deck by hand — the one manual step in a flow that is otherwise a
 * key and an arrow. The edit server already owns this file (it writes notes,
 * layouts and element edits), so it can write this too, through the same
 * applyEdit door: Z undoes it, live-reload shows it.
 *
 * Returns the new HTML, or **null when the config is not a literal at the call
 * site** — `const cfg = {…}; Decklight.init(cfg)` has nothing here to edit, and
 * guessing which `cfg` is meant, in which scope, is how an editor corrupts a
 * file. That deck keeps the printed line and is told why.
 */
/**
 * Add a recorded track to the deck's `narration.files`, or update it in place.
 *
 * ADD, not replace. A deck can carry as many tracks as you have voices — four
 * cloned ones, the system voice, two takes of your own — and `N` is the
 * switcher. Replacing the key (which is what this did when it only knew how to
 * write one) threw the others away the first time somebody recorded a second
 * voice, which is exactly when a multi-track deck exists.
 *
 * A track already listed under the same `dir` is UPDATED rather than added
 * twice: re-recording into a folder should refresh what the deck says about
 * it, not leave the picker showing the same folder twice.
 *
 * The one-string form (`files: 'voiceover'`, with `ext`/`segments` beside it)
 * becomes a one-element list carrying those same keys — the shape
 * `narrationTracks()` already normalises it to internally, so the deck plays
 * identically before and after.
 *
 * Returns the new HTML, or null when there is no literal here to edit.
 */
/**
 * The local track directories a deck's `narration.files` names, in order.
 *
 * A directory track is a folder of recorded audio; a `manifest`/cloud entry
 * has no local `dir` and is not one. Uses the same init walkers upsert does,
 * so it reads exactly the config the deck actually runs — the `files: 'x'`
 * one-string form counts too. Returns `[]` for a deck with no narration, a
 * config built outside the call, or a manifest-only track.
 */
export function configuredTrackDirs(html) {
  // A deck as data (#520): the configuration is JSON, and reads as such.
  const block = configBlock(html);
  if (block) {
    const files = block.config?.narration?.files;
    if (typeof files === 'string') return [files];
    if (!Array.isArray(files)) return [];
    return files.flatMap((e) => (typeof e === 'string' ? [e] : e && typeof e === 'object' && e.dir && !e.manifest ? [e.dir] : []));
  }
  const arg = initArgument(html);
  if (!arg) return [];
  const raw = html.slice(arg.start, arg.end);
  const open = raw.indexOf('{');
  if (open === -1 || raw.slice(0, open).trim()) return [];
  const obj = raw.slice(open, raw.lastIndexOf('}') + 1);
  const narr = objectKey(obj, 'narration');
  if (!narr) return [];
  const nval = obj.slice(narr.valueFrom, narr.to).trim();
  if (!nval.startsWith('{')) return [];
  const files = objectKey(nval, 'files');
  if (!files) return [];
  const fval = nval.slice(files.valueFrom, files.to).trim();
  const dirs = [];
  if (fval.startsWith('[')) {
    for (const e of arrayEntries(fval)) {
      const entry = fval.slice(e.from, e.to);
      // a `dir` names a folder; a `manifest` entry is cloud and has none
      const m = /\bdir\s*:\s*(['"`])([^'"`]*)\1/.exec(entry);
      if (m && !/\bmanifest\s*:/.test(entry)) dirs.push(m[2]);
    }
  } else {
    // the one-string form: files: 'voiceover'
    const m = /^(['"`])([^'"`]*)\1$/.exec(fval);
    if (m) dirs.push(m[2]);
  }
  return dirs;
}

export function upsertNarrationTrack(html, track) {
  // A deck as data (#520): the block is parsed, changed and written back as
  // JSON — its own formatting goes, its every key survives. Null when the
  // block is not JSON: an editor that guesses at broken data corrupts it.
  const block = configBlock(html);
  if (block) {
    if (!block.config) return null;
    const cfg = block.config;
    if (cfg.narration !== undefined && (typeof cfg.narration !== 'object' || cfg.narration === null || Array.isArray(cfg.narration))) return null;
    const narr = cfg.narration ?? (cfg.narration = {});
    const entry = Object.fromEntries(Object.entries(track).filter(([, v]) => v !== undefined && v !== null));
    let list;
    if (Array.isArray(narr.files)) list = narr.files;
    else if (typeof narr.files === 'string') {
      // the one-string form becomes the first entry, ext/segments moving into it
      const kept = { label: narr.files, dir: narr.files };
      for (const k of ['ext', 'segments']) if (narr[k] !== undefined) { kept[k] = narr[k]; delete narr[k]; }
      list = [kept];
    } else list = [];
    const same = list.findIndex((e) => (typeof e === 'string' ? e : e?.dir) === track.dir);
    // MERGED into, never replaced (#926): a key the update does not mention —
    // `segments`, a label, anything added by hand — is not a key to delete
    const was = list[same];
    if (same >= 0) list[same] = was && typeof was === 'object' ? { ...was, ...entry } : entry;
    else list.push(entry);
    narr.files = list;
    const indent = /(?:^|\n)([ \t]*)[^\n]*$/.exec(html.slice(0, block.start))?.[1] ?? '';
    const json = JSON.stringify(cfg, null, 2).split('\n').map((l) => indent + l).join('\n');
    return `${html.slice(0, block.innerStart)}\n${json}\n${indent}${html.slice(block.innerEnd)}`;
  }
  const arg = initArgument(html);
  if (!arg) return null;
  const raw = html.slice(arg.start, arg.end);
  const splice = (from, to, text) => html.slice(0, from) + text + html.slice(to);
  const one = narrationLiteral(track);

  // no config object at the call site at all
  if (!raw.trim()) return splice(arg.start, arg.end, `{ narration: { files: [${one}] } }`);
  const open = raw.indexOf('{');
  if (open === -1 || raw.slice(0, open).trim()) return null;
  const close = raw.lastIndexOf('}');
  if (close < open) return null;
  const obj = raw.slice(open, close + 1);
  const at = arg.start + open;

  const narr = objectKey(obj, 'narration');
  if (!narr) {
    const inner = obj.slice(1, -1);
    const body = inner.trim()
      ? `{ narration: { files: [${one}] },${inner.replace(/^\s*\n?/, inner.includes('\n') ? '\n' : ' ')}}`
      : `{ narration: { files: [${one}] } }`;
    return splice(at, arg.start + close + 1, body);
  }

  const nval = obj.slice(narr.valueFrom, narr.to).trim();
  const nvalAt = at + narr.valueFrom + (obj.slice(narr.valueFrom, narr.to).length - obj.slice(narr.valueFrom, narr.to).trimStart().length);
  if (!nval.startsWith('{')) return null;   // narration built elsewhere

  const files = objectKey(nval, 'files');
  if (!files) {
    const inner = nval.slice(1, -1);
    const body = inner.trim() ? `{ files: [${one}],${inner.replace(/^\s*/, ' ')}}` : `{ files: [${one}] }`;
    return splice(nvalAt, nvalAt + nval.length, body);
  }

  const fval = nval.slice(files.valueFrom, files.to).trim();
  const fvalStart = nvalAt + nval.indexOf(fval, files.valueFrom);

  // already a list: update the entry naming this folder, else append
  if (fval.startsWith('[')) {
    const entries = arrayEntries(fval);
    const same = entries.find((e) => {
      const m = /\bdir\s*:\s*(['"`])([^'"`]*)\1/.exec(fval.slice(e.from, e.to));
      return m && m[2] === track.dir;
    });
    if (same) return splice(fvalStart + same.from, fvalStart + same.to, mergeLiteral(fval.slice(same.from, same.to), track));
    const closeAt = fval.lastIndexOf(']');
    const body = entries.length ? `,\n    ${one}\n  ` : one;
    return splice(fvalStart + closeAt, fvalStart + closeAt, body);
  }

  // the one-string form: carry it across as the first entry, keys and all
  const m = /^(['"`])([^'"`]*)\1$/.exec(fval);
  if (!m) return null;
  const kept = { label: m[2], dir: m[2] };
  for (const k of ['ext', 'segments']) {
    const found = objectKey(nval, k);
    if (!found) continue;
    const v = nval.slice(found.valueFrom, found.to).trim();
    kept[k] = v === 'true' ? true : v === 'false' ? false : v.replace(/^['"`]|['"`]$/g, '');
  }
  const list = kept.dir === track.dir ? [narrationLiteral({ ...kept, ...track })] : [narrationLiteral(kept), one];
  // the sibling ext/segments moved INTO the entry they described, so they must
  // not stay behind saying it about every track
  const rest = [];
  for (const [k, span] of ['liveUrl', 'character', 'engine', 'voice', 'style']
    .map((k) => [k, objectKey(nval, k)]).filter(([, v]) => v)) {
    rest.push(nval.slice(span.from, span.to).trim().replace(/,$/, ''));
  }
  const body = `{ files: [\n    ${list.join(',\n    ')}\n  ]${rest.length ? `, ${rest.join(', ')}` : ''} }`;
  return splice(nvalAt, nvalAt + nval.length, body);
}

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
/**
 * What a write route did, in the words the page's debug log shows beside a
 * reload (PRESENTING, debug log). The reload message names it, so a page that
 * comes back can say WHY it went — "notes saved · this tab" rather than a
 * bare reload, which is the one thing a log wiped by the reload cannot say.
 */
const WRITE_LABELS = {
  '/deck/edit/slide/notes': 'notes saved',
  '/deck/edit/slide/sources': 'sources saved',
  '/deck/edit/timings': 'rehearsal timings saved',
  '/deck/edit/slide/layout': 'layout picked',
  '/deck/edit/slide/template': 'template switched',
  '/deck/edit/slide/hidden': 'slide hidden or shown',
  '/deck/edit/slide': 'slides rearranged',
  '/deck/edit/narration': 'narration track saved',
  '/deck/edit/narration/record': 'narration recorded',
  '/deck/edit/element/remove': 'element removed',
  '/deck/edit/element/content': 'element content saved',
  '/deck/edit/element/effect': 'build effect set',
  '/deck/edit/element/style': 'colours saved',
  '/deck/edit/element/concept': 'concept set',
  '/deck/edit/element/text': 'text saved',
  '/deck/edit/element/image': 'image placed',
  '/deck/edit/concepts': 'concept colours saved',
  '/deck/edit/asset': 'asset added',
  '/deck/edit/undo': 'undo (Z)',
  '/deck/edit/redo': 'redo (⇧Z)',
  '/deck/edit/restore': 'restored from git',
  '/deck/edit/theme': 'theme picked',
  '/deck/edit/brand-themes': 'brand themes set',
  '/deck/edit/theme/add': 'theme added',
  '/deck/edit/theme/mark': 'theme marked',
  '/deck/edit/font/mark': 'font marked',
  '/deck/edit/design-system/apply': 'design system applied',
  '/deck/edit/design-system/mark': 'design system marked',
  '/deck/edit/design-system/migrate': 'design system migrated',
  '/deck/edit/check/fix': 'problem fixed',
  '/deck/edit/candidate/apply': 'reviewed fix applied',
  '/deck/edit/enhance': 'script enhanced',
  '/deck/edit/wizard': 'engine set up',
  '/deck/upstream/pull': 'git pull',
};
export function whatWrote(pathname) {
  return WRITE_LABELS[pathname] ?? `${String(pathname ?? '').replace(/^\/deck\/(edit\/)?/, '').replace(/\//g, ' ') || 'the deck'} written`;
}

/**
 * What the agent panel shows of an agent's report: all of it up to `max`,
 * and past that its start and its end with what was cut said between them.
 * A report leads with what it did, so the start is never the part to lose.
 */
export function reportText(text, max = 4000) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const end = Math.floor(max / 4);
  return `${s.slice(0, max - end).trimEnd()}\n…\n${s.slice(-end).trimStart()}`;
}

/**
 * The reason a reload carries. A write of the server's own within the last
 * moments is that write; the file changing while an agent runs is the
 * agent's; anything else changed on disk by a hand this server never saw —
 * an editor, git, a tool. The page shows it as the first line after the
 * reload, with "this tab" or "another tab" when the write said which page.
 */
export const RELOAD_WRITE_WINDOW_MS = 2000;
export function describeReload({ write = null, agent = null, now = Date.now() } = {}) {
  if (write && now - write.at <= RELOAD_WRITE_WINDOW_MS) return { reload: write.what, from: write.from ?? null };
  // a job that names its own reason says it (a migration: "migrated to acme 6.0.0")
  if (agent) return { reload: agent.reload ?? `${agent.agent}'s edit`, from: null };
  return { reload: 'changed on disk — an editor, git, or a tool outside this server', from: null };
}

/**
 * Undo and redo, as snapshots of the deck. An entry is the deck's text, or
 * `{ deck, files: { <path>: text } }` for one step that also wrote files
 * beside it (a migration renames in the stylesheets the deck links), so one
 * Z puts them all back. `current` may be a function of the entry being
 * taken, for the caller to snapshot exactly the files that entry names.
 */
export function createHistory(limit = 200) {
  const past = [];
  const future = [];
  const now = (current, entry) => (typeof current === 'function' ? current(entry) : current);
  return {
    record(before) {
      past.push(before);
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      const entry = past.pop();
      future.push(now(current, entry));
      return entry;
    },
    redo(current) {
      if (!future.length) return null;
      const entry = future.pop();
      past.push(now(current, entry));
      return entry;
    },
    counts() { return { undo: past.length, redo: future.length }; },
  };
}

// ── git: the durable record (the history above is the fast loop) ──────────
// The plumbing lives in git.mjs now; imported for editMain's use below and
// re-exported so long-standing importers (init, the tests) keep finding it
// where edit grew it.
import { inGitRepo, gitAvailable, createRepo, STARTER_GITIGNORE, gitAutocommit, lastCommitSha, resolveGitMode, shouldCommit, commitSubject, untrackedFiles, exitPushLine, oneline, remoteState } from './git.mjs';
import {
  describeCommit, messagesLine, deckOutline,
} from './commit-message.mjs';
import { WIP_REF, deckDirty, nagText, planNag, snapshotWip, wipLine } from './commit-flow.mjs';
export { inGitRepo, createRepo, STARTER_GITIGNORE, gitAutocommit };

/** Who the author is, from git's own answer — see cli/review-routes.mjs. */
function reviewerName(cwd = process.cwd()) {
  const cfg = (key) => {
    try { return execFileSync('git', ['config', key], { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
  };
  const name = cfg('user.name');
  const email = cfg('user.email');
  return (name && email) ? `${name} <${email}>` : (name || email || '');
}


/** `decklight <deck> --no-trust --help`: the no-trust mode's own flags. */
const READ_ONLY_USAGE = `usage: decklight <deck.html|deck.decklight|repository url> --no-trust [--port 8788] [--strict]
                        [--root <dir>] [--remote] [--host <addr>] [--audit]
                        [--no-plugins] [--branch <ref>] [--into <dir>]

  opens a deck in no-trust mode — the safe way in for one you did not write,
  and the only mode a .decklight container opens in. The deck is served from
  its own directory, under a Content-Security-Policy header, with every file
  type a deck cannot use and every dotfile refused; every route that writes
  refuses, and nothing is written. The mode is the run's: it is decided here,
  when the deck is opened, and never from the page.

  A .decklight container (bundle --deck) is unwrapped in memory and treated
  exactly like the deck it wraps: same audit, same policy, same strict rule. Its
  signature is verified and its manifest is printed as what it is — the
  container's own claim about itself, next to the one thing that was checked.
  The manifest's origin (repo and commit) is never printed: the signature
  covers the deck alone, so even on a verified container the origin is whatever
  the packer wrote, and a provenance line nobody vouches for does not belong
  one skim away from a verified identity. It stays in the manifest for tooling
  to read.

  A repository URL (https://github.com/you/talk, git@…, …/talk.git; #path
  picks a deck inside) is cloned to ./<repo> — or the clone already there,
  whichever command made it, is opened — and the deck in it played. The
  clone's upstream is what H checks for the author's newer pushes.

  --branch R the branch or tag to clone (a repository URL)
  --into D   where to clone it (default: ./<repo name>)
  --port N   port to bind; a taken port offers to take over that session
             (on a TTY) or moves on to the next free one            [8788]
  --strict   serve with every script block that is not the runtime removed,
             along with every inline on*= handler, javascript: URL and srcdoc
             document. The removal happens on the way out — the file on disk
             is never touched. Turns itself on when the label finds something.
  --root D   serve D instead of the deck's directory, for a SOURCE deck that
             reaches up for its runtime (demo/talk.html loading
             ../dist/decklight.js). The deck must live under D, and everything
             under D that passes the dotfile and file-type rules becomes
             fetchable by the deck's own script — which is why widening the
             root is a flag you type, never something the cwd decides.
  --remote   also listen on the LAN for the phone remote. Off this machine ONLY
             /deck/remote/* answers, and only with the per-run token the printed URL
             and its QR carry — the deck itself, and every file beside it, stay
             unreachable from the LAN whether or not this flag is passed.
  --host A   the address --remote binds                            [0.0.0.0]
  --audit    print the ingredients label and exit — no server. Exits non-zero
             if the deck runs any script that is not the runtime — a block or
             an executable attribute — so CI can gate on a deck before it is
             forwarded or published.
  --no-plugins  play without your own chrome, whatever is installed.
  --upstream-every N  minutes between upstream checks; 0 turns the check off  [10]
  --no-upstream     never look at the upstream — no git, no network
  --upstream-pull   register the update control the deck's H overlay drives.
                    OFF by default: with it on, any script in the deck can
                    fast-forward the clone the deck was served from.

  Your presenter plugins (decklight library add plugin) are layered on at serve time from
  ~/.decklight/plugins/ — a timer, a teleprompter, a confidence monitor. They
  are YOURS: the deck on disk is untouched, nothing is written into it, and the
  same file played on a machine without them is identical slides and no
  warning. Each one renders inside a sandboxed frame with an opaque origin, so
  it draws chrome and cannot reach the slides — a plugin that asks for slide
  content is refused by name, because a deck has to stay a deterministic
  artifact or two people presenting the same file present different decks.

  A plugin is never part of the ingredients label: the label counts what is in
  the file, the chrome is listed under it as what it is. Loading one registers
  no route and does not widen the policy below by a single source.

  Every no-trust start prints the ingredients label: which runtime is
  embedded and whether its bytes are the ones this install ships, how many
  inert data blocks the runtime will read, and — named, with line numbers —
  every script block that will execute and is NOT accounted for, plus every
  executable attribute (an inline on*= handler, a javascript: or
  data:text/html URL, an inline srcdoc document — the vectors 'unsafe-inline'
  below would otherwise let run unnamed). It is an inventory, not a verdict:
  there is no "safe" here, because the scan is a heuristic over a file someone
  may have edited and a green check would promise more than it can keep.

  A deck with a detached signature beside it (talk.html.sig) is verified BEFORE
  it renders, and the terminal names who signed it — an identity you can judge,
  not a check mark. Sigstore keyless, so there are no keys: the certificate was
  minted for one signature against the signer's OIDC identity and expired
  minutes later; the transparency log is what keeps it checkable. A deck with no
  sidecar is not an alarm — most decks are unsigned, and treating that as a
  finding would train you to ignore the one that matters. Verifying needs the
  sigstore client and the network; when it cannot be done here, that is said as
  its own state and never as a pass.

  When the label finds an unaccounted block — or a signature does not verify,
  or cannot be checked here — strict mode turns ITSELF on and says so in the
  terminal. It does not ask, and there is no --force to turn it
  back off: ten minutes before a talk is the worst possible moment for a
  refusal, and an escape hatch would be reached for exactly then — so the deck
  always plays, and the part nobody can account for is the part that doesn't.
  Removed blocks are named in the terminal, never on the audience's screen.

  What survives strict is what a deck needs to render itself: the runtime, the
  Decklight.init call, JSON data blocks and templates. Builds, layouts, themes,
  charts and background media are markup, CSS and attributes — never at risk. A
  clean deck under --strict is byte-identical to the same deck without it.

  Every response carries this Content-Security-Policy as an HTTP header, which
  the deck cannot override the way it could a <meta> tag:

    ${CSP.replace(/; /g, ';\n    ')}

  Recorded narration from a bucket and external background video still play —
  that is what the https: sources in media-src/connect-src are for. Live voice
  does not: synthesis needs the local bridge, which is a write-mode engine and
  is refused from here.

  Read the policy honestly: script-src carries 'unsafe-inline' because a
  bundled deck IS inline script, so this does not stop a deck from running
  code. It stops that code from reaching anywhere it shouldn't.`;

// `client` is the sigstore client — injectable so a test can drive the
// signature states of `--no-trust --audit` without the network; `undefined`
// means "go load the real one".
export async function editMain(args, { onListen = null, client } = {}) {
  // /deck/review/incoming's answer, briefly remembered (see the route).
  let incomingCache = null;
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (wantsHelp && args.includes('--no-trust')) { console.log(READ_ONLY_USAGE); return 0; }
  if (wantsHelp || !args.filter((a) => !a.startsWith('-')).length) {
    console.log(`usage: node cli/edit.mjs <deck.html> [--no-trust] [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>] [--commit-messages]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (right-click a slide's background), per-slide layout (L/⇧L),
  element edit mode (E, then right-click an element), undo/redo (Z/⇧Z), agent asks (A)
  a taken --port offers to take over that session (on a TTY) or moves on to
  the next free one
  --no-trust      the same server in no-trust mode: the deck is served from
                   its own directory under a CSP header, the ingredients label
                   runs first, and every edit route refuses
                   (--no-trust --help for that mode's flags)
  --remote         also listen on the LAN for the phone remote (either mode)
  --git            keep the deck in git (creates the repo if needed): a silent
                   snapshot on refs/decklight/wip, and K commits when you say so
  --no-git         never touch git (default outside a repository)
  --commit-every N cadence in seconds, timer mode only                    [300]
  --git-mode M     agent  one commit per agent edit, plus whatever K commits
                   timer  the old five-minute cadence, bookends included
                   off    never commit                                  [agent]
  --agent <name>   preferred AI agent for A (default: first one detected)
  --agent-model <id>  the model that agent runs on, this run only (the remembered one
                   otherwise; set it from A's card). Also DECKLIGHT_AGENT_MODEL
  --agent-ask-model <id>  the model for its quick questions (commit subjects, the
                   commit plan, enhance) when it should differ. DECKLIGHT_AGENT_ASK_MODEL
  the server binds 127.0.0.1 unless --remote asks for the LAN`);
    return;
  }
  const { opt } = argReader(args);

  // DECLARED HERE, not down with the rest of the agent wiring, because
  // `ownCommit` closes over it and editMain CALLS ownCommit synchronously —
  // the opening commit, taken when git has never seen this deck. Left where it
  // reads better, that call ran while this binding was still in its temporal
  // dead zone and `decklight <deck>` died on a ReferenceError before the
  // server ever came up. It needed both halves to show: a deck git does not
  // know, and commit-messages on (only that path reads `agentPref`), which is
  // why adding a SECOND deck to a repo was the way to find it.
  let agentPref = opt('--agent') ?? preferredAgent();
  // this run's model (#918): into the env every agent spawn resolves it from
  applyModelFlags(opt);
  const port = parsePort(opt('--port', 8788));
  if (port === null) { console.error(`decklight: ${badPort('--port', opt('--port'))}`); process.exitCode = 1; return; }
  const fail = (msg) => { console.error(`decklight: ${msg}`); process.exitCode = 1; return 1; };

  // ── the mode (PRESENTING) ─────────────────────────────────────────────────
  // One server, two modes. Write mode is the default: the deck is served from
  // disk, live-reloaded, and every /deck/edit/* route writes it. Read-only
  // mode (`--no-trust`, and always for a .decklight container) serves the
  // bytes the ingredients label described, under the CSP, with the
  // presenter's chrome layered on, and refuses every route that writes —
  // /deck/edit/*, the bridges, the review owner's half — by name. The mode is
  // the run's: decided here, from the flag, and never from the page — a page
  // that could grant itself write access would make the flag worth nothing
  // for the deck it exists for, the one you did not write.
  const deckArg = firstPositional(args, VALUE_FLAGS);
  const deckPath = resolve(process.cwd(), deckArg);
  if (!existsSync(deckPath)) return fail(`deck not found: ${deckPath}`);
  // A .decklight is the same deck with its signature and manifest stapled on
  // (DECK_FILE), unwrapped here and treated exactly like the HTML it wraps —
  // same audit, same CSP, same strict rule. Nothing is written to unwrap it:
  // the payload is a slice of the bytes already read. It never leaves
  // no-trust mode: there is no file to edit in place.
  let container = null;
  if (isContainer(deckPath)) {
    try { container = readContainer(deckPath); } catch (e) { return fail(e.message); }
  }
  const noTrust = args.includes('--no-trust') || !!container;

  // --remote widens the LISTENER and nothing else (NO_TRUST#REMOTE), in either
  // mode: off this machine only /deck/remote/* answers, with the per-run
  // token, and the deck itself and every file beside it stay unreachable from
  // the LAN whether or not the flag is passed. allowRemote is the classifier.
  const remote = args.includes('--remote') || opt('--host') !== undefined;
  const host = remote ? opt('--host', '0.0.0.0') : '127.0.0.1';
  const token = remote ? randomBytes(16).toString('base64url') : null;

  // The served root. In write mode it is the cwd, as it always was: a source
  // deck reaches up for its runtime (`demo/talk.html` loading
  // `../dist/decklight.js`) and the author chose where to stand. In no-trust
  // mode it is the deck's OWN directory, never the cwd: everything under the
  // root is fetchable by the deck's own script same-origin, and with
  // `connect-src https:` open, fetchable means exfiltratable — a root
  // inherited from wherever the command happened to run (a project checkout,
  // $HOME via file association) would hand a hostile deck whatever lived
  // there. `--root` widens it, by a flag you typed and printed at startup.
  const rootArg = opt('--root');
  const root = noTrust
    ? (rootArg ? resolve(process.cwd(), rootArg) : dirname(deckPath))
    : process.cwd();
  if (!deckPath.startsWith(root + sep)) {
    return fail(noTrust ? 'deck must live under --root' : 'deck must live under the current directory');
  }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');
  const deckRel = deckUrl.slice(1);

  // ── the no-trust mode's ingredients (PRESENTING) ─────────────────────────
  // The audit runs because it is the way in: a standalone `verify` is a step
  // people skip, so folding it into the command you already use means it runs
  // every time, at no extra effort. It reads the bytes, names what will
  // execute, and decides strict — the startup block, reusable, because a
  // pull (NO_TRUST#UPSTREAM) re-runs it: never new bytes under an old verdict.
  const readAndAudit = () => {
    const bytes = container ? readContainer(deckPath).payload : readFileSync(deckPath);
    const rep = auditDeck(bytes.toString('utf8'));
    return {
      payload: bytes,
      report: rep,
      strict: args.includes('--strict') || rep.counts.unaccounted > 0 || rep.counts.handlers > 0,
    };
  };
  // The signature, if the deck came with one (INTEGRITY#SIGNING). Costs nothing
  // when there is no sidecar — the common case returns without touching the
  // network — and the audit runs either way, because the two answer different
  // questions: a signature says WHO vouched for these bytes, the label says
  // what the bytes will do. A signed deck can still run something nobody
  // should, and the label is what would name it. Verified once, at startup:
  // it is a sidecar for the file as published, and a deck that changed since
  // has already invalidated whatever the old one attested.
  const verifySignature = async () => {
    if (!container) return verifyFile(deckPath, { client });
    let sig = container.signature
      ? await verifyBytes(container.payload, container.signature, { client })
      : { state: TAMPERED, reason: 'the container carries no signature' };
    // The manifest is the container's own label. When it does not describe
    // the deck it is stapled to, something rewrote one half — the same
    // conclusion as a signature that does not verify, so the same state.
    if (!container.digestOk && sig.state === VERIFIED) {
      sig = { state: TAMPERED, reason: 'the manifest digest does not match the payload' };
    }
    return sig;
  };
  // MUTABLE: a pull may replace all of it. The bytes, the label and `strict`
  // move together or not at all. Empty in write mode, which never reads it.
  let audited = null;
  let signature = { state: UNSIGNED };
  /** Enter (or re-enter) no-trust mode: read, audit, decide strict. Says whether the deck itself changed. */
  const audit = () => {
    const before = audited?.payload ?? null;
    const next = readAndAudit();
    const unverified = signature.state !== UNSIGNED && !isVerified(signature);
    // STRICT RATCHETS within a session: a pull may turn it on and can never
    // turn it off. A deck that could clear its own strict flag by pulling
    // could disarm the one mitigation no-trust mode applies unasked.
    audited = { ...next, strict: next.strict || unverified || (audited?.strict ?? false) };
    return before === null || !next.payload.equals(before);
  };
  if (noTrust) {
    signature = await verifySignature();
    audit();
  }

  // `--audit` prints the ingredients label and exits; `--check` still answers,
  // unadvertised, from before `check` came to mean the deck lint alone
  if (args.includes('--audit') || args.includes('--check')) {
    // No server. The label, the manifest, the signature — and an exit code CI
    // can gate on: non-zero means "this deck executes something I could not
    // account for", or "it carries a signature I could not stand behind" —
    // not "this deck is malicious", which is a call no exit code should make.
    // `unchecked` counts: a gate that passes when it could not evaluate the
    // claim is not a gate.
    if (!noTrust) { signature = await verifySignature(); audit(); }
    for (const line of formatLabel(audited.report, { indent: '' })) console.log(line);
    if (container) console.log(formatManifest(container.manifest, { indent: '' }));
    if (signature.state !== UNSIGNED) console.log(formatSignature(signature, { indent: '' }));
    return audited.report.counts.unaccounted || audited.report.counts.handlers
      || (signature.state !== UNSIGNED && !isVerified(signature)) ? 1 : 0;
  }

  // The presenter's own chrome (NO_TRUST#PLUGINS) — a timer, a teleprompter,
  // a confidence monitor. It is loaded from ~/.decklight/plugins/, which is
  // the presenter's library and not the deck's: the installer is the
  // risk-bearer and nothing here travels. Loaded after `auditDeck` has read
  // the bytes, so a plugin is never counted as an unaccounted script block in
  // the label (the label describes the file; a plugin is not in the file),
  // and injected after `stripUnaccounted`, so strict never strips the chrome
  // as if the deck had smuggled it in. BOTH modes: it used to be no-trust
  // only, so presenting your own deck with your own timer meant opening it
  // without trust (ROADMAP section 5). The chrome is the presenter's, and a
  // presenter is often the author. `--no-plugins` turns it off in either.
  const chrome = args.includes('--no-plugins') ? { plugins: [], refused: [] } : loadLibrary();
  // Consulted per request rather than decided once: after a pull `strict`
  // may have ratcheted on, and the bytes served have to follow the verdict
  // printed for them.
  const strip = (text) => (audited?.strict ? stripUnaccounted(text).html : text);
  // Only the deck gets chrome. Every OTHER html file under the root still
  // gets the strict rewrite — strict that stopped at one file would be walked
  // around by a second page under the same root, and the deck can reach one
  // (the theme picker, the slide finder and the speaker view all boot
  // documents into same-origin iframes). Those same iframes are why the
  // chrome is deck-only: presenter chrome belongs to the document the
  // presenter is looking at, and the shim removes itself if framed anyway.
  const rewrite = (text, file) => {
    const out = strip(text);
    return file === deckPath ? injectChrome(out, chrome.plugins) : out;
  };
  // The deck served from memory below goes through the same seam a file
  // does: a deck that is only data (#520) gets the runtime referenced on its
  // way out, and the audit above described the bytes WITHOUT it — which is
  // the point. `staticFiles` does this for every other page itself.
  const serveAudited = (text) => linkReferences(linkRuntime(rewrite(text, deckPath)), { dir: dirname(deckPath), deck: basename(deckPath) });
  // The deck itself, in no-trust mode, is served from MEMORY — container and
  // plain HTML alike — from the bytes the audit read and the signature
  // covered. The label, the signature verdict and `strict` were all decided
  // against those bytes and printed as a verdict; re-reading the file per
  // request would let a deck edited on disk AFTER that moment ride out under
  // it (#235). For a container this also avoids the one write this mode does
  // not make — unpacking to a temp file that would sit somewhere after the
  // talk. A pull re-audits and re-prints.
  const servePayload = (req, res) => {
    if (req.method !== 'GET') return false;
    const body = Buffer.from(serveAudited(audited.payload.toString('utf8')), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  };
  // Is this URL the deck? Matched on the RESOLVED path, exactly as staticFiles
  // would resolve it, so a percent-encoded spelling of the same file cannot
  // slip past this route into the per-request disk read below it.
  const isDeck = (url) => {
    if (url.pathname === '/') return true;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    return resolve(root, '.' + rel) === deckPath;
  };

  const history = createHistory();
  const readDeck = () => readFileSync(deckPath, 'utf8');
  /** Files beside the deck as they are now, `{ path: text }` — for an undo entry that covers them. */
  const snapshotFiles = (paths) => Object.fromEntries(paths.flatMap((p) => { try { return [[p, readFileSync(p, 'utf8')]]; } catch { return []; } }));
  /**
   * What is beside the deck that no commit holds, relative to its folder: the
   * untracked files git does not ignore, or with no git the folder's entries.
   * Read before and after an agent run, so what the run left can be named.
   */
  const besideDeck = () => {
    const dir = dirname(deckPath);
    if (gitOn) return untrackedFiles(dir);
    try { return readdirSync(dir, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort(); } catch { return null; }
  };
  /** HEAD's short sha when it holds `paths` exactly as they are on disk, else null. */
  const cleanHead = (paths) => {
    try {
      const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (git('status', '--porcelain', '--', ...paths)) return null;
      return git('rev-parse', '--short', 'HEAD') || null;
    } catch { return null; }
  };
  /**
   * The one door every mutation goes through: snapshot, then write — so Z
   * always works. Answers whether anything actually changed.
   *
   * Takes a TRANSFORM, `applyEdit((html) => setSlideNotes(html, …))`, so the
   * deck is read exactly ONCE. It used to take the finished html with the
   * current file as a default argument, which meant every call site spelled
   * `applyEdit(setX(readDeck(), …))` — one read to transform, a second for the
   * snapshot. Two reads is not just wasted work: they are two different reads,
   * and an edit landing between them wrote the second one's bytes back over
   * the first one's, with the undo entry recording a file that never existed.
   *
   * A route that has ALREADY read the deck — the template ones need it for
   * their own answer — passes the finished html and that same read as
   * `before`, which is the same single read spelled the other way round.
   */
  // Which route is writing, for the reload's reason: set around every
  // handler (below), read by `writeDeck` — async-safe, so two requests in
  // flight each name their own.
  const writing = new AsyncLocalStorage();
  let lastWrite = null;   // { at, what, from } — the server's latest write of the deck, for the watcher
  const noteWrite = (what, from = null) => { lastWrite = { at: Date.now(), what, from }; };
  /** The one write of the deck file: atomic, and remembered for the reload it causes. */
  const writeDeck = (next) => {
    writeFileAtomic(deckPath, next);
    const ctx = writing.getStore();
    let from = null;
    if (ctx?.body) { try { const f = JSON.parse(ctx.body).from; if (typeof f === 'string') from = f.slice(0, 64); } catch { /* not json, or no page named */ } }
    noteWrite(whatWrote(ctx?.route), from);
  };
  // `also` rides into the undo entry beside the deck: `{ voices }`, the voice
  // folders a slide op renumbered (#916), which Z moves back with it
  const applyEdit = (change, before = readDeck(), also = null) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(also ? { deck: before, ...also } : before);
    writeDeck(next);
    return true;
  };

  /**
   * The voice folders follow an edit that rewrote the deck at once — an
   * agent's (#920) — as a slide op's do (#916): where each slide went is read
   * off the sections before and after (slideRenumber), never off the audio,
   * so a stale take moves with its slide too. The deck is already written, so
   * nothing here can refuse it: a folder that cannot follow is left exactly
   * as it was and said, and realign is still there for it.
   *
   * `null` when no slide moved; else `{ voices, said, renumber }`: the steps
   * that undo the moves (for the edit's undo entry), one line per folder, and
   * Map dir → renumbering for the folders that moved — or `{ error }`.
   */
  const followSlides = (before, after) => {
    const pairs = slideRenumber(before, after);
    if (!pairs.length) return null;
    const deckDir = dirname(deckPath);
    const dirs = voiceFolders(deckPath, [...configuredTrackDirs(before), ...configuredTrackDirs(after)]);
    const r = planSteps(deckDir, dirs.map((dir) => ({ dir, pairs })));
    if (r.error) return { error: `${r.error} — they were left where they were; realign them from the narration panel` };
    if (!r.plans.length) return null;
    try { applyPlans(deckDir, r.plans); } catch (e) {
      return { error: `the recordings could not follow the slides — ${oneline(e)} — they were left where they were` };
    }
    const was = deckOutline(before).length, now = deckOutline(after).length;
    const said = r.plans.map((p) => followedSaid(p, pairs, was, now)).filter(Boolean);
    const renumber = new Map(r.plans.map((p) => [p.dir, movesRenumber(pairs)]));
    return { voices: r.plans.map((p) => p.inverse), said, renumber };
  };

  // Declared before the git block below, which reads it to hold the cadence
  // back while a job is in flight.
  let agentJob = null; // { name, prompt, startedAt } — strictly one at a time
  let agentStop = null; // stops it (POST /deck/edit/agent/stop) — set while it runs
  // The asks of this session, oldest first, with what came of each — what the
  // docked agent panel shows. An agent's edit reloads every browser, so the
  // log lives HERE, not in the page, and rides /deck/ping across the reload.
  const agentAsks = [];
  const ASKS_KEPT = 20;
  let askSeq = 0;
  let enhancing = null;  // a script enhancement in flight: { of, done, stop } — one at a time
  let reviewing = null;  // an agent review in flight: { of, done, stop } — one at a time
  let exportJob = null;  // an export in flight, { kind, what }: cli/edit-handover.mjs says when
  let lastReview = null; // its last result: { at, agent, findings, failed } — kept for Check deck… to re-ask

  // ── git autocommit — the durable record, independent of undo/redo ──────
  const noGit = args.includes('--no-git');
  const wantGit = args.includes('--git');
  const commitEvery = Math.max(5, Number(opt('--commit-every', 300)) || 300);
  // Commit subjects written by an agent, from the deck's diff. Two levels:
  //
  //  - ON CLICK, by default: the commit window's "write it for me" asks the
  //    agent installed on this machine when — and only when — it is pressed,
  //    and its tooltip names the agent and says the changes go to it (and may
  //    go on to its provider). Nothing leaves without that click.
  //  - AUTOMATIC, with --commit-messages: the window drafts one as it opens,
  //    and every commit decklight makes on its own is given one.
  //
  // --no-commit-messages turns both off for the session. Nothing is stored:
  // the setting is the command line's, and the button is the consent.
  const subjectsOff = args.includes('--no-commit-messages');
  const wantMessages = !subjectsOff && args.includes('--commit-messages');
  // The agent a subject would be asked of — named in the button's tooltip, so
  // it is the SAME resolution describeWorking makes (agentAsk). Remembered per
  // preference: commitState goes out on every ping and SSE tick, and probing
  // PATH that often is waste.
  let describerFor = null, describerIs = null;
  const describer = () => {
    if (subjectsOff) return null;
    if (describerFor !== (agentPref ?? '')) {
      const a = agentAsk(agentPref ?? null, 'x');
      describerIs = a ? { name: a.name, label: a.label } : null;
      describerFor = agentPref ?? '';
    }
    return describerIs;
  };

  /**
   * Every commit decklight authors ITSELF goes through here — the cadence, the
   * session bookends, the save that clears the way before an agent edit.
   *
   * One funnel, because the amend has to happen right after the commit while
   * the sha is still the tip, and a second call site that forgot to ask would
   * silently be the one that keeps saying "autosave". Commits made from an
   * AGENT'S OWN message do not come through here: they already say what
   * happened, and asking an agent to rewrite an agent's sentence is a call
   * that buys nothing.
   *
   * The describe is deliberately unawaited. The commit has landed by the time
   * this returns, which is the whole contract of autocommit — the subject is
   * an improvement that arrives late or not at all.
   */
  function ownCommit(message, also = []) {
    const paths = { also: [...alsoNow().also, ...also] };
    const made = message === undefined
      ? gitAutocommit(deckPath, root, undefined, paths)
      : gitAutocommit(deckPath, root, message, paths);
    if (!made) return false;
    pendingAttr = null;
    // Whatever wrote it — the overlay, an agent, a bookend — this stretch of
    // uncommitted work is over, so the nag re-arms for the NEXT one.
    resetEpisode();
    const sha = lastCommitSha;
    if (wantMessages && sha) {
      const template = message ?? `decklight: autosave ${basename(deckPath)}`;
      describeCommit({ cwd: root, sha, deckPath, template, agent: agentPref })
        .then((subject) => { if (subject) console.log(`  git: subject → "${subject}"`); })
        .catch(() => { /* the commit stands; the wording was the optional part */ });
    }
    return true;
  }
  // timer (the old cadence) · agent (one commit per agent edit, the default) · off
  const gitMode = resolveGitMode(args);
  let gitOn = false;

  // ── the commit watch (cli/commit-flow.mjs) ──────────────────────────────
  // How often the snapshot is refreshed and the nag rule re-read. Far shorter
  // than the old commit cadence because nothing here writes history: a tick is
  // one `git diff --numstat` and, when the deck moved, one loose commit object.
  // The NAG is governed by its own rule, not by this interval — see planNag.
  const WATCH_EVERY_MS = 30_000;
  // …but never slower than the cadence the author asked for. `--commit-every`
  // governs `--git-mode timer` outright; in the default mode it is still the
  // knob for "how often should decklight look at my deck", so a tighter number
  // tightens the snapshot too. Without this the interval was a constant nobody
  // could reach, which is also what made it untestable end to end.
  const watchEveryMs = Math.min(commitEvery * 1000, WATCH_EVERY_MS);
  let dirtySince = 0;      // when this stretch of uncommitted work began
  let dirtyLines = 0;      // how much of the deck (and its sidecar) differs from HEAD
  let dirtySlides = null;  // { changed, added, removed } against HEAD, or null
  let dirtyFiles = [];     // which of them, by name beside the deck
  // The review sidecar rides the deck's own commits in write mode (REVIEW):
  // K, the agent's boundary and the session's bookends stage it beside the
  // deck when it changed, and the card counts its lines. The snapshot ref
  // stays deck-only: it is a backup of the thing being edited.
  const sidecarPath = reviewPathFor(deckPath);
  const sidecarRel = sidecarPath.slice(root.length + 1).split(sep).join('/');
  let pendingAttr = null;  // a .gitattributes decklight just wrote, until a commit carries it
  // The attribute's path RELATIVE TO ROOT, asked of git rather than computed
  // from two absolute paths: `--show-toplevel` answers in forward slashes and
  // the long form of a path, and `root` may be the short form of the same
  // directory (a Windows temp dir), so `relative()` between them walks out of
  // the repository and every git call that takes the result refuses.
  const attrRel = () => {
    try {
      const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8' }).trim();
      return '../'.repeat(prefix.split('/').filter(Boolean).length) + '.gitattributes';
    } catch { return null; }
  };
  const alsoNow = () => ({ also: [sidecarPath, ...(pendingAttr ? [pendingAttr] : [])] });
  const alsoRels = () => [sidecarRel, ...(pendingAttr ? [attrRel()] : [])].filter(Boolean);
  let nagged = false;      // the episode latch: asked once, then quiet
  let nagDismissed = false;
  let lastWip = null;      // the snapshot sha, so the ping can prove it exists
  /** A commit happened: this stretch of uncommitted work is over. */
  const resetEpisode = () => {
    dirtySince = 0; dirtyLines = 0; dirtyFiles = []; dirtySlides = null; nagged = false; nagDismissed = false;
  };
  /**
   * Re-read what is uncommitted, right now.
   *
   * Anything ANSWERING A QUESTION calls this rather than reporting the last
   * tick's numbers. The tick is 30s apart, and K is pressed the moment after an
   * edit: a cached "clean" would refuse to commit work that plainly exists,
   * which is the worst possible answer from the button whose whole job is to
   * commit it. The nag latch is deliberately untouched here — measuring is not
   * asking.
   */
  const measureDirty = () => {
    const d = deckDirty(root, deckRel, { also: alsoRels() });
    if (!d.dirty) { dirtySince = 0; dirtyLines = 0; dirtyFiles = []; dirtySlides = null; return d; }
    if (!dirtySince) dirtySince = Date.now();
    dirtyLines = d.lines;
    dirtyFiles = (d.files ?? []).map((f) => basename(f));
    // in slides too, for the chip and the window: a deck's reader thinks in
    // slides. A change that is only the sidecar touches none.
    dirtySlides = slidesSinceHead(root, deckRel);
    return d;
  };
  /** What the deck knows about uncommitted work — ping and SSE both send this. */
  const commitState = () => ({
    dirty: dirtySince > 0,
    lines: dirtyLines,
    files: dirtyFiles,
    slides: dirtySlides,
    sinceMs: dirtySince ? Date.now() - dirtySince : 0,
    nag: nagged && !nagDismissed,
    wip: lastWip,
    canWrite: gitOn && gitMode !== 'off',
    messages: wantMessages,
    // who "write it for me" would ask — null when the session turned subjects
    // off, or no agent is installed; `subjectsOff` says which
    describer: describer(),
    subjectsOff,
  });
  // Write mode's. A deck in no-trust mode is somebody else's: no repository
  // is created beside it, no snapshot is taken, nothing of it is committed.
  function startGit() {
    if (noGit || !(wantGit || inGitRepo(root))) return;
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
      // The session bookends are the cadence's siblings: generic subjects for
      // moments nobody described, and in the default mode the snapshot covers
      // what they were covering. THE FIRST COMMIT IS NOT ONE OF THEM. A
      // repository decklight just created has no commits at all: there is no
      // HEAD for the snapshot to parent on, so this commit is how the deck
      // ENTERS history rather than an autosave of it.
      //
      // A deck git has never seen, in a repository that HAS history, is not
      // that case. It used to be committed here too, on whatever branch was
      // checked out, before anyone pressed anything: a scratch deck in a repo
      // landed on main. Whether a deck is versioned is the author's call, so it
      // stays untracked until K, and the snapshot (which needs only a HEAD, not
      // the deck in it) keeps it safe meanwhile; the chip already reads an
      // untracked deck as uncommitted work and asks once, like any other.
      const opening = deckDirty(root, deckRel);
      if (gitMode === 'timer') ownCommit(`decklight: start editing ${basename(deckPath)}`);
      else if (opening.firstCommit) ownCommit(`decklight: add ${basename(deckPath)}`);
      else { measureDirty(); lastWip = snapshotWip(root, deckPath, deckRel) ?? lastWip; }
      // The cadence no longer WRITES HISTORY. It used to commit every
      // --commit-every seconds, and what that produced was a column of
      // `decklight: autosave talk.html` in which no commit marked anything —
      // a backup wearing a history's clothes. The two jobs are now separate:
      // the tick takes a silent snapshot (refs/decklight/wip, off every branch)
      // so a crash still costs nothing, and asks ONCE per stretch of
      // uncommitted work whether you want to commit it. `--git-mode timer`
      // keeps the old cadence for anyone who wants the wall back.
      setInterval(() => {
        if (agentJob) return;              // never mid-run: see shouldCommit
        if (gitMode === 'timer') {
          if (shouldCommit(gitMode, { kind: 'timer' })) ownCommit();
          return;
        }
        commitWatchTick();
      }, gitMode === 'timer' ? commitEvery * 1000 : watchEveryMs).unref();
      startup('git',
        gitMode === 'timer'
          ? `auto-commit every ${commitEvery}s`
          : `snapshots on decklight/wip · ${opening.untracked ? `${basename(deckPath)} is not in git: K adds it` : 'commits on K'}`,
        gitMode === 'timer'
          ? `  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`
          : wipLine(deckRel, { untracked: opening.untracked }),
        'ok');
    }
  }
  if (!noTrust) startGit();
  /**
   * One tick: refresh the snapshot, and decide whether to ask.
   *
   * Order matters. The snapshot is taken FIRST and unconditionally, because it
   * is the safety net and must not depend on any nag rule being right. Only
   * then is the question considered — and `planNag` answers it once per episode,
   * so an ignored nag stays ignored instead of becoming a five-minute alarm.
   */
  function commitWatchTick() {
    const d = measureDirty();
    if (!d.dirty) { resetEpisode(); return; }
    lastWip = snapshotWip(root, deckPath, deckRel) ?? lastWip;
    if (planNag({ dirty: true, lines: dirtyLines, sinceMs: Date.now() - dirtySince, nagged, dismissed: nagDismissed })) {
      nagged = true;
      broadcast('commit', commitState());
      console.log(`  git: ${nagText({ lines: dirtyLines, sinceMs: Date.now() - dirtySince })}`
        + ' — K in the deck commits it');
    }
  }

  const finalCommit = () => {
    if (!gitOn) return;
    // Not ownCommit: this runs inside the SIGINT handler and the process exits
    // immediately after, so there is no later for an amend to arrive in. The
    // bookend keeps its literal subject, which is true anyway.
    if (gitMode === 'timer') {
      if (gitAutocommit(deckPath, root, `decklight: stop editing ${basename(deckPath)}`, alsoNow())) pendingAttr = null;
    } else {
      // Committing work you deliberately did not commit would be the cadence
      // again, wearing an exit for a hat. The snapshot is refreshed instead —
      // one last time, synchronously, so the newest bytes are safe — and the
      // uncommitted work is NAMED on the way out rather than swallowed.
      const d = deckDirty(root, deckRel);
      if (d.dirty) {
        snapshotWip(root, deckPath, deckRel);
        console.log(`  git: ${deckRel} has uncommitted changes — they are safe on`
          + ` ${WIP_REF.replace('refs/', '')} (git show decklight/wip:${deckRel})`);
      }
    }
    // The last moment anyone is looking. Synchronous and fetch-free on purpose:
    // this runs inside the SIGINT handler, and a network call there would hang
    // a Ctrl-C — the worst possible place to hang.
    try {
      const line = exitPushLine(remoteState(root));
      if (line) console.log(line);
    } catch { /* a reminder is never worth failing an exit over */ }
  };
  process.on('SIGINT', () => { finalCommit(); process.exit(0); });
  process.on('SIGTERM', () => { finalCommit(); process.exit(0); });

  // ── AI agents — one-shot editing tasks from the player (A) ─────────────
  // Precedence, like every other saved choice: the flag wins, then what was
  // remembered (#125), then the first detected agent.
  const agents = detectAgents();
  // Named at startup in write mode only: no-trust mode refuses the agent
  // route with the rest of the write family, and a roster line under the
  // ingredients label would promise a capability that mode does not have.
  if (agents.length && !noTrust) {
    const mark = (a) => a.name + (a.name === agentPref ? ' (preferred)' : '') + (a.installed ? ' (installed)' : '')
      + (agentModel(a.name).model ? ` · ${agentModel(a.name).model}` : '');
    startup('agents', agents.map(mark).join(', '),
      `  agents: ${agents.map(mark).join(', ')} — “Ask agent” (A) is live`, 'ok');
  }
  // A remembered agent that is not on this machine is said ONCE, at startup,
  // rather than discovered at the moment someone presses A mid-talk.
  if (!noTrust && agentPref && !agents.some((a) => a.name === agentPref)) {
    console.log(`  agent: ${agentUnavailable(agentPref, agents)}`);
  }
  // A model set for an agent whose CLI cannot take one is said too (#918):
  // it is not applied, and a setting that silently did nothing is the bug.
  for (const a of noTrust ? [] : agents) {
    const m = agentModel(a.name).model;
    if (m && !takesModel(a)) console.log(`  agent: ${a.name} takes no model flag — "${m}" is not applied, it runs on its own default`);
  }
  // A deck that EMBEDS a runtime older than this install is served as it is
  // (the file is the author's), and that runtime probes routes this server
  // may no longer have: it gets a 404, concludes there is no server, and
  // hides every write-mode affordance without a word. No-trust mode's label
  // already says "DIFFERS"; write mode has to say it too, and name the fix,
  // because a page that silently will not wire up is the one failure nobody
  // can diagnose from the page. The audit is the same comparison --check
  // makes: this install's bytes, or a version it cannot vouch for.
  if (!noTrust) {
    let rt = null;
    try { rt = auditDeck(readDeck()).runtime; } catch { /* the deck is read again by every route; a bad read fails there */ }
    if (rt?.kind === 'inline' && (rt.state === 'differs' || rt.state === 'other-version')) {
      const what = rt.state === 'other-version'
        ? `embeds runtime ${rt.version}; this install is ${rt.installedVersion}`
        : `embeds a runtime that is not this install's build${rt.installedVersion ? ` of ${rt.installedVersion}` : ''}`;
      startup('runtime',
        `${basename(deckPath)} ${what} · run: ${selfCommand()} upgrade ${deckRel}`,
        `  runtime: ${basename(deckPath)} ${what} — the deck may not wire up to this server; run decklight upgrade ${deckRel}`, 'warn');
    }
  }
  // The project's skill, if any, against this install (the same question the
  // runtime row asks of the deck): an agent that reads a skill written by an
  // older decklight reads an old contract — commands that went, routes that
  // moved — and the only place that can be noticed is here, since the agent
  // itself has no way to know. `decklight skills` refreshes it.
  if (!noTrust) {
    const older = [];
    for (const rel of ['.claude/skills/decklight/SKILL.md', 'AGENTS.md']) {
      const file = resolve(root, rel);
      if (!existsSync(file)) continue;
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      if (rel === 'AGENTS.md' && !text.includes(AGENTS_MARKER)) continue;
      const v = skillVersionOf(text);
      if (v === null || (semverCompare(v, PKG.version) ?? -1) < 0) older.push({ rel, v });
    }
    if (older.length) {
      startup('skill',
        // the row is the fact and the command to type, nothing else
        `${older.map((o) => `${basename(o.rel)} ${o.v ? `v${o.v}` : 'before 0.9.0'}`).join(', ')}, older than ${PKG.version} · run: ${selfCommand()} skills`,
        `  skill: ${older.map((o) => `${o.rel} (${o.v ? `v${o.v}` : 'before 0.9.0'})`).join(', ')} — older than this install (${PKG.version}): an agent reads an old contract; run ${selfCommand()} skills`, 'warn');
    }
  }
  // The presenter's chrome, named here as no-trust mode names it under its
  // label: what is layered over the slides, and which plugin reads the notes.
  if (!noTrust && (chrome.plugins.length || chrome.refused.length)) {
    const names = chrome.plugins.map((pl) => `${pl.name}${pl.needs.includes('notes') ? ' (reads your notes)' : ''}`);
    const refused = chrome.refused.map((r) => `${r.name} refused`);
    startup('plugins', [...names, ...refused].join(', ') + ' · --no-plugins plays without them',
      `  chrome: ${[...names, ...refused].join(', ')} — yours, not in the deck (--no-plugins plays without them)`,
      refused.length ? 'warn' : 'ok');
  }
  // Said out loud, every session it is on: this is the switch that starts
  // sending the deck somewhere, and a capability nobody is reminded of is one
  // they stop counting on being off. Printed HERE rather than up with the other
  // git lines because it names the agent, and the roster is only resolved now.
  if (gitOn && wantMessages) {
    const who = agents.find((a) => a.name === agentPref) ?? agents[0];
    startup('git',
      who?.name ? `subjects by ${who.name}` : '--commit-messages needs an agent on PATH',
      `  ${messagesLine(who?.name ?? null)}`, who?.name ? 'ok' : 'warn');
  }

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  // The review routes (SPEC REVIEW), the same ones every server that opens a
  // deck registers: a review can be left in write mode too. The sidecar is
  // appended, never the deck; here it is not committed by itself, because the
  // deck's own commits (the snapshot, K) are what this server keeps.
  // In no-trust mode the sidecar is the ONE file this process writes, and
  // it is committed by itself as each comment lands when the deck sits in a
  // repository (`--no-git` leaves the committing to you).
  const reviewRepo = gitAvailable(dirname(deckPath)) && inGitRepo(dirname(deckPath));
  const review = createReviewRoutes(deckPath, {
    inRepo: reviewRepo,
    gitOn: noTrust && reviewRepo && !noGit,
    mode: noTrust ? 'no-trust' : 'write',
    // A record just landed in the sidecar — a resolve naming a reviewer's
    // comment changes what the incoming listing says is done, so the cached
    // listing must not outlive it. `wrote` is the .gitattributes the first
    // record in this repository had to write (REVIEW, merge=union): the
    // deck's next commit carries it, beside the sidecar.
    onRecord: (_rec, { wrote } = {}) => { incomingCache = null; if (wrote) pendingAttr = wrote; },
    // No-trust mode lists back what this reviewer already submitted, from
    // the remote's review/<me>-* branches (REVIEW), behind the same switches
    // that silence the author's inbox check, and at most once a minute: M is
    // a keypress, not a fetch storm.
    mine: noTrust && reviewRepo && !reviewCheckSuppressed({ args, ci: false }) ? async () => {
      if (!mineCache || Date.now() - mineCache.at > 60_000) {
        const { myReviews } = await import('./review-remote.mjs');
        const { reviewerIdentity } = await import('./review-routes.mjs');
        const { slugUser } = await import('./review-submit.mjs');
        mineCache = { at: Date.now(), r: await myReviews(deckPath, slugUser(reviewerIdentity(dirname(deckPath)))) };
      }
      return mineCache.r;
    } : null,
  });
  let mineCache = null;
  // The deck's channel (deck-routes.mjs): the probe and the stream, in both
  // modes. What the probe carries beyond the mode is `extras`, computed on
  // every ping like everything else on it: the toast is threshold-driven,
  // not live.
  // The quick fix held for review (#907, cli/fix-review.mjs): set with the route table below.
  let fixReview = null;
  const deck = createDeckRoutes(deckPath, {
    noTrust,
    locked: () => noTrust || locked,
    review,
    extras: async () => (noTrust ? {
      // No-trust mode names nothing that edits: no roster, no history, no
      // git. What the page needs is whether the phone remote is on
      // (NO_TRUST#REMOTE: the clicker, and the QR in the speaker view) and
      // whether this deck can ever leave the mode.
      phone: !!token,
      container: !!container,
    } : {
      deck: deckUrl,
      phone: !!token,
      container: !!container,
      ...history.counts(), git: gitOn,
      // What the player's one push nudge reads. Computed once, like everything
      // else on ping: the toast is threshold-driven, not live.
      remote: gitOn ? remoteState(root) : null,
      // with the model each runs on (#918): null for the agent's own default,
      // `takesModel: false` for one whose CLI has no flag for it
      agents: agents.map((a) => ({ name: a.name, label: a.label, ...agentModelState(a) })),
      // which one A reaches for, so the picker opens on it rather than
      // defaulting to the first detected agent every session (#125)
      preferredAgent: agentPref ?? null,
      agentBusy: agentJob && { agent: agentJob.agent, label: agentJob.label, model: agentJob.model, prompt: agentJob.prompt, startedAt: agentJob.startedAt, id: agentJob.id },
      // the long jobs a page that loads mid-run can still stop
      exportBusy: exportJob,
      enhanceBusy: !!enhancing,
      reviewBusy: !!reviewing,
      agentAsks,
      // a quick fix waiting for review: a page that loads mid-review opens it again
      candidate: fixReview?.held() ? { id: fixReview.held().id } : null,
      wizards: await configurableEngines(),
      // What is uncommitted, so a deck that loads mid-session shows the
      // chip without waiting for the next tick to broadcast one.
      commit: (gitOn && measureDirty(), commitState()),
    }),
  });
  const clients = deck.channel;
  const broadcast = deck.broadcast;

  // ── the phone remote (NO_TRUST#REMOTE) ───────────────────────────────────
  // The relay: controller page, QR, readout channel, the phone's taps onto the
  // deck's stream. These are the only paths allowRemote lets through from off
  // this machine, and not one of them writes anything — the phone asks the
  // deck to move, it never edits. The phone is a different origin from the
  // deck (a LAN address, not localhost), so the relay's own endpoints need
  // CORS; nothing else here does.
  const PHONE_CORS = corsHeaders();
  let actualPort = null;
  // The controller answers on loopback in either mode, flag or no flag (a
  // deck on this machine gets its position readout); only the LAN listener,
  // and the QR that points a phone at it, are what --remote adds.
  const relay = createRemoteRelay({
    deckName: basename(deckPath),
    token,
    remoteUrl: () => `http://${lanAddress() ?? host}:${actualPort}/deck/remote?t=${token}`,
    relayToDeck: (event, data) => broadcast(event, data),
    deckCount: () => clients.size,
    CORS: PHONE_CORS,
  });

  // ── the upstream check (NO_TRUST#UPSTREAM) ───────────────────────────────
  // A deck opened without trust from a clone: has its author pushed since? Absent
  // unless the deck is a tracked file in a clone with an upstream — that is
  // the whole safety argument: a deck you were emailed is a single file and
  // never reaches any of it. Write mode has H for the deck's own history and
  // never resolves this; the routes are registered only when it applies.
  const suppressed = !noTrust ? 'write mode' : upstreamSuppressed({ args, env: process.env });
  const upstreamCtx = suppressed ? { state: 'disabled' } : await resolveUpstream(deckPath);
  const upstream = upstreamCtx.state === 'ok' ? upstreamCtx : null;
  // The PULL is a second, explicit opt-in. Server-side there is no way to tell
  // "the presenter clicked" from "a script in the deck called fetch()" — a
  // page's own script is indistinguishable from its user — so the capability
  // is "a deck served from a clone can update itself from that clone's
  // upstream", which is a thing someone should have typed rather than
  // something the cwd decided. And never with --remote: a phone must not move
  // somebody's repo.
  const pullArmed = Boolean(upstream) && args.includes('--upstream-pull') && !token;
  let upstreamStatus = upstream
    ? { state: 'unchecked', branch: upstream.branch, upstream: upstream.upstream, message: 'not checked yet' }
    : { state: upstreamCtx.state, message: suppressed || null };
  let checking = null;
  const intervalMs = resolveInterval(args);
  let lastReported = null;
  const pullOffer = () => (pullArmed
    ? { offered: true }
    : { offered: false, reason: !upstream ? upstreamCtx.state : token ? '--remote is on' : 'start with --upstream-pull' });
  async function refreshUpstream() {
    if (!upstream) return upstreamStatus;
    // Single-flight: a script in a loop must not spawn a hundred fetches.
    if (!checking) {
      checking = checkUpstream(upstream).then((st) => { upstreamStatus = st; checking = null; return st; });
    }
    return checking;
  }
  /** The label, re-printed: what the audience gets from here on. */
  const printLabel = () => {
    for (const line of formatLabel(audited.report)) console.log(line);
    if (container) console.log(formatManifest(container.manifest));
    console.log(formatSignature(signature));
  };
  /**
   * Fast-forward, then re-read, re-audit and RE-PRINT. SPEC's condition on
   * live reload in no-trust mode is exactly this: never new bytes under the
   * old verdict. So the label the presenter can see always describes the
   * bytes being served, and the two move together.
   */
  async function doPull() {
    // Re-checked against a FRESH fetch rather than trusted from the cached
    // status: what was true ten minutes ago is not a licence to check out now.
    const fresh = await refreshUpstream();
    const allowed = canPull(fresh, { offered: pullArmed });
    if (!allowed.ok) return { ok: false, ...allowed, http: 409 };

    const from = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: upstream.repoRoot })).stdout;
    console.log(`  upstream: PULL requested by the deck — fast-forward only, onto ${upstream.upstream}`);
    const merged = await runGit([...SAFE_CONFIG, '-c', `core.hooksPath=${upstream.repoRoot}/.git/decklight-no-hooks`,
      'merge', '--ff-only', '--no-verify', '@{upstream}'], { cwd: upstream.repoRoot, timeoutMs: 20000 });
    if (!merged.ok) {
      const why = oneline(merged.stderr || merged.err);
      console.log(`  upstream: the fast-forward was refused — ${why}`);
      return { ok: false, state: 'not-fast-forward', message: why };
    }
    const to = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: upstream.repoRoot })).stdout;

    // An upstream commit must never blank somebody's talk.
    if (!existsSync(deckPath)) {
      console.log(`  upstream: fast-forwarded ${from} → ${to}, but the deck is gone from that commit`);
      console.log('  still serving the bytes the label above describes');
      return { ok: false, state: 'deck-gone', to, message: 'the deck is not in that commit — still serving the old bytes' };
    }

    const wasStrict = audited.strict;
    const hadFindings = audited.report.counts.unaccounted > 0 || audited.report.counts.handlers > 0;
    if (!audit()) {
      console.log(`  upstream: fast-forwarded ${from} → ${to} — the deck itself is unchanged`);
      await refreshUpstream();
      return { ok: true, state: 'pulled', from, to, deck: 'unchanged', reload: false, message: `fast-forwarded to ${to} — the deck is unchanged` };
    }
    const findings = { unaccounted: audited.report.counts.unaccounted, handlers: audited.report.counts.handlers };
    const degraded = (findings.unaccounted > 0 || findings.handlers > 0) && !hadFindings;

    console.log(`  upstream: fast-forwarded ${from} → ${to}`);
    console.log('  the deck file changed — re-read and re-audited; the label below replaces the one above');
    noteWrite(whatWrote('/deck/upstream/pull'));
    printLabel();
    if (audited.strict) {
      console.log(wasStrict && !(findings.unaccounted > 0 || findings.handlers > 0)
        ? '  still serving strict — a pull cannot turn it off'
        : '  serving strict — what could not be accounted for is stripped');
    }
    console.log('  the label above describes what the audience gets when the deck is reloaded');
    await refreshUpstream();
    return {
      ok: true, state: 'pulled', from, to, deck: 'changed',
      strict: audited.strict, degraded, findings,
      // A degraded deck does NOT reload itself: the swap executes nothing (the
      // browser is still showing the old DOM), so the reload can wait for a
      // second confirmation that names what was found.
      reload: !degraded,
      message: degraded
        ? `the updated deck runs ${findings.unaccounted} unaccounted script block(s) and `
          + `${findings.handlers} inline handler(s) — they are stripped. Reload to show it`
        : `fast-forwarded to ${to}`,
    };
  }

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
  /**
   * Every entry of one TYPE a registered marketplace offers, qualified.
   *
   * Written for themes and generalised the day templates needed the same list:
   * the cache reading, the never-fetched marketplaces and the
   * cloned-but-missing ones are properties of the registry, not of what is
   * being listed, so a second copy of them would be a second thing to keep
   * right.
   */
  const browsableUnits = async (type) => {
    const { loadRegistry, loadCatalog, checkoutPath, classifySource, configHome } = await import('./marketplace.mjs');
    const registry = loadRegistry().marketplaces ?? {};
    const themes = [];
    // Registered-but-never-fetched is the FIRST-RUN state, not an error — the
    // first-party marketplace is deliberately in it — so it is reported as
    // something the presenter can act on (`marketplace update <name>`) rather
    // than as an empty list that looks like an empty marketplace.
    const stale = [];
    for (const [market, m] of Object.entries(registry)) {
      const loaded = loadCatalog(market);
      if (!loaded) { stale.push(market); continue; }
      if (!loaded.ok) { stale.push(market); continue; }
      // A cached catalog whose FILES are not on disk is the same actionable
      // state wearing a different face: since MARKETPLACES#CLONE an entry
      // installs from the marketplace's checkout, so listing its themes would
      // be offering rows that can only fail. `marketplace update` fixes both.
      if (classifySource(m.source ?? '').kind !== 'local' && !existsSync(checkoutPath(configHome(), market))) {
        stale.push(market);
        continue;
      }
      for (const e of loaded.manifest.entries ?? []) {
        if (e.type !== type) continue;
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
   * Advertised in /deck/ping beside the agents: the palette's Configure rows
   * come from here, so a player never has to guess an engine name to ask
   * /deck/edit/wizard about (ENGINES#WIZARD).
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
  let quietWrite = null; // the bytes of a write that updates the page itself (themeMarkRoute, cli/edit-look.mjs)
  // An agent working on a fix held for review (#907) edits the deck file in
  // place, and the file goes back to what it was when it is done: no page
  // reloads for any of it, because nothing it wrote has landed.
  let holding = false;
  // The DIRECTORY, not the file. A path watch follows the inode, and an
  // atomic write — temp file + rename, which is how an agent's editor and
  // most careful tools save — replaces the inode: the watcher then sits deaf
  // on the old one, and every later edit, restore included, reloads nobody.
  // Found in 0.7.0 manual testing as "restore worked but the deck kept
  // showing the old slides". A directory watch names the entry that changed
  // and survives any number of replacements.
  watch(dirname(deckPath), (kind, filename) => {
    if (filename && filename !== basename(deckPath)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      // No-trust mode serves the audited bytes, never the disk: a file that
      // changed underneath it is not reloaded, because that would be new
      // bytes under the old label. A pull re-audits.
      if (noTrust) return;
      if (holding) return;
      // A QUIET write is one the pages update themselves in place, which must
      // not reload: a theme marked from the open picker (a reload closes the
      // picker the author is still choosing in), or a notes save, whose new
      // notes every page is sent as a `notes` event. Skipped only when
      // the file is still exactly what that write put there; any other change
      // since (an editor save, an undo) reloads as it always has.
      const quiet = quietWrite;
      quietWrite = null;
      if (quiet !== null) {
        let now = null;
        try { now = readFileSync(deckPath, 'utf8'); } catch { /* gone — reload says so */ }
        if (now === quiet) { lastWrite = null; console.log('  changed → updated in place, no reload'); return; }
      }
      // The message names what wrote the file (`describeReload`): the page
      // stashes it with its debug log and says it first thing after the
      // reload. An older page reloads on any message, as it always did.
      const why = describeReload({ write: lastWrite, agent: agentJob });
      lastWrite = null;
      clients.raw(`data: ${JSON.stringify(why)}\n\n`);
      console.log(`  changed → reload × ${clients.size} — ${why.reload}${why.from ? ` (page ${why.from})` : ''}`);
    }, 150);
  });

  /**
   * An entry in the agent panel for work THIS SERVER did — a migration, a
   * quick fix — so it shows beside the agents' edits (DESIGN_SYSTEM_MIGRATIONS,
   * PRESENTING_EDITING): the same shape as an ask, by *decklight*, started
   * now; `ownDone` closes it with what came of it. Both ride the `agent`
   * events the panel already listens to.
   */
  function ownAsk({ kind, title, prompt, slide = undefined }) {
    const ask = {
      id: ++askSeq, agent: 'decklight', label: 'decklight', kind, title, prompt,
      ...(Number.isInteger(slide) && slide > 0 ? { slide } : {}),
      startedAt: Date.now(), state: 'running',
    };
    agentAsks.push(ask);
    if (agentAsks.length > ASKS_KEPT) agentAsks.shift();
    broadcast('agent', { state: 'start', agent: ask.agent, label: ask.label, prompt: ask.prompt, kind: ask.kind, title, slide: ask.slide, startedAt: ask.startedAt, id: ask.id });
    return ask;
  }
  function ownDone(ask, { ok = true, changed = false, tail = '' } = {}) {
    Object.assign(ask, { state: 'done', finishedAt: Date.now(), ok, changed, code: ok ? 0 : 1, tail });
    broadcast('agent', { state: 'done', id: ask.id, agent: ask.agent, ok, changed, code: ok ? 0 : 1, tail });
  }

  /**
   * Hand an ask to an agent. `files` are files beside the deck the job may
   * also write (a migration's linked stylesheets): snapshotted with the deck,
   * so one Z takes them all back, and committed with it. `reload` is the
   * reason the reload its edit causes carries; `kind` and `title` label the
   * ask in the panel. `subject` is a commit subject this server built (a
   * migration's), committed as given like the server's own path commits it:
   * cut to an agent's 72 characters, its version is what fell off. `before`
   * builds a closing sentence for the prompt from the commit that holds the
   * deck as it was, once the outstanding work is committed, for a job whose
   * checks compare against it (a migration's before and after renders).
   * `dirs` are folders outside the project the agent must read (a
   * migration's skill, where it is installed).
   *
   * `hold` makes it a fix held for review (#907): `{ start?, done(after) }`.
   * The agent edits the deck file as it always does (from `start`, a held
   * candidate it is adjusting, when given), with every reload held; when it
   * exits the file is put back exactly as it was, and what it wrote goes to
   * `done` instead of the history and git. Nothing is committed, before or
   * after. `done` answers what the `done` event carries for the review.
   */
  function runAgent(prompt, name, message, slide, { files = [], reload = null, kind = null, title = null, subject: given = null, before: beforeSay = null, dirs = [], hold = null } = {}) {
    let cmd = agentCommand(name || agentPref, prompt, deckRel, { slide, dirs });
    if (!cmd) return null;
    const ask = {
      id: ++askSeq, agent: cmd.name, label: cmd.label, prompt,
      ...(cmd.model ? { model: cmd.model } : {}),
      ...(Number.isInteger(slide) && slide > 0 ? { slide } : {}),
      ...(kind ? { kind } : {}), ...(title ? { title } : {}),
      startedAt: Date.now(), state: 'running',
    };
    agentAsks.push(ask);
    if (agentAsks.length > ASKS_KEPT) agentAsks.shift();
    const finish = (d) => Object.assign(ask, { state: 'done', finishedAt: Date.now() }, d);
    // Anything uncommitted at this moment is the PLAYER's work, not the
    // agent's. Sweeping it into its own commit first is what keeps the agent's
    // commit honest: otherwise a hand edit made just before pressing A lands
    // under the agent's message, and a history that misattributes authorship is
    // worse than one that only says "autosave".
    if (!hold && gitOn && shouldCommit(gitMode, { kind: 'bookend' })
        && ownCommit(`decklight: save before ${cmd.name} edits ${basename(deckPath)}`, files)) {
      console.log('  git: committed your outstanding changes first');
    }
    if (beforeSay && gitOn) {
      const head = cleanHead([deckPath, ...files]);
      if (head) {
        prompt = `${prompt} ${beforeSay(head)}`;
        ask.prompt = prompt;
        cmd = agentCommand(cmd.name, prompt, deckRel, { slide, dirs }) ?? cmd;
      }
    }
    // held: the deck as it really is, put back when the agent is done
    const kept = hold ? readDeck() : null;
    if (hold) {
      holding = true;
      if (typeof hold.start === 'string' && hold.start !== kept) writeFileAtomic(deckPath, hold.start);
    }
    /** The deck file as it was before a held run, again; no reload for the trip. */
    const putBack = () => {
      if (!hold) return;
      let now = null;
      try { now = readDeck(); } catch { /* gone: written back below */ }
      if (now !== kept) { quietWrite = kept; writeFileAtomic(deckPath, kept); }
      holding = false;
    };
    const before = readDeck();
    const filesBefore = snapshotFiles(files);
    // what is already beside the deck, so what the run leaves there can be named
    const leftBefore = new Set(besideDeck() ?? []);
    agentJob = { agent: cmd.name, label: cmd.label, ...(cmd.model ? { model: cmd.model } : {}), prompt, startedAt: ask.startedAt, id: ask.id, slide: ask.slide, ...(reload ? { reload } : {}) };
    broadcast('agent', { state: 'start', ...agentJob });
    console.log(`  agent: ${cmd.name}${cmd.model ? ` (${cmd.model})` : ''} ← "${prompt.slice(0, 80)}"`);
    const child = spawn(cmd.bin, cmd.args, { cwd: root, env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-4000); };
    // The clue the chip shows. An agent run used to be a timer and nothing
    // else — ten minutes of "is it stuck?" with no way to tell. claude's
    // stream-json narrates every tool call, so those become activity events
    // on the same SSE channel the start/done events already ride; any other
    // agent gets its last non-empty stdout line, throttled, which is what a
    // person watching the terminal would glance at anyway.
    let resultText = null;
    let lastSaid = 0;
    const say = (text) => {
      if (!text || !agentJob) return;
      agentJob.activity = text;   // /deck/ping carries it across a reload
      broadcast('agent', { state: 'activity', agent: cmd.name, text });
      console.log(`  agent: ${text}`);
    };
    // the stream's last line, if it ended without a newline: read at the end
    let flushStream = () => {};
    if (cmd.stream === 'claude-json') {
      let buf = '';
      const read = (line) => {
        const clue = claudeActivity(line);
        if (clue?.activity) say(clue.activity);
        else if (clue?.result != null) resultText = clue.result;
      };
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          read(line);
        }
      });
      flushStream = () => { if (buf.trim()) read(buf); buf = ''; };
      child.stderr.on('data', keep);
    } else {
      child.stdout.on('data', (chunk) => {
        keep(chunk);
        const now = Date.now();
        if (now - lastSaid < 800) return;
        const line = String(chunk).split('\n').map((l) => l.trim()).filter(Boolean).pop();
        if (line) { lastSaid = now; say(line.slice(0, 80)); }
      });
      child.stderr.on('data', keep);
    }
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    // Stopped by the author: SIGTERM, which every agent CLI answers by
    // winding down, then SIGKILL for one that has not a few seconds later.
    // Whatever it had written by then stays, and Z takes it back like any edit.
    let stopped = false, hard = null;
    agentStop = () => {
      stopped = true;
      child.kill('SIGTERM');
      hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    child.on('error', (e) => {
      clearTimeout(timeout);
      clearTimeout(hard);
      putBack();
      hold?.done(null);
      agentJob = null;
      agentStop = null;
      finish({ ok: false, changed: false, error: String(e.message || e) });
      broadcast('agent', { state: 'done', id: ask.id, agent: cmd.name, ok: false, changed: false, error: String(e.message || e) });
    });
    // after its output, not at its exit: a result line still in the pipe
    // when the process went was a report lost (see afterOutput)
    afterOutput(child, (code) => {
      clearTimeout(timeout);
      clearTimeout(hard);
      agentStop = null;
      flushStream();
      const after = readDeck();
      const filesAfter = snapshotFiles(files);
      const filesChanged = Object.keys(filesBefore).some((p) => filesAfter[p] !== filesBefore[p]);
      const changed = after !== before || filesChanged;
      // held for review: the deck goes back, the edit becomes the candidate
      putBack();
      const held = hold ? hold.done(changed ? after : null, { ok: code === 0 && !stopped }) : null;
      // the voice folders follow the slides the edit added, removed or moved
      // (#920), before the impact is read and the commit made
      const landed = !hold ? (changed && after !== before ? before : null)
        : (changed && !held && hold.start === undefined && after !== kept ? kept : null);
      let followed = null;
      if (landed !== null) {
        try { followed = followSlides(landed, after); } catch (e) { followed = { error: oneline(e) }; }
      }
      // what an undo entry carries beside the deck: its files, and the folders' steps back
      const also = (deck, files) => (files || followed?.voices
        ? { deck, ...(files ? { files } : {}), ...(followed?.voices ? { voices: followed.voices } : {}) }
        : deck);
      // a first run the review could not hold lands as it always did, never lost
      if (hold && changed && !held && hold.start === undefined) { history.record(also(kept)); writeDeck(after); }
      // Z takes the agent's edit back — with the files beside the deck it wrote, in the same step
      if (changed && !hold) history.record(also(before, filesChanged ? filesBefore : null));
      const voicesFollowed = followed?.said?.length ? followed.said.join('; ') : null;
      const voicesStuck = followed?.error ? `🎙 ${followed.error}` : null;
      for (const line of followed?.said ?? []) console.log(`  narration: ${line}`);
      if (voicesStuck) console.log(`  narration: ${followed.error}`);
      // One commit per completed agent edit, carrying the agent's own summary
      // — the boundary and the message both come from the work, not a clock.
      // A failed run or one that changed nothing commits nothing.
      if (!hold && gitOn && shouldCommit(gitMode, { kind: 'agent', ok: code === 0, changed })) {
        const subject = given ?? commitSubject(message ?? prompt, `decklight: ${cmd.name} edited ${basename(deckPath)}`);
        if (gitAutocommit(deckPath, root, subject, { also: [...alsoNow().also, ...files] })) { pendingAttr = null; console.log(`  git: committed "${subject}"`); }
      }
      // Did the edit orphan, stale, or reshape a recording? A track is
      // minutes of somebody's own voice, and a whole-deck rewrite can drop the
      // config that plays it or the notes it reads with nothing on screen to
      // say so — this is where before/after both exist, so it is where the
      // word is said. A warning, never a block: the file is already written,
      // Z takes it back, and the audio never left the disk.
      let recordingWarning = null;
      if (changed && !hold) {
        try {
          // the folders that followed are read where each take went, and as
          // they are now — which is already numbered like `after`
          const renumber = followed?.renumber ?? null;
          const back = (dir) => {
            const f = renumber?.get(String(dir).replace(/^\.\//, '').replace(/\/+$/, ''));
            return f ? (n) => { for (let k = 1; k <= n + 64; k++) if (f(k) === n) return k; return null; } : null;
          };
          const impact = recordingImpact(before, after, {
            dirsOf: configuredTrackDirs,
            recordedSlides: (dir) => {
              let now = [];
              try { now = slidesFromFiles(readdirSync(resolve(dirname(deckPath), dir))); } catch { return []; }
              const was = back(dir);
              return was ? now.map(was).filter((k) => k != null) : now;
            },
            renumber,
          });
          recordingWarning = impactWarning(impact);
        } catch { recordingWarning = null; }   // a warning that throws is worse than none
      }
      agentJob = null;
      // the agent's own words when the stream carried them — raw stream-json
      // stdout is a wall of JSON nobody should be shown
      // — from its start: a report leads with what it did (a migration's
      // renames and their counts), and the panel scrolls
      const said = reportText(resultText ?? tail.trim().split('\n').slice(-6).join('\n'));
      // Files the run created beside the deck and left there: never in the
      // commit (it names its paths), and said, so the author can delete them
      const left = (besideDeck() ?? []).filter((f) => !leftBefore.has(f));
      if (left.length) console.log(`  agent: ${cmd.name} left ${left.join(', ')} beside the deck (not committed)`);
      finish({ ok: code === 0, changed, code, tail: said, ...(left.length ? { left } : {}), ...(stopped ? { stopped } : {}), ...(held ? { held: true } : {}), ...(voicesFollowed ? { voicesFollowed } : {}) });
      broadcast('agent', {
        state: 'done', id: ask.id, agent: cmd.name, ok: code === 0, changed, code, tail: said,
        ...(left.length ? { left } : {}),
        ...(stopped ? { stopped } : {}),
        ...(held ? { candidate: held } : {}),
        ...(recordingWarning ? { recordingWarning } : {}),
        ...(voicesFollowed ? { voicesFollowed } : {}),
        ...(voicesStuck ? { voicesStuck } : {}),
      });
      console.log(`  agent: ${cmd.name} ${stopped ? 'stopped' : `exited (${code})`} — deck ${!changed ? 'unchanged' : hold ? 'changed, held for review' : 'changed'}`);
      if (recordingWarning) console.log(`  ${recordingWarning}`);
    });
    return cmd;
  }

  // ── the session: what a deck asks on load, and how it ends ───────────────

  // ── the bridges, on this origin (#520) ───────────────────────────────────
  // A deck served here reaches its live voice at `/deck/tts` (and the sibling
  // routes the runtime derives from it) and its lip-sync at `/deck/lipsync/*` —
  // the deck's own origin, never a port it would have to spell (SPEC
  // NARRATION). The bridges are separate processes on their own ports
  // (`--tts-port`, `--lipsync-port`); these forward to them, body and
  // headers both ways, and answer 503 when the bridge is not there, which the
  // deck takes exactly as it takes no bridge at all.
  const ttsPort = parsePort(opt('--tts-port', 8787)) ?? 8787;
  const lipsyncPort = parsePort(opt('--lipsync-port', 8789)) ?? 8789;
  const proxyTo = (port, name, rewritePath = (p) => p) => ({ req, res, url, body }) => new Promise((done) => {
    const { host: _host, ...headers } = req.headers;
    const upstream = httpRequest({
      host: '127.0.0.1', port, method: req.method, path: rewritePath(url.pathname) + url.search,
      headers: { ...headers, host: `127.0.0.1:${port}` },
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      up.on('end', done);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`the ${name} bridge is not running on port ${port} (${e.code ?? e.message})`);
      done();
    });
    // every proxied route is dispatched before the body is read, so the
    // request streams through — audio for the lip-sync bridge included
    if (body !== undefined) upstream.end(body); else req.pipe(upstream);
  });
  // both bridges serve their routes at their own roots; on the deck's origin
  // they sit under /deck/, and the prefix comes off on the way through
  const ttsProxy = proxyTo(ttsPort, 'voice', (p) => p.slice('/deck'.length));
  const lipsyncProxy = proxyTo(lipsyncPort, 'lip-sync', (p) => p.slice('/deck/lipsync'.length));

  // ── the lock (PRESENTING) ─────────────────────────────────────────────────
  // Editing is on from the moment write mode answers; the lock is the one
  // switch that turns changes off, to avoid making one by mistake, and back
  // on. It lives here, not in a page, so every tab and the agent see the
  // same state: locked, every POST to /deck/edit/* but this one answers 423,
  // the ping says so, and the channel tells every open page. No-trust mode
  // has no lock to turn: the write family refuses there anyway.
  let locked = false;
  function lockRoute({ body, json }) {
    const { locked: want } = JSON.parse(body || '{}');
    if (typeof want !== 'boolean') return json(400, { ok: false, error: 'locked is true or false' });
    if (want !== locked) {
      locked = want;
      console.log(locked ? '  deck locked — nothing is written until it is unlocked' : '  deck unlocked');
      broadcast('lock', { locked });
    }
    return json(200, { ok: true, locked });
  }
  function shutdownRoute({ res, json, CORS }) {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    // same shutdown a Ctrl-C takes — final autocommit, then actually exit —
    // once the response has cleared the socket, so the asker sees it land
    res.once('finish', () => { finalCommit(); process.exit(0); });
    return;
  }

  function undoRedoRoute({ url, json }) {
    const dir = url.pathname.endsWith('undo') ? 'undo' : 'redo';
    const cur = readDeck();
    // an entry that wrote files beside the deck is answered by those files as they are now
    // …and one that renumbered voice folders (#916) by its steps, planned
    // against the folders as they are now: a take recorded since is carried
    // along, not written over, and redo gets the steps that undo this
    const deckDir = dirname(deckPath);
    let plans = null;
    const content = history[dir]((e) => {
      if (typeof e === 'string') return cur;
      plans = e.voices ? e.voices.map((step) => planFolder(deckDir, step)) : null;
      return {
        deck: cur,
        files: snapshotFiles(Object.keys(e.files ?? {})),
        ...(plans ? { voices: plans.map((p) => p.inverse) } : {}),
      };
    });
    if (content === null) return json(409, { ok: false, error: `nothing to ${dir}`, ...history.counts() });
    if (typeof content !== 'string') {
      for (const [p, text] of Object.entries(content.files ?? {})) writeFileAtomic(p, text);
      if (plans) {
        // a file in the way is set aside in the folder's .trash/, never written over
        try {
          const { moved, setAside } = applyPlans(deckDir, plans.filter(planMoves), { aside: true });
          if (moved) console.log(`  ${dir}: ${moved} recording file${moved === 1 ? '' : 's'} moved with the slides`);
          for (const p of setAside) console.log(`  ${dir}: ${p} was in the way, set aside rather than overwritten`);
        } catch (e) { console.log(`  ${dir}: the voice folders could not follow — ${oneline(e)}; they are as they were`); }
      }
    }
    writeDeck(typeof content === 'string' ? content : content.deck);
    console.log(`  ${dir} → ${JSON.stringify(history.counts())}`);
    return json(200, { ok: true, ...history.counts() });
  }

  // ── review comments (SPEC REVIEW) ─────────────────────────────
  // The author's side of `decklight <deck> --no-trust`. The same file, the same
  // append-only rule: this server may add a line (a resolve, a move) and
  // may not rewrite one, because `merge=union` is what keeps two reviewers
  // from conflicting and an edit in place is what would break it.
  // What reviews are waiting on the remote — the M overlay's incoming
  // section. This one is a fetch the author DID ask for: it runs behind
  // the keypress that just opened the overlay, on demand and nowhere else.
  // The 60s cache is what keeps a nervous author tapping M from turning
  // one gesture into a fetch storm; the off switches still win outright.
  async function reviewIncomingRoute({ json }) {
    // ci: false — this fetch is ASKED FOR, behind the keypress that
    // opened the overlay; only the explicit switches silence it.
    const skipped = reviewCheckSuppressed({ args, ci: false });
    if (skipped) return json(200, { ok: true, state: 'suppressed', reason: skipped, reviews: [] });
    if (!incomingCache || Date.now() - incomingCache.at > 60_000) {
      const r = await reviewsWaiting(deckPath);
      incomingCache = { at: Date.now(), r };
    }
    return json(200, { ok: true, ...incomingCache.r });
  }

  // Point the deck at a track the recorder just wrote. The one manual step
  // in a flow that is otherwise a key and an arrow — and this server
  // already owns the file, so it can take that step too.
  function reviewAtRoute({ url, json }) {
    // The orphan's context: what the slide SAID when the comment was
    // written — `comments --at`, served, so the overlay can put the dead
    // slide's prose under the objection that was about it. Read-only, all
    // local (the commit is already in this clone or the answer is "not
    // here"), and gated exactly as the CLI gates it.
    const id = url.searchParams.get('id') ?? '';
    if (!/^[a-z0-9]{1,12}$/.test(id)) return json(400, { ok: false, error: 'bad comment id' });
    const store = reviewPathFor(deckPath);
    if (!existsSync(store)) return json(404, { ok: false, error: 'no comments here' });
    const c = foldReview(parseReview(readFileSync(store, 'utf8')).records).find((x) => x.id === id);
    if (!c) return json(404, { ok: false, error: `no comment [${id}]` });
    if (!c.deck) return json(200, { ok: true, known: false, why: 'written outside a repository — there is no earlier version to show' });
    if (!gitOn || !knowsCommit(c.deck, root)) {
      return json(200, { ok: true, known: false, why: `this clone does not have ${c.deck}` });
    }
    try {
      const thenHtml = deckAt(deckPath, c.deck, root);
      const wasAt = indexDeckFile(thenHtml)[(c.slide ?? 0) - 1] ?? null;
      return json(200, {
        ok: true,
        known: true,
        deck: c.deck,
        slide: c.slide ?? null,
        title: wasAt?.title ?? null,
        text: slideTextOf(thenHtml, c.slide) || '',
      });
    } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
  }

  // ── the engine wizard (ENGINES#WIZARD) ─────────────────────────────
  // The schema the player renders. Validated on the way OUT as well as on
  // the way in: a catalog is a file someone else wrote, and handing the
  // renderer a schema core has not vetted is how "core renders, a plugin
  // declares" becomes "core renders whatever a plugin sent".
  async function wizardSchemaRoute({ url, json }) {
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
  // server answers loopback alone, and `--no-trust` registers nothing like
  // these at all. A credential prompt in a deck you were emailed has
  // nowhere to post.
  async function wizardConfigureRoute({ body, json }) {
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
    console.log(`  wizard: ${engine} configured (${r.file} — ${r.protection.label})`);
    // A key that could not be restricted is worth an extra line, at the
    // moment it is stored rather than in a doc nobody reads (#308): what
    // decklight says about a credential and what is true of it on disk
    // have to be the same sentence.
    if (r.protection.state !== 'private') {
      console.log(`  wizard: decklight could NOT restrict that file to your account — ${r.protection.label}`);
      if (r.protection.why) console.log(`          the system said: ${r.protection.why}`);
    }
    return json(200, { ok: true, state: r.state, engine, stored: r.stored, protection: r.protection.label });
  }

  function wizardForgetRoute({ body, json }) {
    const { engine } = JSON.parse(body);
    if (typeof engine !== 'string') return json(400, { ok: false, error: 'which engine?' });
    const had = forgetCredentials(engine);
    console.log(`  wizard: ${engine} ${had ? 'forgotten' : 'was not configured'}`);
    return json(200, { ok: true, forgotten: had });
  }

  // ── the recorder's offline recordings — V → Save a live voice as a track, or your voice (PRESENTING) ───────────────────────────────
  // The player used to hand every stitched slide to the browser's DOWNLOAD
  // path, which is why a deck's voice arrived as thirty slide-NN.wav in
  // whatever folder the OS calls Downloads — never the deck's, and on
  // Windows not even near it. `bundle` only ever looks NEXT TO THE DECK, so
  // the recording was finished and in the wrong place, and the last step
  // was moving files by hand. In write mode the server that already owns
  // the deck file writes them itself.
  //
  // Ahead of the shared body read below because this body is BINARY and
  // megabytes of it: a slide of speech is ~48 kB a second, so the string
  // concat and its 1 MB ceiling would both be wrong.
  async function recordRoute({ req, url, json }) {
    const slide = Number(url.searchParams.get('slide'));
    const kind = url.searchParams.get('kind');
    if (!Number.isInteger(slide) || slide < 1 || slide > 9999) return json(400, { ok: false, error: 'bad slide' });
    if (!['wav', 'visemes', 'manifest', 'face', 'face-join'].includes(kind)) return json(400, { ok: false, error: 'bad kind' });
    // `seg` is the per-⟨CLICK⟩ file number — the audio that lets a recording
    // step the builds (slide-NN-KK.wav) and the viseme timeline cut to
    // match it (slide-NN-KK.visemes.json). Absent means the whole slide.
    // Bounded and integral like `slide`, and for the same reason: it is
    // half of a filename this server builds, and the only defence that
    // survives someone deciding the name should be more flexible one day.
    const segRaw = url.searchParams.get('seg');
    const seg = segRaw == null ? null : Number(segRaw);
    if (seg !== null && (!Number.isInteger(seg) || seg < 1 || seg > 999)) {
      return json(400, { ok: false, error: 'bad seg' });
    }
    // The player names the FOLDER (its own `narration.files`, so a recorded
    // set lands where that deck already plays from) and nothing else: the
    // file name is built here, so no request can choose one. The folder is
    // contained to the served root by the same rule staticFiles reads by —
    // and `..`, absolute paths and Windows drive letters are refused before
    // it, because `resolve` would happily swallow all three.
    const want = url.searchParams.get('dir') || 'voiceover';
    const bad = want.length > 200 || /^[/\\]/.test(want) || /^[a-zA-Z]:/.test(want)
      || want.split(/[/\\]/).includes('..');
    const dir = bad ? null : resolve(deckPath, '..', want);
    if (!dir || (!dir.startsWith(root + sep) && dir !== root)) {
      return json(400, { ok: false, error: 'the recording folder must sit inside the deck\'s own directory' });
    }
    const stem = `slide-${String(slide).padStart(2, '0')}`
      + (seg === null ? '' : `-${String(seg).padStart(2, '0')}`);
    const name = `${stem}.${kind === 'wav' ? 'wav' : kind === 'face' ? 'mp4' : 'visemes.json'}`;
    // Your face, filmed with the beat (PRESENTING, the your-voice recorder):
    // made into a clip exactly as long as the beat's WAV, which is uploaded
    // first, so the face cannot drift from the voice across a slide
    // (tools/face-clip.mjs). Then `face-join` makes the slide's clip from its
    // beats', the way the runtime stitches the whole-slide WAV from them. A
    // beat with no clip (recorded before the camera was on) cannot be joined:
    // the slide's old clip is taken away rather than left to play over audio
    // it was not filmed with, and the answer names what is missing.
    if (kind === 'face-join') {
      const segs = String(url.searchParams.get('segs') ?? '').split(',').filter(Boolean).map(Number);
      if (!segs.length || segs.some((k) => !Number.isInteger(k) || k < 1 || k > 999)) return json(400, { ok: false, error: 'bad segs' });
      const nn = String(slide).padStart(2, '0');
      const parts = segs.map((k) => resolve(dir, `slide-${nn}-${String(k).padStart(2, '0')}.mp4`));
      const missing = segs.filter((_, i) => !existsSync(parts[i]));
      const out = resolve(dir, `slide-${nn}.mp4`);
      if (missing.length) {
        rmSync(out, { force: true });
        return json(200, { ok: false, dir: want, missing });
      }
      const { joinFaceClips, hasFfmpeg } = await import('../tools/face-clip.mjs');
      if (!(await hasFfmpeg())) return json(501, { ok: false, error: 'the face needs ffmpeg to be saved: install it (brew install ffmpeg / apt install ffmpeg)' });
      try { await joinFaceClips({ parts, out }); } catch (e) { rmSync(out, { force: true }); return json(500, { ok: false, error: oneline(e) }); }
      console.log(`  filmed ${want}/slide-${nn}.mp4 (${segs.length} beat${segs.length === 1 ? '' : 's'})`);
      return json(200, { ok: true, dir: want, file: `slide-${nn}.mp4` });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64e6) return json(413, { ok: false, error: 'recording too large' });
      chunks.push(chunk);
    }
    // The take's manifest (#535), so a folder the deck recorded is a track
    // `decklight video` renders from, the export offers and the picker
    // refreshes into — the shape tools/voiceover.mjs writes, hashed the same
    // way. The runtime says WHICH slides it recorded and their beat numbers;
    // the notes each hash covers are read from the deck file here, the way
    // voiceover and video read them, so the three can never disagree on the
    // text. Written after every slide, so an aborted take is a valid partial.
    if (kind === 'manifest') {
      if (size > 1e6) return json(413, { ok: false, error: 'manifest too large' });
      let req2;
      try { req2 = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { ok: false, error: 'the manifest is not JSON' }); }
      const str = (v, max = 120) => (typeof v === 'string' && v.length <= max && /^[\w .:+()'-]*$/.test(v) ? v : null);
      // `mine`: your own voice (#850), which no engine voiced. Its manifest
      // carries the beats as you read them, so a moved ⟨CLICK⟩ can be told
      // from changed words, and the notes hash `decklight video` checks.
      const mine = req2.mine === true;
      const header = mine ? { engine: null, model: null, voice: null, style: null }
        : { engine: str(req2.engine, 40), model: str(req2.model), voice: str(req2.voice), style: typeof req2.style === 'string' && req2.style.length <= 400 ? req2.style : null };
      if (!mine && !header.engine) return json(400, { ok: false, error: 'the manifest names no engine' });
      const from = Number(req2.range?.[0]), to = Number(req2.range?.[1]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 9999) return json(400, { ok: false, error: 'bad range' });
      const recorded = {};
      for (const [k, v] of Object.entries(req2.slides ?? {})) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < from || n > to) continue;
        recorded[n] = { segments: Array.isArray(v?.segments) ? v.segments.map(Number) : [], ...(v?.face === true ? { face: true } : {}) };
      }
      const { recorderManifest, slideTexts, slideBeats } = await import('../tools/narration-manifest.mjs');
      let prev = null;
      try { prev = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')); } catch { /* first take here */ }
      // A folder of your voice recorded before it had a manifest: its other
      // slides are on disk, and a manifest naming only this one would hide
      // them from `decklight video`, which trusts a manifest over the files.
      // They are kept as found, with no record of what was read: unknown.
      if (!Array.isArray(prev?.slides) && mine) {
        const { folderNarration } = await import('../tools/video.mjs');
        prev = folderNarration(dir);
      }
      const deckNow = readDeck();
      const manifest = recorderManifest({
        prev: Array.isArray(prev?.slides) ? prev : null, header, texts: slideTexts(deckNow), range: { from, to }, recorded,
        ...(mine ? { recorder: 'mic', beats: slideBeats(deckNow) } : {}),
      });
      // A slide recorded again without the camera (or whose beats could not
      // all be filmed): its clips show a face saying what was said before.
      // A beat's clip is only ever filmed, so it goes; the slide's goes when
      // the manifest said it was filmed, never one `decklight lipsync` made.
      if (mine) {
        let names = [];
        try { names = readdirSync(dir); } catch { /* no folder, nothing filmed */ }
        for (const n of Object.keys(recorded)) {
          if (recorded[n].face) continue;
          const nn = String(n).padStart(2, '0');
          const filmed = !!prev?.slides?.[n - 1]?.face;
          for (const f of names) {
            if (new RegExp(`^slide-${nn}-\\d+\\.mp4$`).test(f) || (filmed && f === `slide-${nn}.mp4`)) rmSync(resolve(dir, f), { force: true });
          }
        }
      }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        // the script beside each file, as voiceover writes it — `--reuse-text` reads it back
        const texts = slideTexts(readDeck());
        for (const n of Object.keys(recorded)) writeFileSync(resolve(dir, `slide-${String(n).padStart(2, '0')}.txt`), texts[n - 1] ?? '');
      } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
      return json(200, { ok: true, dir: want, file: 'manifest.json', slides: manifest.slides.filter(Boolean).length });
    }
    if (kind === 'face') {
      const { writeFaceClip, hasFfmpeg } = await import('../tools/face-clip.mjs');
      if (!(await hasFfmpeg())) return json(501, { ok: false, error: 'the face needs ffmpeg to be saved: install it (brew install ffmpeg / apt install ffmpeg)' });
      try {
        mkdirSync(dir, { recursive: true });
        await writeFaceClip({ bytes: Buffer.concat(chunks), out: resolve(dir, name), wav: resolve(dir, `${stem}.wav`) });
      } catch (e) { rmSync(resolve(dir, name), { force: true }); return json(500, { ok: false, error: oneline(e) }); }
      console.log(`  filmed ${want}/${name} (${Math.round(size / 1024)} kB)`);
      return json(200, { ok: true, dir: want, file: name });
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, name), Buffer.concat(chunks));
    } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
    console.log(`  recorded ${want}/${name} (${Math.round(size / 1024)} kB)`);
    return json(200, { ok: true, dir: want, file: name });
  }

  // What tracks already sit next to this deck. The runtime cannot see the
  // filesystem — which is why `segments: true` is opt-in at all — so it
  // cannot know that `voices/rachel` is taken before proposing it. One
  // question, asked when a recorder opens.
  function tracksRoute({ json }) {
    const root2 = resolve(deckPath, '..');
    const seen = [];
    const deck = readDeck();
    const texts = slideTexts(deck);
    const prior = priorSlideTexts(deck);
    const look = (rel) => {
      let entries;
      try { entries = readdirSync(resolve(root2, rel), { withFileTypes: true }); } catch { return; }
      const wav = entries.filter((e) => e.isFile() && /^slide-\d+(-\d+)?\.(wav|m4a|mp3)$/.test(e.name));
      if (wav.length) {
        let engine = null; let voice = null; let model = null; let style = null; let manifest = false; let stale = 0; let mine = false;
        let drift = [];
        let realign = null;
        try {
          const m = JSON.parse(readFileSync(resolve(root2, rel, 'manifest.json'), 'utf8'));
          engine = m.engine ?? null; voice = m.voice ?? null; manifest = true; mine = m.recorder === 'mic';
          // …and the rest of who voiced it, so the V panel re-voices a
          // synthesized track as itself rather than as the live voice (#919)
          model = m.model ?? null; style = m.style ?? null;
          // how many of its slides were voiced from other notes than the deck
          // has now — the export card marks the track with it (#536)
          if (Array.isArray(m.slides)) {
            stale = staleSlides(m, texts, null, prior).stale.length;
            // …and which, and how (#850): the V panel and narrate --check
            // say "the [click] moved" rather than only "different notes"
            drift = trackDrift(m, deck).drift;
            // …and whether those recordings are only in the wrong place (#916):
            // the deck was reordered outside the slide ops, and each one's
            // stored words say which slide it belongs to now
            realign = realignMoves(m, deck, { scripts: trackScripts(resolve(root2, rel)) });
          }
        } catch { /* a folder recorded by hand has no manifest, and needs none */ }
        seen.push({
          dir: rel.split(sep).join('/'),
          files: wav.length,
          // the beats are what let a track pace the builds, so whether it
          // has them is the one fact worth reporting beside the count
          segments: wav.some((e) => /^slide-\d+-\d+\./.test(e.name)),
          // …and which slides have a whole-slide file: the recorder's plan
          // card lists every slide as recorded, missing or out of step
          slides: wav.map((e) => /^slide-(\d+)\.(wav|m4a|mp3)$/.exec(e.name)).filter(Boolean)
            .map((m) => Number(m[1])).sort((a, b) => a - b),
          ext: (wav[0].name.split('.').pop()),
          engine,
          voice,
          model,
          style,
          manifest,
          mine,
          drift,
          ...(realign?.moves.length ? { realign: { moves: realign.moves, said: realign.said } } : {}),
          // what `decklight video` can render from: a manifest, or a
          // whole-slide file to read off the disk, which is what your own
          // voice leaves (folderNarration). Beats alone render nothing.
          renders: manifest || wav.some((e) => /^slide-\d+\./.test(e.name)),
          stale,
        });
      }
      return entries;
    };
    for (const e of look('.') ?? []) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const kids = look(e.name) ?? [];
      // one more level, because the convention is voices/<voice>
      for (const k of kids) {
        if (k.isDirectory() && !k.name.startsWith('.')) look(`${e.name}${sep}${k.name}`);
      }
    }
    return json(200, { ok: true, tracks: seen });
  }

  /**
   * `POST /deck/edit/narration/realign` — `{ dir }`: move a track's recordings
   * back onto the slides they were recorded from (#916), after a reorder this
   * server did not make (an agent, an editor, a hand-pasted section). The
   * moves are worked out here, from the manifest and the deck as they are
   * now, never taken from the page. One undo entry, the deck unchanged in
   * it, so Z puts the folder back. A rename that would overwrite a file
   * outside the plan refuses the whole realign and says which.
   */
  function realignRoute({ body, json }) {
    const { dir: want } = JSON.parse(body || '{}');
    if (typeof want !== 'string' || !want.trim() || want.length > 200 || /^[/\\]/.test(want)
        || /^[a-zA-Z]:/.test(want) || want.split(/[/\\]/).includes('..')) {
      return json(400, { ok: false, error: 'bad narration folder' });
    }
    const deckDir = dirname(deckPath);
    const rel = want.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!voiceFolders(deckPath, configuredTrackDirs(readDeck())).includes(rel)) {
      return json(404, { ok: false, error: `${rel}/ is not one of this deck's voice folders` });
    }
    let m = null;
    try { m = JSON.parse(readFileSync(resolve(deckDir, rel, 'manifest.json'), 'utf8')); } catch { /* said below */ }
    if (!Array.isArray(m?.slides)) return json(409, { ok: false, error: `${rel}/ has no manifest — nothing records which slide each take was read from` });
    const cur = readDeck();
    const { moves, said } = realignMoves(m, cur, { scripts: trackScripts(resolve(deckDir, rel)) });
    if (!moves.length) return json(200, { ok: true, moved: 0, said: 'every recording is already on its slide', ...history.counts() });
    const plan = planFolder(deckDir, { dir: rel, pairs: moves });
    if (plan.conflicts.length) return json(409, { ok: false, error: `${plan.conflicts[0]} — nothing was moved` });
    if (!planMoves(plan)) return json(200, { ok: true, moved: 0, said: 'every recording is already on its slide', ...history.counts() });
    // the folder first, the undo entry once it has moved: a failed move is put back, and leaves nothing to undo
    try { applyPlans(deckDir, [plan]); } catch (e) { return json(409, { ok: false, error: oneline(e), ...history.counts() }); }
    history.record({ deck: cur, voices: [plan.inverse] });
    console.log(`  narration: ${rel}/ realigned — ${said}`);
    return json(200, { ok: true, moved: moves.filter(([, t]) => t !== null).length, said, ...history.counts() });
  }

  // ── AI agents — the one-shot editing task behind A ───────────────────────

  // Remember which agent A should reach for (#125, SPEC AGENT_UNITS). A
  // preference is a choice about this machine, not about the deck, so it
  // is written beside the unit library and never into the file.
  function agentPreferRoute({ body, json }) {
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

  /** What the card shows for `agent`'s model: the one it runs on, where that came from, whether it can take one. */
  function agentModelState(agent) {
    const { model, source } = agentModel(agent.name);
    return { model, modelSource: source, takesModel: takesModel(agent), suggest: agent.models ?? [] };
  }

  // Remember the model an agent runs on (#918): beside the preference, in
  // agent.json, for decklight's runs only. Picking one here is this session's
  // latest word, so it also replaces a --agent-model this run was started with.
  function agentModelRoute({ body, json }) {
    const { agent, model, task: asked } = JSON.parse(body);
    const task = asked === 'ask' ? 'ask' : 'edit';
    if (typeof agent !== 'string' || (model !== null && typeof model !== 'string')) throw new Error('bad payload');
    const entry = agents.find((a) => a.name === agent);
    if (!entry) return json(400, { ok: false, error: agentUnavailable(agent, agents) });
    if (!takesModel(entry)) return json(400, { ok: false, error: `${entry.label} takes no model flag — it runs on its own default` });
    setAgentModel(agent, model, { task });
    delete process.env[MODEL_ENV[task]];
    const now = agentModel(agent, { task }).model;
    console.log(`  agent: ${agent}${task === 'ask' ? ' (questions)' : ''} → ${now ?? 'its own default model'}`);
    return json(200, { ok: true, agent, task, model: now });
  }

  // The voiceover script, given ElevenLabs v4's audio tags (cli/enhance.mjs):
  // the agent drafts, read-only, a few slides at a time; decklight checks each
  // answer kept the words and beats, and writes them in ONE edit so Z takes
  // the whole run back. Progress rides the SSE channel as 'enhance' events.
  async function enhanceRoute({ body, json }) {
    const { slides, agent, kind: asked } = JSON.parse(body);
    const kind = asked === 'spoken' ? 'spoken' : 'tags';
    const which = slides === 'all' ? null
      : Array.isArray(slides) && slides.length && slides.every((n) => Number.isInteger(n) && n > 0) ? slides : undefined;
    if (which === undefined) throw new Error('bad payload');
    if (enhancing) return json(409, { ok: false, error: `already enhancing — ${enhancing.done} of ${enhancing.of} slides done` });
    if (reviewing) return json(409, { ok: false, error: 'the agent is reviewing the deck — wait for it to finish' });
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is editing the deck — wait for it to finish` });
    const name = agent ?? agentPref ?? null;
    const cmd = agentAsk(name, 'x');
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(name, agents) });
    const { enhanceDeck, applyEnhanced, enhanceable, KINDS } = await import('./enhance.mjs');
    const verb = KINDS[kind].done;
    const html = readDeck();
    const of = enhanceable(html, which).length;
    if (!of) return json(422, { ok: false, error: which?.length === 1 ? `slide ${which[0]} has no notes to enhance` : 'no notes to enhance' });
    const stop = new AbortController();
    enhancing = { of, done: 0, stop: () => stop.abort() };
    broadcast('enhance', { state: 'start', of, agent: cmd.name, kind });
    console.log(`  enhance: ${of} slide${of === 1 ? '' : 's'}${kind === 'spoken' ? ', written for the ear' : ''} ← ${cmd.name} (read-only)`);
    enhanceDeck(html, which, {
      kind, agent: name, cwd: dirname(deckPath), signal: stop.signal,
      onSlide: (r) => {
        enhancing.done = r.done;
        broadcast('enhance', { state: 'slide', ...r });
        console.log(`  enhance: slide ${r.slide} ${r.ok ? (r.changed ? verb : 'unchanged') : `left as it was — ${r.why}`}`);
      },
    }).then(({ answers, results }) => {
      // Stopped: nothing is held. Half a deck tagged reads as a deck
      // somebody forgot to finish, and the slides already answered are a
      // cache hit for nobody — the agent is asked afresh next time.
      if (stop.signal.aborted) {
        enhancing = null;
        broadcast('enhance', { state: 'done', ok: false, stopped: true, kind });
        console.log('  enhance: stopped — nothing written');
        return;
      }
      // against the deck as it is NOW: a slide edited while the agent thought keeps the edit
      const cur = readDeck();
      const { html: next, stale } = applyEnhanced(cur, answers);
      const changed = results.filter((r) => r.changed && !stale.includes(r.slide)).map((r) => r.slide);
      const failed = results.filter((r) => !r.ok).map(({ slide, why }) => ({ slide, why }));
      const left = [...failed, ...stale.map((slide) => ({ slide, why: 'edited while the agent thought — kept as edited' }))].sort((a, b) => a.slide - b.slide);
      // HELD, not written: the rewrite is a candidate the review decides on,
      // slide by slide, like a quick fix (#907). Only a deck the review cannot
      // cut lands as it used to, as one edit the undo chord takes back.
      let candidate = null;
      if (next !== cur) {
        const what = kind === 'spoken' ? 'script: written for the ear' : 'script: audio tags';
        const h = fixReview.hold({ before: cur, after: next, what, kind: 'script', agent: cmd.name, left });
        if (h.ok) candidate = { id: h.id, units: h.units.length };
        else { console.log(`  enhance: ${h.error} — written as one edit instead`); applyEdit(next, cur); }
      }
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: true, changed, failed, stale, kind, candidate });
      console.log(`  enhance: done — ${changed.length} ${verb}${failed.length ? `, ${failed.length} left as they were` : ''}${candidate ? ', held for review' : ''}`);
    }).catch((e) => {
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: false, error: oneline(e), kind });
    });
    return json(200, { ok: true, of, agent: cmd.name, label: cmd.label, kind });
  }

  /**
   * The slide's own text, rewritten by a tool (cli/rewrite.mjs, SPEC
   * PRESENTING_WRITING): `{ slides, tool, instruction? }`. Runs like an
   * enhance, one ask per slide, and is HELD the same way: the passing slides
   * make the candidate, the review decides, nothing is written here.
   */
  async function rewriteRoute({ body, json }) {
    const { slides, agent, tool, instruction = '' } = JSON.parse(body);
    const { rewriteDeck, applyRewritten, rewritable, TOOLS } = await import('./rewrite.mjs');
    if (!TOOLS[tool]) throw new Error('bad payload');
    if (tool === 'custom' && (typeof instruction !== 'string' || !instruction.trim())) return json(400, { ok: false, error: 'say what to change — the custom tool needs an instruction' });
    const which = slides === 'all' ? null
      : Array.isArray(slides) && slides.length && slides.every((n) => Number.isInteger(n) && n > 0) ? slides : undefined;
    if (which === undefined) throw new Error('bad payload');
    if (enhancing) return json(409, { ok: false, error: `already rewriting — ${enhancing.done} of ${enhancing.of} slides done` });
    if (reviewing) return json(409, { ok: false, error: 'the agent is reviewing the deck — wait for it to finish' });
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is editing the deck — wait for it to finish` });
    const name = agent ?? agentPref ?? null;
    const cmd = agentAsk(name, 'x');
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(name, agents) });
    const html = readDeck();
    const of = rewritable(html, which).length;
    if (!of) return json(422, { ok: false, error: which?.length === 1 ? `slide ${which[0]} has no text to rewrite` : 'no slide text to rewrite' });
    const stop = new AbortController();
    enhancing = { of, done: 0, stop: () => stop.abort() };
    broadcast('enhance', { state: 'start', of, agent: cmd.name, kind: tool });
    console.log(`  rewrite: ${TOOLS[tool].label} on ${of} slide${of === 1 ? '' : 's'} ← ${cmd.name} (read-only)`);
    rewriteDeck(html, tool, which, {
      instruction: String(instruction).slice(0, 1000), agent: name, cwd: dirname(deckPath), signal: stop.signal,
      onSlide: (r) => {
        enhancing.done = r.done;
        broadcast('enhance', { state: 'slide', ...r, kind: tool });
        console.log(`  rewrite: slide ${r.slide} ${r.ok ? (r.changed ? TOOLS[tool].done : 'unchanged') : `left as it was — ${r.why}`}`);
      },
    }).then(({ answers, results }) => {
      if (stop.signal.aborted) {
        enhancing = null;
        broadcast('enhance', { state: 'done', ok: false, stopped: true, kind: tool });
        console.log('  rewrite: stopped — nothing written');
        return;
      }
      const cur = readDeck();
      const { html: next, stale } = applyRewritten(cur, answers);
      const changed = results.filter((r) => r.changed && !stale.includes(r.slide)).map((r) => r.slide);
      const failed = results.filter((r) => !r.ok).map(({ slide, why }) => ({ slide, why }));
      const left = [...failed, ...stale.map((slide) => ({ slide, why: 'edited while the agent thought — kept as edited' }))].sort((a, b) => a.slide - b.slide);
      let candidate = null;
      if (next !== cur) {
        const what = tool === 'custom' ? `text: ${String(instruction).trim().slice(0, 60)}` : TOOLS[tool].what;
        const h = fixReview.hold({ before: cur, after: next, what, kind: 'text', agent: cmd.name, left });
        if (h.ok) candidate = { id: h.id, units: h.units.length };
        else { console.log(`  rewrite: ${h.error} — written as one edit instead`); applyEdit(next, cur); }
      }
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: true, changed, failed, stale, kind: tool, candidate });
      console.log(`  rewrite: done — ${changed.length} ${TOOLS[tool].done}${failed.length ? `, ${failed.length} left as they were` : ''}${candidate ? ', held for review' : ''}`);
    }).catch((e) => {
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: false, error: oneline(e), kind: tool });
    });
    return json(200, { ok: true, of, agent: cmd.name, label: cmd.label, kind: tool });
  }

  // The agent review (cli/agent-review.mjs): the agent reads the deck,
  // read-only, a few slides at a time, against the rules in REVIEW_RULES;
  // every answer is checked before it is kept. Nothing here writes: a finding
  // is fixed by the author's own `f` in Check deck…, which is an ordinary A
  // edit through agentRoute. Progress rides the SSE channel as 'review' events.
  async function reviewRoute({ body, json }) {
    const { agent } = JSON.parse(body || '{}');
    if (reviewing) return json(409, { ok: false, error: `already reviewing — ${reviewing.done} of ${reviewing.of} batches done` });
    if (enhancing) return json(409, { ok: false, error: 'the voiceover is being enhanced — wait for it to finish' });
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is editing the deck — wait for it to finish` });
    const name = agent ?? agentPref ?? null;
    const cmd = agentAsk(name, 'x');
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(name, agents) });
    const { reviewDeck, reviewSlides, REVIEW_BATCH } = await import('./agent-review.mjs');
    const html = readDeck();
    const of = Math.ceil(reviewSlides(html).length / REVIEW_BATCH);
    if (!of) return json(422, { ok: false, error: 'no slides to review' });
    const stop = new AbortController();
    reviewing = { of, done: 0, stop: () => stop.abort() };
    broadcast('review', { state: 'start', of, agent: cmd.name });
    console.log(`  review: ${of} batch${of === 1 ? '' : 'es'} ← ${cmd.name} (read-only)`);
    reviewDeck(html, {
      agent: name, cwd: dirname(deckPath), signal: stop.signal,
      onBatch: (r) => { reviewing.done = r.done; broadcast('review', { state: 'batch', ...r }); },
    }).then(({ findings, failed }) => {
      // Stopped: the last review's findings stand — part of a deck's review
      // would read as a deck with nothing to say about the rest.
      if (stop.signal.aborted) {
        reviewing = null;
        broadcast('review', { state: 'done', ok: false, stopped: true });
        console.log('  review: stopped');
        return;
      }
      lastReview = { at: Date.now(), agent: cmd.name, findings, failed };
      reviewing = null;
      broadcast('review', { state: 'done', ok: true, found: findings.length, failed });
      console.log(`  review: done — ${findings.length} finding${findings.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} batch${failed.length === 1 ? '' : 'es'} unanswered` : ''}`);
    }).catch((e) => {
      reviewing = null;
      broadcast('review', { state: 'done', ok: false, error: oneline(e) });
    });
    return json(200, { ok: true, of, agent: cmd.name, label: cmd.label });
  }

  // The last review's findings, against the deck as it is NOW: a slide that
  // moved keeps its findings, one that was edited (fixed) drops them. Each
  // carries the instruction `f` hands the A agent, built here because the
  // rules and their wording live on this side.
  async function reviewFindingsRoute({ json }) {
    if (!lastReview) return json(200, { ok: true, reviewed: false, running: !!reviewing, findings: [] });
    const { currentFindings, fixPrompt, REVIEW_RULES } = await import('./agent-review.mjs');
    const label = Object.fromEntries(REVIEW_RULES.map((r) => [r.id, r.label]));
    const findings = currentFindings(readDeck(), lastReview.findings)
      .map(({ fp, ...f }) => ({ ...f, label: label[f.rule], prompt: fixPrompt(f) }));
    return json(200, { ok: true, reviewed: true, running: !!reviewing, at: lastReview.at, agent: lastReview.agent, findings, failed: lastReview.failed });
  }

  // Stop the agent job in flight, whichever of the three it is: an A edit, a
  // script enhancement or a review. Answers at once; the job's own `done`
  // event, with `stopped`, is what says it has gone.
  function agentStopRoute({ json }) {
    const stop = agentStop ?? enhancing?.stop ?? reviewing?.stop;
    if (!stop) return json(409, { ok: false, error: 'no agent is running' });
    const what = agentStop ? `${agentJob?.agent ?? 'the agent'}'s edit` : enhancing ? 'the enhancement' : 'the review';
    console.log(`  agent: stopping ${what} …`);
    stop();
    return json(200, { ok: true, stopping: what });
  }

  /**
   * What an agent edit needs installed before it runs: Decklight's own skill,
   * which every edit's prompt sends the agent to, and `extra`, a migration's
   * skills. One the agent does not load yet, from the project or its config
   * home, is offered first, every project recommended. Asked only of a page
   * that can answer (`offer`); with no `place` the answer is the offer
   * (`{ choose: 'skill', skills, places }`), with one it is installed, or
   * with `none` not, and a no to Decklight's skill is remembered for this
   * project. Answers the offer, `{ error }`, or null to go ahead.
   */
  async function skillGate(agentName, { offer = false, place = null, extra = [], marketplace = null } = {}) {
    if (!offer && !place) return null;
    if (place !== null && !['global', 'project', 'none'].includes(place)) throw new Error('bad payload');
    const name = agentCommand(agentName || agentPref, '', deckRel)?.name;
    if (!name) return null;
    const S = await import('./skills.mjs');
    const missing = [
      ...(S.TARGETS[name] && !S.placedDecklightSkill(name, { dir: root }) && !S.skillOfferDeclined(name, { dir: root })
        ? [{ skill: 'decklight', ...S.decklightSkillPlaces(name, { dir: root }) }] : []),
      ...extra.filter((x) => !S.placedSkill(x, { dir: root })).map((x) => ({ skill: x, ...S.skillPlaces(x, { dir: root }) })),
    ];
    if (!missing.length) return null;
    if (!place) return { offer: { ok: true, choose: 'skill', agent: name, skills: missing.map((m) => m.skill), places: missing } };
    for (const { skill } of missing) {
      if (place === 'none') { if (skill === 'decklight') S.declineSkillOffer(name, { dir: root }); continue; }
      const global = place === 'global';
      try {
        const lines = skill === 'decklight'
          ? S.installDecklightSkill(name, { global, dir: root })
          : (await S.placeSkill(skill, { global, dir: root, ref: marketplace ? `${skill}@${marketplace}` : skill })).lines;
        for (const line of lines) console.log(`  skill: ${line}`);
      } catch (e) { return { error: `could not install the ${skill} skill: ${e.message}` }; }
    }
    return null;
  }

  /**
   * `review: true` (a Check deck… quick fix, #907) holds what the agent
   * writes for the review view instead of landing it: `rule` names the
   * finding, for the commit the review drafts.
   */
  async function agentRoute({ body, json }) {
    const { prompt, agent, message, slide, offer, place = null, review = false, rule = null } = JSON.parse(body);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
    if (reviewing) return json(409, { ok: false, error: 'the agent is reviewing the deck — wait for it to finish' });
    const gate = await skillGate(agent, { offer, place });
    if (gate?.offer) return json(200, gate.offer);
    if (gate?.error) return json(409, { ok: false, error: gate.error });
    const what = typeof message === 'string' && message.trim() ? message.trim() : commitSubject(prompt, 'fix');
    const hold = review ? {
      done: (after, { ok = true } = {}) => {
        if (after === null) return null;
        const h = fixReview.hold({ before: readDeck(), after, what, rule: typeof rule === 'string' ? rule : null, slide, agent: agentJob?.agent ?? null });
        if (!h.ok) console.log(`  fix: ${h.error}`);
        return h.ok ? { id: h.id, units: h.units.length, ok } : null;
      },
    } : null;
    const cmd = runAgent(prompt.trim(), agent, message, slide, hold ? { hold } : {});
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(agent ?? agentPref, agents) });
    return json(200, { ok: true, agent: cmd.name, label: cmd.label });
  }

  /**
   * `POST /deck/edit/design-system/migrate` `{ ref, agent?, offer?, place? }` (SPEC
   * DESIGN_SYSTEM_MIGRATIONS): Migrate, from the behind toast or the
   * marketplace update's what's new. A job the author watches in the agent
   * panel, not a silent rewrite. When the pending migrations name a skill
   * and an agent is installed, it is an ask like any other: the agent runs
   * `design-system migrate` for the declared renames, then the skill's
   * checks and judgement calls, and its report is what the panel shows.
   * Otherwise this server runs the migration itself and records it in the
   * same panel: the renames by kind, the count, the version, and the skill
   * named for what a rename cannot decide. Either way it is one undo step
   * over the deck and the stylesheets it links, committed on its own like
   * an agent edit, and the reload says what it was. A skill the agent does
   * not load yet is asked about first (`skillGate`): the answer is
   * `{ choose: 'skill', places }`, and the page posts again with `place`:
   * `global` (every project), `project`, or `none` (this run reads it where
   * it is).
   */
  async function designSystemMigrateRoute({ body, json }) {
    const { ref, agent, offer, place = null } = JSON.parse(body || '{}');
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('bad payload');
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
    if (reviewing) return json(409, { ok: false, error: 'the agent is reviewing the deck — wait for it to finish' });
    const { planMigration, migrationLines, linkedStylesheets, skillFile } = await import('./design-system-refs.mjs');
    // read once: the plan, the undo entry and the stylesheets are all of these bytes
    const before = readDeck();
    const plan = planMigration(before, dirname(deckPath), ref.trim());
    if (plan.error) return json(409, { ok: false, error: plan.error });
    if (!plan.changed) return json(200, { ok: true, nothing: true, said: `already on ${plan.ref} ${plan.version} — nothing to migrate` });
    const deckName = basename(deckPath);
    const reload = `migrated to ${plan.name} ${plan.version}`;
    const title = `migrate to ${plan.name} ${plan.version}`;
    const subject = `decklight: migrate ${deckName} to ${plan.name} ${plan.version}`;
    // every stylesheet it links from its folder, not only those the renames
    // touch: the skill's judgement calls may reach the others
    const sheets = linkedStylesheets(before, dirname(deckPath)).map((x) => x.path).filter((p) => p.startsWith(root + sep));
    const skills = plan.status.skills;
    if (skills.length && agentCommand(agent || agentPref, '', deckRel)) {
      // its skills and Decklight's, offered first when the agent has not
      // got them: installed on the author's word, never for one run behind
      // their back, which is what left a stray .claude/ (#893)
      const gate = await skillGate(agent, { offer, place, extra: skills, marketplace: plan.marketplace });
      if (gate?.offer) return json(200, gate.offer);
      if (gate?.error) return json(409, { ok: false, error: gate.error });
      const { placedSkill } = await import('./skills.mjs');
      // The skill where the agent loads it, else (the author said not now)
      // where it already is on this machine, the library's copy or the
      // marketplace's checkout. Only that last folder is handed to the agent
      // (`--add-dir`): one that reads only inside the project was refused the
      // file the prompt named, and one installed for it needs no extra reach.
      const placed = skills.map((s) => placedSkill(s, { dir: root })?.file ?? null);
      const found = skills.map((s, i) => placed[i] ?? skillFile(s, plan.marketplace));
      const where = skills.map((s, i) => (found[i]
        ? `read ${found[i]}`
        : `it is not on this machine (decklight library add skill ${s} --global puts it in your home, never in this project)`));
      const dirs = [...new Set(found.filter((f, i) => f && !placed[i]).map((f) => dirname(f)))];
      const prompt = `Migrate this deck from ${plan.name} ${plan.recorded ?? '(no version recorded)'} to ${plan.version} with the ${skills.join(' and ')} skill`
        + ` (${where.join('; ')}). First run \`decklight design-system migrate ${plan.ref} ${deckRel}\``
        + ' for the renames the design system declares; then do what the skill says a rename cannot: its checks (renders before and after),'
        + ' and its judgement calls (a name removed with no successor). Report the renames with their counts, each judgement call you made,'
        + ' and anything you left alone. Only the deck and its stylesheets change: leave no file you created (a copy, a render) in the project.';
      const cmd = runAgent(prompt, agent, subject, null, {
        files: sheets, reload, kind: 'migrate', title, subject, dirs,
        // the skill renders "before" first, but the prompt has the renames run
        // first: name the commit that holds the deck as it was
        before: (sha) => `The deck as it was before this migration is commit ${sha}: \`git show ${sha}:./${deckRel.split(sep).join('/')}\`.`,
      });
      if (cmd) return json(200, { ok: true, by: 'agent', agent: cmd.name, label: cmd.label });
    }

    // No agent to run the skill, or no skill to run: this server applies the
    // renames itself, and the panel records it as an entry like an ask.
    const ask = ownAsk({ kind: 'migrate', title, prompt: `decklight design-system migrate ${plan.ref} ${deckRel}` });
    if (gitOn && shouldCommit(gitMode, { kind: 'bookend' })
        && ownCommit(`decklight: save before migrating ${deckName}`, sheets)) {
      console.log('  git: committed your outstanding changes first');
    }
    const filesBefore = snapshotFiles(plan.sheets.map((x) => x.path));
    history.record(plan.sheets.length ? { deck: before, files: filesBefore } : before);
    for (const x of plan.sheets) writeFileAtomic(x.path, x.text);
    writeDeck(plan.html);
    noteWrite(reload, lastWrite?.from ?? null);
    if (gitOn && shouldCommit(gitMode, { kind: 'agent', ok: true, changed: true })
        && gitAutocommit(deckPath, root, subject, { also: [...alsoNow().also, ...sheets] })) {
      pendingAttr = null;
      console.log(`  git: committed "${subject}"`);
    }
    const { placedSkill } = await import('./skills.mjs');
    const tail = migrationLines(plan, deckRel, { placed: (s) => placedSkill(s, { dir: root }) }).join('\n');
    ownDone(ask, { changed: true, tail });
    console.log(`  design system: ${reload} — ${plan.renamed} rename${plan.renamed === 1 ? '' : 's'}`);
    return json(200, { ok: true, by: 'server', renamed: plan.renamed, version: plan.version, ask });
  }

  /**
   * `POST /deck/edit/check/fix` `{ rule, slide?, all?, ref?, agent? }`: the
   * quick fix Check deck… offers for one of `decklight check`'s findings
   * (PRESENTING_EDITING, cli/check-fixes.mjs), applied by this server and
   * recorded in the agent panel as an entry by *decklight*, beside the
   * agents' edits. One undo entry and one commit (`fix: <rule> on slide N`,
   * or `fix: <rule>` for the deck); `all` applies a batchable rule to every
   * slide as one of each. `ds-behind` is Migrate (above), which keeps its
   * own words. The judgement fixes never come here: the page hands those to
   * the A agent as an ordinary ask.
   */
  async function checkFixRoute({ body, json }) {
    const { rule, slide, all, ref, agent, review = false } = JSON.parse(body || '{}');
    if (typeof rule !== 'string' || !/^[a-z][a-z-]*$/.test(rule)) throw new Error('bad payload');
    if (slide != null && !(Number.isInteger(slide) && slide > 0)) throw new Error('bad payload');
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
    if (rule === 'ds-behind') {
      if (typeof ref !== 'string' || !ref.trim()) return json(400, { ok: false, error: 'which design system? — its reference' });
      return designSystemMigrateRoute({ body: JSON.stringify({ ref, agent }), json });
    }
    const { BATCH_RULES, fixSubject, offBrandTarget, renameRoles } = await import('./check-fixes.mjs');
    const { setDeckTheme } = await import('./runtime-link.mjs');
    const where = all && BATCH_RULES.includes(rule) ? null : slide ?? null;
    const subject = fixSubject(rule, where);
    const before = readDeck();
    /** The deck rewritten in one step, committed as the fix, and said in the panel. */
    const land = (next, { said, tail, prompt }) => {
      // reviewed first (#907): held, and nothing written until the author applies it
      if (review) {
        const h = fixReview.hold({ before, after: next, what: subject, rule, slide: where });
        if (!h.ok) return json(409, h);
        return json(200, { ok: true, changed: false, held: true, said, candidate: h });
      }
      const ask = ownAsk({ kind: 'fix', title: subject, prompt, slide: where ?? undefined });
      if (gitOn && shouldCommit(gitMode, { kind: 'bookend' }) && ownCommit(`decklight: save before fixing ${rule}`)) {
        console.log('  git: committed your outstanding changes first');
      }
      const changed = applyEdit(next, before);
      if (changed && gitOn && shouldCommit(gitMode, { kind: 'agent', ok: true, changed: true })
          && gitAutocommit(deckPath, root, subject, alsoNow())) {
        pendingAttr = null;
        console.log(`  git: committed "${subject}"`);
      }
      ownDone(ask, { changed, tail: changed ? tail : 'nothing to change — already fixed' });
      console.log(`  check: ${subject} — ${changed ? said : 'nothing to change'}`);
      return json(200, { ok: true, changed, said: changed ? said : 'nothing to change — already fixed', ask, ...history.counts() });
    };
    switch (rule) {
      case 'theme-off-brand': {
        const t = offBrandTarget(before);
        if (!t) return json(409, { ok: false, error: 'the deck is not off its brand — nothing to fix' });
        const next = setDeckTheme(before, t.to);
        if (next === null) return json(409, { ok: false, error: `this deck does not carry a theme the server can set to ${t.to}` });
        return land(next, {
          said: `theme ${t.from} → ${t.to}`, prompt: `set "theme": "${t.to}"`,
          tail: `${deckRel}: "theme": "${t.from}" → "${t.to}"${t.renamed ? ` (${t.from} was renamed)` : ' (the brand\'s first theme)'}`,
        });
      }
      case 'off-role': {
        if (!where && !all) return json(400, { ok: false, error: 'which slide? — or all: true for every slide' });
        const r = renameRoles(before, where);
        if (!r.count) return json(409, { ok: false, error: `no renamed role on ${where ? `slide ${where}` : 'any slide'} — nothing to fix` });
        const said = `${r.count} role${r.count === 1 ? '' : 's'} renamed on slide${r.slides.length === 1 ? '' : 's'} ${r.slides.join(', ')}`;
        return land(r.html, { said, prompt: where ? `rename the renamed roles on slide ${where}` : 'rename the renamed roles on every slide', tail: `${deckRel}: ${said}` });
      }
      case 'ds-unresolved': {
        const name = typeof ref === 'string' ? ref.trim() : '';
        if (!/^\w[\w-]*$/.test(name)) return json(400, { ok: false, error: 'which marketplace? — its registered name' });
        const ask = ownAsk({ kind: 'fix', title: subject, prompt: `decklight marketplace update ${name}` });
        const out = await runMarketplace(['update', name]);
        ownDone(ask, { ok: out.ok, changed: false, tail: out.ok ? out.said : `failed — ${out.error}` });
        if (!out.ok) return json(409, { ok: false, error: out.error, ask });
        console.log(`  check: ${subject} — updated ${name}`);
        // nothing in the deck changed: the page reloads to link what resolves now
        return json(200, { ok: true, changed: false, reload: true, said: out.said, ask });
      }
      case 'ds-unknown-system': {
        if (typeof ref !== 'string' || !ref.trim()) return json(400, { ok: false, error: 'which design system? — name@marketplace' });
        const ask = ownAsk({ kind: 'fix', title: subject, prompt: `decklight design-system add ${ref.trim()} ${deckRel}` });
        let answer = null;
        await routes.get('POST /deck/edit/design-system/mark')({
          body: JSON.stringify({ ref: ref.trim(), used: true }),
          json: (code, payload) => { answer = { code, payload }; },
        });
        const ok = answer?.code === 200 && answer.payload?.ok;
        if (ok && gitOn && shouldCommit(gitMode, { kind: 'agent', ok: true, changed: true }) && gitAutocommit(deckPath, root, subject, alsoNow())) {
          pendingAttr = null;
          console.log(`  git: committed "${subject}"`);
        }
        ownDone(ask, { ok: !!ok, changed: !!ok && !!answer.payload.changed, tail: ok ? `${deckRel}: now uses ${ref.trim()}` : `failed — ${answer?.payload?.error ?? 'no answer'}` });
        if (!ok) return json(answer?.code ?? 500, { ok: false, error: answer?.payload?.error ?? 'could not add the design system', ask });
        return json(200, { ok: true, changed: !!answer.payload.changed, said: `added ${ref.trim()}`, ask, ...history.counts() });
      }
      default:
        return json(400, { ok: false, error: `${rule} has no quick fix the server applies — ask the agent` });
    }
  }

  // ── the route table ──────────────────────────────────────────────────────
  // Every `/deck/edit/*` surface, keyed `METHOD /path`. This was forty-four
  // `if (req.method === … && url.pathname === …)` arms in one eleven-hundred
  // line function: adding a route meant finding a place in the chain, reading
  // a route meant scrolling to it, and the ORDER of two unrelated routes was
  // load-bearing by accident rather than by decision. A table has no order to
  // get wrong — adding a surface is adding a line — and the two places where
  // sequence DOES still matter say so out loud rather than by position
  // (`BEFORE_BODY`, and the prefix list below).
  const routes = new Map(Object.entries({
    'POST /deck/edit/lock': lockRoute,
    // the voice bridge, on this origin (#520): `/deck/tts` speaks, and everything
    // else of the bridge's lives under `/deck/tts/` (the prefix list below)
    'POST /deck/tts': ttsProxy,
    'POST /deck/edit/shutdown': shutdownRoute,
    'POST /deck/edit/undo': undoRedoRoute,
    'POST /deck/edit/redo': undoRedoRoute,

    // the owner's half of a review (REVIEW): registered here alone, beside
    // the routes both servers share
    'GET /deck/review/incoming': reviewIncomingRoute,
    'GET /deck/review/at': reviewAtRoute,

    'GET /deck/edit/wizard': wizardSchemaRoute,
    'POST /deck/edit/wizard': wizardConfigureRoute,
    'POST /deck/edit/wizard/forget': wizardForgetRoute,


    'POST /deck/edit/narration/record': recordRoute,
    'GET /deck/edit/narration/tracks': tracksRoute,
    'POST /deck/edit/narration/realign': realignRoute,

    'POST /deck/edit/agent': agentRoute,
    'POST /deck/edit/design-system/migrate': designSystemMigrateRoute,
    'POST /deck/edit/check/fix': checkFixRoute,
    'POST /deck/edit/agent/stop': agentStopRoute,
    'POST /deck/edit/agent/prefer': agentPreferRoute,
    'POST /deck/edit/agent/model': agentModelRoute,
    'POST /deck/edit/enhance': enhanceRoute,
    'POST /deck/edit/rewrite': rewriteRoute,
    'POST /deck/edit/review': reviewRoute,
    'GET /deck/edit/review': reviewFindingsRoute,
  }));

  // The slide mutations are a file of their own (cli/edit-slides.mjs): thirteen
  // routes of one shape — read the deck, run a pure transform over it, put the
  // result through applyEdit — that between them want four of editMain's
  // bindings and none of the rest. Handed those four explicitly, they can be
  // called from a test with a temp deck and no socket at all. `deckPath` is the
  // odd one: /deck/edit/asset saves a dropped image beside the deck, so it needs to
  // know where the deck is and not only what it says.
  registerSlideRoutes(routes, {
    readDeck, applyEdit, history, deckPath,
    // a notes save updates every page in place: no reload for that write
    quiet: (html) => { quietWrite = html; },
    broadcast: (event, data) => clients.broadcast(event, data),
  });

  // A quick fix reviewed before it lands (#907, cli/fix-review.mjs): the
  // candidate, its two sides as pages, and the apply that writes the slides
  // the author approved as one undo entry. An adjustment is the agent again,
  // held, working on the candidate rather than on the deck.
  fixReview = registerFixReviewRoutes(routes, {
    readDeck, applyEdit, broadcast,
    saveBefore: (what) => {
      if (gitOn && shouldCommit(gitMode, { kind: 'bookend' }) && ownCommit(`decklight: save before applying the reviewed ${what}`)) {
        console.log('  git: committed your outstanding changes first');
      }
    },
    adjust: async ({ candidate, unit, comment }) => {
      if (agentJob) return { ok: false, error: `${agentJob.agent} is already running` };
      if (reviewing) return { ok: false, error: 'the agent is reviewing the deck — wait for it to finish' };
      const cmd = runAgent(adjustPrompt(unit, comment, candidate.what), candidate.agent ?? undefined, null, unit.slide, {
        kind: 'fix', title: `adjust ${candidate.what} on slide ${unit.slide}`,
        hold: {
          start: candidate.after,
          done: (after) => { fixReview.adjusted(candidate.id, after, unit.key); return { id: candidate.id, adjusted: unit.key }; },
        },
      });
      if (!cmd) return { ok: false, code: 400, error: agentUnavailable(candidate.agent ?? agentPref, agents) };
      return { ok: true, agent: cmd.name };
    },
  });

  // The deck's look is a file of its own too (cli/edit-look.mjs): the theme
  // pick and the brand-themes switch, and browsing and marking what the
  // marketplaces offer a deck to wear — themes, design systems, fonts. They
  // want the deck's text and the two ways of writing it, the undo stack, the
  // event channel, and the quiet-write latch, and nothing else of editMain's.
  registerLookRoutes(routes, {
    readDeck, applyEdit, writeDeck, history, broadcast, deckPath,
    // a quiet pick or mark updates the page that asked: no reload for it
    quiet: (html) => { quietWrite = html; },
  });

  // Handing the deck over is a third (cli/edit-handover.mjs): export, the
  // bundle estimate, the inspector's read, and publish. None of them edits
  // the deck; they read it, write files beside it or push it, and own their
  // own in-flight flags.
  registerHandoverRoutes(routes, {
    readDeck, deckPath, root, broadcast,
    gitOn: () => gitOn,
    onExport: (job) => { exportJob = job; },
  });

  // And git (cli/edit-git.mjs): the commit window and the deck's history. The
  // commit bookkeeping stays here, because the timer, the agent's commits and
  // the exit commit share it; the routes reach it through what is handed in,
  // and the `let`s among it only through getters and setters.
  registerGitRoutes(routes, {
    readDeck, history, broadcast, deckPath, deckRel, root,
    gitOn: () => gitOn,
    agentPref: () => agentPref,
    subjectsOff, describer,
    commitState, measureDirty, resetEpisode, alsoNow, alsoRels, attrRel,
    pendingAttr: () => pendingAttr,
    clearPendingAttr: () => { pendingAttr = null; },
    dismissNag: () => { nagDismissed = true; },
  });

  // The routes that run BEFORE the shared body read, and the only reason the
  // dispatcher below has a sequence at all. `/deck/edit/narration/record`'s body is BINARY and
  // megabytes of it — a slide of speech is ~48 kB a second — so the string
  // concat and its 1 MB ceiling would both be wrong, and it reads the stream
  // itself under its own 64 MB limit. `/deck/edit/asset` is the same case with a
  // different payload — an image dropped on the stage, read under its own
  // 25 MB limit. The other three carry no body, and never had one read for them.
  const BEFORE_BODY = new Set([
    'POST /deck/tts',
    'POST /deck/edit/narration/record', 'POST /deck/edit/asset',
    'POST /deck/edit/shutdown', 'POST /deck/edit/undo', 'POST /deck/edit/redo',
  ]);

  // Prefix routes, tried IN ORDER once the exact table has missed and before
  // the static fallback — the one dispatch rule a Map cannot express. Every
  // `/deck/edit/*` path is exact today, so the list is empty; it is declared so the
  // first route that needs a prefix has somewhere to go other than the bottom
  // of the dispatcher, where the chain used to grow.
  const PREFIX_ROUTES = [   // { method, prefix, handler }
    // the voice bridge's own routes, on this origin: /tts/ping, /tts/engines,
    // /tts/voices… — forwarded as they are, since the bridge serves the same
    // paths itself. Nothing of the bridge's sits at the root, where it would
    // shadow a file beside the deck (`voices/` is the narration's folder).
    { method: 'GET', prefix: '/deck/tts/', handler: ttsProxy, beforeBody: true },
    { method: 'POST', prefix: '/deck/tts/', handler: ttsProxy, beforeBody: true },
    // the lip-sync bridge, on this origin (#520): `/deck/lipsync/ping`, `/viseme`, `/video`
    // the audio a POST carries is binary and can pass the body cap, so it
    // streams through unread, like /deck/edit/narration/record's
    { method: 'GET', prefix: '/deck/lipsync/', handler: lipsyncProxy, beforeBody: true },
    { method: 'POST', prefix: '/deck/lipsync/', handler: lipsyncProxy, beforeBody: true },
  ];

  // the deck's channel and the shared review routes, beside this server's own
  for (const [key, handler] of deck.routes) routes.set(key, handler);
  for (const key of ['GET /deck/review/comments', 'POST /deck/review/comments', 'POST /deck/review/submit']) {
    routes.set(key, ({ req, res, url, body }) => review.handle(req, res, url, body ?? ''));
  }
  // The upstream routes are REGISTERED ONLY when the deck is a tracked file in
  // a clone whose branch tracks something (NO_TRUST#UPSTREAM): on a deck you
  // were emailed they are not refused, they do not exist. The strict origin
  // gate, not allowEditRequest: `null` is a sandboxed plugin frame's origin,
  // and presenter chrome must not be able to fast-forward the presenter's
  // repository.
  if (upstream) {
    routes.set('GET /deck/upstream', ({ json }) => json(200, { ok: true, ...upstreamStatus, pull: pullOffer() }));
    routes.set('POST /deck/upstream/check', ({ req, res, json }) => {
      if (!isOwnOrigin(req, actualPort)) { res.writeHead(403); res.end('forbidden'); return; }
      return refreshUpstream().then(() => json(200, { ok: true, ...upstreamStatus, pull: pullOffer() }));
    });
  }
  if (pullArmed) {
    routes.set('POST /deck/upstream/pull', ({ req, res, json }) => {
      if (!isOwnOrigin(req, actualPort)) { res.writeHead(403); res.end('forbidden'); return; }
      // The body is never read. No field of the request reaches git or the
      // filesystem; the repository, the branch and `@{upstream}` are all
      // constants resolved before the server existed.
      return doPull().then((out) => json(out.ok ? 200 : (out.http ?? 409), out));
    });
  }

  // What no-trust mode refuses, by name: everything that writes the deck or
  // reaches a bridge, and the review owner's half. A deck opened without trust used to be
  // served by a process in which none of this was registered; now it is one
  // server, and the refusal is the mode's — a 403 that says which mode would
  // answer, rather than a 405 that pretends the route is unknown.
  const WRITE_FAMILY = (pathname) => pathname.startsWith('/deck/edit/')
    || pathname === '/deck/tts' || pathname.startsWith('/deck/tts/') || pathname.startsWith('/deck/lipsync/')
    || pathname === '/deck/review/incoming' || pathname === '/deck/review/at';

  // What a locked deck still answers: the lock, and the stops.
  const UNLOCKED_POSTS = new Set(['/deck/edit/lock', '/deck/edit/export/stop', '/deck/edit/agent/stop']);

  // Two static servers for one root, chosen per request by the mode. Write
  // mode serves the cwd with the deck at "/" and an author's exotic asset as
  // octet-stream. No-trust mode refuses every extension the MIME table does
  // not name (a file beside a travelled deck that is none of them — `id_rsa`,
  // a `.pem`, a database — is only ever fetched to be exfiltrated), rewrites
  // every html page on its way out (strict, then the chrome), and has no
  // index: "/" is the deck, answered from memory before this is consulted.
  // write mode: the deck gets the presenter's chrome too, every other page none
  const files = staticFiles(root, { index: deckUrl, html: (text, file) => (file === deckPath ? injectChrome(text, chrome.plugins) : text) });
  const auditedFiles = staticFiles(root, { html: rewrite, knownTypesOnly: true });
  const server = createServer(async (req, res) => {
    // No-trust mode: the policy on EVERY response this server writes — the
    // deck and its assets, but also the 403/404/405 pages, the control-
    // channel JSON and SSE, and the remote controller. Set before anything
    // runs, and writeHead merges it under whatever a route names itself, so
    // "every response carries the header" holds by construction.
    if (noTrust) res.setHeader('content-security-policy', CSP);
    // Loopback always; off-loopback only /deck/remote/* carrying the per-run
    // token, and only when --remote asked for a listener at all. Every other
    // path is refused off this machine unconditionally — flag or no flag,
    // token or no token — which is why the static files and the deck itself
    // cannot be reached from the LAN even while the remote can.
    if (!allowRemote(req, token)) {
      res.writeHead(403);
      res.end('forbidden: this deck is served to this machine only; off it, only /deck/remote/* answers, with the session token');
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end('bad request'); return; }
    // The phone remote, before the CSRF gate below: the phone's origin is a
    // LAN address, which that gate rightly refuses for everything else. A
    // body past 4 KB is a probe, not a request — the socket is destroyed and
    // the E2BIG never becomes a response.
    if (url.pathname === '/deck/remote' || url.pathname.startsWith('/deck/remote/')) {
      let body = '';
      if (req.method === 'POST') {
        try { body = (await readBody(req, { max: 4096 })).toString(); } catch { return; }
      }
      try {
        if (relay.handle(req, res, url, body)) return;
      } catch {
        res.writeHead(400, { ...PHONE_CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad payload' }));
        return;
      }
      res.writeHead(405); res.end('method not allowed');
      return;
    }
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
      res.end('forbidden: the deck server answers this machine only, and not a foreign web origin');
      return;
    }
    try {
      const json = (code, obj, headers = {}) => {
        res.writeHead(code, { ...CORS, ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      // no-trust mode: nothing that writes answers, whatever it was aimed at
      if (noTrust && WRITE_FAMILY(url.pathname)) {
        return json(403, { ok: false, noTrust: true, error: 'this deck is open without trust — nothing here changes it' });
      }
      // locked: no edit route writes, whatever it was aimed at — the POSTs
      // that still answer are the lock itself, so it can be lifted, and the
      // stops, which write nothing and end a job started before the lock
      if (locked && req.method === 'POST' && url.pathname.startsWith('/deck/edit/') && !UNLOCKED_POSTS.has(url.pathname)) {
        return json(423, { ok: false, locked: true, error: 'the deck is locked — unlock it from the palette or the lock chip' });
      }
      // an agent is working on a fix held for review: the file is its until it
      // is put back, and a write made now would be undone by that (#907)
      if (holding && req.method === 'POST' && url.pathname.startsWith('/deck/edit/') && !UNLOCKED_POSTS.has(url.pathname)
          && url.pathname !== '/deck/edit/candidate/discard') {
        return json(409, { ok: false, error: 'a fix is being prepared for review — wait for it, or stop the agent' });
      }
      const key = `${req.method} ${url.pathname}`;
      const prefixed = routes.has(key) ? null
        : PREFIX_ROUTES.find((r) => r.method === req.method && url.pathname.startsWith(r.prefix));
      const handler = routes.get(key) ?? prefixed?.handler;
      if (handler && (BEFORE_BODY.has(key) || prefixed?.beforeBody)) {
        return await writing.run({ route: url.pathname, body: '' }, () => handler({ req, res, url, json, CORS }));
      }
      // Read for every POST, matched or not — an oversized body is refused
      // whatever it was aimed at, exactly as the chain refused it.
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
      }
      if (handler) return await writing.run({ route: url.pathname, body }, () => handler({ req, res, url, body, json, CORS }));
      // ── the deck and the files beside it ──────────────────────────────
      // No-trust mode answers the deck's own path from the audited bytes
      // (servePayload above). For a container that also means the URL a
      // person sees is the file they double-clicked — serving the raw archive
      // bytes there would hand a browser something it cannot render.
      if (noTrust) {
        if (isDeck(url)) {
          if (servePayload(req, res)) return;
          res.writeHead(405); res.end('method not allowed'); return;
        }
        if (auditedFiles(req, res, url)) return;
        res.writeHead(405); res.end('method not allowed'); return;
      }
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
  actualPort = actual;
  // `decklight narrate --mic` runs this same server in-process and needs to know
  // WHICH port it ended up on (a taken --port moves to the next free one) and
  // to print its own banner instead of the authoring one.
  if (onListen) onListen({ port: actual, deckUrl, server });
  else if (noTrust) {
    // Before the first slide renders, not after — the point of the label is
    // to be able to decide not to open it. The audience is looking at the
    // deck; none of this goes on the page.
    console.log(`decklight · ${basename(deckPath)} on http://127.0.0.1:${actual}${deckUrl} — no trust: its code stripped, CSP enforced. Ctrl-C stops`);
    console.log(`  serving ${root} — ${rootArg ? '--root as given' : "the deck's own directory"};`
      + ' dotfiles and non-deck file types refused; every edit route refuses, nothing is written');
    printLabel();
    if (upstream) {
      console.log(`  upstream: tracking ${upstream.upstream} — ${intervalMs ? `checking every ${intervalMs / 60000} min` : 'checked when asked'}`
        + (pullArmed ? ', update control ON (--upstream-pull)' : ''));
      if (!pullArmed && args.includes('--upstream-pull') && token) {
        console.log('  upstream: --remote is on — the update control is off; pull from your own terminal');
      }
    } else if (suppressed && suppressed !== 'write mode') {
      console.log(`  upstream: not checked — ${suppressed}`);
    }
    // Reported UNDER the label and never inside it: a plugin is not in the
    // file. Naming which plugins read the speaker notes is the other half of
    // `needs: ["notes"]` being a declaration rather than a silent grant.
    for (const pl of chrome.plugins) {
      console.log(`  chrome: ${pl.name} (${pl.slot}) — yours, not in the deck`
        + `${pl.needs.includes('notes') ? '; reads your speaker notes' : ''}`);
    }
    for (const r of chrome.refused) {
      console.log(`  chrome: ${r.name} REFUSED — not loaded, the deck plays without it`);
      console.log(`    ${r.reason.replace(/\n/g, '\n    ')}`);
    }
    if (audited.strict) {
      const n = audited.report.counts.unaccounted, h = audited.report.counts.handlers;
      if (signature.state !== UNSIGNED && !isVerified(signature)) console.log('  the signature did not verify — serving strict');
      const removed = [
        n ? `${n} unaccounted script block${n === 1 ? '' : 's'}` : '',
        h ? `${h} executable attribute${h === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' and ');
      console.log(removed
        ? `  ${removed} stripped — serving strict. The file on disk is untouched`
        : `  nothing to strip — this deck is served exactly as ${container ? 'the container carries it' : 'it was read from disk'}`);
    }
  } else if (process.env.DECKLIGHT_BANNER) {
    // The port is reported rather than assumed: `listenTakingOverIfNeeded` can
    // land somewhere other than the port `open` resolved, and the URL on the
    // banner has to be the one that actually answers.
    console.log(readyLine({
      url: `http://127.0.0.1:${actual}${deckUrl}`,
      keys: 'Ctrl-C stops',
    }));
  } else console.log(`decklight · ${basename(deckPath)} on http://127.0.0.1:${actual}${deckUrl} — editing on, L layouts, Z undo, A agent. Ctrl-C stops`);
  if (token) {
    console.log(`  remote: listening on ${host} — http://${lanAddress() ?? host}:${actual}/deck/remote?t=${token}`);
    console.log('  off this machine ONLY /deck/remote/* answers, with that token — the deck itself does not');
  }
  // The upstream, said once at startup and then only when it CHANGES. `up to
  // date` every ten minutes for an hour is noise that trains people to stop
  // reading the terminal — which is where the ingredients label lives. Kicked
  // AFTER the last startup line and never awaited: nothing about it can delay
  // the server coming up or hang a talk on a remote that is down.
  if (upstream) {
    const tick = () => refreshUpstream().then((st) => {
      if (st.state !== lastReported) {
        lastReported = st.state;
        console.log(`  upstream: ${st.message}`);
      }
    }).catch(() => {});
    tick();
    // unref'd so a Ctrl-C exits now rather than after an in-flight fetch.
    // `--upstream-every 0` keeps the manual check and drops only the timer.
    if (intervalMs > 0) setInterval(tick, intervalMs).unref();
  }

  // Did somebody review this deck? Asked ONCE, after the last startup line,
  // detached and never awaited — the update-check shape: nothing about it can
  // delay the server coming up or hang authoring on a remote that is down. It
  // is a fetch the author did not type, which is why it is the sanctioned
  // exception cli/git.mjs names, why it is never on a timer, and why it is
  // nowhere near the SIGINT path (finalCommit above says what lives there and
  // why nothing else may).
  if (!onListen && !noTrust) {
    const skipped = reviewCheckSuppressed({ args });
    if (skipped) {
      startup('reviews', `not checked — ${skipped}`, `  reviews: not checked — ${skipped}`);
    } else {
      reviewsWaiting(deckPath)
        .then((r) => {
          const line = reviewLine(r, { deck: relative(process.cwd(), deckPath) || basename(deckPath) });
          if (line) startup('reviews', line.replace(/^reviews:\s*/, ''), `  ${line}`);
        })
        .catch(() => {});
    }
    // Are the marketplaces behind their sources? Only when the author turned
    // the auto-check on (SPEC MARKETPLACES_SCREEN), at most once in its
    // window, and the same detached shape: the deck is told when the answer
    // lands and offers it; a source that does not answer is said on the
    // screen, never here.
    autoCheckInBackground({ broadcast }).then((rec) => {
      const behind = rec?.marketplaces.filter((r) => r.state === 'behind') ?? [];
      if (behind.length) startup('marketplaces', `${behind.map((r) => r.name).join(', ')} out of date`, `  marketplaces: ${behind.map((r) => r.name).join(', ')} out of date — / → Marketplaces… updates ${behind.length === 1 ? 'it' : 'them'}`);
    });
  }
  return { port: actual, deckUrl, host, server };
}


if (isMain(import.meta.url)) {
  // `open` spawns this module directly, so the leash the dispatcher used to
  // arm is armed here — a no-op unless a supervising parent set it up.
  exitWhenOrphaned();
  // Through the one error boundary: a throw used to surface as an unhandled
  // rejection with a raw stack, in a child whose parent's banner had scrolled by.
  const code = await runMain('open', () => editMain(process.argv.slice(2)));
  // editMain sets process.exitCode itself on a refusal and resolves to the
  // server otherwise, so only a failure runMain reported is written here
  if (code === 1) process.exitCode = 1;
}
