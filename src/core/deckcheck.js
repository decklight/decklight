// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Check deck… (palette): every problem with this deck, in one docked panel,
 * each with the fix that would clear it. SPEC PRESENTING_EDITING.
 *
 * `decklight check` answers "what is wrong" in a terminal, for an agent or a
 * CI job. An author presenting or editing has the deck open and no terminal
 * in front of them, and the problems used to be spread over several places:
 * this panel had what the live page can measure, the Inspector had the
 * file's half for one slide at a time, and the head-level findings (a design
 * system the deck is behind, a theme off the brand, a missing file) came as
 * toasts that expired. Now they are all rows here, and the toasts point at
 * the row.
 *
 * THREE SOURCES, ONE LIST. The open deck answers what the render half of the
 * CLI asks a headless one, plus what only a live page can:
 *
 *   overflow          content clipped (measured now, every slide)
 *   dense             crowded past SLIDE_DENSITY (density.js, the same count)
 *   split-conflict    data-layout="split" fighting a flex shell
 *   clicks-vs-builds  ⟨CLICK⟩ markers that do not match the build steps
 *   missing-media     an image or a video that did not load
 *   markdown-slide    a data-markdown slide, which comes up empty
 *   static-diagram    (hint) an SVG diagram with no build, landing all at once
 *   concept-suggestion (hint) a label recurring in different colours
 *
 * In write mode the edit server adds the FILE's half for the whole deck
 * (`GET /deck/edit/check`, cli/check.mjs's `staticFindings` with the same
 * rule ids `check --json` prints): the head-level, deck-wide findings first,
 * then each slide's (`ds-behind`, `theme-off-brand`, `off-role`,
 * `missing-asset`, `unaccounted-script`, …). A finding the page measured
 * itself wins over the file's reading of the same rule on the same slide.
 * After them, the AGENT REVIEW's findings, when one has run (cli/agent-
 * review.mjs): judgement rather than counting, so they are their own group.
 *
 * EVERY ROW WITH A FIX SHOWS IT, as what pressing it will do (*Migrate to
 * acme 6.0.0 · 62 renames*, *Switch to acme-dark*, *Rename text-main →
 * text-body on slide 4*); `f` or the button applies it. Two kinds (#889):
 * a DETERMINISTIC fix the server applies itself (`POST /deck/edit/check/fix`,
 * cli/check-fixes.mjs), recorded in the agent panel's log as an entry by
 * decklight; and a JUDGEMENT fix — a clipped slide, a ⟨CLICK⟩ mismatch, an
 * agent-review finding — handed to the A agent as an ordinary ask, whose
 * prompt carries the finding and its rule, watched in the agent panel.
 * Either way it is one undo entry and one commit, and the row goes when the
 * finding does. Both are REVIEWED first (#907, fixreview.js): the fix is held
 * as a candidate, shown beside the deck as it is, and lands only as far as
 * the author approves it; Settings → Review quick fixes turns that off. `⇧F` fixes every row of a rule whose fix is safe to batch
 * (renamed roles). A row with neither says so.
 *
 * The panel DOCKS like the others (dock.js: float, left, right, bottom, one
 * slot per deck), stays open across the reload an edit causes, refreshes
 * after each write, and ⏎ goes to the row's slide without closing it; ←/→
 * keep driving the deck. `check()` is exposed on the instance so a headless
 * probe reads the same list.
 */

import { selectInList } from './overlay.js';
import { createDock } from './dock.js';
import { slideDensity } from './density.js';
import { notesSegments } from './speaker.js';
import { injectedIn } from './pick.js';

/** One finding, shaped like the CLI's (`--json`), so the two read alike. */
const finding = (level, rule, slide, title, message) => ({ level, rule, slide, title, message });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Rules no agent can do anything about from inside the deck. */
const NOT_FOR_AGENT = new Set(['ds-behind', 'ds-unresolved', 'ds-unknown-system', 'render-failed', 'not-rendered']);

// ── whether a slide's diagram builds (cli/check.mjs's twin)

/** Generated, not drawn, or not the slide's own: nothing here is asked to build. */
const NOT_AUTHORED = 'aside, .chart, .terminal';
const SHAPES = 'rect, circle, ellipse, polygon, polyline, path, line';

/**
 * A diagram: an authored svg with three drawn shapes or more and a label. A
 * slide template's own svg is not the slide's; a slot container it was put in
 * is no reason to skip it (SPEC DESIGN_SYSTEMS).
 */
export const isAuthoredDiagram = (svg) => !svg.parentElement?.closest('svg')
  && !svg.closest(NOT_AUTHORED) && !injectedIn(svg, svg)
  && svg.querySelectorAll(SHAPES).length >= 3 && !!svg.querySelector('text');

/** The slide's diagrams. */
const diagramsOf = (sec) => [...sec.querySelectorAll('svg')].filter(isAuthoredDiagram);

/**
 * The ask a judgement fix hands the A agent: the finding and its rule, and
 * nothing else to do. The agent-review findings carry their own prepared
 * instruction (cli/agent-review.mjs) and keep it.
 */
export const agentPrompt = (f) => `${f.slide ? `On slide ${f.slide} ("${f.title}"), ` : 'In this deck, '}fix this one problem that decklight check found`
  + ` (rule ${f.rule}) and nothing else. The problem: ${f.message}`
  + (f.fix?.skills?.length ? ` Use the ${f.fix.skills.join(' and ')} skill.` : '');

/** `fix: <rule> on slide N`, or `fix: <rule>` for the deck — the commit a fix makes. */
const fixSubject = (f) => `fix: ${f.rule}${f.slide ? ` on slide ${f.slide}` : ''}`;

export function createDeckCheck({
  root, overlays, toast = () => {}, instance, goto, measureOverflow, slideTitle,
  suggestions = () => [], accept = () => null,
  agentFindings = () => [],
  // the edit server behind the page: `available()` and `base()` for the
  // file's findings; `quickFix()` and `askAgent()` answer the fixer when the
  // page can write (and, for the agent, has one), else null
  editmode = () => null, quickFix = () => null, askAgent = () => null,
}) {
  let el = null, sel = 0, rows = [], onResize = null, busy = false;
  // the file's half, from the server: `at` is the fetch that holds, so a
  // slow answer to an earlier one never lands over a newer
  let file = null;        // { findings, slides, deck }
  let fetching = 0;
  let served = null;      // true once the server answered, false once it refused — for the foot
  let want = null;        // a row to select once it is on screen: { rule, ref }
  let refreshTimer = null;

  const dock = createDock({
    root,
    reflow: () => instance()?._reflow?.(),
    getEl: () => el,
    closeLabel: 'close (esc)',
    defaultMode: 'right',
    name: 'Check',
    open: () => { if (!el) open(); },
    close: () => { if (el) close(); },
  });

  /** The file's findings, asked of the server again; nothing without one. */
  function fetchFile() {
    const em = editmode();
    if (!em?.available?.() || em.base?.() == null) { file = null; served = false; return Promise.resolve(); }
    const at = ++fetching;
    return fetch(`${em.base()}/deck/edit/check`).then((r) => r.json()).then((j) => {
      if (at !== fetching) return;
      served = true;
      file = j?.ok ? { findings: Array.isArray(j.findings) ? j.findings : [], slides: j.slides, deck: j.file } : null;
      if (el) paint();
    }).catch(() => { if (at === fetching) { served = false; if (el) paint(); } });
  }

  /** Every finding the open deck can answer for, slide order, errors first within a slide. */
  function check() {
    const inst = instance();
    const sections = inst?._sections ?? [];
    const out = [];
    sections.forEach((sec, i) => {
      const n = i + 1;
      const title = slideTitle(sec, i);
      const add = (level, rule, message) => out.push(finding(level, rule, n, title, message));
      if (sec.hasAttribute('data-markdown-removed')) {
        add('error', 'markdown-slide', 'a markdown slide, which comes up empty: data-markdown was removed in 0.3.0');
      }
      if (measureOverflow(sec, n)) add('error', 'overflow', 'content is clipped: the audience never sees the rest');
      for (const m of sec.querySelectorAll('img')) {
        if (m.getAttribute('src') && m.complete && m.naturalWidth === 0) {
          add('error', 'missing-media', `an image did not load: ${m.getAttribute('src')}`);
        }
      }
      for (const v of sec.querySelectorAll('video, audio')) {
        if (v.error) add('error', 'missing-media', `a ${v.tagName.toLowerCase()} did not load: ${v.currentSrc || v.getAttribute('src') || 'its source'}`);
      }
      const dense = slideDensity(sec);
      if (dense.length) add('warn', 'dense', `crowded: ${dense.join(', ')}. Split it rather than shrink it`);
      if (sec.hasAttribute('data-split-conflict')) {
        add('warn', 'split-conflict', 'data-layout="split" is fighting its own column flexbox: drop one');
      }
      const notes = sec.querySelector(':scope > aside.notes');
      const clicks = notes ? notesSegments(notes.innerHTML).length - 1 : 0;
      const steps = inst._records?.[i]?.groups.length ?? 0;
      if (clicks > 0 && clicks !== steps) {
        add('warn', 'clicks-vs-builds', `${plural(clicks, '⟨CLICK⟩', '⟨CLICK⟩s')} in the notes for ${plural(steps, 'build step')}: narration and builds drift apart`);
      }
      // built is what the engine built: a step on the svg, or on anything in it
      if (!sec.hasAttribute('data-static-ok')) {
        const built = (inst._records?.[i]?.steps ?? []).map((st) => st.el).filter(Boolean);
        const still = diagramsOf(sec).filter((svg) => !svg.hasAttribute('data-static-ok')
          && !built.some((b) => b === svg || svg.contains(b)));
        if (still.length) {
          add('hint', 'static-diagram', `${still.length === 1 ? 'a diagram' : plural(still.length, 'diagram')} with no build: `
            + `${still.length === 1 ? 'it lands' : 'they land'} all at once. Reveal it in steps, or mark it data-static-ok`);
        }
      }
    });
    // labels that recur in different colours (SVG_DIAGRAMS): a hint, not a
    // fault, listed on the first slide that has one; the fix makes it the concept
    for (const s of suggestions()) {
      const sec = sections[s.slides[0] - 1];
      out.push({
        ...finding('hint', 'concept-suggestion', s.slides[0], sec ? slideTitle(sec, s.slides[0] - 1) : '',
          `“${s.label}” is on ${s.slides.length === 1 ? `slide ${s.slides[0]}` : `slides ${s.slides.slice(0, -1).join(', ')} and ${s.slides.at(-1)}`} in ${s.colours} colours: make it the “${s.name}” concept`),
        suggestion: s,
      });
    }
    // the file's half (write mode): what the page already measured for the
    // same rule on the same slide is dropped from it — the page knows better
    // — and the head-level, deck-wide findings come first
    const measured = new Set(out.map((f) => `${f.rule}:${f.slide}`));
    for (const f of file?.findings ?? []) {
      if (f.slide != null && (f.slide < 1 || f.slide > sections.length)) continue;
      if (measured.has(`${f.rule}:${f.slide}`)) continue;
      const slide = f.slide ?? null;
      out.push({
        ...finding(f.level, f.rule, slide, slide ? slideTitle(sections[slide - 1], slide - 1) : 'the deck', f.message),
        ...(f.fix ? { fix: f.fix } : {}), fromFile: true,
      });
    }
    const rank = { error: 0, warn: 1, hint: 2 };
    const own = out.map((f, i) => [f, i])
      .sort((a, b) => (a[0].slide ?? 0) - (b[0].slide ?? 0) || rank[a[0].level] - rank[b[0].level] || a[1] - b[1])
      .map(([f]) => f);
    // the agent's, last and apart: already in slide order, already checked by the server
    const agent = agentFindings().filter((f) => f.slide >= 1 && f.slide <= sections.length).map((f) => ({
      ...finding('agent', f.rule, f.slide, slideTitle(sections[f.slide - 1], f.slide - 1), f.message),
      label: f.label, agentFinding: f,
    }));
    return [...own, ...agent];
  }

  /**
   * What would clear a row, or null: `{ label, run(all), batch, agent }`.
   * The server's own fix first (it wrote what it will do on the finding),
   * then a concept suggestion's accept, then the agent for anything a
   * reader's judgement can mend.
   */
  function fixOf(f) {
    const quick = quickFix();
    if (f.fix && quick) {
      const ref = f.fix.ref ?? f.fix.name ?? null;
      return {
        label: f.fix.label, batch: !!f.fix.batch, agent: false,
        run: (all = false) => quick({ rule: f.rule, slide: f.slide, ref, all: all && !!f.fix.batch, review: true }),
      };
    }
    const take = f.suggestion && accept();
    if (take) return { label: `Make “${f.suggestion.name}” the concept`, batch: false, agent: false, run: () => take(f.suggestion) };
    const ask = askAgent();
    if (!ask) return null;
    if (f.agentFinding) {
      return { label: 'Ask the agent to fix it', batch: false, agent: true,
        run: () => ask({ prompt: f.agentFinding.prompt, slide: f.slide, message: `review: ${f.label} on slide ${f.slide}`, review: true, rule: f.rule }) };
    }
    if (NOT_FOR_AGENT.has(f.rule)) return null;
    return { label: 'Ask the agent to fix it', batch: false, agent: true,
      run: () => ask({ prompt: agentPrompt(f), slide: f.slide ?? undefined, message: fixSubject(f), review: true, rule: f.rule }) };
  }

  /** The palette row: open it, or close it when it is up. */
  function toggle() { if (el) close(); else open(); }

  /** Open it (or leave it open); `{ rule, ref }` opens on, or moves to, that row. */
  function open(select = null) {
    if (select) want = select;
    if (el) { selectWanted(); return; }
    overlays.opening();
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-dockable decklight-deckcheck';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Check deck"></div>';
    // a click in the panel is the panel's, never a click on the slide behind
    el.addEventListener('click', (e) => e.stopPropagation());
    root.appendChild(el);
    dock.reserveGutter();
    onResize = () => dock.reserveGutter();
    window.addEventListener('resize', onResize);
    sel = 0;
    fetchFile();   // first: with no server it says so at once, and the foot reads right from the first paint
    paint();
  }

  /** The findings changed under the panel (a write landed): read them again. */
  function refresh() {
    if (!el) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (el) { fetchFile(); paint(); } }, 60);
  }

  function selectWanted() {
    if (!want || !el) return;
    const i = rows.findIndex((f) => f.rule === want.rule && (!want.ref || f.fix?.ref === want.ref || f.fix?.name === want.ref || f.message.includes(want.ref)));
    if (i >= 0) { select(i); want = null; } else if (served !== null && file !== null) want = null;   // the file answered: the row is not there
  }

  function paint() {
    const card = el.querySelector('.narr-card');
    const scrolled = card.querySelector('.dc-list')?.scrollTop ?? 0;
    card.replaceChildren();
    const found = check();
    const slides = instance()?._sections?.length ?? 0;
    const errors = found.filter((f) => f.level === 'error').length;
    const issues = found.filter((f) => f.level === 'error' || f.level === 'warn');
    const hints = found.filter((f) => f.level === 'hint').length;
    const fromAgent = found.filter((f) => f.level === 'agent').length;
    const fixes = found.map((f) => fixOf(f));
    const withFix = fixes.filter((x) => x && !x.agent).length;
    const onSlides = new Set(issues.filter((f) => f.slide).map((f) => f.slide)).size;
    const onDeck = issues.some((f) => !f.slide);
    const head = document.createElement('div');
    head.className = 'narr-head';
    const heading = document.createElement('span');
    heading.className = 'dc-heading';
    heading.textContent = (issues.length
      ? `check · ${plural(issues.length, 'issue')} on ${onSlides ? plural(onSlides, 'slide') : ''}${onDeck ? `${onSlides ? ' and ' : ''}the deck` : ''}`
        + (errors ? ` · ${plural(errors, 'error')}` : '')
      : 'check') + (hints ? ` · ${plural(hints, 'suggestion')}` : '') + (fromAgent ? ` · ${fromAgent} from the agent` : '')
      + (withFix ? ` · ${withFix} with a fix` : '');
    head.append(heading, dock.controls(close));
    dock.wireHeader(head);
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'dc-list';
    card.appendChild(list);
    rows = found;
    if (!issues.length) {
      const ok = document.createElement('div');
      ok.className = 'narr-row narr-fact dc-clean';
      ok.textContent = `no issues: ${plural(slides, 'slide')} checked${served ? ', file included' : ''}`;
      list.appendChild(ok);
    }
    found.forEach((f, i) => {
      if (f.level === 'agent' && (i === 0 || found[i - 1].level !== 'agent')) {
        const sub = document.createElement('div');
        sub.className = 'narr-group dc-agent-head';
        sub.textContent = `agent review · ${fromAgent}${askAgent() ? ' · f asks the agent to fix one' : ''}`;
        list.appendChild(sub);
      }
      const row = document.createElement('div');
      row.className = `narr-row dc-row dc-${f.level}${f.slide ? '' : ' dc-deck'}`;
      row.dataset.rule = f.rule;
      const mark = document.createElement('span');
      mark.className = 'dc-mark';
      mark.textContent = f.level === 'error' ? '✗' : f.level === 'hint' ? '+' : f.level === 'agent' ? '✦' : '!';
      const where = document.createElement('span');
      where.className = 'dc-where';
      where.textContent = f.slide ? `${f.slide}` : '—';
      where.title = f.slide ? f.title : 'the whole deck';
      const text = document.createElement('span');
      text.className = 'dc-text';
      const name = document.createElement('span');
      name.className = 'dc-title';
      name.textContent = f.title;
      const msg = document.createElement('span');
      msg.className = 'dc-msg';
      msg.textContent = f.message;
      text.append(name, msg);
      if (f.label) {
        const tag = document.createElement('span');
        tag.className = 'dc-rule';
        tag.textContent = f.label;
        text.append(tag);
      }
      // what pressing f does to this row, written on it — or that nothing would
      const q = fixes[i];
      const act = document.createElement('span');
      act.className = 'dc-act';
      if (q) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `dc-fix${q.agent ? ' dc-fix-agent' : ''}`;
        b.textContent = q.label;
        b.title = q.agent ? 'an ask to the agent, watched in the agent panel' : 'applied by decklight, logged in the agent panel · f';
        b.disabled = busy;
        b.addEventListener('click', (e) => { e.stopPropagation(); runFix(i); });
        act.append(b);
        if (q.batch) {
          const all = document.createElement('button');
          all.type = 'button';
          all.className = 'dc-fix dc-fix-all';
          all.textContent = `every ${f.rule} (⇧F)`;
          all.title = `the same fix on every slide with one, as one undo step`;
          all.disabled = busy;
          all.addEventListener('click', (e) => { e.stopPropagation(); runFix(i, true); });
          act.append(all);
        }
      } else {
        act.className += ' dc-nofix';
        act.textContent = 'no quick fix';
      }
      text.append(act);
      row.append(mark, where, text);
      row.addEventListener('mouseenter', () => select(i));
      row.addEventListener('click', () => run(i));
      list.appendChild(row);
    });
    const foot = document.createElement('div');
    foot.className = 'narr-foot dc-foot';
    foot.textContent = served
      ? `⏎ goes to the slide · f applies the row's fix${fixes.some((x) => x?.batch) ? ' · ⇧F every slide' : ''} · the file's findings included`
      : served === false
        ? '⏎ goes to the slide · the file\'s own findings (missing files, scripts) need write mode: decklight check <deck> reads them too'
        : '⏎ goes to the slide · reading the file…';
    card.appendChild(foot);
    list.scrollTop = scrolled;
    if (found.length) select(Math.min(sel, found.length - 1));
    selectWanted();
  }

  function select(i) {
    const list = el.querySelectorAll('.dc-row');
    if (list.length) sel = selectInList(list, i, 'narr-sel');
  }
  /** ⏎ or a click: to the slide, the panel staying put. */
  function run(i) {
    const f = rows[i];
    if (!f) return;
    select(i);
    if (f.slide) goto(f.slide);
  }
  /** `f` on a row: its fix, on its slide; `all` for a batchable rule across the deck. */
  async function runFix(i, all = false) {
    const f = rows[i];
    const q = f ? fixOf(f) : null;
    if (!q) { toast(f ? `no quick fix for ${f.rule}${askAgent() ? '' : ' — the agent could, with an agent CLI on this machine'}` : 'nothing selected', 2600); return false; }
    if (busy) { toast('a fix is still landing', 1600); return true; }
    if (all && !q.batch) { toast(`${f.rule} is fixed one slide at a time`, 2600); return true; }
    if (f.slide) goto(f.slide);
    busy = true;
    paint();
    try { await q.run(all); } finally { busy = false; }
    // the write reloads the page a moment from now; until then, the list as it is
    if (el) refresh();
    return true;
  }
  function close() {
    if (!el) return;
    el.remove();
    el = null;
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    dock.release();
  }

  function keydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowDown': select(sel + 1); return true;
      case 'ArrowUp': select(sel - 1); return true;
      case 'Enter': run(sel); return true;
      case 'Escape': close(); return true;
      case 'f': runFix(sel); return true;
      case 'F': runFix(sel, e.shiftKey); return true;
      default: return false;   // the deck's: a panel beside the slide
    }
  }

  overlays.register({ isOpen: () => !!el, close, keydown, modal: false, panel: true });

  return { open, toggle, close, check, refresh, isOpen: () => !!el };
}
