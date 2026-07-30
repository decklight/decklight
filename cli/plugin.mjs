#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight plugin` — the presenter's own chrome, installed from a
 * marketplace and loaded by `present` (MARKETPLACE.md PRESENT#PLUGINS).
 *
 *   decklight plugin add    <name[@marketplace]>
 *   decklight plugin list
 *   decklight plugin check  <name | directory>
 *   decklight plugin remove <name>
 *
 * WHY THIS IS ALLOWED TO EXIST AT ALL. The asymmetry MARKETPLACE.md WHY is
 * built on: a plugin is safe when the installer is the risk-bearer, and unsafe
 * when it travels to an audience that consented to nothing. A presenter plugin
 * never travels. It lives here, under the config home, and `bundle` cannot see
 * it — nothing in this file is imported by the build.
 *
 * THE SCOPE RULE, AND WHERE IT IS ACTUALLY ENFORCED. Scope is **chrome only**:
 * a plugin may add a timer, a teleprompter, a confidence monitor, and may not
 * touch slide content. Otherwise a deck stops being a deterministic artifact
 * and two people presenting the same file are presenting different decks.
 *
 * That rule is kept by the browser, not by this module:
 *
 *   1. STRUCTURE (the boundary). A plugin's code runs inside
 *      `<iframe sandbox="allow-scripts" srcdoc=…>`. No `allow-same-origin`, so
 *      the frame gets an **opaque origin** and `parent.document` throws
 *      `SecurityError`. There is no handle to a slide to misuse — not a rule
 *      about reaching for one, an inability to.
 *   2. DECLARATION (the named refusal). `plugin.json` is checked against a
 *      CLOSED vocabulary, the way the wizard's field types are closed (SPEC
 *      ENGINES#WIZARD: core renders, a plugin only declares). A manifest that
 *      asks for slide content is refused out loud, before anything loads.
 *   3. LINT (a courtesy, and labelled as one below). `pluginLint` greps for
 *      the reaches that only make sense against the deck's document. Those
 *      already fail at run time under (1); catching them here turns a silent
 *      `SecurityError` in someone's console into a message at install time.
 *      This layer carries **none** of the safety. Deleting it would not widen
 *      what a plugin can do, and it should never be described as if it would.
 *
 * WHAT IT COSTS THE DECK: nothing. The chrome is injected on the way OUT of
 * the presenting server, after the ingredients label has already read the
 * bytes on disk (PRESENT#AUDIT) and after strict mode has stripped what it
 * could not account for (PRESENT#STRICT) — so a plugin is never audited as if
 * it came from the deck, and never stripped as if it were unaccounted. The
 * srcdoc frame needs no route and no CSP change (see `chromeMarkup`).
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { isMain } from '../tools/args.mjs';
// Cache reads only. `loadCatalog` and `resolveEntry` read JSON already on
// disk; the fetching half of marketplace.mjs is deliberately not imported
// here, because `present` imports this file and a presenting path that COULD
// fetch a catalog breaks registered-not-fetched (SPEC MARKETPLACE_REGISTRY) —
// a deck on a plane has to behave exactly like a deck at a desk. The one
// network call in this module is `fetchPlugin`, which is an ARTIFACT fetch on
// an explicit `plugin add`; `resolveSource` is imported dynamically there so
// it is not even resolved on the serving path.
import {
  configHome, loadRegistry, loadCatalog, resolveEntry, MarketplaceError, NAME_RE,
} from './marketplace.mjs';

/** A failure with a message for a human — the mains print it, never a stack. */
export class PluginError extends Error {}

/** Where a presenter's own library lives (OPEN 3 resolved: `~/.decklight/`). */
export const pluginsDir = (home = configHome()) => join(home, 'plugins');

// ── the manifest vocabulary, closed on purpose ─────────────────────────────

/**
 * Where a plugin's frame may sit. A closed list rather than free CSS, for the
 * reason the wizard's field types are closed: "chrome only" is enforceable
 * exactly as long as a plugin cannot place its own markup over a slide. An
 * arbitrary `top`/`left`/`width` would let a plugin cover the stage, which is
 * not transforming content but is indistinguishable from it to the room.
 */
export const SLOTS = ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br', 'edge-top', 'edge-bottom'];

/**
 * What a plugin may be told. `position` is the deck's place in itself;
 * `notes` is the current slide's speaker notes.
 *
 * Notes ARE deck text, and letting them cross is a deliberate call rather than
 * an oversight: a teleprompter is named in-scope chrome and a teleprompter
 * without the deck's notes is a text box. Reading is not transforming — the
 * determinism rule is about mutation, and the speaker view already puts these
 * exact words on this exact machine. What keeps it honest is that it is
 * DECLARED: a plugin gets notes only by asking for them in its manifest, and
 * both `plugin list` and the `present` startup line say which plugins read
 * them. A timer never sees a word of the talk.
 */
export const NEEDS = ['position', 'notes'];

/** Every key a manifest may carry. Anything else is refused, never ignored. */
export const MANIFEST_KEYS = ['name', 'title', 'slot', 'needs', 'version', 'description', 'width', 'height'];

// A frame big enough to be a teleprompter and too small to be a slide. The
// clamp is the same argument as the slot list: chrome that can fill the
// viewport is a cover, whatever its manifest calls it.
export const SIZE_LIMITS = { width: [40, 640], height: [24, 480] };
const DEFAULT_SIZE = { width: 200, height: 96 };

/**
 * Validate a manifest object. Returns `{ ok, manifest, errors }`, where every
 * error is a `{ field, msg }` a human can act on — the refusal has to NAME the
 * reason, or the scope rule is back to being documentation.
 */
export function validateManifest(data, { name: dirName } = {}) {
  const errors = [];
  const err = (field, msg) => errors.push({ field, msg });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, manifest: null, errors: [{ field: '(top level)', msg: 'must be a JSON object' }] };
  }

  for (const key of Object.keys(data)) {
    if (!MANIFEST_KEYS.includes(key)) {
      // Refused rather than ignored, for the wizard's reason (ENGINES#WIZARD):
      // a silently dropped key is a plugin asking for less than its author
      // believed it was asking for.
      err(key, `unknown key — a plugin manifest carries only: ${MANIFEST_KEYS.join(', ')}`);
    }
  }

  if (data.name === undefined) err('name', 'missing — the name the library files it under');
  else if (typeof data.name !== 'string' || !NAME_RE.test(data.name)) {
    err('name', `${JSON.stringify(data.name)} — letters, digits, - and _ only`);
  } else if (dirName && data.name !== dirName) {
    err('name', `"${data.name}" does not match the directory it lives in ("${dirName}")`);
  }

  if (data.slot === undefined) err('slot', `missing — where the chrome sits: ${SLOTS.join(', ')}`);
  else if (!SLOTS.includes(data.slot)) {
    err('slot', `${JSON.stringify(data.slot)} — not a slot. Chrome sits in one of: ${SLOTS.join(', ')}.`
      + ' The list is closed so that a plugin cannot place itself over the slides');
  }

  if (data.needs !== undefined) {
    if (!Array.isArray(data.needs)) err('needs', `must be an array of: ${NEEDS.join(', ')}`);
    else {
      for (const n of data.needs) {
        if (NEEDS.includes(n)) continue;
        // The refusal the ticket is actually about. It has to say WHY, because
        // the author of a refused plugin is the only person who can fix it.
        err('needs', `${JSON.stringify(n)} — a presenter plugin is chrome only, and may ask for: ${NEEDS.join(', ')}.`
          + ' It cannot reach slide content: a deck has to stay a deterministic artifact,'
          + ' or two people presenting the same file are presenting different decks.'
          + ' (Its code runs in a sandboxed frame with an opaque origin, so this would'
          + ' fail at run time regardless — refused here so it fails where you can read it.)');
      }
    }
  }

  for (const dim of ['width', 'height']) {
    if (data[dim] === undefined) continue;
    const [lo, hi] = SIZE_LIMITS[dim];
    if (typeof data[dim] !== 'number' || !Number.isFinite(data[dim])) err(dim, 'must be a number of CSS pixels');
    else if (data[dim] < lo || data[dim] > hi) {
      err(dim, `${data[dim]} — outside ${lo}–${hi}px. Chrome that can fill the viewport is a cover over the slides`);
    }
  }

  for (const s of ['title', 'version', 'description']) {
    if (data[s] !== undefined && typeof data[s] !== 'string') err(s, 'must be a string');
  }

  return { ok: errors.length === 0, manifest: errors.length ? null : normalize(data), errors };
}

const normalize = (data) => ({
  ...DEFAULT_SIZE,
  needs: ['position'],
  title: data.name,
  ...data,
});

/** Parse + validate a `plugin.json` text. */
export function readManifest(raw, opts) {
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    return { ok: false, manifest: null, errors: [{ field: '(json)', msg: String(e.message).replace(/ in JSON.*$/, '') }] };
  }
  return validateManifest(data, opts);
}

