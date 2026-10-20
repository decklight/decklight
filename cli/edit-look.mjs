// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The routes that change how the deck LOOKS rather than what it says: the
// theme it opens in and whether the picker holds it to its brand's themes,
// and the three things a marketplace hands a deck to wear (themes, design
// systems, fonts), each listed from the cache and marked or dropped in the
// deck's config block (SPEC THEME_DISTRIBUTION, DESIGN_SYSTEMS, FONTS) — and
// the marketplaces themselves (SPEC MARKETPLACES_SCREEN): listed, checked,
// updated and added, every one of them through the `decklight marketplace`
// command it would be at a terminal.
//
// They came out of cli/edit.mjs because they are a family with one shape and
// one set of needs. Every one either lists what the cached catalogs offer
// against what the deck already references, or writes one entry into the
// config block as one undo entry; and between them they want six of editMain's
// bindings, none of them about git, agents, bridges or the export machinery
// that make up the rest of that server. The marketplace and reference modules
// they lean on are imported per request, as they always were, so the server
// still pays for none of them until somebody opens a picker.
//
// The import back to edit.mjs is avoided rather than repeated: nothing here
// needs edit.mjs's own transforms, so this module imports only leaf modules,
// and edit.mjs reaches it with a STATIC import for the reason
// cli/edit-slides.mjs gives (a dynamic one from inside editMain would wait on
// edit.mjs's top-level `await`).

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { oneline } from './git.mjs';
import { setDeckTheme, setDeckBrandThemesOnly } from './runtime-link.mjs';

/**
 * Put the look routes into `routes`, the table cli/edit.mjs dispatches on, and
 * hand it back.
 *
 * `ctx` is the whole of what these handlers may touch: `readDeck()` for the
 * current file; `applyEdit()` for the routes that are one text transform;
 * `writeDeck()` and `history` for the marks, which compute the next file
 * themselves (a mark may fetch, validate and record an install first) and so
 * record the undo entry and write it in two steps of their own; `broadcast`
 * for the in-place theme and brand-theme picks; and `quiet(html)`, which
 * tells the deck watcher that the next write of exactly these bytes updates
 * the page itself and must not reload it. `quiet` is a setter, not the
 * variable, because the watcher in editMain reads and clears it.
 * `deckPath` is where a relative marketplace path is read from, and
 * `marketplace(args)` runs `decklight marketplace <args…>` (a test hands in
 * its own); `addMarketplace(spec, ref)` is its `add` (with `--branch ref` when
 * one is given), kept apart because a test of the add door replaces only that.
 */
