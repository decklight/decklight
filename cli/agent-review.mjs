// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent review (Check deck…'s *Review deck with agent…*, SPEC PRESENTING):
 * the local agent reads the deck and says where it could be better, on the
 * questions a rule cannot answer and a reader can.
 *
 * `decklight check` counts what can be counted: a clipped slide, a crowded
 * one, a build that drifts from its notes. Whether a figure has a source
 * behind it, whether the notes say more than the bullets, whether a title
 * states a point, whether a list wants to be a diagram: those take reading,
 * and an agent is a reader the author already has open.
 *
 * Shaped like `enhance` (cli/enhance.mjs), on purpose. The agent runs
 * READ-ONLY, a few slides at a time; decklight builds the prompt, and every
 * answer is checked before anything is shown: a finding on a slide it was not
 * asked about, under a rule nobody named, or with nothing to say is dropped,
 * never repaired. Only the author's own `f` on a finding touches the file,
 * and that is an ordinary A edit (one undo entry, one commit).
 */

import { agentAsk, agentUnavailable, detectAgents } from './agents.mjs';
import { ask, unwrapAnswer, ENHANCE_CONCURRENCY } from './enhance.mjs';
import {
  NOTES_ASIDE, cleanNotes, isHiddenSection, sectionBodies, sectionInner, slideHeading, slideText,
} from '../tools/deck-html.mjs';
import { fingerprint } from '../tools/review-anchor.mjs';

/**
 * The rules, in the order findings are listed. Each `ask` is what the prompt
 * says, word for word; `label` is what Check deck… calls it. A rule is added
 * here and nowhere else: the prompt, the check on the answer and the panel all
 * read this list.
 */
export const REVIEW_RULES = [
  {
    id: 'unsourced-figure',
    label: 'figure without a source',
    ask: 'The slide states a figure, a date, a percentage, a ranking or a quotation, and no source listed for the slide backs it '
      + '(there is none, or the ones listed are plainly about something else). Name the figure. Do not flag general knowledge '
      + 'or the deck\'s own product facts, and never invent what a source says.',
  },
  {
    id: 'thin-voiceover',
    label: 'voiceover missing or thin',
    ask: 'The slide has no speaker notes, or its notes only read the slide\'s own words back. The notes are what the presenter '
      + 'SAYS: they should carry what the slide does not, such as the reason, the example, the consequence. Say what is missing.',
  },
  {
    id: 'topic-title',
    label: 'title is a topic',
    ask: 'The title names a topic ("Results", "Architecture", "Next steps") where it could state the slide\'s point '
      + '("Latency halved after the cache"). Skip title slides, chapter dividers and closing slides. Propose the title.',
  },
  {
    id: 'better-as-visual',
    label: 'clearer as a diagram or table',
    ask: 'The slide writes as bullets something that has a shape: a process or sequence (a diagram, revealed step by step), '
      + 'or a comparison across the same attributes (a table). Skip slides that already have a diagram or a table. Say which shape.',
  },
];
const RULE_IDS = new Set(REVIEW_RULES.map((r) => r.id));
const ruleRank = (id) => REVIEW_RULES.findIndex((r) => r.id === id);

