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
  /** Zone arrangement — applies to both bands and blobs. */
  layout: "chaotic" | "sideBySide";
  pointStyle: "grid" | "strands" | "wave";
  /** Generation axis for Lines and Points/Strands — the 90° switch. */
  lineDir: "v" | "h";
  occ: number;      // coverage — raises the intensity floor
  dens: number;     // density
  stroke: number;   // stroke width
  warp: number;     // deformation
  /** 0..1 — blends regular sine bends into an incoherent meander. */
  organic: number;
  zones: number;
  lock: number;     // interlock at zone edges
  pk: number;       // thinning in A/C (percent)
  grad: number;     // directional gradient in A/C
  seed: number;
  /** Overrides the phase palette when set. */
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
  dir: number;
  glow: number;
}
