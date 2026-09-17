// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Builds engine — SPEC BUILDS.
// The container opts in; the engine claims children. A step is either a DOM
// element or one unit of a registered provider's count.

const CONTAINER_TAGS = new Set(['UL', 'OL', 'TABLE', 'TBODY', 'DL', 'SVG']);
const SVG_SKIP = new Set(['defs', 'title', 'desc', 'style', 'metadata']);

// element → provider registration ({count, apply, label}), shared across instances.
const providerRegistry = new Map();

export function registerProvider(el, provider) {
  providerRegistry.set(el, provider);
}

function eligibleChildren(el) {
  return [...el.children].filter((c) => {
    const tag = c.tagName.toLowerCase();
    if (SVG_SKIP.has(tag)) return false;
    if (tag === 'aside' && c.classList.contains('notes')) return false;
    if (c.hasAttribute('data-build-stay')) return false;
    return true;
  });
}

// Container vs leaf: fixed tags are always containers; div/g are containers
// only with ≥2 eligible children (resolves the spec's "one g is a leaf");
// data-build-self forces leaf.
function isContainer(el) {
  if (el.hasAttribute('data-build-self')) return false;
  const tag = el.tagName.toUpperCase();
  if (CONTAINER_TAGS.has(tag)) return true;
  if (tag === 'DIV' || tag === 'G') return eligibleChildren(el).length >= 2;
  return false;
}

function stepSource(el) {
  const tag = el.tagName.toUpperCase();
  if (tag === 'TABLE') {
    const tbody = el.querySelector(':scope > tbody');
    return tbody ? eligibleChildren(tbody) : eligibleChildren(el).filter((c) => c.tagName === 'TR');
  }
  return eligibleChildren(el);
}

// Pure sequencing: items = [{key, explicit}] in document/emission order.
// Returns groups of item indices. Only explicit steps sharing a key merge.
export function computeGroups(items) {
  const indexed = items.map((it, i) => ({ ...it, i }));
  indexed.sort((a, b) => a.key - b.key || a.i - b.i);
  const groups = [];
  let cur = null;
  let curKey = null;
  let curExplicit = false;
  for (const it of indexed) {
    if (cur && it.explicit && curExplicit && it.key === curKey) {
      cur.push(it.i);
      continue;
    }
    cur = [it.i];
    curKey = it.key;
    curExplicit = it.explicit;
    groups.push(cur);
  }
  return groups;
}

function markStep(el, style) {
  el.classList.add('build-step');
  el.setAttribute('data-build-style', style);
  el.setAttribute('data-build-state', 'pending');
  if (style === 'draw') prepareDraw(el);
}

const STROKED = 'path, line, polyline, polygon, circle, ellipse, rect';
const SVG_NS = 'http://www.w3.org/2000/svg';

function prepareDraw(el) {
  const shapes = el.matches?.(STROKED) ? [el] : [...el.querySelectorAll(STROKED)];
  let anyStroke = false;
  for (const s of shapes) {
    if (prepareStroke(s)) anyStroke = true;
  }
  // Non-stroke content (text, filled shapes) fades while strokes draw.
  const others = el.querySelectorAll('text, tspan');
  others.forEach((o) => o.classList.add('draw-fade'));
  if (!anyStroke) el.setAttribute('data-build-style', 'fade'); // spec: fallback
}

/**
 * One stroke, made drawable: its length measured, its authored dasharray
 * remembered, its arrowheads turned into heads that ride the tip (below) or,
 * where that is not possible, stashed until the draw completes. Idempotent —
 * `sync()` rescans a slide, and a stroke prepared twice would grow a second
 * head. Returns whether the shape has a stroke to draw at all.
 */
