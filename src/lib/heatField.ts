// Shared heat-map post-processing for the heat-displacement patterns
// (Particle Field, Hyper Mix, Gravity Lines).
//
// Two products, both as textures sampled in the vertex shader at a particle's
// own screen position:
//
//   heatTexture (R float)  — the smoothed + blurred motion map. Patterns take its
//                            gradient and displace by it. INSTANTANEOUS: stop moving
//                            and the displacement is gone on the next frame.
//
//   pushTexture (RG float) — a persistent displacement field with memory. Motion
//                            accumulates a push into it; the push then relaxes back
//                            to zero over seconds. This is the "balls on a floor
//                            shoved away by your hands, slowly rolling back" mode.
//
// The push field integrates the SAME gradient vector the attract path applies
// instantly, so both modes displace in the same direction — Push Away only adds
// the memory. Patterns multiply either one by their own Heat Gain / Heat Strength,
// so those sliders keep meaning in both modes.
//
// The maths lives in pushField.ts; this module is the texture plumbing. Everything
// runs on a 160×90 grid (14 400 cells) — a handful of O(n) passes per frame,
// negligible next to the single blur the patterns already did.

import * as THREE from "three";
import { cameraState } from "./globalCameraSettings.svelte";
import {
  HEAT_W, HEAT_H, HEAT_N,
  boxBlur, smoothHeat, stepPushField, type PushOpts,
} from "./pushField";

export { HEAT_W, HEAT_H, boxBlur } from "./pushField";

export interface HeatFieldOpts extends PushOpts {
  /** Blur radius applied to the motion map (existing per-pattern control). */
  blurRadius: number;
}

export interface HeatField {
  /** R float, 160×90 — smoothed + blurred motion. Drop-in for the old uHeatMap. */
  readonly heatTexture: THREE.DataTexture;
  /** RG float, 160×90 — persistent displacement with memory. */
  readonly pushTexture: THREE.DataTexture;
  update(dt: number, opts: HeatFieldOpts): void;
  /** Clear all state — on activate, and whenever Heat is switched off. */
  reset(): void;
  dispose(): void;
}

export function createHeatField(): HeatField {
  const smoothedRaw = new Float32Array(HEAT_N);
  const heatData    = new Float32Array(HEAT_N);
  const blurTmp     = new Float32Array(HEAT_N);
  // Push field, split per channel so the blur helper can run on it directly.
  const fx    = new Float32Array(HEAT_N);
  const fy    = new Float32Array(HEAT_N);
  const fTmpA = new Float32Array(HEAT_N);
  const fTmpB = new Float32Array(HEAT_N);
  const pushData = new Float32Array(HEAT_N * 2);

  const heatTexture = new THREE.DataTexture(heatData, HEAT_W, HEAT_H, THREE.RedFormat, THREE.FloatType);
  heatTexture.minFilter = THREE.LinearFilter;
  heatTexture.magFilter = THREE.LinearFilter;
  heatTexture.needsUpdate = true;

  const pushTexture = new THREE.DataTexture(pushData, HEAT_W, HEAT_H, THREE.RGFormat, THREE.FloatType);
  pushTexture.minFilter = THREE.LinearFilter;
  pushTexture.magFilter = THREE.LinearFilter;
  pushTexture.needsUpdate = true;

  return {
    heatTexture,
    pushTexture,

    update(dt: number, opts: HeatFieldOpts) {
      smoothHeat(cameraState.heatMap, smoothedRaw);
      boxBlur(smoothedRaw, blurTmp, heatData, opts.blurRadius);
      heatTexture.needsUpdate = true;

      if (opts.pushStrength > 0 || opts.solidity > 0) {
        // Cap dt so a stalled tab can't jolt the field on the frame it resumes.
        stepPushField(heatData, fx, fy, fTmpA, fTmpB, Math.min(dt, 0.1), opts);
        for (let i = 0; i < HEAT_N; i++) {
          pushData[i * 2]     = fx[i];
          pushData[i * 2 + 1] = fy[i];
        }
        pushTexture.needsUpdate = true;
      }
    },

    reset() {
      smoothedRaw.fill(0);
      heatData.fill(0);
      fx.fill(0);
      fy.fill(0);
      pushData.fill(0);
      heatTexture.needsUpdate = true;
      pushTexture.needsUpdate = true;
    },

    dispose() {
      heatTexture.dispose();
      pushTexture.dispose();
    },
  };
}

/**
 * GLSL shared by every heat-displacement pattern: given the particle's screen-space
 * UV in heat-map space, return the displacement vector for the active mode. The
 * caller multiplies the result by its own halfH (half the view height in world
 * units at that depth) and nothing else.
 *
 * Attract takes the instantaneous gradient, scaled by Heat Gain and Heat Strength.
 * Push Away reads the field with memory, which is already stored in screen-height
 * fractions and calibrated on the CPU — so `× 2 × halfH` lands it exactly where
 * Solidity says it should go, with no further scaling.
 */
export const HEAT_DISPLACE_GLSL = /* glsl */ `
  uniform sampler2D uHeatMap;
  uniform sampler2D uPushField;
  uniform float     uHeatMode;    // 0 = Attract, 1 = Push Away
  uniform float     uHeatGain;
  uniform float     uHeatStrength;

  vec2 heatDisplace(vec2 uv) {
    if (uHeatMode > 0.5) return texture2D(uPushField, uv).rg * 2.0;
    vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
    float hL = texture2D(uHeatMap, uv - vec2(eps.x, 0.0)).r;
    float hR = texture2D(uHeatMap, uv + vec2(eps.x, 0.0)).r;
    float hD = texture2D(uHeatMap, uv - vec2(0.0, eps.y)).r;
    float hU = texture2D(uHeatMap, uv + vec2(0.0, eps.y)).r;
    return vec2(hR - hL, hU - hD) * uHeatGain * uHeatStrength;
  }
`;
