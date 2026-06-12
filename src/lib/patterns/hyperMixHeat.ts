import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";
import { cameraState } from "../globalCameraSettings.svelte";

const W = 160;
const H = 90;

const BASE_COUNT = 25000;
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _cWhite = new THREE.Color(1, 1, 1);
const _cFade  = new THREE.Color();

const params = {
  speed:      0.03,
  curlScale:  0.11,
  spread:     2.1,
  pointSize:  0.8,
  blur:       0.50,
  pointCount: 25000,
  heatStrength: 0.3,
  heatGain:     5.0,
};

let blurRadius = 15;
let mirrorX    = false;

function boxBlur(src: Float32Array, tmp: Float32Array, dst: Float32Array, r: number) {
  if (r < 1) { dst.set(src); return; }
  for (let y = 0; y < H; y++) {
    const yo = y * W;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, W - 1); k++) { sum += src[yo + k]; cnt++; }
    tmp[yo] = sum / cnt;
    for (let x = 1; x < W; x++) {
      if (x + r < W)      { sum += src[yo + x + r];     cnt++; }
      if (x - r - 1 >= 0) { sum -= src[yo + x - r - 1]; cnt--; }
      tmp[yo + x] = sum / cnt;
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, H - 1); k++) { sum += tmp[k * W + x]; cnt++; }
    dst[x] = sum / cnt;
    for (let y = 1; y < H; y++) {
      if (y + r < H)      { sum += tmp[(y + r) * W + x];     cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * W + x]; cnt--; }
      dst[y * W + x] = sum / cnt;
    }
  }
}

function updateHeatTexture() {
  if (!smoothedRaw || !tmpBuf || !heatTexData || !heatTexture) return;
  const raw = cameraState.heatMap;
  for (let i = 0; i < W * H; i++) {
    smoothedRaw[i] = smoothedRaw[i] * 0.82 + Math.max(0, raw[i] - 0.008) * 0.18;
  }
  boxBlur(smoothedRaw, tmpBuf, heatTexData, blurRadius);
  heatTexture.needsUpdate = true;
}

let qualityLow = false;

// ─── Shaders ──────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `

uniform float uTime;
uniform float uCurlScale;
uniform float uSpread;
uniform float uPtSize;
uniform sampler2D uHeatMap;
uniform float     uHeatStrength;
uniform float     uHeatGain;
uniform float     uMirrorX;

attribute float aSeed;
attribute float aSide;

varying float vColorRatio;
varying float vAlpha;

vec3 _mod289(vec3 x){ return x - floor(x*(1./289.))*289.; }
vec4 _mod289(vec4 x){ return x - floor(x*(1./289.))*289.; }
vec4 _perm(vec4 x){ return _mod289(((x*34.)+1.)*x); }

float snoise(vec3 v){
  const vec2 C = vec2(1./6., 1./3.);
  const vec4 D = vec4(0., 0.5, 1., 2.);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _mod289(i);
  vec4 p = _perm(_perm(_perm(
      i.z + vec4(0.,i1.z,i2.z,1.))
    + i.y + vec4(0.,i1.y,i2.y,1.))
    + i.x + vec4(0.,i1.x,i2.x,1.));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j  = p - 49.*floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.*x_);
  vec4 x  = x_*ns.x + ns.yyyy;
  vec4 y  = y_*ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.+1.;
  vec4 s1 = floor(b1)*2.+1.;
  vec4 sh = -step(h, vec4(0.));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.);
  m = m*m;
  return 42. * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

vec3 curlNoise(vec3 p) {
  const float e = 0.07;
  const vec3 OFF1 = vec3(31.416, 127.1,  311.7);
  const vec3 OFF2 = vec3(269.5,  183.3,  246.1);
  float az_py = snoise(p + vec3(0.,e,0.) + OFF2);
  float az_my = snoise(p - vec3(0.,e,0.) + OFF2);
  float ay_pz = snoise(p + vec3(0.,0.,e) + OFF1);
  float ay_mz = snoise(p - vec3(0.,0.,e) + OFF1);
  float ax_pz = snoise(p + vec3(0.,0.,e));
  float ax_mz = snoise(p - vec3(0.,0.,e));
  float az_px = snoise(p + vec3(e,0.,0.) + OFF2);
  float az_mx = snoise(p - vec3(e,0.,0.) + OFF2);
  float ay_px = snoise(p + vec3(e,0.,0.) + OFF1);
  float ay_mx = snoise(p - vec3(e,0.,0.) + OFF1);
  float ax_py = snoise(p + vec3(0.,e,0.));
  float ax_my = snoise(p - vec3(0.,e,0.));
  return vec3(
    (az_py - az_my - ay_pz + ay_mz),
    (ax_pz - ax_mz - az_px + az_mx),
    (ay_px - ay_mx - ax_py + ax_my)
  ) / (2.*e);
}

