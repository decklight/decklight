// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck in several languages (SPEC TRANSLATIONS): the translation is the
// source with its words replaced, the record says what each piece was
// translated from, and what is behind is a string comparison, never a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  deckUnits, emptyRecord, matchRecord, readBack, renderTranslation, nextRecord, languageStatus, slideShape, slideUnits, isRtl,
} from '../cli/translate-core.mjs';
import { translateMain, translateProblem, translatePrompt, tagProblem, knownLanguages } from '../cli/translate.mjs';

const DECK = `<!doctype html>
<html lang="en"><head><title>Ship it</title>
<script type="application/json" data-decklight-config>{ "decklight": "0.9.0" }</script></head>
<body><div class="decklight">
<section data-module="Intro"><h2>Ship on Friday</h2>
<ul data-build><li>Three &amp; things</li><li>changed</li></ul>
<img src="a.png" alt="A rocket">
<pre><code>npm run build</code></pre>
<aside class="notes">We ship on Friday. [pause] Here is why.
[click]
First, the <b>tests</b>.</aside></section>
<section data-steps="Foundation, Fresh context"><h2>Plan</h2>
<svg viewBox="0 0 10 10"><rect/><text x="1">Agent</text></svg>
<div class="chart" data-chart="bar" data-title="Latency"><script type="application/json">{"labels":["old","new"],"series":[{"name":"p50","data":[1,2],"dashFrom":"new"}]}</script></div>
</section>
<section data-step="Fresh context"><h2>Context</h2></section>
</div></body></html>`;

/** A folder with the deck, removed when the test ends. */
function folder(t, html = DECK) {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-translate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'talk.html'), html);
  return dir;
}

/** An agent that answers every piece with `FR:` in front, and remembers what it was asked. */
function stubAgent({ answer = (text) => `FR:${text}` } = {}) {
  const asked = [];
  return {
    asked,
    resolveAgent: (_name, prompt) => ({ prompt }),
    exec: async (cmd) => {
      if (cmd.prompt === 'x') return '';
      asked.push(cmd.prompt);
      const pieces = cmd.prompt.slice(cmd.prompt.lastIndexOf('# Pieces')).split('\n')
        .map((l) => /^(\d+) \[[^\]]*\]: (.*)$/.exec(l)).filter(Boolean);
      return pieces.map(([, n, text]) => `${n}: ${answer(text)}`).join('\n');
    },
  };
}

const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };
const run = async (dir, args, agent = stubAgent(), extra = {}) => {
  const out = sink(); const err = sink();
  const code = await translateMain([join(dir, 'talk.html'), ...args], { out, err, ...agent, render: async () => ({ findings: [] }), ...extra });
  return { code, out: out.text, err: err.text };
};

test('a slide\'s units: its text, its beats, the words in its attributes and its diagrams; never its code', () => {
  const u = deckUnits(DECK);
  assert.deepEqual(u.deck, [{ kind: 'title', text: 'Ship it' }]);
  assert.deepEqual(u.slides[0], [
    { kind: 'run', text: 'Ship on Friday' }, { kind: 'run', text: 'Three & things' }, { kind: 'run', text: 'changed' },
    { kind: 'beat', text: 'We ship on Friday. [pause] Here is why.' }, { kind: 'beat', text: 'First, the tests.' },
    { kind: 'attr', text: 'Intro' }, { kind: 'attr', text: 'A rocket' },
  ]);
  assert.deepEqual(u.slides[1].map((x) => `${x.kind}:${x.text}`),
    ['run:Plan', 'attr:Foundation', 'attr:Fresh context', 'attr:Latency', 'label:Agent', 'label:old', 'label:new', 'label:p50']);
  assert.ok(!u.slides.flat().some((x) => /npm run build/.test(x.text)), 'code is never a unit');
});

test('the translation is the source with its words replaced, its language set and its source named', () => {
  const m = matchRecord(deckUnits(DECK), emptyRecord('talk.html', 'en', 'fr'));
  for (const x of [...m.deck, ...m.slides.flat()]) Object.assign(x, { status: 'translated', target: `FR:${x.text}`, state: 'machine' });
  const { html } = renderTranslation(DECK, m, { lang: 'fr', sourceName: 'talk.html' });
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<title>FR:Ship it<\/title>/);
  assert.match(html, /"translationOf": "talk.html"/);
  assert.match(html, /<li>FR:Three &amp; things<\/li>/);
  assert.match(html, /data-steps="FR:Foundation, FR:Fresh context"/);
  assert.match(html, /<pre><code>npm run build<\/code><\/pre>/, 'code as it was');
  assert.match(html, /FR:We ship on Friday\. \[pause\] Here is why\.\n\s*\[click\]\n\s*FR:First, the tests\./, 'the beats, cut where they were');
  assert.match(html, /"dashFrom":"FR:new"/, 'a chart\'s reference follows its label');
  assert.equal(slideUnits(html.split('<section')[1]).length, deckUnits(DECK).slides[0].length);
});

