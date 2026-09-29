// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight enhance` — the voiceover script, given the audio tags ElevenLabs
 * v4 performs (SPEC `PRESENTING`).
 *
 * The prompt is ElevenLabs' own: the one their best-practices page publishes
 * for having an LLM add audio tags to a script, word for word, with a short
 * decklight addendum saying what else is in these notes — `[click]` beats and
 * `[pause]` holds, which are decklight's, not the model's. The locally
 * installed agent answers it, read-only (`agentAsk`, the argv the commit
 * subjects use): it is asked for text, and it is never let near the file.
 *
 * DECKLIGHT WRITES, NOT THE AGENT. What comes back is checked before a byte
 * of the deck changes: the same words in the same order (tags, capitals and
 * `!`/`?`/`…` are the only things the prompt allows it to add), the same
 * number of `[click]` beats, and no `[pause]` lost. A slide whose answer fails
 * that is left exactly as it was, and says why — an enhancer that could
 * quietly rewrite a talk would be worse than none.
 *
 * One slide per ask, a few at a time: each answer is small enough to check,
 * and one slide's bad answer costs that slide, not the deck.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { agentAsk, agentUnavailable, detectAgents } from './agents.mjs';
import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { runMain } from './util.mjs';
import { NOTES_ASIDE, cleanNotes, readNotes, sectionBodies, isHiddenSection } from '../tools/deck-html.mjs';
import { canonMarks, captioned, writtenMarks, CLICK_MARK, PAUSE_MARK } from '../tools/sentences.mjs';
import { notesTextToAside, setSlideNotes } from './edit.mjs';

/** Where the prompt below comes from — said in the prompt's own header and in SPEC. */
export const ENHANCE_SOURCE = 'https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4';

/**
 * ElevenLabs' prompt for enhancing a script with audio tags, verbatim
 * (ENHANCE_SOURCE). Kept word for word on purpose: it is the prompt their own
 * model is tuned to be prompted with, and a paraphrase would be decklight's
 * guess at it.
 */
export const ELEVENLABS_ENHANCE_PROMPT = `# Instructions

## 1. Role and Goal

You are an AI assistant specializing in enhancing dialogue text for speech generation.

Your **PRIMARY GOAL** is to dynamically integrate **audio tags** (e.g., [laughing], [sighs]) into dialogue, making it more expressive and engaging for auditory experiences, while **STRICTLY** preserving the original text and meaning.

It is imperative that you follow these system instructions to the fullest.

## 2. Core Directives

Follow these directives meticulously to ensure high-quality output.

### Positive Imperatives (DO):

* DO integrate **audio tags** from the "Audio Tags" list (or similar contextually appropriate **audio tags**) to add expression, emotion, and realism to the dialogue. These tags MUST describe something auditory.
* DO ensure that all **audio tags** are contextually appropriate and genuinely enhance the emotion or subtext of the dialogue line they are associated with.
* DO strive for a diverse range of emotional expressions (e.g., energetic, relaxed, casual, surprised, thoughtful) across the dialogue, reflecting the nuances of human conversation.
* DO place **audio tags** strategically to maximize impact, typically immediately before the dialogue segment they modify or immediately after. (e.g., [annoyed] This is hard. or This is hard. [sighs]).
* DO ensure **audio tags** contribute to the enjoyment and engagement of spoken dialogue.

### Negative Imperatives (DO NOT):

* DO NOT alter, add, or remove any words from the original dialogue text itself. Your role is to *prepend* **audio tags**, not to *edit* the speech. **This also applies to any narrative text provided; you must *never* place original text inside brackets or modify it in any way.**
* DO NOT create **audio tags** from existing narrative descriptions. **Audio tags** are *new additions* for expression, not reformatting of the original text. (e.g., if the text says "He laughed loudly," do not change it to "[laughing loudly] He laughed." Instead, add a tag if appropriate, e.g., "He laughed loudly [chuckles].")
* DO NOT use tags such as [standing], [grinning], [pacing], [music].
* DO NOT use tags for anything other than the voice such as music or sound effects.
* DO NOT invent new dialogue lines.
* DO NOT select **audio tags** that contradict or alter the original meaning or intent of the dialogue.
* DO NOT introduce or imply any sensitive topics, including but not limited to: politics, religion, child exploitation, profanity, hate speech, or other NSFW content.

## 3. Workflow

1. **Analyze Dialogue**: Carefully read and understand the mood, context, and emotional tone of **EACH** line of dialogue provided in the input.
2. **Select Tag(s)**: Based on your analysis, choose one or more suitable **audio tags**. Ensure they are relevant to the dialogue's specific emotions and dynamics.
3. **Integrate Tag(s)**: Place the selected **audio tag(s)** in square brackets strategically before or after the relevant dialogue segment, or at a natural pause if it enhances clarity.
4. **Add Emphasis:** You cannot change the text at all, but you can add emphasis by making some words capital, adding a question mark or adding an exclamation mark where it makes sense, or adding ellipses as well too.
5. **Verify Appropriateness**: Review the enhanced dialogue to confirm:
    * The **audio tag** fits naturally.
    * It enhances meaning without altering it.
    * It adheres to all Core Directives.

## 4. Output Format

* Present ONLY the enhanced dialogue text in a conversational format.
* **Audio tags** **MUST** be enclosed in square brackets (e.g., [laughing]).
* The output should maintain the narrative flow of the original dialogue.

## 5. Audio Tags (Non-Exhaustive)

Use these as a guide. You can infer similar, contextually appropriate **audio tags**.

**Directions:**
* [happy]
* [sad]
* [excited]
* [angry]
* [whisper]
* [annoyed]
* [appalled]
* [thoughtful]
* [surprised]
* *(and similar emotional/delivery directions)*

**Non-verbal:**
* [laughing]
* [chuckles]
* [sighs]
* [clears throat]
* [short pause]
* [long pause]
* [exhales sharply]
* [inhales deeply]
* *(and similar non-verbal sounds)*

## 6. Examples of Enhancement

**Input**:
"Are you serious? I can't believe you did that!"

**Enhanced Output**:
"[appalled] Are you serious? [sighs] I can't believe you did that!"

---

**Input**:
"That's amazing, I didn't know you could sing!"

**Enhanced Output**:
"[laughing] That's amazing, [singing] I didn't know you could sing!"

---

**Input**:
"I guess you're right. It's just... difficult."

**Enhanced Output**:
"I guess you're right. [sighs] It's just... [muttering] difficult."

# Instructions Summary

1. Add audio tags from the audio tags list. These must describe something auditory but only for the voice.
2. Enhance emphasis without altering meaning or text.
3. Reply ONLY with the enhanced text.`;