function prepareStroke(s) {
  if (s.classList.contains('draw-stroke')) return true;
  const stroke = s.getAttribute('stroke') ?? getComputedStyle(s).stroke;
  if (!stroke || stroke === 'none') return false;
  let len = 0;
  try { len = s.getTotalLength(); } catch { return false; }
  if (!len) return false;
  // The draw CSS overrides stroke-dasharray with the path length; remember an
  // authored dasharray so it can be restored once the draw completes.
  const orig = s.getAttribute('stroke-dasharray') || s.style.strokeDasharray;
  if (orig) s.dataset.drawOrig = orig;
  s.classList.add('draw-stroke');
  s.style.setProperty('--draw-len', String(Math.ceil(len)));
  s._drawLen = len; // exact — the frame loop measures against it, the CSS rounds up
  // Markers are not part of the dash pattern: left on the stroke they would
  // sit fully visible at the endpoint while the line is still drawing toward
  // it. The end (and start) marker becomes a HEAD — a copy of the marker's
  // content placed at the drawing tip by the same frame loop that moves the
  // tip, the way Keynote's Line Draw carries an arrowhead (#522). A marker
  // that cannot become a head (marker-mid; a marker on a rect or a circle,
  // whose geometry is not a path) is stashed and re-attached on completion.
  for (const [attr, key] of MARKER_ATTRS) {
    const v = s.getAttribute(attr);
    if (v) s.dataset[key] = v;
  }
  const endHead = ridable(s) && buildHead(s, 'marker-end', 'end');
  const startHead = ridable(s) && buildHead(s, 'marker-start', 'start');
  const ridden = endHead || startHead;
  if (ridden) {
    // this stroke is drawn by the frame loop, not by the CSS transition: the
    // two would drift apart, and the head must sit on the tip every frame
    s.style.transition = 'none';
    s.style.strokeDasharray = String(len);
    setDrawn(s, 0, len);
  }
  return true;
}

const MARKER_ATTRS = [
  ['marker-start', 'drawMarkerStart'],
  ['marker-mid', 'drawMarkerMid'],
  ['marker-end', 'drawMarkerEnd'],
];
function setMarkers(s, on) {
  for (const [attr, key] of MARKER_ATTRS) {
    if (!(key in s.dataset)) continue;
    // a marker that rides as a head is never put back: the head IS the marker
    if (s._drawHeads?.[key === 'drawMarkerEnd' ? 'end' : key === 'drawMarkerStart' ? 'start' : 'mid']) continue;
    if (on) s.setAttribute(attr, s.dataset[key]);
    else s.removeAttribute(attr);
  }
}

// ── the head that rides the tip ───────────────────────────────────────────

/** Only a shape whose geometry is a path can carry a head along it. */
const ridable = (s) => /^(path|line|polyline|polygon)$/i.test(s.tagName) && typeof s.getPointAtLength === 'function';

/** Attributes a `<marker>` may carry that its content inherits. */
const MARKER_PRESENTATION = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'color', 'style', 'class'];

/**
 * Turn the marker `attr` references into a head: a `<g class="draw-head">`
 * after the stroke holding a copy of the marker's content, scaled and offset
 * once the way the marker would be (markerUnits, viewBox, refX/refY), then
 * placed each frame by `placeHead`. Returns whether a head was built.
 */
