import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";

const W = 160;
const H = 90;

let particleCount = 30000;
let pointSize     = 3.0;
let flowSpeed     = 0.2;
let heatStrength  = 0.4;
let heatGain      = 8.0;
let mirrorX       = false;

const MAX_PARTICLES = 50000;

// Pre-allocated attractor pool (same pattern as particlesBody).
const MAX_ATTRACTORS = 16;
const attractors = Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector3());

let points:   THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let accTime      = 0;
let currentAspect = 1;
let scaleY        = 8.0;  // world-space height of the view frustum

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform vec3  uAttractors[16];
  uniform int   uAttractorCount;
  uniform float uAttractStrength;
  attribute float aSeed;
  varying float   vSeed;

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

    // Pull toward each active heat attractor (world-space, same formula as Particle Body).
    for (int i = 0; i < 16; i++) {
      if (i >= uAttractorCount) break;
      vec3 diff = uAttractors[i] - p;
      float dist = length(diff) + 0.001;
      float pull = uAttractStrength / (0.3 + dist * dist * 0.4);
      p += normalize(diff) * pull;
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

// Divide the heat map into a 4×4 grid.
// For each cell, compute a weighted centroid and convert to world space.
// Returns how many attractors were populated.
function buildAttractors(): number {
  const hd = cameraState.heatMap;
  const GRID_W = 4, GRID_H = 4;
  const RW = W / GRID_W;
  const RH = H / GRID_H;
  const sx = scaleY * currentAspect;
  const threshold = 0.008;
  let count = 0;
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      let wx = 0, wy = 0, w = 0;
      const x0 = Math.floor(gx * RW);
      const x1 = Math.floor((gx + 1) * RW);
      const y0 = Math.floor(gy * RH);
      const y1 = Math.floor((gy + 1) * RH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = Math.max(0, hd[y * W + x] - threshold) * heatGain;
          if (v > 0.01) { wx += x * v; wy += y * v; w += v; }
        }
      }
      if (w > 0.1 && count < MAX_ATTRACTORS) {
        const cx = wx / w / W;       // 0–1, left=0 right=1
        const cy = 1 - wy / w / H;  // 0–1, Y-flipped: top=1, bottom=0
        // Convert to world space.  Mirror X when front-facing camera is in use.
        const worldX = (mirrorX ? (0.5 - cx) : (cx - 0.5)) * sx;
        const worldY = (cy - 0.5) * scaleY;
        attractors[count].set(worldX, worldY, 0);
        count++;
      }
    }
  }
  return count;
}

export const particlesHeat: Pattern = {
  id: "particlesHeat",
  name: "Particle Field - Heat",
  controls: [
    { label: "Point Size",    type: "range", min: 1.0,  max: 6.0,   step: 0.1,   default: 3,      get: () => pointSize,    set: v => { pointSize = v; } },
    { label: "Flow Speed",    type: "range", min: 0.0,  max: 3.0,   step: 0.1,   default: 0.2,    get: () => flowSpeed,    set: v => { flowSpeed = v; } },
    { label: "Heat Strength", type: "range", min: 0.0,  max: 2.0,   step: 0.05,  default: 0.4,    get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range", min: 1.0,  max: 30.0,  step: 0.5,   default: 8,      get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Mirror X",      type: "toggle" as const,                                              get: () => mirrorX,      set: v => { mirrorX = v; } },
    { label: "Point Count",   type: "range", min: 5000, max: 50000, step: 1000,  default: 30000,   get: () => particleCount, set: v => { particleCount = v; geometry?.setDrawRange(0, v); } },
  ],

  init(ctx: PatternContext) {
    ctx.camera.position.set(0, 0, 4);
    ctx.camera.lookAt(0, 0, 0);
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);
    // Derive world-space view height from camera FOV and distance.
    scaleY = 2 * Math.tan((ctx.camera.fov * Math.PI) / 360) * 4;

    geometry = buildGeometry();

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:           { value: 0 },
        uSize:           { value: pointSize },
        uColorRange2:    { value: colorC2.colorsV2 },
        uAttractors:     { value: attractors },
        uAttractorCount: { value: 0 },
        uAttractStrength:{ value: heatStrength },
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
    if (!material) return;
    accTime += dt * flowSpeed;

    const count = buildAttractors();
    material.uniforms.uAttractorCount.value  = count;
    material.uniforms.uAttractStrength.value = heatStrength;
    material.uniforms.uTime.value            = accTime;
    material.uniforms.uSize.value            = pointSize;
    material.uniforms.uColorRange2.value     = colorC2.colorsV2;
  },

  resize(w: number, h: number) {
    currentAspect = w / Math.max(h, 1);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    points      = null;
    geometry    = null;
    material    = null;
    accTime     = 0;
    storedCount = 0;
  },
};