// ── the lint, which is a courtesy and not the boundary ─────────────────────

/**
 * Reaches that only make sense against the DECK's document, and therefore
 * only make sense from a plugin that misunderstood where it runs.
 *
 * Say it plainly: every one of these already throws `SecurityError` inside the
 * sandbox. This list exists so the author sees a sentence instead of a console
 * they are not looking at during a talk. It is not a security control, it is
 * not exhaustive, and no amount of adding to it would make it one — the
 * opaque origin is what does the work.
 */
const LINT = [
  [/\bparent\s*\.\s*(document|location|frames|Decklight)/, 'reaches into the parent document'],
  [/\btop\s*\.\s*(document|location)/, 'reaches into the top-level document'],
  [/\.decklight-stage\b/, 'names the slide stage'],
  [/\baside\.notes\b/, 'reads notes out of the DOM (declare `needs: ["notes"]` instead)'],
];

/** `[{ line, why, text }]` for a plugin source — empty when nothing matched. */
export function pluginLint(js) {
  const out = [];
  js.split('\n').forEach((text, i) => {
    for (const [re, why] of LINT) {
      if (re.test(text)) out.push({ line: i + 1, why, text: text.trim().slice(0, 90) });
    }
  });
  return out;
}

// ── loading a presenter's library ──────────────────────────────────────────

