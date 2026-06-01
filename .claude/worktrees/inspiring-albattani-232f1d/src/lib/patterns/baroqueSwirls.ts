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

let colorPhase = 0;
let rotAngle   = 0;

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
  uniform float uFlowSpeed;
  uniform float uWarpAmount;
  uniform float uTealAmt;
  uniform float uPurpleAmt;
  uniform float uSaturation;
  uniform float uColorPhase;
  uniform float uBrightness;
  uniform float uRotAngle;

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
    float t = uTime * uFlowSpeed;

    // Heavy three-level domain warping for baroque complexity
    vec2 q = vec2(fbm(p * 1.3 + t),
                  fbm(p * 1.3 + vec2(5.2, 1.3) - t * 0.85));
    vec2 r = vec2(fbm(p * 0.9 + uWarpAmount * q + vec2(1.7, 9.2) + t * 0.6),
                  fbm(p * 0.9 + uWarpAmount * q + vec2(8.3, 2.8) - t * 0.4));
    float phi = fbm(p * 0.65 + uWarpAmount * 1.2 * r + uColorPhase * 0.15);

    // Color bands: alternating teal / dark / purple / dark
    float band = fract(phi * uBandCount);

    // Smooth band masks
    float tealMask   = smoothstep(0.04, 0.16, band) * smoothstep(0.46, 0.34, band);
    float purpleMask = smoothstep(0.54, 0.66, band) * smoothstep(0.96, 0.84, band);
    // Thin bright edge where bands meet
    float edge = smoothstep(0.44, 0.48, band) * smoothstep(0.52, 0.48, band)
               + smoothstep(0.94, 0.97, band) * smoothstep(1.0,  0.97, band)
               + smoothstep(0.0,  0.03, band) * smoothstep(0.06, 0.03, band);

    vec3 teal   = vec3(0.0, 0.82, 0.72) * uTealAmt;
    vec3 purple = vec3(0.46, 0.05, 0.8) * uPurpleAmt;
    vec3 dark   = vec3(0.0, 0.0, 0.03);

    // Add slight color variation along the band for the painterly feel
    float variation = fbm(p * 3.0 + q) * 0.25;
    teal   = mix(teal,   teal   + vec3(0.0, 0.1, -0.1) * variation, 0.5);
    purple = mix(purple, purple + vec3(0.1, 0.0,  0.1) * variation, 0.5);

    vec3 col = dark + teal * tealMask + purple * purpleMask;
    col += vec3(0.85, 0.95, 0.9) * edge * 0.18;

    // Saturation
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);

    col *= uBrightness;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const baroqueSwirls: Pattern = {
  id: "baroqueSwirls",
  name: "Baroque Swirls",
  controls: [
    { label: "Band Count",   type: "range", min: 2,   max: 20,  step: 1, default: 13,    get: () => bandCount,   set: (v) => { bandCount = v; } },
    { label: "Flow Speed",   type: "range", min: 0.0, max: 0.3, step: 0.005, default: 0, get: () => flowSpeed,   set: (v) => { flowSpeed = v; } },
    { label: "Warp Amount",  type: "range", min: 0.0, max: 3.0, step: 0.05, default: 1.4, get: () => warpAmount,  set: (v) => { warpAmount = v; } },
    { label: "Teal",         type: "range", min: 0.0, max: 1.5, step: 0.05, default: 0.75, get: () => tealAmt,     set: (v) => { tealAmt = v; } },
    { label: "Purple",       type: "range", min: 0.0, max: 1.5, step: 0.05, default: 0.8, get: () => purpleAmt,   set: (v) => { purpleAmt = v; } },
    { label: "Color Speed",  type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.08, get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
    { label: "Saturation",   type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.5, get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Brightness",   type: "range", min: 0.2, max: 2.0, step: 0.05, default: 1.3, get: () => brightness,  set: (v) => { brightness = v; } },
    { label: "Rotate",       type: "range", min: 0.0, max: 0.5, step: 0.01, default: 0, get: () => rotateSpeed, set: (v) => { rotateSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uBandCount:  { value: bandCount },
        uFlowSpeed:  { value: flowSpeed },
        uWarpAmount: { value: warpAmount },
        uTealAmt:    { value: tealAmt },
        uPurpleAmt:  { value: purpleAmt },
        uSaturation: { value: saturation },
        uColorPhase: { value: colorPhase },
        uBrightness: { value: brightness },
        uRotAngle:   { value: rotAngle },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, elapsed: number) {
    if (!material) return;
    colorPhase += dt * colorSpeed * 0.4;
    rotAngle   += dt * rotateSpeed * 1.5;
    material.uniforms.uTime.value       = elapsed;
    material.uniforms.uBandCount.value  = bandCount;
    material.uniforms.uFlowSpeed.value  = flowSpeed;
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
  },
};
