#!/usr/bin/env node
/**
 * Headless verification of the character overlay (test/character.html drives
 * src/core/character.js with a stubbed bridge and a mock audio clock; this
 * script renders it in Chrome and checks the emitted
 * DECKLIGHT-CHARACTER-RESULTS JSON).
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResultsPage } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
runResultsPage(path.join(here, 'character.html'), 'CHARACTER');
