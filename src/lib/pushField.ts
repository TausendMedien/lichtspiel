// Pure numeric core of the "Push Away" heat mode — no THREE, no Svelte state, so
// it can be reasoned about (and tested) on its own. See heatField.ts for the
// texture plumbing that feeds it and hands the result to the shaders.
//
// The model: a displacement field with memory. Motion pushes each cell; the push
// then relaxes exponentially back to rest and diffuses sideways, so a swept gap
// closes gradually from its edges instead of snapping shut.
//
// Two forces write into it, and they behave very differently:
//
//   Push Strength — integrates the heat map's GRADIENT. The gradient is strongest
//   at the rim of a moving shape and near zero in its middle, so this nudges things
//   out of the way and builds up over repeated passes. Soft, cumulative.
//
//   Solidity — treats whatever the camera reads as "you" as a solid object and
//   VACATES it: every covered cell is displaced to the nearest free cell, found
//   with a vector distance transform. One sweep of a hand carves a clean empty
//   path, because the middle of the hand pushes just as hard as its edge.
//
// Displacements are stored in screen-height fractions (0.1 = a tenth of the screen
// height), so Solidity can mean something exact: 1.0 evicts a ball exactly to the
// edge of your silhouette.

export const HEAT_W = 160;
export const HEAT_H = 90;
export const HEAT_N = HEAT_W * HEAT_H;

/** Motion below this per-pixel delta is camera noise, not a person. */
export const NOISE_FLOOR = 0.008;
/** Per-frame rise/fall of the smoothed motion map. */
export const SMOOTH_ALPHA = 0.18;
/** Gradient → push integration rate (per second at pushStrength 1). */
export const PUSH_ACC = 6.0;
/** Ceiling on gradient-accumulated displacement (× pushStrength), in screen heights.
 *  Without it, standing in frame integrates the same gradient forever and eventually
 *  flings everything off screen. */
export const PUSH_MAX_BASE = 0.115;
/** Ceiling on eviction displacement (× solidity), in screen heights. */
export const MAX_EVICT = 0.5;
/** How fast `spread` pulls each cell toward its blurred neighbourhood, per second. */
export const SPREAD_RATE = 5.0;
/** Blurred-heat level (before Heat Gain) that counts as "solid body" for eviction. */
export const OCCUPANCY = 0.35;

export interface PushOpts {
  /** How hard the heat GRADIENT shoves the field — soft and cumulative. 0 = off. */
  pushStrength: number;
  /** How solid your silhouette is. 1 = a covered cell is displaced exactly to the
   *  edge of the silhouette, so one sweep clears the area. 0 = gradient only. */
  solidity: number;
  /** Relaxation back to rest, per second. Lower = the gap stays open longer. */
  returnSpeed: number;
  /** Lateral diffusion — neighbours roll back in from the sides. */
  spread: number;
  /** Viewport aspect (w/h) — the field is stored per screen-height, so the
   *  horizontal component of a cell offset has to be scaled by it. */
  aspect: number;
  /** Pattern's Heat Gain: amplifies the gradient term and sets what counts as solid. */
  heatGain: number;
  /** Pattern's Heat Strength: scales the gradient term (Solidity ignores it). */
  heatStrength: number;
}

/**
 * Separable box blur. src → (H pass) → tmp → (V pass) → dst.
 * O(W*H) per pass via a sliding window sum — safe at 60 fps.
 */
export function boxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  // Horizontal pass: src → tmp
  for (let y = 0; y < HEAT_H; y++) {
    const yo = y * HEAT_W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, HEAT_W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < HEAT_W; x++) {
      if (x + r < HEAT_W)  { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0)  { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  // Vertical pass: tmp → dst
  for (let x = 0; x < HEAT_W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, HEAT_H - 1); k++) { sum += tmp[k * HEAT_W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < HEAT_H; y++) {
      if (y + r < HEAT_H)  { sum += tmp[(y + r) * HEAT_W + x];     cnt++; }
      if (y - r - 1 >= 0)  { sum -= tmp[(y - r - 1) * HEAT_W + x]; cnt--; }
      dst[y * HEAT_W + x] = sum / cnt;
    }
  }
}

/** Smooth the raw camera diff in place: noise floor removed, then eased over frames. */
export function smoothHeat(raw: Float32Array, smoothed: Float32Array) {
  for (let i = 0; i < HEAT_N; i++) {
    smoothed[i] = smoothed[i] * (1 - SMOOTH_ALPHA) + Math.max(0, raw[i] - NOISE_FLOOR) * SMOOTH_ALPHA;
  }
}

/**
 * Central difference of the blurred heat map, in texture (u,v) space — the same
 * vector the Attract path applies instantly, so both modes displace the same way.
 */
export function heatGradient(heat: Float32Array, x: number, y: number): [number, number] {
  const xl = x > 0 ? x - 1 : 0;
  const xr = x < HEAT_W - 1 ? x + 1 : HEAT_W - 1;
  const yd = y > 0 ? y - 1 : 0;
  const yu = y < HEAT_H - 1 ? y + 1 : HEAT_H - 1;
  const row = y * HEAT_W;
  return [
    heat[row + xr] - heat[row + xl],
    heat[yu * HEAT_W + x] - heat[yd * HEAT_W + x],
  ];
}

const INF = 1e9;

/**
 * Vector distance transform (8SSEDT, two sweeps, O(n)): for every cell inside the
 * mask, the offset **in cells** to the nearest cell outside it. That offset is the
 * shortest way out of your silhouette — which is exactly where a ball you are
 * standing on has to go. Cells outside the mask get (0,0); cells with no reachable
 * free cell (mask fills the frame) keep INF and are skipped by the caller.
 */
