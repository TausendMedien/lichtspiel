/** Global 3-colour system: Main / Contrast / Glow + Saturation / Brightness */

const COLORS_KEY = 'pp:colors3';

// All 6 permutations of [main=0, contrast=1, glow=2] → [uMain, uContrast, uGlow]
export const PERMS: [number, number, number][] = [
  [0, 1, 2], [0, 2, 1],
  [1, 0, 2], [1, 2, 0],
  [2, 0, 1], [2, 1, 0],
];

export const COLOR_DEFAULTS = {
  main:       '#00ffff',
  contrast:   '#ff00cc',
  glow:       '#ffffff',
  saturation: 1.0,
  brightness: 1.0,
} as const;

function loadColors() {
  try {
    const s = localStorage.getItem(COLORS_KEY);
    if (!s) return { ...COLOR_DEFAULTS };
    const p = JSON.parse(s);
    const hex = /^#[0-9a-fA-F]{6}$/;
    return {
      main:       hex.test(p.main)       ? p.main       : COLOR_DEFAULTS.main,
      contrast:   hex.test(p.contrast)   ? p.contrast   : COLOR_DEFAULTS.contrast,
      glow:       hex.test(p.glow)       ? p.glow       : COLOR_DEFAULTS.glow,
      saturation: typeof p.saturation === 'number' ? p.saturation : COLOR_DEFAULTS.saturation,
      brightness: typeof p.brightness === 'number' ? p.brightness : COLOR_DEFAULTS.brightness,
    };
  } catch {
    return { ...COLOR_DEFAULTS };
  }
}

/** Global colour values — defined once, shared across all patterns. */
export const colorC2 = $state(
  typeof localStorage !== 'undefined' ? loadColors() : { ...COLOR_DEFAULTS }
);

/** Per-pattern permutation index (0–5); updated when switching patterns. */
export const colorShuffle = $state({ index: 0 });

export function saveColorC2() {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify({
      main:       colorC2.main,
      contrast:   colorC2.contrast,
      glow:       colorC2.glow,
      saturation: colorC2.saturation,
      brightness: colorC2.brightness,
    }));
  } catch {}
}