/**
 * One installed plugin, or a `PluginError` naming what is wrong with it.
 * `dir` may be anywhere — `plugin check` points it at a working copy.
 */
export function loadPlugin(dir) {
  const name = basename(dir);
  const manifestPath = join(dir, 'plugin.json');
  const sourcePath = join(dir, 'plugin.js');
  if (!existsSync(manifestPath)) throw new PluginError(`${name}: no plugin.json in ${dir}`);
  if (!existsSync(sourcePath)) throw new PluginError(`${name}: no plugin.js in ${dir}`);

  const v = readManifest(readFileSync(manifestPath, 'utf8'), { name });
  if (!v.ok) {
    throw new PluginError(`${name}: plugin.json is not a usable manifest:\n`
      + v.errors.map((e) => `    ${e.field} — ${e.msg}`).join('\n'));
  }
  const source = readFileSync(sourcePath, 'utf8');
  const lint = pluginLint(source);
  if (lint.length) {
    throw new PluginError(`${name}: plugin.js reaches outside its frame:\n`
      + lint.map((l) => `    line ${l.line}: ${l.why}\n      ${l.text}`).join('\n')
      + '\n    A presenter plugin renders chrome in a sandboxed frame with an opaque origin;'
      + '\n    the deck\'s document is not reachable from it, so this cannot work. Ask for what'
      + `\n    you need in plugin.json instead: needs: [${NEEDS.map((n) => `"${n}"`).join(', ')}].`);
  }
  return { ...v.manifest, dir, source };
}

/**
 * Every plugin in the presenter's library, and every one that could not be
 * loaded with the reason why.
 *
 * A bad plugin is skipped, never fatal: the alternative is a command that
 * refuses to present a talk because of a timer, ten minutes before the talk —
 * the same argument PRESENT#STRICT settles the same way.
 */
