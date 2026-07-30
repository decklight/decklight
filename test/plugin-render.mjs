#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Presenter plugins (MARKETPLACE.md PRESENT#PLUGINS), measured in a real browser.
 *
 * The unit tests prove the manifest vocabulary refuses a plugin that ASKS for
 * slide content. That is the polite half, and on its own it is worth very
 * little: it only ever meets a plugin whose author declared what they were
 * doing. The claim the ticket rests on is the other one — that a plugin which
 * never asked, and whose code the lint never saw, STILL cannot touch a slide.
 * That is not a property of any code in this repo; it is a property of
 * `sandbox="allow-scripts"` without `allow-same-origin`, and only a browser
 * can testify to it.
 *
 * Three pages, because the claims are not all observable the same way:
 *
 *   containment — a real bundled deck, real chrome, a deliberately hostile
 *                 plugin handed straight to `chromeMarkup` so it bypasses both
 *                 `loadPlugin`'s manifest check and its lint. Every reach into
 *                 the deck must throw. All synchronous.
 *   delivery    — the host shim's own wiring: non-bubbling CustomEvents caught
 *                 in the capture phase, the state shape, and `notes` reaching
 *                 ONLY the plugin that declared it.
 *   policy      — a srcdoc frame runs under `frame-src 'none'`, which is why
 *                 loading a plugin needs no CSP widening and no route. It
 *                 looks wrong until you watch it happen, so it is measured.
 *
 * WHY `delivery` DROPS THE SANDBOX, WHICH WOULD OTHERWISE BE ALARMING. Under
 * `--virtual-time-budget` a headless Chrome never advances an OPAQUE-ORIGIN
 * frame's event loop: its timers never come due and inbound `postMessage` is
 * never delivered, while a same-origin frame beside it gets both. (Measured
 * directly — a plain srcdoc frame reports boot + timer + message; an identical
 * sandboxed one reports only boot.) So the message loop is invisible in the
 * shipped configuration, and no amount of waiting fixes it: `--timeout` dumps
 * at load, and passing both flags leaves virtual time in charge.
 *
 * Rather than not test the wiring, `delivery` strips the sandbox attribute as
 * an INSTRUMENT — never as a configuration. It is the one page that does, it
 * asserts it did it on purpose, and what it measures is entirely host-side
 * logic (capture listeners, state, the notes gate). "A sandboxed frame can
 * receive a postMessage" is browser behaviour this repo does not implement and
 * does not need to prove. `containment` is what runs as shipped, and it is the
 * page that carries the security claim.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';
import { chromeMarkup, injectChrome } from '../cli/plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-plugin-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const render = (file, budget = 20000) =>
  dumpDom(`file://${file}`, { fileAccess: true, budget, quietStderr: true, who: 'plugin-render' });

/**
 * Insert before the document's own `</body>` — the LAST one. A bundled deck
 * contains the string twice: the inlined runtime carries one in its source,
 * and splicing there buries the probe inside a JS string literal where it
 * never runs. (`injectChrome` splices the same way, for the same reason.)
 */
function atBodyEnd(html, insert) {
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + insert : `${html.slice(0, at)}${insert}\n${html.slice(at)}`;
}

const plugin = (name, source, extra = {}) => ({
  name, title: name, slot: 'corner-br', needs: ['position'], width: 200, height: 96, source, ...extra,
});

// ── page one: containment ──────────────────────────────────────────────────

