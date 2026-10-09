// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The commit window's other half (SPEC PRESENTING): uncommitted work cut into
// several commits, a tag on what was committed, and a push of it.
//
// SEVERAL COMMITS OUT OF ONE FILE. A deck is one file, so "these edits are two
// commits" means committing part of a file, which `git add -- <deck>` cannot
// do. The work is cut into UNITS: each hunk of the deck's diff against HEAD
// (at zero context, so two edits on one slide are two hunks), and each other
// file that rides the deck's commits (the review sidecar, the .gitattributes
// decklight wrote) whole. A plan is a list of commits, each a subject and the
// units it takes. Commit k's deck is HEAD's deck with the units of commits
// 1..k applied, so the last commit's deck is the working file, byte for byte.
//
// BUILT ASIDE, LANDED ONCE. The commits are made with plumbing in a private
// index (read-tree HEAD, update-index, write-tree, commit-tree), never the
// author's: whatever else they have staged stays staged. The branch moves
// once, from the HEAD the plan was made on to the last commit, with
// update-ref's old-value check, so a failure halfway leaves nothing behind
// and a HEAD that moved in the meantime is refused rather than overwritten.
// commit-tree runs no hooks, which is the same thing the snapshot already
// does; the one-commit path (gitAutocommit) still runs them.
//
// A PLAN IS FOR THE WORK IT WAS MADE ON. Its `base` is a fingerprint of HEAD
// and of every unit; committing re-reads both and refuses a plan whose work
// changed under it (an edit landed while the agent was thinking), because
// unit 3 of one diff is not unit 3 of another.

import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { agentAsk } from './agents.mjs';
import { ASK_TIMEOUT_MS, ask, deckOutline, deckTitle, reviewSubject } from './commit-message.mjs';
import { GIT_MAX_BUFFER, classifyRemoteError, commitSubject, isIdentityError, noPromptEnv, oneline, remoteState } from './git.mjs';

/** Past this many hunks, the hunks of one slide travel together. */
export const MAX_UNITS = 40;

/** How long a push may take before it is called offline. */
export const PUSH_TIMEOUT_MS = 60_000;

/** git, untrimmed: a diff's last line may end in the very spaces it changed. */
const raw = (args, cwd, { input, env } = {}) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, input, env,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
});
const run = (args, cwd, opts) => raw(args, cwd, opts).trim();

/**
 * The `-U0` hunks of one file's diff, each `{ oldStart, oldCount, newStart,
 * newCount, add, text }`. Pure. Null when the diff has a "No newline" marker:
 * those hunks do not splice by line, so the file goes as one unit instead.
 */
export function parseZeroHunks(diff) {
  const out = [];
  let cur = null;
  for (const line of String(diff ?? '').split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      cur = {
        oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]),
        add: [], text: [line],
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\\')) return null;
    if (line.startsWith('+')) { cur.add.push(line.slice(1)); cur.text.push(line); }
    else if (line.startsWith('-')) cur.text.push(line);
  }
  return out;
}

/**
 * `text` with the chosen hunks of its `-U0` diff applied. Pure. Every hunk is
 * in the old file's coordinates, so they are spliced from the bottom up and
 * none moves another.
 */
export function applyHunks(text, hunks) {
  const lines = String(text).split('\n');
  for (const h of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    // -a,0 is an insertion AFTER line a; -a,b replaces lines a..a+b-1
    const at = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    lines.splice(at, h.oldCount, ...h.add);
  }
  return lines.join('\n');
}

const slidesAt = (outline, from, count) => {
  const last = from + Math.max(count, 1) - 1;
  return outline.filter((s) => s.from <= last && s.to >= from).map((s) => s.index);
};

/** "slide 3", "slides 3-4", "slides 2, 5", or where a change outside any slide is. */
export function whereLabel(slides) {
  if (!slides.length) return 'theme or metadata';
  if (slides.length === 1) return `slide ${slides[0]}`;
  const run_ = slides.every((s, i) => i === 0 || s === slides[i - 1] + 1);
  return run_ ? `slides ${slides[0]}-${slides[slides.length - 1]}` : `slides ${slides.join(', ')}`;
}

