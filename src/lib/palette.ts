// Shared palette-ramp helpers: turn the global 3+3 colour palette into a GLSL
// gradient. Extracted from heatMap.ts so any pattern that maps a scalar (heat,
// field strength, depth …) onto the palette uses the same ramp.

import type * as THREE from "three";
import { colorC2 } from "./colorC2.svelte";

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Fill a `uColors[6]` uniform from the enabled palette colours and return how
 * many stops are live (always the 3 base colours, plus any enabled extras).
 */
export function loadColorStops(colors: THREE.Vector3[]): number {
  let count = 0;
  const push = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    colors[count].set(r, g, b);
    count++;
  };
  push(colorC2.main);
  push(colorC2.contrast);
  push(colorC2.glow);
  if (colorC2.extra1on) push(colorC2.extra1);
  if (colorC2.extra2on) push(colorC2.extra2);
  if (colorC2.extra3on) push(colorC2.extra3);
  return count;
}

/**
 * Palette ramp: 0 → black, then evenly spaced stops through the enabled colours.
 * Constant indices only — compatible with GLSL ES 1.0.
 * Requires `uniform vec3 uColors[6];` and `uniform float uColorCount;`.
 */
export const RAMP_GLSL = /* glsl */ `
  vec3 paletteRamp(float t) {
    float pos = clamp(t * uColorCount, 0.0, uColorCount - 0.001);
    float lof = floor(pos);
    float f   = pos - lof;

    vec3 a = vec3(0.0);
    vec3 b = uColors[0];

    if (lof >= 1.0) { a = uColors[0]; b = uColors[1]; }
    if (lof >= 2.0) { a = uColors[1]; b = uColors[2]; }
    if (lof >= 3.0) { a = uColors[2]; b = uColors[3]; }
    if (lof >= 4.0) { a = uColors[3]; b = uColors[4]; }
    if (lof >= 5.0) { a = uColors[4]; b = uColors[5]; }

    return mix(a, b, f);
  }
`;
