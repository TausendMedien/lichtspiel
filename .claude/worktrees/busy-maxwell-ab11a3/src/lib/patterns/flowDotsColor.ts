import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let dotDensity  = 26;
let dotSize     = 0.42;
let warpAmount  = 1.75;
let flowSpeed   = 0.02;
let perspective = 1.9;
let saturation  = 0.50;
let colorSpeed  = 0.55;
let brightness  = 1.20;
let rotateSpeed = 0.03;
let opacity = 0.85;

let paletteIndex = 0;
let dotColor  = "#00eeff";
let bgColorA  = "#001019";
let bgColorB  = "#005266";

let colorPhase = 0;
let rotAngle   = 0;
let accTime = 0;

const PALETTES = [
  { dot: "#00eeff", bgA: "#001019", bgB: "#005266" },
  { dot: "#c084fc", bgA: "#0f0024", bgB: "#310060" },
  { dot: "#ffd700", bgA: "#1a0000", bgB: "#5c0000" },
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
  uniform float uDotDensity;
  uniform float uDotSize;
  uniform float uWarpAmount;
  uniform float uPerspective;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;
  uniform float uOpacity;
  uniform vec3  uDotColor;
  uniform vec3  uBgColorA;
  uniform vec3  uBgColorB;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a*noise(p); p = p*2.1+vec2(3.1,1.7); a *= 0.5; }
    return v;
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
    float cosR = cos(uRotAngle), sinR = sin(uRotAngle);
    vec2 p = vec2(c.x*cosR - c.y*sinR, c.x*sinR + c.y*cosR);
    float t = uTime;

    vec2 q = vec2(fbm(p * 1.4 + t),
                  fbm(p * 1.4 + vec2(5.2, 1.3) - t * 0.75));
    vec2 r = vec2(fbm(p * 0.9 + uWarpAmount * q + vec2(1.7, 9.2) + t * 0.45),
                  fbm(p * 0.9 + uWarpAmount * q + vec2(8.3, 2.8) - t * 0.3));
    float phi = fbm(p * 0.7 + uWarpAmount * r);

    vec3 bgCol = mix(uBgColorA, uBgColorB, phi * phi * 1.8);
    bgCol = mix(bgCol, uBgColorB * 1.5, q.y * 0.30);
    bgCol = mix(bgCol, uBgColorA * 1.8, r.x * 0.25);

    vec2 warpedP = p + (q - 0.5) * uWarpAmount * 0.32;
    vec2 cf = fract(warpedP * uDotDensity) - 0.5;
    float dd = length(cf);

    float perspGrad = clamp((p.x / aspect + 0.55) * 0.45 + (-p.y + 0.5) * 0.4, 0.04, 1.0);
    float rDot = uDotSize * (0.12 + 0.55 * phi + 0.33 * perspGrad * uPerspective) * 0.44;
    float aa   = max(fwidth(dd), 0.003);
    float dotMask = smoothstep(rDot + aa, rDot - aa, dd);

    vec2  ln  = cf / max(rDot, 0.001);
    float nz  = sqrt(max(0.0, 1.0 - dot(ln, ln)));
    vec3  sN  = normalize(vec3(ln, nz));
    vec3  ld  = normalize(vec3(-0.3, 0.65, 0.9));
    float df  = max(0.0, dot(sN, ld));
    float sp  = pow(max(0.0, dot(reflect(-ld, sN), vec3(0,0,1))), 22.0);
    vec3  dBase = mix(uDotColor, vec3(1.0), phi * 0.35 + perspGrad * 0.25);
    float gray  = dot(dBase, vec3(0.299, 0.587, 0.114));
    dBase = mix(vec3(gray), dBase, uSaturation);
    vec3  dCol = dBase * (0.3 + 0.7 * df) + vec3(1.0) * sp * 0.55;

    vec3 col = mix(bgCol, dCol * uBrightness, dotMask);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), mix(1.0, uOpacity, dotMask));
  }
