import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed      = 4.0;
let rotSpeed   = 0.06;
let ringCount  = 8;
let edges      = 4;
let ringOffset = 0.0;
let wobble     = 0.0;
let shadowWidth = 0.35;
let hueShift   = 0.0;
let saturation = 1.0;
let colorDrift = 0.2;

let colorPhase = 0;
let accTime    = 0;

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
  uniform float uRotSpeed;
  uniform float uRingCount;
  uniform float uEdges;
  uniform float uRingOffset;
  uniform float uWobble;
  uniform float uShadowWidth;
  uniform float uHueShift;
  uniform float uSaturation;
  uniform float uColorPhase;

  const float PI = 3.14159265358979;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  vec2 rot2d(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  }

  // Distance metric whose iso-curves are regular N-gons.
  // Equivalent to max-over-all-face-projections, computed analytically.
  float ngonDist(vec2 p, float n) {
    float a     = 2.0 * PI / n;
    float angle = atan(p.y, p.x);
    float sector = floor(angle / a + 0.5) * a;   // nearest face-normal angle
    return length(p) * cos(angle - sector);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

    // Global rotation: PI/n aligns flat faces outward (diamond for n=4) + time spin
    float globalAngle = PI / uEdges + uTime * uRotSpeed;
    vec2 ruv = rot2d(uv, globalAngle);

    // ── Base N-gon distance (determines ring shape & stripe) ──────────────────
    // Ring shape is always a clean N-gon — no seams or distortion.
    float d0    = ngonDist(ruv, uEdges);
    float depth = 1.0 / max(d0, 0.001);

    // Wobble: radial breathing between rings
    float wobbleOff = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    float stripeRaw = (depth + wobbleOff) * uRingCount * 0.04 - uTime * 0.05;
    float stripe    = fract(stripeRaw);   // 0 = inner edge, 1 = outer edge
    float ringIdx   = floor(stripeRaw);

    // ── Per-ring rotation: rotate the face-shading frame per ring ────────────
    // The ring shape itself stays an intact N-gon (from d0 above).
    // Only the face-lighting direction is rotated for each ring, which gives
    // the visual impression that successive rings are turned relative to each other.
    float ringAngle = ringIdx * uRingOffset;
    vec2 rruv = rot2d(ruv, ringAngle);

    // Face normal of the rotated N-gon at this pixel (nearest face)
    float a          = 2.0 * PI / uEdges;
    float faceAngle  = atan(rruv.y, rruv.x);
    float sector     = floor(faceAngle / a + 0.5) * a;
    vec2  faceNormal = vec2(cos(sector), sin(sector));

    // Fixed light direction (upper-right in rotated UV space)
    vec2  lightDir   = normalize(vec2(0.85, -0.45));
    float shade      = 0.65 + 0.50 * dot(faceNormal, lightDir);

    // ── Global colour gradient (outer = warm coral, mid = magenta, centre = dark) ──
    float colorT = clamp(d0 * 2.2, 0.0, 1.0);
    float hs     = uHueShift;
    float ph     = uColorPhase;

    vec3 colorCenter = hsl2rgb(mod(0.820 + hs + ph * 0.03, 1.0), 0.50, 0.12);
    vec3 colorMid    = hsl2rgb(mod(0.900 + hs + ph * 0.02, 1.0), 1.00, 0.55);
    vec3 colorOuter  = hsl2rgb(mod(0.030 + hs + ph * 0.01, 1.0), 0.90, 0.68);

    vec3 col;
    if (colorT < 0.5) {
      col = mix(colorCenter, colorMid,   colorT * 2.0);
    } else {
      col = mix(colorMid,   colorOuter, (colorT - 0.5) * 2.0);
    }

    // ── Soft shadow bevel at inner edge ───────────────────────────────────────
    float shadow = smoothstep(0.0, uShadowWidth, stripe);
    col *= mix(0.08, 1.0, shadow);

    // ── Face shading (3-D depth per ring face, rotated per ring) ─────────────
    col *= shade;

    // ── Subtle brightness lift toward outer edge ──────────────────────────────
    col *= (0.78 + 0.28 * stripe);
    col  = clamp(col, 0.0, 1.0);

    // ── Saturation ────────────────────────────────────────────────────────────
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, uSaturation);

    // ── Density fade at centre (fwidth-based) ────────────────────────────────
    float rawFw = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fade  = 1.0 - smoothstep(0.8, 1.8, rawFw);
    vec3 darkColor = mix(vec3(0.0), colorCenter, uSaturation);
    col = mix(darkColor, col, fade);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const tunnelEdge: Pattern = {
  id: "tunnelEdge",
  name: "Tunnel — Edge",
  controls: [
    { label: "Speed",        type: "range", min: -20,   max: 20,   step: 0.5,  default: 4,    get: () => speed,        set: (v) => { speed = v; } },
    { label: "Rotation",     type: "range", min: -0.3,  max: 0.3,  step: 0.01, default: 0.06, get: () => rotSpeed,     set: (v) => { rotSpeed = v; } },
    { label: "Ring Count",   type: "range", min: 2,     max: 20,   step: 1,    default: 8,    get: () => ringCount,    set: (v) => { ringCount = v; } },
    { label: "Edges",        type: "range", min: 3,     max: 12,   step: 1,    default: 4,    get: () => edges,        set: (v) => { edges = v; } },
    { label: "Ring Offset",  type: "range", min: -3.14, max: 3.14, step: 0.05, default: 0,    get: () => ringOffset,   set: (v) => { ringOffset = v; } },
    { label: "Wobble",       type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0,    get: () => wobble,       set: (v) => { wobble = v; } },
    { label: "Shadow Width", type: "range", min: 0.05,  max: 0.8,  step: 0.01, default: 0.35, get: () => shadowWidth,  set: (v) => { shadowWidth = v; } },
    { label: "Hue Shift",    type: "range", min: 0.0,   max: 1.0,  step: 0.01, default: 0,    get: () => hueShift,     set: (v) => { hueShift = v; } },
    { label: "Saturation",   type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 1,    get: () => saturation,   set: (v) => { saturation = v; } },
    { label: "Color Drift",  type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0.2,  get: () => colorDrift,   set: (v) => { colorDrift = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uResolution:  { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uRotSpeed:    { value: rotSpeed },
        uRingCount:   { value: ringCount },
        uEdges:       { value: edges },
        uRingOffset:  { value: ringOffset },
        uWobble:      { value: wobble },
        uShadowWidth: { value: shadowWidth },
        uHueShift:    { value: hueShift },
        uSaturation:  { value: saturation },
        uColorPhase:  { value: colorPhase },
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
    if (!material) return;
    accTime    += dt * speed;
    colorPhase += dt * colorDrift * 0.1;
    material.uniforms.uTime.value        = accTime;
    material.uniforms.uRotSpeed.value    = rotSpeed;
    material.uniforms.uRingCount.value   = ringCount;
    material.uniforms.uEdges.value       = edges;
    material.uniforms.uRingOffset.value  = ringOffset;
    material.uniforms.uWobble.value      = wobble;
    material.uniforms.uShadowWidth.value = shadowWidth;
    material.uniforms.uHueShift.value    = hueShift;
    material.uniforms.uSaturation.value  = saturation;
    material.uniforms.uColorPhase.value  = colorPhase;
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
    accTime = 0;
  },
};
