#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight video — render a deck to a narrated mp4.
//
//   decklight video deck.html -o deck.mp4
//                   [--narration <dir>] [--size 1280x720] [--fps 30] [--hold 5]
//                   [--build-hold <s>] [--theme <name> | --gen <b64url>] [--slides a-b] [--voiceover]
//
// A picture per FRAME — a narrated slide is one frame, fully built, held for its
// audio; a silent slide builds as it goes, one frame per step — muxed with the
// audio into one mp4, so a deck becomes a watchable, shareable video in one
// command. Every frame of a silent slide holds --hold, builds included, so a
// build lands at the pace the deck moves at; --build-hold paces the build-up
// frames alone. Narration resolves --narration <dir> → <deckdir>/voiceover/
// (the manifest tools/voiceover.mjs writes) → a fully silent deck where every
// slide holds --hold seconds (per-slide override: data-video-hold="8" on the
// section). Silent slides still carry a silent audio segment (anullsrc) so the
// concatenated audio track stays continuous.
//
// A frame is a still unless the slide moves. Capture of a still is the
// tools/shot.mjs mechanism: one one-shot headless Chrome per frame against the
// deck served over http://127.0.0.1 at #/n/999 (an oversized step clamps to
// the last build, so every slide renders fully built). The deck
// is served under the `--no-trust` CSP, NOT opened over file:// with
// --allow-file-access-from-files (#229): that flag let a deck's own JS read any
// local file and exfiltrate it, and video renders decks you may not have
// vetted. No puppeteer, no new deps.
//
// A slide that MOVES (an SVG <animate*>, a CSS animation, a build that
// transitions in) is captured as a frame sequence at --fps instead (#914):
// tools/cdp.mjs holds one page open over Node ≥22's own WebSocket, pauses every
// animation, and sets the clock by hand, tick by tick — so the frames are
// exactly 1/fps apart and a loop starts from its beginning when the slide
// appears, not mid-cycle from page load. Chrome's screencast would give
// whatever rate it paints at; a hand-set clock gives the rate asked for, the
// same every run. A build's own transition plays in the first MOTION_WINDOW_S
// of its frame (the rest is its last picture held), so audio timing never
// moves: the segment lasts exactly as long as the still would have. Below
// Node 22 a moving slide renders as a still, said once. Animation the page
// drives from script (the character overlay, a terminal typing) is not on that
// clock and stays still, and a cut between slides stays a cut. How far each slide builds, and whether it moves, is asked of the
// deck itself in one extra load, because the grouping is the runtime's and a
// second counter written here would be a copy that drifts.

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from './chrome.mjs';
import { openPage } from './cdp.mjs';
import { argReader, isMain } from './args.mjs';
import { renderThemeParams } from './render-theme.mjs';
import { injectBeforeBodyEnd, sectionBodies, isHiddenSection, NOTES_ASIDE, cleanNotes, notesSegments } from './deck-html.mjs';
import { VIDEO_FORMATS, VIDEO_QUALITIES, VIDEO_SUBTITLES, valuesOf } from './video-options.mjs';
import { splitSentences, speechRuns, stripAudioTags, PAUSE_MARK, CLICK_MARK, canonMarks } from './sentences.mjs';
import { serveForRender } from '../cli/serve.mjs';
import { run as runBounded, PROBE_MS } from './exec.mjs';
import { staleSlides, slideTexts, priorSlideTexts, slideNotes, markerPauses } from './narration-manifest.mjs';
import { synthesizeSlides, readTrack, trackFormat } from './narration-synth.mjs';
import { createEngine, engineStatus, engineBlocker, ENGINES, piperModelDir } from './tts-engines.mjs';
import { loadTtsConfig } from './tts-setup.mjs';
import { createTtsCache } from './tts-cache.mjs';
import { faceLayout } from './face-layout.mjs';

const run = promisify(execFile);

/** Every slide breathes before the next one starts talking. */
export const TAIL_SECONDS = 0.4;

const HELP = `decklight video <deck.html> [options] — render the deck to a narrated mp4

  -o, --out <file>     output file (default: <deck>.mp4 next to the deck, or
                       <deck>.slides-a-b.mp4 for a --slides range; .mov/.webm
                       with --format)
  --narration <dir>    narration dir (default: <deckdir>/voiceover if it has a
                       manifest.json; otherwise the deck renders silent)
  --no-narration       render silent, even with a voiceover/ beside the deck
  --allow-stale        render although the narration was recorded from other
                       notes than the deck has now (the slides are still named)
                       — for what cannot be re-voiced; a machine-voiced track's
                       stale slides are re-voiced first (below)
  --no-revoice         leave a machine-voiced track's stale slides as they are:
                       refuse them, or render them old with --allow-stale
  --format <f>         mp4 (H.264/AAC, the default) · mov (H.264/AAC) · webm
                       (VP9/Opus); read off -o's extension when that names one
  --quality <q>        draft (quick, small) · standard (the default) · high
                       (slower to render, sharper, larger)
  --subtitles <how>    none (the default) · embed (a track the player can turn
                       on) · file (a .srt beside the video, .vtt for webm) —
                       what the narration says, timed against its audio
  --size <WxH>         frame size (default 1280x720; both must be even)
  --fps <n>            video frame rate (default 30)
  --hold <s>           seconds a slide without narration holds (default 5;
                       per-slide override: data-video-hold="8" on the section).
                       A NARRATED slide holds for its audio instead — give that
                       one a beat with data-narration-pause="2", the same
                       attribute the live deck pauses on
  --build-hold <s>     seconds each build-up frame holds on a silent slide
                       (default: the slide's own hold, so builds move at the
                       pace the deck does)
  --theme <name>       render in another theme — one of the deck's own, an added
                       one, or a themes/<name>.css file (rides ?theme=)
  --gen <b64url>       render in a theme that has no name the deck knows — a
                       custom or generated one, as {name, tokens} base64url JSON
                       (rides ?gen=; the export row sends it for you)
  --slides <a-b>       only this slide range (1-based, inclusive)
  --voiceover          run the voiceover batch (tools/voiceover.mjs) first —
                       over the --slides range only, when one is given
  --no-face            leave out the face you filmed while recording the
                       narration. By default it shows the way each slide says
                       (data-face: the corner medallion, hidden, or full
                       screen at a zoom), in time with your voice

Every slide BUILDS, one frame per step, and each build fades or slides in as it
does in the deck. A slide that animates (an SVG <animate>, a looping CSS
animation) plays at --fps for its whole hold, from the start of its loop; a
slide with no motion stays a cheap still. Moving capture needs Node 22+.
A narrated slide takes its timing from its own audio: [click] in the speaker
notes splits the narration, and segment k is spoken over build step k — the
same rule the live player follows. Without
markers it holds fully built for the audio's real duration. A silent slide holds
--hold seconds, --build-hold per step. Either way the audio track is continuous
and the finished slide gets a ${TAIL_SECONDS}s breath before the cut — plus
whatever data-narration-pause="2" asks for, so the mp4 breathes where the
live deck does.
Needs ffmpeg + ffprobe on PATH, and a Chrome ($CHROME or an installed one).
`;

/** '1280x720' → { w, h }. Both even — libx264 yuv420p refuses odd dimensions. */
export function parseSize(s) {
  const m = /^(\d+)x(\d+)$/.exec(s ?? '');
  if (!m) throw new Error(`--size must be WxH, e.g. 1280x720 (got "${s}")`);
  const w = Number(m[1]); const h = Number(m[2]);
  if (w % 2 || h % 2) throw new Error(`--size must be even in both dimensions (yuv420p), got ${w}x${h}`);
  return { w, h };
}

/** '2-5' or '3' → { from, to } (1-based, inclusive), validated against the deck. */
export function parseSlideRange(s, total) {
  if (!s) return { from: 1, to: total };
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) throw new Error(`--slides must be a-b or a single slide number (got "${s}")`);
  const from = Number(m[1]); const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to > total || from > to) {
    throw new Error(`--slides ${s} is outside this deck (${total} slide${total === 1 ? '' : 's'})`);
  }
  return { from, to };
}

