// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck in another language has its own tracks (SPEC PRESENTING_VOICE):
// `talk.fr.html` beside `talk.html` is the same deck in French, the two count
// as one deck, and each sees, renumbers and writes only its own language's
// takes. A deck with no other language beside it must see what it always saw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deckFamily, trackLang, ownsTrack, tracksRoot, defaultTrackDir } from '../tools/deck-family.mjs';
import { aloneInFolder, voiceFolders } from '../tools/voice-renumber.mjs';
import { manifestTracks, faceFolders } from '../cli/narrate.mjs';
import { proposeTrack, liveLangNote } from '../src/core/narration.js';

const deck = (lang) => `<!doctype html>\n<html${lang ? ` lang="${lang}"` : ''}><body><div class="decklight"><section><h1>x</h1></section></div></body></html>`;

/** A folder of decks (`{ name: lang }`) and tracks (`{ rel: manifest|null }`), removed when the test ends. */
function folder(t, decks, tracks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-family-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, lang] of Object.entries(decks)) writeFileSync(join(dir, name), lang === false ? '<html lang="fr"><body>not a deck</body></html>' : deck(lang));
  for (const [rel, manifest] of Object.entries(tracks)) {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'slide-01.wav'), '');
    if (manifest) writeFileSync(join(dir, rel, 'manifest.json'), JSON.stringify({ slides: [{ file: 'slide-01.wav' }], ...manifest }));
  }
  return dir;
}

test('a file is another language of a deck when its name says so and its <html lang> agrees', (t) => {
  const dir = folder(t, { 'talk.html': 'en', 'talk.fr.html': 'fr', 'talk.pt-br.html': 'pt-BR', 'talk.old.html': 'en', 'talk.de.html': false, 'other.html': 'en' });
  const src = deckFamily(join(dir, 'talk.html'));
  assert.equal(src.lang, null);
  assert.deepEqual(src.members.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'talk.fr.html', lang: 'fr' }, { name: 'talk.pt-br.html', lang: 'pt-br' }]);

  const fr = deckFamily(join(dir, 'talk.fr.html'));
  assert.equal(fr.lang, 'fr');
  assert.deepEqual(fr.members.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'talk.html', lang: null }, { name: 'talk.pt-br.html', lang: 'pt-br' }]);

  // a name that only looks like a language: another deck, with no family
  assert.deepEqual(deckFamily(join(dir, 'talk.old.html')), { lang: null, members: [] });
  assert.deepEqual(deckFamily(join(dir, 'other.html')), { lang: null, members: [] });
});

test('a deck named for a language with no deck beside it to be the language of is on its own', (t) => {
  const dir = folder(t, { 'talk.fr.html': 'fr' });
  assert.deepEqual(deckFamily(join(dir, 'talk.fr.html')), { lang: null, members: [] });
  assert.equal(defaultTrackDir(join(dir, 'talk.fr.html')), 'voiceover');
});

test('a track says its language by its folder, else by its manifest', () => {
  assert.equal(trackLang('voices-fr/anna'), 'fr');
  assert.equal(trackLang('voices-pt-BR/me', { lang: 'en' }), 'pt-br');
  assert.equal(trackLang('voices/anna', { lang: 'fr-FR' }), 'fr-fr');
  assert.equal(trackLang('voices/anna', { engine: 'piper' }), null);
  assert.equal(trackLang('voiceover'), null);
  assert.equal(trackLang('voices-backup/anna'), null, 'not a language tag');
});

test('each file of a family owns the tracks in its language; the one with no language keeps the rest', () => {
  const src = { lang: null, members: [{ name: 'talk.fr.html', lang: 'fr' }] };
  const fr = { lang: 'fr', members: [{ name: 'talk.html', lang: null }] };
  assert.equal(ownsTrack(src, 'voices/anna'), true);
  assert.equal(ownsTrack(src, 'voices-fr/anna'), false);
  assert.equal(ownsTrack(src, 'voices/amelie', { lang: 'fr-FR' }), false);
  assert.equal(ownsTrack(src, 'voices-es/anna'), true, 'no Spanish file to own it: it stays where it was seen');
  assert.equal(ownsTrack(fr, 'voices-fr/anna'), true);
  assert.equal(ownsTrack(fr, 'voices/amelie', { lang: 'fr-FR' }), true);
  assert.equal(ownsTrack(fr, 'voices/anna'), false);
  assert.equal(ownsTrack(fr, 'voiceover'), false);
  // no family: everything, as before
  const alone = { lang: null, members: [] };
  for (const rel of ['voices/anna', 'voices-fr/anna', 'voiceover']) assert.equal(ownsTrack(alone, rel, { lang: 'fr' }), true);
  assert.equal(tracksRoot(src), 'voices');
  assert.equal(tracksRoot(fr), 'voices-fr');
});