function buildHead(s, attr, which) {
  const ref = s.getAttribute(attr);
  const idM = ref && /url\(\s*["']?#([^"')\s]+)["']?\s*\)/.exec(ref);
  if (!idM) return false;
  const svg = s.ownerSVGElement;
  const marker = svg?.querySelector(`[id="${CSS.escape(idM[1])}"]`) ?? document.getElementById(idM[1]);
  if (!marker || marker.tagName.toLowerCase() !== 'marker') return false;
  const num = (name, dflt) => { const v = parseFloat(marker.getAttribute(name)); return Number.isFinite(v) ? v : dflt; };
  const sw = parseFloat(getComputedStyle(s).strokeWidth) || 1;
  let scale = (marker.getAttribute('markerUnits') ?? 'strokeWidth') === 'userSpaceOnUse' ? 1 : sw;
  const vb = marker.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) scale *= Math.min(num('markerWidth', 3) / vb.width, num('markerHeight', 3) / vb.height);
  const orient = (marker.getAttribute('orient') ?? '0').trim();
  const auto = orient === 'auto' || orient === 'auto-start-reverse';
  const head = document.createElementNS(SVG_NS, 'g');
  head.setAttribute('class', 'draw-head');
  head.setAttribute('aria-hidden', 'true');
  const inner = document.createElementNS(SVG_NS, 'g');
  inner.setAttribute('transform', `scale(${scale}) translate(${-num('refX', 0)} ${-num('refY', 0)})`);
  for (const a of MARKER_PRESENTATION) if (marker.hasAttribute(a)) inner.setAttribute(a, marker.getAttribute(a));
  const strokeColor = getComputedStyle(s).stroke;
  const fillColor = getComputedStyle(s).fill;
  for (const child of marker.children) {
    const clone = child.cloneNode(true);
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      el.removeAttribute('id'); // the original keeps its id; a copy with it would collide
      // a marker painted with the stroke it sits on takes that stroke's color
      for (const a of ['fill', 'stroke']) {
        const v = el.getAttribute(a);
        if (v === 'context-stroke') el.setAttribute(a, strokeColor);
        else if (v === 'context-fill') el.setAttribute(a, fillColor);
      }
    }
    inner.appendChild(clone);
  }
  head.appendChild(inner);
  head.style.visibility = 'hidden';
  s.after(head);
  s._drawHeads ??= {};
  s._drawHeads[which] = {
    el: head,
    // the stroke's own transform applies to the head too: they share a parent
    prefix: s.getAttribute('transform') ? `${s.getAttribute('transform')} ` : '',
    angle: auto ? null : (parseFloat(orient) || 0),
    reverse: orient === 'auto-start-reverse' && which === 'start',
  };
  // the marker itself leaves the stroke for good; the head stands in for it
  s.removeAttribute(attr);
  return true;
}

/** The point and the tangent angle (degrees) at `d` along the stroke. */
function alongStroke(s, d, len) {
  const at = Math.max(0, Math.min(len, d));
  const p = s.getPointAtLength(at);
  const a = s.getPointAtLength(Math.max(0, at - 0.5));
  const b = s.getPointAtLength(Math.min(len, at + 0.5));
  return { x: p.x, y: p.y, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
}

function placeHead(s, head, d, len) {
  const { x, y, angle } = alongStroke(s, d, len);
  const rot = head.angle ?? (angle + (head.reverse ? 180 : 0));
  head.el.setAttribute('transform', `${head.prefix}translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)})`);
}

/**
 * Set how much of the stroke is drawn, instantly: the dash offset, and the
 * heads — the end head on the tip, the start head at the start, both hidden
 * while nothing is drawn and the end head then parked at the far end, which
 * is where print and the overview (they force every stroke fully drawn) will
 * show it.
 */
function setDrawn(s, d, len) {
  s.style.strokeDashoffset = String(Math.max(0, len - d));
  s._drawnLen = d;
  const heads = s._drawHeads ?? {};
  const shown = d > 0;
  if (heads.end) {
    placeHead(s, heads.end, shown ? d : (s._drawFinal ?? len), len);
    heads.end.el.style.visibility = shown ? '' : 'hidden';
  }
  if (heads.start) {
    placeHead(s, heads.start, 0, len);
    heads.start.el.style.visibility = shown ? '' : 'hidden';
  }
}

/** CSS `ease` — cubic-bezier(.25, .1, .25, 1) — solved for progress `t`. */
function ease(t) {
  const bx = (u) => 3 * 0.25 * u * (1 - u) * (1 - u) + 3 * 0.25 * u * u * (1 - u) + u * u * u;
  const by = (u) => 3 * 0.1 * u * (1 - u) * (1 - u) + 3 * u * u * (1 - u) + u * u * u;
  let lo = 0; let hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (bx(m) < t) lo = m; else hi = m; }
  return by((lo + hi) / 2);
}

/**
 * The pace a stroke with stops draws at when the author names none: design
 * units per second. A 300 px stage takes a second — about what Keynote's
 * Line Draw gives a build — where the flat draw duration (660 ms, most of
 * it in the first quarter second) read as a swoosh rather than growth.
 */
const STOPS_SPEED = 300;

/**
 * How long a draw of `dist` path units takes, in ms: the CSS draw duration
 * (`--build-duration` × 2.2, read off the head so print, the overview,
 * `decklight-no-anim` and reduced motion zero it exactly as they zero the
 * stroke's own transition), or a pace in path units per second —
 * `data-draw-speed` when the author sets one, `STOPS_SPEED` for a stroke
 * that draws in stages — so a longer stage takes longer. The default pace
 * never goes below the flat duration: a short stage is a normal draw, not a
 * flicker. An explicit speed is the author's, exactly.
 */
