// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The browser's own voice — SPEC PRESENTING_BROWSER_VOICE.
//
// The live voice is the bridge's. But a deck opened with no bridge behind it
// (a static copy, a bundle, a phone) still runs in a browser, and every
// browser carries `speechSynthesis`, which speaks with the voices the
// operating system has installed. So when the bridge does not answer, this is
// the engine: same sentence pipeline, same holds, same captions — only the
// sound goes straight to the speakers instead of coming back as a clip.
//
// Everything here takes the synthesizer and the utterance constructor as
// arguments, so it is testable in Node with a fake, and so the narration can
// ask "is there one?" without touching a global it may not have.

export const BROWSER_ENGINE = 'browser';

/** How long `getVoices()` may stay empty before the browser has no voice. */
export const VOICES_WAIT_MS = 2000;

/** How often a speaking utterance is checked for having quietly stopped. */
const WATCH_MS = 250;

/**
 * The browser's voices, waited for. Chrome fills the list late and says so
 * with `voiceschanged`; Safari has it at once. A list still empty after
 * `waitMs` is no voice, not a slow one.
 */
export function loadVoices(synth, waitMs = VOICES_WAIT_MS) {
  if (!synth?.getVoices) return Promise.resolve([]);
  const now = synth.getVoices() ?? [];
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener?.('voiceschanged', finish);
      resolve(synth.getVoices() ?? []);
    };
    synth.addEventListener?.('voiceschanged', finish);
    setTimeout(finish, waitMs);
  });
}

/** `en-GB` → `en`; the picker's language filter speaks two letters. */
const langOf = (v) => String(v?.lang ?? '').toLowerCase().split(/[-_]/)[0];

/**
 * The picker's rows: `[name, flavor, group, langs]`, the bridge's own shape.
 *
 * Names are the browser's (they are what `speak` looks the voice up by), a
 * repeated name is kept once, the deck's language sorts first and the
 * browser's default first within it. A voice that is not local needs the
 * network, and its row says `online` where the others say `this machine`.
 */
export function browserRoster(voices, deckLang = null) {
  const seen = new Set();
  const list = [];
  for (const v of voices ?? []) {
    if (!v?.name || seen.has(v.name)) continue;
    seen.add(v.name);
    list.push(v);
  }
  const rank = (v) => (deckLang && langOf(v) === deckLang ? 0 : 2) + (v.default ? 0 : 1);
  return list
    .map((v, i) => [v, i])
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([v]) => {
      const lang = langOf(v);
      // the language rides fourth and the picker shows it, so the flavor says where it runs
      return [v.name, v.localService === false ? 'online' : 'this machine', null, lang ? [lang] : []];
    });
}

/**
 * What the narration adopts in place of the bridge's `/ping` — or null when
 * this browser has nothing to speak with.
 */
export async function browserPing(synth, { deckLang = null, waitMs } = {}) {
  if (!synth?.speak) return null;
  const voices = browserRoster(await loadVoices(synth, waitMs), deckLang);
  if (!voices.length) return null;
  return { ok: true, engine: BROWSER_ENGINE, model: 'Web Speech', stylable: false, audioTags: false, voices };
}

/**
 * Speak one sentence, and resolve when it is over: 'ended' or 'cancelled'.
 * Rejects with the utterance's error (`not-allowed` when the browser wants a
 * gesture first).
 *
 * The `end` event is not trusted alone. Chrome can drop a voice mid-sentence,
 * or collect an utterance before it fires, and a chain waiting on an event
 * that never comes parks the talk for ever — so once the utterance has
 * started, `synth.speaking` going false counts as the end too — unless the
 * synthesizer is paused, which some browsers report as not speaking, so ⎵
 * does not trip it.
 */
export function speakSentence(synth, Utterance, { text, voice, rate = 1, lang } = {}) {
  return new Promise((resolve, reject) => {
    const u = new Utterance(text);
    const v = (synth.getVoices?.() ?? []).find((x) => x.name === voice);
    if (v) { u.voice = v; u.lang = v.lang; } else if (lang) u.lang = lang;
    u.rate = rate;
    let started = false;
    let timer = null;
    const settle = (fn, arg) => {
      clearInterval(timer);
      timer = -1;
      u.onstart = u.onend = u.onerror = null;
      fn(arg);
    };
    u.onstart = () => {
      started = true;
      if (timer === -1) return;
      timer = setInterval(() => {
        if (started && !synth.speaking && !synth.pending && !synth.paused) settle(resolve, 'ended');
      }, WATCH_MS);
    };
    u.onend = () => settle(resolve, 'ended');
    u.onerror = (e) => {
      const why = e?.error ?? 'error';
      // `cancel()` — navigation, ⎵ off, the next sentence — is not a failure
      if (why === 'canceled' || why === 'interrupted') settle(resolve, 'cancelled');
      else settle(reject, new Error(`browser: ${why}`));
    };
    // keep a reference: an utterance only the synthesizer holds can be
    // collected before its `end` fires (a long-standing Chrome bug)
    speakSentence.current = u;
    synth.speak(u);
  });
}