/**
 * The uncommitted work, as units: `{ head, base, units, files }` or null when
 * there is no HEAD to cut against (a first commit is one commit). Each unit is
 * `{ id, file, whole, hunks, slides, where, lines, diff }`; `files` maps each
 * file to `{ head, work, mode }`.
 */
export function workingUnits({ cwd, deckRel, also = [] }) {
  let head;
  try { head = run(['rev-parse', '--verify', 'HEAD'], cwd); } catch { return null; }
  const units = [];
  const files = {};
  const hash = createHash('sha1').update(head);
  const headText = (rel) => { try { return raw(['show', `HEAD:./${rel}`], cwd); } catch { return null; } };
  const modeOf = (rel) => {
    try { return run(['ls-tree', 'HEAD', '--', rel], cwd).split(/\s/)[0] || '100644'; } catch { return '100644'; }
  };

  for (const rel of [deckRel, ...also.filter(Boolean)]) {
    const abs = resolvePath(cwd, rel);
    if (!existsSync(abs)) continue;
    const work = readFileSync(abs, 'utf8');
    const before = headText(rel);
    if (before === work) continue;
    files[rel] = { head: before, work, mode: before === null ? '100644' : modeOf(rel) };
    hash.update(`\0${rel}\0`).update(work);
    let hunks = null;
    let diff = '';
    if (before !== null && rel === deckRel) {
      try { diff = raw(['diff', '--no-color', '--no-ext-diff', '--unified=0', 'HEAD', '--', rel], cwd); } catch { diff = ''; }
      hunks = parseZeroHunks(diff);
      // the hunks must rebuild the file exactly, or the file goes whole
      if (hunks && (!hunks.length || applyHunks(before, hunks) !== work)) hunks = null;
    }
    if (!hunks) {
      const n = work.split('\n').length;
      units.push({ file: rel, whole: true, hunks: [], slides: [], where: rel, lines: n, diff: before === null ? `(new file ${rel})` : `(${rel}, changed)` });
      continue;
    }
    const outline = deckOutline(work);
    let mine = hunks.map((h) => ({
      file: rel, whole: false, hunks: [h],
      slides: slidesAt(outline, h.newStart, h.newCount),
    }));
    // A deck rewritten wholesale is hundreds of hunks no agent should be
    // asked to sort: past MAX_UNITS, the hunks of one slide go together.
    if (mine.length > MAX_UNITS) {
      const by = new Map();
      for (const u of mine) {
        const key = u.slides.join(',') || '-';
        if (by.has(key)) by.get(key).hunks.push(...u.hunks);
        else by.set(key, { ...u, hunks: [...u.hunks] });
      }
      mine = [...by.values()];
    }
    for (const u of mine) {
      units.push({
        ...u,
        where: whereLabel(u.slides),
        lines: u.hunks.reduce((n, h) => n + h.oldCount + h.newCount, 0),
        diff: u.hunks.map((h) => h.text.join('\n')).join('\n'),
      });
    }
  }
  units.forEach((u, i) => { u.id = i + 1; });
  return { head, base: hash.digest('hex').slice(0, 16), units, files };
}

/**
 * What the agent is asked: these numbered changes, grouped into commits. Pure.
 * The answer is parsed line by line (`parsePlan`), so the format is spelled
 * out and nothing else is asked for.
 */