void main() {
  float period   = 4.0 + aSeed * 8.0;
  float tLife    = fract((uTime + aSeed * 37.93) / period);

  float theta    = aSeed * 6.2831853;
  float phi      = acos(2. * fract(aSeed * 127.1 + 0.5) - 1.);
  vec3 onSphere  = vec3(sin(phi)*cos(theta), sin(phi)*sin(theta), cos(phi));
  vec3 spawnPos  = onSphere * uSpread;
  spawnPos.x    += aSide * uSpread * 1.8;

  vec3 pos = spawnPos;
  float noiseTime = uTime * 0.4 + aSeed * 13.7;
  float intDt = tLife / 6.0;
  for (int i = 0; i < 6; i++) {
    float tt = noiseTime + float(i) * intDt * 0.8;
    pos += curlNoise(pos * uCurlScale + tt) * intDt * 3.0;
  }

  pos.x -= aSide * smoothstep(0., 0.4, tLife) * uSpread * 0.5;

  vColorRatio = aSide * 0.5 + 0.5;

  float sizeRef = 2.0;
  float sizeScale = min(1.0, sizeRef / uPtSize);
  vAlpha = smoothstep(0.0, 0.08, tLife) * smoothstep(1.0, 0.75, tLife) * sizeScale;

  // Attract particles toward hot zones in the heat map.
  vec4 mv0   = modelViewMatrix * vec4(pos, 1.0);
  vec4 clip0 = projectionMatrix * mv0;
  if (clip0.w > 0.0) {
    vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
    uv.y    = 1.0 - uv.y;
    if (uMirrorX > 0.5) uv.x = 1.0 - uv.x;
    vec2 eps = vec2(1.5 / 160.0, 1.5 / 90.0);
    float hL = texture2D(uHeatMap, uv - vec2(eps.x, 0.0)).r;
    float hR = texture2D(uHeatMap, uv + vec2(eps.x, 0.0)).r;
    float hD = texture2D(uHeatMap, uv - vec2(0.0, eps.y)).r;
    float hU = texture2D(uHeatMap, uv + vec2(0.0, eps.y)).r;
    vec2 grad = vec2(hR - hL, hU - hD) * uHeatGain;
    float depth = max(-mv0.z, 0.1);
    float halfH = depth * tan(radians(30.0));
    pos.x += grad.x * halfH * uHeatStrength;
    pos.y += grad.y * halfH * uHeatStrength;
  }

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPtSize * (80.0 / -mv.z);
}
`;

const fragmentShader = /* glsl */ `

uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uBlur;
uniform float uCountScale;
uniform float uPtSize;

