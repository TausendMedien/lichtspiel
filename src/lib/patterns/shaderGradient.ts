import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const HW = 160, HH = 90;

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let scene: THREE.Scene | null = null;
let speed = 0.02;
let accTime = 0;
let colors = 0.85;
let dynamic = 0.6;

// Heat state — DataTexture drives Sobel UV distortion in fragment shader
let heatStrength = 0.5;
let heatBlurR    = 3;
let heatSmoothed: Float32Array | null = null;
let heatTmp:      Float32Array | null = null;
let heatTex:      THREE.DataTexture | null = null;

function heatBoxBlur(src: Float32Array, dst: Float32Array, tmp: Float32Array, W: number, H: number, r: number) {
  const R = Math.max(1, Math.round(r));
  const inv = 1 / (2 * R + 1);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = 0; x <= R; x++) sum += src[y * W + Math.min(x, W - 1)];
    for (let x = 0; x < W; x++) {
      if (x + R < W) sum += src[y * W + x + R];
      if (x - R - 1 >= 0) sum -= src[y * W + x - R - 1];
      tmp[y * W + x] = sum * inv;
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = 0; y <= R; y++) sum += tmp[Math.min(y, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      if (y + R < H) sum += tmp[(y + R) * W + x];
      if (y - R - 1 >= 0) sum -= tmp[(y - R - 1) * W + x];
      dst[y * W + x] = sum * inv;
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
  uniform float uColors;
  uniform float uDynamic;
  uniform vec2 uResolution;
  uniform float uColorsV2;
  uniform vec3  uMainColor;
  uniform sampler2D uHeatMap;
  uniform float uHeatStrength;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;

    if (uHeatStrength > 0.001) {
      vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
      vec2 hUv = vec2(1.0 - vUv.x, 1.0 - vUv.y);
      float hL = texture2D(uHeatMap, clamp(hUv - vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hR = texture2D(uHeatMap, clamp(hUv + vec2(eps.x, 0.0), 0.0, 1.0)).r;
      float hD = texture2D(uHeatMap, clamp(hUv - vec2(0.0, eps.y), 0.0, 1.0)).r;
      float hU = texture2D(uHeatMap, clamp(hUv + vec2(0.0, eps.y), 0.0, 1.0)).r;
      vec2 grad = vec2(hR - hL, hU - hD);
      p += grad * uHeatStrength * 1.2;
    }

    float t = uTime;
    vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
    vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t), fbm(p + 4.0 * q + vec2(8.3, 2.8) - t));
    float f = fbm(p + 4.0 * r);

    // Cyberpunk palette: deep indigo → cyan → magenta → electric blue
    vec3 col = mix(
      vec3(0.02, 0.04, 0.25),        // deep indigo
      vec3(0.0,  0.85, 1.0),         // bright cyan
      clamp(f * f * 2.4, 0.0, 1.0)
    );
    col = mix(col, vec3(0.95, 0.05, 0.9) * uColors, clamp(length(q) * 0.6, 0.0, 1.0));
    col = mix(col, vec3(0.1,  0.5,  1.0) * uColors, clamp(r.x * r.y * 1.4, 0.0, 1.0));

    // Dynamic: contrast around mid-gray (0 = flat/uniform, 1 = full contrast)
    float contrast = 0.2 + uDynamic * 1.8;
    col = (col - 0.5) * contrast + 0.5;
    col = clamp(col, 0.0, 1.0);

    col = clamp(col, 0.0, 1.0);

    vec3 _orig = col;
    float _luma = dot(_orig, vec3(0.299, 0.587, 0.114));
    float _ph1 = clamp(uColorsV2, 0.0, 1.0);
    float _ph2 = clamp((uColorsV2 - 1.0) / 2.0, 0.0, 1.0);
    col = mix(mix(vec3(_luma), uMainColor * (0.2 + _luma * 0.8), _ph1), _orig, _ph2);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const shaderGradient: Pattern = {
  id: "shaderGradient",
  name: "Shader Gradient",
  heatReactive: true,
  controls: [
    { label: "Speed",         type: "range", min: 0.005, max: 0.15, step: 0.005, default: 0.02, tip: "How fast the gradient flows and shifts across the screen.", get: () => speed,   set: (v) => { speed = v; } },
    { label: "Dynamic",       type: "range", min: 0.0,   max: 1.0,  step: 0.05,  default: 0.6,  tip: "Amount of noise turbulence added to the gradient. 0 = smooth, 1 = fully animated.", get: () => dynamic, set: (v) => { dynamic = v; } },
    { label: "Heat Strength", type: "range", min: 0, max: 2, step: 0.1, default: 0.5, interactive: 'heat' as const, tip: "How much heat-map motion bends the gradient around the body. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Blur Radius",   type: "range", min: 0, max: 8, step: 1,   default: 3,   interactive: 'heat' as const, tip: "Radius of heat-map blur — larger = broader glow around motion zones. Requires Heat.",  get: () => heatBlurR,    set: v => { heatBlurR = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    scene = ctx.scene;

    heatSmoothed = new Float32Array(HW * HH);
    heatTmp      = new Float32Array(HW * HH);
    heatTex = new THREE.DataTexture(heatSmoothed, HW, HH, THREE.RedFormat, THREE.FloatType);
    heatTex.minFilter = heatTex.magFilter = THREE.LinearFilter;
    heatTex.needsUpdate = true;

    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uColors:      { value: colors },
        uDynamic:     { value: dynamic },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uColorsV2:    { value: colorC2.colorsV2 },
        uMainColor:   { value: new THREE.Vector3() },
        uHeatMap:     { value: heatTex },
        uHeatStrength:{ value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material || !heatSmoothed || !heatTmp || !heatTex) return;
    accTime += dt * speed;

    const raw = cameraState.heatMap;
    for (let i = 0; i < HW * HH; i++)
      heatSmoothed[i] = heatSmoothed[i] * 0.82 + Math.max(0, raw[i] - 0.008) * 0.18;
    if (heatBlurR >= 1) heatBoxBlur(heatSmoothed, heatSmoothed, heatTmp, HW, HH, heatBlurR);
    heatTex.needsUpdate = true;

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uColors.value       = colors;
    material.uniforms.uDynamic.value      = dynamic;
    material.uniforms.uHeatMap.value      = heatTex;
    material.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
    const _mc = new THREE.Color(colorC2.main);
    material.uniforms.uMainColor.value.set(_mc.r, _mc.g, _mc.b);
    material.uniforms.uColorsV2.value = colorC2.colorsV2;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    heatTex?.dispose();
    mesh = null;
    geometry = null;
    material = null;
    camera = null;
    scene = null;
    heatTex = null;
    heatSmoothed = null;
    heatTmp = null;
    accTime = 0;
  },
};
