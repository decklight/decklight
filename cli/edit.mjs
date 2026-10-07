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
// `decklight <deck.html> --read-only --remote` hosts it now, with no edit surface to widen
// (READ_ONLY#REMOTE). Both flags are refused out loud rather than ignored.
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
//   GET  /deck/edit/template/browse   → deck templates installed here, and what a marketplace offers
//   GET  /deck/edit/template/slides → ?name=   that template's slides, numbered, with what each needs
//   POST /deck/edit/template/add    → { ref }  install a template from a marketplace (UNITS#REST)
//   POST /deck/edit/template/insert → { name, slides, after }  its slides into THIS deck, one undo entry
//   POST /deck/edit/export          → { kind }   write the deck out as a file (the palette's hand-over rows)
//   GET  /deck/edit/publish/plan    → where publishing would put this deck, without putting it there
//   POST /deck/edit/publish         → bundle the deck and push it (the palette's Publish row)
//   GET  /deck/edit/export/estimate → ?kind=bundle&theme=  how big that file would be, before it is written
//   GET  /deck/edit/element/source  → ?slide=&index=            an element's outerHTML, fresh from the file
//   POST /deck/edit/element/remove  → { slide, index }          delete that element
//   POST /deck/edit/element/content → { slide, index, html }    replace its outerHTML
//   POST /deck/edit/element/effect  → { slide, index, effect }  write data-build (null strips it)
//   POST /deck/edit/undo            → step the deck file back through the edit history
//   POST /deck/edit/redo            → step it forward again
//   POST /deck/edit/agent           → { prompt, agent?, slide? } one-shot AI agent edit
//   POST /deck/edit/enhance         → { slides: [n…]|'all', agent?, kind? } audio tags ('tags') or written for the ear ('spoken')
//   POST /deck/edit/enhance/text    → { text, agent?, kind? } → { text }   the same, for the notes editor's box (writes nothing)
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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, watch, existsSync } from 'node:fs';
// Every write of the DECK goes through this rather than writeFileSync: the
// edit server rewrites the whole file on every small edit, and a truncate
// that is interrupted leaves a prefix of a talk where the talk was.
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { resolve, relative, dirname, sep, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_FORMATS, VIDEO_QUALITIES, VIDEO_SUBTITLES, valuesOf } from '../tools/video-options.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { agentAsk, agentCommand, detectAgents, agentUnavailable, preferredAgent, setPreferredAgent, claudeActivity } from './agents.mjs';
import { exitWhenOrphaned } from './supervise.mjs';
import { readyLine } from './banner.mjs';

/**
 * Say a startup fact.
 *
 * Under `open` (DECKLIGHT_BANNER) it becomes a row on the one banner author
 * prints, so it cannot land above the URL. Run standalone — `decklight edit` —
 * it prints the line it always printed, which is why every call passes both:
 * the SHORT text a banner row wants, and the full sentence a bare terminal
 * needs because it has no banner to sit under.
 */
const startup = (key, text, human) => {
  if (process.env.DECKLIGHT_BANNER) console.log(readyLine({ key, text }));
  else console.log(human);
};
import { argReader, firstPositional, isMain, parsePort, badPort } from '../tools/args.mjs';
import { runMain, CommandError } from './util.mjs';

// The flags that take a value, so the deck can be found past them. `--git-mode`
// was missing, so `edit.mjs --git-mode agent deck.html` refused a deck called
// "agent". (`decklight <deck>` builds this argv itself and was never affected.)
const VALUE_FLAGS = ['--port', '--commit-every', '--agent', '--git-mode', '--tts-port', '--lipsync-port',
  '--host', '--root', '--branch', '--into', '--upstream-every'];
import { NOTES_ASIDE, locateSlide, sectionChildRanges, elementChildRanges, splitOpenTag } from '../tools/deck-html.mjs';
import { canonMarks, writtenMarks, CLICK_MARK } from '../tools/sentences.mjs';
import { configBlock, configTheme, hasEmbeddedRuntime, linkRuntime } from './runtime-link.mjs';
import { linkAddedThemes } from './theme-refs.mjs';
import { linkDesignSystems } from './design-system-refs.mjs';
import { linkFonts } from './font-refs.mjs';
import { slideTexts, priorSlideTexts, staleSlides } from '../tools/narration-manifest.mjs';
// The routes that rewrite a slide, which took three of editMain's bindings and
// nothing else with them. The import back — edit-slides reaches here for the
// pure transforms — is a deliberate static cycle and not a dynamic one: this
// module ends in a top-level `await` (the isMain boot below), so a
// `await import('./edit-slides.mjs')` from inside editMain would wait on an
// evaluation that is waiting on IT, and the server would never come up.
// A static cycle has no such moment: both bodies are function declarations,
// hoisted before either runs, and nothing is read until a request arrives.
import { registerSlideRoutes } from './edit-slides.mjs';
// the boot-call locator audit and upgrade share — three commands, one answer
// about which <script> is the init call
import { classifyScripts, auditDeck, formatLabel, stripUnaccounted } from './audit.mjs';
// The read-only mode's own ingredients (PRESENTING): the signature beside a
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
// The arbiters of what a comment IS, shared with the read-only server so two
// writers cannot put two shapes into one union-merged file.
import { commentProblem, reviewRecord } from './review-routes.mjs';
import { foldReview } from '../tools/review-anchor.mjs';
import { recordingImpact, impactWarning, slidesFromFiles } from '../tools/recording-impact.mjs';
import { indexDeckFile, slideTextOf, knowsCommit } from './comments.mjs';
import { deckHistory, decorateHistory, restoreDeck, deckAt, withBaseHref } from './restore.mjs';
import { escapeHtml, staticFiles, listenTakingOverIfNeeded, allowEditRequest, allowRemote, lanAddress, isOwnOrigin, CSP } from './serve.mjs';
import { reviewsWaiting, reviewLine, reviewCheckSuppressed, setCommentDone } from './review-remote.mjs';
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
// (READ_ONLY_SERVER in MARKETPLACE.md: `decklight <deck> --read-only` reuses the same core
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
 *   `subtitles` its `--format`, `--quality` and `--subtitles`.
 * - The voice is ONE of three: `narration` names a recorded folder (inside the
 *   deck's directory, holding a manifest — a render that cannot find its audio
 *   should refuse, not come out silent); `synthesize` asks for the live voice
 *   to be voiced into a folder first; `silent` is silence by name. None of them
 *   is the command's own default: a `voiceover/` beside the deck if there is one.
 * - A synthesized voice never lands on a take somebody recorded. A folder that
 *   already holds audio is refreshed only when its manifest says it was this
 *   engine and this voice; anything else — a manifest for another voice, or
 *   audio with no manifest at all, which is what your own voice leaves — refuses.
 */