test('a language written right to left is marked so', () => {
  assert.equal(isRtl('ar'), true);
  assert.equal(isRtl('he-IL'), true);
  assert.equal(isRtl('fr'), false);
  const m = matchRecord(deckUnits(DECK), emptyRecord('talk.html', 'en', 'ar'));
  assert.match(renderTranslation(DECK, m, { lang: 'ar', sourceName: 'talk.html' }).html, /<html lang="ar" dir="rtl">/);
});

test('a first run writes the translation and its record, and names the language in the source', async (t) => {
  const dir = folder(t);
  const agent = stubAgent();
  const r = await run(dir, ['--to', 'fr'], agent);
  assert.equal(r.code, 0, r.err);
  assert.equal(agent.asked.length, 4, 'the title, and one ask per slide');
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  assert.match(fr, /<h2>FR:Ship on Friday<\/h2>/);
  const rec = JSON.parse(readFileSync(join(dir, 'talk.fr.translation.json'), 'utf8'));
  assert.equal(rec.lang, 'fr');
  assert.equal(rec.from, 'en');
  assert.equal(rec.slides.length, 3);
  assert.deepEqual(rec.slides[0][0], { kind: 'run', state: 'machine', source: 'Ship on Friday', target: 'FR:Ship on Friday' });
  assert.match(readFileSync(join(dir, 'talk.html'), 'utf8'), /"languages": \["fr"\]/);
  assert.deepEqual(knownLanguages(join(dir, 'talk.html'), readFileSync(join(dir, 'talk.html'), 'utf8')), ['fr']);
  assert.match(r.out, /up to date/);
});

test('a second run asks for nothing that did not change, and a slide moved in the source costs nothing', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const again = stubAgent();
  assert.equal((await run(dir, [], again)).code, 0);
  assert.equal(again.asked.length, 0);
  // move slide 3 before slide 2
  const parts = DECK.split('<section');
  const moved = [parts[0], parts[1], parts[3].replace('</div></body></html>', ''), parts[2].replace(/\n<\/div><\/body><\/html>$/, '')].join('<section') + '\n</div></body></html>';
  writeFileSync(join(dir, 'talk.html'), moved.replace('{ "decklight": "0.9.0" }', '{ "decklight": "0.9.0", "languages": ["fr"] }'));
  const third = stubAgent();
  assert.equal((await run(dir, [], third)).code, 0);
  assert.equal(third.asked.length, 0, 'moved, not reworded');
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  assert.ok(fr.indexOf('FR:Context') < fr.indexOf('FR:Plan'), 'the translation follows the source\'s order');
});

function legacyTitle(words, label = words) {
  let i = 0;
  const spans = words.split(' ').map((word) => {
    const letters = [...word].map((c) => `<span class="cf-ch" style="--i:${i++}">${c}</span>`).join('');
    i++;
    return `<span class="cf-w" aria-hidden="true">${letters}</span>`;
  });
  return `<h2 class="headline cf-write cf-write-out" data-slot="title" style="color:inherit; --n:${i - 1}" aria-label="${label}">${spans.join(' ')}</h2>`;
}

test('a plain animated title is translated as one run, even when its length and word count change', async (t) => {
  const dir = folder(t, DECK.replace('<h2>Ship on Friday</h2>', '<h2 data-write>The problem</h2>'));
  const target = 'Un vrai problème';
  const agent = stubAgent({ answer: (text) => text === 'The problem' ? target : `FR:${text}` });
  const first = await run(dir, ['--to', 'fr'], agent);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /on "The problem"/);
  const deck = join(dir, 'talk.fr.html');
  const file = join(dir, 'talk.fr.translation.json');
  const fr = readFileSync(deck, 'utf8');
  const rec = readFileSync(file, 'utf8');
  assert.match(fr, /<h2 data-write>Un vrai problème<\/h2>/);
  assert.deepEqual(JSON.parse(rec).slides[0].slice(0, 1), [
    { kind: 'run', state: 'machine', source: 'The problem', target },
  ]);
  assert.deepEqual(translationFindings(deck, fr, { finding }), []);
  const again = stubAgent();
  assert.equal((await run(dir, [], again)).code, 0);
  assert.deepEqual(again.asked, []);
  assert.equal(readFileSync(deck, 'utf8'), fr);
  assert.equal(readFileSync(file, 'utf8'), rec);
});

