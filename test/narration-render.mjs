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
import { dumpDom, resultsFrom, timedOut } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'narration.html');

// The `record*` modes record the WHOLE deck before they can assert anything,
// and the download path they fall back to leaves a 5s revoke timer behind per
// file — pending virtual-time work that spends the budget without advancing
// the recording. Their own clock, so a slower runner does not turn "not
// finished yet" into a failure. Virtual, not wall: these runs still take under
// a second.
//
// A PREFIX, not `=== 'record'`. `recordseg` was added with an exact match still
// here, so the mode that records the MOST slides got the smallest budget — and
// it passed four runs out of five, which is the worst way for a test to be
// wrong: a real ceiling reported as a flake. Any mode that records the deck
// needs the recording budget, whatever else its name says.
const BUDGET = (m) => (m.startsWith('record') ? 120_000 : 30_000);

/** How long ONE mode may take on the wall clock before it is treated as stuck. */
const MODE_WALL_MS = Number(process.env.NARRATION_MODE_TIMEOUT_MS ?? 90_000);

/**
 * One mode: render the page, read its verdict.
 *
 * RETRIED ONCE if the child had to be killed for running too long (#323). This
 * harness spawns a fresh Chrome per mode — twenty cold starts — and on a
 * Windows runner one of them occasionally never returns: the page leaves work
 * pending, virtual time does not drain, and the dump sits there. It used to
 * take the whole harness with it and say only "KILLED after 180s", which is
 * indistinguishable from the harness having simply grown too slow and cost a
 * re-run to tell apart.
 *
 * The retry is loud, and it is exactly one. A stall that repeats is not
 * environmental and must fail — retrying until it works is how a real hang
 * becomes a green tick that takes twice as long.
 */
function run(mode, extra = '') {
  // quietStderr: a headless Chrome on a machine with no D-Bus/UPower prints
  // pages of unrelated noise that would bury the actual result
  const dump = () => dumpDom(`file://${page}?mode=${mode}${extra}`, {
    fileAccess: true, budget: BUDGET(mode), quietStderr: true,
    who: 'narration-render', timeout: MODE_WALL_MS,
  });
  try {
    return resultsFrom(dump(), 'NARRATION', `mode=${mode}${extra}`);
  } catch (e) {
    if (!timedOut(e)) throw e;
    console.log(`     ${mode}: no answer within ${MODE_WALL_MS / 1000}s — killed, retrying once`);
    stalled.push(mode);
    try {
      return resultsFrom(dump(), 'NARRATION', `mode=${mode}${extra} (retry)`);
    } catch (again) {
      if (!timedOut(again)) throw again;
      // Reported like any other verdict rather than as a Node stack: this is a
      // harness saying which mode hung, which is the whole answer somebody
      // needed and could not get from "KILLED after 180s".
      console.error(`FAIL ${mode.padEnd(8)} STUCK — no answer within ${MODE_WALL_MS / 1000}s, twice.`
        + ' Its virtual clock never drained; the browser was killed both times.');
      console.error('narration-render: FAILED');
      process.exit(1);
    }
  }
}

let bad = 0;
const timings = [];
const stalled = [];
let slowest = 0;
// One mode, by name, for iterating on it: `node test/narration-render.mjs off`.
// The harness boots a browser PER MODE and there are 37 of them, so proving one
// assertion used to cost the whole suite — which is how a mode gets added
// without ever being watched fail.
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const MODES = ['healthy', 'pause', 'sentpause', 'pausedefaults', 'pausenav', 'flaky', 'dead', 'keys', 'modules', 'recorded', 'roster', 'xss',
  'elevenlabsv3', 'scroll', 'sayshelves', 'filter', 'segoverflow', 'switch', 'hint', 'hint&print', 'manifest', 'expired',
  'segments', 'segfold', 'segmiss', 'segnav', 'beatpause', 'plainrec', 'segmanifest', 'segsigned', 'off',
  'record', 'record&dir', 'record&nosrv', 'recordseg', 'recordseg&badconfig', 'micwarn&record'];
