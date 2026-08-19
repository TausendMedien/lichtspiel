/**
 * Lustspiel pattern engine — ported from reference/lustspiel-pattern-generator_7.html.
 *
 * Two deliberate changes against the prototype:
 *  - The fixed H = 1080 became a logical height derived from the output aspect
 *    ratio. DESIGN_W stays 1920 so the stroke-width-to-millimetres-on-the-body
 *    calibration keeps its meaning; nothing is stretched or cropped.
 *  - `organic` and `layout` were added. Both are inert at their defaults.
 *
 * Determinism: hash() decides identity and existence, field()/intensity()/zoneU()
 * decide shape and distribution. Time may only ever enter the latter three —
 * feeding it into hash() makes the image boil frame to frame (photosensitivity).
 */

import type { EngineState, ElementId, PhaseId, Phase } from "./types";

/** Fixed logical width. The height follows the output aspect ratio. */
export const DESIGN_W = 1920;

// ─── Basics ───────────────────────────────────────────────────────────────────

export function hash(x: number, y: number, s: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** -1 .. 1 — the coherent field. Seed (and later time) enters as a phase offset. */
export function field(x: number, y: number, s: number): number {
  return 0.55 * Math.sin(x * 0.0031 + y * 0.0014 + s)
       + 0.30 * Math.sin(y * 0.0052 - x * 0.0017 + s * 1.7)
       + 0.15 * Math.sin((x + y) * 0.0089 + s * 2.3);
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Working state: the user state plus values derived once per paint(). */
interface Ctx extends EngineState {
  H: number;      // logical height
  keep: number;   // 1 = keep everything; < 1 thins elements out (A/C)
  pal: string[];
  t: number;      // time offset fed into field()/intensity()/zoneU()
}

/**
 * Intensity: continuous variation, never zero — areas with more and less, no holes.
 * Coverage raises the floor.
 */
function intensity(x: number, y: number, o: Ctx): number {
  const v = field(x * 1.15 + 400, y * 1.15 + 400, o.seed + 50 + o.t) * 0.5 + 0.5;
  const floor = clamp(0.22 + 0.60 * o.occ, 0.22, 0.88);
  return floor + (1 - floor) * v;
}

// ─── Zones ────────────────────────────────────────────────────────────────────

/** Wide, flowing bands — the basis of the composition. */
function zoneU(x: number, y: number, o: Ctx): number {
  const s = o.seed + o.t;
  if (o.layout === "sideBySide") {
    // Vertical stripes side by side, edge perturbed so it never reads as a ruler line.
    const u = x / DESIGN_W + field(x * 0.9, y * 1.6, o.seed + 210 + o.t) * 0.06;
    return clamp(u, 0, 0.9999) * o.zones;
  }
  const a = Math.sin(x * 0.0019 + Math.sin(y * 0.0030 + s) * 1.8 + s * 0.7);
  const b = Math.sin(y * 0.0034 - x * 0.0010 + s * 1.3);
  const t = clamp((a * 0.68 + b * 0.42) / 1.05, -1, 1);
  return (t * 0.5 + 0.5) * o.zones;
}

function bandZone(x: number, y: number, o: Ctx, slot: number): boolean {
  const n = o.elems.length;
  const u = zoneU(x, y, o), fl = Math.floor(u);
  let idx = fl % n; if (idx < 0) idx += n;
  if (idx === slot) return true;
  if (o.lock > 0) {
    const f = u - fl, d = Math.min(f, 1 - f), band = 0.32 * o.lock;
    if (d < band) {
      const nb = (f < 0.5) ? ((idx - 1 + n) % n) : ((idx + 1) % n);
      if (nb === slot) return hash(x * 0.7, y * 0.9, o.seed + 5) < (1 - d / band) * 0.85;
    }
  }
  return false;
}

/**
 * Blobs: amorphous cells instead of straight bands, with a dark seam at the
 * border rather than blending into each other.
 */
let _blobKey: string | null = null;
let _blobList: { x: number; y: number; slot: number }[] | null = null;

function blobCenters(o: Ctx) {
  // The layout and the logical height change where centres land, so both belong
  // in the cache key — otherwise switching arrangement appears to do nothing.
  const key = o.seed + "|" + o.elems.join(",") + "|" + o.layout + "|" + Math.round(o.H);
  if (_blobKey === key && _blobList) return _blobList;
  const n = o.elems.length, list: { x: number; y: number; slot: number }[] = [], perSlot = 2;
  for (let s = 0; s < n; s++) {
    for (let b = 0; b < perSlot; b++) {
      const rx = hash(s * 17 + b * 31 + 5, 7, o.seed + 200);
      let x: number;
      if (o.layout === "sideBySide") {
        // Slot s owns the horizontal band [s/n, (s+1)/n], widened by 15 % on each
        // side so the seam meanders instead of sitting on a straight line.
        const lo = s / n, hi = (s + 1) / n, over = (hi - lo) * 0.15;
        x = (lo - over + rx * (hi - lo + 2 * over)) * DESIGN_W;
      } else {
        x = rx * DESIGN_W;
      }
      list.push({ x, y: hash(s * 23 + b * 13 + 9, 11, o.seed + 201) * o.H, slot: s });
    }
  }
  _blobKey = key; _blobList = list;
  return list;
}

function blobZone(x: number, y: number, o: Ctx, slot: number): boolean {
  const centers = blobCenters(o);
  let best = Infinity, bestSlot = -1, second = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i], dx = x - c.x, dy = y - c.y, d = dx * dx + dy * dy;
    if (d < best) { second = best; best = d; bestSlot = c.slot; }
    else if (d < second) { second = d; }
  }
  if (bestSlot !== slot) return false;
  const rDist = Math.sqrt(best), rSecond = Math.sqrt(second);
  const margin = (rSecond - rDist) / Math.max(rSecond, 1);
  return margin > 0.06;                          // dark seam instead of blending
}

