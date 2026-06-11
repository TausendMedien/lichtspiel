import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";

const W = 160;
const H = 90;

let particleCount = 30000;
let pointSize     = 3.0;
let flowSpeed     = 0.2;
let heatStrength  = 0.3;
let heatGain      = 5.0;

const MAX_PARTICLES = 50000;

let points: THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let heatTexture: THREE.DataTexture | null = null;
let heatTexData: Float32Array | null = null;
let accTime = 0;
let currentAspect = 1;

const vertexShader = /* glsl */ `
  uniform float     uTime;
  uniform float     uSize;
  uniform sampler2D uHeatMap;
  uniform float     uHeatStrength;
  uniform float     uHeatGain;
  attribute float   aSeed;
  varying float     vSeed;

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    p += flow(p * 0.5 + aSeed, uTime) * 0.6;
    float ang = uTime * 0.05 + aSeed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;

    // Attract particles toward hot zones in the heat map.
    // Sample 4 neighbours to approximate the 2-D gradient, then displace.
    vec4 mv0   = modelViewMatrix * vec4(p, 1.0);
    vec4 clip0 = projectionMatrix * mv0;
    if (clip0.w > 0.0) {
      // Screen-space UV; flip Y so row-0 of the diff buffer = top of screen.
      vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
      uv.y    = 1.0 - uv.y;

      vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
      float hL = texture2D(uHeatMap, uv - vec2(eps.x, 0.0)).r;
      float hR = texture2D(uHeatMap, uv + vec2(eps.x, 0.0)).r;
      float hD = texture2D(uHeatMap, uv - vec2(0.0, eps.y)).r;
      float hU = texture2D(uHeatMap, uv + vec2(0.0, eps.y)).r;
      vec2 grad = vec2(hR - hL, hU - hD) * uHeatGain;

      // Scale by view-depth so displacement feels consistent regardless of z.
      float depth = max(-mv0.z, 0.1);
      float halfH = depth * tan(radians(30.0));
      p.x += grad.x * halfH * uHeatStrength;
      p.y += grad.y * halfH * uHeatStrength;
    }

    vec4 mv      = modelViewMatrix * vec4(p, 1.0);
    gl_Position  = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uColorRange2;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d);

    float sat2    = clamp(uColorRange2, 0.0, 1.0);
    float spread2 = max(0.0, uColorRange2 - 1.0) / 2.0;
    float hue     = 0.5 + fract(vSeed * spread2) * 0.33;
    vec3 col      = hsl2rgb(hue, sat2, 0.6);

    gl_FragColor = vec4(col, alpha);
  }
`;

// Persistent position/seed store — same strategy as particlesBody.
let posStore  = new Float32Array(MAX_PARTICLES * 3);
let seedStore = new Float32Array(MAX_PARTICLES);
let storedCount = 0;

function ensureStore(n: number) {
  while (storedCount < n) {
    const i     = storedCount;
    const r     = Math.cbrt(Math.random()) * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    posStore[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    posStore[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    posStore[i * 3 + 2] = r * Math.cos(phi);
    seedStore[i] = Math.random();
    storedCount++;
  }
}

function buildGeometry(): THREE.BufferGeometry {
  ensureStore(MAX_PARTICLES);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(posStore, 3));
  geo.setAttribute("aSeed",    new THREE.BufferAttribute(seedStore, 1));
  geo.setDrawRange(0, particleCount);
  return geo;
}

export const particlesHeat: Pattern = {
  id: "particlesHeat",
  name: "Hyper Field - Heat",
  controls: [
    { label: "Point Size",    type: "range", min: 1.0,  max: 6.0,   step: 0.1,  default: 3,     get: () => pointSize,    set: v => { pointSize = v; } },
    { label: "Flow Speed",    type: "range", min: 0.0,  max: 3.0,   step: 0.1,  default: 0.2,   get: () => flowSpeed,    set: v => { flowSpeed = v; } },
    { label: "Heat Strength", type: "range", min: 0.0,  max: 2.0,   step: 0.05, default: 0.3,   get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range", min: 1.0,  max: 30.0,  step: 0.5,  default: 5,     get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Point Count",   type: "range", min: 5000, max: 50000, step: 1000, default: 30000,  get: () => particleCount, set: v => { particleCount = v; geometry?.setDrawRange(0, v); } },
  ],

  init(ctx: PatternContext) {
    ctx.camera.position.set(0, 0, 4);
    ctx.camera.lookAt(0, 0, 0);
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);

    heatTexData = new Float32Array(W * H);
    heatTexture = new THREE.DataTexture(heatTexData, W, H, THREE.RedFormat, THREE.FloatType);
    heatTexture.minFilter = THREE.LinearFilter;
    heatTexture.magFilter = THREE.LinearFilter;
    heatTexture.needsUpdate = true;

    geometry = buildGeometry();

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uSize:         { value: pointSize },
        uColorRange2:  { value: colorC2.colorsV2 },
        uHeatMap:      { value: heatTexture },
        uHeatStrength: { value: heatStrength },
        uHeatGain:     { value: heatGain },
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

  update(dt: number, _elapsed: number) {
    if (!material || !heatTexture || !heatTexData) return;
    accTime += dt * flowSpeed;

    heatTexData.set(cameraState.heatMap);
    heatTexture.needsUpdate = true;

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uSize.value         = pointSize;
    material.uniforms.uColorRange2.value  = colorC2.colorsV2;
    material.uniforms.uHeatStrength.value = heatStrength;
    material.uniforms.uHeatGain.value     = heatGain;
  },

  resize(w: number, h: number) {
    currentAspect = w / Math.max(h, 1);
  },

  dispose() {
    heatTexture?.dispose();
    geometry?.dispose();
    material?.dispose();
    points      = null;
    geometry    = null;
    material    = null;
    heatTexture = null;
    heatTexData = null;
    accTime     = 0;
    storedCount = 0;
  },
};
