/** Global 3+3 colour palette + per-pattern assignment state */

const COLORS_KEY = 'pp:colors3';

export const COLOR_DEFAULTS = {
  main:     '#00ffff',  // Base 1 — always on
  contrast: '#ff00cc',  // Base 2 — always on
  glow:     '#ffffff',  // Base 3 — always on
  extra1:   '#ff6600',  // Extra: Flame
  extra2:   '#ffcc00',  // Extra: Gold
  extra3:   '#7700ff',  // Extra: Violet
  extra1on: false,
  extra2on: false,
  extra3on: false,
} as const;

function loadColors() {
  try {
    const s = localStorage.getItem(COLORS_KEY);
    if (!s) return { ...COLOR_DEFAULTS };
    const p = JSON.parse(s);
    const hex = /^#[0-9a-fA-F]{6}$/;
    return {
      main:     hex.test(p.main)     ? p.main     : COLOR_DEFAULTS.main,
      contrast: hex.test(p.contrast) ? p.contrast : COLOR_DEFAULTS.contrast,
      glow:     hex.test(p.glow)     ? p.glow     : COLOR_DEFAULTS.glow,
      extra1:   hex.test(p.extra1)   ? p.extra1   : COLOR_DEFAULTS.extra1,
      extra2:   hex.test(p.extra2)   ? p.extra2   : COLOR_DEFAULTS.extra2,
      extra3:   hex.test(p.extra3)   ? p.extra3   : COLOR_DEFAULTS.extra3,
      extra1on: !!p.extra1on,
      extra2on: !!p.extra2on,
      extra3on: !!p.extra3on,
    };
  } catch {
    return { ...COLOR_DEFAULTS };
  }
}

/** Global colour palette — shared across all patterns. */
export const colorC2 = $state(
  typeof localStorage !== 'undefined' ? loadColors() : { ...COLOR_DEFAULTS }
);

/** Per-pattern colour state — reloaded on every pattern switch. */
export const colorShuffle = $state({
  enabled:    true,
  saturation: 1.0,
  brightness: 1.0,
  assign:     [0, 1, 2] as [number, number, number],
});

export function saveColorC2() {
  try { localStorage.setItem(COLORS_KEY, JSON.stringify({ ...colorC2 })); } catch {}
}

/** Indices into the 6-color array that are currently enabled. */
export function getEnabledIndices(): number[] {
  return [
    0, 1, 2,
    ...(colorC2.extra1on ? [3] : []),
    ...(colorC2.extra2on ? [4] : []),
    ...(colorC2.extra3on ? [5] : []),
  ];
}

/** Hex color for a given palette index (0–5). */
export function getColorByIndex(i: number): string {
  const c = colorC2;
  return [c.main, c.contrast, c.glow, c.extra1, c.extra2, c.extra3][i] ?? c.main;
}