function drawDuration(s, dist) {
  const probe = s._drawHeads?.end?.el ?? s._drawHeads?.start?.el ?? s;
  const base = parseFloat(getComputedStyle(probe).transitionDuration) * 1000 || 0;
  if (!base) return 0;
  const speed = parseFloat(s.getAttribute('data-draw-speed'));
  if (speed > 0) return dist / speed * 1000;
  if (s._drawStops) return Math.max(base, dist / STOPS_SPEED * 1000);
  return base;
}

/**
 * Draw the stroke to `target` path units: instantly when animation is off,
 * else over the draw duration from wherever it is now — a build reversed
 * mid-draw retracts from the tip's current position, no snap — with the
 * heads riding every frame. `onDone` runs when the target is reached.
 */
function driveDraw(s, target, len, onDone) {
  const from = s._drawnLen ?? 0;
  if (s._drawAnim) { cancelFrame(s._drawAnim); s._drawAnim = null; }
  const dur = drawDuration(s, Math.abs(target - from));
  if (!dur || from === target) { setDrawn(s, target, len); onDone?.(); return; }
  // the heads show for the whole trip, including a retract that ends hidden
  for (const h of Object.values(s._drawHeads ?? {})) h.el.style.visibility = '';
  if (from === 0 && s._drawHeads?.end) placeHead(s, s._drawHeads.end, 0, len);
  const t0 = performance.now();
  const tick = (now) => {
    const f = Math.min(1, (now - t0) / dur);
    const d = from + (target - from) * ease(f);
    if (f < 1) {
      s.style.strokeDashoffset = String(Math.max(0, len - d));
      s._drawnLen = d;
      for (const [which, h] of Object.entries(s._drawHeads ?? {})) placeHead(s, h, which === 'end' ? d : 0, len);
      s._drawAnim = nextFrame(tick);
    } else {
      s._drawAnim = null;
      setDrawn(s, target, len);
      onDone?.();
    }
  };
  s._drawAnim = nextFrame(tick);
}

const strokeLen = (s) => s._drawLen ?? (parseFloat(s.style.getPropertyValue('--draw-len')) || 0);

/**
 * The next frame — by requestAnimationFrame when the browser paints, by a
 * timer when it does not: headless Chrome under a virtual-time budget (every
 * render this project makes) advances timers but never begins a frame, and a
 * draw that waited on one would never finish. Whichever fires first runs the
 * tick; the other is a no-op. Returns a handle `cancelFrame` takes.
 */
function nextFrame(fn) {
  const h = { done: false, raf: 0, timer: 0 };
  const once = () => { if (h.done) return; h.done = true; fn(performance.now()); };
  h.raf = requestAnimationFrame(once);
  h.timer = setTimeout(once, 40);
  return h;
}
function cancelFrame(h) {
  if (!h) return;
  h.done = true;
  cancelAnimationFrame(h.raf);
  clearTimeout(h.timer);
}

/**
 * Sync draw completion state: restore an authored stroke-dasharray after the
 * draw animation (inline styles beat the draw CSS once the step is done), and
 * attach stashed markers only when the stroke has fully drawn — a marker is
 * not part of the dash pattern and would otherwise sit at the endpoint before
 * the line reaches it. Both are cleared again when the step returns to
 * pending, so un-building re-arms the draw. A stroke with a riding head is
 * driven here rather than by the CSS transition (`driveDraw`).
 */
function syncDrawRestore(el, state) {
  for (const s of el.querySelectorAll('.draw-stroke')) syncStroke(s, state);
  if (el.matches?.('.draw-stroke')) syncStroke(el, state);
}

