#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Does a deck render in the browsers the AUDIENCE has?
 *
 * Every other harness in this repo drives Chrome, and until now so did every
 * claim: `verify` renders in Blink on three platforms and says nothing at all
 * about Gecko or WebKit. That is a strange gap for this product specifically. A
 * deck is a single HTML file you send someone — the whole promise of `bundle`
 * is that they double-click it and it presents — and what they double-click it
 * IN is not something the author chooses. Safari is the default browser on
 * every Mac and every iPad in the room.
 *
 * So: the same deck, in Firefox and WebKit, asserting the things that would be
 * visibly broken rather than the things that are merely different.
 *
 *   IT MOUNTS         — the runtime creates its stage. If `Decklight.init()`
 *                       throws on an engine, everything else is moot.
 *   IT NAVIGATES      — → moves to the next slide. The keyboard is the whole
 *                       interface during a talk.
 *   IT BUILDS         — a slide with `data-build` reveals a step at a time
 *                       rather than arriving whole.
 *   NOTHING CLIPS     — no slide sets `data-overflow` (SPEC PRESENTING). This is
 *                       the assertion with real cross-engine teeth: the
 *                       guardrail measures TEXT, and text metrics are where
 *                       Gecko, WebKit and Blink actually differ.
 *   NOTHING THROWS    — no console error on any slide.
 *
 * What this is NOT: a pixel comparison. Three engines will never agree
 * pixel-for-pixel and a diff that fails on antialiasing teaches nobody
 * anything. Every assertion here is about the deck being USABLE.
 *
 * Playwright is an OPTIONAL dependency and its browsers are a separate
 * download, so a machine without them skips by name — except under
 * CROSS_ENGINE_STRICT, which CI sets, because a CI job that skipped silently
 * would be a green tick for nothing at all.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveForRender } from '../cli/present.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const STRICT = process.env.CROSS_ENGINE_STRICT === '1';

const skip = (why) => {
  if (STRICT) {
    console.error(`cross-engine: ${why}`);
    console.error('  CROSS_ENGINE_STRICT is set, so this is a failure rather than a skip.');
    process.exit(1);
  }
  console.log(`cross-engine: SKIP — ${why}`);
  process.exit(0);
};

if (!existsSync(path.join(root, 'dist', 'decklight.js'))) {
  skip('dist/decklight.js is missing — npm run build');
}

let playwright;
try {
  playwright = await import('playwright');
} catch {
  skip('playwright is not installed — npm install --include=optional, then npx playwright install firefox webkit');
}

// The deck under test is the demo showcase: it is the biggest one in the repo,
// it uses every layout and build the runtime has, and it is the file the shot
// harness and the docs already point at — so a regression here is one somebody
// would have seen anyway, in a browser nobody was checking.
const DECK = '/demo/showcase.html';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`ok   ${label}`); return; }
  bad += 1;
  console.log(`FAIL ${label}${detail ? `  — ${detail}` : ''}`);
};

/**
 * What one engine makes of the deck.
 *
 * Walks EVERY slide rather than sampling: the overflow guardrail measures the
 * slide it is on, so a deck is only as checked as the slides somebody visited,
 * and the whole point of running this in another engine is the slide whose text
 * wraps differently there.
 */