test('check --fix migrates a scrambled title and its old letter pairs alongside the source deck', async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, 'a.png'), '');
  await run(dir, ['--to', 'fr']);
  const deck = join(dir, 'talk.fr.html');
  const file = join(dir, 'talk.fr.translation.json');
  const srcPath = join(dir, 'talk.html');
  const src = readFileSync(srcPath, 'utf8').replace('<h2>Ship on Friday</h2>', legacyTitle('The problem'));
  writeFileSync(srcPath, src);
  const broken = legacyTitle('Lep roblème', 'Le problème').replace('>L</span>', '>Le</span>');
  const fr = readFileSync(deck, 'utf8').replace('<h2>FR:Ship on Friday</h2>', broken);
  writeFileSync(deck, fr);
  const sourceUnits = deckUnits(src).slides[0];
  const frenchUnits = deckUnits(fr).slides[0];
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.slides[0] = sourceUnits.map((u, i) => ({
    kind: u.kind, state: u.text === 'The problem' ? 'reviewed' : 'machine', source: u.text, target: frenchUnits[i].text,
  }));
  record.structure[0] = slideShape(fr.split('<section')[1]);
  writeFileSync(file, JSON.stringify(record));
  const check = (path, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../cli/check.mjs', import.meta.url)),
    path, '--no-render', '--json', ...args], { encoding: 'utf8' });
  const before = check(deck);
  assert.ok(JSON.parse(before.stdout).some((f) => f.rule === 'legacy-write' && f.title === 'Le problème'));
  const fixed = check(deck, '--fix');
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  assert.match(fixed.stderr, /converted 2 split-letter titles/);
  assert.match(readFileSync(srcPath, 'utf8'), /<h2 class="headline" data-slot="title" style="color:inherit" data-write="out">The problem<\/h2>/);
  const converted = readFileSync(deck, 'utf8');
  assert.match(converted, /data-write="out">Le problème<\/h2>/);
  assert.match(converted, /FR:Three &amp; things/);
  const migrated = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(migrated.slides[0][0], { kind: 'run', state: 'reviewed', source: 'The problem', target: 'Le problème' });
  assert.deepEqual(migrated.slides[1], record.slides[1]);
  assert.equal(migrated.structure[0], slideShape(converted.split('<section')[1]));
  assert.deepEqual(translationFindings(deck, converted, { finding }), []);
  const again = stubAgent();
  assert.equal((await run(dir, [], again)).code, 0);
  assert.deepEqual(again.asked, []);
  assert.equal(readFileSync(deck, 'utf8'), converted);
  assert.doesNotMatch(check(srcPath, '--fix').stderr, /converted/);
});

test('a reworded sentence is asked again with its previous translation, and only it', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const src = readFileSync(join(dir, 'talk.html'), 'utf8');
  writeFileSync(join(dir, 'talk.html'), src.replace('<li>changed</li>', '<li>changed a lot</li>'));
  const agent = stubAgent();
  const r = await run(dir, [], agent);
  assert.equal(r.code, 0, r.err);
  assert.equal(agent.asked.length, 1);
  assert.match(agent.asked[0], /# Previous translations[\s\S]*was "changed", translated "FR:changed"/);
  assert.match(agent.asked[0], /1 \[text\]: changed a lot\s*$/);
  assert.match(readFileSync(join(dir, 'talk.fr.html'), 'utf8'), /<li>FR:changed a lot<\/li>/);
});

test('a correction made in the translation is kept, counted as reviewed, and never re-asked while its source stands', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const frPath = join(dir, 'talk.fr.html');
  writeFileSync(frPath, readFileSync(frPath, 'utf8').replace('FR:Ship on Friday', 'Livraison vendredi'));
  const st = await run(dir, ['--status']);
  assert.match(st.out, /up to date · 1 of \d+ reviewed/);
  assert.match(st.out, /1 correction in talk\.fr\.html/);
  const agent = stubAgent();
  await run(dir, [], agent);
  assert.equal(agent.asked.length, 0);
  assert.match(readFileSync(frPath, 'utf8'), /Livraison vendredi/);
  const rec = JSON.parse(readFileSync(join(dir, 'talk.fr.translation.json'), 'utf8'));
  assert.deepEqual(rec.slides[0][0], { kind: 'run', state: 'reviewed', source: 'Ship on Friday', target: 'Livraison vendredi' });
});

