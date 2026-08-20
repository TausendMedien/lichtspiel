/**
 * Lustspiel pattern engine — ported from reference/lustspiel-pattern-generator_7.html.
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

// ─── Colour ───────────────────────────────────────────────────────────────────
// Palette colours are hex strings ("#rrggbb"). Parsed once per string and cached,
// since a single paint() can call col() thousands of times.

const hexCache = new Map<string, [number, number, number]>();
function hexToRgb(hex: string): [number, number, number] {
  let c = hexCache.get(hex);
  if (c) return c;
  const n = parseInt(hex.slice(1), 16);
  c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  hexCache.set(hex, c);
  return c;
}

/** Linear blend between two hex colours, returned as a hex string — so the
 *  result stays parseable by hexToRgb()/col() if it is fed back in as a
 *  palette entry (as the Film/Default palette blend does). */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a), [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bch)}`;
}

/**
 * Picks a colour along the palette at position r (0..1). `softness` controls
 * whether that pick is a hard step (0, the original look) or a continuous
 * gradient across neighbouring palette entries (1, a soft blend).
 */
function col(r: number, pal: string[], softness: number): string {
  const n = pal.length;
  const pos = clamp(r, 0, 0.999999) * n;
  const i0 = Math.min(n - 1, Math.floor(pos));
  const [ar, ag, ab] = hexToRgb(pal[i0]);
  if (softness <= 0.001) return `rgb(${ar},${ag},${ab})`;
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = pos - i0;
  const [br, bg, bb] = hexToRgb(pal[i1]);
  const sr = ar + (br - ar) * frac, sg = ag + (bg - ag) * frac, sb = ab + (bb - ab) * frac;
  const r2 = Math.round(ar + (sr - ar) * softness);
  const g2 = Math.round(ag + (sg - ag) * softness);
  const b2 = Math.round(ab + (sb - ab) * softness);
  return `rgb(${r2},${g2},${b2})`;
}

/** Working state: the user state plus values derived once per paint(). */
interface Ctx extends EngineState {
  H: number;      // logical height
  keep: number;   // 1 = keep everything; < 1 thins elements out
  pal: string[];
  t: number;      // time offset fed into field()/intensity()/zoneU()
}

/**
 * Intensity: continuous variation, never zero — areas with more and less, no
 * holes. Coverage used to raise/lower this floor; it is fixed at its former
 * maximum (equivalent to Coverage = 1) since separately dimming existing marks
 * duplicated the app's own Brightness control.
 */
const INTENSITY_FLOOR = 0.82;
function intensity(x: number, y: number, o: Ctx): number {
  const v = field(x * 1.15 + 400, y * 1.15 + 400, o.seed + 50 + o.t) * 0.5 + 0.5;
  return INTENSITY_FLOOR + (1 - INTENSITY_FLOOR) * v;
}

// ─── Zones ────────────────────────────────────────────────────────────────────

/** Wide, flowing bands — the basis of the composition. */
function zoneU(x: number, y: number, o: Ctx): number {
  const s = o.seed + o.t;
  // leftRight/upDown promise one band per element, in order — so the band count
  // here is the element count, not Zones (Zones instead sets blob-cluster density
  // for comp="blobs", and repeat count for comp="bands" + arrangement="chaotic").
  const n = o.elems.length;
  // Strictness shrinks the edge noise toward 0 (a clean, near-straight split) as it
  // rises, and opens it up toward a wavier edge as it falls.
  const edgeNoise = 0.16 * (1 - o.strictness) * (1 - o.strictness);
  if (o.arrangement === "leftRight") {
    const u = x / DESIGN_W + field(x * 0.9, y * 1.6, o.seed + 210 + o.t) * edgeNoise;
    return clamp(u, 0, 0.9999) * n;
  }
  if (o.arrangement === "upDown") {
    const u = y / o.H + field(y * 0.9, x * 1.6, o.seed + 310 + o.t) * edgeNoise;
    return clamp(u, 0, 0.9999) * n;
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
 * border rather than blending into each other. Zones sets how many blob
 * clusters each element gets (more = finer, more scattered composition);
 * Interlock narrows the seam toward a soft blend as it rises.
 */
let _blobKey: string | null = null;
let _blobList: { x: number; y: number; slot: number }[] | null = null;

function blobCenters(o: Ctx) {
  // Arrangement, zones and the logical height all change where centres land, so
  // all belong in the cache key — otherwise a change appears to do nothing.
  const key = o.seed + "|" + o.elems.join(",") + "|" + o.arrangement + "|" + Math.round(o.H) + "|" + o.zones + "|" + o.strictness;
  if (_blobKey === key && _blobList) return _blobList;
  const n = o.elems.length;
  const perSlot = Math.max(1, Math.round(o.zones));
  const list: { x: number; y: number; slot: number }[] = [];
  for (let s = 0; s < n; s++) {
    for (let b = 0; b < perSlot; b++) {
      const rx = hash(s * 17 + b * 31 + 5, 7, o.seed + 200);
      const ry = hash(s * 23 + b * 13 + 9, 11, o.seed + 201);
      let x: number, y: number;
      // Strictness controls how far a cluster's centre may wander from the
      // middle of its own band, as a fraction of the band's half-width: at 0 it
      // commonly spills deep into neighbouring bands (a chaotic-looking split —
      // nearest-neighbour assignment near a spilled-over centre goes the "wrong"
      // way); at 1 it stays clustered near its own centre, safely away from any
      // boundary, giving an unambiguous split.
      const spreadFrac = 1.6 - 1.3 * o.strictness;
      if (o.arrangement === "leftRight") {
        const lo = s / n, hi = (s + 1) / n, mid = (lo + hi) / 2, halfW = (hi - lo) / 2;
        x = (mid + (rx * 2 - 1) * halfW * spreadFrac) * DESIGN_W;
        y = ry * o.H;
      } else if (o.arrangement === "upDown") {
        const lo = s / n, hi = (s + 1) / n, mid = (lo + hi) / 2, halfW = (hi - lo) / 2;
        y = (mid + (ry * 2 - 1) * halfW * spreadFrac) * o.H;
        x = rx * DESIGN_W;
      } else {
        x = rx * DESIGN_W;
        y = ry * o.H;
      }
      list.push({ x, y, slot: s });
    }
  }
  _blobKey = key; _blobList = list;
  return list;
}

function blobZone(x: number, y: number, o: Ctx, slot: number): boolean {
  const centers = blobCenters(o);
  // Left/Right and Up/Down promise a split along one axis. Nearest-neighbour
  // distance alone is blind to that — a point can sit firmly in the "top" half
  // by y, yet be 2D-closer to a "bottom" blob purely because of x. Strictness
  // discounts the off-axis distance component, so the search increasingly
  // becomes "nearest along the axis that matters" instead of "nearest in the
  // plane" — that is what actually makes the split unambiguous, more than
  // where the centres themselves sit.
  let wx = 1, wy = 1;
  if (o.arrangement === "leftRight") { const w = 1 - 0.92 * o.strictness; wy = w * w; }
  else if (o.arrangement === "upDown") { const w = 1 - 0.92 * o.strictness; wx = w * w; }
  let best = Infinity, bestSlot = -1, second = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i], dx = x - c.x, dy = y - c.y, d = dx * dx * wx + dy * dy * wy;
    if (d < best) { second = best; best = d; bestSlot = c.slot; }
    else if (d < second) { second = d; }
  }
  if (bestSlot !== slot) return false;
  const rDist = Math.sqrt(best), rSecond = Math.sqrt(second);
  const margin = (rSecond - rDist) / Math.max(rSecond, 1);
  // lock=0 → 0.06 (sharp seam, the original look); lock=1 → close to 0 (blobs
  // interlock almost seamlessly).
  const threshold = 0.06 * (1 - 0.85 * o.lock);
  return margin > threshold;
}

function inZone(x: number, y: number, o: Ctx, slot: number): boolean {
  if (o.elems.length === 1) return true;
  return (o.comp === "blobs") ? blobZone(x, y, o, slot) : bandZone(x, y, o, slot);
}

/**
 * Which element (by position in state.elems) a point belongs to. Exported for
 * tuning and tests — paint() itself never needs this, it calls inZone() per
 * element while drawing. Returns -1 if the point sits in no element's zone
 * (the dark seam between blobs).
 */
export function debugZoneSlot(x: number, y: number, logicalH: number, state: EngineState): number {
  const o: Ctx = {
    ...state,
    H: logicalH,
    keep: 1,
    pal: state.palette && state.palette.length ? state.palette : PHASE[state.phase].pal,
    t: state.time ?? 0,
  };
  for (let slot = 0; slot < o.elems.length; slot++) {
    if (inZone(x, y, o, slot)) return slot;
  }
  return -1;
}

// ─── Phases ───────────────────────────────────────────────────────────────────

export const PHASE: Record<PhaseId, Phase> = {
  A: { pal: ["#ffffff", "#ffffff", "#d6f7ff", "#4fe0ee", "#2aa6c4"], warp: 0.18, jit: 0.10, glow: 0 },
  B: { pal: ["#ffffff", "#d6f7ff", "#4fe0ee", "#b14cff", "#8a2be2"], warp: 0.75, jit: 0.35, glow: 0 },
  C: { pal: ["#f0dcff", "#c24bff", "#8a26c9", "#2a7e8c", "#155a66"], warp: 1.90, jit: 0.85, glow: 1 },
};

/**
 * Organic: blends the regular two-harmonic sine bend into an incoherent, two-
 * octave meander driven by field() — the same coherent noise the "wave" point
 * style uses for its flow. Both the shape AND the amplitude grow with the
 * slider, so high values read as genuinely wild rather than a same-size bend
 * in a different shape.
 */
function bendOf(base: number, px: number, py: number, amp: number, o: Ctx): number {
  let bent = base;
  if (o.organic > 0) {
    const w1 = field(px * 0.55, py * 0.55, o.seed + 130 + o.t);
    const w2 = field(px * 1.6 + 900, py * 1.6 + 900, o.seed + 140 + o.t);
    const wander = (w1 * 0.7 + w2 * 0.55) * amp * 2.4;
    bent = base * (1 - o.organic) + wander * o.organic;
  }
  // A gentle drift independent of Organic, so Speed (state.time) has a visible,
  // continuous effect on every element and style — even a hard sine bend at
  // Organic 0. Skipped for Lustspiel A/B/C (o.animated unset), whose time never
  // advances anyway, so this changes nothing for them.
  if (o.animated) {
    bent += field(px * 0.4 + 300, py * 0.4 + 300, o.seed + 170 + o.t) * amp * 0.30;
  }
  return bent;
}

// ─── Equal-impact calibration ──────────────────────────────────────────────────
// At identical Density/Stroke Width/Warp, the five drawing styles cover very
// different amounts of surface for purely geometric reasons (dot area grows with
// radius², strand coverage is far sparser than a 2D grid, etc.). These constants
// were fitted so that, at the default Stroke Width, every element lights a dancer
// with roughly the same strength — measured as average per-pixel brightness
// across many seeds. They sit between the user's Stroke Width and the raw radius/
// line-width formulas below, invisible as a separate control.
const IMPACT = {
  pointsGrid: 1.26,
  pointsWave: 1.26,
  /** A 1D chain of dots can't match a 2D grid's coverage without either much
   *  bigger dots or densely overlapping (and therefore wasted) placement — so
   *  the fix is split between the two: dots stay close to grid/wave size
   *  (moderately bigger, not ~1.6x as before) and are placed ~3.5x more
   *  densely along each strand. Both were fitted so Strands matches Grid's
   *  measured brightness at the shared default density. */
  pointsStrands: 1.41,
  pointsStrandsPlacement: 3.5,
  lines: 0.82,
  mesh: 1.24,
  rings: 0.91,
};

// ─── Elements ─────────────────────────────────────────────────────────────────

function elPoints(c: CanvasRenderingContext2D, P: Phase, o: Ctx, slot: number) {
  if (o.pointStyle === "strands") return elPointsStrands(c, P, o, slot);
  const sp = 26 / o.dens, style = o.pointStyle, H = o.H;
  const impact = style === "wave" ? IMPACT.pointsWave : IMPACT.pointsGrid;
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
        // Grid style has no other time-dependent term (unlike Wave's flow offset)
        // — add a gentle always-on drift so Speed still has a visible effect.
        if (o.animated) {
          const d = sp * 0.45;
          px += field(x * 0.02, y * 0.02, o.seed + 150 + o.t) * d;
          py += field(y * 0.02, x * 0.02, o.seed + 151 + o.t) * d;
        }
      }
      if (!inZone(px, py, o, slot)) continue;
      if (hash(x * 3.3, y * 4.4, o.seed + 77) > o.keep) continue;   // fewer elements, not dimmer
      const m = intensity(px, py, o);
      const sz = 0.40 + 0.60 * hash(x * 1.7, y * 2.3, o.seed + 9);
      const r = sp * 0.42 * (0.55 + 0.45 * m) * sz * o.stroke * impact;
      if (r < 0.5) continue;
      c.beginPath(); c.arc(px, py, r, 0, 6.2832);
      c.fillStyle = col(hash(x * 2.1, y * 1.3, o.seed + 21), o.pal, o.colorSoftness);
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
  // Radius uses the density-only spacing, unaffected by IMPACT_STRAND_PLACEMENT, so a
  // strand dot stays the same size as a grid/wave dot. The brightness this style is
  // missing (a 1D chain covers far less area than a 2D raster) is made up by placing
  // roughly twice as many dots per strand instead of making each dot bigger.
  const gapSize = Math.max(6, 30 / o.dens);
  const gapPlace = gapSize / IMPACT.pointsStrandsPlacement;
  let pos = -base, i = 0;
  while (pos < spanMain + base) {
    const r1 = hash(i * 3.1, 7.7, o.seed + 60), r2 = hash(i * 5.3, 11.1, o.seed + 62), r3 = hash(i * 9.1, 3.3, o.seed + 64);
    if (hash(i * 6.6, 2.2, o.seed + 78) > o.keep) { pos += base * (0.5 + r1 * 1.6); i++; continue; }
    const amp = P.warp * o.warp * (14 + r3 * 70) * 0.9;
    const f = 0.0016 + r1 * 0.0022, ph = r2 * 6.283;
    const gapR = gapSize * (0.6 + 0.8 * hash(i * 2.2, 4.4, o.seed + 81));
    const gapP = gapPlace * (0.6 + 0.8 * hash(i * 2.2, 4.4, o.seed + 81));
    let acc = gapP;
    for (let s = -10; s < spanSweep + 10; s += 7) {
      acc -= 7;
      if (acc > 0) continue;
      acc = gapP * (0.7 + 0.6 * hash(s * 0.3, i * 1.1, o.seed + 91));
      let bend = amp * Math.sin(s * f + ph) + amp * 0.35 * Math.sin(s * f * 2.7 + ph * 1.7);
      bend = bendOf(bend, horiz ? s : pos, horiz ? pos : s, amp, o);
      const px = horiz ? s : pos + bend, py = horiz ? pos + bend : s;
      if (!inZone(px, py, o, slot)) continue;
      const m = intensity(px, py, o);
      const sz = (0.40 + 0.60 * hash(s * 0.7, i * 3.3, o.seed + 95)) * (0.55 + 0.45 * m);
      const r = Math.max(0.5, gapR * 0.30 * sz * o.stroke * IMPACT.pointsStrands);
      c.beginPath(); c.arc(px, py, r, 0, 6.2832);
      c.fillStyle = col(hash(s * 1.1, i * 2.7, o.seed + 21), o.pal, o.colorSoftness);
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
    const lw0 = base * (0.20 + r2 * 0.55) * o.stroke * 1.9 * IMPACT.lines;
    const amp = P.warp * o.warp * (14 + r3 * 70);
    const f = 0.0016 + r1 * 0.0022, ph = r2 * 6.283;
    c.strokeStyle = col(r3, o.pal, o.colorSoftness);
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
  const org = o.organic > 0 ? cell * 0.9 * o.organic : 0;
  // Organic-gated wander (org) covers Organic > 0; this always-on term (drift)
  // gives Speed a visible effect at Organic 0 too, same rationale as bendOf().
  const drift = o.animated ? cell * 0.4 : 0;
  const nx = (i: number, k: number) => i * cell - cell * 0.5 + (hash(i * 1.7, k * 2.9, o.seed + 7) - 0.5) * j * 2
    + (org ? (field(i * cell * 0.5, k * cell * 0.5, o.seed + 130 + o.t) * 0.7
            + field(i * cell * 1.4 + 900, k * cell * 1.4 + 900, o.seed + 140 + o.t) * 0.5) * org : 0)
    + (drift ? field(i * cell * 0.5 + 700, k * cell * 0.5 + 700, o.seed + 160 + o.t) * drift : 0);
  const ny = (i: number, k: number) => k * cell - cell * 0.5 + (hash(k * 1.3, i * 3.7, o.seed + 13) - 0.5) * j * 2
    + (org ? (field(i * cell * 0.5 + 500, k * cell * 0.5 + 500, o.seed + 131 + o.t) * 0.7
            + field(i * cell * 1.4 + 1400, k * cell * 1.4 + 1400, o.seed + 141 + o.t) * 0.5) * org : 0)
    + (drift ? field(i * cell * 0.5 + 1700, k * cell * 0.5 + 1700, o.seed + 161 + o.t) * drift : 0);
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < cols; i++) {
      const ax = nx(i, k), ay = ny(i, k);
      if (!inZone(ax, ay, o, slot)) continue;
      if (hash(i * 4.4, k * 5.5, o.seed + 77) > o.keep) continue;
      const m = intensity(ax, ay, o);
      c.lineWidth = Math.max(0.6, cell * 0.171 * o.stroke * IMPACT.mesh * (0.55 + 0.45 * m));
      for (const d of [[1, 0], [0, 1]]) {
        const bx = nx(i + d[0], k + d[1]), by = ny(i + d[0], k + d[1]);
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by);
        c.strokeStyle = col(hash(i * 2.3, k * 4.1, o.seed + 17), o.pal, o.colorSoftness);
        c.globalAlpha = 0.35 + 0.65 * m;
        c.stroke();
      }
      c.beginPath(); c.arc(ax, ay, Math.max(0.6, cell * 0.209 * o.stroke * IMPACT.mesh * (0.55 + 0.45 * m)), 0, 6.2832);
      c.fillStyle = col(hash(k * 2.3, i * 4.1, o.seed + 19), o.pal, o.colorSoftness);
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
    c.strokeStyle = col(r2, o.pal, o.colorSoftness);
    c.lineWidth = Math.max(0.6, step * (0.16 + r1 * 0.45) * o.stroke * IMPACT.rings * 1.52 * (0.55 + 0.45 * m));
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
    // Fewer elements, not darker — applies in every phase now (Thinning used to
    // be forced off in B; that was the prototype's stylistic default, not a
    // constraint, and B is thinnable like A/C now).
    keep: 1 - state.pk / 100,
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

  // Applied to every drawImage pass below (not via a separate final pass —
  // drawing a canvas onto itself to re-filter it is unreliable across browsers).
  const brightness = state.brightness ?? 1;
  const brightnessFilter = Math.abs(brightness - 1) > 0.001 ? ` brightness(${Math.max(0, brightness) * 100}%)` : "";

  if (P.glow) {                        // one blur pass instead of shadowBlur per shape
    ctx.filter = `blur(${8 * scale}px)${brightnessFilter}`;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(layer, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
  }
  const soft = state.softness ?? 0;
  if (soft > 0) {
    // Soft mode: a wide blur pass carries most of the weight as softness rises,
    // the crisp layer underneath fades but never disappears — small, sub-pixel
    // drifts stay visible as a gentle glow instead of vanishing between hard
    // edges. Purely a compositing blend; the geometry above is untouched.
    const blurPx = (2 + soft * 16) * scale;
    ctx.filter = `blur(${blurPx}px)${brightnessFilter}`;
    ctx.globalAlpha = 0.35 + soft * 0.45;
    ctx.drawImage(layer, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1 - soft * 0.55;
  }
  if (brightnessFilter) ctx.filter = brightnessFilter.trim();
  ctx.drawImage(layer, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
}