export function planPrompt({ deck, title = null, units, max = 24 * 1024 }) {
  let budget = max;
  const shown = [];
  for (const u of units) {
    const body = u.diff.length > budget ? `${u.diff.slice(0, Math.max(0, budget))}\n(…cut)` : u.diff;
    budget = Math.max(0, budget - body.length);
    shown.push(`[${u.id}] ${u.where}${u.whole ? '' : ` (${u.file})`}\n${body}`);
  }
  return [
    `These are the uncommitted changes to "${deck}", a Decklight deck (a single-file`,
    'HTML presentation; one top-level <section> per slide), numbered.',
    ...(title ? [`The deck is titled "${title}".`] : []),
    '',
    'Group them into git commits, one commit per separate idea. Changes that are',
    'one idea go in one commit; if they are all one idea, reply with ONE commit.',
    'Order the commits so each one makes sense after the ones before it.',
    '',
    'Reply with one line per commit and nothing else, in this exact form:',
    '  <change numbers, comma-separated> | <subject>',
    'for example:',
    '  1, 3 | shorten the agent slide to one claim',
    '  2 | add a closing slide with the three takeaways',
    '',
    'Rules for each subject: at most 72 characters, no quotes, no trailing period;',
    'say what changed for the talk, naming a slide by its own words, never by its',
    'number. Every change number appears in exactly one commit.',
    '',
    ...shown,
  ].join('\n');
}