/**
 * What these notes are, beyond what ElevenLabs' prompt assumes: one narrator
 * reading a slide's speaker notes, with decklight's own markers in them.
 */
export const DECKLIGHT_ADDENDUM = `# About this text

This is the speaker-notes script of one presentation slide, read aloud by a single narrator — a monologue, not a dialogue between people. It contains markers that belong to the presentation software, not to you:

* [click] — on a line of its own: a build step of the slide begins here. Keep every [click] exactly where it is, on its own line, and never add one.
* [pause] and [long pause] — a hold. Keep every one where it is. You may add [short pause] or [long pause] where a hold helps.

Keep the line breaks as they are. Reply with the enhanced script ONLY — no quotes around it, no code fences, no commentary before or after.`;

/** The whole ask for one slide's script. */
export const enhancePrompt = (script) =>
  `${ELEVENLABS_ENHANCE_PROMPT}\n\n${DECKLIGHT_ADDENDUM}\n\n# Script\n\n${script}`;

/**
 * A slide's notes as the script the agent is shown — plain text, every marker
 * in its written form, paragraphs a blank line apart and one `[click]` line
 * between beats (the notes editor's own shape). Null for a slide with nothing
 * to say.
 */
// a paragraph's edges in notes markup — kept as blank lines, as the notes editor keeps them
const BLOCK_EDGE = /<\/?(?:p|div|li|ul|ol|blockquote|pre|h[1-6]|table|tr)\b[^>]*>|<br\s*\/?>/gi;

export function slideScript(asideInner) {
  const beats = readNotes(asideInner ?? '').split(CLICK_MARK).map((b) => b.split(BLOCK_EDGE)
    .map((para) => cleanNotes(para, { marks: true })).filter(Boolean).join('\n\n'));
  const script = writtenMarks(beats.join('\n\n⟨CLICK⟩\n\n')).trim();
  return captioned(canonMarks(script).replaceAll(CLICK_MARK, ' ')) ? script : null;
}

