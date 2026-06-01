import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let lineCount  = 124;
let flowSpeed  = 0.02;
let warpAmount = 0.5;
let lineWidth  = 0.45;
let colorRange = 0.6;
let saturation = 1.0;
let colorSpeed = 0.0;
let brightness = 0.80;
let rotateSpeed = 0.01;

let colorPhase = 0;
let rotAngle   = 0;

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
  uniform float uLineCount;
  uniform float uFlowSpeed;
  uniform float uWarpAmount;
  uniform float uLineWidth;
  uniform float uColorRange;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p  = p * 2.1 + vec2(3.1, 1.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 centered = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 p = vec2(centered.x * cosR - centered.y * sinR,
                  centered.x * sinR + centered.y * cosR);

    float t = uTime * uFlowSpeed;

    // Multi-level domain warp for organic curl
    vec2 q = vec2(fbm(p * 1.4 + t),
                  fbm(p * 1.4 + vec2(5.2, 1.3) - t * 0.7));
    vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.5),
                  fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 0.3));

    // Stream function: angle from center, warped into organic curves
    vec2 wp = p + r * uWarpAmount * 0.45;
    float psi = atan(wp.y, wp.x) / 3.14159;          // -1..1 (angle)
    psi += (fbm(p * 1.8 + q + t * 0.35) - 0.5) * uWarpAmount;

    // Stripe lines along contours of psi
    float stripe = fract(psi * uLineCount * 0.5);
    float aa = fwidth(stripe) * 1.5;
    float lw = clamp(uLineWidth * 0.5, aa * 2.0, 0.49);
    float line = smoothstep(0.0, aa, stripe) * smoothstep(lw, lw - aa, stripe);

    // Palette: cyan (0.50) → blue (0.66) → magenta (0.83) → pink (0.92)
    float hue = 0.62 + sin(uColorPhase + psi * uColorRange * 3.14159
                           + length(p) * 2.0) * 0.22;
    float dist = length(p);
    float lit  = 0.25 + 0.55 * line + 0.1 * exp(-dist * 3.0);
    vec3 col = hsl2rgb(hue, uSaturation, clamp(lit, 0.0, 1.0)) * line * uBrightness;

    // Soft center glow (cyan-white)
    float glow = exp(-dist * 5.0) * 0.6 * uBrightness;
    col += mix(vec3(0.4, 1.0, 0.95), vec3(1.0), glow * 0.5) * glow;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const flowLines: Pattern = {
  id: "flowLines",
  name: "Flow Lines",
  controls: [
    { label: "Line Count",   type: "range", min: 10,  max: 150, step: 1, default: 124,    get: () => lineCount,   set: (v) => { lineCount = v; } },
    { label: "Flow Speed",   type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.02, get: () => flowSpeed,   set: (v) => { flowSpeed = v; } },
    { label: "Warp Amount",  type: "range", min: 0.0, max: 3.0, step: 0.05, default: 0.5, get: () => warpAmount,  set: (v) => { warpAmount = v; } },
    { label: "Line Width",   type: "range", min: 0.1, max: 0.9, step: 0.01, default: 0.45, get: () => lineWidth,   set: (v) => { lineWidth = v; } },
    { label: "Colors",       type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.6, get: () => colorRange,  set: (v) => { colorRange = v; } },
    { label: "Color Speed",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0, get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Saturation",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Brightness",   type: "range", min: 0.2, max: 2.0, step: 0.05, default: 0.8, get: () => brightness,  set: (v) => { brightness = v; } },
    { label: "Rotate",       type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.01, get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uLineCount:   { value: lineCount },
        uFlowSpeed:   { value: flowSpeed },
        uWarpAmount:  { value: warpAmount },
        uLineWidth:   { value: lineWidth },
        uColorRange:  { value: colorRange },
        uSaturation:  { value: saturation },
        uColorPhase:  { value: colorPhase },
        uBrightness:  { value: brightness },
        uRotAngle:    { value: rotAngle },
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

  update(dt: number, elapsed: number) {
    if (!material) return;
    colorPhase += dt * colorSpeed * 0.5;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value       = elapsed;
    material.uniforms.uLineCount.value  = lineCount;
    material.uniforms.uFlowSpeed.value  = flowSpeed;
    material.uniforms.uWarpAmount.value = warpAmount;
    material.uniforms.uLineWidth.value  = lineWidth;
    material.uniforms.uColorRange.value = colorRange;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColorPhase.value = colorPhase;
    material.uniforms.uBrightness.value = brightness;
    material.uniforms.uRotAngle.value   = rotAngle;
  },

  resize(width: number, height: number) {
    if (material) material.uniforms.uResolution.value.set(width, height);
  },

  dispose() {
    geometry?.dispose();
    material?.dispose();
    mesh = null;
    geometry = null;
    material = null;
  },
};
