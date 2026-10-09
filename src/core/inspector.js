// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The inspector (`I`, PRESENTING): everything about the slide on screen, or
 * about the element selected on it.
 *
 * The facts were all computed somewhere already: the build records, the
 * overflow guardrail's marks, the speaker view's timings, the narration's
 * status, the review's comments, the sources aside, `decklight check`. They
 * were scattered across a debug line, a second window and a terminal, so the
 * question "what is going on with THIS slide" had no one place to be asked.
 *
 * It reports and never edits: editing stays with the selection (editbar.js)
 * and its editors, and the one write this panel leads to (`e`, the sources
 * editor) is a door to the editor that already owns it. Each row is a fact,
 * with a green ✓ when it is fine and a yellow ! when it wants a look, the way
 * the terminal banner marks its rows: short, no commentary.
 *
 * Docked, it is a reference open beside the slide. It follows the slide and
 * the selection, and arrow keys keep driving the deck.
 */

import { createDock } from './dock.js';
import { readJson } from './prefs.js';
import { stepLabels } from './builds.js';
import { notesSegments } from './speaker.js';
import { slideTitle } from './finder.js';
import { sourcesOf } from './sources.js';
import {
  parseColor, contrastRatio, aaFloor, hex, tokenFor, stageBox, shareOf,
  fontLine, clock, effectiveBackground,
} from './inspect-facts.js';

/**
 * The theme's own colour tokens (themes/*.css), tried first when naming a
 * colour: a heading is `--heading-color`, not whichever terminal colour
 * happens to share its hex. Any other token comes after, and the terminal
 * and syntax palettes last of all.
 */
const KNOWN_TOKENS = ['--fg', '--heading-color', '--accent', '--muted', '--link', '--bg', '--bg-accent',
  '--accent-contrast', '--d-text', '--d-accent', '--d-stroke', '--d-muted', '--code-fg', '--code-bg', '--block-bg'];
const LAST = /^--(ansi|hl|tm|term)-/;