export function videoExportProblem({ slides, narration, synthesize, silent, format, quality, subtitles, allowStale } = {}, deckDir) {
  if (allowStale != null && typeof allowStale !== 'boolean') return 'allowStale is yes or no';
  // the card's rows and the command's flags read one list (src/core/video-options.js)
  for (const [field, value, list] of [['format', format, VIDEO_FORMATS], ['quality', quality, VIDEO_QUALITIES], ['subtitles', subtitles, VIDEO_SUBTITLES]]) {
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
  if (!existsSync(resolve(deckDir, narration, 'manifest.json'))) {
    return `no recorded narration in ${narration}/ — record the deck first (V → Record this deck…)`;
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
 * The colours a page may ask this server to write (PRESENTING, element edit
 * mode): a theme token by reference — `var(--d-fill-3)`, so the deck stays
 * theme-aware — a design system's token with ONE hex fallback,
 * `var(--acme-blue, #0056f9)` (SPEC DESIGN_SYSTEMS: the colour survives the
 * design system going missing), or a literal hex colour. Nothing else — no
 * nested var(), no other characters: the value lands inside a style
 * attribute, and a style attribute is markup.
 */
const STYLE_VALUE = /^(?:var\(--[a-z][a-z0-9-]{0,40}(?:,\s?#[0-9a-f]{3,8})?\)|#[0-9a-f]{3,8})$/i;
const STYLE_PROPS = new Set(['fill', 'color', 'background-color']);

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
    if (!STYLE_PROPS.has(e.prop)) throw new Error(`not a colour property: ${e.prop}`);
    if (e.value !== null && (typeof e.value !== 'string' || !STYLE_VALUE.test(e.value))) throw new Error(`not a colour this server writes: ${String(e.value).slice(0, 40)}`);
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
      list = kept.dir === track.dir ? [] : [kept];
    } else list = [];
    const same = list.findIndex((e) => (typeof e === 'string' ? e : e?.dir) === track.dir);
    if (same >= 0) list[same] = entry; else list.push(entry);
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
    if (same) return splice(fvalStart + same.from, fvalStart + same.to, one);
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
  const list = kept.dir === track.dir ? [one] : [narrationLiteral(kept), one];
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
import { inGitRepo, gitAvailable, createRepo, STARTER_GITIGNORE, gitAutocommit, lastCommitSha, resolveGitMode, shouldCommit, commitSubject, exitPushLine, oneline, remoteLine, remoteState, unpushed } from './git.mjs';
import {
  describeCommit, describeWorking, messagesLine,
} from './commit-message.mjs';
import { WIP_REF, deckDirty, nagText, planNag, snapshotWip, wipLine } from './commit-flow.mjs';
import { THEME_NAME, GEN_THEME } from '../tools/render-theme.mjs';
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


/** `decklight <deck> --read-only --help`: the read-only mode's own flags. */
const READ_ONLY_USAGE = `usage: decklight <deck.html|deck.decklight|repository url> --read-only [--port 8788] [--strict]
                        [--root <dir>] [--remote] [--host <addr>] [--check]
                        [--no-plugins] [--branch <ref>] [--into <dir>]

  opens a deck in read-only mode — the safe way in for one you did not write,
  and the only mode a .decklight container opens in. The deck is served from
  its own directory, under a Content-Security-Policy header, with every file
  type a deck cannot use and every dotfile refused; every route that writes
  refuses, and nothing is written. The palette's "Write mode" row leaves this
  mode for your own decks; a container never does.

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
  --check    print the ingredients label and exit — no server. Exits non-zero
             if the deck runs any script that is not the runtime — a block or
             an executable attribute — so CI can gate on a deck before it is
             forwarded or published.
  --no-plugins  play without your own chrome, whatever is installed.
  --upstream-every N  minutes between upstream checks; 0 turns the check off  [10]
  --no-upstream     never look at the upstream — no git, no network
  --upstream-pull   register the update control the deck's H overlay drives.
                    OFF by default: with it on, any script in the deck can
                    fast-forward the clone the deck was served from.

  Your presenter plugins (decklight plugin) are layered on at serve time from
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

  Every read-only start prints the ingredients label: which runtime is
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
// signature states of `--read-only --check` without the network; `undefined`
// means "go load the real one".
export async function editMain(args, { onListen = null, client } = {}) {
  // /deck/review/incoming's answer, briefly remembered (see the route).
  let incomingCache = null;
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (wantsHelp && args.includes('--read-only')) { console.log(READ_ONLY_USAGE); return 0; }
  if (wantsHelp || !args.filter((a) => !a.startsWith('-')).length) {
    console.log(`usage: node cli/edit.mjs <deck.html> [--read-only] [--port 8788] [--git | --no-git]
                      [--commit-every <seconds>] [--agent <name>] [--commit-messages]
  serves the cwd, live-reloads the deck on change, and accepts edits from the
  player: notes (right-click a slide's background), per-slide layout (L/⇧L),
  element edit mode (E, then right-click an element), undo/redo (Z/⇧Z), agent asks (A)
  a taken --port offers to take over that session (on a TTY) or moves on to
  the next free one
  --read-only      the same server in read-only mode: the deck is served from
                   its own directory under a CSP header, the ingredients label
                   runs first, and every edit route refuses
                   (--read-only --help for that mode's flags)
  --remote         also listen on the LAN for the phone remote (either mode)
  --git            keep the deck in git (creates the repo if needed): a silent
                   snapshot on refs/decklight/wip, and K commits when you say so
  --no-git         never touch git (default outside a repository)
  --commit-every N cadence in seconds, timer mode only                    [300]
  --git-mode M     agent  one commit per agent edit, plus whatever K commits
                   timer  the old five-minute cadence, bookends included
                   off    never commit                                  [agent]
  --agent <name>   preferred AI agent for A (default: first one detected)
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
  const port = parsePort(opt('--port', 8788));
  if (port === null) { console.error(`decklight: ${badPort('--port', opt('--port'))}`); process.exitCode = 1; return; }
  const fail = (msg) => { console.error(`decklight: ${msg}`); process.exitCode = 1; return 1; };

  // ── the mode (PRESENTING) ─────────────────────────────────────────────────
  // One server, two modes. Write mode is the default: the deck is served from
  // disk, live-reloaded, and every /deck/edit/* route writes it. Read-only
  // mode (`--read-only`, and always for a .decklight container) serves the
  // bytes the ingredients label described, under the CSP, with the
  // presenter's chrome layered on, and refuses every route that writes —
  // /deck/edit/*, the bridges, the review owner's half — by name. The mode is
  // a `let` because the session can change it (PRESENTING: the palette's
  // read-only / write mode row); what cannot change is the root, decided
  // below from the way the deck was opened.
  const deckArg = firstPositional(args, VALUE_FLAGS);
  const deckPath = resolve(process.cwd(), deckArg);
  if (!existsSync(deckPath)) return fail(`deck not found: ${deckPath}`);
  // A .decklight is the same deck with its signature and manifest stapled on
  // (DECK_FILE), unwrapped here and treated exactly like the HTML it wraps —
  // same audit, same CSP, same strict rule. Nothing is written to unwrap it:
  // the payload is a slice of the bytes already read. It never leaves
  // read-only mode: there is no file to edit in place.
  let container = null;
  if (isContainer(deckPath)) {
    try { container = readContainer(deckPath); } catch (e) { return fail(e.message); }
  }
  let readOnly = args.includes('--read-only') || !!container;

  // --remote widens the LISTENER and nothing else (READ_ONLY#REMOTE), in either
  // mode: off this machine only /deck/remote/* answers, with the per-run
  // token, and the deck itself and every file beside it stay unreachable from
  // the LAN whether or not the flag is passed. allowRemote is the classifier.
  const remote = args.includes('--remote') || opt('--host') !== undefined;
  const host = remote ? opt('--host', '0.0.0.0') : '127.0.0.1';
  const token = remote ? randomBytes(16).toString('base64url') : null;

  // The served root. In write mode it is the cwd, as it always was: a source
  // deck reaches up for its runtime (`demo/talk.html` loading
  // `../dist/decklight.js`) and the author chose where to stand. In read-only
  // mode it is the deck's OWN directory, never the cwd: everything under the
  // root is fetchable by the deck's own script same-origin, and with
  // `connect-src https:` open, fetchable means exfiltratable — a root
  // inherited from wherever the command happened to run (a project checkout,
  // $HOME via file association) would hand a hostile deck whatever lived
  // there. `--root` widens it, by a flag you typed and printed at startup.
  // Decided ONCE, from the mode the deck was opened in: a session that
  // changes mode keeps its root, because the deck's URL is relative to it.
  const rootArg = opt('--root');
  const root = readOnly
    ? (rootArg ? resolve(process.cwd(), rootArg) : dirname(deckPath))
    : process.cwd();
  if (!deckPath.startsWith(root + sep)) {
    return fail(readOnly ? 'deck must live under --root' : 'deck must live under the current directory');
  }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');
  const deckRel = deckUrl.slice(1);

  // ── the read-only mode's ingredients (PRESENTING) ─────────────────────────
  // The audit runs because it is the way in: a standalone `verify` is a step
  // people skip, so folding it into the command you already use means it runs
  // every time, at no extra effort. It reads the bytes, names what will
  // execute, and decides strict — the startup block, reusable, because a
  // pull (READ_ONLY#UPSTREAM) and a later change of mode re-run it: never new
  // bytes under an old verdict.
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
  // MUTABLE: a pull may replace all of it, and so may a change of mode. The
  // bytes, the label and `strict` move together or not at all. Empty until
  // read-only mode is entered, which is the only mode that reads it.
  let audited = null;
  let signature = { state: UNSIGNED };
  /** Enter (or re-enter) read-only mode: read, audit, decide strict. Says whether the deck itself changed. */
  const audit = () => {
    const before = audited?.payload ?? null;
    const next = readAndAudit();
    const unverified = signature.state !== UNSIGNED && !isVerified(signature);
    // STRICT RATCHETS within a session: a pull may turn it on and can never
    // turn it off. A deck that could clear its own strict flag by pulling
    // could disarm the one mitigation read-only mode applies unasked.
    audited = { ...next, strict: next.strict || unverified || (audited?.strict ?? false) };
    return before === null || !next.payload.equals(before);
  };
  if (readOnly) {
    signature = await verifySignature();
    audit();
  }

  if (args.includes('--check')) {
    // No server. The label, the manifest, the signature — and an exit code CI
    // can gate on: non-zero means "this deck executes something I could not
    // account for", or "it carries a signature I could not stand behind" —
    // not "this deck is malicious", which is a call no exit code should make.
    // `unchecked` counts: a gate that passes when it could not evaluate the
    // claim is not a gate.
    if (!readOnly) { signature = await verifySignature(); audit(); }
    for (const line of formatLabel(audited.report, { indent: '' })) console.log(line);
    if (container) console.log(formatManifest(container.manifest, { indent: '' }));
    if (signature.state !== UNSIGNED) console.log(formatSignature(signature, { indent: '' }));
    return audited.report.counts.unaccounted || audited.report.counts.handlers
      || (signature.state !== UNSIGNED && !isVerified(signature)) ? 1 : 0;
  }

  // The presenter's own chrome (READ_ONLY#PLUGINS) — a timer, a teleprompter,
  // a confidence monitor. It is loaded from ~/.decklight/plugins/, which is
  // the presenter's library and not the deck's: the installer is the
  // risk-bearer and nothing here travels. Loaded after `auditDeck` has read
  // the bytes, so a plugin is never counted as an unaccounted script block in
  // the label (the label describes the file; a plugin is not in the file),
  // and injected after `stripUnaccounted`, so strict never strips the chrome
  // as if the deck had smuggled it in. Read-only mode only: an author's own
  // deck gets no chrome layered over the slides they are editing.
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
  const serveAudited = (text) => linkFonts(linkDesignSystems(linkAddedThemes(linkRuntime(rewrite(text, deckPath)))));
  // The deck itself, in read-only mode, is served from MEMORY — container and
  // plain HTML alike — from the bytes the audit read and the signature
  // covered. The label, the signature verdict and `strict` were all decided
  // against those bytes and printed as a verdict; re-reading the file per
  // request would let a deck edited on disk AFTER that moment ride out under
  // it (#235). For a container this also avoids the one write this mode does
  // not make — unpacking to a temp file that would sit somewhere after the
  // talk. A pull, or a change of mode, re-audits and re-prints.
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
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileAtomic(deckPath, next);
    return true;
  };

  // Declared before the git block below, which reads it to hold the cadence
  // back while a job is in flight.
  let agentJob = null; // { name, prompt, startedAt } — strictly one at a time
  // The asks of this session, oldest first, with what came of each — what the
  // docked agent panel shows. An agent's edit reloads every browser, so the
  // log lives HERE, not in the page, and rides /deck/ping across the reload.
  const agentAsks = [];
  const ASKS_KEPT = 20;
  let askSeq = 0;
  let exporting = false; // an export in flight — one browser, one output path, any kind
  let enhancing = null;  // a script enhancement in flight: { of, done } — one at a time
  let publishing = false; // a publish in flight — one push at a time

  // ── git autocommit — the durable record, independent of undo/redo ──────
  const noGit = args.includes('--no-git');
  const wantGit = args.includes('--git');
  const commitEvery = Math.max(5, Number(opt('--commit-every', 300)) || 300);
  // Commit subjects written by an agent, from the deck's diff. Two levels:
  //
  //  - ON CLICK, by default: the commit window's "write one for me" asks the
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
  function ownCommit(message) {
    const made = message === undefined
      ? gitAutocommit(deckPath, root)
      : gitAutocommit(deckPath, root, message);
    if (!made) return false;
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
  let dirtyLines = 0;      // how much of the deck differs from HEAD
  let nagged = false;      // the episode latch: asked once, then quiet
  let nagDismissed = false;
  let lastWip = null;      // the snapshot sha, so the ping can prove it exists
  /** A commit happened: this stretch of uncommitted work is over. */
  const resetEpisode = () => {
    dirtySince = 0; dirtyLines = 0; nagged = false; nagDismissed = false;
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
    const d = deckDirty(root, deckRel);
    if (!d.dirty) { dirtySince = 0; dirtyLines = 0; return d; }
    if (!dirtySince) dirtySince = Date.now();
    dirtyLines = d.lines;
    return d;
  };
  /** What the deck knows about uncommitted work — ping and SSE both send this. */
  const commitState = () => ({
    dirty: dirtySince > 0,
    lines: dirtyLines,
    sinceMs: dirtySince ? Date.now() - dirtySince : 0,
    nag: nagged && !nagDismissed,
    wip: lastWip,
    canWrite: gitOn && gitMode !== 'off',
    messages: wantMessages,
    // who "write one for me" would ask — null when the session turned subjects
    // off, or no agent is installed; `subjectsOff` says which
    describer: describer(),
    subjectsOff,
  });
  // Write mode's. A deck opened read-only is somebody else's: no repository
  // is created beside it, no snapshot is taken, nothing of it is committed.
  if (!readOnly && !noGit && (wantGit || inGitRepo(root))) {
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
      // repository decklight just created has no commits at all, and a deck git
      // has never seen is in no commit — in both cases there is no HEAD for the
      // snapshot to parent on and nothing in git to recover, so this commit is
      // how the deck ENTERS history rather than an autosave of it.
      const opening = deckDirty(root, deckRel);
      if (gitMode === 'timer') ownCommit(`decklight: start editing ${basename(deckPath)}`);
      else if (opening.firstCommit || opening.untracked) ownCommit(`decklight: add ${basename(deckPath)}`);
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
          ? `auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`
          : 'commits on your word · snapshot on decklight/wip',
        gitMode === 'timer'
          ? `  git: auto-committing ${deckRel} every ${commitEvery}s (and on Ctrl-C)`
          : wipLine(deckRel));
    }
  }
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
      gitAutocommit(deckPath, root, `decklight: stop editing ${basename(deckPath)}`);
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
  // Named at startup in write mode only: read-only mode refuses the agent
  // route with the rest of the write family, and a roster line under the
  // ingredients label would promise a capability that mode does not have.
  if (agents.length && !readOnly) {
    const mark = (a) => a.name + (a.name === agentPref ? ' (preferred)' : '') + (a.installed ? ' (installed)' : '');
    startup('agents', agents.map(mark).join(', '),
      `  agents: ${agents.map(mark).join(', ')} — “Ask agent” (A) is live`);
  }
  // A remembered agent that is not on this machine is said ONCE, at startup,
  // rather than discovered at the moment someone presses A mid-talk.
  if (!readOnly && agentPref && !agents.some((a) => a.name === agentPref)) {
    console.log(`  agent: ${agentUnavailable(agentPref, agents)}`);
  }
  // Said out loud, every session it is on: this is the switch that starts
  // sending the deck somewhere, and a capability nobody is reminded of is one
  // they stop counting on being off. Printed HERE rather than up with the other
  // git lines because it names the agent, and the roster is only resolved now.
  if (gitOn && wantMessages) {
    const who = agents.find((a) => a.name === agentPref) ?? agents[0];
    startup('git',
      who?.name ? `${who.name} writes the subjects` : '--commit-messages needs an agent on PATH',
      `  ${messagesLine(who?.name ?? null)}`);
  }

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  // The review routes (SPEC REVIEW), the same ones every server that opens a
  // deck registers: a review can be left in write mode too. The sidecar is
  // appended, never the deck; here it is not committed by itself, because the
  // deck's own commits (the snapshot, K) are what this server keeps.
  // In read-only mode the sidecar is the ONE file this process writes, and
  // it is committed by itself as each comment lands when the deck sits in a
  // repository (`--no-git` leaves the committing to you).
  const reviewRepo = gitAvailable(dirname(deckPath)) && inGitRepo(dirname(deckPath));
  const review = createReviewRoutes(deckPath, {
    inRepo: reviewRepo,
    gitOn: readOnly && reviewRepo && !noGit,
    mode: readOnly ? 'read-only' : 'write',
  });
  // The deck's channel (deck-routes.mjs): the probe and the stream, in both
  // modes. What the probe carries beyond the mode is `extras`, computed on
  // every ping like everything else on it: the toast is threshold-driven,
  // not live.
  const deck = createDeckRoutes(deckPath, {
    readOnly: () => readOnly,
    locked: () => readOnly || locked,
    review,
    extras: async () => (readOnly ? {
      // Read-only mode names nothing that edits: no roster, no history, no
      // git. What the page needs is whether the phone remote is on
      // (READ_ONLY#REMOTE: the clicker, and the QR in the speaker view) and
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
      agents: agents.map((a) => ({ name: a.name, label: a.label })),
      // which one A reaches for, so the picker opens on it rather than
      // defaulting to the first detected agent every session (#125)
      preferredAgent: agentPref ?? null,
      agentBusy: agentJob && { agent: agentJob.agent, prompt: agentJob.prompt, startedAt: agentJob.startedAt, id: agentJob.id },
      agentAsks,
      wizards: await configurableEngines(),
      // What is uncommitted, so a deck that loads mid-session shows the
      // chip without waiting for the next tick to broadcast one.
      commit: (gitOn && measureDirty(), commitState()),
    }),
  });
  const clients = deck.channel;
  const broadcast = deck.broadcast;

  // ── the phone remote (READ_ONLY#REMOTE) ───────────────────────────────────
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

  // ── the upstream check (READ_ONLY#UPSTREAM) ───────────────────────────────
  // A deck opened read-only from a clone: has its author pushed since? Absent
  // unless the deck is a tracked file in a clone with an upstream — that is
  // the whole safety argument: a deck you were emailed is a single file and
  // never reaches any of it. Write mode has H for the deck's own history and
  // never resolves this; the routes are registered only when it applies.
  const suppressed = !readOnly ? 'write mode' : upstreamSuppressed({ args, env: process.env });
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
   * live reload in read-only mode is exactly this: never new bytes under the
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
  let quietWrite = null; // the bytes of a write that updates the page itself (themeMarkRoute)
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
      // Read-only mode serves the audited bytes, never the disk: a file that
      // changed underneath it is not reloaded, because that would be new
      // bytes under the old label. Entering read-only mode re-audits.
      if (readOnly) return;
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
        if (now === quiet) { console.log('  changed → updated in place, no reload'); return; }
      }
      clients.raw('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  function runAgent(prompt, name, message, slide) {
    const cmd = agentCommand(name || agentPref, prompt, deckRel);
    if (!cmd) return null;
    const ask = {
      id: ++askSeq, agent: cmd.name, label: cmd.label, prompt,
      ...(Number.isInteger(slide) && slide > 0 ? { slide } : {}),
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
    if (gitOn && shouldCommit(gitMode, { kind: 'bookend' })
        && ownCommit(`decklight: save before ${cmd.name} edits ${basename(deckPath)}`)) {
      console.log('  git: committed your outstanding changes first');
    }
    const before = readDeck();
    agentJob = { agent: cmd.name, label: cmd.label, prompt, startedAt: ask.startedAt, id: ask.id, slide: ask.slide };
    broadcast('agent', { state: 'start', ...agentJob });
    console.log(`  agent: ${cmd.name} ← "${prompt.slice(0, 80)}"`);
    const child = spawn(cmd.bin, cmd.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (cmd.stream === 'claude-json') {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          const clue = claudeActivity(line);
          if (clue?.activity) say(clue.activity);
          else if (clue?.result != null) resultText = clue.result;
        }
      });
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
    child.on('error', (e) => {
      clearTimeout(timeout);
      agentJob = null;
      finish({ ok: false, changed: false, error: String(e.message || e) });
      broadcast('agent', { state: 'done', id: ask.id, agent: cmd.name, ok: false, changed: false, error: String(e.message || e) });
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
      // Did the edit orphan, stale, or reshape a recording? A track is
      // minutes of somebody's own voice, and a whole-deck rewrite can drop the
      // config that plays it or the notes it reads with nothing on screen to
      // say so — this is where before/after both exist, so it is where the
      // word is said. A warning, never a block: the file is already written,
      // Z takes it back, and the audio never left the disk.
      let recordingWarning = null;
      if (changed) {
        try {
          const impact = recordingImpact(before, after, {
            dirsOf: configuredTrackDirs,
            recordedSlides: (dir) => {
              try { return slidesFromFiles(readdirSync(resolve(dirname(deckPath), dir))); }
              catch { return []; }
            },
          });
          recordingWarning = impactWarning(impact);
        } catch { recordingWarning = null; }   // a warning that throws is worse than none
      }
      agentJob = null;
      // the agent's own words when the stream carried them — raw stream-json
      // stdout is a wall of JSON nobody should be shown
      const said = (resultText ?? tail.trim().split('\n').slice(-6).join('\n')).slice(-600);
      finish({ ok: code === 0, changed, code, tail: said });
      broadcast('agent', {
        state: 'done', id: ask.id, agent: cmd.name, ok: code === 0, changed, code, tail: said,
        ...(recordingWarning ? { recordingWarning } : {}),
      });
      console.log(`  agent: ${cmd.name} exited (${code}) — deck ${changed ? 'changed' : 'unchanged'}`);
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

  // The editing LOCK (PRESENTING): started in write mode, the author can turn
  // changes off to avoid making one by mistake, and back on. It lives here,
  // not in a page, so every tab and the agent see the same state: locked,
  // every POST to /deck/edit/* but this one answers 423, the ping says so, and the
  // live-reload channel tells every open page. A server started --read-only
  // has no lock to turn, because it has no write route to lock.
  let locked = false;
  function lockRoute({ body, json }) {
    const { locked: want } = JSON.parse(body || '{}');
    if (typeof want !== 'boolean') return json(400, { ok: false, error: 'locked is true or false' });
    if (want !== locked) {
      locked = want;
      console.log(locked ? '  editing locked — nothing is written until it is unlocked' : '  editing unlocked');
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
    const content = history[dir](cur);
    if (content === null) return json(409, { ok: false, error: `nothing to ${dir}`, ...history.counts() });
    writeFileAtomic(deckPath, content);
    console.log(`  ${dir} → ${JSON.stringify(history.counts())}`);
    return json(200, { ok: true, ...history.counts() });
  }

  // ── committing on the author's word (SPEC PRESENTING) ─────────────────
  // What is uncommitted, right now. The overlay opens on this rather than
  // on whatever the last SSE event said, because K can be pressed at any
  // moment and a stale count is a lie about what you are agreeing to.
  function commitStatusRoute({ json }) {
    if (gitOn) measureDirty();     // the answer must be about NOW, not the last tick
    return json(200, { ok: true, ...commitState(), deck: deckRel });
  }

  // The commit the author asked for. The subject is THEIRS — typed, or an
  // agent's sentence they looked at and kept — so it goes through
  // `commitSubject` like every other message that reaches a command line
  // (one line, capped, never a leading `-`) and nothing else rewrites it:
  // `describeCommit`'s amend is for messages decklight authored, and this
  // one has an author.
  function commitRoute({ body, json }) {
    if (!gitOn) return json(409, { ok: false, error: 'this session is not committing — open the deck with --git' });
    let msg = '';
    try { msg = String(JSON.parse(body || '{}').message ?? '').trim(); } catch { /* below */ }
    if (!msg) return json(400, { ok: false, error: 'a commit needs a message' });
    const subject = commitSubject(msg, `decklight: autosave ${basename(deckPath)}`);
    // gitAutocommit reports false for "nothing to commit", which is not an
    // error: it is the answer to pressing K twice.
    const made = gitAutocommit(deckPath, root, subject);
    if (!made) return json(200, { ok: true, committed: false, ...commitState() });
    resetEpisode();
    console.log(`  git: committed ${deckRel} — "${subject}"`);
    return json(200, {
      ok: true, committed: true, subject, ...history.counts(), ...commitState(),
    });
  }

  // A subject for work that is not committed yet — the overlay's "write one
  // for me", asked only when that is pressed (or as the window opens, with
  // --commit-messages). Refused when the session turned subjects off, or
  // there is no agent to ask.
  async function commitSubjectRoute({ json }) {
    if (subjectsOff) {
      return json(403, { ok: false, error: 'commit subjects are off in this session — it was started with --no-commit-messages' });
    }
    if (!describer()) {
      return json(409, { ok: false, error: 'no agent is installed on this machine to write one — decklight doctor lists the ones it can use' });
    }
    const subject = await describeWorking({
      cwd: root, deckPath, deckRel, agent: agentPref,
      template: `decklight: autosave ${basename(deckPath)}`,
    });
    return json(200, { ok: true, subject: subject ?? null });
  }

  function commitDismissRoute({ json }) {
    // Not the same as committing: the work stays uncommitted and the
    // snapshot keeps running. It only means "stop asking about THIS one".
    nagDismissed = true;
    return json(200, { ok: true, ...commitState() });
  }

  // ── the deck's durable history (#129): what the R overlay reads ────
  // Loopback-only like every other /deck/edit/* path: this serves arbitrary
  // historical revisions of the deck, which is nobody else's business.
  function historyRoute({ json }) {
    if (!gitOn) return json(409, { ok: false, error: 'git is off for this session — there is no history' });
    try {
      // One round trip serves the whole overlay: the commits, which of them
      // exist nowhere but this machine, and where the branch stands. All of
      // it is a LOCAL read — `unpushed` and `@{u}` read remote-tracking
      // refs, so opening the history never touches the network (SPEC
      // PRESENTING).
      // `slides` is what that version WAS, `add`/`del` what it CHANGED —
      // the two questions a hash and a subject cannot answer, and the ones
      // that tell "tightened the wording" apart from "cut four slides"
      // before you restore it rather than after.
      const entries = decorateHistory(deckHistory(deckPath, root), deckPath, root);
      const remote = remoteState(root);
      // `pushed` is null for "not a question worth answering here", and the
      // two cases are different: git could not tell us, or there is no
      // remote at all — in which case EVERY commit is unpushed and marking
      // all of them is a wall of arrows saying what the footer says once.
      const local = ['no-remote', 'ambiguous-remote'].includes(remote.state) ? null : unpushed(root);
      const set = local ? new Set(local) : null;
      for (const e of entries) e.pushed = set ? !set.has(e.full) : null;
      // The LINE is computed here, not in the player: cli/git.mjs is Node
      // (it spawns git), the runtime has zero dependencies and cannot
      // import it, and duplicating the wording in the browser is how the
      // four places that talk about unpushed work start disagreeing.
      return json(200, { ok: true, entries, remote: { ...remote, line: remoteLine(remote) } });
    } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
  }

  /**
   * A page this server writes ITSELF — an old version of the deck, a template
   * preview — goes out the way `staticFiles` sends every other page: a deck
   * that is data (#520) gets the runtime, its stylesheet, its theme and the
   * themes it marks referenced. Without it the frame drew the deck's bare
   * markup, dark text on the panel's dark ground — a black rectangle. The
   * `<base>` comes first, so those references resolve from the root, where
   * `staticFiles` answers them, not from under /deck/edit/.
   */
  const asServed = (html) => linkFonts(linkDesignSystems(linkAddedThemes(linkRuntime(withBaseHref(html)))));

  function deckAtRoute({ res, url, json, CORS }) {
    if (!gitOn) return json(409, { ok: false, error: 'git is off for this session' });
    try {
      // <base href="/"> because this is served from /deck/edit/, not the root:
      // without it every relative ../dist and ./casts path in the deck
      // would resolve one directory too deep and the preview would be bare.
      const html = asServed(deckAt(deckPath, url.searchParams.get('ref') || '', root));
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      // Two different failures, and answering both with the same 404 is how
      // #508 hid for a release: a deck over Node's stdout cap threw ENOBUFS
      // here, was reported as a missing revision, and the preview iframe drew
      // a bare 404 body as a black rectangle. A ref git does not know is the
      // only 404; anything else is this server's problem and says so — in the
      // terminal, and in the frame, which is where somebody is looking.
      // git's own two ways of saying "not here": `invalid object name 'x'` for a
      // ref it cannot resolve, `path 'x' does not exist in 'HEAD'` for a deck that
      // was not in that commit. Everything else — ENOBUFS above all (#508) — is a
      // failure of this server, not a missing revision, and must not wear a 404.
      const missing = /invalid object name|unknown revision|does not exist in|exists on disk, but not in/i
        .test(String(e.stderr || e.message || e));
      const why = missing ? 'no such revision of this deck' : oneline(e);
      if (!missing) console.log(`  history: previewing ${basename(deckPath)} failed — ${why}`);
      res.writeHead(missing ? 404 : 500, { ...CORS, 'content-type': 'text/html; charset=utf-8' });
      return res.end(previewError(why));
    }
  }

  function restoreRoute({ body, json }) {
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

  // ── review comments (SPEC REVIEW) ─────────────────────────────
  // The author's side of `decklight <deck> --read-only`. The same file, the same
  // append-only rule: this server may add a line (a resolve, a reply) and
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

  function reviewDoneRoute({ body, json }) {
    // Mark ONE of a reviewer's comments done, or take the mark off. Their
    // comments live on their branch, which is not ours to write, so the
    // mark is kept in this clone's git config — private, never pushed.
    // Your OWN comments do not come through here at all: they already have
    // a way to be finished with, the append-only `resolve` record below,
    // which travels so the reviewer can see you dealt with their point.
    //
    // The branch is looked up in what the incoming reader LISTED, so it is
    // data here and never an argument; the id is shape-checked before it
    // becomes half of a config key.
    const { branch, id, done = true } = JSON.parse(body || '{}');
    const listed = incomingCache?.r?.reviews?.find((v) => v.branch === branch);
    if (!listed) return json(400, { ok: false, error: 'not a review this deck knows about — press M again to refresh' });
    if (!listed.records?.some((r) => r.id === id)) {
      return json(400, { ok: false, error: 'no such comment in that review' });
    }
    if (!setCommentDone(root, branch, id, !!done)) {
      return json(500, { ok: false, error: 'could not write the mark to git config' });
    }
    // the list just changed shape — the cache must not keep the old marks
    incomingCache = null;
    console.log(`  review: ${branch} ${id} ${done ? 'marked done' : 'reopened'}`);
    return json(200, { ok: true, branch, id, done: !!done });
  }

  // ── marketplace themes, and marking (THEME_BROWSE#UI) ─────────────────
  // What the overlay lists while authoring: every theme of every registered
  // marketplace, each saying whether this deck marks it. Cache-only by
  // construction — the catalogs `marketplace update` already fetched — so a
  // deck on a plane lists what it has and names what it could not read.
  async function themeBrowseRoute({ json }) {
    const { marketplaceThemes, markedRefs, markedSources, resolveThemeRef } = await import('./theme-refs.mjs');
    const { themes, stale } = marketplaceThemes();
    // what the deck marks, as THIS machine names it — the deck may call the
    // same catalog something else (its recorded source says which it means)
    const html = readDeck();
    const sources = markedSources(html);
    const marked = new Set(markedRefs(html).map((r) => {
      const hit = resolveThemeRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    const out = themes.map((t) => ({
      ...t, marked: marked.has(t.qualified),
      ...(resolveThemeRef(t.qualified).remote ? { remote: true } : {}),
    }));
    return json(200, { ok: true, themes: out, stale, cacheOnly: true });
  }

  /**
   * Mark a theme for this deck, or unmark it (SPEC THEME_DISTRIBUTION). The
   * deck gains or loses one reference in its config block — never CSS — as
   * one undo entry; the watcher's reload brings every browser back with the
   * list as the file now says it is.
   *
   * Marking runs the theme through `theme add`'s own validator first, so a
   * theme refused on the command line is refused here, by the same code, and
   * a deck cannot be made to carry what the shipped set could not contain.
   * An entry whose bytes live at a URL is read now — this is the explicit act
   * — and kept, so no server ever has to reach for it again.
   */
  async function themeMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.marked !== false;
    const { parseRef, parseShipped, resolveThemeRef, setMarked, cacheThemeCss, refForDeck } = await import('./theme-refs.mjs');
    const { MarketplaceError, configHome } = await import('./marketplace.mjs');
    const shipped = parseShipped(ref);
    if (!shipped && !parseRef(ref)) return json(400, { ok: false, error: 'which theme? — a shipped name, or name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null;
    // A shipped theme needs no resolving and no check — it is decklight's own,
    // and passed the contract when it shipped. Marking it says only that the
    // deck carries it when it travels.
    if (on && !shipped) {
      const r = resolveThemeRef(ref);
      let css;
      if (r.file) css = readFileSync(r.file, 'utf8');
      else if (r.remote) {
        const { fetchTheme } = await import('./theme.mjs');
        try { css = await fetchTheme(r.remote); }
        catch (e) { return json(502, { ok: false, error: `could not read ${r.remote}: ${oneline(e)}` }); }
      } else {
        // An entry this machine knows but whose files are not here is a state
        // `marketplace update` fixes (409); one it has never heard of is 404.
        const status = r.entry && r.entry.type !== 'theme' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const { validateTheme } = await import('../tools/theme-check.mjs');
      const check = validateTheme(css);
      if (!check.ok) {
        // The deck is left byte-for-byte unchanged.
        return json(400, { ok: false, error: `${r.name} fails the theme contract`, problems: check.errors ?? [] });
      }
      if (r.remote) cacheThemeCss(configHome(), r.marketplace, r.name, css);
      source = r.source ?? null;
      deckRef = refForDeck(before, r.name, r.local, source);
    }
    let out;
    try { out = setMarked(before, deckRef, on, { source }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    if (out.changed) {
      history.record(before);   // Z takes a mark back like any other edit
      // The picker asks for `quiet`: it shows the new mark itself and stays
      // open. Everyone else — the export card's "mark and carry on", which
      // resumes across the reload — gets the reload.
      if (req.quiet === true) quietWrite = out.html;
      writeFileAtomic(deckPath, out.html);
      console.log(`  theme: ${on ? 'marked' : 'unmarked'} ${deckRef}`);
    }
    return json(200, { ok: true, ref: deckRef, marked: on, changed: out.changed, ...history.counts() });
  }
  // Every design system every registered marketplace offers, each saying
  // whether this deck references it (SPEC DESIGN_SYSTEMS) — the palette's
  // "Design systems…" list. Cache-only, like the theme browse above.
  async function designSystemBrowseRoute({ json }) {
    const { marketplaceDesignSystems, designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
    const { markedSources } = await import('./theme-refs.mjs');
    const { systems, stale, unfetched } = marketplaceDesignSystems();
    const html = readDeck();
    const sources = markedSources(html);
    // what the deck references, as THIS machine names the catalog
    const used = new Set(designSystemRefs(html).map((r) => {
      const hit = resolveDesignSystemRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    return json(200, { ok: true, systems: systems.map((s) => ({ ...s, used: used.has(s.qualified) })), stale, unfetched, cacheOnly: true });
  }

  /**
   * Reference a design system from this deck, or drop it (SPEC
   * DESIGN_SYSTEMS) — the twin of the theme mark below it. The package runs
   * through `decklight design-system check` first, so the command line and
   * this route refuse by the same code; the deck gains or loses one entry in
   * its config block as one undo entry.
   */
  async function designSystemMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.used !== false && req.marked !== false;
    const { parseRef, refForDeck } = await import('./theme-refs.mjs');
    const { resolveDesignSystemRef, setDesignSystem, designSystemRefs } = await import('./design-system-refs.mjs');
    const { checkDir } = await import('./design-system.mjs');
    const { MarketplaceError, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
    if (!parseRef(ref)) return json(400, { ok: false, error: 'which design system? — name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null, manifest = null, local = null;
    if (on) {
      const r = resolveDesignSystemRef(ref);
      if (!r.dir) {
        const status = r.entry && r.entry.type !== 'design-system' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const verdict = checkDir(r.dir);
      if (!verdict.ok) {
        // the deck is left byte-for-byte unchanged
        return json(400, { ok: false, error: `${r.ref} fails the design-system check`, problems: verdict.problems.map((p) => `${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.msg}`) });
      }
      source = r.source ?? null;
      manifest = verdict.manifest;
      local = r.local;
      deckRef = refForDeck(before, r.name, r.local, source);
      if (!designSystemRefs(before).some((x) => x.ref === deckRef)) {
        recordInstall({ type: 'design-system', name: r.name, marketplace: r.local, version: r.entry.version ?? null,
          commit: loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null });
      }
    } else {
      // the deck's own spelling, whatever this machine calls the catalog
      const p = parseRef(ref);
      deckRef = designSystemRefs(before).find((x) => x.ref === ref || x.name === p.name)?.ref ?? ref;
    }
    let out;
    try { out = setDesignSystem(before, deckRef, on, { source }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    // Its themes and fonts come with it (SPEC DESIGN_SYSTEMS, #642) — in the
    // same write, so the whole thing is ONE undo — unless the author held ⇧
    // (recommended: false). The look is offered, and applied only when asked.
    let html = out.html, plan = null, look = null;
    if (on && manifest) {
      const deps = await import('./design-system-deps.mjs');
      plan = deps.planRecommended(html, { manifest, local });
      if (req.recommended !== false) {
        html = deps.writePlan(html, plan);
        for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
      }
      look = deps.lookOf(html, req.recommended !== false ? plan
        : { ...plan, items: plan.items.filter((it) => it.status === 'already' || it.status === 'stack') });
      if (req.apply === true && look.differs) html = deps.applyLook(html, look);
      look.phrase = deps.lookPhrase(look, plan);
    }
    const changed = html !== before;
    if (changed) {
      history.record(before);   // Z takes it back like any other edit
      if (req.quiet === true) quietWrite = html;
      writeFileAtomic(deckPath, html);
      console.log(`  design system: ${on ? 'referenced' : 'dropped'} ${deckRef}`);
    }
    const pulled = plan && req.recommended !== false ? plan.items.map(({ kind, rec, ref: r2, status, why, cmd, family }) => ({ kind, rec, ref: r2, status, why, cmd, family })) : [];
    return json(200, { ok: true, ref: deckRef, used: on, changed, pulled, look, ...history.counts() });
  }

  /**
   * Give the deck the look a design system it uses was drawn for (SPEC
   * DESIGN_SYSTEMS, #642): its first recommended theme and font, bringing any
   * that are missing — one edit, one undo, so Z puts the old look back and
   * keeps the design system. The twin of `decklight design-system apply`.
   */
  async function designSystemApplyRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const { designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
    const { markedSources, parseRef } = await import('./theme-refs.mjs');
    const { checkDir } = await import('./design-system.mjs');
    const { recordInstall } = await import('./marketplace.mjs');
    const deps = await import('./design-system-deps.mjs');
    const before = readDeck();
    const p = parseRef(String(req.ref ?? ''));
    const hit = designSystemRefs(before).find((x) => x.ref === req.ref || x.name === (p?.name ?? req.ref));
    if (!hit) return json(404, { ok: false, error: `this deck does not use ${req.ref}` });
    const r = resolveDesignSystemRef(hit, undefined, { source: markedSources(before)[hit.marketplace] ?? null });
    if (!r.dir) return json(409, { ok: false, error: r.missing });
    const verdict = checkDir(r.dir);
    if (!verdict.ok) return json(409, { ok: false, error: `${hit.ref} no longer passes its check` });
    const plan = deps.planRecommended(before, { manifest: verdict.manifest, local: r.local });
    let html = deps.writePlan(before, plan);
    const look = deps.lookOf(html, plan);
    if (look.differs) html = deps.applyLook(html, look);
    look.phrase = deps.lookPhrase(look, plan);
    // recorded even when the deck is unchanged: a dependency already there
    // takes the catalog's version now, as `design-system apply` does (#653)
    for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
    if (html !== before) {
      history.record(before);
      writeFileAtomic(deckPath, html);
      console.log(`  design system: applied ${look.title}'s look — ${look.phrase || 'already worn'}`);
    }
    return json(200, { ok: true, ref: hit.ref, changed: html !== before, look, ...history.counts() });
  }

  // Every font every registered marketplace offers (SPEC FONTS), each saying
  // whether this deck references it, with the faces a preview needs — the
  // font picker's marketplace rows. Cache-only, like the theme browse.
  /**
   * GET /deck/edit/export/estimate?kind=bundle — how big an export would be, before
   * it is written. Only the bundle has one today: the file without its audio
   * (`base`), and what each way of carrying the narration's recorded audio
   * would add (cli/bundle-audio.mjs), so the bundle card can say "Opus — ≈ 2.1
   * MB" before anybody chooses. `audio` is null for a deck with no recorded
   * audio on this disk.
   */
  async function exportEstimateRoute({ url, json }) {
    const kind = url.searchParams.get('kind');
    if (kind !== 'bundle') return json(400, { ok: false, error: `no estimate for ${kind ?? 'that'} — only a bundle has one` });
    const theme = url.searchParams.get('theme');
    if (theme != null && !THEME_NAME.test(theme)) return json(400, { ok: false, error: 'the theme is a theme name' });
    const { bundleMain } = await import('./bundle.mjs');
    const estimate = (argv) => bundleMain([deckPath, ...argv], { estimate: true });
    try {
      // in the theme on screen, as the export will be — or, when that one
      // cannot be bundled yet (the export asks to mark it first), in the
      // deck's own: an estimate a theme's stylesheet away is still one
      let r;
      try { r = await estimate(theme ? ['--theme', theme] : []); } catch (e) {
        if (!theme || !(e instanceof CommandError)) throw e;
        r = await estimate([]);
      }
      return json(200, { ok: true, base: r.base, audio: r.audio });
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      return json(409, { ok: false, error: e.message.split('\n')[0] });
    }
  }

  async function fontBrowseRoute({ json }) {
    const { marketplaceFonts, fontRefs, resolveFontRef } = await import('./font-refs.mjs');
    const { markedSources } = await import('./theme-refs.mjs');
    const { fonts, stale, unfetched } = marketplaceFonts();
    const html = readDeck();
    const sources = markedSources(html);
    const used = new Set(fontRefs(html).map((r) => {
      const hit = resolveFontRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    return json(200, { ok: true, fonts: fonts.map((f) => ({ ...f, used: used.has(f.qualified) })), stale, unfetched, cacheOnly: true });
  }

  /**
   * Reference a font from this deck, or drop it (SPEC FONTS) — the twin of
   * the design-system mark above: `font check` first, one config entry, one
   * undo. `use: true` also makes it the deck's default font. `quiet` writes
   * without the reload: the picker previews the face itself, and stays open.
   */
  async function fontMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.used !== false && req.marked !== false;
    const { parseRef, refForDeck } = await import('./theme-refs.mjs');
    const { resolveFontRef, setFont, fontRefs } = await import('./font-refs.mjs');
    const { checkFontDir } = await import('./font.mjs');
    const { MarketplaceError, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
    if (!parseRef(ref)) return json(400, { ok: false, error: 'which font? — name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null;
    if (on) {
      const r = resolveFontRef(ref);
      if (!r.dir) {
        const status = r.entry && r.entry.type !== 'font' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const verdict = checkFontDir(r.dir);
      if (!verdict.ok) {
        return json(400, { ok: false, error: `${r.ref} fails the font check`, problems: verdict.problems.map((p) => `${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.msg}`) });
      }
      source = r.source ?? null;
      deckRef = refForDeck(before, r.name, r.local, source);
      if (!fontRefs(before).some((x) => x.ref === deckRef)) {
        recordInstall({ type: 'font', name: r.name, marketplace: r.local, version: r.entry.version ?? null,
          commit: loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null });
      }
    } else {
      const p = parseRef(ref);
      deckRef = fontRefs(before).find((x) => x.ref === ref || x.name === p.name)?.ref ?? ref;
    }
    let out;
    try { out = setFont(before, deckRef, on, { source, use: req.use === true }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    if (out.changed) {
      history.record(before);
      if (req.quiet === true) quietWrite = out.html;
      writeFileAtomic(deckPath, out.html);
      console.log(`  font: ${on ? 'referenced' : 'dropped'} ${deckRef}${on && req.use === true ? ' (the deck\'s default)' : ''}`);
    }
    return json(200, { ok: true, ref: deckRef, used: on, changed: out.changed, ...history.counts() });
  }

  // `/deck/edit/theme/add` was 0.9.0's name for installing from Browse. A deck that
  // carries its OWN copy of the runtime still asks for it; it means "mark".
  const themeAddRoute = ({ body, json }) =>
    themeMarkRoute({ body: JSON.stringify({ ref: JSON.parse(body || '{}').ref, marked: true }), json });

  /**
   * The marketplace theme on screen that this deck does not mark, as a
   * reference — or null. An export or a publish of an unmarked theme would
   * come out in a theme the deck does not carry; the card asks first
   * (`409 { unmarked }`), and marking is one more press.
   */
  async function unmarkedOnScreen(theme, { carried = false } = {}) {
    if (!theme) return null;
    const html = readDeck();
    const { markedRefs, markedShipped, marketplaceThemes, shippedThemes } = await import('./theme-refs.mjs');
    if (shippedThemes().includes(theme)) {
      // A render shows a shipped theme without carrying it — every install has
      // it. A BUNDLE carries only what the deck marks, plus the theme it opens
      // on: one it opens on in some other theme is a question first (Gilles'
      // rule), so the file never leaves carrying a theme nobody chose to send.
      if (!carried) return null;
      return markedShipped(html).includes(theme) || theme === configTheme(html) ? null : theme;
    }
    if (markedRefs(html).some((r) => r.name === theme)) return null;
    if (new RegExp(`<style\\b[^>]*\\bdata-theme\\s*=\\s*["']${theme}["']`, 'i').test(html)) return null;
    return marketplaceThemes().themes.find((t) => t.name === theme)?.qualified ?? null;
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
  // server answers loopback alone, and `--read-only` registers nothing like
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

  // ── deck templates, into a deck that already exists (UNITS#REST) ─────────

  /**
   * Deck templates, into a deck that already exists (`UNITS#REST`).
   *
   * A template is one self-contained HTML deck, and until now the only way
   * to use one was `init --from` — which writes a NEW deck, so a deck you
   * had already started could not take anything from a template at all.
   * These four routes are the other half: what is installed, what a
   * marketplace offers, what is IN a template, and its slides into this
   * deck.
   *
   * Listing is cache-only, exactly like the theme browser: a deck being
   * authored on a plane lists what has been fetched and names the
   * marketplaces it could not read. Only `add` touches the network, and it
   * goes through `template add`'s own installer, so a template refused on
   * the command line is refused here for the same reason.
   *
   * The insert is an ORDINARY EDIT — `applyEdit`, one undo entry — because
   * that is what it is: somebody else's slides are now your slides, and `Z`
   * takes them back like any other change.
   */
  async function templateListRoute({ json }) {
    const { listUnits } = await import('./units.mjs');
    const { themes: offered, stale } = await browsableUnits('template');
    const installed = listUnits('template').map((u) => u.name);
    return json(200, {
      ok: true,
      installed,
      // what is offered AND not already here — the picker shows installed
      // templates first, then the ones an install would bring
      offered: offered.filter((e) => !installed.includes(e.name)),
      stale,
      cacheOnly: true,
    });
  }

  async function templateSlidesRoute({ url, json }) {
    const name = url.searchParams.get('name') ?? '';
    const { findUnit } = await import('./units.mjs');
    const found = findUnit('template', name);
    if (!found) return json(404, { ok: false, error: `no template "${name}" is installed here` });
    const { templateSlides, styleForSlides } = await import('../tools/template-slides.mjs');
    const raw = readFileSync(found.path, 'utf8');
    const here = readDeck();
    const slides = templateSlides(raw).map(({ n, title, hidden, needs, html }) => ({
      n, title, hidden, needs,
      // A class this deck already styles ITS OWN way is the one thing the
      // insert cannot fix for you: carrying the template's rule would
      // restyle slides you were not looking at, so it is refused, and the
      // slide lands with this deck's meaning of the name. Said here, with
      // `needs`, rather than in the toast afterwards.
      clashes: styleForSlides(raw, [html], here).clashed,
    }));
    if (!slides.length) return json(422, { ok: false, error: `"${name}" has no slides in it` });
    return json(200, { ok: true, name, slides });
  }

  // What the panel WOULD do, rendered and thrown away.
  //
  // Both modes preview THIS DECK as it would be, never the template as it
  // is. A template carries its own theme, and a slide taken out of it does
  // not: the section lands in your deck and is dressed by your tokens, so a
  // preview in the template's theme is a picture of something you are not
  // going to get. Insert splices the section in; apply retags the slide you
  // are on. Everything else — the runtime, the 46 theme blocks, your own
  // <style> — is the deck's, because it IS the deck.
  //
  // The same steps the two POSTs take, minus `applyEdit`: nothing written,
  // no undo entry, because a cursor moving through a list must never touch
  // the file.
  async function templatePreviewRoute({ res, url, CORS }) {
    const name = url.searchParams.get('name') ?? '';
    const { findUnit } = await import('./units.mjs');
    const found = findUnit('template', name);
    if (!found) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`no template "${name}" is installed here`);
    }
    const { templateSlides, lookOf, isLookAttr, styleForSlides } = await import('../tools/template-slides.mjs');
    const { sectionBodies, setSectionAttrs, insertSectionsAfter, mergeHeadStyle, writeAttrs } =
      await import('../tools/deck-html.mjs');
    const raw = readFileSync(found.path, 'utf8');
    const src = templateSlides(raw).find((x) => x.n === Number(url.searchParams.get('slide')));
    const deck = readDeck();
    const total = sectionBodies(deck).length;
    const to = Number(url.searchParams.get('to'));
    const insert = url.searchParams.get('mode') === 'insert';
    // insert lands AFTER a slide, so 0 is a legal position (before slide 1)
    const lo = insert ? 0 : 1;
    if (!src || !Number.isInteger(to) || to < lo || to > total) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('no such slide, here or there');
    }
    const { loremize, seeded } = await import('../tools/lorem.mjs');
    // the same seed the insert will use, so the preview is not merely the
    // right SHAPE with different words in it
    const taken = insert ? loremize(src.html, seeded(`${name}:${src.n}`)) : null;
    const base = insert
      ? insertSectionsAfter(deck, to, [taken])
      : setSectionAttrs(deck, to, { clearIf: isLookAttr, set: lookOf(src.html) }).html;
    // insert brings the whole section, so the rules it needs are the whole
    // section's; apply brings only the tag, so they are the tag's
    const style = styleForSlides(
      raw,
      insert ? [taken] : [`<section${writeAttrs(lookOf(src.html))}></section>`],
      base,
    );
    const out = style.css ? mergeHeadStyle(base, name, style.css) : base;
    res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(asServed(out));
  }

  // Not a new slide: a slide you already wrote, wearing a template slide's
  // LOOK. The words are yours and stay untouched; the opening tag is
  // replaced wholesale from an allowlist, so applying a look that has no
  // `data-layout` also takes yours off — otherwise the slide would end up
  // looking like neither of them.
  async function templateApplyRoute({ body, json }) {
    const { name, slide, to } = JSON.parse(body || '{}');
    const { findUnit } = await import('./units.mjs');
    const found = typeof name === 'string' && name ? findUnit('template', name) : null;
    if (!found) return json(404, { ok: false, error: `no template "${name}" is installed here` });

    const { templateSlides, lookOf, isLookAttr, styleForSlides } = await import('../tools/template-slides.mjs');
    const { sectionBodies, setSectionAttrs, mergeHeadStyle, writeAttrs } = await import('../tools/deck-html.mjs');
    const raw = readFileSync(found.path, 'utf8');
    const src = templateSlides(raw).find((x) => x.n === Number(slide));
    if (!src) return json(400, { ok: false, error: `"${name}" has no slide ${slide}` });

    const deck = readDeck();
    const total = sectionBodies(deck).length;
    const target = Number(to);
    if (!Number.isInteger(target) || target < 1 || target > total) {
      return json(400, { ok: false, error: `cannot apply to slide ${to} — this deck has ${total}` });
    }

    const look = lookOf(src.html);
    const { html: retagged, replaced } = setSectionAttrs(deck, target, { clearIf: isLookAttr, set: look });
    // The look may name a class the template styles. Slice against the tag
    // alone: the slide's own content did not change, so nothing else can
    // have started needing a rule it did not need a moment ago.
    const style = styleForSlides(raw, [`<section${writeAttrs(look)}></section>`], retagged);
    const changed = applyEdit(style.css ? mergeHeadStyle(retagged, name, style.css) : retagged, deck);
    console.log(`  template: slide ${target} now wears ${name} slide ${src.n}'s look`
      + (Object.keys(look).length ? ` (${Object.keys(look).join(', ')})` : ' (which is the plain one)'));
    return json(200, {
      ok: true, to: target, name, from: src.n, fromTitle: src.title,
      applied: look, replaced, changed, ...history.counts(),
      styles: { carried: style.carried, clashed: style.clashed, dangling: style.dangling },
    });
  }

  async function templateAddRoute({ body, json }) {
    const { ref } = JSON.parse(body || '{}');
    if (typeof ref !== 'string' || !ref.trim()) return json(400, { ok: false, error: 'which template?' });
    const { installUnit, UnitError } = await import('./units.mjs');
    try {
      const done = await installUnit('template', ref.trim());
      console.log(`  template: installed ${done.name} from ${ref.trim()}`);
      return json(200, { ok: true, name: done.name });
    } catch (e) {
      if (e instanceof UnitError) return json(400, { ok: false, error: e.message });
      return json(502, { ok: false, error: oneline(e) });
    }
  }

  async function templateInsertRoute({ body, json }) {
    const { name, slides: want, after } = JSON.parse(body || '{}');
    const { findUnit } = await import('./units.mjs');
    const found = typeof name === 'string' && name ? findUnit('template', name) : null;
    if (!found) return json(404, { ok: false, error: `no template "${name}" is installed here` });

    const { templateSlides, styleForSlides } = await import('../tools/template-slides.mjs');
    const { sectionBodies, insertSectionsAfter, mergeHeadStyle } = await import('../tools/deck-html.mjs');
    const raw = readFileSync(found.path, 'utf8');
    const all = templateSlides(raw);
    const picked = (Array.isArray(want) && want.length ? want : all.map((s) => s.n))
      .map(Number)
      .filter((n) => Number.isInteger(n));
    const missing = picked.filter((n) => !all.some((s) => s.n === n));
    if (missing.length) {
      return json(400, { ok: false, error: `"${name}" has no slide ${missing.join(', ')} (it has ${all.length})` });
    }
    if (!picked.length) return json(400, { ok: false, error: 'no slides chosen' });

    const deck = readDeck();
    const total = sectionBodies(deck).length;
    const at = Number.isInteger(after) ? after : total;
    if (at < 0 || at > total) return json(400, { ok: false, error: `cannot insert after slide ${after} — this deck has ${total}` });

    const chosen = [...new Set(picked)].sort((a, b) => a - b).map((n) => all.find((s) => s.n === n));
    // A slide is markup AND the rules that shape it. `.breaks` is a stack
    // of cards in the deck it came from and a bare list in yours, so the
    // design travels with the section — into one marked block, so `Z`
    // takes the whole thing back and a reader can see whose rules these are.
    // A template slide is worth taking for its shape; its words are the
    // words of the talk it was written for, and a slide that looks
    // finished while saying nothing you mean is how somebody else's
    // pricing ends up on a screen behind you (`UNITS#REST`).
    const { loremize, seeded } = await import('../tools/lorem.mjs');
    const taken = chosen.map((s) => loremize(s.html, seeded(`${name}:${s.n}`)));
    const style = styleForSlides(raw, taken, deck);
    const spliced = insertSectionsAfter(deck, at, taken);
    const changed = applyEdit(style.css ? mergeHeadStyle(spliced, name, style.css) : spliced, deck);
    const needs = [...new Set(chosen.flatMap((s) => s.needs))];
    console.log(`  template: ${chosen.length} slide(s) from ${name} after slide ${at}`
      + (style.carried.length ? ` — with ${style.carried.join(', ')}` : '')
      + (style.clashed.length ? `; ${style.clashed.join(', ')} left to this deck's own rules` : '')
      + (needs.length ? `; points at ${needs.join(', ')}, which this deck does not have` : ''));
    return json(200, {
      ok: true, inserted: chosen.length, after: at, name,
      titles: chosen.map((s) => s.title), needs, changed, ...history.counts(),
      // the summary, not the stylesheet: the rules are in the file now
      styles: { carried: style.carried, clashed: style.clashed, dangling: style.dangling },
    });
  }

  // ── the recorder's offline recordings — V → Record this deck… (PRESENTING) ───────────────────────────────
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
    if (kind !== 'wav' && kind !== 'visemes' && kind !== 'manifest') return json(400, { ok: false, error: 'bad kind' });
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
    const name = `slide-${String(slide).padStart(2, '0')}`
      + (seg === null ? '' : `-${String(seg).padStart(2, '0')}`)
      + `.${kind === 'wav' ? 'wav' : 'visemes.json'}`;
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
      const header = { engine: str(req2.engine, 40), model: str(req2.model), voice: str(req2.voice), style: typeof req2.style === 'string' && req2.style.length <= 400 ? req2.style : null };
      if (!header.engine) return json(400, { ok: false, error: 'the manifest names no engine' });
      const from = Number(req2.range?.[0]), to = Number(req2.range?.[1]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 9999) return json(400, { ok: false, error: 'bad range' });
      const recorded = {};
      for (const [k, v] of Object.entries(req2.slides ?? {})) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < from || n > to) continue;
        recorded[n] = { segments: Array.isArray(v?.segments) ? v.segments.map(Number) : [] };
      }
      const { recorderManifest, slideTexts } = await import('../tools/narration-manifest.mjs');
      let prev = null;
      try { prev = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')); } catch { /* first take here */ }
      const manifest = recorderManifest({ prev: Array.isArray(prev?.slides) ? prev : null, header, texts: slideTexts(readDeck()), range: { from, to }, recorded });
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        // the script beside each file, as voiceover writes it — `--reuse-text` reads it back
        const texts = slideTexts(readDeck());
        for (const n of Object.keys(recorded)) writeFileSync(resolve(dir, `slide-${String(n).padStart(2, '0')}.txt`), texts[n - 1] ?? '');
      } catch (e) { return json(500, { ok: false, error: oneline(e) }); }
      return json(200, { ok: true, dir: want, file: 'manifest.json', slides: manifest.slides.filter(Boolean).length });
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
        let engine = null; let voice = null; let manifest = false; let stale = 0;
        try {
          const m = JSON.parse(readFileSync(resolve(root2, rel, 'manifest.json'), 'utf8'));
          engine = m.engine ?? null; voice = m.voice ?? null; manifest = true;
          // how many of its slides were voiced from other notes than the deck
          // has now — the export card marks the track with it (#536)
          if (Array.isArray(m.slides)) stale = staleSlides(m, texts, null, prior).stale.length;
        } catch { /* a folder recorded by hand has no manifest, and needs none */ }
        seen.push({
          dir: rel.split(sep).join('/'),
          files: wav.length,
          // the beats are what let a track pace the builds, so whether it
          // has them is the one fact worth reporting beside the count
          segments: wav.some((e) => /^slide-\d+-\d+\./.test(e.name)),
          ext: (wav[0].name.split('.').pop()),
          engine,
          voice,
          // only a folder with a manifest is one `decklight video` can render
          // from — your own voice leaves none, and the export must not offer it
          manifest,
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

  // ── hand-over: the files this deck can be written out as, and publishing ───

  /**
   * Write the deck out as a file, for the palette's hand-over rows
   * (PRESENTING) — `{ kind }`, one of EXPORT_KINDS.
   *
   * `decklight pptx` and `decklight pdf` need Node and a headless Chrome,
   * so the deck cannot do this itself — the same reason `A` asks the
   * server to run an agent. The work is the commands' own `main`s,
   * unchanged, so what a row writes is exactly what the command line
   * writes.
   *
   * Four things this route owes the session it is running inside:
   *
   * - it must not TAKE THE SERVER DOWN. `chromeBin` exits the process when
   *   there is no browser — correct for a one-shot command, fatal here, so
   *   Chrome is resolved with the non-fatal `findChrome` first and a machine
   *   without one gets a sentence instead of a dead edit server.
   * - it must not run twice at once. Two exports write the same path
   *   through two browsers; the second caller is told to wait. ONE flag for
   *   every kind, deliberately: two different exports at once is still two
   *   browsers on one machine, and the second would only be slower.
   * - it must not block. Both `main`s are async all the way down (pptx
   *   serves the deck from THIS process while Chrome fetches it; pdf is
   *   async so the session stays answerable while Chrome prints), so live
   *   reload, the SSE stream and every other route keep answering while a
   *   slide renders. That is also why a row can say "rendering…" and mean it.
   * - it must SAY WHERE IT IS. An export is tens of seconds, so each slide
   *   is announced on the `export` channel of the same SSE stream the agent
   *   chip rides, and the deck rewrites its one progress row from it.
   */
  async function exportRoute({ url, body, json }) {
    const req = JSON.parse(body || '{}');
    const kind = req.kind ?? 'pptx';
    const job = EXPORT_KINDS[kind];
    if (!job) {
      return json(400, { ok: false, error: `not a file this server writes: ${kind} — try ${Object.keys(EXPORT_KINDS).join(', ')}` });
    }
    // The theme on screen, which the render is told because it cannot see the
    // browser's pick (#547): a name — what `--theme` takes — or, for a theme
    // that lives only in that browser, its tokens as `--gen` takes them
    // (base64url JSON, the form `?gen=` loads; the runtime vets every token).
    if (req.theme != null && !(typeof req.theme === 'string' && THEME_NAME.test(req.theme))) {
      return json(400, { ok: false, error: 'the theme is a theme name' });
    }
    if (req.gen != null && !(typeof req.gen === 'string' && GEN_THEME.test(req.gen))) {
      return json(400, { ok: false, error: 'the generated theme is base64url, at most 16 KB' });
    }
    if (req.theme != null && req.gen != null) return json(400, { ok: false, error: 'one theme — a name or a generated one' });
    if (kind === 'bundle') {
      // A bundle EMBEDS its themes, and a generated one is tokens in this
      // browser with no file to embed. Bundling in the configured theme
      // instead would hand over a file that does not look like the screen.
      if (req.gen != null) {
        return json(400, { ok: false, error: 'a generated theme lives only in this browser — save it (⌃⇧T) and add it with decklight theme add to bundle it' });
      }
      if (alreadyOneFile(readDeck())) {
        return json(409, { ok: false, error: 'this deck is already one file — send it as it is' });
      }
    }
    const unmarked = await unmarkedOnScreen(req.theme, { carried: kind === 'bundle' });
    if (unmarked) return json(409, { ok: false, unmarked, error: `${unmarked} is not marked for this deck` });
    const themed = req.theme ? ['--theme', req.theme] : req.gen ? ['--gen', req.gen] : [];
    if (kind === 'video') {
      const bad = videoExportProblem(req, dirname(deckPath));
      if (bad) return json(400, { ok: false, error: bad });
    }
    if (exporting) return json(409, { ok: false, error: 'an export is already running' });
    const { findChrome } = await import('../tools/chrome.mjs');
    // every file but the bundle is a render; the bundle launches no browser
    if (kind !== 'bundle' && !findChrome()) {
      return json(503, { ok: false, error: 'no Chrome found — install one, or point $CHROME at it' });
    }
    exporting = true;
    const started = Date.now();
    console.log(`  export: ${basename(deckPath)} → ${job.what}${req.slides ? ` of slides ${req.slides}` : ''}`
      + `${req.synthesize ? `, voiced by ${req.synthesize.engine} into ${req.synthesize.dir}/` : ''} …`);
    broadcast('export', { state: 'start', kind, what: job.what });
    try {
      let out, code, reason = null, subs = null;
      if (kind === 'video') {
        const { videoOut, videoProgress, voiceoverProgress, subtitlesOut } = await import('../tools/video.mjs');
        out = videoOut(deckPath, req.slides || null, req.format || 'mp4');
        subs = req.subtitles === 'file' ? subtitlesOut(out, req.format || 'mp4') : null;
        // Two phases, each told apart on the channel: voicing is minutes on a
        // cloud engine, and a row that said "rendering" through all of it would
        // read as stuck on slide one.
        if (req.synthesize) {
          ({ code, reason } = await runTool('voiceover', await voiceoverArgv(req),
            voiceoverProgress((n, of) => broadcast('export', { state: 'slide', kind, phase: 'voice', n, of }))));
        }
        if (!code) {
          const narration = req.synthesize?.dir ?? req.narration ?? null;
          ({ code, reason } = await runTool('video', [deckPath, '-o', out, ...themed,
            ...(req.slides ? ['--slides', req.slides] : []),
            ...(req.format ? ['--format', req.format] : []),
            ...(req.quality ? ['--quality', req.quality] : []),
            ...(req.subtitles ? ['--subtitles', req.subtitles] : []),
            ...(narration ? ['--narration', resolve(dirname(deckPath), narration)] : req.silent ? ['--no-narration'] : []),
            // the card showed the track as recorded from older notes and it was picked anyway (#536)
            ...(req.allowStale === true ? ['--allow-stale'] : [])],
          videoProgress((n, of) => broadcast('export', { state: 'slide', kind, phase: 'render', n, of }))));
        }
      } else if (kind === 'bundle') {
        // The CLI's own name for the file, beside the deck, so the row and
        // `decklight bundle` write the same one; `audio` is its --audio
        // ('original', 'aac' or 'opus'), the recorded voice carried inside.
        // bundleMain returns nothing on success and throws a sentence on a
        // refusal — the catch below says it.
        const { bundleMain } = await import('./bundle.mjs');
        const { AUDIO_CHOICES } = await import('./bundle-audio.mjs');
        out = join(dirname(deckPath), `${basename(deckPath).replace(/\.html?$/i, '')}-standalone.html`);
        code = (await bundleMain([deckPath, '-o', out, ...(req.theme ? ['--theme', req.theme] : []),
          ...(AUDIO_CHOICES.includes(req.audio) ? ['--audio', req.audio] : [])])) ?? 0;
      } else if (kind === 'pptx') {
        const { pptxMain, pptxOut } = await import('./pptx-export.mjs');
        out = pptxOut(deckPath);
        code = await pptxMain([deckPath, ...themed], {
          log: (line) => console.log(`  ${line}`),
          onSlide: (n, of) => broadcast('export', { state: 'slide', kind, n, of }),
        });
      } else {
        const { pdfMain, pdfOut } = await import('./pdf.mjs');
        out = pdfOut(deckPath, null, job.variant);
        code = await pdfMain([deckPath, ...themed, ...(job.variant ? [`--${job.variant}`] : [])]);
      }
      const file = relative(process.cwd(), out) || basename(out);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (code !== 0) {
        broadcast('export', { state: 'done', kind, ok: false });
        return json(500, { ok: false, error: reason ?? 'the export refused — see the edit server\'s output' });
      }
      // A render with nothing spoken writes no subtitles and says so; the deck
      // is told of a file only when there is one to open.
      const voiced = {
        ...(req.synthesize ? { voiced: req.synthesize.dir } : {}),
        ...(subs && existsSync(subs) ? { subtitles: relative(process.cwd(), subs) || basename(subs) } : {}),
      };
      broadcast('export', { state: 'done', kind, ok: true, file, seconds, ...voiced });
      return json(200, { ok: true, kind, what: job.what, file, seconds, ...voiced });
    } catch (e) {
      // A render that hangs or a Chrome that dies is the export's problem,
      // never the session's: the message goes back to the palette and the
      // server carries on serving the deck.
      console.log(`  export: ${job.what} failed — ${oneline(e)}`);
      broadcast('export', { state: 'done', kind, ok: false, error: oneline(e) });
      return json(500, { ok: false, error: oneline(e) });
    } finally {
      exporting = false;
    }
  }

  /**
   * `decklight video` (and `decklight voiceover` before it, when the export
   * voices its slides), run as CHILDREN rather than through their `main`s like
   * the other exports: both end in `process.exit` on every refusal, and each
   * would take this session down or freeze it. A child keeps that where it
   * belongs, and its output is read line by line for the progress it already
   * prints.
   *
   * Served from the same root `pptx` picks: the current directory when the deck
   * is under it, its own directory otherwise.
   */
  function runTool(name, argv, onLine) {
    const script = fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url));
    const cwd = deckPath.startsWith(process.cwd() + sep) ? process.cwd() : dirname(deckPath);
    return new Promise((done) => {
      const child = spawn(process.execPath, [script, ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let pending = '', err = '';
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        for (let i; (i = pending.indexOf('\n')) >= 0;) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          console.log(`  ${line}`);
          onLine(line);
        }
      });
      child.stderr.on('data', (chunk) => { err += chunk; process.stdout.write(String(chunk).replace(/^/gm, '  ')); });
      child.on('error', (e) => done({ code: 1, reason: oneline(e) }));
      child.on('close', (code) => {
        // the command's own refusal is the sentence the deck shows
        const said = err.split('\n').map((l) => l.trim()).filter(Boolean);
        const prefix = `decklight ${name}:`;
        const refusal = said.findLast((l) => l.startsWith(prefix)) ?? said.at(-1);
        done({ code, reason: code === 0 ? null : (refusal?.replace(prefix, '').trim() ?? null) });
      });
    });
  }

  /**
   * argv for voicing an export: the live voice the deck is speaking with, as
   * `decklight voiceover` spells it. The deck sends what only it knows — the
   * engine and model the bridge answered with, the voice and tone picked in V —
   * and the rest comes from where the bridge itself reads it (the environment,
   * then ~/.config/decklight/tts.json for the same engine), so a sentence
   * already heard live is a cache hit here and not a second bill.
   */
  async function voiceoverArgv({ slides, synthesize: s }) {
    const { loadTtsConfig } = await import('../tools/tts-setup.mjs');
    const { piperModelDir } = await import('../tools/tts-engines.mjs');
    const saved = loadTtsConfig();
    const savedFor = saved?.engine === s.engine ? saved : null;
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? saved?.project;
    const dataDir = savedFor?.dataDir ?? (s.engine === 'piper' ? piperModelDir() : null);
    return [deckPath, '-o', resolve(dirname(deckPath), s.dir), '--engine', s.engine,
      ...(s.voice ? ['--voice', s.voice] : []),
      ...(s.style ? ['--style', s.style] : []),
      ...(s.model ? ['--tts-model', s.model] : []),
      ...(savedFor?.format ? ['--tts-format', savedFor.format] : []),
      ...(dataDir ? ['--data-dir', dataDir] : []),
      ...(project && (s.engine === 'gemini' || s.engine === 'chirp') ? ['--project', project] : []),
      ...(slides ? ['--slides', slides] : [])];
  }

  /**
   * Publish the deck — and, before that, say where to (PRESENTING).
   *
   * The one row in the palette that reaches OFF this machine. Everything
   * else the deck can ask this server for writes a file beside it; this
   * pushes a page the world can read, and `Z` does not take that back. So
   * it is two routes, not one: the deck asks for the PLAN, shows a person
   * the remote and the URL, and only posts after a second, deliberate
   * press. The arming lives in the deck, not here — an unarmed POST
   * publishes, exactly as the command line does, because a confirmation
   * belongs to the surface that can show somebody what they are agreeing
   * to.
   *
   * `GIT_TERMINAL_PROMPT=0` matters more here than anywhere else: publish
   * pushes with a synchronous git, so a credential prompt would not be
   * asking anybody anything — it would hang the write-mode session on a
   * terminal nobody is looking at.
   */
  async function publishPlanRoute({ json }) {
    if (!gitOn) return json(409, { ok: false, error: 'git is off for this session — there is nothing to publish from' });
    const remote = remoteState(root);
    if (!remote.url) {
      return json(409, { ok: false, error: `nowhere to publish to — ${remoteLine(remote) || remote.state}` });
    }
    const { pagesUrl } = await import('./publish.mjs');
    // Whether it COULD sign is part of the plan, not a failure after the
    // fact: publish signs by default and refuses rather than publishing
    // unsigned (INTEGRITY), and the deck would otherwise show somebody a
    // URL, take their confirmation, and only then say it cannot.
    //
    // The SENTENCE is built here, not in the deck. The runtime must never
    // so much as name the signing client (test/sign.test.mjs greps src/
    // and dist/ for it — the invariant is that the browser never reaches
    // for it), so the server hands over words the deck only has to show.
    const { loadClient, INSTALL_HINT } = await import('./sign.mjs');
    const canSign = Boolean(await loadClient());
    return json(200, {
      ok: true, remote: remote.remote, branch: 'gh-pages',
      url: pagesUrl(remote.url), bundled: !alreadyOneFile(readDeck()),
      signing: canSign,
      why: canSign ? null : `publish signs the deck first, and that client is not installed — ${INSTALL_HINT}`,
    });
  }

  async function publishRoute({ body, json }) {
    if (!gitOn) return json(409, { ok: false, error: 'git is off for this session — there is nothing to publish from' });
    if (publishing) return json(409, { ok: false, error: 'a publish is already running' });
    // The theme on screen is the one the page opens on (SPEC THEME_DISTRIBUTION)
    // — the same question the export card answers, asked the same way.
    const { theme = null } = JSON.parse(body || '{}');
    if (theme != null && !(typeof theme === 'string' && THEME_NAME.test(theme))) {
      return json(400, { ok: false, error: 'the theme is a theme name' });
    }
    const unmarked = await unmarkedOnScreen(theme);
    if (unmarked) return json(409, { ok: false, unmarked, error: `${unmarked} is not marked for this deck` });
    publishing = true;
    const before = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = '0';
    console.log(`  publish: ${basename(deckPath)} → gh-pages …`);
    try {
      const { publishMain } = await import('./publish.mjs');
      // A deck that is already one file has nothing to flatten, and the
      // bundler rightly refuses it — the same two cases `decklight
      // publish` has, decided here rather than made the presenter's
      // problem. Everything else is the command's own default, signature
      // included.
      const oneFile = alreadyOneFile(readDeck());
      const args = [deckPath, ...(oneFile ? ['--no-bundle'] : theme ? ['--theme', theme] : [])];
      const r = await publishMain(args);
      console.log(`  publish: ${r.url ?? `${r.remote} ${r.branch}`}`);
      return json(200, { ok: true, url: r.url ?? null, branch: r.branch, remote: r.remote, commit: r.commit });
    } catch (e) {
      console.log(`  publish: refused — ${oneline(e)}`);
      return json(500, { ok: false, error: oneline(e) });
    } finally {
      process.env.GIT_TERMINAL_PROMPT = before ?? '';
      if (before === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      publishing = false;
    }
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
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is editing the deck — wait for it to finish` });
    const name = agent ?? agentPref ?? null;
    const cmd = agentAsk(name, 'x');
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(name, agents) });
    const { enhanceDeck, applyEnhanced, enhanceable, KINDS } = await import('./enhance.mjs');
    const verb = KINDS[kind].done;
    const html = readDeck();
    const of = enhanceable(html, which).length;
    if (!of) return json(422, { ok: false, error: which?.length === 1 ? `slide ${which[0]} has no notes to enhance` : 'no notes to enhance' });
    enhancing = { of, done: 0 };
    broadcast('enhance', { state: 'start', of, agent: cmd.name, kind });
    console.log(`  enhance: ${of} slide${of === 1 ? '' : 's'}${kind === 'spoken' ? ', written for the ear' : ''} ← ${cmd.name} (read-only)`);
    enhanceDeck(html, which, {
      kind, agent: name, cwd: dirname(deckPath),
      onSlide: (r) => {
        enhancing.done = r.done;
        broadcast('enhance', { state: 'slide', ...r });
        console.log(`  enhance: slide ${r.slide} ${r.ok ? (r.changed ? verb : 'unchanged') : `left as it was — ${r.why}`}`);
      },
    }).then(({ answers, results }) => {
      let stale = [];
      // against the deck as it is NOW: a slide edited while the agent thought keeps the edit
      applyEdit((cur) => { const a = applyEnhanced(cur, answers); stale = a.stale; return a.html; });
      const changed = results.filter((r) => r.changed && !stale.includes(r.slide)).map((r) => r.slide);
      const failed = results.filter((r) => !r.ok).map(({ slide, why }) => ({ slide, why }));
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: true, changed, failed, stale, kind });
      console.log(`  enhance: done — ${changed.length} ${verb}${failed.length ? `, ${failed.length} left as they were` : ''}`);
    }).catch((e) => {
      enhancing = null;
      broadcast('enhance', { state: 'done', ok: false, error: oneline(e), kind });
    });
    return json(200, { ok: true, of, agent: cmd.name, label: cmd.label, kind });
  }

  // The notes editor's one box, enhanced without touching the file: the text
  // goes to the agent (read-only) and comes back checked, for the author to
  // read and save — or not. Nothing here writes; ⌘⏎ in the editor does.
  async function enhanceTextRoute({ body, json }) {
    const { text, agent, kind: asked } = JSON.parse(body);
    const kind = asked === 'spoken' ? 'spoken' : 'tags';
    if (typeof text !== 'string') throw new Error('bad payload');
    if (!text.trim()) return json(422, { ok: false, error: `nothing to ${kind === 'spoken' ? 'rewrite' : 'enhance'} — the notes are empty` });
    const name = agent ?? agentPref ?? null;
    const cmd = agentAsk(name, 'x');
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(name, agents) });
    const { enhanceText } = await import('./enhance.mjs');
    console.log(`  enhance: the notes editor's text${kind === 'spoken' ? ', written for the ear' : ''} ← ${cmd.name} (read-only)`);
    const r = await enhanceText(text, { kind, agent: name, cwd: dirname(deckPath) });
    return r.ok
      ? json(200, { ok: true, text: r.text, changed: r.changed, agent: cmd.name, label: cmd.label })
      : json(422, { ok: false, error: r.why, agent: cmd.name });
  }

  function agentRoute({ body, json }) {
    const { prompt, agent, message, slide } = JSON.parse(body);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('bad payload');
    if (agentJob) return json(409, { ok: false, error: `${agentJob.agent} is already running` });
    const cmd = runAgent(prompt.trim(), agent, message, slide);
    if (!cmd) return json(400, { ok: false, error: agentUnavailable(agent ?? agentPref, agents) });
    return json(200, { ok: true, agent: cmd.name, label: cmd.label });
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

    'GET /deck/edit/commit': commitStatusRoute,
    'POST /deck/edit/commit': commitRoute,
    'POST /deck/edit/commit/subject': commitSubjectRoute,
    'POST /deck/edit/commit/dismiss': commitDismissRoute,
    'GET /deck/edit/history': historyRoute,
    'GET /deck/edit/history/at': deckAtRoute,
    'POST /deck/edit/restore': restoreRoute,

    // the owner's half of a review (REVIEW): registered here alone, beside
    // the routes both servers share
    'GET /deck/review/incoming': reviewIncomingRoute,
    'GET /deck/review/at': reviewAtRoute,
    'POST /deck/review/done': reviewDoneRoute,

    'GET /deck/edit/theme/browse': themeBrowseRoute,
    'POST /deck/edit/theme/add': themeAddRoute,
    'POST /deck/edit/theme/mark': themeMarkRoute,
    'GET /deck/edit/design-system/browse': designSystemBrowseRoute,
    'POST /deck/edit/design-system/mark': designSystemMarkRoute,
    'POST /deck/edit/design-system/apply': designSystemApplyRoute,
    'GET /deck/edit/font/browse': fontBrowseRoute,
    'POST /deck/edit/font/mark': fontMarkRoute,
    'GET /deck/edit/wizard': wizardSchemaRoute,
    'POST /deck/edit/wizard': wizardConfigureRoute,
    'POST /deck/edit/wizard/forget': wizardForgetRoute,

    'GET /deck/edit/template/browse': templateListRoute,
    'GET /deck/edit/template/slides': templateSlidesRoute,
    'GET /deck/edit/template/preview': templatePreviewRoute,
    'POST /deck/edit/template/apply': templateApplyRoute,
    'POST /deck/edit/template/add': templateAddRoute,
    'POST /deck/edit/template/insert': templateInsertRoute,

    'POST /deck/edit/narration/record': recordRoute,
    'GET /deck/edit/narration/tracks': tracksRoute,

    'POST /deck/edit/export': exportRoute,
    'GET /deck/edit/export/estimate': exportEstimateRoute,
    'GET /deck/edit/publish/plan': publishPlanRoute,
    'POST /deck/edit/publish': publishRoute,

    'POST /deck/edit/agent': agentRoute,
    'POST /deck/edit/agent/prefer': agentPreferRoute,
    'POST /deck/edit/enhance': enhanceRoute,
    'POST /deck/edit/enhance/text': enhanceTextRoute,
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
  // a clone whose branch tracks something (READ_ONLY#UPSTREAM): on a deck you
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

  // What read-only mode refuses, by name: everything that writes the deck or
  // reaches a bridge, and the review owner's half. The lock is write mode's
  // own switch and refuses with the rest. A deck opened read-only used to be
  // served by a process in which none of this was registered; now it is one
  // server, and the refusal is the mode's — a 403 that says which mode would
  // answer, rather than a 405 that pretends the route is unknown.
  const WRITE_FAMILY = (pathname) => pathname.startsWith('/deck/edit/')
    || pathname === '/deck/tts' || pathname.startsWith('/deck/tts/') || pathname.startsWith('/deck/lipsync/')
    || pathname === '/deck/review/incoming' || pathname === '/deck/review/at' || pathname === '/deck/review/done';

  // Two static servers for one root, chosen per request by the mode. Write
  // mode serves the cwd with the deck at "/" and an author's exotic asset as
  // octet-stream. Read-only mode refuses every extension the MIME table does
  // not name (a file beside a travelled deck that is none of them — `id_rsa`,
  // a `.pem`, a database — is only ever fetched to be exfiltrated), rewrites
  // every html page on its way out (strict, then the chrome), and has no
  // index: "/" is the deck, answered from memory before this is consulted.
  const files = staticFiles(root, { index: deckUrl });
  const auditedFiles = staticFiles(root, { html: rewrite, knownTypesOnly: true });
  const server = createServer(async (req, res) => {
    // Read-only mode: the policy on EVERY response this server writes — the
    // deck and its assets, but also the 403/404/405 pages, the control-
    // channel JSON and SSE, and the remote controller. Set before anything
    // runs, and writeHead merges it under whatever a route names itself, so
    // "every response carries the header" holds by construction.
    if (readOnly) res.setHeader('content-security-policy', CSP);
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
      // read-only mode: nothing that writes answers, whatever it was aimed at
      if (readOnly && WRITE_FAMILY(url.pathname)) {
        return json(403, { ok: false, readOnly: true, error: 'this deck is open read-only — nothing here changes it' });
      }
      // locked: no edit route writes, whatever it was aimed at — the one
      // POST that still answers is the lock itself, so it can be lifted
      if (locked && req.method === 'POST' && url.pathname.startsWith('/deck/edit/') && url.pathname !== '/deck/edit/lock') {
        return json(423, { ok: false, locked: true, error: 'editing is locked — unlock it from the palette or the lock chip' });
      }
      const key = `${req.method} ${url.pathname}`;
      const prefixed = routes.has(key) ? null
        : PREFIX_ROUTES.find((r) => r.method === req.method && url.pathname.startsWith(r.prefix));
      const handler = routes.get(key) ?? prefixed?.handler;
      if (handler && (BEFORE_BODY.has(key) || prefixed?.beforeBody)) return await handler({ req, res, url, json, CORS });
      // Read for every POST, matched or not — an oversized body is refused
      // whatever it was aimed at, exactly as the chain refused it.
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
      }
      if (handler) return await handler({ req, res, url, body, json, CORS });
      // ── the deck and the files beside it ──────────────────────────────
      // Read-only mode answers the deck's own path from the audited bytes
      // (servePayload above). For a container that also means the URL a
      // person sees is the file they double-clicked — serving the raw archive
      // bytes there would hand a browser something it cannot render.
      if (readOnly) {
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
  // `decklight record` runs this same server in-process and needs to know
  // WHICH port it ended up on (a taken --port moves to the next free one) and
  // to print its own banner instead of the authoring one.
  if (onListen) onListen({ port: actual, deckUrl, server });
  else if (readOnly) {
    // Before the first slide renders, not after — the point of the label is
    // to be able to decide not to open it. The audience is looking at the
    // deck; none of this goes on the page.
    console.log(`decklight · ${basename(deckPath)} on http://127.0.0.1:${actual}${deckUrl} — read-only, CSP enforced. Ctrl-C stops`);
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
      keys: 'E edit · L layouts · Z undo · A agent · Ctrl-C stops',
    }));
  } else console.log(`decklight · ${basename(deckPath)} on http://127.0.0.1:${actual}${deckUrl} — E element edit mode, L layouts, Z undo, A agent. Ctrl-C stops`);
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
  if (!onListen && !readOnly) {
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
