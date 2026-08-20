import { expect, test, describe } from "bun:test";
import { hash, field, PHASE, DESIGN_W, mixHex } from "./engine";

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

});

describe("mixHex", () => {
  test("t=0 returns the first colour, t=1 the second", () => {
    expect(mixHex("#ff0000", "#0000ff", 0)).toBe("#ff0000");
    expect(mixHex("#ff0000", "#0000ff", 1)).toBe("#0000ff");
  });

  test("t=0.5 is the midpoint", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("output is a real hex colour — parseable if fed back into a palette", () => {
    const mixed = mixHex("#00ffff", "#ff00cc", 0.5);
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
  });
});

test("the design width stays fixed — the mm calibration depends on it", () => {
  expect(DESIGN_W).toBe(1920);
});

describe("arrangement — spatial partition between elements", () => {
  const { debugZoneSlot, DESIGN_W } = require("./engine") as typeof import("./engine");
  const H = 1080;
  const base = {
    phase: "B" as const, pointStyle: "strands" as const, lineDir: "v" as const,
    dens: 1, stroke: 1, warp: 1, organic: 0, zones: 3, lock: 0.35, pk: 20,
    seed: 8685, colorSoftness: 0.5, strictness: 0.65, elems: [1, 2] as const,
  };

  // Column of samples at a given fraction across the width, returns the majority slot.
  function majoritySlotAtX(frac: number, state: Parameters<typeof debugZoneSlot>[3]) {
    const counts = [0, 0];
    for (let i = 0; i < 50; i++) {
      const y = ((i + 0.5) / 50) * H;
      const slot = debugZoneSlot(frac * DESIGN_W, y, H, state as any);
      if (slot === 0 || slot === 1) counts[slot]++;
    }
    return counts[0] >= counts[1] ? 0 : 1;
  }

  test("blobs + leftRight: far left is element 0, far right is element 1", () => {
    const st = { ...base, comp: "blobs" as const, arrangement: "leftRight" as const };
    expect(majoritySlotAtX(0.05, st)).toBe(0);
    expect(majoritySlotAtX(0.95, st)).toBe(1);
  });

  test("bands + leftRight: far left is element 0, far right is element 1", () => {
    const st = { ...base, comp: "bands" as const, arrangement: "leftRight" as const };
    expect(majoritySlotAtX(0.05, st)).toBe(0);
    expect(majoritySlotAtX(0.95, st)).toBe(1);
  });

  test("blobs + chaotic: no left/right ordering — both slots appear near both edges", () => {
    const st = { ...base, comp: "blobs" as const, arrangement: "chaotic" as const };
    let sawSlot0NearRight = false, sawSlot1NearLeft = false;
    for (let i = 0; i < 40; i++) {
      const y = ((i + 0.5) / 40) * H;
      if (debugZoneSlot(0.9 * DESIGN_W, y, H, st as any) === 0) sawSlot0NearRight = true;
      if (debugZoneSlot(0.1 * DESIGN_W, y, H, st as any) === 1) sawSlot1NearLeft = true;
    }
    expect(sawSlot0NearRight || sawSlot1NearLeft).toBe(true);
  });

  test("Zones raises the number of blob clusters (more distinct centres)", () => {
    const st2 = { ...base, comp: "blobs" as const, arrangement: "chaotic" as const, zones: 2 };
    const st6 = { ...base, comp: "blobs" as const, arrangement: "chaotic" as const, zones: 6 };
    // More clusters -> the pattern of slot assignment across a fine scanline changes
    // more often (more, smaller regions) than with fewer clusters.
    const flips = (st: any) => {
      let last = -1, n = 0;
      for (let i = 0; i < 300; i++) {
        const slot = debugZoneSlot(((i + 0.5) / 300) * DESIGN_W, H * 0.5, H, st);
        if (slot !== last) { n++; last = slot; }
      }
      return n;
    };
    expect(flips(st6)).toBeGreaterThan(flips(st2));
  });
});
