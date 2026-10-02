#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The whole program: work out what init should be told, then run the latest
// decklight to do it. `decklight@latest` is a tag, which npx re-resolves
// against the registry on every run — so a decklight installed in the project
// or globally (which a bare `npx decklight` would run, however old) never
// stands in for the current release. The shim gives `npm create`, the idiom
// people already know, that guarantee and the folder-names-the-title shorthand.

import { spawnSync } from 'node:child_process';
import { childEnv, initArgs, npxCommand } from './lib.mjs';

const { cmd, shell } = npxCommand();
const r = spawnSync(cmd, ['--yes', 'decklight@latest', ...initArgs(process.argv.slice(2))],
  { stdio: 'inherit', shell, env: childEnv() });
process.exit(r.status ?? 1);
