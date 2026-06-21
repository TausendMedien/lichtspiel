// Evolving Range — sliders drift slowly + autonomously inside a per-slider [min,max]
// band so transitions between looks stay smooth and comprehensible instead of jumpy.
//
// Two layers of state:
//  • Global (this $state): master on/off, drift speed, and how many sliders may move
//    at once. Persisted in localStorage 'pp:evolving'. In demo the global speed is the
//    authoritative one (it overrides any per-pattern intent).
//  • Per-pattern config: which range controls evolve and their individual [min,max].
//    Stored per pattern under 'pp:evo:{patternId}'. The actual drift scheduler lives in
//    App.svelte's liveSync loop (next to randomizeAnims).

const STORAGE_KEY = 'pp:evolving';

export interface EvoCtrl {
  on: boolean;
  min: number;
  max: number;
}
export type EvoConfig = Record<string, EvoCtrl>;

interface EvolvingState {
  active: boolean;
  /** 0..1 — higher = faster drift (shorter transitions). */
  speed: number;
  /** How many sliders may drift simultaneously (1..3). */
  maxConcurrent: number;
}

function loadGlobal(): EvolvingState {
  const fallback: EvolvingState = { active: false, speed: 0.4, maxConcurrent: 2 };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    return {
      active: typeof p.active === 'boolean' ? p.active : fallback.active,
      speed: typeof p.speed === 'number' ? Math.min(1, Math.max(0, p.speed)) : fallback.speed,
      maxConcurrent: typeof p.maxConcurrent === 'number'
        ? Math.min(3, Math.max(1, Math.round(p.maxConcurrent)))
        : fallback.maxConcurrent,
    };
  } catch {
    return fallback;
  }
}

export const evolving = $state<EvolvingState>(loadGlobal());

export function saveEvolving(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: evolving.active,
      speed: evolving.speed,
      maxConcurrent: evolving.maxConcurrent,
    }));
  } catch {}
}

// Map the 0..1 speed slider to a per-transition duration in milliseconds.
// Slow end ≈ 15 s, fast end ≈ 2.5 s — slow enough that drift stays readable.
export function evoDurationMs(speed: number): number {
  const s = Math.min(1, Math.max(0, speed));
  return 15000 - s * 12500;
}

function evoKey(patternId: string): string {
  return `pp:evo:${patternId}`;
}

export function getEvo(patternId: string): EvoConfig {
  try {
    const raw = localStorage.getItem(evoKey(patternId));
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') return p as EvoConfig;
    }
  } catch {}
  // No saved config — light* patterns ship with the "Default" factory bands so they
  // evolve sensibly the moment the master switch is turned on.
  return evoFactory(patternId, 0) ?? {};
}

export function saveEvo(patternId: string, cfg: EvoConfig): void {
  try { localStorage.setItem(evoKey(patternId), JSON.stringify(cfg)); } catch {}
}

// ── Factory Evolving bands for Light Painting ──────────────────────────────────
// User-supplied drift ranges per Pattern-Start preset. Index 0 = "Default" base,
// 1/2/3 = Chilled/Balanced/Active (matching the demo Pattern-Start slots). Applied to
// every light* variant since they share the same six controls.
const LIGHT_PAINT_IDS = new Set([
  'lightPaint', 'lightTrail', 'lightPaintBlack', 'lightFly', 'lightVortex', 'lightKaleido', 'lightGlitch',
]);

type Bands = Record<string, [number, number]>;
const LP_BANDS: Bands[] = [
  { // Default
    'Fade Speed': [0.005, 0.020], 'Colorize': [0.0, 1.0], 'Black': [0.6, 1.0],
    'Fly In/Out': [-0.2, 0.2], 'Vortex': [-0.05, 0.05], 'RGB Split': [0.0, 0.03],
  },
  { // 1 — Chilled
    'Fade Speed': [0.005, 0.015], 'Colorize': [0.0, 0.30], 'Black': [0.6, 1.0],
    'Fly In/Out': [-0.01, 0.01], 'Vortex': [-0.01, 0.01], 'RGB Split': [0.0, 0.01],
  },
  { // 2 — Balanced
    'Fade Speed': [0.005, 0.025], 'Colorize': [0.0, 0.50], 'Black': [0.6, 1.0],
    'Fly In/Out': [-0.15, 0.15], 'Vortex': [-0.05, 0.05], 'RGB Split': [0.0, 0.03],
  },
  { // 3 — Active
    'Fade Speed': [0.005, 0.025], 'Colorize': [0.0, 1.0], 'Black': [0.6, 1.0],
    'Fly In/Out': [-0.3, 0.3], 'Vortex': [-0.2, 0.2], 'RGB Split': [0.0, 0.03],
  },
];

function bandsToConfig(bands: Bands): EvoConfig {
  const cfg: EvoConfig = {};
  for (const [label, [min, max]] of Object.entries(bands)) cfg[label] = { on: true, min, max };
  return cfg;
}

/** Factory evolving config for a light* pattern at a Pattern-Start slot (0=Default,
 *  1/2/3 = Chilled/Balanced/Active), or null if the pattern has no factory bands. */
export function evoFactory(patternId: string, slotIdx: number): EvoConfig | null {
  if (!LIGHT_PAINT_IDS.has(patternId)) return null;
  const bands = LP_BANDS[slotIdx];
  return bands ? bandsToConfig(bands) : null;
}
