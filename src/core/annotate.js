// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Ink annotations (W pen / ⇧W laser) — SPEC §8. A <canvas> sibling of the
// stage, above the slides and below the corner chrome / captions / pickers.
// Strokes are stored in DESIGN coordinates and redrawn at the engine's
// current scale, so a window resize never drifts them off their slide
// positions. Ephemeral by design: cleared on every slide change, never
// persisted; ?print exclusion is by construction — the engine simply never
// creates the annotator there (the clock/progress pattern).

const TRAIL_MS = 300;   // laser afterglow lifetime
const PEN_WIDTH = 3.5;  // design px

/** Pointer position → design coordinates. `rect` is the stage's bounding
 *  box (its on-screen size already includes the scale transform), `scale`
 *  the engine's design→screen factor (instance._scale). */
export function toDesignCoords(clientX, clientY, rect, scale) {
  const s = scale || 1;
  return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
}

/** Drop laser-trail points older than `ttl` ms. Pure; does not mutate. */
export function pruneTrail(points, now, ttl = TRAIL_MS) {
  return points.filter((p) => now - p.t < ttl);
}

export function createAnnotator(instance, root) {
  const stage = root.querySelector(':scope > .decklight-stage');
  let canvas = null, ctx = null;
  let tool = null;      // null | 'pen' | 'laser'
  let strokes = [];     // committed pen strokes: { color, points: [{x, y}] }
  let live = null;      // the stroke under the pointer right now
  let trail = [];       // laser afterglow: { x, y, t }
  let laserAt = null;   // the dot itself — stays put while the tool is on
  let raf = 0;

  // read LIVE, per stroke and per laser frame: switching themes recolors
  // the next stroke without touching the ones already on the slide
  const accent = () =>
    getComputedStyle(root).getPropertyValue('--accent').trim() || '#fff';
  const designPoint = (e) =>
    toDesignCoords(e.clientX, e.clientY, stage.getBoundingClientRect(), instance._scale);

  function redraw() {
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rootBox = root.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const s = instance._scale || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // design coordinates from here on
    ctx.setTransform(dpr * s, 0, 0, dpr * s,
      (box.left - rootBox.left) * dpr, (box.top - rootBox.top) * dpr);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = PEN_WIDTH;
    for (const st of live ? [...strokes, live] : strokes) {
      if (!st.points.length) continue;
      ctx.strokeStyle = st.color;
      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (const p of st.points) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    if (tool === 'laser' && laserAt) {
      const color = accent();
      const now = performance.now();
      ctx.fillStyle = color;
      for (const p of trail) {
        const a = 1 - (now - p.t) / TRAIL_MS;
        ctx.globalAlpha = a * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + 4 * a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowColor = color;
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(laserAt.x, laserAt.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // fade loop — runs only while trail points remain, then rests on the dot
  function tick() {
    raf = 0;
    trail = pruneTrail(trail, performance.now());
    redraw();
    if (trail.length) raf = requestAnimationFrame(tick);
  }
  const startLoop = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function down(e) {
    if (tool !== 'pen' || e.button > 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }
    live = { color: accent(), points: [designPoint(e)] };
    redraw();
    e.preventDefault();
  }
  function move(e) {
    if (tool === 'pen' && live) {
      live.points.push(designPoint(e));
      redraw();
    } else if (tool === 'laser') {
      laserAt = designPoint(e);
      trail.push({ ...laserAt, t: performance.now() });
      startLoop();
    }
  }
  function up() {
    if (!live) return;
    strokes.push(live);
    live = null;
  }

  function resize() {
    const box = root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    redraw();
  }

  function mount() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'decklight-annotate';
    canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(canvas);
    ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    // the canvas only receives touches while a tool is on — keep them from
    // reaching the root's swipe-navigation handler mid-drawing
    canvas.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    resize();
    // re-fit on every root resize; the redraw waits a frame so the engine's
    // own ResizeObserver (same root) has updated _scale and the stage
    // transform first — that is what keeps strokes glued through a rescale
    new ResizeObserver(() => { resize(); requestAnimationFrame(redraw); }).observe(root);
  }

  /** Toggle a tool ('pen' by default). Asking for the other tool switches
   *  to it; asking for the active one turns ink off. Returns the new tool. */
  function toggle(next = 'pen') {
    tool = tool === next ? null : next;
    if (tool) mount();
    if (canvas) {
      canvas.classList.toggle('tool-pen', tool === 'pen');
      canvas.classList.toggle('tool-laser', tool === 'laser');
    }
    if (live) { strokes.push(live); live = null; }
    if (tool !== 'laser') {
      trail = [];
      laserAt = null;
      if (ctx) redraw();
    }
    return tool;
  }

  function clear() {
    strokes = [];
    live = null;
    trail = [];
    laserAt = null;
    if (ctx) redraw();
  }

  /** Draw a stroke from design-coordinate points — the headless-harness and
   *  demo-driver hook (no pointer events to synthesize). */
  function stroke(points) {
    mount();
    strokes.push({ color: accent(), points: points.map((p) => ({ x: p.x, y: p.y })) });
    redraw();
  }

  instance.on('slide', clear); // annotations belong to the slide they were drawn on

  return {
    toggle,
    laser: () => toggle('laser'),
    clear,
    stroke,
    get tool() { return tool; },
    get active() { return tool !== null; },
  };
}
