#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The whole program: work out what init should be told, then run the latest
// decklight to do it. `npm create <x>` always fetches the latest create-x, so
// this shim is never stale — which is the entire reason it exists: a bare
// `npx decklight` reuses whatever version npx unpacked the first time, and the
// README had to explain `@latest` to every newcomer.

import { spawnSync } from 'node:child_process';
import { initArgs, npxCommand } from './lib.mjs';

const { cmd, shell } = npxCommand();
const r = spawnSync(cmd, ['--yes', 'decklight@latest', ...initArgs(process.argv.slice(2))],
  { stdio: 'inherit', shell });
process.exit(r.status ?? 1);