test('--status and --check start no agent; --check fails while a language is behind', async (t) => {
  const dir = folder(t);
  const none = { resolveAgent: () => { throw new Error('no agent for a status'); }, exec: async () => { throw new Error('no'); } };
  writeFileSync(join(dir, 'talk.html'), DECK.replace('{ "decklight": "0.9.0" }', '{ "decklight": "0.9.0", "languages": ["fr"] }'));
  const st = await run(dir, ['--status'], none);
  assert.equal(st.code, 0);
  assert.match(st.out, /○ Français · fr {2}not translated yet/);
  assert.equal((await run(dir, ['--check'], none)).code, 1);
  await run(dir, []);
  assert.equal((await run(dir, ['--check'], none)).code, 0);
  writeFileSync(join(dir, 'talk.html'), readFileSync(join(dir, 'talk.html'), 'utf8').replace('<h2>Plan</h2>', '<h2>The plan</h2>'));
  const behind = await run(dir, ['--check'], none);
  assert.equal(behind.code, 1);
  assert.match(behind.out, /↑ Français · fr {2}behind: 1 changed on "The plan"/);
});

test('--no-agent: the structure catches up, a missing sentence shows the source\'s words, and stays behind', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  writeFileSync(join(dir, 'talk.html'), readFileSync(join(dir, 'talk.html'), 'utf8').replace('<h2>Context</h2>', '<h2>Context</h2><p>A new line</p>'));
  const r = await run(dir, ['--no-agent'], { resolveAgent: () => null, exec: async () => null });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 piece still behind/);
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  assert.match(fr, /<h2>FR:Context<\/h2><p>A new line<\/p>/);
  const rec = JSON.parse(readFileSync(join(dir, 'talk.fr.translation.json'), 'utf8'));
  assert.equal(rec.slides[2].find((u) => u.source === 'A new line').state, 'pending');
  const agent = stubAgent();
  await run(dir, [], agent);
  assert.equal(agent.asked.length, 1, 'the next run with an agent asks for it');
  assert.match(readFileSync(join(dir, 'talk.fr.html'), 'utf8'), /<p>FR:A new line<\/p>/);
});

test('a translation changed in more than its words is not overwritten without --discard-structure', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const frPath = join(dir, 'talk.fr.html');
  writeFileSync(frPath, readFileSync(frPath, 'utf8').replace('<h2>FR:Plan</h2>', '<h2 class="big">FR:Plan</h2>'));
  const r = await run(dir, []);
  assert.equal(r.code, 2);
  assert.match(r.err, /talk\.fr\.html, slide 2: it was changed in more than its words/);
  assert.match(readFileSync(frPath, 'utf8'), /class="big"/, 'left alone');
  assert.equal((await run(dir, ['--discard-structure'])).code, 0);
  assert.doesNotMatch(readFileSync(frPath, 'utf8'), /class="big"/);
});

test('an answer is written only when it passes its check', () => {
  const units = [{ kind: 'run', text: 'Ship on Friday' }, { kind: 'beat', text: 'We ship. [pause] Here is why.\n\nAgain.' }];
  const ok = new Map([[1, 'Livraison vendredi'], [2, 'Nous livrons. [pause] Voici pourquoi. ¶ Encore.']]);
  assert.equal(translateProblem(units, ok, { from: 'en', to: 'fr' }), null);
  assert.match(translateProblem(units, new Map([[1, 'x']]), { to: 'fr' }), /skipped piece 2/);
  assert.match(translateProblem(units, new Map([...ok, [2, 'Nous livrons. Voici pourquoi. ¶ Encore.']]), { to: 'fr' }), /\[pause\]/);
  assert.match(translateProblem(units, new Map([...ok, [2, 'Nous livrons. [pause] Voici pourquoi. Encore.']]), { to: 'fr' }), /paragraph/);
  assert.match(translateProblem(units, new Map([...ok, [1, '<b>Livraison</b>']]), { to: 'fr' }), /markup/);
  assert.match(translateProblem([{ kind: 'run', text: 'The build is green' }], new Map([[1, 'La compilation est verte']]), { to: 'fr', glossary: { build: 'build' } }), /glossary says "build" is "build"/);
  assert.match(translateProblem([{ kind: 'run', text: 'Ship on Friday' }], new Map([[1, 'Ship on Friday']]), { from: 'en', to: 'ja' }), /script/);
  assert.equal(translateProblem([{ kind: 'run', text: 'Ship on Friday' }], new Map([[1, '金曜日に出荷']]), { from: 'en', to: 'ja' }), null);
});