/** What an answer looks like once the agent's packaging is off it: fences, surrounding quotes. */
export function unwrapAnswer(out) {
  let t = String(out ?? '').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fenced) t = fenced[1].trim();
  if (/^"[\s\S]*"$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

// The words of a beat, as the check compares them: no tags, no markers, no
// case, no punctuation — the only things the prompt lets the agent change.
const wordsOf = (beat) => captioned(beat).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const beatsOf = (text) => canonMarks(text).split(CLICK_MARK);
const pausesOf = (beat) => beat.split(PAUSE_MARK).length - 1;

/**
 * Is `after` the script `before`, only enhanced? Null when it is; otherwise
 * the reason it is not, in words for the person whose notes these are.
 */
export function enhanceProblem(before, after) {
  if (!after?.trim()) return 'the agent answered nothing';
  const was = beatsOf(before);
  const now = beatsOf(after);
  if (now.length !== was.length) {
    return `the agent changed the [click] beats (${was.length} → ${now.length}) — the builds would drift`;
  }
  for (let k = 0; k < was.length; k++) {
    if (wordsOf(now[k]) !== wordsOf(was[k])) {
      return `the agent changed the words${was.length > 1 ? ` of beat ${k + 1}` : ''} — the prompt allows only tags and emphasis`;
    }
    if (pausesOf(now[k]) < pausesOf(was[k])) return 'the agent dropped a [pause]';
  }
  return null;
}

/** Run a read-only agent ask; resolves to its stdout, or null. */
function ask(cmd, cwd, timeoutMs) {
  return new Promise((done) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };
    let child;
    try {
      child = execFile(cmd.bin, cmd.args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
        (err, stdout) => finish(err && !stdout ? null : String(stdout ?? '')));
    } catch { return finish(null); }
    child.on('error', () => finish(null));
  });
}

/** How long one slide's ask may take. */
export const ENHANCE_TIMEOUT_MS = 120_000;
/** How many slides are asked about at once. */
export const ENHANCE_CONCURRENCY = 3;

/**
 * The slides of `html` that can be enhanced, as `{ slide, inner, script }`:
 * a visible slide with an `<aside class="notes">` that says something.
 * `only` (1-based slide numbers) narrows it.
 */
export function enhanceable(html, only = null) {
  const want = only ? new Set(only) : null;
  return sectionBodies(html).flatMap((body, i) => {
    const slide = i + 1;
    if (want && !want.has(slide)) return [];
    if (isHiddenSection(body)) return [];
    const aside = NOTES_ASIDE.exec(body);
    const script = aside ? slideScript(aside[1]) : null;
    return script ? [{ slide, script }] : [];
  });
}

/**
 * The answers written into `html`: each slide that passed the check and says
 * something new — and only if its notes still read exactly as they did when
 * the agent was asked. A slide edited in the meantime keeps the edit; the
 * answer was to a script that no longer exists. Returns `{ html, stale }`.
 */
export function applyEnhanced(html, answers) {
  let out = html;
  const stale = [];
  const bodies = sectionBodies(html);
  for (const a of answers) {
    if (!a.ok || !a.changed) continue;
    const aside = NOTES_ASIDE.exec(bodies[a.slide - 1] ?? '');
    if (!aside || slideScript(aside[1]) !== a.before) { stale.push(a.slide); continue; }
    out = setSlideNotes(out, a.slide, notesTextToAside(a.text));
  }
  return { html: out, stale };
}

/**
 * Ask the agent to enhance `slides` (1-based numbers, or null for every slide
 * with notes) of the deck in `html`. Resolves to `{ html, results, answers }`:
 * the deck with every passing slide rewritten (`applyEnhanced`), one
 * `{ slide, ok, changed, why }` per slide asked about, and the raw answers for
 * a caller that applies them to a newer copy of the deck. Never throws for one
 * slide's failure — only when there is no agent to ask at all.
 */