function syncStroke(s, state) {
  const orig = s.dataset.drawOrig;
  const hasMarkers = MARKER_ATTRS.some(([, key]) => key in s.dataset);
  if (s._drawHeads) {
    const len = strokeLen(s);
    if (state === 'pending') {
      if (orig) s.style.strokeDasharray = String(len);
      setMarkers(s, false);
      driveDraw(s, 0, len);
    } else {
      driveDraw(s, len, len, () => {
        if (orig) { s.style.strokeDasharray = orig; s.style.strokeDashoffset = '0'; }
        setMarkers(s, true);
      });
    }
    return;
  }
  if (!orig && !hasMarkers) return;
  if (state === 'done') {
    if (orig) { s.style.strokeDasharray = orig; s.style.strokeDashoffset = '0'; }
    setMarkers(s, true);
  } else if (state === 'pending') {
    s.style.removeProperty('stroke-dasharray');
    s.style.removeProperty('stroke-dashoffset');
    setMarkers(s, false);
  } else {
    // current: let the CSS dash-offset animation run (a dashed stroke draws
    // as a solid line, then snaps to its authored dashes on completion).
    s.style.removeProperty('stroke-dasharray');
    s.style.removeProperty('stroke-dashoffset');
    setMarkers(s, false);
    const restore = () => {
      if (s.closest('.build-step')?.getAttribute('data-build-state') !== 'pending') {
        if (orig) { s.style.strokeDasharray = orig; s.style.strokeDashoffset = '0'; }
        setMarkers(s, true);
      }
    };
    const dur = parseFloat(getComputedStyle(s).transitionDuration) || 0;
    if (dur === 0) {
      // transitions disabled (print, reduced-motion): restore synchronously
      restore();
    } else {
      s.addEventListener('transitionend', restore, { once: true });
      setTimeout(restore, dur * 1000 + 150); // safety net if the event is lost
    }
  }
}

// ── one stroke, several build steps (data-draw-stops) ─────────────────────

/**
 * `data-draw-stops="347 542 767"` — path lengths, or fractions of the total
 * when every value is ≤ 1 (or written with `%`) — turns one stroke into as
 * many build steps: step k draws to stop k, the head riding each stage, a
 * reversed build retracting stage by stage. It is a build provider like any
 * other (BUILD_PROVIDER_API): `apply(k)` is idempotent, so a deep link or
 * back-nav lands on the right stop, instantly under `decklight-no-anim`.
 */
export function parseDrawStops(attr, len) {
  const raw = String(attr ?? '').trim().split(/[\s,]+/).filter(Boolean);
  const nums = raw.map((t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)));
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n < 0)) return [];
  const fractions = raw.some((t) => t.endsWith('%')) || nums.every((n) => n <= 1);
  return nums.map((n) => Math.min(len, fractions ? n * len : n));
}

function drawStopsProvider(s) {
  if (!ridable(s) || !prepareStroke(s)) return null;
  const len = strokeLen(s);
  const stops = parseDrawStops(s.getAttribute('data-draw-stops'), len);
  if (!stops.length) return null;
  if (!s._drawHeads) {
    // no marker to ride, but the stages are still the frame loop's to draw
    s.style.transition = 'none';
    s.style.strokeDasharray = String(len);
    s._drawHeads = {};
    setDrawn(s, 0, len);
  }
  s._drawFinal = stops[stops.length - 1];
  s._drawStops = true; // paced by length, not the flat duration (drawDuration)
  setDrawn(s, 0, len);
  return {
    count: stops.length,
    apply(k) {
      const target = k > 0 ? stops[Math.min(k, stops.length) - 1] : 0;
      const orig = s.dataset.drawOrig;
      if (orig && target < len) s.style.strokeDasharray = String(len);
      driveDraw(s, target, len, () => {
        if (orig && target >= len) { s.style.strokeDasharray = orig; s.style.strokeDashoffset = '0'; }
      });
    },
    label: (i) => `draw to stop ${i}`,
  };
}

/**
 * Scan one slide. Returns a record:
 *   { steps: [{kind:'dom', el, container} | {kind:'provider', provider, el, sub}],
 *     groups: [[stepIdx…]…], providers: [{el, provider, first, count}] }
 */