varying float vColorRatio;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  float maxSharp  = clamp(uPtSize * 2.5, 6.0, 20.0);
  float sharpness = mix(1.5, maxSharp, uBlur);
  float softness  = pow(max(0.0, 1.0 - d * 2.0), sharpness);

  float alpha = softness * vAlpha * uCountScale * 0.85;

  vec3 col = mix(uColor1, uColor2, vColorRatio);

  gl_FragColor = vec4(col, alpha);
}
`;

// ─── Pattern state ─────────────────────────────────────────────────────────────

let accTime  = 0;
let points:   THREE.Points | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let cam:      THREE.PerspectiveCamera | null = null;
let sceneRef: THREE.Scene | null = null;
let heatTexture: THREE.DataTexture | null = null;
let heatTexData: Float32Array | null = null;
let smoothedRaw: Float32Array | null = null;
let tmpBuf:      Float32Array | null = null;

function effectiveCount() {
  return qualityLow ? Math.max(5000, Math.round(params.pointCount / 2)) : params.pointCount;
}

function rebuildPoints(count: number) {
  if (!sceneRef || !points || !material) return;
  sceneRef.remove(points);
  geometry?.dispose();
  geometry = buildGeometry(count);
  points = new THREE.Points(geometry, material);
  sceneRef.add(points);
}

function buildGeometry(count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const seeds     = new Float32Array(count);
  const sides     = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = Math.cbrt(Math.random()) * params.spread;
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    seeds[i] = Math.random();
    sides[i] = i % 2 === 0 ? -1 : 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aSeed",    new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute("aSide",    new THREE.BufferAttribute(sides, 1));
  return geo;
}

export const hyperMixHeat: Pattern = {
  id: "hyperMixHeat",
  name: "Hyper Mix - Heat",
  motionControlLabels: ['Speed'],
  audioControlLabels:  ['Speed', 'Point Size'],

  controls: [
    {
      label: "Speed",
      type: "range", min: 0, max: 0.2, step: 0.005,
      default: 0.03,
      audioWeight: 0.35,
      get: () => params.speed,
      set: (v) => { params.speed = v; },
    },
    {
      label: "Turbulence",
      type: "range", min: 0.01, max: 0.25, step: 0.01,
      default: 0.11,
      audioWeight: 0.25,
      get: () => params.curlScale,
      set: (v) => { params.curlScale = v; if (material) material.uniforms.uCurlScale.value = v; },
    },
    {
      label: "Spread",
      type: "range", min: 0.1, max: 6.0, step: 0.1,
      default: 2.1,
      get: () => params.spread,
      set: (v) => { params.spread = v; if (material) material.uniforms.uSpread.value = v; },
    },
    {
      label: "Point Size",
      type: "range", min: 0.2, max: 3.0, step: 0.1,
      default: 0.8,
      audioWeight: 0.3,
      get: () => params.pointSize,
      set: (v) => { params.pointSize = v; if (material) material.uniforms.uPtSize.value = v; },
    },
    {
      label: "Point Count",
      type: "range", min: 5000, max: 30000, step: 1000,
      default: 25000,
      get: () => params.pointCount,
      set: (v) => { params.pointCount = v; rebuildPoints(effectiveCount()); },
    },
    {
      label: "High Quality",
      type: "toggle" as const,
      title: "Off = half point count for slower machines",
      get: () => !qualityLow,
      set: (v: boolean) => { qualityLow = !v; rebuildPoints(effectiveCount()); },
    },
    {
      label: "Heat Strength",
      type: "range", min: 0, max: 2.0, step: 0.05,
      default: 0.3,
      get: () => params.heatStrength,
      set: (v) => { params.heatStrength = v; },
    },
    {
      label: "Heat Gain",
      type: "range", min: 1.0, max: 30.0, step: 0.5,
      default: 5.0,
      get: () => params.heatGain,
      set: (v) => { params.heatGain = v; },
    },
    {
      label: "Blur Radius",
      type: "range", min: 0, max: 30, step: 1,
      default: 15,
      get: () => blurRadius,
      set: (v) => { blurRadius = v; },
    },
    { label: "Mirror X", type: "toggle" as const, get: () => mirrorX, set: (v) => { mirrorX = v; } },
  ],

  init(ctx: PatternContext) {
    cam = ctx.camera;
    sceneRef = ctx.scene;
    cam.position.set(0, 0, 8);
    cam.lookAt(0, 0, 0);

    heatTexData = new Float32Array(W * H);
    smoothedRaw = new Float32Array(W * H);
    tmpBuf      = new Float32Array(W * H);
    heatTexture = new THREE.DataTexture(heatTexData, W, H, THREE.RedFormat, THREE.FloatType);
    heatTexture.minFilter = THREE.LinearFilter;
    heatTexture.magFilter = THREE.LinearFilter;
    heatTexture.needsUpdate = true;

    geometry = buildGeometry(params.pointCount);

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uCurlScale:    { value: params.curlScale },
        uSpread:       { value: params.spread },
        uPtSize:       { value: params.pointSize },
        uBlur:         { value: 1.0 - params.blur },
        uCountScale:   { value: 1.0 },
        uColor1:       { value: new THREE.Color(0x00ccff) },
        uColor2:       { value: new THREE.Color(0xff00cc) },
        uHeatMap:      { value: heatTexture },
        uHeatStrength: { value: params.heatStrength },
        uHeatGain:     { value: params.heatGain },
        uMirrorX:      { value: mirrorX ? 1.0 : 0.0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    points = new THREE.Points(geometry, material);
    ctx.scene.add(points);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime += dt * params.speed;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uCountScale.value = Math.min(1.0, BASE_COUNT / params.pointCount);
    material.uniforms.uHeatStrength.value = params.heatStrength;
    material.uniforms.uHeatGain.value     = params.heatGain;
    material.uniforms.uMirrorX.value      = mirrorX ? 1.0 : 0.0;

    updateHeatTexture();

    _c1.set(colorC2.main);
    _c2.set(colorC2.contrast);
    const _ph1 = Math.min(1.0, colorC2.colorsV2);
    const _ph2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
    _cFade.lerpColors(_cWhite, _c1, _ph1);
    material.uniforms.uColor1.value.copy(_cFade);
    material.uniforms.uColor2.value.lerpColors(_cFade, _c2, _ph2);
  },

  resize() {},

  dispose() {
    heatTexture?.dispose();
    geometry?.dispose();
    material?.dispose();
    points      = null;
    geometry    = null;
    material    = null;
    heatTexture = null;
    heatTexData = null;
    smoothedRaw = null;
    tmpBuf      = null;
    cam         = null;
    sceneRef    = null;
    accTime     = 0;
    qualityLow  = false;
  },
};