function inZone(x: number, y: number, o: Ctx, slot: number): boolean {
  if (o.elems.length === 1) return true;
  return (o.comp === "blobs") ? blobZone(x, y, o, slot) : bandZone(x, y, o, slot);
}

// ─── Phases ───────────────────────────────────────────────────────────────────

export const PHASE: Record<PhaseId, Phase> = {
  A: { pal: ["#ffffff", "#ffffff", "#d6f7ff", "#4fe0ee", "#2aa6c4"], warp: 0.18, jit: 0.10, dir: +1, glow: 0 },
  B: { pal: ["#ffffff", "#d6f7ff", "#4fe0ee", "#b14cff", "#8a2be2"], warp: 0.75, jit: 0.35, dir:  0, glow: 0 },
  C: { pal: ["#f0dcff", "#c24bff", "#8a26c9", "#2a7e8c", "#155a66"], warp: 1.90, jit: 0.85, dir: -1, glow: 1 },
};

const col = (r: number, pal: string[]) => pal[Math.min(pal.length - 1, Math.floor(r * pal.length))];

/**
 * Organic: blends the regular two-harmonic sine bend into an incoherent meander
 * driven by the same field() the "wave" point style already uses. It changes the
 * shape of a strand, never whether it exists — so it is safe to animate.
 */
function bendOf(base: number, px: number, py: number, amp: number, o: Ctx): number {
  if (o.organic <= 0) return base;
  const wander = field(px * 0.6, py * 0.6, o.seed + 130 + o.t) * amp * 1.6;
  return base * (1 - o.organic) + wander * o.organic;
}

// ─── Elements ─────────────────────────────────────────────────────────────────

