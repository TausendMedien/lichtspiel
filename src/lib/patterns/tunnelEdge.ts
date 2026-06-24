import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const W = 160, H = 90;

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed      = 4.0;
let rotSpeed   = 0.06;
let ringCount  = 8;
let edges      = 5;
let ringOffset = 0.0;
let wobble     = 0.0;
let shadowWidth = 0.35;
let colorDrift = 0.2;

let colorPhase = 0;
let accTime    = 0;

// Heat state — centroid shifts tunnel center toward person
let heatCenterStr = 1.0;
const heatOffset  = new THREE.Vector2();

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

const _colorA = new THREE.Color();
const _colorB = new THREE.Color();
const _cWhite = new THREE.Color(1, 1, 1);
const _cFade  = new THREE.Color();
const _cTemp  = new THREE.Color();

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
  uniform float uColorPhase;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec2  uHeatOffset;

  const float PI = 3.14159265358979;

  vec2 rot2d(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  }

  float ngonDist(vec2 p, float n) {
    float a     = 2.0 * PI / n;
    float angle = atan(p.y, p.x);
    float sector = floor(angle / a + 0.5) * a;
    return length(p) * cos(angle - sector);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 uv = (vUv - 0.5 - uHeatOffset) * vec2(aspect, 1.0);

    float globalAngle = PI / uEdges + uTime * uRotSpeed;
    vec2 ruv = rot2d(uv, globalAngle);

    float d0    = ngonDist(ruv, uEdges);
    float depth = 1.0 / max(d0, 0.001);

    float wobbleOff = uWobble * sin(depth * 6.0 - uTime * 2.5) * 0.12;

    float stripeRaw = (depth + wobbleOff) * uRingCount * 0.04 - uTime * 0.05;
    float stripe    = fract(stripeRaw);
    float ringIdx   = floor(stripeRaw);

    float ringAngle = ringIdx * uRingOffset;
    vec2 rruv = rot2d(ruv, ringAngle);

    float a          = 2.0 * PI / uEdges;
    float faceAngle  = atan(rruv.y, rruv.x);
    float sector     = floor(faceAngle / a + 0.5) * a;
    vec2  faceNormal = vec2(cos(sector), sin(sector));

    vec2  lightDir   = normalize(vec2(0.85, -0.45));
    float shade      = 0.65 + 0.50 * dot(faceNormal, lightDir);

    // ── Custom colour gradient: colorA (inner) → colorB (outer) ───────────
    float colorT = clamp(d0 * 2.2, 0.0, 1.0);
    float blend  = 0.5 + 0.5 * sin(uColorPhase * 6.28318);

    vec3 colorCenter = uColorA * 0.15;
    vec3 colorMid    = mix(uColorA, uColorB, blend);
    vec3 colorOuter  = uColorB;

    vec3 col;
    if (colorT < 0.5) {
      col = mix(colorCenter, colorMid,   colorT * 2.0);
    } else {
      col = mix(colorMid,   colorOuter, (colorT - 0.5) * 2.0);
    }

    float shadow = smoothstep(0.0, uShadowWidth, stripe);
    col *= mix(0.08, 1.0, shadow);
    col *= shade;
    col *= (0.78 + 0.28 * stripe);
    col  = clamp(col, 0.0, 1.0);

    float rawFw = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fade  = 1.0 - smoothstep(0.8, 1.8, rawFw);
    col = mix(colorCenter, col, fade);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const tunnelEdge: Pattern = {
  id: "tunnelEdge",
  name: "Tunnel — Edge",
  heatReactive: true,
  motionControlLabels: ["Speed", "Wobble"],  // speed + wobble respond to motion; Tier 1 handles Color v2
  audioControlLabels:  ["Shadow Width"],
  controls: [
    { label: "Speed",        type: "range", min: -30,   max: 30,   step: 0.5,  default: 4,    tip: "Fly-through speed. Positive = forwards, negative = backwards.",                          get: () => speed,       set: (v) => { speed = v; } },
    { label: "Rotation",     type: "range", min: -0.3,  max: 0.3,  step: 0.01, default: 0.06, tip: "How fast the tunnel spins around the fly-through axis. Sign sets direction.",           get: () => rotSpeed,    set: (v) => { rotSpeed = v; } },
    { label: "Ring Count",   type: "range", min: 2,     max: 20,   step: 1,    default: 8,    tip: "Number of polygon rings visible at once.",                                               get: () => ringCount,   set: (v) => { ringCount = v; } },
    { label: "Edges",        type: "range", min: 3,     max: 12,   step: 1,    default: 5,    tip: "Number of sides per ring (3 = triangle, 6 = hexagon, 12 ≈ circle).",                    get: () => edges,       set: (v) => { edges = v; } },
    { label: "Ring Offset",  type: "range", min: -3.14, max: 3.14, step: 0.05, default: 0,    tip: "Phase twist between adjacent rings — creates a spiral or zigzag look.",                 get: () => ringOffset,  set: (v) => { ringOffset = v; } },
    { label: "Wobble",       type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0,    tip: "Camera sway as you fly through.",                                                       get: () => wobble,      set: (v) => { wobble = v; } },
    { label: "Shadow Width", type: "range", min: 0.05,  max: 0.8,  step: 0.01, default: 0.35, tip: "Width of the shaded gap between the bright and dark faces of each edge.",               get: () => shadowWidth, set: (v) => { shadowWidth = v; } },
    { label: "Color Drift",  type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0.2,  tip: "How fast the palette shifts along the tunnel.",                                         get: () => colorDrift,  set: (v) => { colorDrift = v; } },
    { label: "Center Shift", type: "range", min: 0, max: 2, step: 0.1, default: 1.0, interactive: 'heat' as const, tip: "How much heat-map position shifts the tunnel center toward the person. Requires Heat.", get: () => heatCenterStr, set: v => { heatCenterStr = v; } },
  ],

  init(ctx: PatternContext) {
    _cFade.lerpColors(_cWhite, new THREE.Color(colorC2.main), Math.min(1.0, colorC2.colorsV2));
    _colorA.copy(_cFade);
    _colorB.lerpColors(_cFade, new THREE.Color(colorC2.contrast), Math.max(0, colorC2.colorsV2 - 1) / 2);
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
        uColorPhase:  { value: colorPhase },
        uColorA:      { value: new THREE.Vector3(_colorA.r, _colorA.g, _colorA.b) },
        uColorB:      { value: new THREE.Vector3(_colorB.r, _colorB.g, _colorB.b) },
        uHeatOffset:  { value: new THREE.Vector2(0, 0) },
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
    _cTemp.set(colorC2.main);
    const _ph1 = Math.min(1.0, colorC2.colorsV2);
    const _ph2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
    _cFade.lerpColors(_cWhite, _cTemp, _ph1);
    _colorA.copy(_cFade);
    _cTemp.set(colorC2.contrast);
    _colorB.lerpColors(_cFade, _cTemp, _ph2);
    // Color v2 is now driven universally by the motionCameraWrapper.
    material.uniforms.uTime.value        = accTime;
    material.uniforms.uRotSpeed.value    = rotSpeed;
    material.uniforms.uRingCount.value   = ringCount;
    material.uniforms.uEdges.value       = edges;
    material.uniforms.uRingOffset.value  = ringOffset;
    material.uniforms.uWobble.value      = wobble;
    material.uniforms.uShadowWidth.value = shadowWidth;
    material.uniforms.uColorPhase.value  = colorPhase;
    material.uniforms.uColorA.value.set(_colorA.r, _colorA.g, _colorA.b);
    material.uniforms.uColorB.value.set(_colorB.r, _colorB.g, _colorB.b);
    material.uniforms.uHeatOffset.value.copy(heatOffset);
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
    colorPhase = 0;
    heatOffset.set(0, 0);
  },
};
