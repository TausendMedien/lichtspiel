/** Element ids — the four building blocks of the Lustspiel vocabulary. */
export type ElementId = 1 | 2 | 3 | 4 | 5;   // 1 Points, 2 Lines, 3 Mesh, 4 Rings, 5 Gravity

/** A = ascent, B = dance, C = descent. Each phase has its own palette and warp/jitter. */
export type PhaseId = "A" | "B" | "C";

export interface EngineState {
  phase: PhaseId;
  /** Active elements. The array index doubles as the zone slot. */
  elems: ElementId[];
  /** Zone shape. */
  comp: "bands" | "blobs";
  /** Zone arrangement — applies to both bands and blobs. chaotic scatters zones
   *  over the whole surface; leftRight/upDown assign each element its own band
   *  along that axis, with a meandering (not ruler-straight) edge. */
  arrangement: "chaotic" | "leftRight" | "upDown";
  /** 0..1 — how cleanly leftRight/upDown splits the elements: 0 lets bands
   *  meander and overlap a lot (can look chaotic), 1 gives a clean, unambiguous
   *  split. No effect on "chaotic" arrangement. */
  strictness: number;
  pointStyle: "grid" | "strands" | "wave";
  /** Generation axis for Lines and Points/Strands — the 90° switch. */
  lineDir: "v" | "h";
  dens: number;     // density
  stroke: number;   // stroke width
  warp: number;     // deformation
  /** 0..1 — blends regular sine bends into an incoherent meander. */
  organic: number;
  /** Number of zones (bands), or blob clusters per element (blobs). 2..6. */
  zones: number;
  /** Interlock at zone edges: band overlap for bands, seam softness for blobs. */
  lock: number;
  pk: number;       // thinning in A/C (percent)
  seed: number;
  /** 0 = hard, stepped colour picks per shape. 1 = a smooth gradient across the
   *  palette, like the soft blends in Gravity Lines. */
  colorSoftness: number;
  /** 0 = every shape crisp and fully opaque (the original look). 1 = a soft,
   *  blurred, semi-transparent second mode built for slow, subtle change —
   *  small drifts read clearly even when they're too small to change a hard
   *  edge. Purely a render-time blend; never affects which shapes exist. */
  softness?: number;
  /** 0..1 — Lustspiel Organic only, 0 (off) everywhere else. An organic, unevenly
   *  distributed "grime" layer: patches of the frame dissolve into a heavy-blurred
   *  wash, other patches sink toward black — see paintAtmosphere() in engine.ts. */
  atmosphere?: number;
  /** Always set by the pattern adapter — a blend of the phase's fixed palette and
   *  the app's global palette. Falls back to the phase palette when absent (only
   *  relevant if some other future caller omits it). */
  palette?: string[];
  /**
   * Extra phase offset for field()/intensity()/zoneU() — animation.
   * NEVER passed to hash(): that would change which elements exist per frame.
   */
  time?: number;
  /**
   * True for the Speed-driven Lustspiel 1/2/3 patterns — adds a gentle,
   * always-on time-based drift to every element/style (not just Organic's
   * meander or the Wave point style's flow), so Speed has a visible effect
   * everywhere. Left unset (falsy) for Lustspiel A/B/C, whose `time` never
   * advances anyway, but which must render bit-for-bit as before this existed.
   */
  animated?: boolean;
  /** Lustspiel Alpha/Beta/Gamma only: slot indices (positions in `elems`) that
   *  are actually canvas elements — the rest are filler ids standing in for
   *  hosted WebGL elements sharing the same zone partition, and must never be
   *  drawn by RENDER. Unset means "draw everything", so every existing pattern
   *  is unaffected. */
  drawOnly?: number[];
  /** Lustspiel Alpha/Beta/Gamma only: Merged mode for the canvas half — every
   *  element covers the whole frame instead of being partitioned by inZone().
   *  Unset/false leaves every existing pattern's zone behaviour untouched. */
  bypassZones?: boolean;
  /** Lustspiel Alpha/Beta/Gamma only: per-slot brightness multiplier, applied
   *  in paintLayered() around each element's final composite. Unset means no
   *  multiplier (gain 1), so every existing pattern is unaffected. */
  elemGain?: number[];
  /** Lustspiel Alpha/Beta/Gamma only: forces the per-element paintLayered()
   *  path even at Atmosphere 0 — that path is also what makes drawOnly and
   *  elemGain work. Unset/false leaves every existing pattern on the original
   *  single-surface paint() path. */
  layered?: boolean;
}

export interface Phase {
  pal: string[];
  warp: number;
  jit: number;
  glow: number;
}
