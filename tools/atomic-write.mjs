// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One write that is either the whole file or none of it.
//
// `writeFileSync` truncates first and then copies: for the length of that copy
// the file on disk is a PREFIX of what it is becoming, and a crash, a full
// disk or a kill -9 in that window leaves it that way. The author server
// rewrites the deck on every keystroke-level edit — a note, a layout, an undo
// — so that window is open hundreds of times an authoring session, on the one
// file the whole talk is. A half-written deck is not a lost edit; it is a lost
// deck, and the version git has is an autosave old.
//
// So: write a sibling in the SAME directory, then rename it over the target.
// Rename is atomic within a filesystem, which is why the temp file cannot live
// in /tmp — a cross-device rename is a copy again, with the window back.
//
// This is also exactly the shape editors save in, which cli/edit.mjs's live
// reload already had to survive: it watches the DIRECTORY rather than the file
// for this reason (a path watch follows the inode a rename replaces). The temp
// name is deliberately not the deck's, so the watcher's `filename === deck`
// filter ignores the create and fires once, on the rename.

import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write `data` to `path` atomically: whole, or not at all.
 *
 * The temp sibling carries the pid and six random bytes, so two processes
 * writing the same file at once cannot land on the same staging name and
 * rename each other's half-written bytes into place. On any failure the temp
 * file is removed and the error rethrown — the target is untouched, and the
 * directory is not left holding litter that looks like a deck.
 */
export function writeFileAtomic(path, data) {
  const tmp = join(dirname(path), `${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    // force: the failure may BE that the temp file was never created, and a
    // cleanup that throws would replace the real error with its own.
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do about it */ }
    throw e;
  }
}