test('the ask carries the glossary, the slide\'s other translations and the limits of a slide that did not fit', () => {
  const p = translatePrompt([{ kind: 'run', text: 'Ship', status: 'missing' }], {
    from: 'en', to: 'fr', glossary: { deck: 'présentation' }, done: [{ kind: 'run', text: 'Plan', target: 'Plan' }], limits: [12],
  });
  assert.match(p, /from English \(en\) into French \(fr\)/);
  assert.match(p, /- deck → présentation/);
  assert.match(p, /# Already translated on this slide[\s\S]*- Plan → Plan/);
  assert.match(p, /1 \[text, at most 12 characters\]: Ship/);
});

test('a slide that does not fit in the translation is asked again for shorter text', async (t) => {
  const dir = folder(t);
  let renders = 0;
  const agent = stubAgent({ answer: (text) => (/at most/.test(text) ? text : `FR:${text}`) });
  const shorter = [];
  const exec = async (cmd) => { if (/# Too long/.test(cmd.prompt)) shorter.push(cmd.prompt); return agent.exec(cmd); };
  const r = await run(dir, ['--to', 'fr'], { ...agent, exec }, {
    render: async () => ({ findings: renders++ === 0 ? [{ rule: 'overflow', slide: 1 }] : [] }),
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(shorter.length, 1);
  assert.match(shorter[0], /1 \[text, at most \d+ characters\]: Ship on Friday/);
  assert.match(r.out, /does not fit — asking for shorter text/);
});

test('a language is named by a tag a file can carry', () => {
  assert.equal(tagProblem('fr'), null);
  assert.equal(tagProblem('pt-BR'), null);
  assert.match(tagProblem('french!'), /not a language tag/);
  assert.match(tagProblem('../x'), /not a language tag/);
});

test('a translation given by mistake is translated from its source', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const out = sink(); const err = sink();
  const code = await translateMain([join(dir, 'talk.fr.html'), '--status'], { out, err, render: async () => ({ findings: [] }) });
  assert.equal(code, 0);
  assert.match(err.text, /is the French of talk\.html — translating from talk\.html/);
  assert.ok(existsSync(join(dir, 'talk.fr.translation.json')));
});

test('readBack and matchRecord on their own: what a status needs and nothing else', () => {
  const m = matchRecord(deckUnits(DECK), emptyRecord('talk.html', 'en', 'fr'));
  for (const x of [...m.deck, ...m.slides.flat()]) Object.assign(x, { status: 'translated', target: `FR:${x.text}`, state: 'machine' });
  const { html, structure } = renderTranslation(DECK, m, { lang: 'fr', sourceName: 'talk.html' });
  const rec = nextRecord(emptyRecord('talk.html', 'en', 'fr'), m, structure);
  const back = readBack(rec, html);
  assert.equal(back.corrected, 0);
  assert.deepEqual(back.structure, []);
  const st = languageStatus(matchRecord(deckUnits(DECK), back.record));
  assert.equal(st.up, true);
  assert.equal(st.reviewed, 0);
});

// ── decklight check on a deck's languages ────────────────────────────────────

import { translationFindings } from '../cli/translate-files.mjs';
const finding = (level, rule, slide, title, message) => ({ level, rule, slide, title, message });
const rules = (fs) => fs.map((f) => `${f.level}:${f.rule}:${f.slide ?? '-'}`);

test('check: a translation that is up to date says nothing, and nor does a deck with no languages', async (t) => {
  const dir = folder(t);
  assert.deepEqual(translationFindings(join(dir, 'talk.html'), DECK, { finding }), []);
  await run(dir, ['--to', 'fr']);
  for (const name of ['talk.html', 'talk.fr.html']) {
    assert.deepEqual(translationFindings(join(dir, name), readFileSync(join(dir, name), 'utf8'), { finding }), [], name);
  }
});

test('check: the source warns per language behind; the translation fails on each stale or missing piece', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const src = readFileSync(join(dir, 'talk.html'), 'utf8').replace('<h2>Plan</h2>', '<h2>The plan</h2>').replace('<h2>Context</h2>', '<h2>Context</h2><p>New</p>');
  writeFileSync(join(dir, 'talk.html'), src);
  const onSource = translationFindings(join(dir, 'talk.html'), src, { finding });
  assert.deepEqual(rules(onSource), ['warn:translation-behind:-']);
  assert.match(onSource[0].message, /French \(talk\.fr\.html\) is 2 pieces behind on "The plan", "Context": run decklight translate talk\.html/);
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  const onFr = translationFindings(join(dir, 'talk.fr.html'), fr, { finding });
  assert.deepEqual(rules(onFr), ['error:translation-stale:2', 'error:translation-missing:3']);
  assert.match(onFr[0].message, /such as "The plan" \(it shows its previous translation\)/);
});

test('check: a translation changed in more than its words, or in another language, fails', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  const restyled = fr.replace('<h2>FR:Plan</h2>', '<h2 class="big">FR:Plan</h2>');
  assert.deepEqual(rules(translationFindings(join(dir, 'talk.fr.html'), restyled, { finding })), ['error:translation-structure:2']);
  const relang = fr.replace('<html lang="fr">', '<html lang="de">');
  assert.deepEqual(rules(translationFindings(join(dir, 'talk.fr.html'), relang, { finding })), ['error:translation-lang:-']);
});

test('check: a language listed and never translated is a warning on the source', (t) => {
  const html = DECK.replace('{ "decklight": "0.9.0" }', '{ "decklight": "0.9.0", "languages": ["es"] }');
  const dir = folder(t, html);
  const f = translationFindings(join(dir, 'talk.html'), html, { finding });
  assert.deepEqual(rules(f), ['warn:translation-behind:-']);
  assert.match(f[0].message, /Spanish \(talk\.es\.html\) is listed in "languages" and not translated yet/);
});

// ── Languages…, the edit server's half ───────────────────────────────────────

import { structureRefusal, languagesList, markReviewed, registerTranslateRoutes, newlyBehind } from '../cli/edit-translate.mjs';
import { EventEmitter } from 'node:events';

test('a translation refuses the edits that change its structure, naming its source; its words stay open', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const fr = join(dir, 'talk.fr.html');
  assert.match(structureRefusal(fr, '/deck/edit/slide/layout').error, /talk.fr.html is the French of talk.html.*change the slides in talk.html/);
  assert.equal(structureRefusal(fr, '/deck/edit/slide/layout').source, 'talk.html', 'the file the refusal opens');
  assert.equal(structureRefusal(fr, '/deck/edit/element/text'), null);
  assert.equal(structureRefusal(fr, '/deck/edit/slide/notes'), null);
  assert.equal(structureRefusal(join(dir, 'talk.html'), '/deck/edit/slide/layout'), null, 'the source is refused nothing');
});

test('Languages… lists each language from either side, and a translation\'s unread slides', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const fromSource = languagesList(join(dir, 'talk.html'));
  assert.equal(fromSource.isTranslation, false);
  assert.deepEqual(fromSource.languages.map((l) => [l.lang, l.name, l.file, l.up]), [['fr', 'Français', 'talk.fr.html', true]]);
  const fromFr = languagesList(join(dir, 'talk.fr.html'));
  assert.equal(fromFr.isTranslation, true);
  assert.equal(fromFr.source, 'talk.html');
  assert.deepEqual(fromFr.unread.map((u) => u.slide), [1, 2, 3]);
  assert.equal(markReviewed(join(dir, 'talk.fr.html'), 2), 8);
  assert.deepEqual(languagesList(join(dir, 'talk.fr.html')).unread.map((u) => u.slide), [1, 3]);
});

