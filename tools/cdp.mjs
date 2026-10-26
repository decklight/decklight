// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A minimal Chrome DevTools Protocol page driver — the one thing `decklight
// video` needs that a one-shot `--screenshot` cannot do: hold ONE page open,
// move its clock by hand, and photograph it at each tick.
//
// No dependency: Node ≥22 ships a global WebSocket client, and Chrome says
// where it listens on stderr (`--remote-debugging-port=0`). The page is still
// whatever URL the caller gives it — the video tool passes the deck served over
// http://127.0.0.1 under the `--no-trust` CSP (#229), so this adds no file://
// access: the debugging port is bound to loopback and lives only as long as the
// browser, which is killed in `close()`.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeArgs } from './chrome.mjs';

const LISTENING = /DevTools listening on (ws:\/\/\S+)/;

/**
 * Start a headless Chrome and open one page of `w`×`h` CSS pixels.
 * @returns {Promise<{ send, evaluate, navigate, screenshot, close }>}
 */
export async function openPage(bin, { w, h, signal, startupMs = 15000 } = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('animated capture needs Node 22 or newer (no WebSocket client here)');
  const profile = mkdtempSync(join(tmpdir(), 'decklight-cdp-'));
  const child = spawn(bin, chromeArgs(
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${w},${h}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ), { stdio: ['ignore', 'ignore', 'pipe'], signal });
  child.on('error', () => {});   // an abort kills the child; the rejection below says why
  const exited = new Promise((ok) => child.once('exit', ok));
  // the profile goes only once Chrome has let go of it — it writes on the way out
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };

  let endpoint;
  try {
    endpoint = await new Promise((ok, no) => {
      let seen = '';
      const timer = setTimeout(() => no(new Error('Chrome did not open its debugging port')), startupMs);
      child.stderr.on('data', (d) => {
        seen += d;
        const m = LISTENING.exec(seen);
        if (m) { clearTimeout(timer); ok(m[1]); }
      });
      child.on('exit', () => { clearTimeout(timer); no(new Error('Chrome exited before it was ready')); });
    });
  } catch (e) { await cleanup(); throw e; }

  const ws = new WebSocket(endpoint);
  try {
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('could not reach Chrome\'s debugging port')); });
  } catch (e) { await cleanup(); throw e; }

  let id = 0;
  const pending = new Map();
  const waiting = [];   // { method, sessionId, ok, no }
  // Chrome gone mid-capture: every call still waiting on it fails, rather than
  // the render hanging on an answer that will never come
  ws.onclose = () => {
    const gone = new Error('Chrome closed its debugging connection');
    for (const p of pending.values()) p.no(gone);
    for (const x of waiting.splice(0)) x.no(gone);
    pending.clear();
  };
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.no(new Error(`${p.method}: ${msg.error.message}`)); else p?.ok(msg.result);
    } else {
      const i = waiting.findIndex((x) => x.method === msg.method && x.sessionId === msg.sessionId);
      if (i >= 0) waiting.splice(i, 1)[0].ok(msg.params);
    }
  };
  const call = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const n = ++id;
    pending.set(n, { ok, no, method });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  try {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => call(method, params, sessionId);
    const once = (method) => new Promise((ok, no) => waiting.push({ method, sessionId, ok, no }));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

    return {
      send,
      /** Run an expression in the page; its (awaited) value comes back. */
      async evaluate(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      /** Load `url` and resolve once the page's load event has fired. */
      async navigate(url) {
        const loaded = once('Page.loadEventFired');
        loaded.catch(() => {});   // a failed navigate below is the error that gets reported
        const { errorText } = await send('Page.navigate', { url });
        if (errorText) throw new Error(`could not load ${url}: ${errorText}`);
        await loaded;
      },
      /** A PNG of the viewport, as a Buffer. */
      async screenshot() {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        return Buffer.from(data, 'base64');
      },
      async close() { try { ws.close(); } catch { /* already gone */ } await cleanup(); },
    };
  } catch (e) { try { ws.close(); } catch { /* gone */ } await cleanup(); throw e; }
}