test('the same deck in another language is not another deck in the folder', (t) => {
  const dir = folder(t, { 'talk.html': 'en', 'talk.fr.html': 'fr' });
  assert.equal(aloneInFolder(join(dir, 'talk.html')), true);
  assert.equal(aloneInFolder(join(dir, 'talk.fr.html')), true);
  const two = folder(t, { 'talk.html': 'en', 'talk.fr.html': 'fr', 'other.html': 'en' });
  assert.equal(aloneInFolder(join(two, 'talk.html')), false);
  assert.equal(aloneInFolder(join(two, 'talk.fr.html')), false);
});

test('a slide moved in one language renumbers that language\'s recordings only', (t) => {
  const tracks = {
    'voices/anna': { engine: 'piper' }, 'voices/me': null, voiceover: { engine: 'piper' },
    'voices-fr/amelie': { engine: 'elevenlabs', lang: 'fr' }, 'voices-fr/me': null, 'voices/lea': { engine: 'chirp', lang: 'fr-FR' },
  };
  const dir = folder(t, { 'talk.html': 'en', 'talk.fr.html': 'fr' }, tracks);
  assert.deepEqual(voiceFolders(join(dir, 'talk.html')), ['voiceover', 'voices/anna', 'voices/me']);
  assert.deepEqual(voiceFolders(join(dir, 'talk.fr.html')), ['voices-fr/amelie', 'voices-fr/me', 'voices/lea']);
  // a folder the deck's config names is its own, whatever it is called
  assert.deepEqual(voiceFolders(join(dir, 'talk.fr.html'), ['voices/anna']), ['voices-fr/amelie', 'voices-fr/me', 'voices/anna', 'voices/lea']);

  // the same folders beside one deck: all of them, as before
  const one = folder(t, { 'talk.html': 'en' }, tracks);
  assert.deepEqual(voiceFolders(join(one, 'talk.html')), Object.keys(tracks).sort());
});

test('narrate --check and --face take the deck\'s own language', (t) => {
  const dir = folder(t, { 'talk.html': 'en', 'talk.fr.html': 'fr' }, {
    'voices/anna': { engine: 'piper' }, 'voices-fr/amelie': { engine: 'elevenlabs', lang: 'fr' },
    voiceover: { engine: 'piper' }, 'voices-fr/voiceover': { engine: 'piper' },
  });
  assert.deepEqual(manifestTracks(dir, join(dir, 'talk.html')).sort(), ['voiceover', 'voices/anna']);
  assert.deepEqual(manifestTracks(dir, join(dir, 'talk.fr.html')).sort(), ['voices-fr/amelie', 'voices-fr/voiceover']);
  assert.equal(manifestTracks(dir).length, 4, 'with no deck named: every track, as before');

  assert.equal(defaultTrackDir(join(dir, 'talk.html')), 'voiceover');
  assert.equal(defaultTrackDir(join(dir, 'talk.fr.html')), 'voices-fr/voiceover');
  assert.deepEqual(faceFolders(join(dir, 'talk.html'), deck('en'), null), [join(dir, 'voiceover')]);
  assert.deepEqual(faceFolders(join(dir, 'talk.fr.html'), deck('fr'), null), [join(dir, 'voices-fr', 'voiceover')]);
});

test('a new take is proposed under the deck\'s own root', () => {
  assert.deepEqual(proposeTrack({ engine: 'elevenlabs', voice: 'Amelie', root: 'voices-fr' }, []),
    { dir: 'voices-fr/amelie', label: 'Amelie · elevenlabs' });
  assert.equal(proposeTrack({ mine: true, root: 'voices-fr' }, ['voices/me']).dir, 'voices-fr/me');
  assert.equal(proposeTrack({ mine: true, root: 'voices-fr' }, ['voices-fr/me']).dir, 'voices-fr/me-2');
  // no root: where it always went
  assert.equal(proposeTrack({ mine: true }, []).dir, 'voices/me');
});

test('the live voice\'s row says the language it is told, and when a deck not in English is told none', () => {
  assert.equal(liveLangNote('fr', 'fr'), ' · French');
  assert.equal(liveLangNote('fr-FR', 'fr'), ' · French (France)');
  assert.equal(liveLangNote(null, 'fr'), ' · not told the deck is French');
  assert.equal(liveLangNote(null, 'en'), '');
  assert.equal(liveLangNote(null, null), '');
});
