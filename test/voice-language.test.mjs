// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck's language reaches the voice (SPEC PRESENTING_VOICE): `<html lang>`
// is read from the file, told to the engines that take a language, is part of
// what a clip is when it was told, and picks the lip-sync recogniser and the
// places a caption breaks. English, and a deck that names no language, must
// behave exactly as before: every assertion on "unchanged" here is a recorded
// take somebody would otherwise pay to record again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deckLang } from '../tools/deck-html.mjs';
import { createEngine, voiceLang, chirpLocale, primaryLang } from '../tools/tts-engines.mjs';
import { createSynth, languageCode, DEFAULT_MODEL, KEY_ENV } from '../tools/elevenlabs-tts.mjs';
import { cacheKey, clipKey } from '../tools/tts-cache.mjs';
import { manifestHash } from '../tools/narration-manifest.mjs';
import { rhubarbArgs, rhubarbRecognizer } from '../tools/lipsync-engines.mjs';
import { splitSentences } from '../tools/sentences.mjs';
import { planServices } from '../cli/open.mjs';

test('deckLang reads <html lang>, however it is quoted, and null when there is none', () => {
  assert.equal(deckLang('<!doctype html>\n<html lang="fr">'), 'fr');
  assert.equal(deckLang('<html class="x" lang=\'pt-BR\' data-y>'), 'pt-BR');
  assert.equal(deckLang('<HTML LANG=de>'), 'de');
  assert.equal(deckLang('<html>'), null);
  assert.equal(deckLang('<html lang="">'), null);
  assert.equal(deckLang('<div class="decklight"><section lang="fr"></section></div>'), null, 'the language of a slide is not the deck\'s');
  assert.equal(deckLang(undefined), null);
});

test('voiceLang: the flag, then a deck that is not in English, then the saved language', () => {
  assert.equal(voiceLang({ flag: 'de-DE', deck: 'fr', saved: 'es' }), 'de-DE');
  assert.equal(voiceLang({ deck: 'fr', saved: 'es' }), 'fr');
  assert.equal(voiceLang({ deck: 'pt-BR' }), 'pt-BR');
  // `en` is what init writes into every deck: it does not outrank a choice
  assert.equal(voiceLang({ deck: 'en', saved: 'es-ES' }), 'es-ES');
  assert.equal(voiceLang({ deck: 'en-GB' }), undefined);
  assert.equal(voiceLang({ deck: null }), undefined);
  assert.equal(voiceLang(), undefined);
  assert.equal(primaryLang('fr-CA'), 'fr');
  assert.equal(primaryLang(''), null);
});

test('languageCode: two letters, not English, and only for a model that takes one', () => {
  assert.equal(languageCode(DEFAULT_MODEL, 'fr'), 'fr');
  assert.equal(languageCode(DEFAULT_MODEL, 'pt-BR'), 'pt');
  assert.equal(languageCode('eleven_flash_v2_5', 'de'), 'de');
  assert.equal(languageCode(DEFAULT_MODEL, 'en'), undefined);
  assert.equal(languageCode(DEFAULT_MODEL, 'en-GB'), undefined);
  assert.equal(languageCode(DEFAULT_MODEL, null), undefined);
  assert.equal(languageCode(DEFAULT_MODEL, 'cmn-CN'), undefined, 'not a two-letter code: sent nothing rather than a guess');
  assert.equal(languageCode('eleven_multilingual_v2', 'fr'), undefined);
});

/** An ElevenLabs with one voice that answers every synthesis with silence, and records every call. */
function fakeElevenLabs() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if ((init.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => ({ voices: [{ voice_id: 'v1', name: 'Amelie', category: 'premade' }] }), text: async () => '' };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array(4800).buffer, text: async () => '' };
  };
  fetchImpl.posts = () => calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(c.init.body));
  return fetchImpl;
}

test('ElevenLabs is told the language of a deck that is not in English, and nothing otherwise', async () => {
  const fr = fakeElevenLabs();
  await createSynth({ key: 'k', lang: 'fr-FR', fetchImpl: fr }).synth('Six.', {});
  assert.equal(fr.posts()[0].language_code, 'fr');

  for (const opts of [{ lang: 'en' }, {}, { lang: 'fr', model: 'eleven_multilingual_v2' }]) {
    const f = fakeElevenLabs();
    await createSynth({ key: 'k', fetchImpl: f, ...opts }).synth('Six.', {});
    assert.ok(!('language_code' in f.posts()[0]), `no language_code for ${JSON.stringify(opts)}`);
  }
});

test('an engine says which language it was told, and only then', () => {
  const env = { [KEY_ENV]: 'k' };
  assert.equal(createEngine({ engine: 'elevenlabs', env, lang: 'fr' }).lang, 'fr');
  assert.equal(createEngine({ engine: 'elevenlabs', env, lang: 'en' }).lang, undefined);
  assert.equal(createEngine({ engine: 'elevenlabs', env }).lang, undefined);
  assert.equal(createEngine({ engine: 'elevenlabs', env, lang: 'fr', model: 'eleven_multilingual_v2' }).lang, undefined);
  assert.equal(createEngine({ engine: 'chirp', project: 'my-project', lang: 'fr' }).lang, 'fr-FR');
  assert.equal(createEngine({ engine: 'chirp', project: 'my-project', lang: 'fr-CA' }).lang, 'fr-CA');
  assert.equal(createEngine({ engine: 'chirp', project: 'my-project' }).lang, undefined);
  assert.equal(createEngine({ engine: 'chirp', project: 'my-project', lang: 'en-US' }).lang, undefined);
});