// A real deck, bundled the way one that reaches you would be. A fixture would
// prove the frame is contained inside a page we wrote; the point is that it is
// contained inside a deck we did not.
const bundled = path.join(dir, 'deck.html');
execFileSync(process.execPath,
  [path.join(root, 'cli/decklight.mjs'), 'bundle', path.join(root, 'demo/intro.html'), '-o', bundled],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Everything a plugin would do if "chrome only" were merely a convention.
 *
 * Reported synchronously, never on a timer — see the header note on opaque
 * frames under virtual time. None of these reaches needs the deck to have
 * booted, which is what makes the whole verdict observable.
 *
 * It reports to the harness, NOT to the host shim, which ignores messages from
 * frames entirely. A sandboxed frame can always postMessage to its parent;
 * that the shim has no listener is a design choice (the relay is one-way, so
 * there is no request channel on which to grow a second capability), not a
 * wall, and this harness would be lying if it implied otherwise.
 */
const HOSTILE = `
function attempt(fn) { try { var v = fn(); return { ok: true, got: String(v).slice(0, 60) }; }
                       catch (e) { return { ok: false, threw: e.name }; } }
parent.postMessage({ __probe: 1, findings: {
  parentDocument: attempt(function () { return parent.document.title; }),
  readHeading:    attempt(function () { return parent.document.querySelector('h1').textContent; }),
  writeSlide:     attempt(function () {
                    var s = parent.document.querySelector('.decklight-stage > section');
                    s.innerHTML = '<h1>REWRITTEN BY A PLUGIN</h1>';
                    return 'wrote';
                  }),
  topLocation:    attempt(function () { return top.location.href; }),
  cookies:        attempt(function () { return parent.document.cookie; }),
  storage:        attempt(function () { return String(localStorage.length); }),
  origin:         String(location.origin)
} }, '*');
`;

const CONTAIN_PROBE = `<script>
  window.__f = null;
  window.addEventListener('message', function (e) { if (e.data && e.data.__probe) window.__f = e.data; });
  setTimeout(function () {
    var stage = document.querySelector('.decklight-stage > section');
    var frame = document.querySelector('.decklight-chrome iframe');
    var out = {
      reported: !!window.__f,
      findings: window.__f && window.__f.findings,
      // Scoped to the STAGE, not the body: the hostile source is quoted
      // verbatim inside the frame's srcdoc attribute, so scanning
      // document.body.innerHTML for the marker always "finds" it and this
      // check would fail whether or not the write ever landed.
      slideIntact: !!stage && stage.innerHTML.indexOf('REWRITTEN') < 0,
      frameCount: document.querySelectorAll('.decklight-chrome iframe').length,
      sandbox: frame && frame.getAttribute('sandbox'),
      stageText: stage ? stage.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : null
    };
    var pre = document.createElement('pre');
    pre.textContent = 'DECKLIGHT-PLUGIN-RESULTS ' + JSON.stringify(out);
    document.body.appendChild(pre);
  }, 2000);
</script>`;

const containPage = path.join(dir, 'contained.html');
writeFileSync(containPage,
  atBodyEnd(injectChrome(readFileSync(bundled, 'utf8'), [plugin('hostile', HOSTILE)]), CONTAIN_PROBE));
const contained = resultsFrom(render(containPage), 'PLUGIN', 'containment');

// ── page two: delivery ─────────────────────────────────────────────────────

const ECHO = `decklight.on(function (s) { parent.postMessage({ __echo: decklight.name, state: s }, '*'); });`;
const shipped = chromeMarkup([
  plugin('timer', ECHO),
  plugin('prompter', ECHO, { slot: 'edge-bottom', needs: ['position', 'notes'] }),
]);
// The instrument, and the only place it appears. Asserted below, so this can
// never silently become a no-op that leaves the page testing the real thing
// and reporting on nothing.
const instrumented = shipped.replaceAll(' sandbox="allow-scripts"', '');
if (instrumented === shipped) {
  console.error('plugin-render: the delivery page failed to strip the sandbox attribute');
  console.error('  chromeMarkup no longer emits sandbox="allow-scripts" — that is the whole ticket');
  process.exit(1);
}

const deliveryPage = path.join(dir, 'delivery.html');
writeFileSync(deliveryPage, `<!doctype html><html><body>
<div class="decklight"><div class="decklight-stage">
  <section><h1>one</h1><aside class="notes">NOTES FOR SLIDE ONE</aside></section>
  <section><h1>two</h1><aside class="notes">NOTES FOR SLIDE TWO</aside></section>
</div></div>
${instrumented}
<script>
  window.__echo = {};
  window.addEventListener('message', function (e) {
    if (e.data && e.data.__echo) window.__echo[e.data.__echo] = e.data.state;
  });
  // Exactly what the engine emits: CustomEvents on the deck root, with the
  // default bubbles:false. The shim catches them on document in the CAPTURE
  // phase — if that ever regresses to a bubbling assumption, this page is
  // where it shows up.
  setTimeout(function () {
    var r = document.querySelector('.decklight');
    r.dispatchEvent(new CustomEvent('decklight:ready', { detail: { slides: 2 } }));
    r.dispatchEvent(new CustomEvent('decklight:slide', { detail: { slide: 2, total: 2, direction: 'next' } }));
    r.dispatchEvent(new CustomEvent('decklight:build', { detail: { slide: 2, index: 1, total: 3 } }));
  }, 300);
  setTimeout(function () {
    var pre = document.createElement('pre');
    pre.textContent = 'DECKLIGHT-DELIVERY-RESULTS ' + JSON.stringify({
      timer: window.__echo.timer || null,
      prompter: window.__echo.prompter || null
    });
    document.body.appendChild(pre);
  }, 2500);
</script>
</body></html>`);
const delivery = resultsFrom(render(deliveryPage, 8000), 'DELIVERY', 'delivery');

// ── page three: policy ─────────────────────────────────────────────────────
// A srcdoc frame is never fetched, so `frame-src` has no URL to judge and it
// runs even under 'none'. That is what lets a plugin load without widening the
// presenting CSP by a single source and without a route to serve it from.
// Measured with the strictest possible policy: if it survives frame-src
// 'none', it survives present's frame-src 'self'.
const policyPage = path.join(dir, 'policy.html');
writeFileSync(policyPage, `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'none'; child-src 'none'">
</head><body>
<div class="decklight"><div class="decklight-stage"><section><h1>secret</h1></section></div></div>
${chromeMarkup([plugin('probe', "parent.postMessage({__probe:1,ran:true,origin:location.origin},'*');")])}
<script>
  window.__ran = null;
  window.addEventListener('message', function (e) { if (e.data && e.data.__probe) window.__ran = e.data; });
  setTimeout(function () {
    var pre = document.createElement('pre');
    pre.textContent = 'DECKLIGHT-POLICY-RESULTS ' + JSON.stringify({
      ranUnderFrameSrcNone: !!(window.__ran && window.__ran.ran),
      origin: window.__ran && window.__ran.origin
    });
    document.body.appendChild(pre);
  }, 1500);
</script>
</body></html>`);
const policy = resultsFrom(render(policyPage, 8000), 'POLICY', 'policy');

// ── the verdict ────────────────────────────────────────────────────────────

const f = contained.findings || {};
const blocked = (k) => !!f[k] && f[k].ok === false;
const t = delivery.timer;
const p = delivery.prompter;

const checks = [
  // containment — what runs as shipped
  ['the plugin ran at all (else nothing below means anything)', contained.reported === true],
  ['exactly one chrome frame mounted', contained.frameCount === 1],
  ['the frame is sandboxed without allow-same-origin', contained.sandbox === 'allow-scripts'],
  ['its origin is opaque', f.origin === 'null'],
  ['parent.document — refused', blocked('parentDocument')],
  ['reading a slide heading — refused', blocked('readHeading')],
  ['rewriting a slide — refused', blocked('writeSlide')],
  ['top.location — refused', blocked('topLocation')],
  ['the deck\'s cookies — refused', blocked('cookies')],
  ['the deck\'s localStorage — refused', blocked('storage')],
  ['the slide is untouched', contained.slideIntact === true],
  ['the deck still rendered its own content', !!contained.stageText],

  // delivery — chrome that cannot reach content still has to WORK, or
  // "enforced" just means "broken"
  ['a plugin is told the deck position', !!t && t.slide === 2 && t.totalSlides === 2],
  ['it is told the build step', !!t && t.step === 1],
  ['it is told elapsed time', !!t && typeof t.elapsed === 'number'],
  ['a plugin that declared notes gets them', !!p && p.notes === 'NOTES FOR SLIDE TWO'],
  ['a plugin that did NOT declare notes gets none', !!t && t.notes === undefined],

  // policy
  ['a srcdoc frame runs under frame-src \'none\' (no CSP widening needed)',
    policy.ranUnderFrameSrcNone === true],
];

console.log('plugin-render results:', JSON.stringify({ contained, delivery, policy }, null, 2));
let failed = 0;
for (const [what, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`\nplugin-render: ${failed} of ${checks.length} FAILED`);
  process.exit(1);
}
console.log(`\nplugin-render: PASS — ${checks.length} checks`);
