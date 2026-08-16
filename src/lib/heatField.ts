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
import { pushState } from "./pushSettings.svelte";
import { privacyMode } from "./privacyMode.svelte";
import {
  HEAT_W, HEAT_H, HEAT_N,
  boxBlur, smoothHeat, stepPushField,
} from "./pushField";

export { HEAT_W, HEAT_H, boxBlur } from "./pushField";

/** True when the Push sensor is live — patterns set uPushMode from this. */
export function pushActive(): boolean {
  return pushState.enabled && cameraState.enabled && !privacyMode.active;
}

/** True when a pattern should be running its heat pipeline at all. */
export function heatOrPushActive(): boolean {
  return (cameraState.heatEnabled || pushState.enabled) && !privacyMode.active;
}

export interface HeatField {
  /** R float, 160×90 — smoothed + blurred motion. Drop-in for the old uHeatMap. */
  readonly heatTexture: THREE.DataTexture;
  /** RG float, 160×90 — persistent displacement with memory. */
  readonly pushTexture: THREE.DataTexture;
  /**
   * Refresh both textures. `blurRadius` is the pattern's own Heat Blur control;
   * `aspect` is its viewport aspect, needed because the push field is stored per
   * screen height. Push parameters come from the global Push sensor.
   */
  update(dt: number, blurRadius: number, aspect: number): void;
  /** Clear all state — on activate, and whenever the sensors are switched off. */
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

    update(dt: number, blurRadius: number, aspect: number) {
      smoothHeat(cameraState.heatMap, smoothedRaw);
      boxBlur(smoothedRaw, blurTmp, heatData, blurRadius);
      heatTexture.needsUpdate = true;

      if (pushActive() && (pushState.strength > 0 || pushState.solidity > 0)) {
        // Cap dt so a stalled tab can't jolt the field on the frame it resumes.
        stepPushField(heatData, fx, fy, fTmpA, fTmpB, Math.min(dt, 0.1), {
          strength:    pushState.strength,
          solidity:    pushState.solidity,
          returnSpeed: pushState.returnSpeed,
          spread:      pushState.spread,
          sensitivity: pushState.sensitivity,
          aspect,
        });
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
 * GLSL for the particle patterns (Particle Field, Hyper Mix, Gravity Lines): given
 * a particle's screen-space UV in heat-map space, the displacement for the active
 * sensor. The caller multiplies by its own halfH — half the view height in world
 * units at that depth — and nothing else.
 *
 * Heat takes the instantaneous gradient, scaled by Heat Gain and Heat Strength.
 * Push reads the field with memory, already stored in screen-height fractions and
 * calibrated on the CPU, so `× 2 × halfH` lands it exactly where Solidity says.
 */
export const HEAT_DISPLACE_GLSL = /* glsl */ `
  uniform sampler2D uHeatMap;
  uniform sampler2D uPushField;
  uniform float     uPushMode;    // 1 = the Push sensor is driving
  uniform float     uHeatGain;
  uniform float     uHeatStrength;

  vec2 heatDisplace(vec2 uv) {
    if (uPushMode > 0.5) return texture2D(uPushField, uv).rg * 2.0;
    vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
    float hL = texture2D(uHeatMap, uv - vec2(eps.x, 0.0)).r;
    float hR = texture2D(uHeatMap, uv + vec2(eps.x, 0.0)).r;
    float hD = texture2D(uHeatMap, uv - vec2(0.0, eps.y)).r;
    float hU = texture2D(uHeatMap, uv + vec2(0.0, eps.y)).r;
    return vec2(hR - hL, hU - hD) * uHeatGain * uHeatStrength;
  }
`;

/**
 * GLSL for the full-screen patterns, whose heat effect is a UV or position warp in
 * a space where 1.0 spans the screen height (Parallel Lines, Tunnel, Shader
 * Gradient, Warp Surfaces, Curl Orbs, Static Images…).
 *
 * Each of those hand-tuned its own gradient multiplier, so `k` keeps that tuning on
 * the Heat path. Push ignores `k`: the field already carries an absolute distance,
 * and honouring it is the whole point — Solidity 1 has to clear the area whatever a
 * pattern's taste for gradient strength happened to be.
 *
 * `uv` is in heat-map space (the caller applies its own mirror/flip first).
 * `pushScale` is how many of the caller's own units span one screen height — 1.0 for
 * a UV space normalised to the screen height, 2.0 for a -1..1 space, and so on.
 */
export const HEAT_WARP_GLSL = /* glsl */ `
  uniform sampler2D uHeatMap;
  uniform sampler2D uPushField;
  uniform float     uPushMode;    // 1 = the Push sensor is driving
  uniform float     uHeatStrength;

  vec2 heatWarp(vec2 uv, float k, float pushScale) {
    if (uPushMode > 0.5) return texture2D(uPushField, clamp(uv, 0.0, 1.0)).rg * pushScale;
    vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
    float hL = texture2D(uHeatMap, clamp(uv - vec2(eps.x, 0.0), 0.0, 1.0)).r;
    float hR = texture2D(uHeatMap, clamp(uv + vec2(eps.x, 0.0), 0.0, 1.0)).r;
    float hD = texture2D(uHeatMap, clamp(uv - vec2(0.0, eps.y), 0.0, 1.0)).r;
    float hU = texture2D(uHeatMap, clamp(uv + vec2(0.0, eps.y), 0.0, 1.0)).r;
    return vec2(hR - hL, hU - hD) * uHeatStrength * k;
  }
`;