test('chirpLocale: a bare language gets a region, a full tag is taken at its word, an unknown one is refused', () => {
  assert.equal(chirpLocale('fr'), 'fr-FR');
  assert.equal(chirpLocale('zh'), 'cmn-CN');
  assert.equal(chirpLocale('pt_pt'), 'pt-PT');
  assert.equal(chirpLocale('cmn-cn'), 'cmn-CN');
  assert.equal(chirpLocale(undefined), 'en-US');
  assert.throws(() => chirpLocale('xx'), /chirp needs a locale for the language 'xx'/);
});

test('a clip told no language hashes as it always has; told one, it is a different clip', () => {
  const f = { engine: 'elevenlabs', model: 'm', format: 'wav', voice: 'v', style: 's', text: 'Six.' };
  // the formula before a language existed, spelled out: these bytes are the
  // name of every clip already on disk and every hash in every manifest
  const before = createHash('sha256')
    .update([f.engine, f.model, f.format, f.voice, f.style, f.text].join('\u0000')).digest('hex');
  assert.equal(cacheKey(f), before);
  assert.equal(cacheKey({ ...f, lang: undefined }), before);
  assert.equal(cacheKey({ ...f, lang: '' }), before);
  assert.notEqual(cacheKey({ ...f, lang: 'fr' }), before);
  assert.notEqual(cacheKey({ ...f, lang: 'fr' }), cacheKey({ ...f, lang: 'es' }));

  const env = { [KEY_ENV]: 'k' };
  const ask = { voice: 'Amelie', text: 'Six.' };
  const plain = clipKey(createEngine({ engine: 'elevenlabs', env }), ask);
  assert.equal(clipKey(createEngine({ engine: 'elevenlabs', env, lang: 'en' }), ask), plain);
  assert.notEqual(clipKey(createEngine({ engine: 'elevenlabs', env, lang: 'fr' }), ask), plain);
});

test('a manifest hash follows its header: no lang, the old hash; a lang, its own', () => {
  const header = { engine: 'elevenlabs', model: DEFAULT_MODEL, voice: 'Amelie', style: undefined };
  const old = manifestHash(header, 'Six.');
  assert.equal(manifestHash({ ...header, lang: undefined }, 'Six.'), old);
  assert.notEqual(manifestHash({ ...header, lang: 'fr' }, 'Six.'), old);
});

test('decklight <deck> starts the voice bridge in the language of the deck', () => {
  const env = { [KEY_ENV]: 'k' };
  const plan = (extra) => planServices({ args: ['deck.html', '--tts-engine', 'elevenlabs'], env, hasBin: () => false, ...extra });
  const tts = (p) => p.run.find((s) => s.name === 'tts')?.args.join(' ');

  assert.equal(tts(plan({ deckLanguage: 'fr' })), 'tts --port 8787 --engine elevenlabs --lang fr');
  // English and no language: the plan is the one it always was
  assert.equal(tts(plan({ deckLanguage: 'en' })), 'tts --port 8787 --engine elevenlabs');
  assert.equal(tts(plan({})), 'tts --port 8787 --engine elevenlabs');
  // a saved language is the bridge's own to read; an English deck does not override it
  assert.equal(tts(plan({ deckLanguage: 'en', saved: { lang: 'es-ES' } })), 'tts --port 8787 --engine elevenlabs');
  assert.equal(tts(plan({ deckLanguage: 'fr', saved: { lang: 'es-ES' } })), 'tts --port 8787 --engine elevenlabs --lang fr');
});

test('lip-sync hears a language that is not English by its sounds', () => {
  assert.equal(rhubarbRecognizer('fr'), 'phonetic');
  assert.equal(rhubarbRecognizer('ja-JP'), 'phonetic');
  assert.equal(rhubarbRecognizer('en'), null);
  assert.equal(rhubarbRecognizer('en-GB'), null);
  assert.equal(rhubarbRecognizer(undefined), null);
  const base = { wav: 'a.wav', dialogFile: 'a.txt', out: 'a.json' };
  assert.deepEqual(rhubarbArgs(base), ['-f', 'json', '-o', 'a.json', '--machineReadable', '--dialogFile', 'a.txt', 'a.wav'],
    'no language: the argv it always was');
  assert.deepEqual(rhubarbArgs({ ...base, lang: 'en' }), rhubarbArgs(base));
  assert.deepEqual(rhubarbArgs({ ...base, lang: 'fr' }), ['-f', 'json', '-o', 'a.json', '--machineReadable', '-r', 'phonetic', 'a.wav']);
  assert.deepEqual(rhubarbArgs({ wav: 'a.wav', out: 'a.json' }), ['-f', 'json', '-o', 'a.json', '--machineReadable', 'a.wav']);
});

test('a sentence takes its closing guillemet, and ends at full-width punctuation', () => {
  assert.deepEqual(splitSentences('Il a dit : « Non. » Puis il est parti ! Vraiment ?'),
    ['Il a dit : « Non. »', 'Puis il est parti !', 'Vraiment ?']);
  assert.deepEqual(splitSentences('« Non. » Et après ?'), ['« Non. »', 'Et après ?']);
  assert.deepEqual(splitSentences('これは一つ。これは二つ！「はい。」終わり'), ['これは一つ。', 'これは二つ！', '「はい。」', '終わり']);
  // English is cut where it always was
  assert.deepEqual(splitSentences('One. Two (three.) "Four!" five'), ['One.', 'Two (three.)', '"Four!"', 'five']);
  assert.deepEqual(splitSentences('He said "no." Then left… Really?'), ['He said "no."', 'Then left…', 'Really?']);
});
