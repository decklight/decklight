#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Narration auto-advance, and what a failing voice bridge does to it.
 *
 * The voice is the clock: the deck advances when a segment finishes speaking.
 * So when the voice CANNOT be played, the deck must stop — advancing in silence
 * would walk the talk past slides nobody has heard — and it must say why, where
 * the presenter is actually looking.
 *
 * Three runs of test/narration.html (audio and bridge both mocked in-page):
 *   healthy — every sentence synthesizes: the deck walks itself to the last slide
 *   flaky   — the first sentence 429s: the deck HOLDS on slide 1, shows a message
 *             explaining it, and keeps that message in the log (I)
 *   dead    — every sentence 429s: same, and it never races ahead
 *   roster  — the bridge speaks its OWN voices (an ElevenLabs key knows none of
 *             the Gemini star names): the persisted voice is stale, so the deck
 *             takes the bridge's first, says it did, and remembers
 *   xss     — the bridge's roster names a voice WITH MARKUP (an ElevenLabs
 *             voice is named by whoever shared it): the N picker must render
 *             it as text, never parse it
 *   record  — ⇧V with an author server up: every stitched slide goes THROUGH
 *             that server into a folder beside the deck, and nothing reaches
 *             the browser's download path (`&dir`: the deck already names a
 *             narration folder, so the recording lands in that one;
 *             `&nosrv`: nothing to write with, so the browser still gets them)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'narration.html');

// `record` records the WHOLE deck before it can assert anything, and the
// download path it falls back to leaves a 5s revoke timer behind per file —
// pending virtual-time work that spends the budget without advancing the
// recording. Its own clock, so a slower runner does not turn "not finished
// yet" into a failure. Virtual, not wall: these runs still take under a second.
const BUDGET = (m) => (m === 'record' ? 120_000 : 30_000);

function run(mode, extra = '') {
  // quietStderr: a headless Chrome on a machine with no D-Bus/UPower prints
  // pages of unrelated noise that would bury the actual result
  const html = dumpDom(`file://${page}?mode=${mode}${extra}`,
    { fileAccess: true, budget: BUDGET(mode), quietStderr: true, who: 'narration-render' });
  return resultsFrom(html, 'NARRATION', `mode=${mode}${extra}`);
}

let bad = 0;
for (const mode of ['healthy', 'pause', 'pausenav', 'flaky', 'dead', 'keys', 'modules', 'recorded', 'roster', 'xss',
  'elevenlabsv3', 'scroll', 'segoverflow', 'hint', 'hint&print', 'manifest', 'expired',
  'record', 'record&dir', 'record&nosrv']) {
  const [m, extra] = mode.split('&');
  const r = run(m, extra ? `&${extra}` : '');
  const ok = r.PASS === true;
  if (!ok) bad++;
  if (m === 'manifest' || m === 'expired') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} `
      + (r.expiredCase
        ? `played nothing=${r.playedNothing} held=${r.didNotAdvance}`
          + ` said expired=${r.saidExpired} named re-sign=${r.namedResign}`
        : `signed url verbatim=${r.playedSigned && r.keptTheQuery}`
          + ` · per-slide=${r.perSlideUrls} null slide quiet=${r.quietOnNullSlide}`)
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (m === 'hint') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} `
      + (r.printing
        ? `no pill on paper=${r.hidden}`
        : `shown=${r.shown} names V=${r.namesTheKey} button=${r.isAButton}`
          + ` · click plays=${r.clickStartsVoice} gone=${r.goneAfterClick} remembered=${r.remembered}`
          + ` · logged once=${r.inLog && r.noDoubleToast}`)
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'keys') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} play: \` opens=${r.playOpens} closes=${r.playCloses} azerty(²)=${r.azertyOpens}`
      + ` · edit: bare ignored=${r.editIgnoresBareKey} ⌃\` opens=${r.editCtrlOpens} ⌥\` opens=${r.editAltOpens}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'xss') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} ${r.rows} rows · script did not run=${r.scriptDidNotRun}`
      + ` nothing parsed=${r.nothingParsed} name literal=${r.nameIsLiteralText} flavor literal=${r.flavorIsLiteralText}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'elevenlabsv3') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} tone step shown=${r.toneStepShown}`
      + ` · tones offered=${r.toneLabels?.length ?? 0} · sent short v3 cue "${r.sentStyle}" (not the gemini prose)`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'segoverflow') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} ${r.asked} sentences asked for`
      + ` · spoke the first=${r.spokeFirst} and the surplus=${r.spokeSurplus}`
      + ` · still advanced=${r.movedOn} · warned in the log=${r.warned} (not toasted=${r.notToasted})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'scroll') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} ${r.rows} rows, card scrolls=${r.scrollable}`
      + ` · selection stayed in view=${r.visibleThroughout}${r.lostAt ? ` (lost at ↓${r.lostAt})` : ''}`
      + ` · list scrolled=${r.scrolled} · hover held still=${r.hoverHeldStill}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'roster') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} stale voice ${r.savedBefore} → ${r.savedAfter}`
      + ` (swapped=${r.swapped} persisted=${r.persisted} said so=${r.saidSo} spoke as it=${r.spokeAs})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'recorded') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} silent slide stays quiet=${r.quietOnSlideWithNoNotes}`
      + ` · missing file warns=${r.warnsOnMissingFile}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (m === 'record') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(12)} `
      + (r.authored
        ? `wrote ${r.slides?.join(',')} to ${r.dir}/ (right folder=${r.dirIsRight})`
          + ` · nothing downloaded=${r.wentToDisk}`
          + ` · card says where=${r.saidWhere} and how to play it=${r.namedTheConfig}`
        : `no server → downloaded ${r.slides?.join(',')} (posted nothing=${r.wentToDisk})`
          + ` · card says downloads=${r.saidWhere}`)
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'pause') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} slide 1 held ${r.heldFor}ms for its beat (>=900=${r.held})`
      + ` · and the deck still reached ${r.slide}/${r.total} on its own=${r.reachedEnd}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'pausenav') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} still on 1 mid-beat=${r.stayedForTheBeat}`
      + ` · jumped to ${r.visited?.join('→')} (asked for 4=${r.wentWhereAsked},`
      + ` never fell through to 2=${r.neverJumpedToTwo})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'modules') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} M gone=${r.noModuleMenu} · finder lists slides=${r.listsSlides}`
      + ` modules=${r.listsModules} (marked=${r.moduleRowMarked}, current hidden=${r.hidesCurrentModule})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  const detail = mode === 'healthy'
    ? ''
    : ` · stopped=${r.stopped} explained=${r.explained} window=${r.windowUp} log=${r.logUp}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} slide ${r.slide}/${r.total} · ${r.ttsCalls} tts calls, ${r.failures} failed${detail}`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
  if (r.lastMessage) console.log(`       message: "${r.lastMessage}"`);
}
if (bad) { console.error('narration-render: FAILED'); process.exit(1); }
console.log('narration-render: PASS');