export function loadLibrary(home = configHome()) {
  const dir = pluginsDir(home);
  if (!existsSync(dir)) return { plugins: [], refused: [] };
  const plugins = [];
  const refused = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    try { plugins.push(loadPlugin(p)); } catch (e) {
      if (!(e instanceof PluginError)) throw e;
      refused.push({ name, reason: e.message });
    }
  }
  return { plugins, refused };
}

// ── the chrome, as markup ──────────────────────────────────────────────────

/**
 * Escape for an attribute value. `&` and `"` are the two that matter — with
 * every quote escaped the attribute cannot be closed early, which is what
 * keeps a plugin's source from breaking out into the deck's document.
 *
 * `<` and `>` go too, though an HTML5 attribute value does not require it: a
 * plugin is a whole document quoted inside one attribute, so its text is full
 * of tags, and leaving them raw means anything that ever looks at this file
 * with a regex sees markup that is not markup. Browsers decode the entities
 * before parsing the srcdoc, so the frame gets exactly the document intended.
 */
const attr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The document a plugin actually runs in.
 *
 * Two script blocks: a fixed preamble that gives the plugin its only API, and
 * the plugin. The API is deliberately one-way — `decklight.on(fn)` receives
 * state, and there is nothing to call to ASK the host for anything. A request
 * channel is how a chrome-only surface acquires a second capability later; a
 * relay that only ever pushes has nowhere to grow one.
 */
function frameDoc(plugin) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;height:100%;overflow:hidden;
  font:13px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  color:#fff;background:transparent}
</style><body><script>
(function(){var fns=[],last=null;
window.decklight={slot:${JSON.stringify(plugin.slot)},name:${JSON.stringify(plugin.name)},
  on:function(fn){fns.push(fn);if(last)try{fn(last)}catch(e){}}};
window.addEventListener("message",function(e){
  var d=e.data;if(!d||d.__decklight!==1)return;last=d.state;
  for(var i=0;i<fns.length;i++){try{fns[i](d.state)}catch(err){}}});
})();
</script><script>
${plugin.source}
</script>`;
}

/**
 * The host side: one capture-phase listener set, and a push to every frame.
 *
 * Capture on `document` rather than a listener on `.decklight`, because the
 * engine's events are `CustomEvent`s with the default `bubbles: false`
 * (src/core/engine.js `_emit`) — a capture listener on an ancestor still sees
 * them, and this way the shim needs no handle on a root that may not exist
 * yet when it runs.
 *
 * Nothing here is added to the runtime: `present` injects this, `bundle` never
 * does, and a deck opened any other way has never heard of it.
 */
function hostShim(plugins) {
  const wantsNotes = plugins.filter((p) => p.needs.includes('notes')).map((p) => p.name);
  return `<script>
