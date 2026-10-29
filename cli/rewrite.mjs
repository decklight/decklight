// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The slide-text writing tools (SPEC PRESENTING_WRITING): the words ON the
 * slide, rewritten by the locally installed agent and reviewed before they
 * land, the way the script rewrites are (cli/enhance.mjs, #907).
 *
 * THE AGENT SEES TEXT RUNS, NOT MARKUP. A slide's visible text is cut into
 * runs, the text between tags outside the notes, code, scripts, styles and
 * SVG, numbered, and the agent is asked for the same numbered runs back.
 * Decklight puts them into the slide where they came from. So a tool can
 * only change words: the slide's structure, its builds, attributes, styles
 * and classes cannot move, which is what makes it safe to run on a whole
 * deck. An answer with markup in it, a run skipped or emptied, or a change a
 * tool does not allow (a typo fix that rewords, a tighten that lengthens)
 * fails its check, and that slide is left exactly as it was, with why.
 *
 * Four tools (TOOLS): `tighten` (shorter, same meaning), `typos` (spelling,
 * grammar and punctuation, nothing else), `match` (reworded to agree with the
 * speaker notes, which are sent along) and `custom` (one instruction of the
 * author's, with the same check as match).
 */

import { agentAsk, agentUnavailable, detectAgents } from './agents.mjs';
import { ask, unwrapAnswer, ENHANCE_TIMEOUT_MS, ENHANCE_CONCURRENCY } from './enhance.mjs';
import { sectionBodies, sectionCloseIndex, isHiddenSection, locateSlide, cleanNotes, NOTES_ASIDE } from '../tools/deck-html.mjs';

/** Where the slide's text stops being the slide's: containers whose insides are not words to rewrite. */
const SKIP = /<!--[\s\S]*?-->|<(script|style|pre|code|svg|aside|textarea|kbd|samp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<[^>]+>/g;

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|apos|nbsp);/gi, (m, b) => {
  const low = b.toLowerCase();
  if (low === 'amp') return '&';
  if (low === 'lt') return '<';
  if (low === 'gt') return '>';
  if (low === 'quot') return '"';
  if (low === '#39' || low === 'apos') return "'";
  if (low === 'nbsp') return ' ';
  const code = low.startsWith('#x') ? parseInt(low.slice(2), 16) : parseInt(low.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A slide's visible text as numbered runs: `[{ n, start, end, text }]`, each
 * a stretch of text between tags with at least one word in it, `start`/`end`
 * its place in `content` (the section's inside), `text` decoded. Pure.
 */
export function textRuns(content) {
  const src = String(content ?? '');
  const runs = [];
  // what is skipped is blanked to a mark, same length, so offsets stay the
  // offsets and a run that touches it is not a run; then the text is walked
  // by tag boundaries, so a run never crosses a tag
  const skipped = src.replace(SKIP, (x) => '\u0000'.repeat(x.length));
  const bounds = [];
  for (const m of skipped.matchAll(TAG)) bounds.push([m.index, m.index + m[0].length]);
  let at = 0;
  for (const [s, e] of [...bounds, [src.length, src.length]]) {
    const piece = skipped.slice(at, s);
    if (/\S/.test(piece) && !piece.includes('\u0000')) {
      const lead = piece.match(/^\s*/)[0].length, trail = piece.match(/\s*$/)[0].length;
      const text = decode(piece.slice(lead, piece.length - trail));
      if (/[\p{L}\p{N}]/u.test(text)) runs.push({ n: runs.length + 1, start: at + lead, end: at + piece.length - trail, text });
    }
    at = e;
  }
  return runs;
}

/** `content` with each run's text replaced by `texts[n]` (encoded), from the back so offsets hold. Pure. */
export function withRuns(content, runs, texts) {
  let out = String(content ?? '');
  for (const r of [...runs].sort((a, b) => b.start - a.start)) {
    const t = texts.get?.(r.n) ?? texts[r.n];
    if (typeof t !== 'string' || t === r.text) continue;
    out = out.slice(0, r.start) + encode(t) + out.slice(r.end);
  }
  return out;
}

/** The runs as the agent is shown them: one per line, numbered. */
export const runsText = (runs) => runs.map((r) => `${r.n}: ${r.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');

/** The agent's answer as a map n → text; a line that is not `n: text` is ignored. Pure. */
export function parseRuns(answer) {
  const out = new Map();
  for (const line of unwrapAnswer(answer).split('\n')) {
    const m = /^\s*(\d+)\s*[:.)]\s?(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

const RULES = `# About this text

These are the text runs of one presentation slide, the words the audience reads, numbered in reading order. Each run is one stretch of text between the slide's tags; the layout, builds and styling around them belong to the presentation software and are not shown.

Answer with the same numbered runs, one per line, in the form \`N: text\`, every number present and in order. A run you leave unchanged, repeat exactly as it is. Never merge, split, reorder, add or drop a run. No markup, no quotes around a run, no code fences, no commentary before or after. Keep the language of the original.`;

/** The four tools: what each asks for, and how its answer is checked. */
export const TOOLS = {
  tighten: {
    label: 'tighten', done: 'tightened', what: 'text: tightened',
    ask: 'Make each run shorter while keeping its meaning, its voice and its terms. Fewer words, not fewer points: cut filler, hedges and repetition, prefer the plain word. A run that is already tight stays exactly as it is. Never make a run longer.',
  },
  typos: {
    label: 'fix typos and grammar', done: 'fixed', what: 'text: typos and grammar',
    ask: 'Fix spelling, grammar, punctuation and capitalisation only. Change nothing else: not the wording, not the order of the words, not the terms, not the language. A run with nothing wrong stays exactly as it is.',
  },
  match: {
    label: 'match the script', done: 'matched to the script', what: 'text: matched to the script',
    ask: 'The slide\'s speaker notes, what the presenter says while this slide is on screen, are given under # Notes. Reword the runs so they agree with the notes: the same terms, the same claims, the same order of ideas. Keep each run about as long as it is; a run that already agrees stays exactly as it is.',
  },
  custom: {
    label: 'custom instruction', done: 'rewritten', what: 'text: rewritten',
    ask: null,   // the author's own words (`instruction`)
  },
};

/** The whole ask for one slide's runs. */
export function rewritePrompt(tool, runs, { instruction = '', notes = '' } = {}) {
  const t = TOOLS[tool] ?? TOOLS.custom;
  const task = t.ask ?? `Apply this instruction to every run it applies to, and leave the others exactly as they are: ${String(instruction).trim()}`;
  return `# Instructions\n\n${task}\n\n${RULES}${tool === 'match' && notes ? `\n\n# Notes\n\n${notes}` : ''}\n\n# Runs\n\n${runsText(runs)}`;
}

/** Character edit distance, for the typo check — the runs are short. */
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/**
 * Why an answer cannot be written, or null: every run answered, none
 * emptied, no markup, and the tool's own rule — a typo fix that changed more
 * than a few characters per word reworded; a tighten that lengthened a run;
 * a match or a custom rewrite that doubled or halved the slide. Pure.
 */
export function rewriteProblem(tool, runs, answers) {
  if (!answers?.size) return 'the agent answered nothing the check could read';
  for (const r of runs) {
    if (!answers.has(r.n)) return `the agent skipped run ${r.n}`;
    const a = answers.get(r.n);
    if (!a.trim()) return `the agent emptied run ${r.n}`;
    if (/[<>]/.test(a)) return `the agent answered run ${r.n} with markup`;
    if (tool === 'typos' && editDistance(r.text, a) > 3 * words(r.text) + 2) return `the agent reworded run ${r.n} — a typo fix changes a few characters, not the words`;
    if (tool === 'tighten' && a.length > r.text.length + 2) return `the agent made run ${r.n} longer`;
  }
  const before = runs.reduce((n, r) => n + words(r.text), 0);
  const after = runs.reduce((n, r) => n + words(answers.get(r.n)), 0);
  if (tool !== 'typos' && tool !== 'tighten') {
    if (after > 2.5 * Math.max(1, before)) return 'the agent\'s answer is far longer than the slide — commentary, not a rewrite';
    if (after < 0.4 * before) return 'the agent\'s answer is far shorter than the slide — points were dropped';
  }
  return null;
}

/** A section body's inside: from after its opening tag to its own close. */
function insideOf(body) {
  const open = body.indexOf('>');
  const close = sectionCloseIndex(body);
  if (open < 0 || close < 0 || close < open) return null;
  return { from: open + 1, to: close };
}

/**
 * The slides a tool can work on: `[{ slide, runs, notes }]` for every shown
 * section with text (or those in `only`). Pure.
 */
export function rewritable(html, only = null) {
  const bodies = sectionBodies(html);
  return bodies.flatMap((body, i) => {
    const slide = i + 1;
    if (only && !only.includes(slide)) return [];
    if (isHiddenSection(body)) return [];
    const at = insideOf(body);
    if (!at) return [];
    const runs = textRuns(body.slice(at.from, at.to));
    if (!runs.length) return [];
    const aside = NOTES_ASIDE.exec(body);
    return [{ slide, runs, notes: aside ? cleanNotes(aside[1]) : '' }];
  });
}

/**
 * One slide's runs, rewritten: the agent is asked, its answer parsed and
 * checked. Resolves to `{ ok, texts }` (a Map n → text) or `{ ok: false, why }`.
 */
export async function rewriteRuns(tool, runs, {
  instruction = '', notes = '', agent = null, cwd = process.cwd(), env = process.env, timeoutMs = ENHANCE_TIMEOUT_MS,
  resolveAgent = agentAsk, exec = ask, signal = null,
} = {}) {
  const cmd = resolveAgent(agent, rewritePrompt(tool, runs, { instruction, notes }), { env });
  if (!cmd) return { ok: false, why: agentUnavailable(agent, detectAgents({ env })) };
  const out = await exec(cmd, cwd, timeoutMs, signal);
  if (signal?.aborted) return { ok: false, why: 'stopped' };
  if (out == null) return { ok: false, why: 'the agent did not answer in time' };
  const texts = parseRuns(out);
  const why = rewriteProblem(tool, runs, texts);
  if (why) return { ok: false, why };
  const changed = runs.some((r) => texts.get(r.n) !== r.text);
  return { ok: true, texts, changed };
}

/**
 * The answers written into `html`: each slide that passed and changed, and
 * only if its runs still read exactly as they did when the agent was asked.
 * Returns `{ html, stale }`.
 */
export function applyRewritten(html, answers) {
  let out = html;
  const stale = [];
  for (const a of answers) {
    if (!a.ok || !a.changed) continue;
    const { parts, idx } = locateSlide(out, a.slide);
    const body = parts[idx];
    const at = insideOf(body);
    const now = at ? textRuns(body.slice(at.from, at.to)) : [];
    if (!at || now.length !== a.runs.length || now.some((r, i) => r.text !== a.runs[i].text)) { stale.push(a.slide); continue; }
    parts[idx] = body.slice(0, at.from) + withRuns(body.slice(at.from, at.to), now, a.texts) + body.slice(at.to);
    out = parts.join('');
  }
  return { html: out, stale };
}

/**
 * Ask the agent to run `tool` over `slides` (1-based, or null for every shown
 * slide with text) of the deck in `html`. Resolves to `{ html, results,
 * answers }` like enhanceDeck: one `{ slide, ok, changed, why }` per slide,
 * and the raw answers for a caller that applies them to a newer copy.
 */
export async function rewriteDeck(html, tool, slides = null, {
  instruction = '', agent = null, cwd = process.cwd(), env = process.env, timeoutMs = ENHANCE_TIMEOUT_MS,
  concurrency = ENHANCE_CONCURRENCY, resolveAgent = agentAsk, exec = ask, onSlide = () => {}, signal = null,
} = {}) {
  if (!resolveAgent(agent, 'x', { env })) throw new Error(agentUnavailable(agent, detectAgents({ env })));
  const todo = rewritable(html, slides);
  const answers = [];
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < todo.length && !signal?.aborted) {
      const { slide, runs, notes } = todo[next++];
      const a = await rewriteRuns(tool, runs, { instruction, notes, agent, cwd, env, timeoutMs, resolveAgent, exec, signal });
      const r = { slide, ok: a.ok, changed: !!(a.ok && a.changed), ...(a.ok ? {} : { why: a.why }) };
      answers.push({ ...r, runs, texts: a.texts ?? null });
      onSlide({ ...r, done: ++finished, of: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  answers.sort((a, b) => a.slide - b.slide);
  const results = answers.map(({ runs, texts, ...r }) => r);
  return { html: applyRewritten(html, answers).html, results, answers };
}
