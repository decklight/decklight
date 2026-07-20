// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Helpers shared by the CLI commands. Generic Node-CLI plumbing (argv reading,
// entry-point detection) lives in tools/args.mjs; this file is the pieces that
// are specific to *these* commands — the failure convention and the one HTML
// escape whose exact form is load-bearing.

/**
 * A command's stderr-and-exit failure. `makeFail('bundle')` returns a `fail`
 * that prints `decklight bundle: <msg>` and exits 1 — the shape every command
 * hand-rolled.
 */
export const makeFail = (cmd) => (msg) => {
  process.stderr.write(`decklight ${cmd}: ${msg}\n`);
  process.exit(1);
};

// Inline <script> content must never contain "</script" (terminates the tag)
// NOR "<!--" (flips the HTML tokenizer into script-data-escaped mode, after
// which closers mis-parse — marked's comment regexes contain it). "\/" is an
// identity escape everywhere. "<!--" is broken by rewriting the bang as a
// backslash-u0021 unicode escape, NOT as backslash-bang: the latter is fine
// in strings and flagless regexes but an INVALID escape inside u-flagged
// regexes — highlight.js composes its XML grammar's comment regex with /imu
// the first time a deck highlights language-html, which turned the old
// escape into a lazy SyntaxError. The unicode escape is valid in strings,
// templates, JSON, and regexes with or without the u flag.
export const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');