export async function enhanceDeck(html, slides = null, {
  agent = null, cwd = process.cwd(), env = process.env, timeoutMs = ENHANCE_TIMEOUT_MS,
  concurrency = ENHANCE_CONCURRENCY, resolveAgent = agentAsk, exec = ask, onSlide = () => {},
} = {}) {
  if (!resolveAgent(agent, 'x', { env })) throw new Error(agentUnavailable(agent, detectAgents({ env })));
  const todo = enhanceable(html, slides);
  const answers = [];
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { slide, script } = todo[next++];
      const cmd = resolveAgent(agent, enhancePrompt(script), { env });
      const out = cmd ? await exec(cmd, cwd, timeoutMs) : null;
      const after = out == null ? null : unwrapAnswer(out);
      const why = out == null ? 'the agent did not answer in time' : enhanceProblem(script, after);
      const r = { slide, ok: !why, changed: !why && after !== script, ...(why ? { why } : {}) };
      answers.push({ ...r, before: script, text: after });
      onSlide({ ...r, done: ++finished, of: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  answers.sort((a, b) => a.slide - b.slide);
  const results = answers.map(({ before, text, ...r }) => r);
  return { html: applyEnhanced(html, answers).html, results, answers };
}

/** '3', '2-5', '1,4,6-7' → slide numbers; throws on anything else or out of range. */
export function parseSlides(s, total) {
  const nums = new Set();
  for (const part of String(s).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    const from = m ? Number(m[1]) : NaN;
    const to = m?.[2] ? Number(m[2]) : from;
    if (!m || from < 1 || to > total || from > to) {
      throw new Error(`--slides ${s} is not slides of this deck (1–${total}; e.g. 3, 2-5 or 1,4)`);
    }
    for (let n = from; n <= to; n++) nums.add(n);
  }
  if (!nums.size) throw new Error('--slides needs a slide number, a-b, or a list');
  return [...nums].sort((a, b) => a - b);
}

const USAGE = `decklight enhance — add ElevenLabs v4 audio tags to the voiceover script

Usage:
  decklight enhance <deck.html> --slides <n | a-b | a,b,c> [--agent <name>] [--dry-run]
  decklight enhance <deck.html> --all [--agent <name>] [--dry-run]

Asks the AI agent installed on this machine (claude, codex, …) to add audio
tags — [thoughtful], [sighs], [excited] — to each slide's speaker notes, with
the prompt ElevenLabs publishes for exactly that:
  ${ENHANCE_SOURCE}
The agent is asked for text only (read-only); decklight checks every answer
keeps the same words, [click] beats and [pause]s before it writes the slide,
and leaves a slide whose answer does not as it was. Tags are performed by
ElevenLabs v4/v3 and left out by every other voice.

  --slides   the slides to enhance
  --all      every slide with notes
  --agent    which agent to ask (default: your remembered one, else the first found)
  --dry-run  print each enhanced script; write nothing

Note: the notes are sent to that agent, and most agents are cloud services.`;

export async function enhanceMain(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const { opt } = argReader(args);
  const deck = firstPositional(args, ['--slides', '--agent']);
  if (!deck) { console.error(`decklight enhance: needs a deck\n\n${USAGE}`); return 1; }
  const path = resolve(deck);
  if (!existsSync(path)) { console.error(`decklight enhance: no such deck: ${deck}`); return 1; }
  const all = args.includes('--all');
  const which = opt('--slides');
  if (!all && !which) {
    console.error('decklight enhance: say which slides — --slides 3 (or 2-5, or 1,4) — or --all for every slide with notes');
    return 1;
  }
  const html = readFileSync(path, 'utf8');
  let slides = null;
  try { slides = all ? null : parseSlides(which, sectionBodies(html).length); }
  catch (e) { console.error(`decklight enhance: ${e.message}`); return 1; }
  const dry = args.includes('--dry-run');
  let res;
  try {
    const n = enhanceable(html, slides).length;
    if (!n) { console.log('decklight enhance: no notes to enhance on those slides'); return 0; }
    console.log(`enhance: ${n} slide${n === 1 ? '' : 's'} — asking the agent (read-only), a few at a time…`);
    res = await enhanceDeck(html, slides, {
      agent: opt('--agent') ?? null, cwd: dirname(path),
      onSlide: (r) => console.log(`  slide ${r.slide}: ${r.ok ? (r.changed ? 'enhanced' : 'already as it would be') : `left as it was — ${r.why}`}`
        + `  (${r.done}/${r.of})`),
    });
  } catch (e) { console.error(`decklight enhance: ${e.message}`); return 1; }
  const done = res.results.filter((r) => r.changed);
  if (dry) {
    for (const r of done) {
      const aside = NOTES_ASIDE.exec(sectionBodies(res.html)[r.slide - 1])?.[1] ?? '';
      console.log(`\n── slide ${r.slide} ──\n${slideScript(aside)}`);
    }
    console.log(`\n${done.length} slide${done.length === 1 ? '' : 's'} would change — nothing written (--dry-run)`);
  } else if (done.length) {
    writeFileSync(path, res.html);
    console.log(`wrote ${deck}: ${done.length} slide${done.length === 1 ? '' : 's'} enhanced`);
  } else console.log('nothing changed');
  return res.results.some((r) => !r.ok) ? 2 : 0;
}

if (isMain(import.meta.url)) process.exit(await runMain('enhance', () => enhanceMain(process.argv.slice(2))));
