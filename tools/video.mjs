#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight video — render a deck to a narrated mp4.
//
//   decklight video deck.html -o deck.mp4
//                   [--narration <dir>] [--size 1280x720] [--fps 30] [--hold 5]
//                   [--build-hold <s>] [--theme <name>] [--slides a-b] [--voiceover]
//
// A still per FRAME — a narrated slide is one still, fully built, held for its
// audio; a silent slide builds as it goes, one still per step — muxed with the
// audio into one mp4, so a deck becomes a watchable, shareable video in one
// command. Every frame of a silent slide holds --hold, builds included, so a
// build lands at the pace the deck moves at; --build-hold paces the build-up
// frames alone. Narration resolves --narration <dir> → <deckdir>/voiceover/
// (the manifest tools/voiceover.mjs writes) → a fully silent deck where every
// slide holds --hold seconds (per-slide override: data-video-hold="8" on the
// section). Silent slides still carry a silent audio segment (anullsrc) so the
// concatenated audio track stays continuous.
//
// Capture is the tools/shot.mjs mechanism: one one-shot headless Chrome per
// frame against the deck served over http://127.0.0.1 at #/n/999 (an oversized
// step clamps to the last build, so every slide renders fully built). The deck
// is served under the `present` CSP, NOT opened over file:// with
// --allow-file-access-from-files (#229): that flag let a deck's own JS read any
// local file and exfiltrate it, and video renders decks you may not have
// vetted. No puppeteer, no CDP, no new deps — which is also the honest limit:
// frames are stills, so the character overlay appears but frozen and a build
// CUTS rather than animating (animated capture needs a CDP screencast — a
// Node ≥22 follow-up). How far each slide builds is asked of the deck itself,
// in one extra load, because the grouping is the runtime's and a second counter
// written here would be a copy that drifts.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from './chrome.mjs';
import { argReader, isMain } from './args.mjs';
import { injectBeforeBodyEnd, sectionBodies } from './deck-html.mjs';
import { serveForRender } from '../cli/present.mjs';

const run = promisify(execFile);

/** Every slide breathes before the next one starts talking. */
export const TAIL_SECONDS = 0.4;

const HELP = `decklight video <deck.html> [options] — render the deck to a narrated mp4

  -o, --out <file>     output mp4 (default: <deck>.mp4 next to the deck)
  --narration <dir>    narration dir (default: <deckdir>/voiceover if it has a
                       manifest.json; otherwise the deck renders silent)
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
  --theme <name>       render with themes/<name>.css instead of the deck's theme
  --slides <a-b>       only this slide range (1-based, inclusive)
  --voiceover          run the voiceover batch (tools/voiceover.mjs) first

Every slide BUILDS, one frame per step. A narrated slide takes its timing from
its own audio: ⟨CLICK⟩ in the speaker notes splits the narration, and segment k
is spoken over build step k — the same rule the live player follows. Without
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

/** Per-slide hold seconds: data-video-hold="8" on the section, else the default. */
export function extractHolds(html, defaultHold) {
  return sectionBodies(html).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    const m = tag.match(/data-video-hold="([\d.]+)"/);
    return m ? Number(m[1]) : defaultHold;
  });
}

/**
 * Per-slide narration beat: data-narration-pause="2" on the section, else 0.
 *
 * The recorded mirror of the live rule (PRESENTING): src/core/narration.js
 * holds that many seconds after a slide's last sentence before moving on, and
 * an exported mp4 must breathe in the same places the deck does. Read off the
 * raw open tag, like extractHolds, so the same attribute appearing in a
 * slide's CONTENT cannot be mistaken for the slide's own.
 */
export function extractPauses(html) {
  return sectionBodies(html).map((sec) => {
    const tag = sec.slice(0, sec.indexOf('>'));
    const m = tag.match(/data-narration-pause="([\d.]+)"/);
    return m ? Number(m[1]) : 0;
  });
}

/**
 * An oversized step: the engine clamps it to the slide's last build, so this
 * always renders a slide fully built however many steps it turns out to have.
 * Every slide's FINAL frame is captured here rather than at a counted step, so
 * a miscount can shorten the build-up but can never lose the finished slide.
 */
export const LAST_STEP = 999;

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
 *                                added to a NARRATED slide's finished frame
 * @returns {Array<{slide, step, audio, duration, pad}>}  audio null ⇒ silent hold;
 *                                `pad` is the silence ffmpeg appends to the audio
 */
export function planTimeline(manifest, durations, holds, range = null, { steps = null, buildHold = null, pauses = null, onWarn = null } = {}) {
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
    const hold = holds[n - 1];
    if (!builds) { plan.push({ slide: n, step: LAST_STEP, audio: null, duration: hold }); continue; }
    const each = buildHold ?? hold;
    for (let k = 0; k < builds; k++) plan.push({ slide: n, step: k, audio: null, duration: each });
    plan.push({ slide: n, step: LAST_STEP, audio: null, duration: hold });
  }
  return plan;
}

/**
 * ffmpeg argv for one slide's segment: the still looped at --fps under its
 * audio. Narrated slides pad the audio with `pad` — the tail, plus whatever
 * beat the slide asked for (`data-narration-pause`) — and stop there; silent
 * slides synthesize the same stereo/44.1k silence (anullsrc), so every segment
 * carries an audio stream and the concat-demuxer's `-c copy` audio track never
 * goes discontinuous. -t bounds both the infinite loop and the infinite
 * anullsrc (-shortest can't end a segment whose streams are both endless).
 */
export function segmentArgs({ frame, audio, duration, fps, out, pad = TAIL_SECONDS }) {
  return [
    '-y', '-loop', '1', '-framerate', String(fps), '-i', frame,
    ...(audio
      ? ['-i', audio, '-af', `apad=pad_dur=${pad}`]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-t', Number(duration).toFixed(3), '-movflags', '+faststart', out,
  ];
}

/** The concat-demuxer list: one `file '…'` line per segment, quotes escaped. */
export function concatList(segments) {
  return segments.map((s) => `file '${s.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