export function registerLookRoutes(routes, {
  readDeck, applyEdit, writeDeck, history, broadcast = () => {}, quiet = () => {},
  deckPath = null, marketplace = runMarketplace,
  addMarketplace = (spec, ref = null) => marketplace(['add', spec, ...(ref ? ['--branch', ref] : [])]),
}) {
  // The deck's theme (PRESENTING): in write mode a pick is the deck's, not
  // the viewer's — written the way this deck carries it (setDeckTheme), quiet
  // and in place like a layout pick, with a `theme` event for every other
  // page. One undo entry, so Z takes it back.
  function themeRoute({ body, json }) {
    const { theme, quiet: inPlace, from } = JSON.parse(body || '{}');
    if (typeof theme !== 'string' || !/^[\w-]+$/.test(theme)) return json(400, { ok: false, error: 'theme is a name' });
    let unwritable = false;
    const changed = applyEdit((html) => { const next = setDeckTheme(html, theme); if (next === null) unwritable = true; return next ?? html; });
    if (unwritable) return json(409, { ok: false, error: `this deck does not carry a theme the server can set to ${theme} — a bundle holds only the themes it embeds` });
    if (changed) {
      console.log(`  theme saved: ${theme}`);
      if (inPlace === true) {
        quiet(readDeck());
        broadcast('theme', { theme, from: typeof from === 'string' ? from.slice(0, 64) : null });
      }
    }
    return json(200, { ok: true, changed, inPlace: changed && inPlace === true, ...history.counts() });
  }
  /**
   * `POST /deck/edit/brand-themes` `{ only, quiet?, from? }`: whether the
   * picker holds this deck to its design systems' own themes (SPEC
   * BRAND_PALETTE) — the picker's *Show every theme* and *Only <brand>'s
   * themes* rows. Quiet and in place like a theme pick; every other page reloads.
   */
  function brandThemesRoute({ body, json }) {
    const { only, quiet: inPlace, from } = JSON.parse(body || '{}');
    if (typeof only !== 'boolean') return json(400, { ok: false, error: 'only is true or false' });
    let unwritable = false;
    const changed = applyEdit((html) => { const next = setDeckBrandThemesOnly(html, only); if (next === null) unwritable = true; return next ?? html; });
    if (unwritable) return json(409, { ok: false, error: 'this deck carries no configuration block to record it in — decklight upgrade --link <deck.html> gives it one' });
    if (changed) {
      console.log(`  brand themes only: ${only}`);
      if (inPlace === true) {
        quiet(readDeck());
        broadcast('styles', { slide: 1, index: 0, from: typeof from === 'string' ? from.slice(0, 64) : null });
      }
    }
    return json(200, { ok: true, changed, inPlace: changed && inPlace === true, ...history.counts() });
  }

  // ── marketplace themes, and marking (THEME_BROWSE#UI) ─────────────────
  // What the overlay lists while authoring: every theme of every registered
  // marketplace, each saying whether this deck marks it. Cache-only by
  // construction — the catalogs `marketplace update` already fetched — so a
  // deck on a plane lists what it has and names what it could not read.
  async function themeBrowseRoute({ json }) {
    const { marketplaceThemes, markedRefs, markedSources, resolveThemeRef } = await import('./theme-refs.mjs');
    const { themes, stale } = marketplaceThemes();
    // what the deck marks, as THIS machine names it — the deck may call the
    // same catalog something else (its recorded source says which it means)
    const html = readDeck();
    const sources = markedSources(html);
    const marked = new Set(markedRefs(html).map((r) => {
      const hit = resolveThemeRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    const out = themes.map((t) => ({
      ...t, marked: marked.has(t.qualified),
      ...(resolveThemeRef(t.qualified).remote ? { remote: true } : {}),
    }));
    return json(200, { ok: true, themes: out, stale, cacheOnly: true });
  }

  /**
   * Mark a theme for this deck, or unmark it (SPEC THEME_DISTRIBUTION). The
   * deck gains or loses one reference in its config block — never CSS — as
   * one undo entry; the watcher's reload brings every browser back with the
   * list as the file now says it is.
   *
   * Marking runs the theme through `theme add`'s own validator first, so a
   * theme refused on the command line is refused here, by the same code, and
   * a deck cannot be made to carry what the shipped set could not contain.
   * An entry whose bytes live at a URL is read now — this is the explicit act
   * — and kept, so no server ever has to reach for it again.
   */
  async function themeMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.marked !== false;
    const { parseRef, parseShipped, resolveThemeRef, setMarked, cacheThemeCss, refForDeck } = await import('./theme-refs.mjs');
    const { MarketplaceError, configHome } = await import('./marketplace.mjs');
    const shipped = parseShipped(ref);
    if (!shipped && !parseRef(ref)) return json(400, { ok: false, error: 'which theme? — a shipped name, or name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null;
    // A shipped theme needs no resolving and no check — it is decklight's own,
    // and passed the contract when it shipped. Marking it says only that the
    // deck carries it when it travels.
    if (on && !shipped) {
      const r = resolveThemeRef(ref);
      let css;
      if (r.file) css = readFileSync(r.file, 'utf8');
      else if (r.remote) {
        const { fetchTheme } = await import('./theme.mjs');
        try { css = await fetchTheme(r.remote); }
        catch (e) { return json(502, { ok: false, error: `could not read ${r.remote}: ${oneline(e)}` }); }
      } else {
        // An entry this machine knows but whose files are not here is a state
        // `marketplace update` fixes (409); one it has never heard of is 404.
        const status = r.entry && r.entry.type !== 'theme' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const { validateTheme } = await import('../tools/theme-check.mjs');
      const check = validateTheme(css);
      if (!check.ok) {
        // The deck is left byte-for-byte unchanged.
        return json(400, { ok: false, error: `${r.name} fails the theme contract`, problems: check.errors ?? [] });
      }
      if (r.remote) cacheThemeCss(configHome(), r.marketplace, r.name, css);
      source = r.source ?? null;
      deckRef = refForDeck(before, r.name, r.local, source);
    }
    let out;
    try { out = setMarked(before, deckRef, on, { source }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    if (out.changed) {
      history.record(before);   // Z takes a mark back like any other edit
      // The picker asks for `quiet`: it shows the new mark itself and stays
      // open. Everyone else — the export card's "mark and carry on", which
      // resumes across the reload — gets the reload.
      if (req.quiet === true) quiet(out.html);
      writeDeck(out.html);
      console.log(`  theme: ${on ? 'marked' : 'unmarked'} ${deckRef}`);
    }
    return json(200, { ok: true, ref: deckRef, marked: on, changed: out.changed, ...history.counts() });
  }
  // Every design system every registered marketplace offers, each saying
  // whether this deck references it (SPEC DESIGN_SYSTEMS) — the palette's
  // "Design systems…" list. Cache-only, like the theme browse above.
  async function designSystemBrowseRoute({ json }) {
    const { marketplaceDesignSystems, designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
    const { markedSources } = await import('./theme-refs.mjs');
    const { systems, stale, unfetched } = marketplaceDesignSystems();
    const html = readDeck();
    const sources = markedSources(html);
    // what the deck references, as THIS machine names the catalog
    const used = new Set(designSystemRefs(html).map((r) => {
      const hit = resolveDesignSystemRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    return json(200, { ok: true, systems: systems.map((s) => ({ ...s, used: used.has(s.qualified) })), stale, unfetched, cacheOnly: true });
  }

  /**
   * Reference a design system from this deck, or drop it (SPEC
   * DESIGN_SYSTEMS) — the twin of the theme mark below it. The package runs
   * through `decklight design-system gate` first, so the command line and
   * this route refuse by the same code; the deck gains or loses one entry in
   * its config block as one undo entry.
   */
  async function designSystemMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.used !== false && req.marked !== false;
    const { parseRef, refForDeck } = await import('./theme-refs.mjs');
    const { resolveDesignSystemRef, setDesignSystem, designSystemRefs } = await import('./design-system-refs.mjs');
    const { checkDir } = await import('./design-system.mjs');
    const { MarketplaceError, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
    if (!parseRef(ref)) return json(400, { ok: false, error: 'which design system? — name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null, manifest = null, local = null;
    if (on) {
      const r = resolveDesignSystemRef(ref);
      if (!r.dir) {
        const status = r.entry && r.entry.type !== 'design-system' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const verdict = checkDir(r.dir);
      if (!verdict.ok) {
        // the deck is left byte-for-byte unchanged
        return json(400, { ok: false, error: `${r.ref} fails the design-system check`, problems: verdict.problems.map((p) => `${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.msg}`) });
      }
      source = r.source ?? null;
      manifest = verdict.manifest;
      local = r.local;
      deckRef = refForDeck(before, r.name, r.local, source);
      if (!designSystemRefs(before).some((x) => x.ref === deckRef)) {
        recordInstall({ type: 'design-system', name: r.name, marketplace: r.local, version: r.entry.version ?? null,
          commit: loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null });
      }
    } else {
      // the deck's own spelling, whatever this machine calls the catalog
      const p = parseRef(ref);
      deckRef = designSystemRefs(before).find((x) => x.ref === ref || x.name === p.name)?.ref ?? ref;
    }
    let out;
    try { out = setDesignSystem(before, deckRef, on, { source }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    // Its themes and fonts come with it (SPEC DESIGN_SYSTEMS, #642) — in the
    // same write, so the whole thing is ONE undo — unless the author held ⇧
    // (recommended: false). The look is offered, and applied only when asked.
    let html = out.html, plan = null, look = null;
    if (on && manifest) {
      const deps = await import('./design-system-deps.mjs');
      plan = deps.planRecommended(html, { manifest, local });
      if (req.recommended !== false) {
        html = deps.writePlan(html, plan);
        for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
      }
      look = deps.lookOf(html, req.recommended !== false ? plan
        : { ...plan, items: plan.items.filter((it) => it.status === 'already' || it.status === 'stack') });
      if (req.apply === true && look.differs) html = deps.applyLook(html, look);
      look.phrase = deps.lookPhrase(look, plan);
    }
    const changed = html !== before;
    if (changed) {
      history.record(before);   // Z takes it back like any other edit
      if (req.quiet === true) quiet(html);
      writeDeck(html);
      console.log(`  design system: ${on ? 'referenced' : 'dropped'} ${deckRef}`);
    }
    const pulled = plan && req.recommended !== false ? plan.items.map(({ kind, rec, ref: r2, status, why, cmd, family }) => ({ kind, rec, ref: r2, status, why, cmd, family })) : [];
    return json(200, { ok: true, ref: deckRef, used: on, changed, pulled, look, ...history.counts() });
  }

  /**
   * Give the deck the look a design system it uses was drawn for (SPEC
   * DESIGN_SYSTEMS, #642): its first recommended theme and font, bringing any
   * that are missing — one edit, one undo, so Z puts the old look back and
   * keeps the design system. The twin of `decklight design-system apply`.
   */
  async function designSystemApplyRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const { designSystemRefs, resolveDesignSystemRef } = await import('./design-system-refs.mjs');
    const { markedSources, parseRef } = await import('./theme-refs.mjs');
    const { checkDir } = await import('./design-system.mjs');
    const { recordInstall } = await import('./marketplace.mjs');
    const deps = await import('./design-system-deps.mjs');
    const before = readDeck();
    const p = parseRef(String(req.ref ?? ''));
    const hit = designSystemRefs(before).find((x) => x.ref === req.ref || x.name === (p?.name ?? req.ref));
    if (!hit) return json(404, { ok: false, error: `this deck does not use ${req.ref}` });
    const r = resolveDesignSystemRef(hit, undefined, { source: markedSources(before)[hit.marketplace] ?? null });
    if (!r.dir) return json(409, { ok: false, error: r.missing });
    const verdict = checkDir(r.dir);
    if (!verdict.ok) return json(409, { ok: false, error: `${hit.ref} no longer passes its check` });
    const plan = deps.planRecommended(before, { manifest: verdict.manifest, local: r.local });
    let html = deps.writePlan(before, plan);
    const look = deps.lookOf(html, plan);
    if (look.differs) html = deps.applyLook(html, look);
    look.phrase = deps.lookPhrase(look, plan);
    // recorded even when the deck is unchanged: a dependency already there
    // takes the catalog's version now, as `design-system apply` does (#653)
    for (const inst of deps.plannedInstalls(plan)) recordInstall(inst);
    if (html !== before) {
      history.record(before);
      writeDeck(html);
      console.log(`  design system: applied ${look.title}'s look — ${look.phrase || 'already worn'}`);
    }
    return json(200, { ok: true, ref: hit.ref, changed: html !== before, look, ...history.counts() });
  }

  // Every font every registered marketplace offers (SPEC FONTS), each saying
  // whether this deck references it, with the faces a preview needs — the
  // font picker's marketplace rows. Cache-only, like the theme browse.
  async function fontBrowseRoute({ json }) {
    const { marketplaceFonts, fontRefs, resolveFontRef } = await import('./font-refs.mjs');
    const { markedSources } = await import('./theme-refs.mjs');
    const { fonts, stale, unfetched } = marketplaceFonts();
    const html = readDeck();
    const sources = markedSources(html);
    const used = new Set(fontRefs(html).map((r) => {
      const hit = resolveFontRef(r, undefined, { source: sources[r.marketplace] ?? null });
      return `${r.name}@${hit.local ?? r.marketplace}`;
    }));
    return json(200, { ok: true, fonts: fonts.map((f) => ({ ...f, used: used.has(f.qualified) })), stale, unfetched, cacheOnly: true });
  }

  /**
   * Reference a font from this deck, or drop it (SPEC FONTS) — the twin of
   * the design-system mark above: `font gate` first, one config entry, one
   * undo. `use: true` also makes it the deck's default font. `quiet` writes
   * without the reload: the picker previews the face itself, and stays open.
   */
  async function fontMarkRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const ref = typeof req.ref === 'string' ? req.ref.trim() : '';
    const on = req.used !== false && req.marked !== false;
    const { parseRef, refForDeck } = await import('./theme-refs.mjs');
    const { resolveFontRef, setFont, fontRefs } = await import('./font-refs.mjs');
    const { checkFontDir } = await import('./font.mjs');
    const { MarketplaceError, recordInstall, loadRegistry, configHome } = await import('./marketplace.mjs');
    if (!parseRef(ref)) return json(400, { ok: false, error: 'which font? — name@marketplace' });
    const before = readDeck();
    let deckRef = ref, source = null;
    if (on) {
      const r = resolveFontRef(ref);
      if (!r.dir) {
        const status = r.entry && r.entry.type !== 'font' ? 400 : r.entry ? 409 : 404;
        return json(status, { ok: false, error: r.missing });
      }
      const verdict = checkFontDir(r.dir);
      if (!verdict.ok) {
        return json(400, { ok: false, error: `${r.ref} fails the font check`, problems: verdict.problems.map((p) => `${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.msg}`) });
      }
      source = r.source ?? null;
      deckRef = refForDeck(before, r.name, r.local, source);
      if (!fontRefs(before).some((x) => x.ref === deckRef)) {
        recordInstall({ type: 'font', name: r.name, marketplace: r.local, version: r.entry.version ?? null,
          commit: loadRegistry(configHome()).marketplaces?.[r.local]?.commit ?? null });
      }
    } else {
      const p = parseRef(ref);
      deckRef = fontRefs(before).find((x) => x.ref === ref || x.name === p.name)?.ref ?? ref;
    }
    let out;
    try { out = setFont(before, deckRef, on, { source, use: req.use === true }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    if (out.changed) {
      history.record(before);
      if (req.quiet === true) quiet(out.html);
      writeDeck(out.html);
      console.log(`  font: ${on ? 'referenced' : 'dropped'} ${deckRef}${on && req.use === true ? ' (the deck\'s default)' : ''}`);
    }
    return json(200, { ok: true, ref: deckRef, used: on, changed: out.changed, ...history.counts() });
  }

  // `/deck/edit/theme/add` was 0.9.0's name for installing from Browse. A deck that
  // carries its OWN copy of the runtime still asks for it; it means "mark".
  const themeAddRoute = ({ body, json }) =>
    themeMarkRoute({ body: JSON.stringify({ ref: JSON.parse(body || '{}').ref, marked: true }), json });

  /**
   * `POST /deck/edit/marketplace/add` `{ spec, ref?, confirm? }`: register a
   * marketplace from inside the deck (SPEC MARKETPLACES_SCREEN, PLATFORM
   * MARKETPLACE_REGISTRY). `ref` is the command's `--branch`, a branch or a
   * tag to pin the catalog to. Two steps, like publish. Without `confirm` it says
   * what it is about to do (`planAdd`: which URL it would clone, or which
   * directory it would read) and touches nothing. With it, it runs
   * `decklight marketplace add` itself, as a child process: the same command,
   * so the registry cannot tell the two doors apart, and a clone that takes
   * thirty seconds holds up nobody but the person who asked for it. A relative
   * path is the deck's directory's, and is registered absolute. Nothing in
   * the deck changes, so there is no undo entry and no reload: the pickers ask
   * again, and find it.
   */
  async function marketplaceAddRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    if (req.ref != null && typeof req.ref !== 'string') return json(400, { ok: false, error: '--branch takes a branch or tag name' });
    const { planAdd, loadRegistry, loadCatalog, MarketplaceError, configHome } = await import('./marketplace.mjs');
    let plan;
    try { plan = planAdd(req.spec, { ref: req.ref?.trim() || null, base: deckPath ? dirname(deckPath) : process.cwd(), home: configHome() }); }
    catch (e) {
      if (e instanceof MarketplaceError) return json(400, { ok: false, error: e.message });
      throw e;
    }
    if (req.confirm !== true) return json(200, { ok: true, confirm: true, plan });
    const out = await addMarketplace(plan.spec, plan.ref);
    if (!out.ok) return json(409, { ok: false, error: out.error, plan });
    const reg = loadRegistry(configHome()).marketplaces ?? {};
    const name = Object.keys(reg).find((n) => reg[n].source === plan.spec) ?? null;
    const cat = name ? loadCatalog(name, configHome()) : null;
    const counts = {};
    for (const e of cat?.ok ? cat.manifest.entries ?? [] : []) counts[e.type] = (counts[e.type] ?? 0) + 1;
    console.log(`  marketplace: ${plan.registered ? 'refreshed' : 'registered'} ${name ?? plan.spec} from ${plan.spec}`);
    return json(200, { ok: true, name, spec: plan.spec, refreshed: !!plan.registered, counts, said: out.said });
  }

  /**
   * `GET /deck/edit/marketplaces`: every registered marketplace, from the
   * registry and the cache alone (SPEC MARKETPLACES_SCREEN) — what
   * `marketplace list` says, as data. Per marketplace: where it comes from
   * and at which ref and commit, whether it was ever fetched (`state`), what
   * its catalog offers per kind (`counts`), what its last update changed
   * (`changes`, as `update` recorded it), and which installs the catalog now
   * has newer (`newer`). No network: whether a source has MOVED is
   * `/deck/edit/marketplace/check`'s question, asked only when somebody asks.
   */
  async function marketplacesRoute({ json }) {
    const { loadRegistry, loadCatalog, newerThanInstalled, classifySource, configHome, MarketplaceError } = await import('./marketplace.mjs');
    let reg;
    try { reg = loadRegistry(configHome()).marketplaces ?? {}; } catch (e) {
      if (e instanceof MarketplaceError) return json(409, { ok: false, error: e.message });
      throw e;
    }
    const newer = newerThanInstalled(configHome());
    const marketplaces = Object.keys(reg).sort().map((name) => {
      const m = reg[name];
      const cat = loadCatalog(name, configHome());
      const counts = {};
      for (const e of cat?.ok ? cat.manifest.entries : []) counts[e.type] = (counts[e.type] ?? 0) + 1;
      return {
        name, source: m.source, ref: m.ref ?? null, commit: m.commit ?? null, firstParty: !!m.firstParty,
        local: classifySource(m.source).kind === 'local',
        state: cat === null ? 'unfetched' : cat.ok ? 'fetched' : 'unreadable',
        description: cat?.ok ? cat.manifest.description ?? null : null,
        counts, changes: m.changes ?? null,
        newer: newer.filter((n) => n.qualified.endsWith(`@${name}`)),
      };
    });
    return json(200, { ok: true, marketplaces, cacheOnly: true });
  }

  /**
   * `POST /deck/edit/marketplace/check` `{ name? }`: which marketplaces are
   * behind their source — `decklight marketplace outdated --json`, run as a
   * child like `add`. It ASKS each remote where its ref points (`git
   * ls-remote`, the caller's credentials) and fetches nothing, so it is one
   * explicit press, not a confirm; it never runs on its own.
   */
  async function marketplaceCheckRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    if (req.name != null && !/^\w[\w-]*$/.test(String(req.name))) return json(400, { ok: false, error: 'which marketplace? — its registered name' });
    const out = await marketplace(['outdated', '--json', ...(req.name ? [String(req.name)] : [])]);
    if (!out.ok) return json(409, { ok: false, error: out.error });
    let parsed;
    try { parsed = JSON.parse(out.stdout); } catch { return json(500, { ok: false, error: 'decklight marketplace outdated answered something that is not JSON' }); }
    return json(200, { ok: true, marketplaces: parsed.marketplaces ?? [] });
  }

  /**
   * `POST /deck/edit/marketplace/update` `{ name }`: `decklight marketplace
   * update <name>`, run as a child — the same re-clone, at the same pinned
   * ref, with the same refusals; a failed one leaves the cache and checkout
   * as they were. Answers with what the update changed (the `changes` the
   * command recorded: added, removed, versions moved) and which installs the
   * catalog now has newer, with the command that takes each — the screen's
   * what's new. Nothing in the deck changes, so no undo entry and no reload.
   */
  async function marketplaceUpdateRoute({ body, json }) {
    const req = JSON.parse(body || '{}');
    const name = typeof req.name === 'string' ? req.name : '';
    if (!/^\w[\w-]*$/.test(name)) return json(400, { ok: false, error: 'which marketplace? — its registered name' });
    const { loadRegistry, loadCatalog, newerThanInstalled, configHome } = await import('./marketplace.mjs');
    if (!loadRegistry(configHome()).marketplaces?.[name]) return json(404, { ok: false, error: `no marketplace "${name}" is registered` });
    const out = await marketplace(['update', name]);
    if (!out.ok) return json(409, { ok: false, error: out.error });
    const m = loadRegistry(configHome()).marketplaces?.[name] ?? {};
    const cat = loadCatalog(name, configHome());
    const counts = {};
    for (const e of cat?.ok ? cat.manifest.entries : []) counts[e.type] = (counts[e.type] ?? 0) + 1;
    console.log(`  marketplace: updated ${name}${m.commit ? ` (${m.commit.slice(0, 7)})` : ''}`);
    return json(200, { ok: true, name, commit: m.commit ?? null, changes: m.changes ?? null, counts, newer: newerThanInstalled(configHome(), name), said: out.said });
  }

  routes.set('POST /deck/edit/theme', themeRoute);
  routes.set('POST /deck/edit/brand-themes', brandThemesRoute);
  routes.set('GET /deck/edit/theme/browse', themeBrowseRoute);
  routes.set('POST /deck/edit/theme/add', themeAddRoute);
  routes.set('POST /deck/edit/theme/mark', themeMarkRoute);
  routes.set('GET /deck/edit/design-system/browse', designSystemBrowseRoute);
  routes.set('POST /deck/edit/design-system/mark', designSystemMarkRoute);
  routes.set('POST /deck/edit/design-system/apply', designSystemApplyRoute);
  routes.set('GET /deck/edit/font/browse', fontBrowseRoute);
  routes.set('POST /deck/edit/font/mark', fontMarkRoute);
  routes.set('POST /deck/edit/marketplace/add', marketplaceAddRoute);
  routes.set('GET /deck/edit/marketplaces', marketplacesRoute);
  routes.set('POST /deck/edit/marketplace/check', marketplaceCheckRoute);
  routes.set('POST /deck/edit/marketplace/update', marketplaceUpdateRoute);
  return routes;
}

const CLI = fileURLToPath(new URL('./decklight.mjs', import.meta.url));

/**
 * Run `decklight marketplace <args…>` and say how it went: `{ ok, said,
 * stdout }` with the command's own first line, or `{ ok: false, error }` with
 * what it printed on the way out, prefix dropped. git is told never to prompt
 * (the command does that too; a server has no terminal to prompt on), and the
 * update notice is the command line's business, not this sentence's.
 */
export function runMarketplace(args, { timeoutMs = 120000 } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, 'marketplace', ...args], {
      encoding: 'utf8', timeout: timeoutMs,
      // no version banner: the server already said which version this is,
      // and on stderr it would open every refusal read back from there
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', DECKLIGHT_NO_UPDATE_CHECK: '1', DECKLIGHT_BANNER: '1' },
    }, (err, stdout, stderr) => {
      if (!err) return done({ ok: true, said: String(stdout).trim().split('\n')[0] ?? '', stdout: String(stdout) });
      const said = String(stderr).trim().replace(new RegExp(`^decklight marketplace ${args[0]}: `), '');
      done({ ok: false, error: said || (err.killed ? `gave up after ${Math.round(timeoutMs / 1000)}s` : oneline(err)) });
    });
  });
}

/** `decklight marketplace add <spec>` — the add door's one command. */
export const runMarketplaceAdd = (spec, opts) => runMarketplace(['add', spec], opts);