test('a run from the panel is the command, its lines relayed as events', async (t) => {
  const dir = folder(t);
  const routes = new Map();
  const events = [];
  let argv = null;
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: () => {} } });
  registerTranslateRoutes(routes, { deckPath: join(dir, 'talk.html'), broadcast: (e, d) => events.push([e, d]), spawnRun: (args) => { argv = args; return child; } });
  let answer = null;
  routes.get('POST /deck/edit/translate')({ body: JSON.stringify({ to: ['fr'], slides: [2] }), json: (code, j) => { answer = [code, j]; } });
  assert.equal(answer[0], 200);
  assert.deepEqual(argv.slice(1), ['--to', 'fr', '--from-server', '--slides', '2']);
  routes.get('POST /deck/edit/translate')({ body: JSON.stringify({ to: ['fr'] }), json: (code, j) => { answer = [code, j]; } });
  assert.equal(answer[0], 409, 'one run at a time');
  child.stdout.emit('data', 'translate: French (talk.fr.html) — 3 pieces\n');
  child.emit('close', 0);
  assert.deepEqual(events.map(([, d]) => d.state), ['start', 'line', 'done']);
  assert.equal(events[1][1].text, 'French (talk.fr.html) — 3 pieces');
  routes.get('POST /deck/edit/translate')({ body: JSON.stringify({ to: ['../x'] }), json: (code, j) => { answer = [code, j]; } });
  assert.equal(answer[0], 400);
});