/** How many slides one ask covers: enough to see the deck's voice, few enough to read closely. */
export const REVIEW_BATCH = 6;
/** How long one batch may take: a reading of six slides, not a rewrite. */
export const REVIEW_TIMEOUT_MS = 180_000;
/** What a message or a fix may run to; the panel shows one line of it. */
const MESSAGE_MAX = 160;
const FIX_MAX = 400;
/** A slide's own text, cut where it stops helping the agent and starts costing the prompt. */
const TEXT_MAX = 1200;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SOURCES_ASIDE = /<aside\b[^>]*\bclass\s*=\s*["'][^"']*\bsources\b[^"']*["'][^>]*>([\s\S]*?)<\/aside>/i;
const plain = (html) => slideText(html);

/** The sources aside, as lines an agent reads: `owner: platform-team`, `Annual report (report.pdf#page=12): pp. 12–14`. */
function sourcesOf(inner) {
  const aside = SOURCES_ASIDE.exec(inner)?.[1];
  if (!aside) return [];
  const facts = [...aside.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map(([, k, v]) => `${plain(k)}: ${plain(v)}`);
  const links = [...aside.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].flatMap(([, li]) => {
    const a = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(li);
    if (!a) return [];
    const title = plain(a[2]);
    const note = plain(li.replace(a[0], ' ')).replace(/^[\s—–-]+/, '');
    return [`${title} (${a[1]})${note ? `: ${note}` : ''}`];
  });
  return [...facts, ...links];
}

/**
 * What the agent is shown of each visible slide, and the fingerprint a
 * finding keeps of it: `{ slide, title, text, notes, sources, hasDiagram, hasTable, fp }`.
 * The fingerprint covers the notes too: a thin voiceover is fixed in the notes,
 * and a fixed slide must stop being flagged.
 */
export function reviewSlides(html) {
  return sectionBodies(String(html ?? '')).flatMap((body, i) => {
    if (isHiddenSection(body)) return [];
    const inner = sectionInner(body);
    const notes = cleanNotes(NOTES_ASIDE.exec(inner)?.[1] ?? '').trim();
    const text = slideText(inner);
    return [{
      slide: i + 1,
      title: slideHeading(inner, i),
      text: clip(text, TEXT_MAX),
      notes,
      sources: sourcesOf(inner),
      hasDiagram: /<svg\b/i.test(inner.replace(/<div\b[^>]*class="[^"]*\b(chart|terminal)\b[\s\S]*?<\/div>/gi, '')),
      hasTable: /<table\b/i.test(inner),
      fp: fingerprint(`${text}\n${notes}`),
    }];
  });
}

/** The ask for one batch: the rules, the deck's outline for context, the slides, and the answer's exact shape. */
export function reviewPrompt(batch, outline) {
  const rules = REVIEW_RULES.map((r) => `- \`${r.id}\`: ${r.ask}`).join('\n');
  const deck = outline.map((s) => `${s.slide}. ${s.title}`).join('\n');
  const slides = batch.map((s) => [
    `### Slide ${s.slide}: ${s.title}`,
    `On the slide: ${s.text || '(nothing but the title)'}`,
    `Speaker notes: ${s.notes || '(none)'}`,
    `Sources listed: ${s.sources.length ? s.sources.join(' · ') : '(none)'}`,
    `Has a diagram: ${s.hasDiagram ? 'yes' : 'no'} · has a table: ${s.hasTable ? 'yes' : 'no'}`,
  ].join('\n')).join('\n\n');
  return `# Review these slides

You are reviewing slides of a presentation for its author. Read only what is
below; do not open, edit or create any file. Answer with JSON and nothing else.

## Flag only these, and only where they clearly apply

${rules}

## The whole deck, for context

${deck}

## The slides to review

${slides}

## Your answer

A JSON array, one object per problem found, each
\`{"slide": <number>, "rule": "<one of the ids above>", "message": "<what is wrong, one sentence to the author, under ${MESSAGE_MAX} characters>", "fix": "<one concrete instruction that would fix it on this slide>"}\`.
At most one object per slide and rule. Only the slides listed above. If nothing
applies, answer \`[]\`. Never guess what a source says.
`;
}

/**
 * The findings in an answer, checked: `{ findings }`, or `{ why }` when the
 * answer is not a list at all. Never throws. An item is kept only if it names
 * a slide of `batch`, a known rule, and says something; the first per slide
 * and rule wins. Each kept finding carries its slide's title and fingerprint.
 */
export function parseReview(answer, batch) {
  let t = unwrapAnswer(answer);
  // an agent that talks before its JSON: the outermost array, if there is one
  if (!t.startsWith('[')) {
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a !== -1 && b > a) t = t.slice(a, b + 1);
  }
  let items;
  try { items = JSON.parse(t); } catch { return { why: 'the agent did not answer with JSON' }; }
  if (!Array.isArray(items)) return { why: 'the agent did not answer with a list' };
  const bySlide = new Map(batch.map((s) => [s.slide, s]));
  const seen = new Set();
  const findings = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const s = bySlide.get(Number(it.slide));
    const message = typeof it.message === 'string' ? it.message.replace(/\s+/g, ' ').trim() : '';
    const fix = typeof it.fix === 'string' ? it.fix.replace(/\s+/g, ' ').trim() : '';
    if (!s || !RULE_IDS.has(it.rule) || !message || !fix) continue;
    const key = `${s.slide}|${it.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ slide: s.slide, title: s.title, fp: s.fp, rule: it.rule, message: clip(message, MESSAGE_MAX), fix: clip(fix, FIX_MAX) });
  }
  return { findings };
}

const order = (a, b) => a.slide - b.slide || ruleRank(a.rule) - ruleRank(b.rule);

/**
 * Review the deck in `html`: batches of `REVIEW_BATCH` slides, a few at a
 * time, each through a read-only ask. Resolves to `{ findings, failed }`,
 * `failed` being `[{ slides, why }]` for a batch that timed out or answered
 * nothing usable. Throws only when there is no agent to ask at all.
 */
export async function reviewDeck(html, {
  agent = null, cwd = process.cwd(), env = process.env, timeoutMs = REVIEW_TIMEOUT_MS,
  concurrency = ENHANCE_CONCURRENCY, resolveAgent = agentAsk, exec = ask, onBatch = () => {},
} = {}) {
  if (!resolveAgent(agent, 'x', { env })) throw new Error(agentUnavailable(agent, detectAgents({ env })));
  const slides = reviewSlides(html);
  const outline = slides.map(({ slide, title }) => ({ slide, title }));
  const batches = [];
  for (let i = 0; i < slides.length; i += REVIEW_BATCH) batches.push(slides.slice(i, i + REVIEW_BATCH));
  const findings = [];
  const failed = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const cmd = resolveAgent(agent, reviewPrompt(batch, outline), { env });
      const out = cmd ? await exec(cmd, cwd, timeoutMs) : null;
      const r = out == null ? { why: 'the agent did not answer in time' } : parseReview(out, batch);
      if (r.findings) findings.push(...r.findings);
      else failed.push({ slides: batch.map((s) => s.slide), why: r.why });
      onBatch({ done: ++done, of: batches.length, found: findings.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return { findings: findings.sort(order), failed: failed.sort((a, b) => a.slides[0] - b.slides[0]) };
}

/**
 * The findings that still hold in the deck as it is NOW, each on the slide it
 * now sits at: matched by fingerprint, so a slide that moved keeps its
 * finding and a slide that was edited (fixed, or rewritten) drops it. A
 * finding about a slide that changed is a finding about text that no longer
 * exists.
 */
export function currentFindings(html, findings) {
  const now = new Map();
  for (const s of reviewSlides(html)) if (!now.has(s.fp)) now.set(s.fp, s);
  return (findings ?? []).flatMap((f) => {
    const s = now.get(f.fp);
    return s ? [{ ...f, slide: s.slide, title: s.title }] : [];
  }).sort(order);
}

/** The instruction the A agent is given to fix one finding (`f` in Check deck…). */
export const fixPrompt = (f) => `On slide ${f.slide} ("${f.title}"), fix this one review finding and nothing else. `
  + `The problem: ${f.message} What to do: ${f.fix}`
  + (f.rule === 'unsourced-figure' ? ' Add a source only if you can open and read it; otherwise say so in the speaker notes instead of inventing one.' : '');
