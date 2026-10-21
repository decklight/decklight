// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * "Check for updates when decklight starts" (SPEC MARKETPLACES_SCREEN): the
 * one way a marketplace check runs without somebody pressing C.
 *
 * Opening a screen is not consent to reach the network, so the check never
 * ran by itself. This is the consent: a per-machine switch, off until the
 * author turns it on (O on the screen, `decklight marketplace auto-check on`),
 * kept in the registry beside the marketplaces it is about. While it is on,
 * an edit server that starts runs the same `decklight marketplace outdated
 * --json` that C runs (`git ls-remote`, nothing fetched, nothing written but
 * the answer), at most once in a window, never on the critical path: the
 * server starts and serves without waiting, the shape of cli/update-check.mjs.
 *
 * The answer is RECORDED (`~/.decklight/marketplace-check.json`): when it was
 * asked, each marketplace's state, and which offers the author dismissed, by
 * the commit they were offered. The screen's list starts from it, and the
 * deck offers what it found once, in a toast that names what the open deck
 * uses from a marketplace that moved. It only ever offers: an update is still
 * the author's, because it re-clones with their credentials and changes what
 * every deck on the machine is served.
 *
 * Every function takes the config home, so a test points it at a temp one.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { configHome, loadRegistry, saveRegistry } from './marketplace.mjs';

/** How long a recorded answer stands before a starting server asks again: a session's restarts ask once. */
export const AUTO_CHECK_WINDOW_MS = 12 * 60 * 60 * 1000;

export const checkRecordPath = (home = configHome()) => join(home, 'marketplace-check.json');

/** Is the switch on? An unreadable registry is a no: nothing runs that was not asked for. */
export function autoCheckOn(home = configHome()) {
  try { return loadRegistry(home).autoCheck === true; } catch { return false; }
}

/** Has the screen already asked, once, whether to turn it on? */
export function autoCheckOffered(home = configHome()) {
  try { return loadRegistry(home).autoCheckOffered === true; } catch { return true; }
}

/** Turn it on or off — and turning it either way means the question was answered. */
export function setAutoCheck(on, home = configHome()) {
  const reg = loadRegistry(home);
  reg.autoCheck = !!on;
  reg.autoCheckOffered = true;
  saveRegistry(reg, home);
  return reg.autoCheck;
}

/** The screen asked once; it does not ask again. */
export function markAutoCheckOffered(home = configHome()) {
  const reg = loadRegistry(home);
  if (reg.autoCheckOffered === true) return false;
  reg.autoCheckOffered = true;
  saveRegistry(reg, home);
  return true;
}

/** The recorded answer — `{ checkedAt, marketplaces, dismissed }` — or null when there is none. */
export function readCheckRecord(home = configHome()) {
  try {
    const r = JSON.parse(readFileSync(checkRecordPath(home), 'utf8'));
    if (!Number.isFinite(r?.checkedAt) || !Array.isArray(r?.marketplaces)) return null;
    return { checkedAt: r.checkedAt, marketplaces: r.marketplaces, dismissed: r.dismissed && typeof r.dismissed === 'object' ? r.dismissed : {} };
  } catch { return null; }
}

function writeRecord(rec, home) {
  mkdirSync(home, { recursive: true });
  writeFileAtomic(checkRecordPath(home), `${JSON.stringify(rec, null, 2)}\n`);
}

/**
 * Record what `outdated` answered. `all` is a check of every marketplace,
 * which is what the window measures; one marketplace's answer is folded into
 * the record without moving it. Dismissals are kept, and one for a
 * marketplace no longer registered goes with it.
 */
export function recordCheck(results, home = configHome(), { all = true, now = Date.now() } = {}) {
  const prev = readCheckRecord(home);
  const rows = new Map((all ? [] : prev?.marketplaces ?? []).map((r) => [r.name, r]));
  for (const r of results) rows.set(r.name, r);
  const marketplaces = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(marketplaces.map((r) => r.name));
  const dismissed = Object.fromEntries(Object.entries(prev?.dismissed ?? {}).filter(([n]) => names.has(n)));
  const rec = { checkedAt: all || !prev ? now : prev.checkedAt, marketplaces, dismissed };
  writeRecord(rec, home);
  return rec;
}

/** An update took a marketplace to `commit`: the record says so, and nothing is offered for it any more. */
export function noteUpdated(name, commit = null, home = configHome()) {
  const rec = readCheckRecord(home);
  const row = rec?.marketplaces.find((r) => r.name === name);
  if (!row) return false;
  Object.assign(row, { state: 'current', commit: commit ?? row.commit ?? null, remote: commit ?? row.remote ?? null, error: null });
  writeRecord(rec, home);
  return true;
}