/**
 * Where a render lands: `talk.mp4`, or `talk.slides-5-9.mp4` for a range — so
 * five slides rendered to check a fix never overwrite the whole talk. The deck's
 * export row writes the same name, because what a row writes is what this
 * command writes.
 */
export function videoOut(deck, slides = null, format = 'mp4') {
  return `${deck.replace(/\.html?$/i, '')}${slides ? `.slides-${slides}` : ''}.${ENCODINGS[format]?.ext ?? 'mp4'}`;
}

/** The sidecar subtitles of a render: the video's name, with the container's own subtitle extension. */
export function subtitlesOut(out, format = 'mp4') {
  return `${out.replace(/\.[^./\\]+$/, '')}.${ENCODINGS[format].subtitleExt}`;
}

/**
 * --format, --quality and --subtitles, checked. The format is read off `-o`
 * when only the file name says it, and a name and a flag that disagree are
 * refused rather than settled: `-o talk.mp4 --format webm` would otherwise write
 * a WebM that every player then refuses by its extension.
 */
export function videoOptions({ out = null, format = null, quality = null, subtitles = null } = {}) {
  const formats = valuesOf(VIDEO_FORMATS);
  if (format != null && !formats.includes(format)) throw new Error(`--format must be ${formats.join(', ')} (got "${format}")`);
  const named = out ? /\.([a-z0-9]+)$/i.exec(basename(out))?.[1]?.toLowerCase() ?? null : null;
  if (format && named && named !== ENCODINGS[format].ext) {
    throw new Error(`-o ${basename(out)} is not a .${ENCODINGS[format].ext} — drop --format, or name the file .${ENCODINGS[format].ext}`);
  }
  if (!format && named && !formats.includes(named)) {
    throw new Error(`-o ${basename(out)}: .${named} is not a format this writes — use ${formats.map((f) => `.${f}`).join(', ')}`);
  }
  const qualities = valuesOf(VIDEO_QUALITIES);
  if (quality != null && !qualities.includes(quality)) throw new Error(`--quality must be ${qualities.join(', ')} (got "${quality}")`);
  const modes = valuesOf(VIDEO_SUBTITLES);
  if (subtitles != null && !modes.includes(subtitles)) throw new Error(`--subtitles must be ${modes.join(', ')} (got "${subtitles}")`);
  return { format: format ?? named ?? 'mp4', quality: quality ?? 'standard', subtitles: subtitles ?? 'none' };
}

/**
 * Read this command's own output as progress: the plan line names how many
 * slides the render covers, and each frame line names its slide. `onSlide(n, of)`
 * fires once per slide, when its first frame is done — the edit server
 * relays it to the deck's export row, which is how a render that takes minutes
 * keeps saying where it is.
 */
export function videoProgress(onSlide) {
  let of = 0;
  const seen = new Set();
  return (line) => {
    const head = /^\S.*: (\d+) slides?, \d+ narrated/.exec(line);
    if (head) { of = Number(head[1]); return; }
    const frame = /^\s+slide (\d+)[:\s·]/.exec(line);
    if (frame && of && !seen.has(frame[1])) { seen.add(frame[1]); onSlide(seen.size, of); }
  };
}

/**
 * The same, for `tools/voiceover.mjs` when an export voices its slides first:
 * its plan line ends `· N to voice`, and each slide line after it — synthesized,
 * or kept from an earlier run — is one of those N done.
 */
export function voiceoverProgress(onSlide) {
  let of = 0;
  let n = 0;
  return (line) => {
    const head = / · (\d+) to voice$/.exec(line);
    if (head) { of = Number(head[1]); return; }
    if (of && /^\s+slide \d+: /.test(line)) onSlide(++n, of);
  };
}

/**
 * argv for the `--voiceover` batch. The range rides along: rendering slides 5-9
 * should not synthesise the other thirty, and on a paid engine that is a bill.
 */
export function voiceoverArgs(deck, { narration, slides } = {}) {
  return [fileURLToPath(new URL('./voiceover.mjs', import.meta.url)), deck,
    ...(narration ? ['-o', resolve(narration)] : []), ...(slides ? ['--slides', slides] : [])];
}

/** Per-slide `data-face` (FACE_LAYOUT), read off the open tag like extractHolds; null where there is none. */
export function extractFaces(html) {
  return sectionBodies(html).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    return tag.match(/\sdata-face="([^"]*)"/)?.[1] ?? null;
  });
}

/** The medallion in the frame: the deck's own size and corner margin (CSS px, and a frame is a window of them). */
export const FACE_CORNER_PX = { size: 220, margin: 28 };

/**
 * The filmed face for one planned frame, or null: the clip beside its audio
 * (slide-NN-KK.mp4 beside slide-NN-KK.wav), on a slide whose manifest entry
 * says it was filmed, placed as the slide's `data-face` says for that beat.
 */
export function faceFor(p, { narration, faces, exists = existsSync }) {
  if (!p.audio || !narration?.slides?.[p.slide - 1]?.face) return null;
  const clip = join(narration.dir, p.audio.replace(/\.[^.]+$/, '.mp4'));
  if (!exists(clip)) return null;
  const beat = Number(/^slide-\d+-(\d+)\./.exec(basename(p.audio))?.[1] ?? 1);
  const at = faceLayout(faces?.[p.slide - 1], beat);
  return at.kind === 'hide' ? null : { clip, ...at };
}

/** Per-slide hold seconds: data-video-hold="8" on the section, else the default. */
export function extractHolds(html, defaultHold) {
  return sectionBodies(html).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    const m = tag.match(/data-video-hold="([\d.]+)"/);
    return m ? Number(m[1]) : defaultHold;
  });
}

/**
 * The runtime's built-in hold before a slide turns (SLIDE_PAUSE_S in
 * src/core/narration.js — not imported, because src/ does not ship in the
 * package; test/video.test.mjs pins the two equal). An exported mp4 must
 * breathe where the live deck does, and the live deck now breathes here by
 * default.
 */
export const SLIDE_PAUSE_DEFAULT = 1;

/**
 * Seconds of ⟨PAUSE⟩ hold each build step of each slide asks for (#560): the
 * markers in the ⟨CLICK⟩ segments that step narrates, each two beat pauses
 * (`markerPauses`). `steps[i]` is slide i+1's build count; the array for a
 * slide has one entry per frame, the finished slide last. Segments fold the
 * way the runtime's `stepAudio` folds them — empty ones kept, so segment k is
 * step k, and every surplus segment on the last step.
 *
 * A render with narration has the holds IN its audio — the deck's recorder and
 * the synthesis core both bake them — so only a SILENT frame reads this.
 */
export function pauseMarks(html, steps = null) {
  const holds = markerPauses(html);
  return slideNotes(html).map((notes, i) => {
    const segs = notes.split(CLICK_MARK).map((t) => t.split(PAUSE_MARK).length - 1);
    const builds = steps?.[i] ?? 0;
    return Array.from({ length: builds + 1 }, (_, k) => (k < builds ? segs[k] ?? 0 : segs.slice(k).reduce((a, b) => a + b, 0)) * holds[i]);
  });
}

/**
 * Per-slide narration beat: data-narration-pause="2" on the section, else
 * the built-in default above.
 *
 * The recorded mirror of the live rule (PRESENTING): src/core/narration.js
 * holds that many seconds after a slide's last sentence before moving on, and
 * an exported mp4 must breathe in the same places the deck does. Read off the
 * raw open tag, like extractHolds, so the same attribute appearing in a
 * slide's CONTENT cannot be mistaken for the slide's own. (The deck-wide
 * `narration.slidePause` config tier is not read here: it lives inside the
 * boot call, and this reads sections, not scripts.)
 */
