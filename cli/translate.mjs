#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight translate — a deck in several languages (SPEC TRANSLATE_CLI).
 *
 *   decklight translate <deck.html> [--to fr,es] [--slides 3,5-8] [--agent <name>] [--agent-model <m>]
 *                                   [--status | --check] [--dry-run] [--no-agent] [--discard-structure]
 *
 * DECKLIGHT DOES NOT TRANSLATE, AN AGENT DOES, AND DECKLIGHT WRITES THE FILE.
 * The agent is the one the writing tools use, run read-only, one ask per
 * slide; it is shown numbered pieces of text and answers numbered pieces of
 * text, and only an answer that passes `translateProblem` is written. The
 * file it lands in is the source with its words replaced (cli/translate-core.mjs),
 * so an agent cannot move, drop or restyle anything.
 *
 * What is behind is a string comparison against the record and never a
 * question for a model: `--status`, `--check` and `--no-agent` start none.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { agentAsk, agentUnavailable, detectAgents } from './agents.mjs';
import { ask, ENHANCE_TIMEOUT_MS, ENHANCE_CONCURRENCY, parseSlides } from './enhance.mjs';
import { parseRuns } from './rewrite.mjs';
import { deckConfig, withConfigKeys } from './runtime-link.mjs';
import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { sectionBodies } from '../tools/deck-html.mjs';
import { knownLanguages, languageFiles, resolveSource, slidesPhrase } from './translate-files.mjs';
import { runMain } from './util.mjs';
import { slideRenumber } from './commit-split.mjs';
import { applyPlans, planSteps, voiceFolders } from '../tools/voice-renumber.mjs';
import {
  deckUnits, emptyRecord, formatRecord, languageName, languageStatus, matchRecord,
  nextRecord, parseRecord, readBack, renderTranslation, sourceLang, withAlternates,
} from './translate-core.mjs';

export const USAGE = `usage: decklight translate <deck.html> [--to fr,es] [--slides 3,5-8] [--agent <name>] [--agent-model <m>]
                                [--status | --check] [--dry-run] [--no-agent] [--discard-structure]
  writes the deck in another language beside it: talk.fr.html, made from talk.html with its words
  replaced, and talk.fr.translation.json, the record of what each piece was translated from.
  Commit all three. Run it again after editing talk.html and only what changed is translated

  --to fr,es        the languages (BCP 47 tags) [every language the deck's "languages" names]
                    a language named for the first time is added there
  --slides 3,5-8    ask the agent about these slides only; the rest catch up without it
  --agent NAME      the coding agent that translates [the one the writing tools use]
  --agent-model M   its model, for this run
  --status          what is behind, per language. Starts no agent and writes nothing
  --check           the same, and exit 1 when any language is behind (for CI)
  --dry-run         ask the agent and print what would change, write nothing
  --no-agent        regenerate from the record alone: the structure catches up, the
                    words that need a model stay behind and are counted
  --discard-structure  overwrite a translation that was changed in more than its words

  fixing a translation is editing the translation: a sentence you change in talk.fr.html is
  kept, and never re-asked while its source stands. The slides' text and notes are sent to
  the agent, and most agents are cloud services
`;

export { knownLanguages, languageFiles, resolveSource } from './translate-files.mjs';

const VALUE_FLAGS = ['--to', '--slides', '--agent', '--agent-model', '--wait'];

/** Run started by the edit server: "stop" on stdin stops it after the slides in flight (TRANSLATE_PANEL). */
function stopOnInput(controller) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (s) => { if (/\bstop\b/.test(s)) controller.abort(); });
  process.stdin.on('error', () => {});
  process.stdin.unref?.();
}
const TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/** Is `tag` a language this command can name a file after? */
export function tagProblem(tag) {
  if (!TAG.test(tag)) return `"${tag}" is not a language tag (fr, pt-BR, zh-Hans)`;
  try { Intl.getCanonicalLocales(tag); } catch { return `"${tag}" is not a language tag (fr, pt-BR, zh-Hans)`; }
  return null;
}

