import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let speed       = 4.0;
let rotSpeed    = 0.06;
let ringCount   = 8;
let edges       = 4;
let ringOffset  = 0.0;
let wobble      = 0.0;
let shadowWidth = 0.35;
let brightness  = 1.0;
let saturation  = 1.0;
let colorSet    = 0;

// Per-color-stop brightness multipliers
let colCenter = 1.0;
let colMid    = 1.0;
let colOuter  = 1.0;

let accTime = 0;

// center, mid, outer — each as [r,g,b]
const COLOR_SETS = [
  { center: [0.0, 0.0, 0.0],   mid: [1.0, 0.0,   1.0  ], outer: [0.0, 1.0,  1.0  ] }, // cyan/magenta
  { center: [0.0, 0.0, 0.0],   mid: [0.6, 0.0,   1.0  ], outer: [1.0, 0.843, 0.0 ] }, // purple/gold
  { center: [0.0, 0.0, 0.0],   mid: [0.0, 1.0,   1.0  ], outer: [1.0, 1.0,  1.0  ] }, // white/cyan
];

function setColors(mat: THREE.ShaderMaterial) {
  const cs = COLOR_SETS[colorSet] ?? COLOR_SETS[0];
  mat.uniforms.uColorCenter.value.set(...cs.center as [number, number, number]);
  mat.uniforms.uColorMid.value.set(...cs.mid as [number, number, number]);
  mat.uniforms.uColorOuter.value.set(...cs.outer as [number, number, number]);
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
  uniform float uRotSpeed;
  uniform float uRingCount;
  uniform float uEdges;
  uniform float uRingOffset;
  uniform float uWobble;
  uniform float uShadowWidth;
  uniform float uBrightness;
  uniform float uSaturation;
  uniform vec3  uColorCenter;
  uniform vec3  uColorMid;
  uniform vec3  uColorOuter;
  uniform float uColCenter;
  uniform float uColMid;
  uniform float uColOuter;

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
    vec2 uv = (vUv - 0.5) * vec2(aspect, 1.0);

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

    vec2  lightDir = normalize(vec2(0.85, -0.45));
    float shade    = 0.65 + 0.50 * dot(faceNormal, lightDir);

    // 3-point palette gradient: center → mid → outer
    float colorT = clamp(d0 * 2.2, 0.0, 1.0);
    vec3 col;
    if (colorT < 0.5) {
      col = mix(uColorCenter * uColCenter, uColorMid * uColMid, colorT * 2.0);
    } else {
      col = mix(uColorMid * uColMid, uColorOuter * uColOuter, (colorT - 0.5) * 2.0);
    }

    float shadow = smoothstep(0.0, uShadowWidth, stripe);
    col *= mix(0.08, 1.0, shadow);

    col *= shade;
    col *= (0.78 + 0.28 * stripe);
    col  = clamp(col, 0.0, 1.0);

    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, uSaturation);
    col = clamp(col * uBrightness, 0.0, 1.0);

    float rawFw = length(vec2(dFdx(stripeRaw), dFdy(stripeRaw)));
    float fade  = 1.0 - smoothstep(0.8, 1.8, rawFw);
    col = mix(mix(vec3(0.0), uColorCenter, uSaturation), col, fade);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const tunnelEdgePalette: Pattern = {
  id: "tunnelEdgePalette",
  name: "Tunnel — Edge Palette",
  motionControlLabels: ["Speed", "Wobble", "Saturation"],
  controls: [
    { label: "Color Set",    type: "select", options: ["Cyan / Magenta", "Purple / Gold", "White / Cyan"],
      get: () => colorSet, set: (v) => { colorSet = v; if (material) setColors(material); } },
    { label: "Speed",        type: "range", min: -20,   max: 20,   step: 0.5,  default: 4,    get: () => speed,       set: (v) => { speed = v; } },
    { label: "Rotation",     type: "range", min: -0.3,  max: 0.3,  step: 0.01, default: 0.06, get: () => rotSpeed,    set: (v) => { rotSpeed = v; } },
    { label: "Ring Count",   type: "range", min: 2,     max: 20,   step: 1,    default: 8,    get: () => ringCount,   set: (v) => { ringCount = v; } },
    { label: "Edges",        type: "range", min: 3,     max: 12,   step: 1,    default: 4,    get: () => edges,       set: (v) => { edges = v; } },
    { label: "Ring Offset",  type: "range", min: -3.14, max: 3.14, step: 0.05, default: 0,    get: () => ringOffset,  set: (v) => { ringOffset = v; } },
    { label: "Wobble",       type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 0,    get: () => wobble,      set: (v) => { wobble = v; } },
    { label: "Shadow Width", type: "range", min: 0.05,  max: 0.8,  step: 0.01, default: 0.35, get: () => shadowWidth, set: (v) => { shadowWidth = v; } },
    { label: "Brightness",   type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 1,    get: () => brightness,  set: (v) => { brightness = v; } },
    { label: "Saturation",   type: "range", min: 0.0,   max: 1.0,  step: 0.05, default: 1,    get: () => saturation,  set: (v) => { saturation = v; } },
    { label: "separator", type: "separator" },
    { label: "Center",    type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => colCenter, set: (v) => { colCenter = v; } },
    { label: "Mid",       type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => colMid,    set: (v) => { colMid = v; } },
    { label: "Outer",     type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => colOuter,  set: (v) => { colOuter = v; } },
  ],

  init(ctx: PatternContext) {
    const cs = COLOR_SETS[colorSet] ?? COLOR_SETS[0];
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
        uBrightness:  { value: brightness },
        uSaturation:  { value: saturation },
        uColorCenter: { value: new THREE.Vector3(...cs.center as [number, number, number]) },
        uColorMid:    { value: new THREE.Vector3(...cs.mid as [number, number, number]) },
        uColorOuter:  { value: new THREE.Vector3(...cs.outer as [number, number, number]) },
        uColCenter:   { value: colCenter },
        uColMid:      { value: colMid },
        uColOuter:    { value: colOuter },
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

  update(dt: number) {
    if (!material) return;
    accTime += dt * speed;
    material.uniforms.uTime.value        = accTime;
    material.uniforms.uRotSpeed.value    = rotSpeed;
    material.uniforms.uRingCount.value   = ringCount;
    material.uniforms.uEdges.value       = edges;
    material.uniforms.uRingOffset.value  = ringOffset;
    material.uniforms.uWobble.value      = wobble;
    material.uniforms.uShadowWidth.value = shadowWidth;
    material.uniforms.uBrightness.value  = brightness;
    material.uniforms.uSaturation.value  = saturation;
    material.uniforms.uColCenter.value   = colCenter;
    material.uniforms.uColMid.value      = colMid;
    material.uniforms.uColOuter.value    = colOuter;
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
    brightness = 1.0;
    saturation = 1.0;
    colCenter = colMid = colOuter = 1.0;
  },
};
