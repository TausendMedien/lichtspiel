import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";

const W = 160;
const H = 90;

let particleCount = 30000;
let pointSize     = 3.0;
let flowSpeed     = 0.2;
let heatStrength  = 0.5;
let heatGain      = 11.0;
let blurRadius    = 4.0;
let mirrorX       = true;

const MAX_PARTICLES = 50000;

let points:      THREE.Points | null = null;
let geometry:    THREE.BufferGeometry | null = null;
let material:    THREE.ShaderMaterial | null = null;
let heatTexture: THREE.DataTexture | null = null;
let heatTexData: Float32Array | null = null;  // final blurred data, owned by DataTexture
let smoothedRaw: Float32Array | null = null;  // temporally smoothed raw heat
let tmpBuf:      Float32Array | null = null;  // H-pass intermediate
let accTime      = 0;
let currentAspect = 1;

// Separable box blur.  src → (H pass) → tmp → (V pass) → dst.
// O(W*H) per pass via sliding window sum — safe at 60 fps.
function boxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  // Horizontal pass: src → tmp
  for (let y = 0; y < H; y++) {
    const yo = y * W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < W; x++) {
      if (x + r < W)      { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0) { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  // Vertical pass: tmp → dst
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, H - 1); k++) { sum += tmp[k * W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < H; y++) {
      if (y + r < H)      { sum += tmp[(y + r) * W + x];     cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * W + x]; cnt--; }
      dst[y * W + x] = sum / cnt;
    }
  }
}

function updateHeatTexture() {
  if (!smoothedRaw || !tmpBuf || !heatTexData || !heatTexture) return;
  const raw = cameraState.heatMap;
  // Temporal smoothing: 82% old + 18% new — prevents frame-to-frame jumping.
  for (let i = 0; i < W * H; i++) {
    smoothedRaw[i] = smoothedRaw[i] * 0.82 + Math.max(0, raw[i] - 0.008) * 0.18;
  }
  // Spatial blur: extends gradient reach beyond the raw motion zone.
  boxBlur(smoothedRaw, tmpBuf, heatTexData, blurRadius);
  heatTexture.needsUpdate = true;
}

const vertexShader = /* glsl */ `
  uniform float     uTime;
  uniform float     uSize;
  uniform sampler2D uHeatMap;
  uniform float     uHeatStrength;
  uniform float     uHeatGain;
  uniform float     uMirrorX;
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

    // Sample gradient of the CPU-blurred heat map.
    // CPU blur already extends the signal beyond the raw motion zone,
    // so even distant particles see a non-zero gradient and are pulled in.
    vec4 mv0   = modelViewMatrix * vec4(p, 1.0);
    vec4 clip0 = projectionMatrix * mv0;
    if (clip0.w > 0.0) {
      vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
      uv.y = 1.0 - uv.y;
      if (uMirrorX > 0.5) uv.x = 1.0 - uv.x;

      vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
      float hL = texture2D(uHeatMap, uv - vec2(eps.x, 0.0)).r;
      float hR = texture2D(uHeatMap, uv + vec2(eps.x, 0.0)).r;
      float hD = texture2D(uHeatMap, uv - vec2(0.0, eps.y)).r;
      float hU = texture2D(uHeatMap, uv + vec2(0.0, eps.y)).r;
      vec2 grad = vec2(hR - hL, hU - hD) * uHeatGain;

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
  name: "Particle Field - Heat",
  motionControlLabels: ['Point Size', 'Flow Speed'],
  audioControlLabels:  ['Point Size', 'Flow Speed', 'Heat Strength'],

  activate() {
    cameraState.enabled = true;
  },

  controls: [
    { label: "Heat", type: "toggle" as const, get: () => cameraState.enabled, set: (v: boolean) => { cameraState.enabled = v; } },
    { label: "Point Size",    type: "range",  min: 1.0,  max: 6.0,   step: 0.1,  default: 3,    get: () => pointSize,    set: v => { pointSize = v; } },
    { label: "Flow Speed",    type: "range",  min: 0.0,  max: 3.0,   step: 0.1,  default: 0.2,  get: () => flowSpeed,    set: v => { flowSpeed = v; } },
    { label: "Heat Strength", type: "range",  min: 0.35, max: 1.0,   step: 0.01, default: 0.5,  get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range",  min: 4.0,  max: 20.0,  step: 0.5,  default: 11,   get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Blur Radius",   type: "range",  min: 0,    max: 10,    step: 0.1,  default: 4,    get: () => blurRadius,   set: v => { blurRadius = v; } },
    { label: "Point Count",   type: "range",  min: 5000, max: 50000, step: 1000, default: 30000, get: () => particleCount, set: v => { particleCount = v; geometry?.setDrawRange(0, v); } },
  ],

  init(ctx: PatternContext) {
    ctx.camera.position.set(0, 0, 4);
    ctx.camera.lookAt(0, 0, 0);
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);

    heatTexData = new Float32Array(W * H);
    smoothedRaw = new Float32Array(W * H);
    tmpBuf      = new Float32Array(W * H);
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
        uMirrorX:      { value: mirrorX ? 1.0 : 0.0 },
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

    updateHeatTexture();

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uSize.value         = pointSize;
    material.uniforms.uColorRange2.value  = colorC2.colorsV2;
    material.uniforms.uHeatStrength.value = heatStrength;
    material.uniforms.uHeatGain.value     = heatGain;
    material.uniforms.uMirrorX.value      = mirrorX ? 1.0 : 0.0;
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
    smoothedRaw = null;
    tmpBuf      = null;
    accTime     = 0;
    storedCount = 0;
  },
};
