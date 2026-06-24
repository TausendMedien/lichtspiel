import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const W = 160, H = 90;

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed = 10;
let wobble = 0.0;
let ringCount = 42;
let lineThickness = 0.10;
let colorSpeed = 0.60;

let colorPhase = 0;
let accTime    = 0;

// Centroid-based center shift (keeps tunnel aimed at person)
let heatCenterStr = 1.0;
const heatOffset  = new THREE.Vector2();

// DataTexture Sobel — locally bends rings where motion edges are
let heatStrength  = 1.8;
let heatBlurR     = 1;
let heatSmoothed: Float32Array | null = null;
let heatTmp:      Float32Array | null = null;
let heatTexData:  Float32Array | null = null;
let heatTex:      THREE.DataTexture | null = null;

function computeHeatCentroid() {
  const map = cameraState.heatMap;
  let wx = 0, wy = 0, total = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = map[y * W + x];
      wx += v * x; wy += v * y; total += v;
    }
  return total > 0.01
    ? { cx: wx / total / W, cy: wy / total / H, total }
    : { cx: 0.5, cy: 0.5, total: 0 };
}

function heatBoxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  for (let y = 0; y < H; y++) {
    const yo = y * W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < W; x++) {
      if (x + r < W)     { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0) { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, H - 1); k++) { sum += tmp[k * W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < H; y++) {
      if (y + r < H)     { sum += tmp[(y + r) * W + x];     cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * W + x]; cnt--; }
      dst[y * W + x] = sum / cnt;
    }
  }
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uWobble;
  uniform float uRingCount;
  uniform float uLineWidth;
  uniform float uColorPhase;
  uniform float uColorSpread;
  uniform vec2  uHeatOffset;
  uniform sampler2D uHeatMap;
  uniform float uHeatStrength;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5 - uHeatOffset) * vec2(aspect, 1.0);

    // Heat Sobel: locally warps rings at body edges — each pixel bends independently
    if (uHeatStrength > 0.001) {
      vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
      vec2 hUv = vec2(1.0 - vUv.x, 1.0 - vUv.y);
      float hL = texture2D(uHeatMap, clamp(hUv - vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hR = texture2D(uHeatMap, clamp(hUv + vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hD = texture2D(uHeatMap, clamp(hUv - vec2(0.0, eps.y), 0.0, 1.0)).r;
      float hU = texture2D(uHeatMap, clamp(hUv + vec2(0.0, eps.y), 0.0, 1.0)).r;
      uv += vec2(hR - hL, hU - hD) * uHeatStrength * 0.3;
    }

    float r = length(uv);
    if (r < 0.001) discard;

    float depth = 1.0 / r;

    float wobbleOffset = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    float stripeRaw = (depth + wobbleOffset) * uRingCount * 0.042 - uTime * 0.05;
    float stripe    = fract(stripeRaw);

    float rawFw = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fw    = clamp(rawFw, 0.0001, uLineWidth * 0.45);
    float lw    = uLineWidth;
    float line  = smoothstep(0.0, fw, stripe)
                - smoothstep(max(lw - fw, fw), lw, stripe);

    float fade = 1.0 - smoothstep(1.5, 2.5, rawFw / lw);
    line *= fade;

    float centerFade = smoothstep(0.0, 0.10, r);
    line *= centerFade;

    if (line < 0.01) discard;

    float _sat    = clamp(uColorSpread, 0.0, 1.0);
    float _spread = max(0.0, uColorSpread - 1.0) / 2.0;
    float hue = 0.665 + sin(uColorPhase) * 0.165 * _spread;
    float lit = 0.55 + 0.15 * sin(uTime * 0.4 + depth * 0.2);
    vec3 col = hsl2rgb(hue, _sat, lit);

    float pulse = 0.85 + 0.15 * sin(uTime * 2.0 + stripe * 12.0);
    col *= pulse * line;

    gl_FragColor = vec4(col, line);
  }
`;

export const tunnel: Pattern = {
  id: "tunnel",
  name: "Tunnel",
  heatReactive: true,
  motionControlLabels: ["Speed", "Wobble"],
  audioControlLabels:  ["Thickness"],
  controls: [
    { label: "Speed",         type: "range", min: -40,  max: 40,  step: 1,    default: 10,  tip: "Fly-through speed. Positive = forwards, negative = backwards.", get: () => speed,         set: (v) => { speed = v; } },
    { label: "Wobble",        type: "range", min: 0,    max: 1.0, step: 0.05, default: 0,   tip: "Camera sway from side to side as you fly.",                   get: () => wobble,        set: (v) => { wobble = v; } },
    { label: "Ring Count",    type: "range", min: 1,    max: 50,  step: 1,    default: 42,  tip: "Number of rings visible at once.",                            get: () => ringCount,     set: (v) => { ringCount = v; } },
    { label: "Thickness",     type: "range", min: 0.02, max: 0.5, step: 0.02, default: 0.1, tip: "Width of each ring line.",                                    get: () => lineThickness, set: (v) => { lineThickness = v; } },
    { label: "Color Speed",   type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 0.6, tip: "How fast the palette cycles along the tunnel.",              get: () => colorSpeed,    set: (v) => { colorSpeed = v; } },
    { label: "Center Shift",  type: "range", min: 0, max: 2, step: 0.1, default: 1.0, interactive: 'heat' as const, tip: "How much heat-map position shifts the tunnel center toward the person. Requires Heat.", get: () => heatCenterStr, set: v => { heatCenterStr = v; } },
    { label: "Heat Strength", type: "range", min: 0, max: 2.5, step: 0.1, default: 1.8, interactive: 'heat' as const, tip: "How much heat-map edges locally warp the tunnel rings. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Blur Radius",   type: "range", min: 0, max: 8,   step: 1,   default: 1,   interactive: 'heat' as const, tip: "Radius of heat-map blur — larger = broader glow around motion zones. Requires Heat.", get: () => heatBlurR, set: v => { heatBlurR = v; } },
  ],

  init(ctx: PatternContext) {
    heatSmoothed = new Float32Array(W * H);
    heatTmp      = new Float32Array(W * H);
    heatTexData  = new Float32Array(W * H);
    heatTex = new THREE.DataTexture(heatTexData, W, H, THREE.RedFormat, THREE.FloatType);
    heatTex.minFilter = heatTex.magFilter = THREE.LinearFilter;
    heatTex.needsUpdate = true;

    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uWobble:      { value: wobble },
        uRingCount:   { value: ringCount },
        uLineWidth:   { value: lineThickness },
        uColorPhase:  { value: colorPhase },
        uColorSpread: { value: colorC2.colorsV2 },
        uHeatOffset:  { value: new THREE.Vector2(0, 0) },
        uHeatMap:     { value: heatTex },
        uHeatStrength:{ value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material || !heatSmoothed || !heatTmp || !heatTex) return;
    accTime    += dt * speed;
    colorPhase += dt * colorSpeed * 2.0;

    const raw = cameraState.heatMap;
    for (let i = 0; i < W * H; i++)
      heatSmoothed[i] = heatSmoothed[i] * 0.82 + Math.max(0, raw[i] - 0.008) * 0.18;
    heatBoxBlur(heatSmoothed, heatTmp, heatTexData!, heatBlurR);
    heatTex.needsUpdate = true;

    if (cameraState.heatEnabled) {
      const { cx, cy } = computeHeatCentroid();
      const tx = (0.5 - cx) * 0.35 * heatCenterStr;
      const ty = (0.5 - cy) * 0.35 * heatCenterStr;
      const spd = Math.min(1, dt * 2.5);
      heatOffset.x += (tx - heatOffset.x) * spd;
      heatOffset.y += (ty - heatOffset.y) * spd;
    } else {
      const decay = Math.max(0, 1 - dt * 3);
      heatOffset.x *= decay;
      heatOffset.y *= decay;
    }

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uWobble.value       = wobble;
    material.uniforms.uRingCount.value    = ringCount;
    material.uniforms.uLineWidth.value    = lineThickness;
    material.uniforms.uColorPhase.value   = colorPhase;
    material.uniforms.uColorSpread.value  = colorC2.colorsV2;
    material.uniforms.uHeatOffset.value.copy(heatOffset);
    material.uniforms.uHeatMap.value      = heatTex;
    material.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    heatTex?.dispose();
    mesh = null; geometry = null; material = null;
    heatTex = null; heatSmoothed = null; heatTmp = null; heatTexData = null;
    accTime = 0;
    heatOffset.set(0, 0);
  },
};