// ── the ask ──────────────────────────────────────────────────────────────────

const KIND_LABEL = { run: 'text', beat: 'notes', attr: 'attribute', label: 'diagram', title: 'title' };
const PARA = ' ¶ ';
const oneLine = (u) => (u.kind === 'beat' ? u.text.split('\n\n').join(PARA) : u.text.replace(/\s*\n\s*/g, ' '));
const fromLine = (kind, s) => (kind === 'beat' ? s.split(/\s*¶\s*/).map((p) => p.trim()).filter(Boolean).join('\n\n') : s.trim());

/** The script a language is written in, as a regex over letters, or null when no check is made for it. */
export function scriptRe(lang) {
  let script;
  try { script = new Intl.Locale(lang).maximize().script; } catch { return null; }
  const P = (...names) => new RegExp(`[${names.map((n) => `\\p{Script=${n}}`).join('')}]`, 'u');
  return ({
    Latn: P('Latin'), Cyrl: P('Cyrillic'), Grek: P('Greek'), Arab: P('Arabic'), Hebr: P('Hebrew'),
    Deva: P('Devanagari'), Thai: P('Thai'), Hang: P('Hangul'), Kore: P('Hangul', 'Han'),
    Hans: P('Han'), Hant: P('Han'), Jpan: P('Han', 'Hiragana', 'Katakana'), Beng: P('Bengali'),
    Taml: P('Tamil'), Geor: P('Georgian'), Armn: P('Armenian'), Ethi: P('Ethiopic'),
  })[script] ?? null;
}
const scriptOf = (lang) => { try { return new Intl.Locale(lang).maximize().script; } catch { return null; } };

/** The whole ask for one slide's pieces. */
export function translatePrompt(units, { from, to, title = '', glossary = {}, done = [], limits = null } = {}) {
  const fromName = from ? `${languageName(from, { in: 'en' })} (${from})` : 'the language it is written in';
  const toName = `${languageName(to, { in: 'en' })} (${to})`;
  const terms = Object.entries(glossary ?? {});
  const changed = units.map((u, k) => ({ u, n: k + 1 })).filter(({ u }) => u.status === 'changed' && u.previous);
  return [
    '# Instructions',
    '',
    `Translate the numbered pieces of one presentation slide from ${fromName} into ${toName}.`,
    '',
    'Each piece is one stretch of text: [text] is words on the slide, [notes] is what the presenter says aloud while the slide is on screen (write it to be spoken), [attribute] is a short label such as an image description or a chapter name, [diagram] is a word drawn in a diagram or a chart, [title] is the deck\'s title. Translate each piece on its own; never merge, split, reorder, add or drop one.',
    '',
    'Answer with the same numbered pieces, one per line, in the form `N: text`, every number present and in order. No markup, no quotes around a piece, no code fences, no commentary before or after.',
    '',
    'Keep every bracketed direction such as [pause], [long pause] or [whispers] exactly as written, where it falls in the sentence: it is an instruction to the voice, not words. ¶ marks a paragraph break: keep each one. Product names, commands, code, file names and URLs stay as they are. Keep each piece about as long as it is: the slide\'s text has to fit where it is.',
    ...(terms.length ? ['', '# Glossary', '', 'Translate these terms this way, every time (a term given as itself stays as it is):', '', ...terms.map(([a, b]) => `- ${a} → ${b}`)] : []),
    ...(title ? ['', '# The deck', '', `Title: ${title}`] : []),
    ...(done.length ? ['', '# Already translated on this slide', '', 'Agree with these:', '', ...done.map((u) => `- ${oneLine(u)} → ${u.kind === 'beat' ? u.target.split('\n\n').join(PARA) : u.target}`)] : []),
    ...(changed.length ? ['', '# Previous translations', '', 'These pieces were translated before and their source has since been reworded. Change the previous translation only as much as the rewording needs:', '',
      ...changed.map(({ u, n }) => `${n}: was "${oneLine({ ...u, text: u.previous.source })}", translated "${u.kind === 'beat' ? u.previous.target.split('\n\n').join(PARA) : u.previous.target}"`)] : []),
    ...(limits ? ['', '# Too long', '', 'Your last translation of this slide did not fit on it. Answer again with shorter text, keeping the meaning, each piece within the characters given.'] : []),
    '',
    '# Pieces',
    '',
    ...units.map((u, k) => `${k + 1} [${KIND_LABEL[u.kind] ?? u.kind}${limits?.[k] ? `, at most ${limits[k]} characters` : ''}]: ${oneLine(u)}`),
  ].join('\n');
}