for (const mode of (only.length ? MODES.filter((m) => only.includes(m.split('&')[0])) : MODES)) {
  const [m, extra] = mode.split('&');
  // Timed, and printed even on success (#323). This harness boots a browser per
  // mode, so when it dies to its budget the useful question is WHICH mode was
  // slow — and the run that prompted this said only "KILLED after 180s", with
  // sixteen ok lines above it and no way to tell a hang from a harness that had
  // simply grown. A number per mode makes the next occurrence readable from the
  // log alone, and makes drift visible before it becomes a failure.
  const at = Date.now();
  const r = run(m, extra ? `&${extra}` : '');
  const took = Date.now() - at;
  slowest = Math.max(slowest, took);
  timings.push([mode, took]);
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
  if (mode === 'switch') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} live spoke=${r.liveWasSpeaking}`
      + ` · picker listed the track=${r.pickerListedTrack}`
      + ` · orphaned live chain did not advance=${r.stayedPut} · now recorded=${r.nowRecorded}`
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
  if (mode === 'pausedefaults') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} a deck that says nothing holds 1s before the slide turns=${r.slideHeldOneSecond}`
      + ` (${r.slideTurnTook}ms)`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'sentpause') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} breathed between sentences by default=${r.breathedByDefault}`
      + ` (${r.defaultTook}ms to slide 2) · "0" switched it off=${r.zeroMeansNoBreath} (${r.zeroTook}ms)`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'beatpause') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} held after the clip=${r.heldAfterClip}`
      + ` · advanced once the hold elapsed=${r.advancedAfterHold}`
      + ` · still ran itself to the end=${r.reachedTheEnd}`
      + ` · deck-wide narration.beatPause held too=${r.deckWideHeld && r.deckWideAdvanced}`
      + ` · a slide's "0" wins=${r.slideZeroWins}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'filter') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} box focused on open=${r.focusedOnOpen}`
      + ` · "fr" found the French voice=${r.bareFindsLang} and opened the fold it hid in=${r.foldOpened}`
      + ` · lang:fr dropped the names=${r.langOnly} · accent-blind=${r.accentBlind}`
      + ` · empty says so=${r.emptySays} · clearing refolds=${r.clearedRefolds}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'sayshelves') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} folded to ${r.rows} rows`
      + ` · install row on BEST=${r.installRowShown} (opens Settings=${r.installPosted})`
      + ` · novelty expands in place=${r.noveltyExpands} · other languages too=${r.othersExpand}`
      + ` · ▶ warmed only the visible rows=${r.warmedOnlyVisible && r.foldedStayedCold}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'roster') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} stale voice ${r.savedBefore} → ${r.savedAfter}`
      + ` (swapped=${r.swapped} persisted=${r.persisted} said so=${r.saidSo} spoke as it=${r.spokeAs})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (m === 'segmanifest' || m === 'segsigned') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} `
      + (r.unsignedSegments
        ? `unsigned segments on a signed manifest ignored=${r.ignoredThem}`
          + ` · whole slide instead=${r.playedTheWholeSlide} · did not pace itself=${r.didNotAdvance}`
        : `each segment's own signature, verbatim=${r.playedEachSigned && r.keptTheQuery}`
          + ` · whole-slide entry too=${r.wholeSlideToo} · ran to the end=${r.ranToTheEnd}`)
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (m === 'segments' || m === 'segfold') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} every beat spoke=${r.spokeEverySegment}`
      + ` · whole-slide inside a segmented track=${r.wholeSlideToo}`
      + ` · ran to the end on its own=${r.ranToTheEnd} · asked for ${r.asked?.length} files`
      + (m === 'segfold' ? ` · warned the counts disagree=${r.warnedOverflow}` : '')
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'segmiss') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} first segment gone → whole slide=${r.fellBackAtArrival}`
      + ` (and moved on=${r.wentOn})`
      + ` · gap mid-slide → held=${r.heldThere} named the file=${r.namedTheFile} once=${r.saidItOnce}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'segnav') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} → mid-beat advanced exactly once=${r.midClip}`
      + ` · in order=${r.inOrder} · nothing played twice=${r.stillNothingTwice}`
      + ` · still reached the end=${r.reachedTheEnd}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'off') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} a deck that SHIPS a track arrives silent=${r.offByDefault}`
      + ` · \u2334 advances while off=${r.spaceAdvancedWhileOff}`
      + ` · \u{1F507} row first=${r.offRowFirst} and current=${r.offRowIsCurrent}`
      + ` · picking hands \u2334 to the voice=${r.spaceStartsAfterPick} (spoke=${r.spokeOnSpace})`
      + ` · Off stops it=${r.offStopped} and gives \u2334 back=${r.spaceAdvancesAgain}`
      + ` · remembered=${r.persistedOff}`
      + (r.exception ? ` \u00b7 ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'plainrec') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} un-opted track unchanged:`
      + ` one file for the slide=${r.playedTheWholeSlide} · did not auto-advance=${r.didNotAdvance}`
      + ` · → did not restart it=${r.steppedWithoutRestarting}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (m === 'micwarn') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} opened by ?record with no server answering:`
      + ` warned BEFORE the first beat=${r.warned} · named the cause=${r.namedTheCause}`
      + ` · still lets you record anyway=${r.stillOffersToRecord}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'recordseg&badconfig') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} a deck that builds its config elsewhere:`
      + ` the refusal reaches the card=${r.explainedTheRefusal}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'recordseg') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(10)} ⇧V wrote a beat per ⟨CLICK⟩=${r.wroteABeatPerClick}`
      + ` (${(r.beats ?? []).join(' ')}) · none for a one-breath slide=${r.noBeatsForAOneBreathSlide}`
      + ` · card offers segments: true=${r.namedSegments}`
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
    if (!ok) console.error('   ', JSON.stringify(r));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(12)} `
      + (r.authored
        ? `wrote ${r.slides?.join(',')} to ${r.dir}/ (right folder=${r.dirIsRight}, offered up front as "${r.folderField}", labelled "${r.label ?? ''}")`
          + ` · nothing downloaded=${r.wentToDisk}`
          + ` · card says where=${r.saidWhere} and how to play it=${r.namedTheConfig}`
        : `no server → downloaded ${r.slides?.join(',')} (posted nothing=${r.wentToDisk})`
          + ` · card says downloads=${r.saidWhere} and WHY=${r.saidWhyNotTheDeck}`)
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
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} M is review now=${r.mIsReviewNow} · finder lists slides=${r.listsSlides}`
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
// The cost report, printed always. `verify` caps this harness at a multiple of
// the per-harness budget precisely because its cost is a SUM over modes
// (test/verify.mjs), and the only way to see that sum growing — before it
// becomes a timeout on somebody's PR — is to print it.
const total = timings.reduce((a, [, ms]) => a + ms, 0);
console.log(`\nnarration-render: ${timings.length} modes in ${(total / 1000).toFixed(1)}s`);
// Said out loud even when the retry saved the run: a stall that stops being
// reported is a stall that stops being investigated, and #323 is open precisely
// because nobody could tell which mode it was.
if (stalled.length) console.log(`  STALLED and retried: ${stalled.join(', ')}`);
for (const [name, ms] of [...timings].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
  console.log(`  slowest: ${name} ${(ms / 1000).toFixed(1)}s`);
}
if (bad) { console.error('narration-render: FAILED'); process.exit(1); }
console.log('narration-render: PASS');