export function evictionOffsets(mask: Uint8Array, dx: Float32Array, dy: Float32Array) {
  for (let i = 0; i < HEAT_N; i++) {
    if (mask[i]) { dx[i] = INF; dy[i] = INF; } else { dx[i] = 0; dy[i] = 0; }
  }

  // Take the neighbour's route to its nearest free cell, plus the step to reach it.
  const cmp = (i: number, x: number, y: number, ox: number, oy: number) => {
    const nx = x + ox, ny = y + oy;
    if (nx < 0 || nx >= HEAT_W || ny < 0 || ny >= HEAT_H) return;
    const ni = ny * HEAT_W + nx;
    const cx = dx[ni] + ox, cy = dy[ni] + oy;
    if (cx * cx + cy * cy < dx[i] * dx[i] + dy[i] * dy[i]) { dx[i] = cx; dy[i] = cy; }
  };

  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      const i = y * HEAT_W + x;
      cmp(i, x, y, -1, 0); cmp(i, x, y, 0, -1); cmp(i, x, y, -1, -1); cmp(i, x, y, 1, -1);
    }
    for (let x = HEAT_W - 2; x >= 0; x--) cmp(y * HEAT_W + x, x, y, 1, 0);
  }
  for (let y = HEAT_H - 1; y >= 0; y--) {
    for (let x = HEAT_W - 1; x >= 0; x--) {
      const i = y * HEAT_W + x;
      cmp(i, x, y, 1, 0); cmp(i, x, y, 0, 1); cmp(i, x, y, 1, 1); cmp(i, x, y, -1, 1);
    }
    for (let x = 1; x < HEAT_W; x++) cmp(y * HEAT_W + x, x, y, -1, 0);
  }
}

// Scratch for the eviction pass — one pattern is active at a time and the buffers
// never outlive a single call, so module-level is safe and avoids per-frame garbage.
let _mask: Uint8Array | null = null;
let _edx:  Float32Array | null = null;
let _edy:  Float32Array | null = null;

/**
 * Advance the push field by dt: apply the gradient shove and the solid-body
 * eviction, relax toward rest, clamp, then diffuse. `fx`/`fy` are updated in
 * place; `tmpA`/`tmpB` are scratch.
 */
export function stepPushField(
  heat: Float32Array,
  fx: Float32Array, fy: Float32Array,
  tmpA: Float32Array, tmpB: Float32Array,
  dt: number, opts: PushOpts,
) {
  // Gradient term, converted into screen-height fractions: the old chain was
  // grad · gain · strength · halfH, and world = field · 2 · halfH downstream.
  const acc   = opts.pushStrength * PUSH_ACC * dt * opts.heatGain * opts.heatStrength * 0.5;
  // Exponential relaxation, framerate independent.
  const keep  = Math.exp(-opts.returnSpeed * dt);
  const blend = opts.spread > 0 ? Math.min(1, opts.spread * SPREAD_RATE * dt) : 0;
  const max   = Math.max(opts.pushStrength * PUSH_MAX_BASE, opts.solidity * MAX_EVICT);

  // Solid-body eviction: mark everything the camera reads as "you", then find the
  // way out of it for every covered cell.
  const evicting = opts.solidity > 0;
  if (evicting) {
    if (!_mask) { _mask = new Uint8Array(HEAT_N); _edx = new Float32Array(HEAT_N); _edy = new Float32Array(HEAT_N); }
    const thr = OCCUPANCY / Math.max(opts.heatGain, 0.001);
    for (let i = 0; i < HEAT_N; i++) _mask[i] = heat[i] > thr ? 1 : 0;
    evictionOffsets(_mask, _edx!, _edy!);
  }
  // Cell offsets → screen-height fractions. The offset points INTO the free area,
  // and the shaders read the field in the same flipped space as the heat gradient,
  // so the displacement is its negation (see heatDisplace in heatField.ts).
  const evX = -opts.solidity * opts.aspect / HEAT_W;
  const evY = -opts.solidity / HEAT_H;

  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      const i = y * HEAT_W + x;
      const [gx, gy] = heatGradient(heat, x, y);
      let vx = fx[i] + gx * acc;
      let vy = fy[i] + gy * acc;

      // A solid body wins over whatever the gradient had managed so far: you can't
      // leave a ball sitting inside your own silhouette.
      if (evicting && _mask![i] && _edx![i] < INF) {
        const ex = _edx![i] * evX, ey = _edy![i] * evY;
        if (ex * ex + ey * ey > vx * vx + vy * vy) { vx = ex; vy = ey; }
      }

      vx *= keep;
      vy *= keep;
      // Clamp so a long sustained push can't run away.
      const m = Math.hypot(vx, vy);
      if (m > max) { const s = max / m; vx *= s; vy *= s; }
      fx[i] = vx;
      fy[i] = vy;
    }
  }

  // Diffusion: the edge of the gap softens and neighbouring cells creep inward, so
  // the floor closes up gradually instead of the gap popping shut.
  if (blend > 0) {
    boxBlur(fx, tmpA, tmpB, 1);
    for (let i = 0; i < HEAT_N; i++) fx[i] += (tmpB[i] - fx[i]) * blend;
    boxBlur(fy, tmpA, tmpB, 1);
    for (let i = 0; i < HEAT_N; i++) fy[i] += (tmpB[i] - fy[i]) * blend;
  }
}