(function(){
  // Presenter chrome belongs to the one document a presenter is looking at.
  // The deck boots itself into same-origin iframes for the theme picker, the
  // slide finder and the speaker view, and ?print is a page being exported —
  // the same rule the HUD keeps for the clock and the hairline.
  var host=document.querySelector(".decklight-chrome");
  if(!host)return;
  if(window.top!==window.self||/[?&](embedded|print)\\b/.test(location.search)){host.remove();return;}
  var notes=${JSON.stringify(wantsNotes)};
  var frames=[].slice.call(host.querySelectorAll("iframe[data-plugin]"));
  var state={slide:1,step:0,totalSlides:0,elapsed:0};
  var started=null;
  function notesFor(i){
    var secs=document.querySelectorAll(".decklight-stage > section");
    var el=secs[i-1]&&secs[i-1].querySelector("aside.notes");
    return el?el.textContent.trim():"";
  }
  function push(){
    state.elapsed=started==null?0:Date.now()-started;
    for(var i=0;i<frames.length;i++){
      var f=frames[i],w=f.contentWindow;
      if(!w)continue;
      var s=state;
      if(notes.indexOf(f.getAttribute("data-plugin"))>=0){
        s={};for(var k in state)s[k]=state[k];
        s.notes=notesFor(state.slide);
      }
      // "*" is the only possible target: the frame's origin is opaque, so
      // there is no origin string that would ever match it.
      w.postMessage({__decklight:1,state:s},"*");
    }
  }
  document.addEventListener("decklight:ready",function(e){
    state.totalSlides=(e.detail&&e.detail.slides)||0;push();
  },true);
  document.addEventListener("decklight:slide",function(e){
    var d=e.detail||{};
    // Elapsed counts from the FIRST advance, not page load — a deck idling on
    // its title slide while the room fills is not a talk yet (HUD's rule).
    if(started==null)started=Date.now();
    state.slide=d.slide||1;state.totalSlides=d.total||state.totalSlides;state.step=0;push();
  },true);
  document.addEventListener("decklight:build",function(e){
    var d=e.detail||{};state.step=d.index||0;push();
  },true);
  setInterval(push,1000);
  push();
})();
</script>`;
}

/** The stylesheet for the slots. Inline, which `style-src 'unsafe-inline'` already allows. */
const CHROME_CSS = `<style>
.decklight-chrome{position:fixed;inset:0;pointer-events:none;z-index:55}
.decklight-chrome > div{position:absolute;pointer-events:auto}
.decklight-chrome iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}
.decklight-chrome .corner-tl{top:16px;left:16px}
.decklight-chrome .corner-tr{top:16px;right:16px}
.decklight-chrome .corner-bl{bottom:16px;left:16px}
.decklight-chrome .corner-br{bottom:16px;right:16px}
.decklight-chrome .edge-top{top:0;left:50%;transform:translateX(-50%)}
.decklight-chrome .edge-bottom{bottom:0;left:50%;transform:translateX(-50%)}
@media print{.decklight-chrome{display:none}}
</style>`;

/**
 * The whole injection: the slot styles, one sandboxed frame per plugin, and
 * the host shim.
 *
 * WHY THIS NEEDS NO CSP CHANGE, WHICH LOOKS WRONG UNTIL YOU CHECK IT. A
 * `srcdoc` frame is not fetched, so `frame-src` never gets a URL to judge — it
 * runs even under `frame-src 'none'`, verified in headless Chrome
 * (test/plugin-render.mjs). It INHERITS the embedding document's policy
 * instead, and the presenting CSP already carries `script-src 'unsafe-inline'`
 * because a bundled deck IS inline script. So the chrome loads under exactly
 * the header the deck is served with, no route is registered for it, and
 * `present`'s policy string is untouched by a plugin being installed.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` is the load-bearing
 * attribute: it hands the frame an opaque origin, so `parent.document` throws.
 * Adding `allow-same-origin` here would silently undo the entire ticket.
 */
export function chromeMarkup(plugins) {
  if (!plugins.length) return '';
  const frames = plugins.map((p) => `<div class="${p.slot}" style="width:${p.width}px;height:${p.height}px">`
    + `<iframe data-plugin="${attr(p.name)}" title="${attr(p.title)}"`
    + ` sandbox="allow-scripts" srcdoc="${attr(frameDoc(p))}"></iframe></div>`).join('\n');
  return `\n<!-- decklight presenter chrome — the presenter's own, not part of this deck -->\n`
    + `${CHROME_CSS}\n<div class="decklight-chrome">\n${frames}\n</div>\n${hostShim(plugins)}\n`;
}

/**
 * Put the chrome into a served document, immediately before `</body>`.
 *
 * Called by `present` AFTER the audit has read the file and AFTER strict mode
 * has run, which is the whole reason the ingredients label stays honest: the
 * label describes the bytes on disk, and these bytes were never on disk.
 * With no plugins installed this returns its input unchanged — byte for byte,
 * which is what keeps `present` on a machine with an empty library exactly the
 * command it was before this existed.
 */
export function injectChrome(html, plugins) {
  const markup = chromeMarkup(plugins);
  if (!markup) return html;
  const i = html.lastIndexOf('</body>');
  return i < 0 ? html + markup : html.slice(0, i) + markup + html.slice(i);
}

// ── the command ────────────────────────────────────────────────────────────

