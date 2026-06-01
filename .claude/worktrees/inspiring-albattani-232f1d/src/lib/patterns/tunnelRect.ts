import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed = 5.0;
let rotSpeed = 0.08;
let ringCount = 6;
let shape = 1.0;
let ringOffset = 0.0;   // extra rotation per ring (radians); 0 = all aligned
let saturation = 1.0;
let wobble = 0.0;
let hueShift = 0.0;
let colorSpeed = 0.30;

let colorPhase = 0;

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
  uniform float uSpeed;
  uniform float uRotSpeed;
  uniform float uRingCount;
  uniform float uShape;
  uniform float uRingOffset;
  uniform float uSaturation;
  uniform float uWobble;
  uniform float uHueShift;
  uniform float uColorPhase;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

    // ── Pass 1: ring index from unrotated Chebyshev distance ─────────────────
    // Using the unrotated Chebyshev metric (same shape as final, just not rotated)
    // gives a ring index that closely matches the rotated result → no circular
    // distortion at the outer rings.
    float d0 = max(abs(uv.x) * uShape / aspect, abs(uv.y));
    float approxStripe = (1.0 / max(d0, 0.001)) * uRingCount * 0.04 - uTime * uSpeed * 0.05;

    // ── Per-ring rotation ──────────────────────────────────────────────────────
    // Use approxStripe continuously (not floored) so rotation varies smoothly
    // across ring boundaries — no hard seam / jagged tears at the corners.
    float totalAngle = 0.7854 + uTime * uRotSpeed + approxStripe * uRingOffset;
    float cosA = cos(totalAngle);
    float sinA = sin(totalAngle);
    vec2 ruv = vec2(cosA * uv.x - sinA * uv.y,
                    sinA * uv.x + cosA * uv.y);

    // ── Pass 2: Chebyshev distance with per-ring-rotated UV ───────────────────
    float d     = max(abs(ruv.x) * uShape / aspect, abs(ruv.y));
    float depth = 1.0 / max(d, 0.001);

    // Wobble: radial breathing between rings, same technique as circular tunnel.
    float wobbleOff = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    float stripeRaw = (depth + wobbleOff) * uRingCount * 0.04 - uTime * uSpeed * 0.05;
    float stripe    = fract(stripeRaw);

    // ── Per-ring colour ───────────────────────────────────────────────────────
    // Animated stripe index travels with the rings as speed scrolls them.
    float animIndex = floor(stripeRaw);
    float hue = mod(0.04 + uHueShift + animIndex * 0.11 + sin(uColorPhase * 0.7) * 0.04, 1.0);
    float lit = 0.58 + 0.08 * sin(animIndex * 1.9 + uColorPhase * 0.5);
    vec3 col  = hsl2rgb(hue, 0.88, lit);

    // ── Shadow strip at inner ring edge ──────────────────────────────────────
    // The front "wall" of each staircase step faces the viewer and is in shadow.
    float stepShadow = smoothstep(0.0, 0.18, stripe);
    col *= mix(0.20, 1.0, stepShadow);

    // ── 3-D face shading ──────────────────────────────────────────────────────
    // L∞-normalised face direction: divide (faceX, faceY) by their Chebyshev
    // length. This gives the true face normal of each rectangle side and varies
    // *continuously* around corners — no 4-quadrant brightness jump.
    float faceX   = ruv.x * uShape / aspect;
    float faceY   = ruv.y;
    vec2 faceNorm = vec2(faceX, faceY) / max(max(abs(faceX), abs(faceY)), 0.001);
    // Light from the right and slightly downward (matches the reference look).
    vec2 lightDir = normalize(vec2(0.85, -0.45));
    float shade   = 0.68 + 0.48 * dot(faceNorm, lightDir);
    col = clamp(col * shade, 0.0, 1.0);

    // ── Saturation ────────────────────────────────────────────────────────────
    // 0 = greyscale (dark gaps stay dark, bright rings stay bright → true B&W).
    // 1 = full colour.
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, uSaturation);

    // ── Density fade near centre ──────────────────────────────────────────────
    float rawFw    = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fade     = 1.0 - smoothstep(0.8, 1.8, rawFw);
    // Dark centre colour adapts: coloured at sat=1, pure black at sat=0.
    vec3 darkColor = mix(vec3(0.0), hsl2rgb(0.87, 0.60, 0.04), uSaturation);
    col = mix(darkColor, col, fade);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const tunnelRect: Pattern = {
  id: "tunnelRect",
  name: "Tunnel — Rect",
  controls: [
    { label: "Speed",       type: "range", min: -100, max: 100, step: 1, default: 5,    get: () => speed,       set: (v) => { speed = v; } },
    { label: "Rotation",    type: "range", min: -1.0, max: 1.0, step: 0.01, default: 0.08, get: () => rotSpeed,    set: (v) => { rotSpeed = v; } },
    { label: "Ring Count",  type: "range", min: 1,    max: 20,  step: 1, default: 6,    get: () => ringCount,   set: (v) => { ringCount = v; } },
    { label: "Shape",       type: "range", min: 0.3,  max: 3.0, step: 0.1, default: 1,  get: () => shape,       set: (v) => { shape = v; } },
    { label: "Ring Offset", type: "range", min: -0.5, max: 0.5, step: 0.01, default: 0, get: () => ringOffset,  set: (v) => { ringOffset = v; } },
    { label: "Wobble",      type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 0, get: () => wobble,      set: (v) => { wobble = v; } },
    { label: "Saturation",  type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 1, get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "Hue Shift",   type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 0, get: () => hueShift,    set: (v) => { hueShift = v; } },
    { label: "Color Speed", type: "range", min: 0.0,  max: 1.0, step: 0.05, default: 0.3, get: () => colorSpeed,  set: (v) => { colorSpeed = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.size.width, ctx.size.height) },
        uSpeed:      { value: speed },
        uRotSpeed:   { value: rotSpeed },
        uRingCount:  { value: ringCount },
        uShape:      { value: shape },
        uRingOffset: { value: ringOffset },
        uSaturation: { value: saturation },
        uWobble:     { value: wobble },
        uHueShift:   { value: hueShift },
        uColorPhase: { value: colorPhase },
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
    colorPhase += dt * colorSpeed * 0.3;
    material.uniforms.uTime.value        = elapsed;
    material.uniforms.uSpeed.value       = speed;
    material.uniforms.uRotSpeed.value    = rotSpeed;
    material.uniforms.uRingCount.value   = ringCount;
    material.uniforms.uShape.value       = shape;
    material.uniforms.uRingOffset.value  = ringOffset;
    material.uniforms.uSaturation.value  = saturation;
    material.uniforms.uWobble.value      = wobble;
    material.uniforms.uHueShift.value    = hueShift;
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
  },
};
