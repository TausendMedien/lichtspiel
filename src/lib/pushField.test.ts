import { expect, test, describe } from "bun:test";
import {
  HEAT_W, HEAT_H, HEAT_N,
  boxBlur, smoothHeat, heatGradient, stepPushField,
  PUSH_MAX_BASE, type PushOpts,
} from "./pushField";

const DT = 1 / 60;

function blob(cx: number, cy: number, amp: number, r: number): Float32Array {
  const m = new Float32Array(HEAT_N);
  for (let y = Math.max(0, cy - r); y < Math.min(HEAT_H, cy + r); y++)
    for (let x = Math.max(0, cx - r); x < Math.min(HEAT_W, cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d < 1) m[y * HEAT_W + x] = amp * (1 - d) * (1 - d);
    }
  return m;
}

function makeState() {
  return {
    fx: new Float32Array(HEAT_N), fy: new Float32Array(HEAT_N),
    a: new Float32Array(HEAT_N), b: new Float32Array(HEAT_N),
  };
}

/** Run `seconds` of frames with the given heat map. */
function run(s: ReturnType<typeof makeState>, heat: Float32Array, seconds: number, opts: PushOpts) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    stepPushField(heat, s.fx, s.fy, s.a, s.b, DT, opts);
  }
}

const at = (s: ReturnType<typeof makeState>, x: number, y: number) => {
  const i = y * HEAT_W + x;
  return { x: s.fx[i], y: s.fy[i], mag: Math.hypot(s.fx[i], s.fy[i]) };
};

const OPTS: PushOpts = { pushStrength: 1.2, returnSpeed: 0.35, spread: 0.4 };

describe("push field", () => {
  test("motion builds a displacement that points away from the hot centre", () => {
    const s = makeState();
    const heat = blob(80, 45, 0.3, 16);
    run(s, heat, 1, OPTS);

    // Sample to the RIGHT of the blob centre. The heat gradient there points back
    // toward the centre in texture space, which is the direction the Attract path
    // already displaces by — i.e. outward on screen. Both modes must agree in sign.
    const right = at(s, 92, 45);
    const [gx] = heatGradient(heat, 92, 45);
    expect(Math.sign(right.x)).toBe(Math.sign(gx));
    expect(right.mag).toBeGreaterThan(0);

    // Mirror side must push the opposite way — that is what opens a gap rather
    // than sliding the whole field sideways.
    const left = at(s, 68, 45);
    expect(Math.sign(left.x)).toBe(-Math.sign(right.x));
  });

  test("sustained motion saturates at the clamp instead of running away", () => {
    const s = makeState();
    const heat = blob(80, 45, 0.3, 16);
    run(s, heat, 30, OPTS);
    const max = OPTS.pushStrength * PUSH_MAX_BASE;
    let peak = 0;
    for (let i = 0; i < HEAT_N; i++) peak = Math.max(peak, Math.hypot(s.fx[i], s.fy[i]));
    expect(peak).toBeLessThanOrEqual(max + 1e-6);
    expect(peak).toBeGreaterThan(max * 0.9);   // it does reach the ceiling
  });

  test("the gap stays open after the motion stops, then relaxes away", () => {
    const s = makeState();
    const heat = blob(80, 45, 0.3, 16);
    run(s, heat, 2, OPTS);
    const peak = at(s, 92, 45).mag;
    expect(peak).toBeGreaterThan(0);

    const still = new Float32Array(HEAT_N);   // person stopped moving
    run(s, still, 1, OPTS);
    // Still clearly displaced a second later — this is the whole point of the mode.
    expect(at(s, 92, 45).mag).toBeGreaterThan(peak * 0.5);

    run(s, still, 9, OPTS);
    // ...and effectively closed after ten seconds at the default Return Speed.
    expect(at(s, 92, 45).mag).toBeLessThan(peak * 0.1);
  });

  test("Return Speed controls how long the gap lingers", () => {
    const heat = blob(80, 45, 0.3, 16);
    const still = new Float32Array(HEAT_N);
    const slow = makeState(), fast = makeState();
    run(slow, heat, 2, { ...OPTS, returnSpeed: 0.1 });
    run(fast, heat, 2, { ...OPTS, returnSpeed: 2.0 });
    run(slow, still, 3, { ...OPTS, returnSpeed: 0.1 });
    run(fast, still, 3, { ...OPTS, returnSpeed: 2.0 });
    expect(at(slow, 92, 45).mag).toBeGreaterThan(at(fast, 92, 45).mag * 10);
  });

  test("pushStrength 0 (Attract mode) leaves the field untouched", () => {
    const s = makeState();
    run(s, blob(80, 45, 0.3, 16), 2, { ...OPTS, pushStrength: 0 });
    for (let i = 0; i < HEAT_N; i++) expect(s.fx[i]).toBe(0);
  });

  test("spread widens the disturbed area", () => {
    const heat = blob(80, 45, 0.3, 10);
    const none = makeState(), wide = makeState();
    run(none, heat, 2, { ...OPTS, spread: 0 });
    run(wide, heat, 2, { ...OPTS, spread: 1 });
    const disturbed = (s: ReturnType<typeof makeState>) => {
      let n = 0;
      for (let i = 0; i < HEAT_N; i++) if (Math.hypot(s.fx[i], s.fy[i]) > 1e-4) n++;
      return n;
    };
    expect(disturbed(wide)).toBeGreaterThan(disturbed(none));
  });
});

describe("heat smoothing", () => {
  test("camera noise below the floor never reaches the field", () => {
    const raw = new Float32Array(HEAT_N).fill(0.005);   // under NOISE_FLOOR
    const sm  = new Float32Array(HEAT_N);
    for (let i = 0; i < 600; i++) smoothHeat(raw, sm);
    expect(Math.max(...sm)).toBe(0);
  });

  test("a real signal converges toward its above-floor value", () => {
    const raw = new Float32Array(HEAT_N).fill(0.3);
    const sm  = new Float32Array(HEAT_N);
    for (let i = 0; i < 600; i++) smoothHeat(raw, sm);
    expect(sm[0]).toBeCloseTo(0.3 - 0.008, 3);
  });
});

describe("boxBlur", () => {
  test("preserves the mean and spreads a spike", () => {
    const src = new Float32Array(HEAT_N);
    src[45 * HEAT_W + 80] = 1;
    const tmp = new Float32Array(HEAT_N), dst = new Float32Array(HEAT_N);
    boxBlur(src, tmp, dst, 4);
    expect(dst[45 * HEAT_W + 80]).toBeGreaterThan(0);
    expect(dst[45 * HEAT_W + 80]).toBeLessThan(1);
    expect(dst[45 * HEAT_W + 83]).toBeGreaterThan(0);   // energy reached the neighbours
    const sum = (a: Float32Array) => a.reduce((t, v) => t + v, 0);
    expect(sum(dst)).toBeCloseTo(sum(src), 3);
  });

  test("radius below 1 is a pass-through", () => {
    const src = new Float32Array(HEAT_N).fill(0.5);
    const tmp = new Float32Array(HEAT_N), dst = new Float32Array(HEAT_N);
    boxBlur(src, tmp, dst, 0);
    expect(dst[0]).toBe(0.5);
  });
});