export function scanSlide(section) {
  const steps = [];
  const items = []; // {key, explicit} parallel to steps
  const claimed = new Set();
  let auto = 0;

  const push = (step, orderAttr) => {
    const explicit = orderAttr != null && orderAttr !== '';
    const key = explicit ? parseInt(orderAttr, 10) : auto;
    steps.push(step);
    items.push({ key: Number.isFinite(key) ? key : auto, explicit });
    auto++;
  };

  const walker = document.createTreeWalker(section, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (claimed.has(el)) continue;
    let provider = providerRegistry.get(el);
    // a stroke that draws in stages (#522) is a provider of its own making
    if (!provider && el.hasAttribute('data-draw-stops')) {
      provider = drawStopsProvider(el);
      if (provider) registerProvider(el, provider);
    }
    if (provider) {
      for (let sub = 0; sub < provider.count; sub++) {
        push({ kind: 'provider', provider, el, sub }, null);
      }
      // provider element subtree is opaque to further build scanning
      el.querySelectorAll('*').forEach((d) => claimed.add(d));
      continue;
    }
    if (!el.hasAttribute('data-build')) continue;
    const style = el.getAttribute('data-build') || 'fade';
    if (isContainer(el)) {
      for (const child of stepSource(el)) {
        claimed.add(child);
        // a claimed child's own subtree is not re-scanned for builds
        child.querySelectorAll('[data-build]').forEach((d) => claimed.add(d));
        // a child stroke drawing in stages contributes its stops, not one step
        if (child.hasAttribute('data-draw-stops')) {
          const stops = providerRegistry.get(child) ?? drawStopsProvider(child);
          if (stops) {
            registerProvider(child, stops);
            for (let sub = 0; sub < stops.count; sub++) push({ kind: 'provider', provider: stops, el: child, sub }, null);
            continue;
          }
        }
        const childStyle = child.getAttribute('data-build') || style;
        markStep(child, childStyle);
        push({ kind: 'dom', el: child, container: el }, child.getAttribute('data-build-order'));
      }
      el.setAttribute('data-build-container', '');
    } else {
      markStep(el, style);
      push({ kind: 'dom', el, container: null }, el.getAttribute('data-build-order'));
    }
  }

  const groups = computeGroups(items);

  // provider bookkeeping: first group index covering each provider
  const providers = [];
  const seen = new Map();
  steps.forEach((s, i) => {
    if (s.kind !== 'provider') return;
    if (!seen.has(s.provider)) {
      const rec = { el: s.el, provider: s.provider, stepIdxs: [] };
      seen.set(s.provider, rec);
      providers.push(rec);
    }
    seen.get(s.provider).stepIdxs.push(i);
  });

  return { steps, groups, providers };
}

/**
 * Apply build state for `step` groups revealed (0 = nothing).
 * Idempotent; providers are called with their own revealed count.
 */
export function applyBuildState(record, step) {
  const revealedSteps = new Set();
  record.groups.forEach((group, g) => {
    for (const idx of group) if (g < step) revealedSteps.add(idx);
  });
  const currentGroup = step > 0 ? record.groups[step - 1] ?? [] : [];
  const currentSet = new Set(currentGroup);

  const touchedContainers = new Set();
  record.steps.forEach((s, i) => {
    if (s.kind !== 'dom') return;
    const state = currentSet.has(i) ? 'current' : revealedSteps.has(i) ? 'done' : 'pending';
    s.el.setAttribute('data-build-state', state);
    if (s.el.getAttribute('data-build-style') === 'draw') syncDrawRestore(s.el, state);
    if (s.container) touchedContainers.add(s.container);
  });
  // highlight style: container dims siblings while one step is current
  for (const c of touchedContainers) {
    const hasCurrentHl = !!c.querySelector(':scope [data-build-style="highlight"][data-build-state="current"]');
    c.classList.toggle('has-current-highlight', hasCurrentHl);
  }

  for (const p of record.providers) {
    const k = p.stepIdxs.filter((i) => revealedSteps.has(i) || currentSet.has(i)).length;
    if (p._last !== k) {
      p._last = k;
      p.provider.apply(k);
    }
  }
}

/** Speaker-view step labels for a slide record. */
export function stepLabels(record) {
  return record.groups.map((group) => {
    const s = record.steps[group[0]];
    if (s.kind === 'provider') {
      const sub = s.sub;
      return s.provider.label ? s.provider.label(sub + 1) : 'step';
    }
    const text = s.el.textContent.trim().replace(/\s+/g, ' ');
    return text.slice(0, 60) || s.el.tagName.toLowerCase();
  });
}