async function drive(browser, origin) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // An uncaught exception is always the deck's fault. A console error is not:
  // the runtime probes `/edit/ping` and `/present/ping` to find out whether it
  // is being authored or presented, and a deck opened without either server
  // gets a 404 BY DESIGN — WebKit reports that as a console error and Gecko
  // does not, which is a difference between engines' logging and not between
  // their rendering.
  const benign = /\/(edit|present)\/ping/;
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !benign.test(m.text() + m.location().url)) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e.message ?? e)));

  await page.goto(origin + DECK, { waitUntil: 'load' });
  // The runtime mounts on load; give it a moment to exist rather than racing it.
  await page.waitForSelector('.decklight-stage', { timeout: 15000 });

  // Dismiss the first-run welcome card before touching the keyboard. An overlay
  // that is up OWNS the keyboard (src/core/engine.js), by design, so a driver
  // that skips this reads every arrow key as "the deck does not navigate" — the
  // same trap the #308 repro fell into. Every browser context here is fresh, so
  // the card is always up, exactly as it is for a first-time viewer.
  const welcome = page.locator('.decklight-welcome');
  const hadWelcome = (await welcome.count()) > 0;
  if (hadWelcome) {
    await page.keyboard.press('Escape');
    await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  const welcomed = hadWelcome && (await welcome.count()) === 0;

  const total = await page.locator('.decklight-stage > section').count();
  const firstActive = await page.locator('.decklight-stage > section.active').count();

  // Two readings of "where are we", because they are different claims. THE DOM
  // IS THE DECK — which slide carries `.active` is what the audience sees. The
  // hash is a FEATURE (deep links, refresh) and the only place a build step is
  // legible from outside; reading a `data-step` attribute instead looks
  // equivalent and is not, since there is none.
  const where = () => page.evaluate(() => {
    const list = [...document.querySelectorAll('.decklight-stage > section')];
    const m = /^#\/(\d+)\/(\d+)/.exec(location.hash) ?? [];
    return {
      slide: list.indexOf(document.querySelector('.decklight-stage > section.active')) + 1,
      hashSlide: Number(m[1] ?? 0),
      step: Number(m[2] ?? 0),
      overflow: list.filter((x) => x.hasAttribute('data-overflow')).map((x) => list.indexOf(x) + 1),
    };
  });

  const overflowed = [];
  let built = 0;
  let seen = 1;
  let at = await where();
  // 120ms between presses: a presenter's pace. The SCRUB — a held arrow key,
  // which is what found #328 — is asserted separately below, now that the
  // runtime coalesces its history writes instead of losing them.
  for (let i = 0; i < total * 12; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const next = await where();
    for (const n of next.overflow) if (!overflowed.includes(n)) overflowed.push(n);
    if (next.slide > at.slide) seen = Math.max(seen, next.slide);
    else if (next.slide === at.slide && next.step > at.step) built += 1;
    if (next.slide === at.slide && next.step === at.step) break;  // the last slide, fully built
    at = next;
  }
  const synced = at.slide === at.hashSlide;

  // ── the things a walk does not touch ───────────────────────────────────

  // A transition leaves marker classes on both sections while it runs and takes
  // them off when it finishes. Both halves matter: without the first there is no
  // animation, and without the second every slide a presenter leaves keeps them
  // — which is precisely what `--transition-duration: 350ms` parsed as 350
  // SECONDS did, on every deck, in every browser (SPEC MOTION).
  await page.evaluate(() => window.location.hash = '#/1/0');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(80);
  const midMove = await page.evaluate(() =>
    document.querySelectorAll('.decklight-stage > section.entering, .decklight-stage > section.leaving').length);
  await page.waitForTimeout(1200);
  const afterMove = await page.evaluate(() =>
    document.querySelectorAll('.decklight-stage > section[class*="entering"], '
      + '.decklight-stage > section[class*="leaving"], .decklight-stage > section[class*="tr-"]').length);

  // The theme is a stylesheet, and a stylesheet that did not load leaves a deck
  // that renders as unstyled HTML — legible, and not a deck.
  const themed = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.decklight')).backgroundColor;
    const h = document.querySelector('.decklight-stage > section.active h1, .decklight-stage > section.active h2');
    return {
      bg,
      headingPx: h ? parseFloat(getComputedStyle(h).fontSize) : 0,
      transparent: bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)',
    };
  });

  // Speaker notes are in the file and must never be on the screen. This is one
  // CSS rule (`aside.notes { display: none }`) between a presenter's private
  // notes and a room full of people.
  const notes = await page.evaluate(() => {
    const all = [...document.querySelectorAll('aside.notes')];
    return { count: all.length, visible: all.filter((n) => n.offsetParent !== null).length };
  });

  // ── the scrub (#328) ───────────────────────────────────────────────────
  //
  // A held arrow key, or anyone dragging through a deck to find a slide. WebKit
  // caps history writes at 100 per 10 seconds and counts pushState and
  // replaceState against the same budget, and the runtime used to write one per
  // navigation — so a fast walk of the showcase silently exhausted it and left
  // the URL on slide 31 with slide 39 on screen. PERMANENTLY: only a further
  // navigation would have resynced it, and at the end of a deck there are none.
  //
  // Blink and Gecko have no such limit, so this assertion is about WebKit and
  // costs the other two a few seconds. That is the point of running here at all.
  await page.evaluate(() => { window.location.hash = '#/1/0'; });
  await page.waitForTimeout(400);
  for (let i = 0; i < 160; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
  }
  // Settle, then wait out WebKit's 10-second window. A URL that is merely LATE
  // is not the bug; one that never arrives is.
  await page.waitForTimeout(1500);
  const scrubbed = await where();
  await page.waitForTimeout(11000);
  const afterLimiter = await where();
  const scrubSynced = afterLimiter.slide === afterLimiter.hashSlide
    && scrubbed.slide === scrubbed.hashSlide;

  // A deep link is how a deck is shared mid-talk, and the deck has to arrive
  // where the URL says rather than at slide 1.
  await page.evaluate(() => window.location.hash = '#/12/0');
  await page.waitForTimeout(500);
  const deepLinked = (await where()).slide;

  // ← is not → reversed: it runs a different keyframe, and it is what a
  // presenter reaches for the moment they say "sorry, go back one".
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  const wentBack = (await where()).slide;

  // Overview, and out again. The one overlay every presenter uses.
  await page.keyboard.press('o');
  await page.waitForTimeout(400);
  const overviewOpen = await page.evaluate(() => document.querySelectorAll('.decklight-overview').length);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const overviewClosed = await page.evaluate(() => document.querySelectorAll('.decklight-overview').length);

  // The stage is scaled to fit the viewport, so nothing should ever put a
  // scrollbar on the page itself.
  const scrolls = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  }));

  await page.close();
  return { total, firstActive, seen, built, overflowed, errors, welcomed, synced, at,
    scrubSynced, scrubbed, afterLimiter,
    midMove, afterMove, themed, notes, deepLinked, wentBack, overviewOpen, overviewClosed, scrolls };
}