const USAGE = `usage: decklight plugin <add|list|check|remove> …

  decklight plugin add <name[@marketplace]>
    install a presenter plugin from a registered marketplace into your own
    library under ~/.decklight/plugins/. It is yours: it never enters a deck,
    never travels with one, and bundle cannot see it
    EXAMPLE: decklight plugin add timer
    EXAMPLE: decklight plugin add teleprompter@decklight

  decklight plugin list
    what is installed, where each sits, and which ones read your speaker notes

  decklight plugin check <name | directory>
    validate a plugin without installing it — the same manifest vocabulary and
    the same lint the loader applies. Exits non-zero on a refusal, so a
    plugin's own CI can gate on it

  decklight plugin remove <name>
    delete it from your library

  A plugin is two files. Its code runs in a sandboxed frame with an opaque
  origin, so it can render chrome — a timer, a teleprompter, a confidence
  monitor — and cannot reach the slides. That is structural, not a promise:
  parent.document throws there.

    plugin.json   { "name": "timer", "slot": "corner-br",
                    "needs": ["position"], "width": 150, "height": 44 }

    plugin.js     decklight.on(function (s) {
                    var m = Math.floor(s.elapsed / 60000);
                    document.body.textContent =
                      m + ':' + ('0' + Math.floor(s.elapsed / 1000) % 60).slice(-2)
                      + '  ' + s.slide + '/' + s.totalSlides;
                  });

  decklight.on is the whole API, and it only ever receives: the state comes to
  you and there is nothing to call to ask for more. A plugin that declared
  "notes" also gets s.notes for the current slide.

  Scope is chrome only. A manifest that asks for slide content is refused by
  name, because a deck has to stay a deterministic artifact — otherwise two
  people presenting the same file are presenting different decks.

  slots: ${SLOTS.join(', ')}
  needs: ${NEEDS.join(', ')} — "notes" must be declared, and is named in
         plugin list and at present startup so you know who is reading them

  present loads the library; bundle never does. With nothing installed,
  present behaves exactly as it does with this command absent.
  DECKLIGHT_HOME overrides ~/.decklight/.`;

/** Read a plugin's two files from a resolved source (a URL or a local dir). */
async function fetchPlugin(source, { fetchImpl = fetch } = {}) {
  const one = async (file) => {
    const at = /^https?:\/\//i.test(source) ? `${source.replace(/\/$/, '')}/${file}` : join(resolve(source), file);
    if (/^https?:\/\//i.test(at)) {
      let r;
      try { r = await fetchImpl(at); } catch (e) { throw new PluginError(`could not fetch ${at} — ${e.cause?.code ?? e.message}`); }
      if (!r.ok) throw new PluginError(`${at} — HTTP ${r.status}`);
      return await r.text();
    }
    if (!existsSync(at)) throw new PluginError(`no such file: ${at}`);
    return readFileSync(at, 'utf8');
  };
  return { manifest: await one('plugin.json'), source: await one('plugin.js') };
}

/** Validate a fetched pair the way the loader will, before anything is written. */
function vet(name, files) {
  const v = readManifest(files.manifest, { name });
  if (!v.ok) {
    throw new PluginError(`${name}: plugin.json is not a usable manifest:\n`
      + v.errors.map((e) => `    ${e.field} — ${e.msg}`).join('\n'));
  }
  const lint = pluginLint(files.source);
  if (lint.length) {
    throw new PluginError(`${name}: plugin.js reaches outside its frame:\n`
      + lint.map((l) => `    line ${l.line}: ${l.why}\n      ${l.text}`).join('\n'));
  }
  return v.manifest;
}