test('a save to the source that puts a language behind is told once', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const before = readFileSync(join(dir, 'talk.html'), 'utf8');
  const after = before.replace('<h2>Plan</h2>', '<h2>The plan</h2>');
  assert.deepEqual(newlyBehind(join(dir, 'talk.html'), before, after), [{ lang: 'fr', name: 'French', n: 1 }]);
  const further = after.replace('<h2>Context</h2>', '<h2>The context</h2>');
  assert.deepEqual(newlyBehind(join(dir, 'talk.html'), after, further), [], 'already behind: not told again');
});

// ── the language switch, and a deck that travels with its languages ─────────

import { languageRows, languageHref } from '../src/core/languages.js';
import { bundleMain } from '../cli/bundle.mjs';
import { mkdirSync } from 'node:fs';

/** The little of a document languageRows reads. */
const fakeDoc = (html) => ({
  documentElement: { getAttribute: () => /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1] ?? '' },
  querySelectorAll: () => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"[^>]*>/g)]
    .map(([, lang, href]) => ({ getAttribute: (a) => (a === 'hreflang' ? lang : href) })),
  querySelector: () => { const m = /<script type="application\/json" data-decklight-config>([\s\S]*?)<\/script>/.exec(html); return m ? { textContent: m[1] } : null; },
});

test('the switch lists the deck\'s languages from either side, the one on screen marked, and keeps the place', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr,de']);
  const src = readFileSync(join(dir, 'talk.html'), 'utf8');
  assert.deepEqual(languageRows(fakeDoc(src), '/x/talk.html').map((r) => [r.lang, r.href, r.here]),
    [['en', 'talk.html', true], ['fr', 'talk.fr.html', false], ['de', 'talk.de.html', false]]);
  const fr = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  assert.deepEqual(languageRows(fakeDoc(fr), '/x/talk.fr.html').map((r) => [r.lang, r.name, r.here]),
    [['en', 'English', false], ['fr', 'Français', true], ['de', 'Deutsch', false]]);
  assert.match(readFileSync(join(dir, 'talk.de.html'), 'utf8'), /hreflang="fr" href="talk\.fr\.html"/, 'every translation links every language');
  assert.equal(languageHref({ href: 'talk.fr.html' }, { slide: 4, step: 2 }, '?all'), 'talk.fr.html?all#/4/2');
  assert.deepEqual(languageRows(fakeDoc(DECK), '/x/talk.html'), [], 'a deck in one language has no switch');
});

test('bundle --languages: each language a file of its own beside the output, switching to the others; without it, one language and no switch', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  mkdirSync(join(dir, 'out'));
  const out = join(dir, 'out', 'site.html');
  const quiet = t.mock.method(process.stdout, 'write', () => true);
  try {
    await bundleMain([join(dir, 'talk.html'), '--languages', 'all', '-o', out]);
    await bundleMain([join(dir, 'talk.html'), '-o', join(dir, 'out', 'alone.html')]);
  } finally { quiet.mock.restore(); }
  const site = readFileSync(out, 'utf8');
  const siteFr = readFileSync(join(dir, 'out', 'site.fr.html'), 'utf8');
  assert.match(site, /"languages": \["fr"\]/);
  assert.match(siteFr, /<link rel="alternate" hreflang="en" href="site\.html" data-decklight-lang>/);
  assert.match(siteFr, /<link rel="alternate" hreflang="fr" href="site\.fr\.html" data-decklight-lang>/);
  assert.match(siteFr, /<h2>FR:Ship on Friday<\/h2>/);
  const alone = readFileSync(join(dir, 'out', 'alone.html'), 'utf8');
  assert.doesNotMatch(alone, /"languages": \[|data-decklight-lang/);
});

// ── voice, captions and video per language ───────────────────────────────────

import { cueMaxChars, subtitleCues, toVtt, concatArgs, iso639b, disclosureLine, withDisclosure } from '../tools/video.mjs';
import { piperVoiceFor, PIPER_DEFAULT_VOICE } from '../tools/tts-engines.mjs';
import { followTakes } from '../cli/translate.mjs';