function elPoints(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  if (o.pointStyle === "strands") return elPointsStrands(c, P, o, slot);
  const sp = 26 / o.dens, style = o.pointStyle, H = o.H;
  for (let y = sp * 0.5; y < H + sp; y += sp) {
    for (let x = sp * 0.5; x < DESIGN_W + sp; x += sp) {
      let px: number, py: number;
      if (style === "wave") {
        const flow = field(x * 0.9, y * 0.9, o.seed + 80 + o.t) * 34;   // coarse coherent drift
        px = x + (hash(x, y, o.seed) - 0.5) * sp * 0.18;
        py = y + flow + (hash(y, x, o.seed + 3) - 0.5) * sp * 0.18;
      } else {
        const j = P.jit * o.warp * sp;
        px = x + (hash(x, y, o.seed) - 0.5) * j;
        py = y + (hash(y, x, o.seed + 3) - 0.5) * j * 1.4;
      }
      if (!inZone(px, py, o, slot)) continue;
      if (hash(x * 3.3, y * 4.4, o.seed + 77) > o.keep) continue;   // fewer elements, not dimmer
      const m = intensity(px, py, o);
      const sz = 0.40 + 0.60 * hash(x * 1.7, y * 2.3, o.seed + 9);
      const r = sp * 0.42 * (0.55 + 0.45 * m) * sz * o.stroke;
      if (r < 0.5) continue;
      c.beginPath(); c.arc(px, py, r, 0, 6.2832);
      c.fillStyle = col(hash(x * 2.1, y * 1.3, o.seed + 21), o.pal);
      c.globalAlpha = 0.55 + 0.45 * m;
      c.fill();
    }
  }
  c.globalAlpha = 1;
}

/**
 * Strand point style: chains of dots along the same bent paths as element 2 —
 * independent strands that may cross and overlap.
 */
function elPointsStrands(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  const horiz = (o.lineDir === "h");
  const base = 22 / o.dens;
  const spanMain = horiz ? o.H : DESIGN_W, spanSweep = horiz ? DESIGN_W : o.H;
  let pos = -base, i = 0;
  while (pos < spanMain + base) {
    const r1 = hash(i * 3.1, 7.7, o.seed + 60), r2 = hash(i * 5.3, 11.1, o.seed + 62), r3 = hash(i * 9.1, 3.3, o.seed + 64);
    if (hash(i * 6.6, 2.2, o.seed + 78) > o.keep) { pos += base * (0.5 + r1 * 1.6); i++; continue; }
    const amp = P.warp * o.warp * (14 + r3 * 70) * 0.9;
    const f = 0.0016 + r1 * 0.0022, ph = r2 * 6.283;
    const gap = Math.max(6, 30 / o.dens) * (0.6 + 0.8 * hash(i * 2.2, 4.4, o.seed + 81));
    let acc = gap;
    for (let s = -10; s < spanSweep + 10; s += 7) {
      acc -= 7;
      if (acc > 0) continue;
      acc = gap * (0.7 + 0.6 * hash(s * 0.3, i * 1.1, o.seed + 91));
      let bend = amp * Math.sin(s * f + ph) + amp * 0.35 * Math.sin(s * f * 2.7 + ph * 1.7);
      bend = bendOf(bend, horiz ? s : pos, horiz ? pos : s, amp, o);
      const px = horiz ? s : pos + bend, py = horiz ? pos + bend : s;
      if (!inZone(px, py, o, slot)) continue;
      const m = intensity(px, py, o);
      const sz = (0.40 + 0.60 * hash(s * 0.7, i * 3.3, o.seed + 95)) * (0.55 + 0.45 * m);
      const r = Math.max(0.5, gap * 0.30 * sz * o.stroke);
      c.beginPath(); c.arc(px, py, r, 0, 6.2832);
      c.fillStyle = col(hash(s * 1.1, i * 2.7, o.seed + 21), o.pal);
      c.globalAlpha = 0.55 + 0.45 * m;
      c.fill();
    }
    pos += base * (0.5 + r1 * 1.6); i++;
  }
  c.globalAlpha = 1;
}