export function createInspector({
  root, overlays, toast, copyText,
  instance, stage, editmode, editbar, review, narration, sources,
}) {
  const dock = createDock({
    root,
    reflow: () => instance()._reflow?.(),
    key: 'decklight-inspector-dock:' + location.pathname,
    getEl: () => el,
    closeLabel: 'close (I)',
    defaultMode: 'right',
  });
  let el = null;
  let onResize = null;
  let resizeTimer = null;
  let watch = null;
  // the selection, as editbar announced it; `focus` is the node being shown,
  // which a breadcrumb can move from the selected block to a node inside it
  let target = null;
  let focus = null;
  let hovered = null;
  let subscribed = false;
  // what the server and the review said about a slide, kept until the slide
  // changes: the selection re-renders on every click and must not re-ask
  let fileFacts = { slide: 0, data: null };
  let comments = { slide: 0, data: undefined };
  let lastText = '';

  const inst = () => instance();
  const slideNo = () => inst().state.slide;
  const sectionAt = (n) => inst()._sections[n - 1];
  const isOpen = () => !!el;

  function close() {
    unhover();
    el?.remove();
    el = null;
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    watch?.disconnect();
    watch = null;
    dock.release();
  }

  function open() {
    if (el) { close(); return; }
    overlays.opening();
    if (!subscribed && editbar()?.onSelect) {
      subscribed = true;
      editbar().onSelect((t) => {
        target = t;
        focus = t ? (t.clicked && t.top.contains(t.clicked) ? t.clicked : t.top) : null;
        if (el) render();
      });
    }
    target = editbar()?.selected?.() ?? null;
    focus = target ? (target.clicked ?? target.top) : null;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-dockable decklight-inspector';
    el.innerHTML = '<div class="narr-card"></div>';
    root.appendChild(el);
    dock.reserveGutter();
    onResize = () => {
      dock.reserveGutter();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (el) render(); }, 120);
    };
    window.addEventListener('resize', onResize);
    // the overflow guardrail measures AFTER a slide arrives (overflow.js), so
    // its verdict lands after the first paint here: hear it, and say it
    watch = new MutationObserver(() => { if (el) render(); });
    watch.observe(stage(), { subtree: true, attributes: true, attributeFilter: ['data-overflow', 'data-split-conflict'] });
    render();
  }

  // ----- the rows ------------------------------------------------------------

  /** A row: `key`, `value`, and an optional mark ('ok' ✓, 'warn' !). */
  const row = (key, value, mark = null, extra = null) => ({ key, value, mark, extra });

  function slideRows() {
    const n = slideNo();
    const sec = sectionAt(n);
    const rows = [];
    if (!sec) return rows;
    const ds = sec.getAttribute('data-template');
    rows.push(row('layout', [sec.getAttribute('data-layout') || 'auto', ds].filter(Boolean).join(' · ')));

    const rec = inst()._records[n - 1];
    const steps = rec?.groups.length ?? 0;
    const labels = steps ? stepLabels(rec) : [];
    rows.push(row('builds', steps ? `${steps} step${steps === 1 ? '' : 's'} · on ${inst().state.step}` : 'none',
      null, labels.length ? labels.map((l, i) => `${i + 1} ${l}`).join(' · ') : null));

    const notes = sec.querySelector(':scope > aside.notes');
    if (notes) {
      const words = (notes.textContent.match(/\S+/g) ?? []).length;
      const clicks = notesSegments(notes.innerHTML).length - 1;
      const off = clicks > 0 && clicks !== steps;
      rows.push(row('notes', `${words} word${words === 1 ? '' : 's'}${clicks ? ` · ${clicks} ⟨CLICK⟩` : ''}`,
        off ? 'warn' : null, off ? `${clicks} ⟨CLICK⟩ for ${steps} step${steps === 1 ? '' : 's'}` : null));
    } else rows.push(row('notes', 'none'));

    const planned = Number(sec.dataset.timing);
    const rehearsed = Number(readJson('decklight-timings:' + location.pathname)?.[n - 1]);
    const time = [
      planned > 0 && `planned ${clock(planned)}`,
      rehearsed > 0 && `rehearsed ${clock(rehearsed)}`,
    ].filter(Boolean);
    rows.push(row('time', time.length ? time.join(' · ') : 'not planned',
      planned > 0 && rehearsed > planned + 5 ? 'warn' : null));

    const clip = clippedBy(sec);
    if (sec.hasAttribute('data-split-conflict')) rows.push(row('fit', 'split layout fights a flex block', 'warn'));
    else if (sec.hasAttribute('data-overflow')) rows.push(row('fit', clip ? `clips by ${clip}px` : 'clips', 'warn'));
    else rows.push(row('fit', 'fits', 'ok'));

    const st = narration()?.status?.();
    if (st) {
      const voice = !st.hasTracks && !st.live ? 'no track'
        : st.track ? `${st.live ? 'live voice' : 'recorded'}${st.narrating ? (st.paused ? ' · paused' : ' · playing') : ''}`
        : 'off';
      rows.push(row('voice', voice));
    }

    if (comments.slide === n && comments.data) {
      const { open, resolved } = comments.data;
      rows.push(row('comments', open || resolved ? `${open} open · ${resolved} resolved` : 'none'));
    }

    const file = fileFacts.slide === n ? fileFacts.data : null;
    if (file) {
      rows.push(row('file', `${file.file} · lines ${span(file.lines)}`));
      for (const f of file.findings) rows.push(row('check', f.message, f.level === 'error' || f.level === 'warn' ? 'warn' : null));
    }
    return rows;
  }

  /** How far the slide's worst clipped box overflows, in deck px (the guardrail's own test). */
  function clippedBy(sec) {
    let worst = 0;
    for (const n of [sec, ...sec.querySelectorAll('pre, table, svg, ul, ol, blockquote')]) {
      if (n.closest('.terminal') || n.hasAttribute('data-scroll-ok')) continue;
      if (getComputedStyle(n).overflowY === 'visible') continue;
      worst = Math.max(worst, n.scrollHeight - n.clientHeight);
    }
    return worst > 2 ? Math.round(worst) : 0;
  }

  const span = ([a, b]) => (a === b ? `${a}` : `${a}–${b}`);

  function elementRows() {
    const node = focus;
    const sec = node.closest('section');
    const rows = [];
    rows.push(row('element', describe(node), null,
      node === target.top ? `block ${target.index + 1}` : `inside block ${target.index + 1}`));

    const st = stage();
    const box = stageBox(node.getBoundingClientRect(), st.getBoundingClientRect(), inst()._scale);
    const sw = parseFloat(st.style.width) || inst().config.width;
    const sh = parseFloat(st.style.height) || inst().config.height;
    rows.push(row('box', `x ${box.x} y ${box.y} · ${box.w}×${box.h}`, null, `${shareOf(box, sw, sh)}% of the slide`));

    const cs = getComputedStyle(node);
    const text = (node.textContent ?? '').trim();
    if (text) {
      const svg = node instanceof SVGElement;
      const colour = svg && node.tagName !== 'svg' ? cs.fill : cs.color;
      const c = parseColor(colour);
      rows.push(row('type', fontLine(cs), null, c ? colourName(colour, c) : null));
      if (c) {
        // nothing opaque behind it: the theme's own --bg is the canvas
        const canvas = parseColor(getComputedStyle(root).getPropertyValue('--bg'));
        const seen = {};
        const bg = effectiveBackground(node, {
          styleOf: (n) => getComputedStyle(n), stop: root, seen,
          fallback: canvas && canvas[3] >= 1 ? canvas : [255, 255, 255, 1],
        });
        const ratio = contrastRatio(c, bg);
        const floor = aaFloor(parseFloat(cs.fontSize) || 0, cs.fontWeight);
        // cut, never rounded: 4.48 shown as "4.5:1 !" next to "AA wants 4.5" reads as a bug
        rows.push(row('contrast', `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`, ratio >= floor ? 'ok' : 'warn',
          `on ${seen.image ? '≈ ' : ''}${hex(bg)}${seen.image ? ' (gradient)' : ''} · AA wants ${floor}:1`));
      }
    }

    rows.push(row('build', buildOf(node)));

    if (node.tagName === 'IMG') {
      const raw = node.getAttribute('src') ?? '';
      const src = raw.startsWith('data:') ? 'inline' : raw.split(/[?#]/)[0].split('/').pop() || 'inline';
      rows.push(row('image', `${src} · ${node.naturalWidth}×${node.naturalHeight}`));
      const alt = (node.getAttribute('alt') ?? '').trim();
      rows.push(row('alt', alt || 'missing', alt ? 'ok' : 'warn'));
    }
    const svgRoot = node.tagName === 'svg' ? node : null;
    if (svgRoot?.getAttribute('viewBox')) rows.push(row('viewBox', svgRoot.getAttribute('viewBox')));

    const r = node.getBoundingClientRect(), s = sec.getBoundingClientRect();
    const off = r.left < s.left - 1 || r.top < s.top - 1 || r.right > s.right + 1 || r.bottom > s.bottom + 1;
    const clips = node.scrollHeight > node.clientHeight + 2 && cs.overflowY !== 'visible';
    rows.push(clips ? row('fit', `clips by ${Math.round(node.scrollHeight - node.clientHeight)}px`, 'warn')
      : off ? row('fit', 'runs off the slide', 'warn') : row('fit', 'fits', 'ok'));

    const file = fileFacts.slide === slideNo() ? fileFacts.data : null;
    const block = file?.blocks?.[target.index];
    if (block) rows.push(row('file', `${file.file} · lines ${span(block.lines)}`));
    return rows;
  }

  /** `ul · 5 items`, `svg · 14 nodes`, `figure.diagram`. */
  function describe(node) {
    const tag = node.tagName.toLowerCase();
    const cls = typeof node.className === 'string' ? node.className : node.getAttribute('class') ?? '';
    const first = cls.split(/\s+/).find((c) => c && !c.startsWith('dl-'));
    const name = first ? `${tag}.${first}` : tag;
    if (tag === 'ul' || tag === 'ol') return `${name} · ${node.querySelectorAll(':scope > li').length} items`;
    if (tag === 'table') return `${name} · ${node.querySelectorAll('tr').length} rows`;
    if (tag === 'svg') return `${name} · ${node.querySelectorAll('*').length} nodes`;
    return name;
  }

  /** The token the colour is, or its hex: `var(--fg)` says it follows the theme. */
  function colourName(raw, c) {
    const cs = getComputedStyle(root);
    const tokens = [];
    for (const name of KNOWN_TOKENS) tokens.push([name, cs.getPropertyValue(name)]);
    const rest = [];
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (name.startsWith('--') && !KNOWN_TOKENS.includes(name)) rest.push([name, cs.getPropertyValue(name)]);
    }
    rest.sort((a, b) => LAST.test(a[0]) - LAST.test(b[0]));
    tokens.push(...rest);
    const token = tokenFor(raw, tokens);
    const value = c[3] < 1 ? `${hex(c)} at ${Math.round(c[3] * 100)}%` : hex(c);
    return token ? `var(${token}) · ${value}` : value;
  }

  /** Which build step shows it: its own, the steps inside it, or none. */
  function buildOf(node) {
    const rec = inst()._records[slideNo() - 1];
    if (!rec?.groups.length) return 'always';
    const inside = [];
    for (let g = 0; g < rec.groups.length; g++) {
      for (const i of rec.groups[g]) {
        const el_ = rec.steps[i]?.el;
        if (!el_) continue;
        if (el_ === node || el_.contains(node)) return `appears on step ${g + 1}`;
        if (node.contains(el_)) inside.push(g + 1);
      }
    }
    if (!inside.length) return 'always';
    const lo = Math.min(...inside), hi = Math.max(...inside);
    return lo === hi ? `holds step ${lo}` : `holds steps ${lo}–${hi}`;
  }

  // ----- painting ------------------------------------------------------------

  /** From the selected block down to the node clicked in it. */
  function crumbs() {
    const chain = [];
    const deepest = target.clicked && target.top.contains(target.clicked) ? target.clicked : target.top;
    for (let n = deepest; n; n = n.parentElement) {
      chain.unshift(n);
      if (n === target.top) break;
    }
    return chain;
  }

  function crumbLabel(n) {
    if (!n.children.length) {
      const t = (n.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (t) return `"${t.length > 18 ? t.slice(0, 17) + '…' : t}"`;
    }
    return describe(n).split(' · ')[0];
  }

  function unhover() {
    hovered?.classList.remove('dl-inspect-hover');
    hovered = null;
  }

  function header(card) {
    const head = document.createElement('div');
    head.className = 'narr-head ins-head';
    const title = document.createElement('span');
    title.className = 'ins-title';
    const n = slideNo();
    const sec = sectionAt(n);
    if (!target) {
      title.textContent = `slide ${n} / ${inst().state.totalSlides} · ${sec ? slideTitle(sec, n - 1, '') : ''}`;
    } else {
      title.append(Object.assign(document.createElement('span'), { textContent: `slide ${n}` }));
      for (const node of crumbs()) {
        title.append(Object.assign(document.createElement('span'), { className: 'ins-sep', textContent: '›' }));
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ins-crumb' + (node === focus ? ' ins-on' : '');
        b.textContent = crumbLabel(node);
        b.addEventListener('mouseenter', () => { unhover(); hovered = node; node.classList.add('dl-inspect-hover'); });
        b.addEventListener('mouseleave', unhover);
        // stopped here: the render below detaches this button, and a click that
        // reached the slide from a detached node would read as a click on
        // nothing, which lets go of the selection (editbar.js)
        b.addEventListener('click', (e) => { e.stopPropagation(); focus = node; render(); });
        title.append(b);
      }
    }
    head.append(title);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'dk-btn ins-copy';
    copy.textContent = '⧉';
    copy.title = 'copy these facts';
    copy.setAttribute('aria-label', 'copy');
    copy.addEventListener('click', () => copyText(lastText));
    head.append(copy);
    head.append(dock.controls(close));
    dock.wireHeader(head);
    card.append(head);
  }

  function render() {
    if (!el) return;
    const n = slideNo();
    if (target && (!focus || !focus.isConnected || target.slide !== n)) { target = null; focus = null; }
    const card = el.querySelector('.narr-card');
    card.textContent = '';
    header(card);
    const rows = target ? elementRows() : slideRows();
    const grid = document.createElement('dl');
    grid.className = 'ins-rows';
    for (const r of rows) {
      const dt = Object.assign(document.createElement('dt'), { textContent: r.key });
      const dd = document.createElement('dd');
      if (r.mark) {
        dd.append(Object.assign(document.createElement('span'), {
          className: r.mark === 'ok' ? 'ins-ok' : 'ins-warn', textContent: r.mark === 'ok' ? '✓' : '!',
        }));
      }
      dd.append(Object.assign(document.createElement('span'), { className: 'ins-value', textContent: r.value }));
      if (r.extra) dd.append(Object.assign(document.createElement('span'), { className: 'ins-extra', textContent: r.extra }));
      dd.dataset.key = r.key;
      grid.append(dt, dd);
    }
    card.append(grid);
    let text = rows.map((r) => `${r.key}: ${r.mark === 'warn' ? '! ' : ''}${r.value}${r.extra ? ` (${r.extra})` : ''}`);
    if (!target) text = text.concat(sourcesSection(card, n));
    const where = target ? `slide ${n}, ${crumbs().map(crumbLabel).join(' › ')}` : `slide ${n}`;
    lastText = [where, ...text].join('\n');

    const foot = document.createElement('div');
    foot.className = 'narr-head ins-foot';
    foot.textContent = [
      !target && editmode()?.available?.() && 'e edits sources',
      target ? 'esc lets go of it' : 'esc closes',
    ].filter(Boolean).join(' · ');
    card.append(foot);
    if (!target) fetchAsync(n);
  }

  /** The slide's sources (SLIDE_SOURCES), read here; `e` opens their editor. */
  function sourcesSection(card, n) {
    const data = sourcesOf(sectionAt(n));
    const group = Object.assign(document.createElement('div'), { className: 'narr-group', textContent: 'sources' });
    card.append(group);
    if (!data) {
      card.append(Object.assign(document.createElement('div'), { className: 'ins-none', textContent: 'none' }));
      return ['sources: none'];
    }
    const lines = [];
    if (data.facts.length) {
      const dl = document.createElement('dl');
      dl.className = 'ins-rows src-facts';
      for (const [k, v] of data.facts) {
        dl.append(Object.assign(document.createElement('dt'), { textContent: k }));
        dl.append(Object.assign(document.createElement('dd'), { textContent: v }));
        lines.push(`${k}: ${v}`);
      }
      card.append(dl);
    }
    for (const link of data.links) {
      // an <a>, not a div with a click handler: a link people may want to open
      // in a new tab, copy, or middle-click is a link
      const a = document.createElement('a');
      a.className = 'narr-row ins-link';
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(Object.assign(document.createElement('span'), { className: 'narr-row-label', textContent: link.title }));
      if (link.note) a.append(Object.assign(document.createElement('span'), { className: 'narr-tag', textContent: link.note }));
      a.append(Object.assign(document.createElement('span'), { className: 'src-go', textContent: '↗' }));
      card.append(a);
      lines.push(`${link.title}: ${link.href}`);
    }
    return lines;
  }

  /** The two answers that need a round trip, once per slide. */
  function fetchAsync(n) {
    if (comments.slide !== n) {
      comments = { slide: n, data: undefined };
      Promise.resolve(review()?.countFor?.(n)).then((data) => {
        if (comments.slide !== n) return;
        comments.data = data ?? null;
        if (data && el && !target && slideNo() === n) render();
      }).catch(() => {});
    }
    const em = editmode();
    if (fileFacts.slide !== n && em?.available?.()) {
      fileFacts = { slide: n, data: null };
      fetch(`${em.base()}/deck/edit/inspect?slide=${n}`)
        .then((r) => r.json())
        .then((j) => {
          if (fileFacts.slide !== n || !j?.ok) return;
          fileFacts.data = j;
          if (el && slideNo() === n) render();
        })
        .catch(() => {});
    }
  }

  /** The slide moved or a build stepped: show where the deck is now. */
  function onSlide() {
    if (el) render();
  }

  function keydown(e) {
    if (e.key === 'Escape') {
      // a selection lets go first (editbar's Esc, below the overlays), which
      // brings the panel back to the slide; with nothing selected Esc closes
      if (target) return false;
      close();
      return true;
    }
    if ((e.key === 'e' || e.key === 'E') && !target && editmode()?.available?.()) {
      close();
      sources().edit();
      return true;
    }
    // everything else is the deck's: the panel is a reference beside it
    return false;
  }

  overlays.register({ isOpen, close, keydown, modal: false });
  return { open, close, isOpen, onSlide, text: () => lastText };
}
