// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `--commit-messages` — an agent writes the subject decklight would otherwise
 * template (SPEC `PRESENTING`).
 *
 * The wall of `decklight: autosave deck.html` is the problem. It is what the
 * cadence has to say when nobody told it what changed, and after an afternoon
 * the H overlay is a column of the same sentence with no way to see what
 * happened when. An agent reading the diff can say `tighten the four-variables
 * build to one line per idea` instead.
 *
 * THE COMMIT LANDS FIRST, ALWAYS. Autocommit exists so a crash cannot cost you
 * an afternoon, and nothing here is allowed to weaken that: decklight commits
 * with its own template exactly as before, and the agent's subject arrives
 * afterwards as an amend. So a slow agent, a wedged agent, a missing agent, an
 * agent that answers a paragraph of prose — every one of those costs a
 * generically-worded commit, never a lost one.
 *
 * That ordering is also why the amend is safe. It rewrites one message, on the
 * tip commit, seconds old, that nothing has been built on: the guard refuses
 * the moment HEAD has moved or the commit has reached a remote.
 *
 * OPT-IN, and the reason is not cost. A diff of your deck goes to whichever
 * agent CLI is installed, and most of them are cloud-backed. decklight does not
 * infer that permission from what happens to be on PATH — the same rule
 * `lipsync --veo` follows for the one part of it that leaves the machine.
 */

import { execFile } from 'node:child_process';
import { basename, relative } from 'node:path';
import { agentAsk } from './agents.mjs';
import { commitSubject, git } from './git.mjs';

/** How much diff the agent is shown. */
export const MAX_DIFF = 24 * 1024;

/** How long it may take before the commit keeps the message it already has. */
export const ASK_TIMEOUT_MS = 45_000;

/**
 * The change a commit made to the deck, trimmed to something worth sending.
 *
 * `--unified=1` and a byte cap, because the unit here is a single-file HTML
 * deck: swapping a theme rewrites a 70 KB `<style>` block, and a bundled deck
 * carries its whole runtime inline. An unbounded diff would be most of a
 * megabyte of machine-generated CSS with the author's two edited sentences
 * somewhere inside it — slower, more expensive, and harder to summarise than
 * the same diff cut off.
 *
 * Truncation is SAID rather than hidden: an agent that knows it is seeing part
 * of a change writes a subject about the part it saw, instead of a confident
 * one about a change it never read.
 */
export function changeDiff(cwd, sha, deckRel, { max = MAX_DIFF, run = git } = {}) {
  const out = run(['show', '--format=', '--unified=1', sha, '--', deckRel], cwd) ?? '';
  if (out.length <= max) return { diff: out, truncated: false };
  return { diff: out.slice(0, max), truncated: true };
}

/**
 * What the agent is asked. Pure, so the wording is reviewable without an agent.
 *
 * Every constraint here exists because of how the answer is used: it goes
 * straight into `git commit --amend -m`, so it has to be ONE line, short
 * enough to survive `commitSubject`'s 72-character cap unmangled, and free of
 * the conversational framing every CLI adds by default. Asking for the bare
 * line is worth more than parsing one out afterwards.
 */
export function messagePrompt({ deck, diff, truncated, template }) {
  return [
    `Write the git commit subject for this change to "${deck}", a Decklight deck`,
    '(a single-file HTML presentation; one top-level <section> per slide).',
    '',
    'Rules:',
    '- ONE line. No body, no preamble, no quotes, no markdown, no trailing period.',
    '- At most 72 characters.',
    '- Say what changed and why it matters to the talk, not which lines moved.',
    '  "cut the pour-over slide down to one claim" — not "edit deck.html".',
    '- Describe the slides, not the HTML: a reader of this log is looking for a',
    '  moment in the deck, not a diff.',
    '- Reply with the subject line and nothing else.',
    '',
    truncated
      ? 'The diff below is TRUNCATED — describe only what you can see in it.'
      : 'The diff:',
    '',
    diff,
    '',
    `If the diff says nothing useful, reply with exactly: ${template}`,
  ].join('\n');
}

/**
 * The subject inside whatever the CLI printed.
 *
 * Agents are chatty and inconsistently so: some answer the bare line, some wrap
 * it in a code fence, some open with "Here's the commit message:". The rule is
 * the LAST non-empty line that is not obviously framing — last, because the
 * preamble comes first and the answer comes last, and because a CLI's own
 * trailing banner is stripped by the same filters that catch the preamble.
 *
 * Deliberately not clever. Anything this does not recognise falls through to
 * the caller's fallback, which is the templated subject the commit already has
 * — a wrong-but-confident subject is worse than a generic one.
 */
