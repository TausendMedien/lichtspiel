import { expect, test, describe } from "bun:test";
import {
  HEAT_W, HEAT_H, HEAT_N,
  boxBlur, smoothHeat, heatGradient, stepPushField, evictionOffsets,
  PUSH_MAX_BASE, MAX_EVICT, type PushOpts,
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

type State = ReturnType<typeof makeState>;

/** Run `seconds` of frames with the given heat map. */
function run(s: State, heat: Float32Array, seconds: number, opts: PushOpts) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    stepPushField(heat, s.fx, s.fy, s.a, s.b, DT, opts);
  }
}

const at = (s: State, x: number, y: number) => {
  const i = y * HEAT_W + x;
  return { x: s.fx[i], y: s.fy[i], mag: Math.hypot(s.fx[i], s.fy[i]) };
};

/** Defaults as shipped: Solidity 1, Push Strength 1.2, 16:9. */
const OPTS: PushOpts = {
  pushStrength: 1.2, solidity: 1, returnSpeed: 0.35, spread: 0.4,
  aspect: 16 / 9, heatGain: 11, heatStrength: 0.5,
};
const GRADIENT_ONLY: PushOpts = { ...OPTS, solidity: 0 };

describe("solid-body eviction", () => {
  test("clears the MIDDLE of the covered area, which the gradient alone cannot", () => {
    // The whole point of Solidity: the heat gradient vanishes at the centre of a
    // shape, so gradient-only push leaves a stubborn island of particles behind.
    const heat = blob(80, 45, 0.3, 16);
    const soft = makeState(), solid = makeState();
    run(soft,  heat, 0.5, GRADIENT_ONLY);
    run(solid, heat, 0.5, OPTS);

    const centreSoft  = at(soft,  80, 45).mag;
    const centreSolid = at(solid, 80, 45).mag;
    expect(centreSoft).toBeLessThan(0.005);          // barely moves
    expect(centreSolid).toBeGreaterThan(centreSoft * 20);
  });

  test("one pass is enough — a single sweep clears the swept lane", () => {
    // Sweep a hand left→right, one frame per step, and check the lane behind it.
    const s = makeState();
    for (let cx = 30; cx <= 120; cx += 2) {
      stepPushField(blob(cx, 45, 0.3, 12), s.fx, s.fy, s.a, s.b, DT, OPTS);
    }
    // Everything along the swept lane is displaced, including cells the hand only
    // passed over once.
    for (const x of [40, 60, 80, 100]) {
      expect(at(s, x, 45).mag).toBeGreaterThan(0.05);
    }
    // Well outside the lane, nothing much happened.
    expect(at(s, 80, 8).mag).toBeLessThan(0.02);
  });

  test("the displacement is roughly the distance to the edge of the silhouette", () => {
    const s = makeState();
    const r = 12;
    run(s, blob(80, 45, 0.3, r), 0.5, { ...OPTS, spread: 0, returnSpeed: 0.01 });
    // A cell at the centre must travel about the blob's radius to get out. The mask
    // is thresholded from the heat falloff, so the effective radius is smaller than
    // the nominal one — check the order of magnitude, in screen-height fractions.
    const expected = r / HEAT_H;
    const got = at(s, 80, 45).mag;
    expect(got).toBeGreaterThan(expected * 0.3);
    expect(got).toBeLessThan(expected * 1.5);
  });

  test("Solidity scales the eviction distance", () => {
    const heat = blob(80, 45, 0.3, 14);
    const half = makeState(), full = makeState();
    run(half, heat, 0.5, { ...OPTS, solidity: 0.5, returnSpeed: 0.01, spread: 0 });
    run(full, heat, 0.5, { ...OPTS, solidity: 1.0, returnSpeed: 0.01, spread: 0 });
    expect(at(full, 80, 45).mag).toBeGreaterThan(at(half, 80, 45).mag * 1.6);
  });

  test("cells on opposite sides are evicted in opposite directions", () => {
    const s = makeState();
    run(s, blob(80, 45, 0.3, 14), 0.5, OPTS);
    expect(Math.sign(at(s, 72, 45).x)).toBe(-Math.sign(at(s, 88, 45).x));
    expect(Math.sign(at(s, 80, 38).y)).toBe(-Math.sign(at(s, 80, 52).y));
  });

  test("eviction pushes the same way the gradient does — the two never fight", () => {
    const heat = blob(80, 45, 0.3, 14);
    const soft = makeState(), solid = makeState();
    run(soft,  heat, 0.5, GRADIENT_ONLY);
    run(solid, heat, 0.5, { ...OPTS, pushStrength: 0 });
    // Sample at the rim, where the gradient is strong enough to have a clear sign.
    const a = at(soft, 90, 45), b = at(solid, 90, 45);
    expect(Math.sign(a.x)).toBe(Math.sign(b.x));
  });

  test("stays within the ceiling", () => {
    const s = makeState();
    run(s, blob(80, 45, 0.9, 40), 20, OPTS);
    const ceiling = Math.max(OPTS.pushStrength * PUSH_MAX_BASE, OPTS.solidity * MAX_EVICT);
    for (let i = 0; i < HEAT_N; i++) {
      expect(Math.hypot(s.fx[i], s.fy[i])).toBeLessThanOrEqual(ceiling + 1e-6);
    }
  });
});