const tagsOf = (s) => (String(s).match(/\[[^\]\n]{1,40}\]/g) ?? []).map((t) => t.toLowerCase().replace(/\s+/g, ' ')).sort().join('|');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Why an answer cannot be written, or null (SPEC TRANSLATE_CLI): every piece
 * answered and none emptied, no markup, a piece's bracketed directions and
 * paragraphs all kept, every glossary term as the glossary says, and the
 * answer in the target language's script where the source's differs. Pure.
 */
export function translateProblem(units, answers, { from = null, to, glossary = {}, limits = null } = {}) {
  if (!answers?.size) return 'the agent answered nothing the check could read';
  for (const [k, u] of units.entries()) {
    const n = k + 1;
    if (!answers.has(n)) return `the agent skipped piece ${n}`;
    const a = answers.get(n);
    if (!a.trim()) return `the agent emptied piece ${n}`;
    if (/[<>]/.test(a)) return `the agent answered piece ${n} with markup`;
    if (tagsOf(oneLine(u)) !== tagsOf(a)) return `piece ${n} lost or changed a bracketed direction such as [pause]`;
    if (u.kind === 'beat' && (oneLine(u).match(/¶/g) ?? []).length !== (a.match(/¶/g) ?? []).length) return `piece ${n} lost a paragraph break`;
    if (limits?.[k] && a.trim().length > limits[k]) return `piece ${n} is still longer than ${limits[k]} characters`;
    for (const [term, target] of Object.entries(glossary ?? {})) {
      if (!term || !target) continue;
      const hit = new RegExp(`(?<!\\p{L})${escRe(term)}(?!\\p{L})`, 'iu').test(u.text);
      if (hit && !a.toLowerCase().includes(String(target).toLowerCase())) return `piece ${n}: the glossary says "${term}" is "${target}"`;
    }
  }
  const want = scriptRe(to);
  if (want && scriptOf(to) !== scriptOf(from ?? 'en')) {
    const letters = [...answers.values()].join(' ');
    if (/\p{L}/u.test(letters) && !want.test(letters)) return `the answer is not written in ${languageName(to, { in: 'en' })}'s script`;
  }
  return null;
}

/**
 * One slide's pieces, translated: the agent is asked, its answer parsed and
 * checked. Resolves to `{ ok, texts: [text] }` or `{ ok: false, why }`.
 */
export async function translateUnits(units, opts) {
  const { agent = null, model, cwd = process.cwd(), env = process.env, timeoutMs = ENHANCE_TIMEOUT_MS, resolveAgent = agentAsk, exec = ask, signal = null } = opts;
  const cmd = resolveAgent(agent, translatePrompt(units, opts), { env, model });
  if (!cmd) return { ok: false, why: agentUnavailable(agent, detectAgents({ env })) };
  const out = await exec(cmd, cwd, timeoutMs, signal);
  if (signal?.aborted) return { ok: false, why: 'stopped' };
  if (out == null) return { ok: false, why: 'the agent did not answer in time' };
  const answers = parseRuns(out);
  const why = translateProblem(units, answers, opts);
  if (why) return { ok: false, why };
  return { ok: true, texts: units.map((u, k) => fromLine(u.kind, answers.get(k + 1))) };
}