function elLines(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  const horiz = (o.lineDir === "h");
  const base = 13 / o.dens;
  const spanMain = horiz ? o.H : DESIGN_W, spanSweep = horiz ? DESIGN_W : o.H;
  let pos = -base, i = 0;
  while (pos < spanMain + base) {
    const r1 = hash(i * 3.1, 7.7, o.seed), r2 = hash(i * 5.3, 11.1, o.seed + 2), r3 = hash(i * 9.1, 3.3, o.seed + 4);
    if (hash(i * 6.6, 2.2, o.seed + 77) > o.keep) { pos += base * (0.5 + r1 * 1.7); i++; continue; }
    const lw0 = base * (0.20 + r2 * 0.55) * o.stroke * 1.9;
    const amp = P.warp * o.warp * (14 + r3 * 70);
    const f = 0.0016 + r1 * 0.0022, ph = r2 * 6.283;
    c.strokeStyle = col(r3, o.pal);
    c.beginPath(); let open = false;
    for (let s = -8; s <= spanSweep + 8; s += 5) {
      let bend = amp * Math.sin(s * f + ph) + amp * 0.35 * Math.sin(s * f * 2.7 + ph * 1.7);
      bend = bendOf(bend, horiz ? s : pos, horiz ? pos : s, amp, o);
      const px = horiz ? s : pos + bend, py = horiz ? pos + bend : s;
      if (inZone(px, py, o, slot)) { open ? c.lineTo(px, py) : (c.moveTo(px, py), open = true); }
      else open = false;
    }
    const m = intensity(horiz ? spanSweep * 0.5 : pos, horiz ? pos : spanSweep * 0.5, o);
    c.lineWidth = Math.max(0.6, lw0 * (0.55 + 0.45 * m));
    c.globalAlpha = (0.45 + 0.55 * m);
    c.stroke();
    pos += base * (0.5 + r1 * 1.7); i++;
  }
  c.globalAlpha = 1;
}

function elMesh(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  const cell = 58 / o.dens;
  const cols = Math.ceil(DESIGN_W / cell) + 2, rows = Math.ceil(o.H / cell) + 2;
  const j = cell * 0.30 * (0.4 + P.jit * o.warp);
  const org = o.organic > 0 ? cell * 0.55 * o.organic : 0;
  const nx = (i: number, k: number) => i * cell - cell * 0.5 + (hash(i * 1.7, k * 2.9, o.seed + 7) - 0.5) * j * 2
    + (org ? field(i * cell * 0.6, k * cell * 0.6, o.seed + 130 + o.t) * org : 0);
  const ny = (i: number, k: number) => k * cell - cell * 0.5 + (hash(k * 1.3, i * 3.7, o.seed + 13) - 0.5) * j * 2
    + (org ? field(i * cell * 0.6 + 500, k * cell * 0.6 + 500, o.seed + 131 + o.t) * org : 0);
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < cols; i++) {
      const ax = nx(i, k), ay = ny(i, k);
      if (!inZone(ax, ay, o, slot)) continue;
      if (hash(i * 4.4, k * 5.5, o.seed + 77) > o.keep) continue;
      const m = intensity(ax, ay, o);
      c.lineWidth = Math.max(0.6, cell * 0.171 * o.stroke * (0.55 + 0.45 * m));
      for (const d of [[1, 0], [0, 1]]) {
        const bx = nx(i + d[0], k + d[1]), by = ny(i + d[0], k + d[1]);
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by);
        c.strokeStyle = col(hash(i * 2.3, k * 4.1, o.seed + 17), o.pal);
        c.globalAlpha = 0.35 + 0.65 * m;
        c.stroke();
      }
      c.beginPath(); c.arc(ax, ay, Math.max(0.6, cell * 0.209 * o.stroke * (0.55 + 0.45 * m)), 0, 6.2832);
      c.fillStyle = col(hash(k * 2.3, i * 4.1, o.seed + 19), o.pal);
      c.globalAlpha = 0.65 + 0.35 * m; c.fill();
    }
  }
  c.globalAlpha = 1;
}