/** `[{ units: [ids], subject }]` from the agent's lines. Pure. */
export function parsePlan(answer) {
  const out = [];
  for (const line of String(answer ?? '').split('\n')) {
    const m = /^\s*[-*]?\s*\[?((?:\d+\s*,?\s*)+)\]?\s*[|:]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ids = m[1].split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isInteger);
    if (ids.length && m[2]) out.push({ units: ids, subject: m[2].replace(/^["'`]|["'`]$/g, '') });
  }
  return out;
}

/**
 * A plan every unit is in exactly once. Pure. A unit the agent named twice
 * stays with the first commit that named it; one it forgot joins the commit
 * of the unit before it (the change it sits beside), or the first commit.
 * Commits left with nothing are dropped.
 */
export function normalizePlan(groups, units) {
  const ids = units.map((u) => u.id);
  const owner = new Map();
  const plan = groups.map((g) => ({ subject: g.subject, units: [] }));
  plan.forEach((g, i) => {
    for (const id of groups[i].units) {
      if (ids.includes(id) && !owner.has(id)) { owner.set(id, i); g.units.push(id); }
    }
  });
  if (!plan.length) plan.push({ subject: '', units: [] });
  let last = 0;
  for (const id of ids) {
    if (owner.has(id)) { last = owner.get(id); continue; }
    owner.set(id, last);
    plan[last].units.push(id);
  }
  for (const g of plan) g.units.sort((a, b) => a - b);
  return plan.filter((g) => g.units.length);
}

/** The added lines of a file that rides the deck (an append-only sidecar), as a diff. */
const addedLines = (f) => {
  const fresh = f.head !== null && f.work.startsWith(f.head) ? f.work.slice(f.head.length) : f.work;
  return fresh.split('\n').filter(Boolean).map((l) => `+${l}`).join('\n');
};

/**
 * The commits "write them for me" proposes: `{ work, commits }`, where
 * `commits` is `[{ subject, units }]`, or `{ work, commits: null }` when there
 * is nothing to cut (no HEAD: a first commit is one commit; nothing changed).
 *
 * The files that ride the deck are not the agent's to describe: the review
 * sidecar's records say what they are (reviewSubject), so they are one commit
 * of their own with that subject, and a .gitattributes decklight wrote goes
 * with them. Only the deck's hunks are sent to the agent, and only on the
 * click that asked for it. An agent that answers nothing usable leaves the
 * deck as one commit with an empty subject, for the author to write.
 */
export async function planWorking({
  cwd, deckPath, deckRel, also = [], agent = null, env = process.env,
  timeoutMs = ASK_TIMEOUT_MS, exec = ask, resolve = agentAsk, read = readFileSync,
}) {
  const work = workingUnits({ cwd, deckRel, also });
  if (!work || !work.units.length) return { work, commits: null };
  const deckUnits = work.units.filter((u) => u.file === deckRel);
  const rest = work.units.filter((u) => u.file !== deckRel);
  const commits = [];
  if (deckUnits.length) {
    let groups = [];
    let html = '';
    try { html = read(deckPath, 'utf8'); } catch { /* the title is optional */ }
    const spawned = resolve(agent, planPrompt({ deck: deckRel, title: deckTitle(html), units: deckUnits }), { env });
    if (spawned) {
      let answer = null;
      try { answer = await exec(spawned, cwd, timeoutMs); } catch { answer = null; }
      groups = parsePlan(answer);
    }
    commits.push(...normalizePlan(groups, deckUnits).map((g) => ({ subject: g.subject, units: g.units })));
  }
  if (rest.length) {
    const side = rest.map((u) => reviewSubject(addedLines(work.files[u.file]))).find(Boolean);
    commits.push({ subject: side ?? '', units: rest.map((u) => u.id) });
  }
  return { work, commits };
}

/** A unit as the window shows it: no hunk bodies, which can be large. */
export const unitSummary = (u) => ({ id: u.id, file: u.file, where: u.where, lines: u.lines, slides: u.slides });

/** A commit-tree that falls back to a stand-in identity, like gitAutocommit. */
function commitTree(cwd, tree, parent, message, env) {
  const args = ['commit-tree', tree, '-p', parent, '-m', message];
  try { return run(args, cwd, { env }); } catch (e) {
    if (!isIdentityError(e)) throw e;
    return run(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost', ...args], cwd, { env });
  }
}

/**
 * Make the plan's commits on top of HEAD. `commits` is `[{ message, units }]`;
 * `work` is what `workingUnits` returned when the plan was made. Resolves to
 * `{ ok: true, shas, subjects }`, or `{ ok: false, code, error }` with code
 * STALE when the work or HEAD moved since.
 */
export function commitPlan({ cwd, deckRel, also = [], base, commits, template }) {
  const now = workingUnits({ cwd, deckRel, also });
  if (!now || now.base !== base) {
    return { ok: false, code: 'STALE', error: 'the deck changed since these commits were proposed — write them again' };
  }
  const byId = new Map(now.units.map((u) => [u.id, u]));
  const plan = normalizePlan(
    (commits ?? []).map((c) => ({ subject: String(c?.message ?? ''), units: (c?.units ?? []).map(Number) })),
    now.units,
  );
  if (!plan.length) return { ok: false, code: 'EMPTY', error: 'nothing to commit' };
  const subjects = plan.map((g) => commitSubject(g.subject.trim() || template, template));

  const dir = mkdtempSync(join(tmpdir(), 'decklight-split-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    run(['read-tree', now.head], cwd, { env });
    const taken = new Set();
    let parent = now.head;
    const shas = [];
    plan.forEach((g, k) => {
      for (const id of g.units) taken.add(id);
      // every file this commit touches, at the state of commits 1..k
      for (const [rel, f] of Object.entries(now.files)) {
        const mine = now.units.filter((u) => u.file === rel && taken.has(u.id));
        if (!g.units.some((id) => byId.get(id).file === rel)) continue;
        const text = mine.some((u) => u.whole) ? f.work : applyHunks(f.head ?? '', mine.flatMap((u) => u.hunks));
        const blob = run(['hash-object', '-w', '--stdin', `--path=${rel}`], cwd, { input: text });
        run(['update-index', '--add', '--cacheinfo', `${f.mode},${blob},${rel}`], cwd, { env });
      }
      const tree = run(['write-tree'], cwd, { env });
      parent = commitTree(cwd, tree, parent, subjects[k], env);
      shas.push(parent);
    });
    // the one move, and only from the HEAD the plan was made on
    run(['update-ref', '-m', `decklight: ${plan.length} commits`, 'HEAD', parent, now.head], cwd);
    // the author's index now agrees with the new HEAD for these files, and
    // keeps everything else it had
    try { run(['reset', '-q', 'HEAD', '--', ...Object.keys(now.files)], cwd); } catch { /* status shows it; nothing is lost */ }
    return { ok: true, shas, subjects };
  } catch (e) {
    return { ok: false, code: 'GIT', error: oneline(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A tag name git accepts and that cannot be read as an option. */
export function tagNameProblem(name, cwd) {
  const v = String(name ?? '').trim();
  if (!v) return 'a tag needs a name';
  if (v.startsWith('-')) return 'a tag name cannot start with -';
  try { run(['check-ref-format', `refs/tags/${v}`], cwd); } catch { return `"${v}" is not a name git takes for a tag`; }
  return null;
}

/** An annotated tag on HEAD: `{ ok, tag, sha }` or `{ ok: false, code, error }`. */
export function tagHead(cwd, name) {
  const v = String(name ?? '').trim();
  const bad = tagNameProblem(v, cwd);
  if (bad) return { ok: false, code: 'BAD', error: bad };
  let sha;
  try { sha = run(['rev-parse', '--verify', 'HEAD'], cwd); } catch { return { ok: false, code: 'UNBORN', error: 'nothing is committed yet — commit first, then tag it' }; }
  try { run(['rev-parse', '--verify', '--quiet', `refs/tags/${v}`], cwd); return { ok: false, code: 'EXISTS', error: `the tag ${v} already exists` }; } catch { /* free */ }
  const args = ['tag', '-a', v, '-m', v, sha];
  try { run(args, cwd); } catch (e) {
    if (!isIdentityError(e)) return { ok: false, code: 'GIT', error: oneline(e) };
    try { run(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost', ...args], cwd); }
    catch (e2) { return { ok: false, code: 'GIT', error: oneline(e2) }; }
  }
  return { ok: true, tag: v, sha };
}

/** Tags pointing at HEAD, for the window to show what is already tagged. */
export function headTags(cwd) {
  try { return run(['tag', '--points-at', 'HEAD'], cwd).split('\n').filter(Boolean); } catch { return []; }
}

/**
 * Why a push was refused, in words a presenter can act on. Pure. The remote
 * having commits this branch does not is its own sentence, since it is the
 * common one and "unknown" helps nobody.
 */
export function pushError(e, s) {
  const text = String(e?.stderr || e?.message || e || '');
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) {
    return `${s.remote} has commits this branch does not — pull them first (git pull --ff-only), then push`;
  }
  switch (classifyRemoteError(e)) {
    case 'offline': return `${s.remote} did not answer — offline, or it took longer than a minute`;
    case 'denied': return `${s.remote} refused the credentials on this machine — push once from a terminal to set them up`;
    case 'gone': return `${s.remote} is not there any more (${s.url ?? 'its url'})`;
    default: return oneline(e);
  }
}

/**
 * Why there is nothing a push can do here, or null when it can go. Pure over
 * a `remoteState`.
 */
export function pushBlocked(s) {
  switch (s?.state) {
    case 'ok': case 'no-upstream': return null;
    case 'no-remote': return 'no remote to push to — git remote add origin <url>';
    case 'ambiguous-remote': return 'several remotes and none is called origin — push from a terminal to choose';
    case 'detached': return 'detached HEAD — there is no branch to push';
    case 'unborn': return 'nothing is committed yet';
    default: return 'git cannot say where this branch stands';
  }
}

/**
 * Push the branch, and the annotated tags on what it pushes (--follow-tags),
 * on a click and only then (git.mjs: never a push you did not ask for). No
 * prompt can hang it (noPromptEnv) and a minute is the bound. Resolves to
 * `{ ok, pushed, remote, branch }` or `{ ok: false, code, error }`; never rejects.
 */
export function pushBranch(cwd, { state = remoteState(cwd), timeoutMs = PUSH_TIMEOUT_MS, exec = execFile } = {}) {
  const blocked = pushBlocked(state);
  if (blocked) return Promise.resolve({ ok: false, code: 'BLOCKED', error: blocked });
  const args = state.state === 'no-upstream'
    ? ['push', '--follow-tags', '-u', state.remote, state.branch]
    : ['push', '--follow-tags'];
  return new Promise((resolve) => {
    exec('git', args, { cwd, env: noPromptEnv(), timeout: timeoutMs, encoding: 'utf8' }, (err, _out, stderr) => {
      if (err) { err.stderr = err.stderr || stderr; resolve({ ok: false, code: 'REMOTE', error: pushError(err, state) }); return; }
      resolve({ ok: true, pushed: true, remote: state.remote, branch: state.branch, args: args.join(' ') });
    });
  });
}
