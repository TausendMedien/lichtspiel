// Pure numeric core of the "Push Away" heat mode — no THREE, no Svelte state, so
// it can be reasoned about (and tested) on its own. See heatField.ts for the
// texture plumbing that feeds it and hands the result to the shaders.
//
// The model: a displacement field with memory. Motion integrates a push into each
// cell; the push then relaxes exponentially back to rest and diffuses sideways, so
// a swept gap closes gradually from its edges instead of snapping shut.

export const HEAT_W = 160;
export const HEAT_H = 90;
export const HEAT_N = HEAT_W * HEAT_H;

/** Motion below this per-pixel delta is camera noise, not a person. */
export const NOISE_FLOOR = 0.008;
/** Per-frame rise/fall of the smoothed motion map. */
export const SMOOTH_ALPHA = 0.18;
/** Gradient → push integration rate (per second at pushStrength 1). */
export const PUSH_ACC = 6.0;
/** Ceiling on accumulated displacement (× pushStrength), in raw-gradient units.
 *  Sized so a fully-charged push lands in the same order of magnitude as a strong
 *  instantaneous gradient — otherwise Push Away would fling particles off screen
 *  at Heat Gain settings that look fine in Attract. */
export const PUSH_MAX_BASE = 0.05;
/** How fast `spread` pulls each cell toward its blurred neighbourhood, per second. */
export const SPREAD_RATE = 5.0;

export interface PushOpts {
  /** How hard motion shoves the field. 0 = Push Away off. */
  pushStrength: number;
  /** Relaxation back to rest, per second. Lower = the gap stays open longer. */
  returnSpeed: number;
  /** Lateral diffusion — neighbours roll back in from the sides. */
  spread: number;
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

/**
 * Advance the push field by dt: integrate the heat gradient, relax toward rest,
 * clamp, then diffuse. `fx`/`fy` are updated in place; `tmpA`/`tmpB` are scratch.
 */
export function stepPushField(
  heat: Float32Array,
  fx: Float32Array, fy: Float32Array,
  tmpA: Float32Array, tmpB: Float32Array,
  dt: number, opts: PushOpts,
) {
  const acc   = opts.pushStrength * PUSH_ACC * dt;
  const max   = opts.pushStrength * PUSH_MAX_BASE;
  // Exponential relaxation, framerate independent.
  const keep  = Math.exp(-opts.returnSpeed * dt);
  const blend = opts.spread > 0 ? Math.min(1, opts.spread * SPREAD_RATE * dt) : 0;

  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      const i = y * HEAT_W + x;
      const [gx, gy] = heatGradient(heat, x, y);
      let vx = (fx[i] + gx * acc) * keep;
      let vy = (fy[i] + gy * acc) * keep;
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