test('captions are cut for the language: shorter, and by character, for one written without spaces', () => {
  assert.equal(cueMaxChars('fr'), 84);
  assert.equal(cueMaxChars('ja'), 26);
  assert.equal(cueMaxChars('zh-Hant'), 32);
  const jp = 'これはとても長い日本語の文で字幕の一行には収まりません'.repeat(2) + '。';
  const cues = subtitleCues([{ audio: 'a.wav', duration: 10, pad: 0 }], () => jp, () => 0, { max: cueMaxChars('ja') });
  assert.ok(cues.length > 1, 'split');
  for (const c of cues) for (const line of c.text.split('\n')) assert.ok(line.length <= 13, line);
  assert.match(toVtt([{ start: 0, end: 1, text: 'Bonjour' }], { lang: 'fr' }), /^WEBVTT\nLanguage: fr\n\n/);
});

test('a video says its language in its streams, and that an AI voice narrates it', () => {
  assert.equal(iso639b('fr-FR'), 'fre');
  assert.equal(iso639b('xx'), null);
  const args = concatArgs('in.txt', 'out.mp4', { lang: 'fr', audio: true, subtitles: 'subs.srt', comment: disclosureLine('elevenlabs', 'fr') });
  assert.deepEqual(args.slice(args.indexOf('-metadata:s:a:0'), args.indexOf('-metadata:s:a:0') + 2), ['-metadata:s:a:0', 'language=fre']);
  assert.ok(args.includes('-metadata:s:s:0'));
  assert.ok(args.includes('comment=Narration par une voix de synthèse (ElevenLabs)'));
  assert.ok(!concatArgs('in.txt', 'out.mp4', {}).includes('-metadata'), 'nothing said, nothing written');
  assert.equal(disclosureLine('piper', 'sw'), 'Narrated by an AI voice (Piper)');
  assert.match(withDisclosure('<section><h1>A</h1></section><section>B</section>', 'Narrated'), /^<section><h1>A<\/h1><p class="decklight-disclose" data-decklight-disclose>Narrated<\/p><\/section><section>B<\/section>$/);
});

test('piper reads a deck in its own language by default', () => {
  assert.equal(piperVoiceFor('fr'), 'fr_FR-siwis-medium');
  assert.equal(piperVoiceFor('de-AT'), 'de_DE-thorsten-high');
  assert.equal(piperVoiceFor(null), PIPER_DEFAULT_VOICE);
  assert.equal(piperVoiceFor('tlh'), PIPER_DEFAULT_VOICE, 'a language piper has no voice for keeps the default');
});

test('a slide moved in the source moves the language\'s takes at the run that moves it', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr']);
  const take = join(dir, 'voices-fr', 'amelie');
  mkdirSync(take, { recursive: true });
  writeFileSync(join(take, 'slide-01.wav'), 'one');
  writeFileSync(join(take, 'slide-02.wav'), 'two');
  const before = readFileSync(join(dir, 'talk.fr.html'), 'utf8');
  // swap slides 1 and 2 of the translation
  const p = before.split('<section');
  const swapped = [p[0], p[2].replace(/\s*$/, '\n'), p[1].replace(/\s*$/, '\n'), p[3]].join('<section');
  const said = followTakes(join(dir, 'talk.fr.html'), before, swapped, 'French');
  assert.match(said, /voices-fr\/amelie\/ followed their slides/);
  assert.equal(readFileSync(join(take, 'slide-01.wav'), 'utf8'), 'two');
  assert.equal(readFileSync(join(take, 'slide-02.wav'), 'utf8'), 'one');
});

test('the panel says the slides the last run left overflowing, and the takes the script moved away from', async (t) => {
  const dir = folder(t);
  await run(dir, ['--to', 'fr'], stubAgent(), { render: async () => ({ findings: [{ rule: 'overflow', slide: 2 }] }) });
  const rec = JSON.parse(readFileSync(join(dir, 'talk.fr.translation.json'), 'utf8'));
  assert.deepEqual(rec.overflow, [2], 'kept until the next run measures again');
  const take = join(dir, 'voices-fr', 'amelie');
  mkdirSync(take, { recursive: true });
  writeFileSync(join(take, 'slide-01.wav'), 'x');
  writeFileSync(join(take, 'manifest.json'), JSON.stringify({ engine: 'piper', lang: 'fr', slides: [{ file: 'slide-01.wav', hash: 'voiced-from-other-notes' }] }));
  const fr = languagesList(join(dir, 'talk.html')).languages[0];
  assert.deepEqual(fr.overflow, [2]);
  assert.match(fr.overflowPhrase, /FR:Plan/);
  assert.deepEqual(fr.staleTakes.slides, [1]);
  assert.equal(fr.staleTakes.tracks, 1);
});
