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

describe("buildZoneMask", () => {
  const { buildZoneMask, debugZoneSlot, DESIGN_W } = require("./engine") as typeof import("./engine");
  const H = DESIGN_W * 9 / 16;
  const MW = 64, MH = 36;
  const zin = {
    comp: "blobs" as const, arrangement: "chaotic" as const,
    zones: 3, lock: 0.35, seed: 8685, strictness: 0.65,
    elems: [1, 2] as const,
  };
  const build = (input: any) => {
    const out = new Uint8Array(MW * MH * 4);
    buildZoneMask(out, MW, MH, H, input);
    return out;
  };
  /** Mask rows are written bottom-up, so undo that to compare against engine space. */
  const at = (out: Uint8Array, mx: number, my: number) => {
    const b = (my * MW + mx) * 4;
    return [out[b], out[b + 1], out[b + 2], out[b + 3]];
  };

  test("a single element writes channel 0 only — never all four", () => {
    // inZone() short-circuits to true for ANY slot when elems.length === 1, so a
    // naive loop to 4 would mark every element as owning the entire screen.
    const out = build({ ...zin, elems: [1] });
    let anyC0 = false;
    for (let i = 0; i < MW * MH; i++) {
      expect(out[i * 4 + 1]).toBe(0);
      expect(out[i * 4 + 2]).toBe(0);
      expect(out[i * 4 + 3]).toBe(0);
      if (out[i * 4] > 0) anyC0 = true;
    }
    expect(anyC0).toBe(true);
  });

  test("two elements each own part of the screen, neither owns all of it", () => {
    const out = build(zin);
    let c0 = 0, c1 = 0;
    for (let i = 0; i < MW * MH; i++) {
      if (out[i * 4] > 127) c0++;
      if (out[i * 4 + 1] > 127) c1++;
    }
    const total = MW * MH;
    expect(c0).toBeGreaterThan(total * 0.05);
    expect(c1).toBeGreaterThan(total * 0.05);
    expect(c0).toBeLessThan(total * 0.95);
    expect(c1).toBeLessThan(total * 0.95);
  });

  test("agrees with debugZoneSlot on which channel dominates", () => {
    const state = { ...zin, phase: "B" as const, pointStyle: "grid" as const,
      lineDir: "v" as const, dens: 1, stroke: 1, warp: 1, organic: 0, pk: 0,
      colorSoftness: 0, elems: [1, 2] };
    const out = build(zin);
    let checked = 0, agreed = 0;
    for (let my = 2; my < MH - 2; my += 5) {
      for (let mx = 2; mx < MW - 2; mx += 5) {
        const wx = ((mx + 0.5) / MW) * DESIGN_W;
        const wy = (1 - (my + 0.5) / MH) * H;      // mask rows are bottom-up
        const slot = debugZoneSlot(wx, wy, H, state as any);
        if (slot < 0) continue;                     // seam — no channel required
        const px = at(out, mx, my);
        // Only count cells that are unambiguous (not straddling a 2x2 edge).
        if (px[slot] === 255 || px[slot] === 0) {
          checked++;
          if (px[slot] === 255) agreed++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(agreed / checked).toBeGreaterThan(0.9);
  });

  test("Up / Down puts element 0 in the upper half of the screen", () => {
    // Guards the flipY trap: DataTexture.flipY is false and PlaneGeometry puts
    // uv.y = 1 at the top, so texel row 0 is the BOTTOM of the screen.
    const out = build({ ...zin, comp: "bands", arrangement: "upDown", strictness: 1, lock: 0 });
    let topC0 = 0, botC0 = 0;
    for (let mx = 0; mx < MW; mx++) {
      for (let my = 0; my < MH; my++) {
        const v = at(out, mx, my)[0];
        if (my >= MH / 2) topC0 += v; else botC0 += v;   // high row index = top
      }
    }
    expect(topC0).toBeGreaterThan(botC0 * 3);
  });
});

describe("zone seams — Interlock closes gaps without double-covering", () => {
  const { debugZoneSlot, buildZoneMask, DESIGN_W } = require("./engine") as typeof import("./engine");
  const H = 1080;
  const base = {
    phase: "B" as const, pointStyle: "strands" as const, lineDir: "v" as const,
    dens: 1, stroke: 1, warp: 1, organic: 0, zones: 2, pk: 0,
    seed: 8685, colorSoftness: 0, strictness: 0.65, elems: [1, 2] as const,
  };

  test("blobs: Interlock=0 still leaves an unclaimed seam (unchanged look)", () => {
    const st = { ...base, comp: "blobs" as const, arrangement: "chaotic" as const, lock: 0 };
    let seam = 0;
    const N = 60;
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      const x = (ix + 0.5) / N * DESIGN_W, y = (iy + 0.5) / N * H;
      if (debugZoneSlot(x, y, H, st as any) === -1) seam++;
    }
    expect(seam).toBeGreaterThan(0);
  });

  test("blobs: Interlock=1 closes the seam completely — no unclaimed points", () => {
    const st = { ...base, comp: "blobs" as const, arrangement: "chaotic" as const, lock: 1 };
    let seam = 0;
    const N = 60;
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      const x = (ix + 0.5) / N * DESIGN_W, y = (iy + 0.5) / N * H;
      if (debugZoneSlot(x, y, H, st as any) === -1) seam++;
    }
    expect(seam).toBe(0);
  });

  test("bands: Interlock handoff never lets two neighbouring elements both claim the same point", () => {
    // Regression test for the "bright seam" bug: the mask's per-channel bytes
    // sum to at most one full channel's worth (255) per texel iff each
    // supersample ever counts toward exactly one channel. Summed well above
    // 255 would mean some subsamples counted toward two channels at once —
    // the additive double-coverage that read as an unrelated bright line.
    const st = {
      comp: "bands" as const, arrangement: "leftRight" as const, zones: 3,
      lock: 1, seed: 8685, strictness: 0.65, elems: [1, 2, 3, 4] as const,
    };
    const MW = 400, MH = 4;
    const out = new Uint8Array(MW * MH * 4);
    buildZoneMask(out, MW, MH, H, st);
    let maxSum = 0;
    for (let i = 0; i < MW * MH; i++) {
      const sum = out[i * 4] + out[i * 4 + 1] + out[i * 4 + 2] + out[i * 4 + 3];
      if (sum > maxSum) maxSum = sum;
    }
    // Each of up to 4 channels independently rounds its own 0..255 coverage,
    // so a boundary texel split evenly between two channels can round each
    // side up and land a couple of units over 255 — real double-coverage
    // (the bug this guards against) pushes the sum toward ~2x that, not a
    // rounding-sized nudge.
    expect(maxSum).toBeLessThanOrEqual(260);
  });

  test("bands: Interlock=0 leaves the seam handoff disabled (unchanged look)", () => {
    const st = { ...base, comp: "bands" as const, arrangement: "leftRight" as const, lock: 0 };
    // Every point belongs to exactly its home band — no handoff at all — so
    // slot assignment must be a clean step function with no dithering.
    const N = 300;
    let last = -1, flips = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * DESIGN_W;
      const slot = debugZoneSlot(x, H * 0.5, H, st as any);
      if (slot !== last) { flips++; last = slot; }
    }
    // 2 elements, chaotic-free leftRight split -> exactly one transition.
    expect(flips).toBeLessThanOrEqual(2);
  });
});