/** The commit an offer is for — what Dismiss remembers. A local directory has none, so it is "changed on disk". */
const offerKey = (r) => r.remote ?? 'changed-on-disk';

/** Dismiss the offer for `name` at what it was offered at: the same commit is not offered again. */
export function dismissOffer(name, remote = null, home = configHome()) {
  const rec = readCheckRecord(home);
  if (!rec) return false;
  const row = rec.marketplaces.find((r) => r.name === name);
  rec.dismissed[name] = remote ?? (row ? offerKey(row) : 'changed-on-disk');
  writeRecord(rec, home);
  return true;
}

/** Should a starting server ask? Only with the switch on, and once in the window. */
export function autoCheckDue(home = configHome(), now = Date.now()) {
  if (!autoCheckOn(home)) return false;
  const rec = readCheckRecord(home);
  return !rec || now - rec.checkedAt >= AUTO_CHECK_WINDOW_MS;
}

/** "checked 3 min ago: 1 of 3 out of date" — the screen's summary line, and the server's startup one. */
export function checkSummary(rec, now = Date.now()) {
  if (!rec) return null;
  const s = Math.max(0, (now - rec.checkedAt) / 1000);
  const ago = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
  const behind = rec.marketplaces.filter((r) => r.state === 'behind' || r.state === 'unfetched').length;
  return `checked ${ago}: ${behind ? `${behind} of ${rec.marketplaces.length} out of date` : 'all up to date'}`;
}

/**
 * What the deck offers from the record: every marketplace found BEHIND (one
 * never fetched is not an update to something you have) whose offer was not
 * dismissed at this commit, with what the open deck uses from it. A check
 * asks where a ref points and reads no catalog, so it cannot say which
 * versions the update brings; what it can say is which of this deck's design
 * systems, themes and fonts come from there. Nothing while the switch is off.
 */
export async function autoCheckOffers(html = null, home = configHome()) {
  if (!autoCheckOn(home)) return [];
  const rec = readCheckRecord(home);
  if (!rec) return [];
  const uses = html ? await deckUses(html) : new Map();
  return rec.marketplaces
    .filter((r) => r.state === 'behind' && rec.dismissed[r.name] !== offerKey(r))
    .map((r) => {
      const used = uses.get(r.name) ?? [];
      return { name: r.name, commit: r.commit ?? null, remote: offerKey(r), local: !!r.local, uses: used, text: offerText(r, used) };
    });
}

/** "decklight-confluent has an update: this deck uses confluent-developer (design system) from it". */
export function offerText(r, uses = []) {
  const what = r.local ? 'has changed on disk' : 'has an update';
  if (!uses.length) return `${r.name} ${what}`;
  return `${r.name} ${what}: this deck uses ${uses.map((u) => `${u.name} (${u.kind})`).join(', ')} from it`;
}

/** Marketplace name → `[{ name, kind }]`, what the deck references from each. */
async function deckUses(html) {
  const [{ designSystemRefs }, { markedRefs }, { fontRefs }] = await Promise.all([
    import('./design-system-refs.mjs'), import('./theme-refs.mjs'), import('./font-refs.mjs'),
  ]);
  const out = new Map();
  const add = (refs, kind) => {
    for (const r of refs) {
      if (!out.has(r.marketplace)) out.set(r.marketplace, []);
      out.get(r.marketplace).push({ name: r.name, kind });
    }
  };
  try {
    add(designSystemRefs(html), 'design system');
    add(markedRefs(html), 'theme');
    add(fontRefs(html), 'font');
  } catch { /* a block that does not parse uses nothing */ }
  return out;
}

/**
 * The starting server's check: when it is due, `run(['outdated', '--json'])`
 * (the command C runs, as a child) and record the answer. Resolves to the
 * record, or null when nothing ran or it failed — silently, either way: an
 * unreachable source is a row on the screen, never a word at startup.
 */
export async function runAutoCheck({ run, home = configHome(), now = Date.now() } = {}) {
  if (!autoCheckDue(home, now)) return null;
  try {
    const out = await run(['outdated', '--json']);
    if (!out?.ok) return null;
    const parsed = JSON.parse(out.stdout);
    // the command recorded it too; recording it again keeps the dismissals either way
    return recordCheck(parsed.marketplaces ?? [], home, { now });
  } catch { return null; }
}
