// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The routes that HAND THE DECK OVER: writing it out as another file (pptx,
// pdf, a one-file bundle, a video), saying how big a bundle would be before
// it is written, and publishing it to a page the world can read (SPEC
// PRESENTING). The inspector's read of where a slide lives in the file sits
// here too: like the rest, it reads the deck and never writes it.
//
// They came out of cli/edit.mjs because none of them edits the deck. What they
// share is the machinery of a long job run beside a live session: a headless
// Chrome or a child process, a progress feed on the event channel, a flag
// that keeps two of them from running at once, and the question every one of
// them asks first, whether the theme on screen is one the deck marks
// (`unmarkedOnScreen`). Between them they want five of editMain's bindings,
// and the two in-flight flags they own outright, so those live here with them.
//
// The import back to edit.mjs, for the export table and the two checks it
// shares with the command line, is a deliberate STATIC cycle, for the reason
// cli/edit-slides.mjs gives: edit.mjs ends in a top-level `await`, so a
// dynamic import from inside editMain would wait on an evaluation that is
// waiting on it. Nothing here reads those bindings until a request arrives.

import { existsSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { EXPORT_KINDS, alreadyOneFile, videoExportProblem } from './edit.mjs';
import { oneline, remoteLine, remoteState } from './git.mjs';
import { configTheme } from './runtime-link.mjs';
import { CommandError } from './util.mjs';
import { unleashedEnv } from './supervise.mjs';
import { THEME_NAME, GEN_THEME } from '../tools/render-theme.mjs';
import { locateSlide, sectionChildRanges } from '../tools/deck-html.mjs';

/** How long a stopped child has to clean up after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5000;

/**
 * Why `module` cannot name a chapter to bundle, or null when it can (or is
 * absent: the whole deck). The bundle card sends the chapter's NUMBER, never
 * its title: `--module` takes a full title too, but a title is free text and
 * a number is the one thing the picker and the CLI count the same way.
 * Whether the deck has that chapter is the bundler's to say.
 */
export function moduleProblem(module) {
  if (module == null) return null;
  return /^[1-9]\d{0,3}$/.test(String(module)) ? null : 'the module is a chapter number, counting from 1';
}

/**
 * Put the hand-over routes into `routes`, the table cli/edit.mjs dispatches
 * on, and hand it back.
 *
 * `ctx` is the whole of what these handlers may touch: `readDeck()` for the
 * current file, `deckPath` because every export is written beside the deck
 * and named after it, `root` for the repository a publish pushes from,
 * `broadcast` for the export's progress, and `gitOn()` for whether this
 * session has a repository to publish from: a getter, not a copy, because it
 * is a `let` of editMain's and the answer is whatever it holds when a publish
 * asks. `onExport` hears `{ kind, what }` when an export starts and null when
 * it ends, so `/deck/ping` can tell a page that loads mid-render there is one
 * to stop.
 */
export function registerHandoverRoutes(routes, { readDeck, deckPath, root, gitOn, broadcast = () => {}, onExport = () => {} }) {
  let exporting = false; // an export in flight — one browser, one output path, any kind
  let stopExport = null; // stops it, while it is one that can be stopped
  let publishing = false; // a publish in flight — one push at a time

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
   *
   * And it can be STOPPED (`exportStopRoute`), so a ten-minute video started
   * on the wrong slides is not a reason to kill the session it runs in.
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
      const bad = moduleProblem(req.module);
      if (bad) return json(400, { ok: false, error: bad });
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
    // Every kind but the bundle: the bundle launches nothing and is seconds
    // from done, so there is nothing to stop part-way.
    const stop = new AbortController();
    stopExport = kind === 'bundle' ? null : () => stop.abort();
    onExport({ kind, what: job.what });
    const started = Date.now();
    console.log(`  export: ${basename(deckPath)} → ${job.what}${req.slides ? ` of slides ${req.slides}` : ''}`
      + `${req.synthesize ? `, voiced by ${req.synthesize.engine} into ${req.synthesize.dir}/` : ''} …`);
    broadcast('export', { state: 'start', kind, what: job.what });
    try {
      let out, code, reason = null, subs = null, notes = null;
      if (kind === 'video') {
        const { videoOut, videoProgress, voiceoverProgress, subtitlesOut } = await import('../tools/video.mjs');
        out = videoOut(deckPath, req.slides || null, req.format || 'mp4');
        subs = req.subtitles === 'file' ? subtitlesOut(out, req.format || 'mp4') : null;
        // Two phases, each told apart on the channel: voicing is minutes on a
        // cloud engine, and a row that said "rendering" through all of it would
        // read as stuck on slide one.
        if (req.synthesize) {
          ({ code, reason } = await runTool('voiceover', await voiceoverArgv(req),
            voiceoverProgress((n, of) => broadcast('export', { state: 'slide', kind, phase: 'voice', n, of })), stop.signal));
        }
        if (!code && !stop.signal.aborted) {
          const narration = req.synthesize?.dir ?? req.narration ?? null;
          ({ code, reason } = await runTool('video', [deckPath, '-o', out, ...themed,
            ...(req.slides ? ['--slides', req.slides] : []),
            ...(req.format ? ['--format', req.format] : []),
            ...(req.quality ? ['--quality', req.quality] : []),
            ...(req.subtitles ? ['--subtitles', req.subtitles] : []),
            ...(narration ? ['--narration', resolve(dirname(deckPath), narration)] : req.silent ? ['--no-narration'] : []),
            // the card showed the track as recorded from older notes and it was picked anyway (#536)
            ...(req.allowStale === true ? ['--allow-stale'] : [])],
          videoProgress((n, of) => broadcast('export', { state: 'slide', kind, phase: 'render', n, of })), stop.signal));
        }
      } else if (kind === 'bundle') {
        // No -o: the CLI names the file, beside the deck, so the row and
        // `decklight bundle` write the same one — `<deck>-standalone.html`,
        // or for one chapter (`module`, its number: --module) the chapter's
        // own name, which never overwrites the whole deck's. `audio` is its
        // --audio ('original', 'aac' or 'opus'), the recorded voice carried
        // inside. bundleMain returns nothing on success and throws a sentence
        // on a refusal (an unknown chapter among them, before any file is
        // written) — the catch below says it. The notes it prints after the
        // file come back too: which chapter went in, and where the audio is.
        const { bundleMain } = await import('./bundle.mjs');
        const { AUDIO_CHOICES } = await import('./bundle-audio.mjs');
        const report = {};
        code = (await bundleMain([deckPath, ...(req.theme ? ['--theme', req.theme] : []),
          ...(req.module != null ? ['--module', String(req.module)] : []),
          ...(AUDIO_CHOICES.includes(req.audio) ? ['--audio', req.audio] : [])], { report })) ?? 0;
        out = report.out;
        notes = report.notices;
      } else if (kind === 'pptx') {
        const { pptxMain, pptxOut } = await import('./pptx-export.mjs');
        out = pptxOut(deckPath);
        code = await pptxMain([deckPath, ...themed], {
          log: (line) => console.log(`  ${line}`),
          onSlide: (n, of) => broadcast('export', { state: 'slide', kind, n, of }),
          signal: stop.signal,
        });
      } else {
        const { pdfMain, pdfOut } = await import('./pdf.mjs');
        out = pdfOut(deckPath, null, job.variant);
        code = await pdfMain([deckPath, ...themed, ...(job.variant ? [`--${job.variant}`] : [])], { signal: stop.signal });
      }
      if (stop.signal.aborted) return stopped();
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
      return json(200, { ok: true, kind, what: job.what, file, seconds, ...voiced, ...(notes ? { notes } : {}) });
    } catch (e) {
      if (stop.signal.aborted) return stopped();
      // A render that hangs or a Chrome that dies is the export's problem,
      // never the session's: the message goes back to the palette and the
      // server carries on serving the deck. A command's refusal is a sentence
      // and then, at most, a list it introduces ("— its chapters are:"); the
      // sentence is what fits on a card, and the card has the list already.
      const said = e instanceof CommandError ? e.message.split('\n')[0].replace(/\s+—[^—]*:$/, '') : oneline(e);
      console.log(`  export: ${job.what} failed — ${said}`);
      broadcast('export', { state: 'done', kind, ok: false, error: said });
      return json(500, { ok: false, error: said });
    } finally {
      exporting = false;
      stopExport = null;
      onExport(null);
    }

    // Not a failure: what was asked for. The voice a stopped export had
    // already synthesized stays where it was written — it is the deck's own
    // folder, and the next export finds those slides done.
    function stopped() {
      const kept = req.synthesize && existsSync(resolve(dirname(deckPath), req.synthesize.dir)) ? { voiced: req.synthesize.dir } : {};
      console.log(`  export: ${job.what} stopped — nothing written`);
      broadcast('export', { state: 'done', kind, ok: false, stopped: true, ...kept });
      return json(200, { ok: false, stopped: true, kind, what: job.what, ...kept });
    }
  }

  /**
   * POST /deck/edit/export/stop — stop the export in flight. Answers at once;
   * the export's own request is the one that says it stopped (`{ stopped }`),
   * once its children are gone and its scratch files with them.
   */
  function exportStopRoute({ json }) {
    if (!exporting) return json(409, { ok: false, error: 'no export is running' });
    if (!stopExport) return json(409, { ok: false, error: 'a bundle cannot be stopped part-way — it is seconds from done' });
    console.log('  export: stopping …');
    stopExport();
    return json(200, { ok: true });
  }

  /**
   * `decklight video` (and `decklight narrate` before it, when the export
   * voices its slides), run as CHILDREN rather than through their `main`s like
   * the other exports: both end in `process.exit` on every refusal, and each
   * would take this session down or freeze it. A child keeps that where it
   * belongs, and its output is read line by line for the progress it already
   * prints.
   *
   * Served from the same root `pptx` picks: the current directory when the deck
   * is under it, its own directory otherwise.
   *
   * `signal` stops it: SIGTERM, which `decklight video` answers by killing its
   * Chrome and ffmpeg and clearing its scratch frames, then SIGKILL for a child
   * that has not gone a few seconds later.
   */
  function runTool(name, argv, onLine, signal = null) {
    const script = fileURLToPath(new URL(`../tools/${name}.mjs`, import.meta.url));
    const cwd = deckPath.startsWith(process.cwd() + sep) ? process.cwd() : dirname(deckPath);
    return new Promise((done) => {
      const child = spawn(process.execPath, [script, ...argv], { cwd, env: unleashedEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let hard = null;
      const stop = () => {
        child.kill('SIGTERM');
        hard = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      };
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
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
        clearTimeout(hard);
        signal?.removeEventListener('abort', stop);
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
   * `decklight narrate` spells it. The deck sends what only it knows — the
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
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session — there is nothing to publish from' });
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
    if (!gitOn()) return json(409, { ok: false, error: 'git is off for this session — there is nothing to publish from' });
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
    // one chapter is estimated as one chapter: its slides, its share of the audio
    const module = url.searchParams.get('module');
    const bad = moduleProblem(module);
    if (bad) return json(400, { ok: false, error: bad });
    const { bundleMain } = await import('./bundle.mjs');
    const estimate = (argv) => bundleMain([deckPath, ...argv, ...(module != null ? ['--module', module] : [])], { estimate: true });
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

  /**
   * Where slide N lives in the file, for the inspector (`I`, PRESENTING): the
   * slide's lines, each authored top-level child's lines by the same raw index
   * the element routes use, and what `decklight check` would say about it.
   * Read-only, and only the static half of the check: the render half needs a
   * browser and takes seconds, and the panel asks on every slide change.
   */
  async function inspectRoute({ url, json }) {
    const { sectionRanges, staticFindings } = await import('./check.mjs');
    const html = readDeck();
    const ranges = sectionRanges(html);
    const slide = Number(url.searchParams.get('slide'));
    if (!Number.isInteger(slide) || slide < 1 || slide > ranges.length) {
      return json(400, { ok: false, error: `no slide ${url.searchParams.get('slide') ?? ''} — the deck has ${ranges.length}`.trim() });
    }
    // 1-based line of an offset: the newlines before it, plus one
    const breaks = [];
    for (let i = html.indexOf('\n'); i !== -1; i = html.indexOf('\n', i + 1)) breaks.push(i);
    const lineAt = (at) => {
      let lo = 0, hi = breaks.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < at) lo = mid + 1; else hi = mid; }
      return lo + 1;
    };
    const span = (start, end) => [lineAt(start), lineAt(Math.max(start, end - 1))];
    const range = ranges[slide - 1];
    const { parts, idx } = locateSlide(html, slide);
    const segAt = parts.slice(0, idx).join('').length;
    let blocks = [];
    try {
      blocks = sectionChildRanges(parts[idx]).map((r) => ({ tag: r.tag, lines: span(segAt + r.start, segAt + r.end) }));
    } catch { /* a malformed section still has its own lines */ }
    const findings = staticFindings(html, { dir: dirname(deckPath) })
      .filter((f) => f.slide === slide)
      .map(({ level, rule, message }) => ({ level, rule, message }));
    return json(200, { ok: true, file: basename(deckPath), lines: span(range.start, range.end), blocks, findings });
  }

  /**
   * Every finding `decklight check`'s static half has for the whole deck,
   * for Check deck… (PRESENTING_EDITING): head-level ones (a design system
   * the deck is behind, a theme off the brand, a missing file) with
   * `slide: null`, then each slide's, the same rule ids `check --json`
   * prints — and on each the quick fix the server could apply for it
   * (cli/check-fixes.mjs), so the row says what pressing it would do. Read-
   * only, like the inspector's read above; the render half is the open
   * page's own (src/core/deckcheck.js measures it).
   */
  async function checkRoute({ json }) {
    const { sectionRanges, staticFindings } = await import('./check.mjs');
    const { quickFixes } = await import('./check-fixes.mjs');
    const html = readDeck();
    const dir = dirname(deckPath);
    const found = staticFindings(html, { dir, deck: basename(deckPath) });
    return json(200, {
      ok: true, file: basename(deckPath), slides: sectionRanges(html).length,
      findings: quickFixes(found, html, dir, { deck: basename(deckPath) }),
    });
  }

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

  routes.set('POST /deck/edit/export', exportRoute);
  routes.set('POST /deck/edit/export/stop', exportStopRoute);
  routes.set('GET /deck/edit/export/estimate', exportEstimateRoute);
  routes.set('GET /deck/edit/inspect', inspectRoute);
  routes.set('GET /deck/edit/check', checkRoute);
  routes.set('GET /deck/edit/publish/plan', publishPlanRoute);
  routes.set('POST /deck/edit/publish', publishRoute);
  return routes;
}