export function extractPauses(html) {
  return sectionBodies(html).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    const m = tag.match(/data-narration-pause="([\d.]+)"/);
    return m ? Number(m[1]) : SLIDE_PAUSE_DEFAULT;
  });
}

/**
 * An oversized step: the engine clamps it to the slide's last build, so this
 * always renders a slide fully built however many steps it turns out to have.
 * Every slide's FINAL frame is captured here rather than at a counted step, so
 * a miscount can shorten the build-up but can never lose the finished slide.
 */
export const LAST_STEP = 999;

/** A build's own transition plays in this long; the rest of its frame is its last picture, held. */
export const MOTION_WINDOW_S = 1;

const round = (s) => Math.round(s * 1000) / 1000;

/**
 * The schedule: which frame of which slide is on screen, under what audio, for
 * how long.
 *
 * ONE ENTRY PER FRAME, not per slide. A silent slide with builds is a sequence
 * — the slide bare, then each build revealed — because a video of a built slide
 * that opens fully built has thrown away the thing the builds were for. A
 * A NARRATED slide follows its own notes: where those notes are segmented by
 * ⟨CLICK⟩ and the segment count matches the build count, segment k narrates
 * build step k and holds for that segment's REAL audio. Nothing is inferred —
 * the markers are the author's, tools/voiceover.mjs synthesises one file per
 * segment, and this reads their ffprobe'd durations. A narrated slide with no
 * markers, or a count that does not line up, is one fully-built still for the
 * length of its audio, as it always was.
 *
 * Timing, for a silent slide with `b` build steps (so `b + 1` frames): EVERY
 * frame holds for the slide's hold, so a build lands at the pace the rest of
 * the deck moves at and the deck gets longer the more it builds. Splitting the
 * hold across the frames instead — keeping the deck's length fixed — was tried
 * first and reads far too fast: the more a slide has to say, the less time each
 * beat of it got, which is exactly backwards. `buildHold` overrides the
 * build-up frames alone, for a deck that wants its builds quicker (or slower)
 * than its slides.
 *
 * @param {Array|null} manifest   manifest.slides from tools/voiceover.mjs
 *                                ({ file } per slide, null for silent slides) —
 *                                or null for a fully silent deck
 * @param {object} durations      audio file → real (ffprobe) seconds
 * @param {number[]} holds        per-slide hold seconds (one per section)
 * @param {{from,to}} [range]     1-based inclusive slide range
 * @param {object} [opts]         steps: per-slide build-step counts (null ⇒ one
 *                                frame per slide); buildHold: seconds per
 *                                build-up frame (null ⇒ the slide's own hold);
 *                                pauses: per-slide data-narration-pause seconds
 *                                added to a NARRATED slide's finished frame;
 *                                marks: pauseMarks — ⟨PAUSE⟩ seconds per frame
 *                                added to a SILENT one (narrated audio has them)
 * @returns {Array<{slide, step, audio, duration, pad}>}  audio null ⇒ silent hold;
 *                                `pad` is the silence ffmpeg appends to the audio
 */
export function planTimeline(manifest, durations, holds, range = null, { steps = null, buildHold = null, pauses = null, marks = null, onWarn = null } = {}) {
  const from = range?.from ?? 1;
  const to = range?.to ?? holds.length;
  const plan = [];
  for (let n = from; n <= to; n++) {
    const entry = manifest?.[n - 1] ?? null;
    const file = entry?.file ?? null;
    const dur = file ? durations?.[file] : null;

    // A narrated slide whose notes are segmented by ⟨CLICK⟩ builds AS IT
    // SPEAKS: segment k narrates build step k. That rule is not invented here —
    // src/core/narration.js already speaks live narration that way ("exactly
    // like a presenter reading the notes and clicking between segments"), and
    // captions, rehearse mode and the notes editor all run on the same
    // segmentation. This makes the recorded render the mirror of it.
    const segs = entry?.segments ?? null;
    const builds = steps?.[n - 1] ?? 0;
    // The slide's own beat rides on the tail of its finished frame — the one
    // place the live deck pauses too. A silent slide has no narration to pause
    // after; --hold and data-video-hold are its knobs.
    const tail = TAIL_SECONDS + (pauses?.[n - 1] ?? 0);
    if (Number.isFinite(dur) && segs?.length && builds) {
      const times = segs.map((sg) => durations?.[sg.file]);
      if (segs.length === builds + 1 && times.every((t) => Number.isFinite(t))) {
        segs.forEach((sg, k) => {
          const last = k === segs.length - 1;
          plan.push({
            slide: n,
            step: last ? LAST_STEP : k,
            audio: sg.file,
            // Only the finished slide gets the breath. A build that paused for
            // it would read as hesitation rather than as a beat.
            duration: round(times[k] + (last ? tail : 0)),
            pad: last ? tail : 0,
          });
        });
        continue;
      }
      // A marker count that does not match the build count is the author's to
      // fix, and guessing which build a segment belongs to would bake a wrong
      // sync into an mp4 — worse than no sync. Say which slide, and render it
      // the way an unsegmented one renders.
      onWarn?.(`slide ${n}: ${segs.length} narration segment${segs.length === 1 ? '' : 's'}`
        + ` but ${builds + 1} frames (${builds} build${builds === 1 ? '' : 's'} + the finished slide)`
        + ' — narrating the whole slide over one still instead');
    }

    if (Number.isFinite(dur)) {
      plan.push({ slide: n, step: LAST_STEP, audio: file, duration: round(dur + tail), pad: tail });
      continue;
    }
    // No audio to carry them, so a silent frame holds its ⟨PAUSE⟩ markers
    // itself — the same seconds a narrated one has baked into its file.
    const hold = holds[n - 1];
    const mark = (k) => marks?.[n - 1]?.[k] ?? 0;
    if (!builds) { plan.push({ slide: n, step: LAST_STEP, audio: null, duration: round(hold + mark(0)) }); continue; }
    const each = buildHold ?? hold;
    for (let k = 0; k < builds; k++) plan.push({ slide: n, step: k, audio: null, duration: round(each + mark(k)) });
    plan.push({ slide: n, step: LAST_STEP, audio: null, duration: round(hold + mark(builds)) });
  }
  return plan;
}

/**
 * How each container is encoded, at each quality.
 *
 * `standard` for mp4 is what this command always wrote (x264's own defaults,
 * AAC at 128k), so a render that asks for nothing comes out as it did. WebM is
 * VP9 in constant-quality mode (`-b:v 0` is what makes `-crf` mean that) with
 * Opus, which takes 48 kHz and nothing else — so its silent segments are
 * synthesized at 48 kHz too, or the concat's `-c copy` audio would change rate
 * mid-file. Draft trades VP9's quality search for speed (`realtime`), because a
 * draft is for checking the timing, not the picture.
 */
const X264 = { draft: { preset: 'veryfast', crf: '28' }, standard: { preset: 'medium', crf: '23' }, high: { preset: 'slow', crf: '18' } };
const VP9 = { draft: { crf: '40', deadline: 'realtime', cpu: '8' }, standard: { crf: '32', deadline: 'good', cpu: '4' }, high: { crf: '24', deadline: 'good', cpu: '2' } };
const AUDIO_KBPS = { draft: '96k', standard: '128k', high: '192k' };
const H264 = {
  faststart: true, subtitleCodec: 'mov_text', subtitleExt: 'srt', sampleRate: 44100,
  video: (q, moving = false) => ['-c:v', 'libx264', ...(moving ? [] : ['-tune', 'stillimage']), '-pix_fmt', 'yuv420p', '-preset', X264[q].preset, '-crf', X264[q].crf],
  audio: (q) => ['-c:a', 'aac', '-b:a', AUDIO_KBPS[q], '-ar', '44100', '-ac', '2'],
};
export const ENCODINGS = {
  mp4: { ext: 'mp4', ...H264 },
  mov: { ext: 'mov', ...H264 },
  webm: {
    ext: 'webm', faststart: false, subtitleCodec: 'webvtt', subtitleExt: 'vtt', sampleRate: 48000,
    video: (q) => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', VP9[q].crf,
      '-deadline', VP9[q].deadline, '-cpu-used', VP9[q].cpu, '-row-mt', '1'],
    audio: (q) => ['-c:a', 'libopus', '-b:a', AUDIO_KBPS[q], '-ar', '48000', '-ac', '2'],
  },
};

