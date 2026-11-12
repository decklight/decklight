// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight check --watch`: the check again, every time the deck is saved.
 *
 * For an author who keeps a terminal beside the editor. Two pieces, both
 * independent of what a check IS (cli/check.mjs owns that and drives these),
 * so a test can run them with a counter in place of the lint:
 *
 *   watchDeck            hears the deck being saved, and runs `run` once per
 *                        save, never two at a time
 *   persistentRenderer   one headless Chrome held open across runs, where
 *                        `check` alone starts and stops one per run
 */

import { watch as fsWatch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { openPage } from '../tools/cdp.mjs';

/**
 * Run `run` whenever `file` changes, and once at the start (`initial`).
 *
 * The DIRECTORY is watched, and the events filtered by name, never the file
 * itself. A path watch follows the inode, and an atomic save (a temp file
 * renamed over the deck, which is how most editors and every careful tool
 * write) replaces the inode: the watch goes deaf on the old one and every
 * later save is missed. The edit server learnt this in 0.7.0 (cli/edit.mjs,
 * the deck watch). A directory watch names the entry that changed and
 * survives any number of replacements. A platform that does not name it
 * (`filename` null) counts as a change: one check too many beats one missed.
 *
 * A save is a burst (a truncate and a write, or a write and a rename, and an
 * editor's swap files besides), so events are DEBOUNCED into one run. A save
 * landing while a run is still going is not lost and not run beside it: one
 * more run follows the current one.
 *
 * Returns `{ close, settled }`: `settled()` resolves once nothing is running
 * or waiting to run (for a test, and for a clean stop).
 */
export function watchDeck({ file, run, debounceMs = 150, watch = fsWatch, initial = true, onError = () => {} }) {
  const path = resolve(file);
  const name = basename(path);
  let timer = null;
  let running = null;
  let again = false;
  let closed = false;

  async function kick() {
    timer = null;
    if (closed) return;
    if (running) { again = true; return; }
    running = (async () => {
      try { await run(); } catch (e) { onError(e); }
    })();
    await running;
    running = null;
    if (again && !closed) { again = false; await kick(); }
  }
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(kick, debounceMs);
  };

  const watcher = watch(dirname(path), (_kind, filename) => {
    if (filename != null && basename(String(filename)) !== name) return;
    schedule();
  });
  watcher.on?.('error', onError);
  if (initial) kick();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      try { watcher.close(); } catch { /* already closed */ }
    },
    async settled() {
      while (timer || running) {
        if (running) await running;
        else await new Promise((ok) => setTimeout(ok, debounceMs));
      }
    },
  };
}

/**
 * One headless Chrome for every run of a watch, the page reloaded each time.
 *
 * `render(url, wait)` answers what `chrome --dump-dom --virtual-time-budget`
 * answers in a one-shot: the page loads, then its clock runs on virtual time
 * until `wait` ms have passed with nothing left to fetch, and the DOM is read.
 * The budget is set once the navigation is under way, not before: set on the
 * blank page it is spent before the deck has asked for anything.
 *
 * A browser that dies or stops answering is dropped, and the next run starts
 * a new one; `close()` stops it for good (Ctrl-C).
 */
export function persistentRenderer(bin, { open = openPage, timeoutMs = 60_000 } = {}) {
  let page = null;
  let opening = null;
  const drop = async () => {
    const p = page;
    page = null;
    await p?.close().catch(() => {});
  };
  const capped = (promise, what) => {
    let t;
    return Promise.race([
      promise,
      new Promise((_, no) => { t = setTimeout(() => no(new Error(`Chrome did not answer (${what}) in ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]).finally(() => clearTimeout(t));
  };
  return {
    async render(url, wait) {
      if (!page) {
        // the viewport a one-shot headless Chrome has, so both measure the same slides
        opening ??= open(bin, { w: 800, h: 600, args: ['--allow-file-access-from-files'] }).finally(() => { opening = null; });
        page = await opening;
      }
      try {
        return await capped((async () => {
          await page.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
          await page.navigate('about:blank');
          await page.send('Page.navigate', { url });
          const spent = page.once('Emulation.virtualTimeBudgetExpired');
          await page.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: wait });
          await spent;
          return page.evaluate('document.documentElement ? document.documentElement.outerHTML : ""');
        })(), 'rendering the deck');
      } catch (e) {
        await drop();
        throw e;
      }
    },
    async close() {
      if (opening) await opening.catch(() => {});
      await drop();
    },
  };
}

/** The line a watch prints over each fresh report: when, and how to stop. */
export function watchHeader(deckName, slides, at = new Date()) {
  const hh = (n) => String(n).padStart(2, '0');
  const time = `${hh(at.getHours())}:${hh(at.getMinutes())}:${hh(at.getSeconds())}`;
  return `check: ${deckName} · ${slides} slide${slides === 1 ? '' : 's'} · ${time} · watching for saves, Ctrl-C stops`;
}
