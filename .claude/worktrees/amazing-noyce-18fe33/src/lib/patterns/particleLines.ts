import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

// Each line is a head+tail vertex pair placed close together at init.
// Both travel through the same flow field, so they stay near each other → short animated strokes.
const PAIR_COUNT = 10000;
const COUNT = PAIR_COUNT * 2;

let brightness = 0.6;
let flowSpeed = 0.2;
let colorRange = 1.0;
let saturation = 0.60;
let tailOffset = 0.18; // initial spread; baked at init — change takes effect after pattern switch

let lineSegments: THREE.LineSegments | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let accTime = 0;

const vertexShader = /* glsl */ `
  uniform float uTime;
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
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uAlpha;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float hue = 0.5 + fract(vSeed * uColorRange) * 0.33;
    vec3 col = hsl2rgb(hue, 1.0, 0.6);
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);
    gl_FragColor = vec4(col, uAlpha);
  }
`;

export const particleLines: Pattern = {
  id: "particleLines",
  name: "Particle Lines",
  controls: [
    { label: "Brightness",  type: "range", min: 0.05, max: 1.0,  step: 0.05, default: 0.6,  get: () => brightness,  set: (v) => { brightness = v; } },
    { label: "Flow Speed",  type: "range", min: 0.0,  max: 3.0,  step: 0.1,  default: 0.2,  get: () => flowSpeed,   set: (v) => { flowSpeed = v; } },
    { label: "Tail Length", type: "range", min: 0.02, max: 0.8,  step: 0.02, default: 0.18, get: () => tailOffset,  set: (v) => { tailOffset = v; } },
    { label: "Colors",      type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 1.0,  get: () => colorRange,  set: (v) => { colorRange = v; } },
    { label: "Saturation",  type: "range", min: 0.0,  max: 1.0,  step: 0.05, default: 0.6,  get: () => saturation,  set: (v) => { saturation = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);

    for (let i = 0; i < PAIR_COUNT; i++) {
      const r = Math.cbrt(Math.random()) * 4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);
      const seed = Math.random();

      const hi = i * 2;
      positions[hi * 3]     = x;
      positions[hi * 3 + 1] = y;
      positions[hi * 3 + 2] = z;
      seeds[hi] = seed;

      const ti = i * 2 + 1;
      positions[ti * 3]     = x + (Math.random() - 0.5) * tailOffset;
      positions[ti * 3 + 1] = y + (Math.random() - 0.5) * tailOffset;
      positions[ti * 3 + 2] = z + (Math.random() - 0.5) * tailOffset;
      seeds[ti] = seed + 0.0001;
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uColorRange: { value: colorRange },
        uSaturation: { value: saturation },
        uAlpha:      { value: brightness },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    lineSegments = new THREE.LineSegments(geometry, material);
    ctx.scene.add(lineSegments);
  },

  update(dt: number) {
    if (!material) return;
    accTime += dt * flowSpeed;
    material.uniforms.uTime.value = accTime;
    material.uniforms.uColorRange.value = colorRange;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uAlpha.value = brightness;
  },

  resize() {},

  dispose() {
    geometry?.dispose();
    material?.dispose();
    lineSegments = null;
    geometry = null;
    material = null;
    camera = null;
    accTime = 0;
  },
};