const server = await serveForRender(root);
const ENGINES = ['firefox', 'webkit'];
try {
  for (const name of ENGINES) {
    console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`);
    let browser;
    try {
      browser = await playwright[name].launch({ headless: true });
    } catch (e) {
      // A missing browser binary is a setup problem, not a decklight one — and
      // it must not read as a pass.
      skip(`${name} will not launch (${String(e.message).split('\n')[0]}) — npx playwright install ${name}`);
    }
    console.log(`  ${name} ${browser.version()}`);
    const r = await drive(browser, server.origin);
    await browser.close();

    check(`${name}: the runtime mounts`, r.total > 0, `${r.total} slides in the DOM`);
    check(`${name}: the welcome card appears, and Escape dismisses it`, r.welcomed,
      'the first-run card never showed, or would not close');
    check(`${name}: exactly one slide is active on arrival`, r.firstActive === 1, `${r.firstActive} active`);
    check(`${name}: → walks the whole deck`, r.seen === r.total, `reached ${r.seen} of ${r.total}`);
    check(`${name}: slides build a step at a time`, r.built > 0, `${r.built} build steps`);
    // The one that is really about this engine: the guardrail measures text, and
    // text is what Gecko and WebKit lay out differently from Blink.
    check(`${name}: no slide clips its frame`, r.overflowed.length === 0,
      `data-overflow on slide(s) ${r.overflowed.join(', ')}`);
    // The URL is how a deck is deep-linked and how a refresh keeps its place,
    // so it has to agree with the slide on screen.
    check(`${name}: the URL agrees with the slide on screen`, r.synced,
      `on slide ${r.at.slide}, URL says ${r.at.hashSlide}`);
    // ...and still agrees after a SCRUB, which is where WebKit's history
    // limiter used to leave it stuck for good (#328).
    check(`${name}: and still agrees after 160 fast presses`, r.scrubSynced,
      `settled on slide ${r.scrubbed.slide} with URL ${r.scrubbed.hashSlide}`
      + `, and after the limiter window ${r.afterLimiter.slide} vs ${r.afterLimiter.hashSlide}`);
    check(`${name}: a transition marks both slides while it runs`, r.midMove === 2,
      `${r.midMove} section(s) marked entering/leaving 80ms in`);
    // The assertion that would have caught 350ms being read as 350 seconds.
    check(`${name}: and clears every marker when it ends`, r.afterMove === 0,
      `${r.afterMove} section(s) still marked a second later`);
    check(`${name}: the theme is actually applied`, !r.themed.transparent && r.themed.headingPx > 20,
      `background ${r.themed.bg}, heading ${r.themed.headingPx}px`);
    check(`${name}: speaker notes are in the file and never on the screen`,
      r.notes.count > 0 && r.notes.visible === 0,
      `${r.notes.count} notes, ${r.notes.visible} visible`);
    check(`${name}: a deep link arrives where it says`, r.deepLinked === 12,
      `#/12/0 landed on ${r.deepLinked}`);
    check(`${name}: ← goes back`, r.wentBack === 11, `landed on ${r.wentBack}`);
    check(`${name}: overview opens and closes`, r.overviewOpen === 1 && r.overviewClosed === 0,
      `open=${r.overviewOpen} closed=${r.overviewClosed}`);
    check(`${name}: the page itself never scrolls`, !r.scrolls.x && !r.scrolls.y,
      `x=${r.scrolls.x} y=${r.scrolls.y}`);
    check(`${name}: nothing throws`, r.errors.length === 0, r.errors.slice(0, 3).join(' | '));
  }
} finally {
  await server.close();
}

if (bad) { console.error(`\ncross-engine: FAILED — ${bad} assertion(s)`); process.exit(1); }
console.log(`\ncross-engine: PASS — ${ENGINES.join(' + ')}`);