`;

function applyPalette(idx: number) {
  if (idx < 3) {
    dotColor = PALETTES[idx].dot;
    bgColorA = PALETTES[idx].bgA;
    bgColorB = PALETTES[idx].bgB;
  }
  if (material) {
    material.uniforms.uDotColor.value.set(...hexToVec3(dotColor));
    material.uniforms.uBgColorA.value.set(...hexToVec3(bgColorA));
    material.uniforms.uBgColorB.value.set(...hexToVec3(bgColorB));
  }
}

export const flowDotsColor: Pattern = {
  id: "flowDotsColor",
  name: "Flow Dots · Color",
  controls: [
    { label: "Dot Density",    type: "range", min: 5,   max: 50,  step: 1, default: 26,    get: () => dotDensity,  set: v => { dotDensity = v; } },
    { label: "Dot Size",       type: "range", min: 0.1, max: 1.0, step: 0.01, default: 0.42, get: () => dotSize,   set: v => { dotSize = v; } },
    { label: "Warp Amount",    type: "range", min: 0.0, max: 3.0, step: 0.05, default: 1.75, get: () => warpAmount, set: v => { warpAmount = v; } },
    { label: "Flow Speed",     type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.02, get: () => flowSpeed,  set: v => { flowSpeed = v; } },
    { label: "Perspective",    type: "range", min: 0.0, max: 2.0, step: 0.05, default: 1.9,  get: () => perspective, set: v => { perspective = v; } },
    { label: "Color Speed",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.55, get: () => colorSpeed, set: v => { colorSpeed = v; } },
    { label: "Saturation",     type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.5,  get: () => saturation, set: v => { saturation = v; } },
    { label: "Brightness",     type: "range", min: 0.2, max: 2.0, step: 0.05, default: 1.2,  get: () => brightness, set: v => { brightness = v; } },
    { label: "Rotate",         type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0.03, get: () => rotateSpeed, set: v => { rotateSpeed = v; } },
    { label: "Opacity",        type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.85, get: () => opacity,    set: v => { opacity = v; } },
    { label: "Color Palette",  type: "select", options: PALETTE_NAMES,
      get: () => paletteIndex,
      set: v => { paletteIndex = v; applyPalette(v); }
    },
    { label: "Dot Color",      type: "color", get: () => dotColor,
      set: v => { dotColor = v; paletteIndex = 3; if (material) material.uniforms.uDotColor.value.set(...hexToVec3(v)); }
    },
    { label: "Background A",   type: "color", get: () => bgColorA,
      set: v => { bgColorA = v; paletteIndex = 3; if (material) material.uniforms.uBgColorA.value.set(...hexToVec3(v)); }
    },
    { label: "Background B",   type: "color", get: () => bgColorB,
      set: v => { bgColorB = v; paletteIndex = 3; if (material) material.uniforms.uBgColorB.value.set(...hexToVec3(v)); }
    },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uDotDensity:  { value: dotDensity },
        uDotSize:     { value: dotSize },
        uWarpAmount:  { value: warpAmount },
        uPerspective: { value: perspective },
        uSaturation:  { value: saturation },
        uColorPhase:  { value: colorPhase },
        uBrightness:  { value: brightness },
        uRotAngle:    { value: rotAngle },
        uOpacity:     { value: opacity },
        uDotColor:    { value: new THREE.Color(...hexToVec3(dotColor)) },
        uBgColorA:    { value: new THREE.Color(...hexToVec3(bgColorA)) },
        uBgColorB:    { value: new THREE.Color(...hexToVec3(bgColorB)) },
      },
      vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime    += dt * flowSpeed;
    colorPhase += dt * colorSpeed * 0.5;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value        = accTime;
    material.uniforms.uDotDensity.value  = dotDensity;
    material.uniforms.uDotSize.value     = dotSize;
    material.uniforms.uWarpAmount.value  = warpAmount;
    material.uniforms.uPerspective.value = perspective;
    material.uniforms.uSaturation.value  = saturation;
    material.uniforms.uColorPhase.value  = colorPhase;
    material.uniforms.uBrightness.value  = brightness;
    material.uniforms.uRotAngle.value    = rotAngle;
    material.uniforms.uOpacity.value     = opacity;
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
