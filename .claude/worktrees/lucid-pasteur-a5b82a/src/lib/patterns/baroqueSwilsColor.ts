import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let bandCount   = 13;
let flowSpeed   = 0.0;
let warpAmount  = 1.4;
let tealAmt     = 0.75;
let purpleAmt   = 0.80;
let saturation  = 0.50;
let colorSpeed  = 0.08;
let brightness  = 1.30;
let rotateSpeed = 0.0;

let paletteIndex = 1; // default: Purple/Teal (matches original look)
let colorA  = "#00d1b8";
let colorB  = "#750dcc";
let darkBase = "#000008";

let colorPhase = 0;
let rotAngle   = 0;
let accTime    = 0;

const PALETTES = [
  { a: "#00ffff", b: "#ff00ff", dark: "#000010" },
  { a: "#00d1b8", b: "#750dcc", dark: "#000008" },
  { a: "#ffd700", b: "#8b0000", dark: "#100000" },
];
const PALETTE_NAMES = ["Cyan/Magenta", "Purple/Teal", "Gold/Dark Red", "Custom"];

function hexToVec3(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uBandCount;
  uniform float uWarpAmount;
  uniform float uTealAmt;
  uniform float uPurpleAmt;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uDarkColor;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a*noise(p); p = p*2.1+vec2(3.1,1.7); a *= 0.5; }
    return v;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 p = vec2(c.x*cosR - c.y*sinR, c.x*sinR + c.y*cosR);
    float t = uTime;

    vec2 q = vec2(fbm(p * 1.3 + t),
                  fbm(p * 1.3 + vec2(5.2, 1.3) - t * 0.85));
    vec2 r = vec2(fbm(p * 0.9 + uWarpAmount * q + vec2(1.7, 9.2) + t * 0.6),
                  fbm(p * 0.9 + uWarpAmount * q + vec2(8.3, 2.8) - t * 0.4));
    float phi = fbm(p * 0.65 + uWarpAmount * 1.2 * r + uColorPhase * 0.15);

    float band = fract(phi * uBandCount);

    float tealMask   = smoothstep(0.04, 0.16, band) * smoothstep(0.46, 0.34, band);
    float purpleMask = smoothstep(0.54, 0.66, band) * smoothstep(0.96, 0.84, band);
    float edge = smoothstep(0.44, 0.48, band) * smoothstep(0.52, 0.48, band)
               + smoothstep(0.94, 0.97, band) * smoothstep(1.0,  0.97, band)
               + smoothstep(0.0,  0.03, band) * smoothstep(0.06, 0.03, band);

    vec3 ca = uColorA * uTealAmt;
    vec3 cb = uColorB * uPurpleAmt;

    float variation = fbm(p * 3.0 + q) * 0.25;
    vec3 caVar = normalize(uColorA + vec3(0.001)) * 0.1 * variation;
    vec3 cbVar = normalize(uColorB + vec3(0.001)) * 0.1 * variation;
    ca = mix(ca, ca + caVar, 0.5);
    cb = mix(cb, cb + cbVar, 0.5);

    vec3 col = uDarkColor + ca * tealMask + cb * purpleMask;
    col += vec3(0.85, 0.95, 0.9) * edge * 0.18;

    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);

    col *= uBrightness;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

function applyPalette(idx: number) {
  if (idx < 3) {
    colorA   = PALETTES[idx].a;
    colorB   = PALETTES[idx].b;
    darkBase = PALETTES[idx].dark;
  }
  if (material) {
    material.uniforms.uColorA.value.set(...hexToVec3(colorA));
    material.uniforms.uColorB.value.set(...hexToVec3(colorB));
    material.uniforms.uDarkColor.value.set(...hexToVec3(darkBase));
  }
}

export const baroqueSwilsColor: Pattern = {
  id: "baroqueSwilsColor",
  name: "Baroque Swirls · Color",
  controls: [
    { label: "Band Count",    type: "range", min: 2,   max: 20,  step: 1, default: 13,    get: () => bandCount,   set: v => { bandCount = v; } },
    { label: "Flow Speed",    type: "range", min: 0.0, max: 0.3, step: 0.005, default: 0, get: () => flowSpeed,   set: v => { flowSpeed = v; } },
    { label: "Warp Amount",   type: "range", min: 0.0, max: 3.0, step: 0.05, default: 1.4, get: () => warpAmount,  set: v => { warpAmount = v; } },
    { label: "Color A Mix",   type: "range", min: 0.0, max: 1.5, step: 0.05, default: 0.75, get: () => tealAmt,   set: v => { tealAmt = v; } },
    { label: "Color B Mix",   type: "range", min: 0.0, max: 1.5, step: 0.05, default: 0.8,  get: () => purpleAmt, set: v => { purpleAmt = v; } },
    { label: "Color Speed",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.08, get: () => colorSpeed,  set: v => { colorSpeed = v; } },
    { label: "Saturation",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.5,  get: () => saturation,  set: v => { saturation = v; } },
    { label: "Brightness",    type: "range", min: 0.2, max: 2.0, step: 0.05, default: 1.3,  get: () => brightness,  set: v => { brightness = v; } },
    { label: "Rotate",        type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0,    get: () => rotateSpeed, set: v => { rotateSpeed = v; } },
    { label: "Color Palette", type: "select", options: PALETTE_NAMES,
      get: () => paletteIndex,
      set: v => { paletteIndex = v; applyPalette(v); }
    },
    { label: "Color A",       type: "color", get: () => colorA,
      set: v => { colorA = v; paletteIndex = 3; if (material) material.uniforms.uColorA.value.set(...hexToVec3(v)); }
    },
    { label: "Color B",       type: "color", get: () => colorB,
      set: v => { colorB = v; paletteIndex = 3; if (material) material.uniforms.uColorB.value.set(...hexToVec3(v)); }
    },
    { label: "Dark Base",     type: "color", get: () => darkBase,
      set: v => { darkBase = v; paletteIndex = 3; if (material) material.uniforms.uDarkColor.value.set(...hexToVec3(v)); }
    },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uBandCount:  { value: bandCount },
        uWarpAmount: { value: warpAmount },
        uTealAmt:    { value: tealAmt },
        uPurpleAmt:  { value: purpleAmt },
        uSaturation: { value: saturation },
        uColorPhase: { value: colorPhase },
        uBrightness: { value: brightness },
        uRotAngle:   { value: rotAngle },
        uColorA:     { value: new THREE.Color(...hexToVec3(colorA)) },
        uColorB:     { value: new THREE.Color(...hexToVec3(colorB)) },
        uDarkColor:  { value: new THREE.Color(...hexToVec3(darkBase)) },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime    += dt * flowSpeed;
    colorPhase += dt * colorSpeed * 0.4;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uBandCount.value  = bandCount;
    material.uniforms.uWarpAmount.value = warpAmount;
    material.uniforms.uTealAmt.value    = tealAmt;
    material.uniforms.uPurpleAmt.value  = purpleAmt;
    material.uniforms.uSaturation.value = saturation;
    material.uniforms.uColorPhase.value = colorPhase;
    material.uniforms.uBrightness.value = brightness;
    material.uniforms.uRotAngle.value   = rotAngle;
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
