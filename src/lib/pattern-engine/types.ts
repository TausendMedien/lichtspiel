/** Element ids — the four building blocks of the Lustspiel vocabulary. */
export type ElementId = 1 | 2 | 3 | 4;   // 1 Points, 2 Lines, 3 Mesh, 4 Rings

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
  /** Always set by the pattern adapter — a blend of the phase's fixed palette and
   *  the app's global palette. Falls back to the phase palette when absent (only
   *  relevant if some other future caller omits it). */
  palette?: string[];
  /**
   * Extra phase offset for field()/intensity()/zoneU() — animation.
   * NEVER passed to hash(): that would change which elements exist per frame.
   */
  time?: number;
}

export interface Phase {
  pal: string[];
  warp: number;
  jit: number;
  glow: number;
}