export function subjectFrom(raw) {
  const lines = String(raw ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*>]\s+/, '').trim())
    .filter(Boolean)
    // fences, banners, and the "here is your answer" line every CLI has
    .filter((l) => !/^```/.test(l))
    .filter((l) => !/^(here'?s?|sure|okay|certainly|the commit|commit message)\b/i.test(l))
    .filter((l) => !/^\[?(info|warn|error|debug)\]?[: ]/i.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  // strip surrounding quotes/backticks an agent added around the line itself
  const bare = last.replace(/^["'`]+|["'`]+$/g, '').replace(/\.$/, '').trim();
  return bare || null;
}

/**
 * Is `sha` still the tip, and still only here?
 *
 * The two conditions that make amending a message a formatting change rather
 * than a rewrite of history. If a commit landed in between — the agent flow's
 * own commit, a restore, a second cadence tick — the message we were about to
 * fix belongs to a commit that is no longer the one we are on, and rewriting
 * anything below the tip is not something this feature is allowed to do.
 */
export function amendable(cwd, sha, { run = git } = {}) {
  try {
    if (run(['rev-parse', 'HEAD'], cwd) !== sha) return false;
    // `--remotes` needs no upstream, and answers for a repo with no remote at
    // all — where nothing is pushed and every commit is fair game.
    return (run(['branch', '--remotes', '--contains', sha], cwd) ?? '') === '';
  } catch { return false; }
}

/** Replace the tip's subject, leaving its tree, author and date alone. */
export function amendSubject(cwd, sha, subject, { run = git } = {}) {
  if (!amendable(cwd, sha, { run })) return false;
  try {
    run(['commit', '--amend', '--only', '--no-edit', '-m', subject], cwd);
    return true;
  } catch { return false; }
}

/** Run the agent and resolve its stdout, or null. Never rejects. */
function ask(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = execFile(cmd.bin, cmd.args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // The agent is being asked a question about a diff it is given in the
        // prompt; it needs no input and a CLI that waits on one would otherwise
        // hang until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
      }, (err, stdout) => finish(err && !stdout ? null : String(stdout ?? '')));
    } catch { return finish(null); }
    child.on('error', () => finish(null));
  });
}

/**
 * Give commit `sha` a subject an agent wrote. Resolves to the new subject, or
 * null when anything at all did not work out.
 *
 * Asynchronous and unawaited by design — see the note at the top of the file.
 * The caller has already committed.
 */
export async function describeCommit({
  cwd, sha, deckPath, template, agent = null,
  env = process.env, timeoutMs = ASK_TIMEOUT_MS, run = git, exec = ask,
} = {}) {
  const deck = basename(deckPath);
  const cmd = agentAsk(agent, 'x', { env });
  if (!cmd) return null;
  // Checked BEFORE the agent is spawned as well as after: a commit that has
  // already been superseded is one whose message nobody will ever see, and
  // paying an agent to describe it would be the feature's own busywork.
  if (!amendable(cwd, sha, { run })) return null;

  let diff;
  try { diff = changeDiff(cwd, sha, relative(cwd, deckPath) || deck, { run }); }
  catch { return null; }
  if (!diff.diff.trim()) return null;

  const prompt = messagePrompt({ deck, template, ...diff });
  const spawned = agentAsk(agent, prompt, { env });
  if (!spawned) return null;
  // Caught, not propagated. This is called unawaited from the commit path, so
  // a rejection here would be an unhandled one — and the whole contract is that
  // a misbehaving agent costs a generic subject, never anything louder.
  let out;
  try { out = await exec(spawned, cwd, timeoutMs); }
  catch { return null; }
  if (out == null) return null;

  const found = subjectFrom(out);
  if (!found) return null;
  const subject = commitSubject(found, template);
  // The agent echoing the template back (the prompt's own escape hatch) is a
  // successful answer meaning "nothing worth saying" — and amending a message
  // to itself is a rewrite for no reason.
  if (subject === template) return null;
  return amendSubject(cwd, sha, subject, { run }) ? subject : null;
}

/** The startup line: what is on, who does it, and what leaves the machine. */
export function messagesLine(agentName) {
  return agentName
    ? `git: ${agentName} writes the commit subjects — the deck's diffs are sent to it`
    : 'git: --commit-messages needs an agent on PATH — subjects stay generic';
}