/** Run `fn` over `items`, `n` at a time, in order of starting. */
async function pool(items, n, fn, signal = null) {
  let next = 0;
  const worker = async () => { while (next < items.length && !signal?.aborted) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * The same source text is given the same translation (TRANSLATION_UNITS): a
 * chapter name or a step of a run of steps is matched to the others by its
 * words, so an attribute translated twice in one run, or once now and once
 * before, takes one translation.
 */
export function unifyAttributes(matched) {
  const first = new Map();
  const all = [...matched.deck, ...matched.slides.flat()];
  for (const u of all) if (u.kind === 'attr' && u.status === 'current' && !first.has(u.text)) first.set(u.text, u);
  for (const u of all) if (u.kind === 'attr' && u.status === 'translated' && !first.has(u.text)) first.set(u.text, u);
  for (const u of all) {
    if (u.kind !== 'attr' || u.status !== 'translated') continue;
    const f = first.get(u.text);
    if (f && f !== u) { u.target = f.target; u.state = f.state; }
  }
}

/**
 * Ask the agent for every behind unit on `slides` (1-based numbers, null for
 * all), in place on `matched`. Resolves to `[{ slide, ok, why, count, redone }]`.
 */
export async function translateMatched(matched, { slides = null, limitsBySlide = null, onSlide = () => {}, ...opts }) {
  const todo = [];
  const behind = (u) => u.status === 'changed' || u.status === 'missing';
  if (matched.deck.some(behind) && !limitsBySlide) todo.push({ slide: 0, units: matched.deck.filter(behind) });
  matched.slides.forEach((S, i) => {
    if (slides && !slides.includes(i + 1)) return;
    if (limitsBySlide && !limitsBySlide.has(i + 1)) return;
    const units = limitsBySlide ? S.filter((u) => u.status === 'translated') : S.filter(behind);
    if (units.length) todo.push({ slide: i + 1, units, done: S.filter((u) => u.status === 'current') });
  });
  const results = [];
  let finished = 0;
  await pool(todo, opts.concurrency ?? ENHANCE_CONCURRENCY, async ({ slide, units, done = [] }) => {
    const limits = limitsBySlide?.get(slide)?.(units) ?? null;
    const asked = limitsBySlide ? units.map((u) => ({ ...u, status: 'missing' })) : units;
    const a = await translateUnits(asked, { ...opts, done, limits });
    const r = { slide, ok: a.ok, count: units.length, ...(a.ok ? {} : { why: a.why }), redone: 0 };
    if (a.ok) {
      units.forEach((u, k) => {
        if (u.status === 'changed' && u.previous?.state === 'reviewed') r.redone++;
        Object.assign(u, { status: 'translated', target: a.texts[k], state: 'machine' });
      });
    }
    results.push(r);
    onSlide({ ...r, done: ++finished, of: todo.length });
  }, opts.signal);
  unifyAttributes(matched);
  return results.sort((x, y) => x.slide - y.slide);
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * The language's recordings follow its slides: where each slide of the
 * translation as it was is in the translation as it is now, read off the
 * sections (as the edit server reads an agent's edit), applied to the
 * language's own voice folders. A line saying what moved, or ''.
 */
export function followTakes(deckPath, before, after, label) {
  const pairs = slideRenumber(before, after);
  if (!pairs.length) return '';
  const dirs = voiceFolders(deckPath);
  if (!dirs.length) return '';
  const r = planSteps(dirname(deckPath), dirs.map((dir) => ({ dir, pairs })));
  if (r.error) return `translate: ${label}: ${r.error} — they were left where they were; realign them from the narration panel\n`;
  if (!r.plans.length) return '';
  try { applyPlans(dirname(deckPath), r.plans); } catch (e) { return `translate: ${label}: the recordings could not follow the slides — ${e.message}\n`; }
  return `translate: ${label}: the recordings in ${r.plans.map((p) => `${p.dir}/`).join(', ')} followed their slides\n`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line of `--status` for a language. */
export function statusLine(lang, st, html, { exists = true } = {}) {
  const name = `${languageName(lang)} · ${lang}`;
  if (!exists) return `  ○ ${name}  not translated yet`;
  const read = `${st.reviewed} of ${st.total} reviewed`;
  if (st.up) return `  ✓ ${name}  up to date · ${read}`;
  const parts = [st.changed && `${st.changed} changed`, st.missing && `${st.missing} missing`].filter(Boolean).join(', ');
  return `  ↑ ${name}  behind: ${parts} ${slidesPhrase(html, st.behind)} · ${read}`;
}

/** The overflowing slides of a written deck, by the same render `decklight check` reads; null with no browser. */
async function overflowing(deckPath, { render = null, wait = 8000 } = {}) {
  const r = render ?? (await import('./check.mjs').then(async (check) => {
    const { findChrome } = await import('../tools/chrome.mjs');
    const bin = findChrome();
    return bin ? (path) => check.checkOnce(path, path, { render: check.oneShot(bin), wait }) : null;
  }));
  if (!r) return null;
  const once = await r(deckPath);
  return once ? [...new Set(once.findings.filter((f) => f.rule === 'overflow' && f.slide).map((f) => f.slide))] : null;
}

export async function translateMain(args = [], {
  out = process.stdout, err = process.stderr, env = process.env, exec = ask, resolveAgent = agentAsk, render = null,
} = {}) {
  if (args.includes('--help') || args.includes('-h')) { out.write(USAGE); return 0; }
  const { opt } = argReader(args);
  const given = firstPositional(args, VALUE_FLAGS);
  if (!given) { err.write(`decklight translate: needs a deck\n\n${USAGE}`); return 1; }
  const deckPath = resolve(given);
  if (!existsSync(deckPath)) { err.write(`decklight translate: no such deck: ${given}\n`); return 1; }
  const { source, given: was } = resolveSource(deckPath);
  if (was) err.write(`decklight translate: ${basename(deckPath)} is the ${languageName(was, { in: 'en' })} of ${basename(source)} — translating from ${basename(source)}\n`);
  let html = readFileSync(source, 'utf8');
  const from = sourceLang(html);
  const sourceName = basename(source);

  const status = args.includes('--status') || args.includes('--check');
  const dry = args.includes('--dry-run');
  const noAgent = args.includes('--no-agent');
  const discard = args.includes('--discard-structure');
  const asked = opt('--to') ? opt('--to').split(',').map((s) => s.trim()).filter(Boolean) : null;
  for (const t of asked ?? []) {
    const bad = tagProblem(t);
    if (bad) { err.write(`decklight translate: ${bad}\n`); return 1; }
    if (from && t.toLowerCase() === from.toLowerCase()) { err.write(`decklight translate: ${sourceName} is already in ${t}\n`); return 1; }
  }
  const known = knownLanguages(source, html);
  const langs = asked ?? known;
  if (!langs.length) {
    err.write(`decklight translate: ${sourceName} names no languages yet — say which with --to (decklight translate ${given} --to fr)\n`);
    return 1;
  }
  const total = sectionBodies(html).length;
  let only = null;
  if (opt('--slides')) {
    try { only = parseSlides(opt('--slides'), total); } catch (e) { err.write(`decklight translate: ${e.message}\n`); return 1; }
  }

  // a language named for the first time joins the source's list
  const fresh = langs.filter((l) => !known.some((k) => k.toLowerCase() === l.toLowerCase()));
  if (fresh.length && !status && !dry) {
    const listed = Array.isArray(deckConfig(html)?.languages) ? deckConfig(html).languages : [];
    const next = withConfigKeys(html, { languages: [...listed, ...fresh] });
    if (next) { writeFileAtomic(source, next); html = next; }
    else err.write(`decklight translate: ${sourceName} has no configuration block to list ${fresh.join(', ')} in — name ${fresh.length === 1 ? 'it' : 'them'} with --to each time\n`);
  }

  if (!status && !noAgent && !resolveAgent(opt('--agent') ?? null, 'x', { env })) {
    err.write(`decklight translate: ${agentUnavailable(opt('--agent') ?? null, detectAgents({ env }))}\n`
      + '  (--no-agent regenerates the translations without one: the words that need a model stay behind)\n');
    return 1;
  }

  const source$ = deckUnits(html);
  // every language of the deck, linked from each translation (TRANSLATION_SWITCH)
  const everyLang = [...new Map([...knownLanguages(source, html), ...langs].map((l) => [l.toLowerCase(), l])).values()];
  const alternates = [
    ...(from ? [{ lang: from, href: sourceName }] : []),
    ...everyLang.map((l) => ({ lang: l, href: basename(languageFiles(source, l).deck) })),
  ];
  const controller = new AbortController();
  if (args.includes('--from-server')) stopOnInput(controller);
  let code = 0;
  if (status) out.write(`${sourceName}${from ? ` (${from})` : ''} · ${plural(langs.length, 'language')}\n`);
  for (const lang of langs) {
    const files = languageFiles(source, lang);
    const label = `${languageName(lang, { in: 'en' })} (${basename(files.deck)})`;
    let record;
    try { record = existsSync(files.record) ? parseRecord(readFileSync(files.record, 'utf8')) : emptyRecord(sourceName, from, lang); }
    catch (e) { err.write(`decklight translate: ${basename(files.record)} cannot be read — ${e.message}\n`); code = 2; continue; }
    const translation = existsSync(files.deck) ? readFileSync(files.deck, 'utf8') : null;
    const back = readBack(record, translation);
    if (back.structure.length && !discard) {
      for (const s of back.structure) {
        err.write(`decklight translate: ${basename(files.deck)}${s.slide ? `, slide ${s.slide}` : ''}: ${s.why}. `
          + `A translation takes its structure from ${sourceName}: make that change there, or run again with --discard-structure to overwrite it\n`);
      }
      code = 2;
      continue;
    }
    const base = back.structure.length ? record : back.record;
    const matched = matchRecord(source$, { ...base, slides: back.structure.length ? [] : base.slides });
    const before = languageStatus(matched);

    if (status) {
      out.write(`${statusLine(lang, before, html, { exists: !!translation })}\n`);
      if (back.corrected) out.write(`      ${plural(back.corrected, 'correction')} in ${basename(files.deck)}, kept as reviewed at the next run\n`);
      if (!before.up || !translation) code = args.includes('--check') ? Math.max(code, 1) : code;
      continue;
    }

    let results = [];
    let writtenRecord = null;
    if (!noAgent && !before.up) {
      out.write(`translate: ${label} — ${plural(before.changed + before.missing, 'piece')} to translate ${slidesPhrase(html, only ? before.behind.filter((n) => only.includes(n)) : before.behind)}\n`);
      const common = {
        from, to: lang, title: source$.deck[0]?.text ?? '', glossary: base.glossary ?? {},
        agent: opt('--agent') ?? null, model: opt('--agent-model'), env, exec, resolveAgent, cwd: dirname(source),
        signal: controller.signal,
      };
      results = await translateMatched(matched, {
        ...common, slides: only,
        onSlide: (r) => out.write(`  [${r.done}/${r.of}] ${r.slide ? `slide ${r.slide}` : 'the title'} ${r.ok ? `· ${plural(r.count, 'piece')}` : `· left as it was: ${r.why}`}\n`),
      });

      // fit is measured, not estimated: render, and re-ask a slide that overflows for shorter text
      if (!dry && results.some((r) => r.ok && r.slide)) {
        for (let round = 0; round < 2; round++) {
          const draft = renderTranslation(html, matched, { lang, sourceName, alternates });
          writeFileAtomic(files.deck, draft.html);
          const over = await overflowing(files.deck, { render, wait: Number(opt('--wait', 8000)) });
          const ours = (over ?? []).filter((n) => matched.slides[n - 1]?.some((u) => u.status === 'translated'));
          if (!ours.length) break;
          out.write(`  ${plural(ours.length, 'slide')} ${slidesPhrase(html, ours)} ${ours.length === 1 ? 'does' : 'do'} not fit — asking for shorter text\n`);
          const limitsBySlide = new Map(ours.map((n) => [n, (units) => units.map((u) => (u.kind === 'run' ? Math.max(4, Math.min(u.text.length, Math.floor(u.target.length * 0.85))) : null))]));
          await translateMatched(matched, { ...common, limitsBySlide });
        }
      }
    }

    const after = languageStatus(matched);
    if (dry) {
      const now = matched.slides.flatMap((S, i) => S.filter((u) => u.status === 'translated').map((u) => ({ u, slide: i + 1 })));
      for (const { u, slide } of now) out.write(`  slide ${slide} [${KIND_LABEL[u.kind]}] ${u.text.replace(/\n+/g, ' ')}\n      → ${u.target.replace(/\n+/g, ' ')}\n`);
      out.write(`translate: --dry-run — ${basename(files.deck)} not written\n`);
    } else {
      const written = renderTranslation(html, matched, { lang, sourceName, alternates });
      // a slide moved in the source moves this language's takes with it, at
      // the run that moves the slide here (TRANSLATION_VOICE)
      if (translation) out.write(followTakes(files.deck, translation, written.html, label));
      writeFileAtomic(files.deck, written.html);
      writeFileAtomic(files.record, formatRecord(nextRecord(base, matched, written.structure)));
      writtenRecord = nextRecord(base, matched, written.structure);
    }
    const done = results.filter((r) => r.ok).reduce((n, r) => n + r.count, 0);
    const failed = results.filter((r) => !r.ok);
    const redone = results.reduce((n, r) => n + r.redone, 0);
    const parts = [
      `${label}: ${done ? `${plural(done, 'piece')} translated` : 'nothing translated'}`,
      back.corrected ? `${plural(back.corrected, 'correction')} of yours kept` : '',
      after.up ? 'up to date' : `${plural(after.changed + after.missing, 'piece')} still behind ${slidesPhrase(html, after.behind) || 'in the title'}`,
      ...failed.map((r) => `${r.slide ? `slide ${r.slide}` : 'the title'} left as it was: ${r.why}`),
      redone ? `${plural(redone, 'reviewed translation')} redone, the source changed` : '',
    ].filter(Boolean);
    out.write(`translate: ${parts.join(' · ')}\n`);
    if (!dry && done) {
      const still = await overflowing(files.deck, { render, wait: Number(opt('--wait', 8000)) }).catch(() => null);
      if (still?.length) out.write(`translate: ${basename(files.deck)} — ${plural(still.length, 'slide')} still ${still.length === 1 ? 'overflows' : 'overflow'} ${slidesPhrase(html, still)}: shorten the ${languageName(lang, { in: 'en' })} in the file, or the source\n`);
      // what the panel says until the next run measures again (TRANSLATE_PANEL)
      if (still && writtenRecord) writeFileAtomic(files.record, formatRecord({ ...writtenRecord, overflow: still }));
    }
    if (failed.length) code = 2;
    if (controller.signal.aborted) { out.write('translate: stopped — what was answered and passed is written, the rest stays behind\n'); break; }
  }
  // the translations this run did not write still link every language there now is
  if (!status && !dry) {
    for (const l of everyLang) {
      if (langs.some((x) => x.toLowerCase() === l.toLowerCase())) continue;
      const f = languageFiles(source, l).deck;
      if (!existsSync(f)) continue;
      const was = readFileSync(f, 'utf8');
      const now = withAlternates(was, alternates);
      if (now !== was) writeFileAtomic(f, now);
    }
  }
  return code;
}

if (isMain(import.meta.url)) {
  process.exitCode = await runMain('translate', () => translateMain(process.argv.slice(2)));
  // started by the edit server, whose pipe on stdin would keep it alive
  if (process.argv.includes('--from-server')) process.exit(process.exitCode);
}
