import { expect, test, describe } from "bun:test";
import { hash, field, PHASE, DESIGN_W } from "./engine";

describe("hash", () => {
  test("is deterministic and in [0,1)", () => {
    for (const [x, y, s] of [[0, 0, 7], [123.4, 56.7, 42], [-9, 1e4, 1]] as const) {
      const a = hash(x, y, s), b = hash(x, y, s);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  test("known values — pins the formula against accidental edits", () => {
    expect(hash(0, 0, 7)).toBeCloseTo(0.8530247179951402, 12);
    expect(hash(100, 200, 7)).toBeCloseTo(0.3191683422483038, 12);
  });

  test("a nearby seed gives an unrelated value (identity really changes)", () => {
    expect(Math.abs(hash(10, 10, 7) - hash(10, 10, 8))).toBeGreaterThan(0.01);
  });
});

describe("field", () => {
  test("stays within [-1,1]", () => {
    for (let i = 0; i < 500; i++) {
      const v = field(i * 37.1, i * 91.7, 7);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("known values — pins the three sine terms", () => {
    expect(field(0, 0, 7)).toBeCloseTo(0.11859078304662315, 12);
    expect(field(960, 540, 7)).toBeCloseTo(-0.5230915490991452, 12);
  });

  test("is spatially coherent — neighbouring points stay close", () => {
    for (let i = 0; i < 100; i++) {
      const x = i * 19, y = i * 7;
      expect(Math.abs(field(x, y, 7) - field(x + 1, y + 1, 7))).toBeLessThan(0.02);
    }
  });

  test("time enters as a phase shift, so it moves the whole field", () => {
    const still = field(500, 300, 7);
    const moved = field(500, 300, 7 + 0.5);
    expect(still).not.toBe(moved);
  });
});

describe("phases", () => {
  test("each phase has a five-colour palette and rising warp/jitter", () => {
    expect(PHASE.A.pal.length).toBe(5);
    expect(PHASE.B.pal.length).toBe(5);
    expect(PHASE.C.pal.length).toBe(5);
    expect(PHASE.A.warp).toBeLessThan(PHASE.B.warp);
    expect(PHASE.B.warp).toBeLessThan(PHASE.C.warp);
    expect(PHASE.A.jit).toBeLessThan(PHASE.B.jit);
    expect(PHASE.B.jit).toBeLessThan(PHASE.C.jit);
  });

  test("only B is directionless — Thinning/Gradient are inert there", () => {
    expect(PHASE.B.dir).toBe(0);
    expect(PHASE.A.dir).toBe(1);
    expect(PHASE.C.dir).toBe(-1);
  });
});

test("the design width stays fixed — the mm calibration depends on it", () => {
  expect(DESIGN_W).toBe(1920);
});