describe("eviction offsets", () => {
  test("point out of the mask by the shortest route", () => {
    const mask = new Uint8Array(HEAT_N);
    for (let y = 40; y < 50; y++) for (let x = 70; x < 90; x++) mask[y * HEAT_W + x] = 1;
    const dx = new Float32Array(HEAT_N), dy = new Float32Array(HEAT_N);
    evictionOffsets(mask, dx, dy);

    // Free cells stay put.
    expect(dx[45 * HEAT_W + 10]).toBe(0);
    // The band is 10 rows tall and 20 wide, so from the middle the way out is
    // vertical, and about half the height.
    const i = 45 * HEAT_W + 80;
    expect(Math.abs(dy[i])).toBeLessThanOrEqual(6);
    expect(Math.abs(dy[i])).toBeGreaterThan(0);
    expect(Math.abs(dx[i])).toBeLessThan(Math.abs(dy[i]) + 1);
    // Near the left edge the way out is sideways and short.
    const j = 45 * HEAT_W + 71;
    expect(dx[j]).toBe(-2);
  });

  test("an empty mask leaves every cell at rest", () => {
    const dx = new Float32Array(HEAT_N), dy = new Float32Array(HEAT_N);
    evictionOffsets(new Uint8Array(HEAT_N), dx, dy);
    for (let i = 0; i < HEAT_N; i++) expect(dx[i]).toBe(0);
  });
});

describe("push field", () => {
  test("motion builds a displacement that points away from the hot centre", () => {
    const s = makeState();
    const heat = blob(80, 45, 0.3, 16);
    run(s, heat, 1, GRADIENT_ONLY);

    // Sample to the RIGHT of the blob centre. The heat gradient there is the
    // direction the Attract path already displaces by; both modes must agree.
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
    run(s, blob(80, 45, 0.3, 16), 30, GRADIENT_ONLY);
    const max = OPTS.pushStrength * PUSH_MAX_BASE;
    let peak = 0;
    for (let i = 0; i < HEAT_N; i++) peak = Math.max(peak, Math.hypot(s.fx[i], s.fy[i]));
    expect(peak).toBeLessThanOrEqual(max + 1e-6);
    expect(peak).toBeGreaterThan(max * 0.9);   // it does reach the ceiling
  });

  test("the gap stays open after the motion stops, then closes", () => {
    const s = makeState();
    run(s, blob(80, 45, 0.3, 16), 2, OPTS);
    // Measure the SIZE of the gap, not one cell: at the very centre the two sides
    // of the eviction point opposite ways, so Spread cancels them there first —
    // the hole genuinely refills from the middle outward.
    const open = (st: State) => {
      let n = 0;
      for (let i = 0; i < HEAT_N; i++) if (Math.hypot(st.fx[i], st.fy[i]) > 0.02) n++;
      return n;
    };
    const peak = open(s);
    expect(peak).toBeGreaterThan(200);

    const still = new Float32Array(HEAT_N);   // person stopped moving
    run(s, still, 1, OPTS);
    // Still clearly open a second later — this is the whole point of the mode.
    expect(open(s)).toBeGreaterThan(peak * 0.5);

    run(s, still, 9, OPTS);
    // ...and effectively closed after ten seconds at the default Return Speed.
    expect(open(s)).toBe(0);
  });

  test("Return Speed controls how long the gap lingers", () => {
    const heat = blob(80, 45, 0.3, 16);
    const still = new Float32Array(HEAT_N);
    const slow = makeState(), fast = makeState();
    run(slow, heat, 2, { ...OPTS, returnSpeed: 0.1 });
    run(fast, heat, 2, { ...OPTS, returnSpeed: 2.0 });
    run(slow, still, 3, { ...OPTS, returnSpeed: 0.1 });
    run(fast, still, 3, { ...OPTS, returnSpeed: 2.0 });
    expect(at(slow, 80, 45).mag).toBeGreaterThan(at(fast, 80, 45).mag * 10);
  });

  test("both forces at zero (Attract mode) leaves the field untouched", () => {
    const s = makeState();
    run(s, blob(80, 45, 0.3, 16), 2, { ...OPTS, pushStrength: 0, solidity: 0 });
    for (let i = 0; i < HEAT_N; i++) expect(s.fx[i]).toBe(0);
  });

  test("spread widens the disturbed area", () => {
    const heat = blob(80, 45, 0.3, 10);
    const none = makeState(), wide = makeState();
    run(none, heat, 2, { ...OPTS, spread: 0 });
    run(wide, heat, 2, { ...OPTS, spread: 1 });
    const disturbed = (s: State) => {
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