function elRings(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  const H = o.H;
  const cx = DESIGN_W * (0.28 + hash(1, 2, o.seed) * 0.44), cy = H * (0.28 + hash(3, 4, o.seed) * 0.44);
  const maxR = Math.hypot(Math.max(cx, DESIGN_W - cx), Math.max(cy, H - cy));
  const step = 17 / o.dens;
  let r = step, i = 0;
  while (r < maxR) {
    const r1 = hash(i * 2.7, 5.5, o.seed + 6), r2 = hash(i * 4.3, 9.9, o.seed + 8);
    if (hash(i * 8.8, 1.1, o.seed + 77) > o.keep) { r += step * (0.6 + r2 * 1.1); i++; continue; }
    const amp = P.warp * o.warp * r * 0.085;
    const m = intensity(cx, cy - r, o);
    c.strokeStyle = col(r2, o.pal);
    c.lineWidth = Math.max(0.6, step * (0.16 + r1 * 0.45) * o.stroke * 1.52 * (0.55 + 0.45 * m));
    c.globalAlpha = (0.40 + 0.60 * m);
    c.beginPath(); let open = false;
    for (let a = 0; a <= 6.31; a += 0.035) {
      let rr = r + amp * Math.sin(a * 3 + r * 0.01) + amp * 0.4 * Math.sin(a * 7 + r * 0.02);
      const px0 = cx + Math.cos(a) * rr, py0 = cy + Math.sin(a) * rr;
      rr = bendOf(rr - r, px0, py0, amp, o) + r;
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      const inb = px > -20 && px < DESIGN_W + 20 && py > -20 && py < H + 20;
      if (inb && inZone(px, py, o, slot)) { open ? c.lineTo(px, py) : (c.moveTo(px, py), open = true); }
      else open = false;
    }
    c.stroke();
    r += step * (0.6 + r2 * 1.1); i++;
  }
  c.globalAlpha = 1;
}

type ElementFn = (c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) => void;
const RENDER: Record<ElementId, ElementFn> = { 1: elPoints, 2: elLines, 3: elMesh, 4: elRings };

// ─── Composition ──────────────────────────────────────────────────────────────

let layer: HTMLCanvasElement | null = null;

/**
 * Draws one frame. `scale` maps the logical space onto the output buffer,
 * `logicalH` is DESIGN_W / aspect — so nothing is stretched or cropped.
 */
export function paint(
  ctx: CanvasRenderingContext2D,
  scale: number,
  logicalH: number,
  state: EngineState,
): void {
  const P = PHASE[state.phase];
  const o: Ctx = {
    ...state,
    H: logicalH,
    // A/C: fewer elements, not darker.
    keep: state.phase === "B" ? 1 : (1 - state.pk / 100),
    pal: state.palette && state.palette.length ? state.palette : P.pal,
    t: state.time ?? 0,
  };
  const w = DESIGN_W * scale, h = logicalH * scale;

  if (!layer) layer = document.createElement("canvas");
  layer.width = Math.max(1, Math.round(w));
  layer.height = Math.max(1, Math.round(h));
  const c = layer.getContext("2d");
  if (!c) return;

  c.setTransform(scale, 0, 0, scale, 0, 0);
  c.clearRect(0, 0, DESIGN_W, logicalH);
  c.globalCompositeOperation = "lighter";
  c.lineCap = "round"; c.lineJoin = "round";
  o.elems.forEach((el, slot) => RENDER[el](c, P, o, slot));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);

  if (P.glow) {                        // one blur pass instead of shadowBlur per shape
    ctx.filter = "blur(" + (8 * scale) + "px)";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(layer, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(layer, 0, 0);

  // Gradient: extra directional darkening in A/C only — capped at 40 %.
  if (P.dir !== 0 && o.grad > 0) {
    const amt = Math.min(0.4, o.grad * 0.4);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    if (P.dir > 0) { g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + amt + ")"); }
    else           { g.addColorStop(0, "rgba(0,0,0," + amt + ")"); g.addColorStop(1, "rgba(0,0,0,0)"); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}
