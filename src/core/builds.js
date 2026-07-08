// Builds engine — SPEC §2.
// The container opts in; the engine claims children. A step is either a DOM
// element or one unit of a registered provider's count.

const CONTAINER_TAGS = new Set(['UL', 'OL', 'TABLE', 'TBODY', 'DL', 'SVG']);
const SVG_SKIP = new Set(['defs', 'title', 'desc', 'style', 'metadata']);

// element → provider registration ({count, apply, label}), shared across instances.
export const providerRegistry = new Map();

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

function prepareDraw(el) {
  const shapes = el.matches?.(STROKED) ? [el] : [...el.querySelectorAll(STROKED)];
  let anyStroke = false;
  for (const s of shapes) {
    const stroke = s.getAttribute('stroke') ?? getComputedStyle(s).stroke;
    if (!stroke || stroke === 'none') continue;
    let len = 0;
    try { len = s.getTotalLength(); } catch { continue; }
    if (!len) continue;
    anyStroke = true;
    // The draw CSS overrides stroke-dasharray with the path length; remember an
    // authored dasharray so it can be restored once the draw completes.
    const orig = s.getAttribute('stroke-dasharray') || s.style.strokeDasharray;
    if (orig) s.dataset.drawOrig = orig;
    // Markers (arrowheads) are not part of the dash pattern: they'd sit fully
    // visible at the endpoint while the stroke is still drawing toward it.
    // Stash them; they re-attach the moment the draw completes.
    for (const [attr, key] of MARKER_ATTRS) {
      const v = s.getAttribute(attr);
      if (v) s.dataset[key] = v;
    }
    s.classList.add('draw-stroke');
    s.style.setProperty('--draw-len', String(Math.ceil(len)));
  }
  // Non-stroke content (text, filled shapes) fades while strokes draw.
  const others = el.querySelectorAll('text, tspan');
  others.forEach((o) => o.classList.add('draw-fade'));
  if (!anyStroke) el.setAttribute('data-build-style', 'fade'); // spec: fallback
}

const MARKER_ATTRS = [
  ['marker-start', 'drawMarkerStart'],
  ['marker-mid', 'drawMarkerMid'],
  ['marker-end', 'drawMarkerEnd'],
];
function setMarkers(s, on) {
  for (const [attr, key] of MARKER_ATTRS) {
    if (!(key in s.dataset)) continue;
    if (on) s.setAttribute(attr, s.dataset[key]);
    else s.removeAttribute(attr);
  }
}

/**
 * Sync draw completion state: restore an authored stroke-dasharray after the
 * draw animation (inline styles beat the draw CSS once the step is done), and
 * attach markers (arrowheads) only when the stroke has fully drawn — a marker
 * is not part of the dash pattern and would otherwise sit at the endpoint
 * before the line reaches it. Both are cleared again when the step returns to
 * pending, so un-building re-arms the draw.
 */
function syncDrawRestore(el, state) {
  for (const s of el.querySelectorAll('.draw-stroke')) {
    const orig = s.dataset.drawOrig;
    const hasMarkers = MARKER_ATTRS.some(([, key]) => key in s.dataset);
    if (!orig && !hasMarkers) continue;
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
        if (el.getAttribute('data-build-state') !== 'pending') {
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
    const provider = providerRegistry.get(el);
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