/** ffmpeg argv joining the segments into the output without re-encoding. */
export function concatArgs(listFile, out) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy',
    '-movflags', '+faststart', out];
}

/** ffprobe argv for a file's real duration in seconds (prints one number). */
export function ffprobeArgs(file) {
  return ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file];
}

/**
 * Where the narration lives: --narration <dir> (its manifest is then required)
 * → <deckdir>/voiceover/manifest.json → null (a silent deck).
 * @returns {{ dir, slides }|null}
 */
export function resolveNarration(deckPath, narrationDir) {
  const load = (dir, required) => {
    const path = join(dir, 'manifest.json');
    if (!existsSync(path)) {
      if (required) {
        throw new Error(`--narration: no manifest.json in ${dir} — `
          + 'run tools/voiceover.mjs (or decklight video --voiceover) first');
      }
      return null;
    }
    const m = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(m?.slides)) {
      throw new Error(`${path}: not a voiceover manifest (no slides array) — regenerate it with tools/voiceover.mjs`);
    }
    return { dir, slides: m.slides };
  };
  if (narrationDir) return load(resolve(narrationDir), true);
  return load(join(resolve(deckPath, '..'), 'voiceover'), false);
}

const have = (bin) => {
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; }
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
  function report() {
    var d = window.__decklightProbe, out = [];
    try {
      for (var i = 1; i <= d.state.totalSlides; i++) { d.goto(i, ${LAST_STEP}); out.push(d.state.step); }
    } catch (e) { out = ['err', String(e && e.message)]; }
    var pre = document.createElement('pre');
    pre.textContent = 'DECKLIGHT-BUILD-STEPS ' + JSON.stringify(out);
    document.body.appendChild(pre);
  }
  if (document.readyState === 'complete') setTimeout(report, 30);
  else window.addEventListener('load', function () { setTimeout(report, 30); });
})();
</script>`;

/** Make the deck's instance reachable, the way test/import-render.mjs does. */
const exposeInstance = (html) => html.replace(/\bDecklight\s*\.\s*init\s*\(/, 'window.__decklightProbe = Decklight.init(');

/** Parse the probe's answer out of a dumped DOM; null when it did not report. */
export function parseBuildSteps(dom, slides) {
  const m = /DECKLIGHT-BUILD-STEPS (\[[^\]]*\])/.exec(dom);
  if (!m) return null;
  let counts;
  try { counts = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(counts) || counts.some((c) => !Number.isInteger(c) || c < 0)) return null;
  return counts.length === slides ? counts : null;
}

export async function videoMain(argv, { exec = run, log = console.log } = {}) {
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
  // off the loopback origin the frames are captured against. This is `present`'s
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

  let out; let plan; let narration;
  try {
    out = resolve(opt('-o', opt('--out', deck.replace(/\.html?$/i, '.mp4'))));
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

    const html = readFileSync(deck, 'utf8');
    const holds = extractHolds(html, hold);
    const pauses = extractPauses(html);
    if (!holds.length) throw new Error(`${basename(deck)} has no <section> slides`);
    const range = parseSlideRange(opt('--slides'), holds.length);

    if (argv.includes('--voiceover')) {
      const vo = [fileURLToPath(new URL('./voiceover.mjs', import.meta.url)), deck];
      const nd = opt('--narration');
      if (nd) vo.push('-o', resolve(nd));
      const r = spawnSync(process.execPath, vo, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('voiceover batch failed — see its output above');
    }

    narration = resolveNarration(deck, opt('--narration'));

    // real durations, not the manifest's word count: ffprobe each audio file
    const durations = {};
    for (let n = range.from; n <= range.to; n++) {
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


    // --theme rides on the deck's response in memory (no temp file): only the
    // deck itself gets the injected link; every other html asset under the root
    // is served untouched. Over the loopback origin `themes/…` resolves exactly
    // as the sibling-copy path used to, so a themed render is unchanged.
    let probing = false;
    const inject = (text, file) => {
      if (resolve(file) !== deck) return text;
      let out = theme
        ? text.replace(/(<\/head>)/i, `<link rel="stylesheet" href="themes/${theme}.css">$1`)
        : text;
      if (probing) out = injectBeforeBodyEnd(exposeInstance(out), STEP_PROBE) ?? out;
      return out;
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
      try {
        const dom = await exec(chrome, chromeArgs(
          '--hide-scrollbars', `--window-size=${w},${h}`,
          '--virtual-time-budget=2500', '--dump-dom', `${server.origin}${deckPath}`,
        ), { maxBuffer: 64 * 1024 * 1024 });
        steps = parseBuildSteps(dom.stdout, holds.length);
      } catch { /* fall through to one frame per slide */ }
      probing = false;
      if (!steps) console.warn('  builds: the deck did not report its build steps — one still per slide');

      plan = planTimeline(narration?.slides ?? null, durations, holds, range,
        { steps, buildHold, pauses, onWarn: (w) => console.warn(`  ${w}`) });
      const slideCount = new Set(plan.map((p) => p.slide)).size;
      log(`${basename(deck)}: ${slideCount} slide${slideCount === 1 ? '' : 's'}, `
        + `${plan.filter((p) => p.audio).length} narrated`
        + (plan.length > slideCount ? `, ${plan.length} frames` : '')
        + (narration ? ` (${narration.dir})` : ' (silent)'));

      const segments = [];
      let f = 0;
      for (const p of plan) {
        const nn = String(p.slide).padStart(2, '0');
        const id = `${nn}-${String(f++).padStart(3, '0')}`;
        const frame = join(work, `frame-${id}.png`);
        // one one-shot Chrome per frame; LAST_STEP clamps to the last build
        await exec(chrome, chromeArgs(
          '--hide-scrollbars',
          '--autoplay-policy=no-user-gesture-required',
          `--window-size=${w},${h}`,
          '--virtual-time-budget=1500',
          `--screenshot=${frame}`,
          `${server.origin}${deckPath}#/${p.slide}/${p.step}`,
        ));
        if (!existsSync(frame)) throw new Error(`chrome produced no frame for slide ${p.slide}`);
        const seg = join(work, `seg-${id}.mp4`);
        await exec('ffmpeg', segmentArgs({
          frame, duration: p.duration, pad: p.pad, fps, out: seg,
          audio: p.audio ? join(narration.dir, p.audio) : null,
        }));
        segments.push(seg);
        const where = p.step === LAST_STEP ? '' : ` · build ${p.step}`;
        log(`  slide ${nn}${where}: ${p.duration.toFixed(1)}s ${p.audio ?? '(silence)'}`);
      }

      const list = join(work, 'concat.txt');
      writeFileSync(list, concatList(segments));
      await exec('ffmpeg', concatArgs(list, out));
    } finally {
      await server.close();
      rmSync(work, { recursive: true, force: true });
    }

    const total = Number((await exec('ffprobe', ffprobeArgs(out))).stdout.trim());
    log(`done → ${out} (${total.toFixed(1)}s)`);
  } catch (e) {
    console.error(`decklight video: ${e.message}`);
    process.exit(1);
  }
}

// direct execution still works: node tools/video.mjs deck.html -o deck.mp4
if (isMain(import.meta.url)) {
  await videoMain(process.argv.slice(2));
}
