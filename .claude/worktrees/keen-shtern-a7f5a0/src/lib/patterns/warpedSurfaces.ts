import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let warpIterations = 2;  // select index → 1, 2, 3, 4
let noiseScale    = 1.2;
let warpAmount    = 1.6;
let flowSpeed     = 0.04;
let palette       = 0;   // select: Iridescent / Fire / Ocean / Void
let saturation    = 0.9;
let brightness    = 1.1;

let accTime = 0;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uNoiseScale;
  uniform float uWarpAmount;
  uniform int   uIterations;
  uniform int   uPalette;
  uniform float uSaturation;
  uniform float uBrightness;

  #define PI  3.14159265358979
  #define TAU 6.28318530717959

  // Value noise
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a*noise(p); p = p*2.1+vec2(3.7,1.3); a *= 0.5; }
    return v;
  }

  // Polar domain warp — rotates p by angle*amount radians around origin
  vec2 polarWarp(vec2 p, float angle, float amount) {
    float r     = length(p);
    float theta = atan(p.y, p.x) + angle * amount;
    return vec2(cos(theta), sin(theta)) * r;
  }

  vec2 warpedPos(vec2 p, float t) {
    for (int i = 0; i < 4; i++) {
      if (i >= uIterations) break;
      float a = fbm(p * 0.8 + t * 0.07 + float(i) * 3.1) * TAU;
      float m = fbm(p * 0.6 - t * 0.05 + float(i) * 1.7) * uWarpAmount;
      p = polarWarp(p, a, m);
    }
    return p;
  }

  // Piecewise palette — no green hues anywhere
  vec3 applyPalette(float v) {
    float t = fract(v);
    if (uPalette == 0) { // Iridescent: dark indigo → cyan → gold → dark
      vec3 dark = vec3(0.04, 0.03, 0.18);
      vec3 cyan = vec3(0.0,  0.87, 1.0);
      vec3 gold = vec3(1.0,  0.76, 0.05);
      if (t < 0.40) return mix(dark, cyan, t / 0.40);
      if (t < 0.70) return mix(cyan, gold, (t - 0.40) / 0.30);
      return              mix(gold, dark, (t - 0.70) / 0.30);
    }
    if (uPalette == 1) { // Fire: black → deep red → orange → gold
      vec3 blk  = vec3(0.02, 0.0,  0.0);
      vec3 red  = vec3(0.70, 0.05, 0.0);
      vec3 oran = vec3(0.95, 0.40, 0.0);
      vec3 gold = vec3(1.0,  0.82, 0.1);
      if (t < 0.35) return mix(blk,  red,  t / 0.35);
      if (t < 0.65) return mix(red,  oran, (t - 0.35) / 0.30);
      return              mix(oran, gold, (t - 0.65) / 0.35);
    }
    if (uPalette == 2) { // Ocean: deep blue → teal → cyan → gold
      vec3 deep = vec3(0.0,  0.05, 0.20);
      vec3 teal = vec3(0.0,  0.50, 0.60);
      vec3 cyan = vec3(0.10, 0.88, 1.0);
      vec3 gold = vec3(0.90, 0.72, 0.05);
      if (t < 0.35) return mix(deep, teal, t / 0.35);
      if (t < 0.65) return mix(teal, cyan, (t - 0.35) / 0.30);
      return              mix(cyan, gold, (t - 0.65) / 0.35);
    }
    // Void: deep purple → violet → magenta
    vec3 dark   = vec3(0.04, 0.0,  0.10);
    vec3 violet = vec3(0.45, 0.0,  0.85);
    vec3 magen  = vec3(0.90, 0.10, 0.75);
    if (t < 0.5) return mix(dark,   violet, t * 2.0);
    return            mix(violet, magen,  (t - 0.5) * 2.0);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * uNoiseScale;

    vec2 wp = warpedPos(p, uTime);
    float v = fbm(wp * 1.4 + uTime * 0.03);

    vec3 col = applyPalette(v);

    // Saturation
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);

    col *= uBrightness;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const warpedSurfaces: Pattern = {
  id: "warpedSurfaces",
  name: "Warped Surfaces",
  attribution: "Inspired by Anton Palsson (palmdrop) — surfaces",
  controls: [
    { label: "Warp Iterations", type: "select", options: ["1", "2", "3", "4"],
      get: () => warpIterations - 1, set: (v) => { warpIterations = v + 1; } },
    { label: "Noise Scale",  type: "range", min: 0.3, max: 3.0, step: 0.05, default: 1.2, get: () => noiseScale,  set: (v) => { noiseScale = v; } },
    { label: "Warp Amount",  type: "range", min: 0.0, max: 4.0, step: 0.1,  default: 1.6, get: () => warpAmount,  set: (v) => { warpAmount = v; } },
    { label: "Flow Speed",   type: "range", min: 0.0, max: 0.4, step: 0.005, default: 0.04, get: () => flowSpeed, set: (v) => { flowSpeed = v; } },
    { label: "Color Palette", type: "select", options: ["Iridescent", "Fire", "Ocean", "Void"],
      get: () => palette, set: (v) => { palette = v; } },
    { label: "Saturation",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.9,  get: () => saturation, set: (v) => { saturation = v; } },
    { label: "Brightness",   type: "range", min: 0.2, max: 2.0, step: 0.05, default: 1.1,  get: () => brightness, set: (v) => { brightness = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uNoiseScale: { value: noiseScale },
        uWarpAmount: { value: warpAmount },
        uIterations: { value: warpIterations },
        uPalette:    { value: palette },
        uSaturation: { value: saturation },
        uBrightness: { value: brightness },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime += dt * flowSpeed;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uNoiseScale.value = noiseScale;
    material.uniforms.uWarpAmount.value = warpAmount;
    material.uniforms.uIterations.value = warpIterations;
    material.uniforms.uPalette.value    = palette;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uBrightness.value = brightness;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    accTime = 0;
  },
};