async function addMain(args, home) {
  const [ref] = args.filter((a) => !a.startsWith('-'));
  if (!ref) { console.error(`decklight plugin add: needs a plugin name\n\n${USAGE}`); return 1; }

  const reg = loadRegistry(home);
  const catalogs = {};
  for (const name of Object.keys(reg.marketplaces)) {
    const c = loadCatalog(name, home);
    if (c?.ok) catalogs[name] = c.manifest;
  }
  if (!Object.keys(catalogs).length) {
    console.error('decklight plugin add: no marketplace has been fetched yet'
      + ' — decklight marketplace update <name> (registered is not fetched)');
    return 1;
  }

  let hit;
  try { hit = resolveEntry(ref, catalogs); } catch (e) {
    console.error(`decklight plugin add: ${e.message}`);
    return 1;
  }
  if (hit.entry.type !== 'plugin') {
    console.error(`decklight plugin add: ${hit.qualified} is a ${hit.entry.type}, not a plugin`);
    return 1;
  }

  const { resolveSource } = await import('./theme.mjs');
  const src = resolveSource(hit.entry.source, reg.marketplaces[hit.marketplace]?.source);
  let manifest;
  let files;
  try {
    files = await fetchPlugin(src);
    manifest = vet(hit.entry.name, files);
  } catch (e) {
    if (!(e instanceof PluginError)) throw e;
    console.error(`decklight plugin add: ${e.message}`);
    console.error(`\n  ${hit.qualified} was NOT installed`);
    return 1;
  }

  const dir = join(pluginsDir(home), manifest.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), files.manifest);
  writeFileSync(join(dir, 'plugin.js'), files.source);
  console.log(`installed ${manifest.name} from ${hit.qualified} — ${manifest.slot}, reads ${manifest.needs.join(' + ')}`);
  console.log(`  it is yours, not the deck's: decklight present loads it, bundle never will`);
  if (manifest.needs.includes('notes')) console.log('  it reads your speaker notes — it asked, and plugin list says so');
  return 0;
}

function listMain(home) {
  const { plugins, refused } = loadLibrary(home);
  if (!plugins.length && !refused.length) {
    console.log('no presenter plugins installed — decklight plugin add <name>');
    console.log(`  (a plugin is your own chrome: a timer, a teleprompter. It never enters a deck.)`);
    return 0;
  }
  for (const p of plugins) {
    console.log(`${p.name}${p.version ? ` ${p.version}` : ''}  ${p.slot}  ${p.width}×${p.height}`
      + `  reads ${p.needs.join(' + ')}${p.needs.includes('notes') ? '  ← your speaker notes' : ''}`);
    if (p.description) console.log(`  ${p.description}`);
  }
  for (const r of refused) console.log(`${r.name} — REFUSED\n  ${r.reason.replace(/\n/g, '\n  ')}`);
  return refused.length ? 1 : 0;
}

function checkMain(args, home) {
  const [target] = args.filter((a) => !a.startsWith('-'));
  if (!target) { console.error(`decklight plugin check: needs a plugin name or directory\n\n${USAGE}`); return 1; }
  const dir = existsSync(target) ? resolve(target) : join(pluginsDir(home), target);
  if (!existsSync(dir)) { console.error(`decklight plugin check: no such plugin or directory: ${target}`); return 1; }
  let p;
  try { p = loadPlugin(dir); } catch (e) {
    if (!(e instanceof PluginError)) throw e;
    console.error(`✘ ${e.message}`);
    return 1;
  }
  console.log(`✔ ${p.name} — ${p.slot}, ${p.width}×${p.height}, reads ${p.needs.join(' + ')}`);
  console.log(`  its code runs in a sandboxed frame with an opaque origin: it renders chrome, and`);
  console.log(`  cannot reach the slides. present will load it; bundle will not.`);
  return 0;
}

function removeMain(args, home) {
  const [name] = args.filter((a) => !a.startsWith('-'));
  if (!name) { console.error(`decklight plugin remove: which one?\n\n${USAGE}`); return 1; }
  const dir = join(pluginsDir(home), name);
  if (!existsSync(dir)) { console.error(`decklight plugin remove: no plugin "${name}" installed (decklight plugin list)`); return 1; }
  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${name}`);
  return 0;
}

export async function pluginMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  const home = configHome();
  try {
    if (sub === 'add') return await addMain(rest, home);
    if (sub === 'list') return listMain(home);
    if (sub === 'check') return checkMain(rest, home);
    if (sub === 'remove') return removeMain(rest, home);
  } catch (e) {
    if (e instanceof PluginError || e instanceof MarketplaceError) {
      console.error(`decklight plugin ${sub}: ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.error(`decklight plugin: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await pluginMain(process.argv.slice(2)));