/**
 * ffmpeg argv for one slide's segment: the still looped at --fps under its
 * audio, or a moving frame's sequence (`frames`) with its last picture held. Narrated slides pad the audio with `pad` — the tail, plus whatever
 * beat the slide asked for (`data-narration-pause`) — and stop there; silent
 * slides synthesize the same stereo/44.1k silence (anullsrc), so every segment
 * carries an audio stream and the concat-demuxer's `-c copy` audio track never
 * goes discontinuous. -t bounds both the infinite loop and the infinite
 * anullsrc (-shortest can't end a segment whose streams are both endless).
 */
export function segmentArgs({ frame, frames = null, audio, duration, fps, out, pad = TAIL_SECONDS, format = 'mp4', quality = 'standard', face = null, size = null }) {
  const enc = ENCODINGS[format];
  // A moving segment reads a numbered sequence (`frames: { pattern, count }`)
  // and holds its last picture for whatever the sequence does not cover, so
  // the segment is as long as the still would have been.
  const rest = frames ? Math.max(0, duration - frames.count / fps) : 0;
  if (face && audio && size) return faceSegmentArgs({ frame, frames, rest, audio, duration, fps, out, pad, enc, quality, face, size });
  return [
    '-y', ...(frames
      ? ['-framerate', String(fps), '-i', frames.pattern]
      : ['-loop', '1', '-framerate', String(fps), '-i', frame]),
    ...(audio
      ? ['-i', audio, '-af', `apad=pad_dur=${pad}`]
      : ['-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${enc.sampleRate}`]),
    ...(rest > 0 ? ['-vf', `tpad=stop_mode=clone:stop_duration=${rest.toFixed(3)}`] : []),
    ...enc.video(quality, !!frames), ...enc.audio(quality),
    '-t', Number(duration).toFixed(3), ...(enc.faststart ? ['-movflags', '+faststart'] : []), out,
  ];
}

/**
 * segmentArgs with your face in it: the medallion over the still, cut round
 * in the corner (`corner`), or the face alone over the whole frame, cropped
 * to fill it and zoomed on itself the way the deck's `transform-origin: 50%
 * 40%` zooms it (`full`). The clip is exactly as long as the audio (the
 * recorder made it so); it holds its last frame through the slide's breath,
 * as the deck holds it between beats. Same encoder, frame rate and size as
 * every other segment, so the concat's `-c copy` still joins them.
 */
function faceSegmentArgs({ frame, frames, rest, audio, duration, fps, out, pad, enc, quality, face, size }) {
  const { w, h } = size;
  const hold = `tpad=stop_mode=clone:stop_duration=${Number(pad + 1).toFixed(3)}`;
  let graph;
  if (face.kind === 'full') {
    const zw = Math.ceil((w * face.zoom) / 2) * 2;
    const zh = Math.ceil((h * face.zoom) / 2) * 2;
    graph = `[2:v]fps=${fps},scale=${zw}:${zh}:force_original_aspect_ratio=increase,`
      + `crop=${w}:${h}:(iw-${w})/2:(ih-${h})*0.4,setsar=1,${hold},format=yuv420p[v]`;
  } else {
    const d = FACE_CORNER_PX.size;
    const m = FACE_CORNER_PX.margin;
    graph = `[2:v]fps=${fps},scale=${d}:${d}:force_original_aspect_ratio=increase,crop=${d}:${d},setsar=1,${hold},format=yuva420p,`
      + `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lte(hypot(X-${d / 2},Y-${d / 2}),${d / 2}),255,0)'[f];`
      + `[0:v]${rest > 0 ? `tpad=stop_mode=clone:stop_duration=${rest.toFixed(3)},` : ''}setsar=1[s];[s][f]overlay=${w - d - m}:${h - d - m}:eof_action=repeat,format=yuv420p[v]`;
  }
  return [
    '-y', ...(frames
      ? ['-framerate', String(fps), '-i', frames.pattern]
      : ['-loop', '1', '-framerate', String(fps), '-i', frame]),
    '-i', audio, '-i', face.clip,
    '-filter_complex', `${graph};[1:a]apad=pad_dur=${pad}[a]`,
    '-map', '[v]', '-map', '[a]', '-r', String(fps),
    ...enc.video(quality, true), ...enc.audio(quality),
    '-t', Number(duration).toFixed(3), ...(enc.faststart ? ['-movflags', '+faststart'] : []), out,
  ];
}

/** The concat-demuxer list: one `file '…'` line per segment, quotes escaped. */
export function concatList(segments) {
  return segments.map((s) => `file '${s.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

/**
 * ffmpeg argv joining the segments into the output without re-encoding — and,
 * when there are subtitles to embed, mapping them in as a track of the
 * container's own kind (the only step that encodes anything, and it is text).
 */
export function concatArgs(listFile, out, { format = 'mp4', subtitles = null } = {}) {
  const enc = ENCODINGS[format];
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    ...(subtitles ? ['-i', subtitles, '-map', '0', '-map', '1'] : []),
    '-c', 'copy', ...(subtitles ? ['-c:s', enc.subtitleCodec] : []),
    ...(enc.faststart ? ['-movflags', '+faststart'] : []), out];
}

/** A subtitle longer than this is split into cues of its own; two lines of about half each is what a player shows. */
export const CUE_MAX_CHARS = 84;

/** Words into runs of at most `max` characters, never mid-word. */
function chunkCue(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > max) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** One cue's text on at most two lines, broken at the space nearest the middle. */
function wrapCue(text, line = CUE_MAX_CHARS / 2) {
  if (text.length <= line) return text;
  const mid = text.length / 2;
  let at = -1;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) if (at < 0 || Math.abs(i - mid) < Math.abs(at - mid)) at = i;
  return at < 0 ? text : `${text.slice(0, at)}\n${text.slice(at + 1)}`;
}

/**
 * The subtitles of a render: what each narrated frame SAYS, timed against the
 * frame's real audio.
 *
 * The unit is the sentence, split by the very function the live captions use
 * (`splitSentences`, tools/sentences.mjs), so a video's subtitles break
 * where the deck's captions do. Within one beat the audio is ONE file, so
 * where a sentence starts inside it is not known — it is shared out by length,
 * which lands close for speech and is exact at every beat boundary. The breath
 * after a slide (`pad`) carries no caption, and a silent frame none at all.
 * Nor does a ⟨PAUSE⟩ (#560): the script beside a clip keeps its markers, and
 * each one is `holdOf(frame)` seconds of the clip's silence — taken out of the
 * time shared among the words, and left uncaptioned where it falls.
 *
 * @param plan    planTimeline's frames, in order
 * @param textOf  frame → the words its audio speaks, ⟨PAUSE⟩ markers and all
 * @param holdOf  frame → seconds one ⟨PAUSE⟩ holds on its slide
 * @returns {Array<{start, end, text}>} seconds from the start of the video
 */
export function subtitleCues(plan, textOf, holdOf = () => 0) {
  const cues = [];
  let t = 0;
  for (const p of plan) {
    const speech = p.audio ? Math.max(0, p.duration - (p.pad ?? 0)) : 0;
    const { lead, runs } = speechRuns(speech ? String(textOf(p) ?? '') : '');
    const hold = runs.length ? holdOf(p) : 0;
    const held = hold * (lead + runs.reduce((n, r) => n + r.pause, 0));
    const spoken = Math.max(0, speech - held);
    // pieces of { text, weight }, each run's then its hold
    const cut = runs.map((r) => ({
      // an audio tag is direction for the voice, never a subtitle
      pieces: splitSentences(r.text).map(stripAudioTags).filter(Boolean).flatMap((s) => chunkCue(s, CUE_MAX_CHARS))
        .map((text) => ({ text, weight: text.length })),
      pause: r.pause,
    }));
    const total = cut.reduce((n, c) => n + c.pieces.reduce((m, x) => m + x.weight, 0), 0);
    let at = t + lead * hold;
    for (const c of cut) {
      for (const piece of c.pieces) {
        const len = spoken * (piece.weight / total);
        cues.push({ start: round(at), end: round(at + len), text: wrapCue(piece.text) });
        at += len;
      }
      at += c.pause * hold;
    }
    t += p.duration;
  }
  return cues;
}

const stamp = (s, mark) => {
  const ms = Math.round(s * 1000);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(Math.floor(ms / 3600000))}:${two(Math.floor(ms / 60000) % 60)}:${two(Math.floor(ms / 1000) % 60)}${mark}${String(ms % 1000).padStart(3, '0')}`;
};
// An arrow inside a line would read as a timing line to a strict parser.
const safeCue = (text) => text.replaceAll('-->', '→');

/** SubRip: numbered cues, comma before the milliseconds. */
export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${safeCue(c.text).replaceAll('<', '‹')}\n`).join('\n');
}

/** WebVTT: a header, a dot before the milliseconds, and `<` / `&` escaped — cue text is markup there. */
export function toVtt(cues) {
  const esc = (t) => safeCue(t).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${esc(c.text)}\n`).join('\n')}`;
}

/** ffprobe argv for a file's real duration in seconds (prints one number). */
export function ffprobeArgs(file) {
  return ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file];
}

/**
 * A folder recorded by hand, read off the disk: what a manifest would say
 * about its files, and nothing it would say about the notes. Your own voice
 * (`narrate --mic`) wrote no manifest, and a folder of `slide-NN.wav` with its
 * `slide-NN-KK.wav` beats is everything a render plays; with no hash per
 * slide, the freshness check counts it as hand-recorded and says so.
 * Null when the folder holds no whole-slide audio at all.
 */
export function folderNarration(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const EXT = ['wav', 'm4a', 'mp3'];   // a folder holding two, the recorder's first
  const whole = new Map();
  const beats = new Map();
  for (const f of names) {
    const m = /^slide-(\d+)(?:-(\d+))?\.(wav|m4a|mp3)$/.exec(f);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2] == null) {
      const had = whole.get(n);
      if (!had || EXT.indexOf(m[3]) < EXT.indexOf(had.split('.').pop())) whole.set(n, f);
    } else {
      if (!beats.has(n)) beats.set(n, new Map());
      const k = Number(m[2]);
      const had = beats.get(n).get(k);
      if (!had || EXT.indexOf(m[3]) < EXT.indexOf(had.split('.').pop())) beats.get(n).set(k, f);
    }
  }
  if (!whole.size) return null;
  const slides = [];
  for (let n = 1; n <= Math.max(...whole.keys()); n++) {
    const file = whole.get(n);
    if (!file) { slides.push(null); continue; }
    const segs = [...(beats.get(n) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => ({ file: f }));
    slides.push(segs.length ? { file, segments: segs } : { file });
  }
  return { dir, slides, engine: undefined, model: undefined, voice: undefined, style: undefined };
}

/**
 * Where the narration lives: --narration <dir> (its manifest, else the audio
 * files in it, recorded by hand) → <deckdir>/voiceover/manifest.json → null
 * (a silent deck).
 * @returns {{ dir, slides }|null}
 */
export function resolveNarration(deckPath, narrationDir) {
  const load = (dir, required) => {
    const path = join(dir, 'manifest.json');
    if (!existsSync(path)) {
      if (required) {
        const byHand = folderNarration(dir);
        if (byHand) return byHand;
        throw new Error(`--narration: no manifest.json and no slide-NN audio in ${dir} — `
          + 'record it first (decklight narrate, or decklight video --voiceover)');
      }
      return null;
    }
    const m = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(m?.slides)) {
      throw new Error(`${path}: not a voiceover manifest (no slides array) — regenerate it with tools/voiceover.mjs`);
    }
    // the header rides along: the freshness check hashes the deck's notes under it
    return { dir, slides: m.slides, engine: m.engine, model: m.model, voice: m.voice, style: m.style };
  };
  if (narrationDir) return load(resolve(narrationDir), true);
  return load(join(resolve(deckPath, '..'), 'voiceover'), false);
}

/**
 * Re-voice a machine-voiced track's stale slides, before a render (#553).
 *
 * A slide whose notes changed since it was voiced would speak against its own
 * captions, so the render refuses it (#536). When the track was voiced by an
 * ENGINE — its manifest header names one — and that engine is available here,
 * the refusal has an obvious fix the render can make itself: voice just those
 * slides again, in the track's own engine, model, voice and style, into its
 * own format and file names. That is a range-scoped call into the one
 * synthesis core every producer of a track shares (tools/narration-synth.mjs,
 * #555), so the refreshed slide is exactly what `voiceover` or the deck's
 * recorder would have written, and the freshness check it then passes is the
 * same hash.
 *
 * Returns `{ ok: true }` once every stale slide is voiced, or `{ ok: false,
 * why }` for a track that cannot be re-voiced — a human take (no engine), or an
 * engine this machine cannot run (no key, no model) — naming what is missing.
 * Before any synthesis it says how many clips it will ask for, from which
 * engine: on a cloud engine that is money, and the clip cache makes any
 * sentence already paid for free.
 */
export async function revoiceStale({
  html, narration, stale, log = console.log, env = process.env,
  create = createEngine, status = engineStatus, cache = createTtsCache(),
}) {
  const { dir, engine } = narration;
  if (!engine || !ENGINES.includes(engine)) {
    return { ok: false, why: `${basename(dir)}/ names no engine it was voiced with — a take in somebody's own voice is re-recorded, not re-voiced` };
  }
  // the engine's settings as the edit server passes them to voiceover: the
  // environment, then tts.json for THIS engine
  const saved = loadTtsConfig(env);
  const savedFor = saved?.engine === engine ? saved : null;
  const project = env.GOOGLE_CLOUD_PROJECT ?? saved?.project ?? null;
  const dataDir = savedFor?.dataDir ?? (engine === 'piper' ? piperModelDir(env) : null);
  const voice = narration.voice ?? undefined;
  const st = status(engine, { env, project, dataDir, voice: engine === 'piper' ? (voice ?? narration.model) : voice });
  if (!st.ready) {
    const b = engineBlocker(st, { env });
    return { ok: false, why: `it was voiced by ${engine}, which ${b ? `${b.why} — ${b.fix}` : `is not available here (${st.reason})`}` };
  }
  let tts;
  try {
    tts = create({
      engine, voice, project, dataDir, env,
      // the model is identity only where an engine has more than one per voice
      model: engine === 'elevenlabs' || engine === 'gemini' ? (narration.model ?? undefined) : undefined,
      format: savedFor?.format,
    });
  } catch (e) {
    return { ok: false, why: `it was voiced by ${engine}, which cannot start here — ${e.message}` };
  }
  try {
    const raw = slideNotes(html);
    const clips = stale.reduce((sum, n) => sum + (notesSegments(raw[n - 1] ?? '')?.length ?? 1), 0);
    log(`  re-voicing ${stale.length === 1 ? `slide ${stale[0]}` : `slides ${stale.join(', ')}`} in the track's own voice — `
      + `${clips} clip${clips === 1 ? '' : 's'} from ${engine}${voice ? ` (${voice})` : ''}`
      + `${typeof tts.cost === 'string' ? `, ${tts.cost}` : ''}; any sentence already voiced comes from the clip cache`);
    for (const n of stale) {
      const prev = readTrack(dir);
      await synthesizeSlides({
        html, dir, tts, voice, style: narration.style ?? undefined,
        format: trackFormat(prev) ?? 'wav', range: { from: n, to: n }, prev, cache, log,
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  } finally {
    tts.synth.close?.();
  }
}

const have = (bin) => {
  try { runBounded(bin, ['-version'], { stdio: 'ignore', timeout: PROBE_MS }); return true; }
  catch (e) { return e?.code !== 'ENOENT'; }
};

/**
 * The probe that answers "how many build steps does each slide have?".
 *
 * Asked of the DECK, in a browser, because that is the only place the answer
 * exists: grouping is the runtime's (`src/core/builds.js` — `data-build-stay`,
 * `data-build-self`, nesting, ⟨CLICK⟩ markers), and a second counter written in
 * Node would be a copy that drifts. It reads the count the same way the capture
 * URLs do: `goto(n, LAST_STEP)` clamps, so the resulting `state.step` IS the
 * slide's last step.
 *
 * Injected only for this one load, never for the frame captures — a probe that
 * called `goto` during a screenshot would photograph the wrong slide.
 */
const STEP_PROBE = `<script>
(function () {
  // 0 still · 1 only its builds move · 2 it animates (SMIL, or a CSS animation
  // that loops or outlasts a build's window). The slide's own entry animation
  // is on the section itself and does not count: a cut between slides stays a cut.
  function motion(d, i) {
    var sec = d._sections[i - 1];
    var inside = function (a) { var t = a.effect && a.effect.target; return t && t !== sec && sec.contains(t); };
    var long = function (a) { return !(a instanceof CSSTransition) && a.effect.getComputedTiming().endTime > ${MOTION_WINDOW_S * 1000}; };
    if (sec.querySelector('animate, animateMotion, animateTransform, set') || document.getAnimations().filter(inside).some(long)) return 2;
    d.goto(i, 0);
    document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) {} });
    d.goto(i, 1);
    return d.state.step > 0 && document.getAnimations().some(inside) ? 1 : 0;
  }
  function report() {
    var d = window.__decklightProbe, out = [], moves = [];
    try {
      for (var i = 1; i <= d.state.totalSlides; i++) { d.goto(i, ${LAST_STEP}); out.push(d.state.step); }
    } catch (e) { out = ['err', String(e && e.message)]; }
    try {
      for (var j = 1; j <= d.state.totalSlides; j++) { d.goto(j, ${LAST_STEP}); moves.push(motion(d, j)); }
    } catch (e) { moves = []; }
    var pre = document.createElement('pre');
    pre.textContent = 'DECKLIGHT-BUILD-STEPS ' + JSON.stringify(out) + '\\nDECKLIGHT-MOTION ' + JSON.stringify(moves);
    document.body.appendChild(pre);
  }
  if (document.readyState === 'complete') setTimeout(report, 30);
  else window.addEventListener('load', function () { setTimeout(report, 30); });
})();
</script>`;

/**
 * Make the deck's instance reachable, the way test/import-render.mjs does: a
 * deck that boots itself from its `init` call has the call's result exposed; a
 * deck as data (#520) boots itself, so the probe reads the instance off the
 * stage — lazily, since the engine is served into the page after this runs.
 */
const PROBE_GETTER = '<script>Object.defineProperty(window, "__decklightProbe", { get: () => document.querySelector(".decklight")?.__decklight });</script>\n';
const exposeInstance = (html) => {
  const out = html.replace(/\bDecklight\s*\.\s*init\s*\(/, 'window.__decklightProbe = Decklight.init(');
  return out !== html ? out : (injectBeforeBodyEnd(html, PROBE_GETTER) ?? html);
};

/** Parse the probe's answer out of a dumped DOM; null when it did not report. */
export function parseBuildSteps(dom, slides) {
  const m = /DECKLIGHT-BUILD-STEPS (\[[^\]]*\])/.exec(dom);
  if (!m) return null;
  let counts;
  try { counts = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(counts) || counts.some((c) => !Number.isInteger(c) || c < 0)) return null;
  return counts.length === slides ? counts : null;
}

/**
 * Parse the probe's per-slide motion out of a dumped DOM: 0 still, 1 only its
 * builds move, 2 it animates. Null when the deck did not report — every slide
 * then keeps the still path it had before animated capture.
 */
export function parseMotion(dom, slides) {
  const m = /DECKLIGHT-MOTION (\[[^\]]*\])/.exec(dom);
  if (!m) return null;
  let kinds;
  try { kinds = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(kinds) || kinds.some((k) => ![0, 1, 2].includes(k))) return null;
  return kinds.length === slides ? kinds : null;
}

/**
 * How many frames of a plan entry are captured moving (0 ⇒ the cheap still).
 * An animating slide (2) moves for the whole hold; a slide that only builds (1)
 * moves just in the first MOTION_WINDOW_S of a frame that a build led into —
 * `entered` — and every other frame of it is a still.
 */
export function motionFrames(kind, { duration, fps, entered }) {
  if (kind === 2) return Math.ceil(duration * fps);
  if (kind === 1 && entered) return Math.min(Math.ceil(duration * fps), Math.ceil(MOTION_WINDOW_S * fps));
  return 0;
}

/**
 * The motion of every plan entry: how many frames to capture moving (`count`,
 * 0 ⇒ a still), the step the page shows first when a build leads into it
 * (`from`), and how long the slide has been on screen when it starts
 * (`offset`). `kinds` is parseMotion's answer, or null for an all-still render.
 */
export function motionPlan(plan, kinds, fps) {
  let offset = 0;
  return plan.map((p, i) => {
    const prev = plan[i - 1];
    const same = prev?.slide === p.slide;
    offset = same ? offset + prev.duration : 0;
    const from = same ? prev.step : null;
    return { count: motionFrames(kinds?.[p.slide - 1] ?? 0, { duration: p.duration, fps, entered: same }), from, offset: round(offset) };
  });
}

/**
 * Photograph a moving frame: one page, every animation paused, the clock set by
 * hand to 0, 1/fps, 2/fps… — so frames are exactly a tick apart whatever the
 * machine's speed, and a loop starts from its beginning. SMIL has its own clock
 * (`setCurrentTime` on the svg); CSS animations and transitions share the
 * document's (`getAnimations`). `from` is the build step shown first: the page
 * then moves to `to`, and that transition is what the frames show — from its
 * own start, while whatever was already moving carries on from `offset`, the
 * seconds the slide has been on screen, so a loop does not restart at a build.
 * A slide's own entry animation (on the section) is finished, never played: a
 * still cuts between slides, and so does this.
 */
export async function captureMotion(page, { url, slide, from = null, to, offset = 0, count, fps, frameAt }) {
  // about:blank first: a URL that differs only in its hash is a same-document
  // navigation, which never fires load — and every capture wants a fresh page
  await page.navigate('about:blank');
  await page.navigate(`${url}#/${slide}/${from ?? to}`);
  await page.evaluate('(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise((r) => setTimeout(r, 400)))');
  await page.evaluate(`window.__dlBefore = new Set(document.getAnimations()); window.__dlSeek = (t, offset) => {
    const own = (el) => el && el.tagName === 'SECTION' && !el.parentElement.closest('section');
    for (const s of document.querySelectorAll('svg')) { try { s.pauseAnimations(); s.setCurrentTime(t + offset); } catch {} }
    for (const a of document.getAnimations()) {
      try {
        if (own(a.effect && a.effect.target)) { a.finish(); continue; }
        a.pause();
        a.currentTime = (window.__dlBefore.has(a) ? t + offset : t) * 1000;
      } catch {}
    }
  }`);
  // The build steps through the deck itself, the way a presenter's click does:
  // a hash change is a jump, and a jump applies its builds without animating.
  if (from != null) {
    await page.evaluate(`new Promise((r) => { document.querySelector('.decklight').__decklight.goto(${slide}, ${to}); requestAnimationFrame(() => setTimeout(r, 0)); })`);
  }
  for (let i = 0; i < count; i++) {
    await page.evaluate(`window.__dlSeek(${i / fps}, ${offset})`);
    await frameAt(i, await page.screenshot());
  }
}

export async function videoMain(argv, { exec: execRaw = run, log = console.log } = {}) {
  const { opt } = argReader(argv);
  const deckArg = argv.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  // Two different situations, and the stream and the exit code follow WHICH
  // one happened rather than whether a deck was named. Asking for help is not
  // a failure: it goes to stdout and exits 0, the way every other command
  // answers `--help`. Naming no deck IS a failure: stderr, exit 1.
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (wantsHelp || !deckArg) {
    (wantsHelp ? process.stdout : process.stderr).write(HELP);
    process.exit(wantsHelp ? 0 : 1);
  }
  const deck = resolve(deckArg);
  if (!existsSync(deck)) { console.error(`decklight video: no such deck: ${deck}`); process.exit(1); }

  // The served root is the directory you run from — the deck must sit inside it
  // so its relative assets (`../dist/decklight.js`, `themes/…`) resolve as URLs
  // off the loopback origin the frames are captured against. This is the no-trust mode's
  // rule, for the same reason (#229): the deck runs under the CSP, and a read
  // cannot escape the served tree. `cd` to a directory containing the deck.
  const root = process.cwd();
  if (deck !== root && !deck.startsWith(root + sep)) {
    console.error(`decklight video: the deck must live under the current directory (${root}) — cd there first`);
    process.exit(1);
  }

  // the voiceover encoder-detection policy: a missing tool is a hard, friendly
  // error naming what to install — not a stack trace three steps later
  if (!have('ffmpeg') || !have('ffprobe')) {
    console.error('decklight video needs ffmpeg and ffprobe — install ffmpeg '
      + '(apt install ffmpeg / brew install ffmpeg)');
    process.exit(1);
  }

  // Stopped part-way — the edit server's stop route sends SIGTERM. Every Chrome
  // and ffmpeg in flight is killed through this signal and the next one never
  // starts; the `finally` below takes the scratch frames, and the catch takes a
  // file ffmpeg had begun writing, because a half-written video looks exactly
  // like a finished one in a file browser. Anything not waiting on a child
  // (re-voicing over the network) gets a moment, then the process goes anyway.
  const stopping = new AbortController();
  process.once('SIGTERM', () => {
    stopping.abort();
    setTimeout(() => process.exit(143), 3000).unref();
  });
  const exec = (bin, args, opts = {}) => execRaw(bin, args, { ...opts, signal: stopping.signal });
  let writing = false;

  let out; let plan; let narration;
  try {
    const named = opt('-o', opt('--out'));
    const { format, quality, subtitles } = videoOptions({
      out: named, format: opt('--format'), quality: opt('--quality'), subtitles: opt('--subtitles'),
    });
    out = resolve(named ?? videoOut(deck, opt('--slides'), format));
    const { w, h } = parseSize(opt('--size', '1280x720'));
    const fps = Number(opt('--fps', '30'));
    const hold = Number(opt('--hold', '5'));
    const buildHoldArg = opt('--build-hold');
    const buildHold = buildHoldArg === undefined ? null : Number(buildHoldArg);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`--fps must be a positive number`);
    if (!Number.isFinite(hold) || hold <= 0) throw new Error(`--hold must be positive seconds`);
    if (buildHold !== null && (!Number.isFinite(buildHold) || buildHold <= 0)) {
      throw new Error(`--build-hold must be positive seconds`);
    }
    const theme = opt('--theme');
    const themeParams = renderThemeParams({ theme, gen: opt('--gen') });   // throws on a bad value, before any work

    const html = readFileSync(deck, 'utf8');
    const holds = extractHolds(html, hold);
    const pauses = extractPauses(html);
    if (!holds.length) throw new Error(`${basename(deck)} has no <section> slides`);
    const range = parseSlideRange(opt('--slides'), holds.length);

    if (argv.includes('--voiceover')) {
      const vo = voiceoverArgs(deck, { narration: opt('--narration'), slides: opt('--slides') });
      const r = spawnSync(process.execPath, vo, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('voiceover batch failed — see its output above');
    }

    // --no-narration is silence asked for by name: without it, a voiceover/
    // beside the deck narrates whether or not that was the voice wanted
    narration = argv.includes('--no-narration') ? null : resolveNarration(deck, opt('--narration'));
    // Is the track still THIS deck's notes? Each manifest slide carries the
    // hash of the notes it was voiced from; a slide whose notes moved since
    // would speak against its own captions, so it is named and, unless asked
    // for by name, refused (#536). Only the slides being rendered are checked.
    if (narration) {
      let { stale, hashless } = staleSlides(narration, slideTexts(html), range, priorSlideTexts(html));
      if (hashless) log(`  narration: ${hashless} slide${hashless === 1 ? '' : 's'} in ${basename(narration.dir)}/ carr${hashless === 1 ? 'ies' : 'y'} no notes hash (recorded by hand) — not checked`);
      for (const n of stale) console.warn(`  slide ${n}: narration was recorded from different notes`);
      // A machine-voiced track fixes itself: its stale slides are voiced again
      // in its own voice, and the check runs again on what that wrote (#553).
      let unrevoiced = null;
      if (stale.length && !argv.includes('--no-revoice')) {
        const r = await revoiceStale({ html, narration, stale, log });
        if (r.ok) {
          narration = resolveNarration(deck, narration.dir);
          ({ stale } = staleSlides(narration, slideTexts(html), range, priorSlideTexts(html)));
        } else {
          unrevoiced = r.why;
          console.warn(`  not re-voiced: ${r.why}`);
        }
      }
      if (stale.length) {
        const which = stale.length === 1 ? `slide ${stale[0]}` : `slides ${stale.join(', ')}`;
        if (!argv.includes('--allow-stale')) {
          // the two fixes have two names (#919): your own voice is
          // re-recorded at the microphone, an engine's track is re-voiced
          const fix = narration.engine ? 're-voice' : 're-record';
          throw new Error(`the narration in ${narration.dir} was recorded from older notes on ${which}`
            + `${unrevoiced ? ` and cannot be re-voiced here: ${unrevoiced}` : ''} — `
            + `${fix} ${stale.length === 1 ? 'it' : 'them'} from the deck (V, then ⋯ on ${basename(narration.dir)}) or pass --allow-stale`);
        }
        console.warn(`  --allow-stale: rendering ${which} with the older narration`);
      }
    }

    // real durations, not the manifest's word count: ffprobe each audio file
    const durations = {};
    const hidden = sectionBodies(html).map(isHiddenSection);
    for (let n = range.from; n <= range.to; n++) {
      if (hidden[n - 1]) continue;   // a hidden slide keeps its number and gets no frame
      const entry = narration?.slides?.[n - 1];
      // The slide's own audio AND its ⟨CLICK⟩ segments. Measured here rather
      // than trusted from the manifest, for the reason the per-slide durations
      // already are: what a file says it is worth is not what ffprobe says.
      const files = [entry?.file, ...(entry?.segments ?? []).map((sg) => sg.file)].filter(Boolean);
      for (const file of files) {
        if (durations[file] != null) continue;
        const path = join(narration.dir, file);
        if (!existsSync(path)) {
          console.warn(`  slide ${String(n).padStart(2, '0')}: ${file} is in the manifest but not on disk`
            + `${file === entry?.file ? ` — holding ${holds[n - 1]}s of silence` : ' — narrating the whole slide instead'}`);
          continue;
        }
        durations[file] = Number((await exec('ffprobe', ffprobeArgs(path))).stdout.trim());
      }
    }


    // --theme rides the deck URL as `?theme=` — the runtime's own startup
    // override, as `decklight pdf` has always used it — so it reaches every
    // kind of theme a deck can hold: one of its inline blocks, an added one, or
    // a themes/<name>.css file. It used to inject a <link> to that file, which
    // on a deck whose themes are inline blocks (every `upgrade --link` deck)
    // pointed at nothing, and the render came out in the first block (#547).
    // …and every load is declared a render (`?capture`, #548). --gen rides
    // `?gen=` the same way, for a theme that lives only in a browser.
    const renderQuery = `?${['capture', ...themeParams].join('&')}`;
    let probing = false;
    const inject = (text, file) => {
      if (resolve(file) !== deck || !probing) return text;
      return injectBeforeBodyEnd(exposeInstance(text), STEP_PROBE) ?? text;
    };
    const deckPath = '/' + relative(root, deck).split(sep).join('/');

    const work = mkdtempSync(join(tmpdir(), 'decklight-video-'));
    const server = await serveForRender(root, { html: inject });
    try {
      const chrome = chromeBin('video');

      // Ask the deck how far each slide builds, in one extra load, before any
      // frame is captured. A deck that will not answer is not an error: the
      // plan falls back to one fully-built still per slide, which is what this
      // command did before builds had frames of their own.
      probing = true;
      let steps = null;
      let kinds = null;
      try {
        const dom = await exec(chrome, chromeArgs(
          '--hide-scrollbars', `--window-size=${w},${h}`,
          '--virtual-time-budget=2500', '--dump-dom', `${server.origin}${deckPath}${renderQuery}`,
        ), { maxBuffer: 64 * 1024 * 1024 });
        steps = parseBuildSteps(dom.stdout, holds.length);
        kinds = parseMotion(dom.stdout, holds.length);
      } catch { /* fall through to one frame per slide */ }
      probing = false;
      if (!steps) console.warn('  builds: the deck did not report its build steps — one still per slide');
      else if (!kinds) console.warn('  motion: the deck did not report which slides move — every frame a still');

      plan = planTimeline(narration?.slides ?? null, durations, holds, range,
        { steps, buildHold, pauses, marks: pauseMarks(html, steps), onWarn: (w) => console.warn(`  ${w}`) });
      const slideCount = new Set(plan.map((p) => p.slide)).size;
      log(`${basename(deck)}: ${slideCount} slide${slideCount === 1 ? '' : 's'}, `
        + `${plan.filter((p) => p.audio).length} narrated`
        + (plan.length > slideCount ? `, ${plan.length} frames` : '')
        + (narration ? ` (${narration.dir})` : ' (silent)'));

      // your face, where you filmed it, unless --no-face
      const faces = argv.includes('--no-face') ? null : extractFaces(html);
      const filmed = faces ? plan.filter((p) => faceFor(p, { narration, faces })).length : 0;
      if (filmed) log(`  your face: on ${filmed} frame${filmed === 1 ? '' : 's'} (--no-face leaves it out)`);
      const segments = [];
      const motion = motionPlan(plan, kinds, fps);
      let page = null;   // the one CDP page every moving frame shares, opened on first need
      let stillsOnly = false;
      try {
        for (const [f, p] of plan.entries()) {
          const nn = String(p.slide).padStart(2, '0');
          const id = `${nn}-${String(f).padStart(3, '0')}`;
          const m = motion[f];
          let frame = null; let frames = null;
          // A page that will not open (Node < 22 has no WebSocket) is not an
          // error: the slide is a still, as every slide was before #914.
          if (m.count && !page && !stillsOnly) {
            try { page = await openPage(chrome, { w, h, signal: stopping.signal }); } catch (e) {
              if (stopping.signal.aborted) throw e;
              stillsOnly = true;
              console.warn(`  motion: ${e.message} — moving slides render as stills`);
            }
          }
          if (m.count && page) {
            const dir = join(work, `frames-${id}`);
            mkdirSync(dir);
            await captureMotion(page, {
              url: `${server.origin}${deckPath}${renderQuery}`, slide: p.slide, from: m.from, to: p.step,
              offset: m.offset, count: m.count, fps,
              frameAt: (i, png) => writeFileSync(join(dir, `${String(i).padStart(5, '0')}.png`), png),
            });
            frames = { pattern: join(dir, '%05d.png'), count: m.count };
          } else {
            frame = join(work, `frame-${id}.png`);
            // one one-shot Chrome per still; LAST_STEP clamps to the last build.
            // `?capture` says it is a render: every frame is a fresh load, and
            // without it each one greeted the viewer with the voice-over hint (#548)
            await exec(chrome, chromeArgs(
              '--hide-scrollbars',
              '--autoplay-policy=no-user-gesture-required',
              `--window-size=${w},${h}`,
              '--virtual-time-budget=1500',
              `--screenshot=${frame}`,
              `${server.origin}${deckPath}${renderQuery}#/${p.slide}/${p.step}`,
            ));
            if (!existsSync(frame)) throw new Error(`chrome produced no frame for slide ${p.slide}`);
          }
          const seg = join(work, `seg-${id}.${ENCODINGS[format].ext}`);
          const face = faces ? faceFor(p, { narration, faces }) : null;
          await exec('ffmpeg', segmentArgs({
            frame, frames, duration: p.duration, pad: p.pad, fps, out: seg, format, quality,
            audio: p.audio ? join(narration.dir, p.audio) : null,
            face, size: { w, h },
          }));
          segments.push(seg);
          const where = p.step === LAST_STEP ? '' : ` · build ${p.step}`;
          const moving = frames ? ` · moving ${(m.count / fps).toFixed(1)}s` : '';
          log(`  slide ${nn}${where}: ${p.duration.toFixed(1)}s ${p.audio ?? '(silence)'}${moving}`);
        }
      } finally {
        await page?.close();
      }

      // Subtitles are the words the audio speaks: the script voiceover wrote
      // beside each clip when there is one (it may have been edited to change
      // what is said), the deck's own notes for that beat when there is not.
      let embedded = null;
      if (subtitles !== 'none') {
        const sections = sectionBodies(html);
        const textOf = (p) => {
          const script = join(narration.dir, p.audio.replace(/\.[^.]+$/, '.txt'));
          // an edited script may spell its markers the way a person does — `[pause]`
          if (existsSync(script)) return canonMarks(readFileSync(script, 'utf8'));
          const notes = sections[p.slide - 1]?.match(NOTES_ASIDE)?.[1] ?? '';
          const k = narration.slides?.[p.slide - 1]?.segments?.findIndex((sg) => sg.file === p.audio) ?? -1;
          return k >= 0 ? (notesSegments(notes, { marks: true })?.[k] ?? '') : cleanNotes(notes, { marks: true });
        };
        const markHolds = markerPauses(html);
        const cues = narration ? subtitleCues(plan, textOf, (p) => markHolds[p.slide - 1] ?? 0) : [];
        const enc = ENCODINGS[format];
        if (!cues.length) {
          console.warn('  subtitles: nothing is spoken in this render — none written');
        } else {
          const file = subtitles === 'embed' ? join(work, `subtitles.${enc.subtitleExt}`) : subtitlesOut(out, format);
          writeFileSync(file, enc.subtitleExt === 'vtt' ? toVtt(cues) : toSrt(cues));
          if (subtitles === 'embed') embedded = file;
          log(`  subtitles: ${cues.length} cue${cues.length === 1 ? '' : 's'} ${subtitles === 'embed' ? 'embedded' : `→ ${file}`}`);
        }
      }

      const list = join(work, 'concat.txt');
      writeFileSync(list, concatList(segments));
      writing = true;
      await exec('ffmpeg', concatArgs(list, out, { format, subtitles: embedded }));
      writing = false;
    } finally {
      await server.close();
      rmSync(work, { recursive: true, force: true });
    }

    const total = Number((await exec('ffprobe', ffprobeArgs(out))).stdout.trim());
    log(`done → ${out} (${total.toFixed(1)}s)`);
  } catch (e) {
    if (stopping.signal.aborted) {
      if (writing) rmSync(out, { force: true });
      console.error('decklight video: stopped — no video written');
      process.exit(143);
    }
    console.error(`decklight video: ${e.message}`);
    process.exit(1);
  }
}

// direct execution still works: node tools/video.mjs deck.html -o deck.mp4
if (isMain(import.meta.url)) {
  await videoMain(process.argv.slice(2));
}
