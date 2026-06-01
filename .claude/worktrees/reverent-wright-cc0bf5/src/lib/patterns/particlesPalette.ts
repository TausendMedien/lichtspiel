import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

const COUNT = 50000;

let pointSize  = 7.0;
let flowSpeed  = 0.2;
let brightness = 1.0;
let saturation = 0.80;

// Per-color brightness multipliers (0–1)
let colCyan    = 1.0;
let colMagenta = 1.0;
let colPurple  = 1.0;
let colGold    = 1.0;
let colWhite   = 1.0;
let colBlack   = 1.0;

let points: THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let accTime = 0;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vSeed;

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    vec3 disp = flow(p * 0.5 + aSeed, uTime) * 0.6;
    p += disp;
    float ang = uTime * 0.05 + aSeed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uSaturation;
  uniform float uBrightness;
  uniform float uColCyan;
  uniform float uColMagenta;
  uniform float uColPurple;
  uniform float uColGold;
  uniform float uColWhite;
  uniform float uColBlack;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d);

    // Standard palette: cyan, magenta, purple, gold, white, black
    vec3 palette[6];
    palette[0] = vec3(0.0,  1.0,  1.0)    * uColCyan;
    palette[1] = vec3(1.0,  0.0,  1.0)    * uColMagenta;
    palette[2] = vec3(0.6,  0.0,  1.0)    * uColPurple;
    palette[3] = vec3(1.0,  0.843, 0.0)   * uColGold;
    palette[4] = vec3(1.0,  1.0,  1.0)    * uColWhite;
    palette[5] = vec3(0.02, 0.02, 0.05)   * uColBlack;

    int idx = int(fract(vSeed) * 6.0);
    vec3 col = palette[idx];

    // Saturation (0 = B&W, 1 = full color)
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);
    col = clamp(col * uBrightness, 0.0, 1.0);

    gl_FragColor = vec4(col, alpha);
  }
`;

export const particlesPalette: Pattern = {
  id: "particlesPalette",
  name: "Particle Field — Palette",
  controls: [
    { label: "Point Size",  type: "range", min: 0.3, max: 10.0, step: 0.1,  default: 7,   get: () => pointSize,  set: (v) => { pointSize = v; } },
    { label: "Flow Speed",  type: "range", min: 0.0, max: 3.0,  step: 0.1,  default: 0.2, get: () => flowSpeed,  set: (v) => { flowSpeed = v; } },
    { label: "Brightness",  type: "range", min: 0.0, max: 1.0,  step: 0.05, default: 1.0, get: () => brightness, set: (v) => { brightness = v; } },
    { label: "Saturation",  type: "range", min: 0.0, max: 1.0,  step: 0.05, default: 0.8, get: () => saturation, set: (v) => { saturation = v; } },
    { label: "separator", type: "separator" },
    { label: "Cyan",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colCyan,    set: (v) => { colCyan = v; } },
    { label: "Magenta", type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colMagenta, set: (v) => { colMagenta = v; } },
    { label: "Purple",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colPurple,  set: (v) => { colPurple = v; } },
    { label: "Gold",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colGold,    set: (v) => { colGold = v; } },
    { label: "White",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colWhite,   set: (v) => { colWhite = v; } },
    { label: "Dark",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1.0, get: () => colBlack,   set: (v) => { colBlack = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = Math.cbrt(Math.random()) * 4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = Math.random();
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed",    new THREE.BufferAttribute(seeds, 1));

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uSize:       { value: pointSize },
        uBrightness: { value: brightness },
        uSaturation: { value: saturation },
        uColCyan:    { value: colCyan },
        uColMagenta: { value: colMagenta },
        uColPurple:  { value: colPurple },
        uColGold:    { value: colGold },
        uColWhite:   { value: colWhite },
        uColBlack:   { value: colBlack },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    points = new THREE.Points(geometry, material);
    ctx.scene.add(points);
  },

  update(dt: number) {
    if (!material) return;
    accTime += dt * flowSpeed;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uSize.value       = pointSize;
    material.uniforms.uBrightness.value = brightness;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColCyan.value    = colCyan;
    material.uniforms.uColMagenta.value = colMagenta;
    material.uniforms.uColPurple.value  = colPurple;
    material.uniforms.uColGold.value    = colGold;
    material.uniforms.uColWhite.value   = colWhite;
    material.uniforms.uColBlack.value   = colBlack;
  },

  resize() {},

  dispose() {
    geometry?.dispose();
    material?.dispose();
    points = null;
    geometry = null;
    material = null;
    camera = null;
    accTime = 0;
    brightness = 1.0;
    saturation = 0.80;
    colCyan = colMagenta = colPurple = colGold = colWhite = colBlack = 1.0;
  },
};
