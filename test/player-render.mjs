#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Headless verification of the terminal player (test/player.html drives a
 * mock Decklight; this script renders it in Chrome and checks the emitted
 * DECKLIGHT-PLAYER-RESULTS JSON).
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResultsPage } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
runResultsPage(path.join(here, 'player.html'), 'PLAYER');
