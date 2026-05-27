import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";

// Each line rendered as a screen-space quad (2 triangles) for real pixel-width control.
// A second glow-points pass adds per-particle blur and size variation like Particle Field.

let lineCount  = 1000;
let flowSpeed  = 0.3;
let tailLength = 6.0;
let lineWidth  = 4.0;  // pixels

let lineMesh:   THREE.Mesh   | null = null;
let glowPoints: THREE.Points | null = null;
let lineGeo:  THREE.BufferGeometry | null = null;
let glowGeo:  THREE.BufferGeometry | null = null;
let lineMat:  THREE.ShaderMaterial | null = null;
let glowMat:  THREE.ShaderMaterial | null = null;
let camera:   THREE.PerspectiveCamera | null = null;
let sceneRef: THREE.Scene | null = null;
let accTime = 0;
let needsRebuild    = false;
let needsTailUpdate = false;
let vpWidth = 1, vpHeight = 1;

// ─── Persistent line store ────────────────────────────────────────────────────
// Stores stable per-line head positions and tail directions so that changing
// Line Count only adds/removes lines from the end, and changing Tail Length
// only slides the tail endpoints — neither scrambles the whole image.
interface LineEntry {
  hx: number; hy: number; hz: number;  // head position
  tdx: number; tdy: number; tdz: number; // tail direction (unscaled, multiply by tailLength)
  hs: number;  // head seed
}
let lineStore: LineEntry[] = [];
let posAttr:      THREE.BufferAttribute | null = null;
let otherPosAttr: THREE.BufferAttribute | null = null;

function ensureStore(N: number) {
  while (lineStore.length < N) {
    const r     = Math.cbrt(Math.random()) * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    lineStore.push({
      hx:  r * Math.sin(phi) * Math.cos(theta),
      hy:  r * Math.sin(phi) * Math.sin(theta),
      hz:  r * Math.cos(phi),
      tdx: Math.random() - 0.5,
      tdy: Math.random() - 0.5,
      tdz: Math.random() - 0.5,
      hs:  Math.random(),
    });
  }
}

// Update only position/otherPos when tailLength changes (seeds/sides/indices unchanged).
function updateTailPositions() {
  if (!posAttr || !otherPosAttr) return;
  const N = Math.round(lineCount);
  const positions = posAttr.array as Float32Array;
  const otherPos  = otherPosAttr.array as Float32Array;
  for (let i = 0; i < N; i++) {
    const { hx, hy, hz, tdx, tdy, tdz } = lineStore[i];
    const tx = hx + tdx * tailLength;
    const ty = hy + tdy * tailLength;
    const tz = hz + tdz * tailLength;
    const b = i * 4;
    // HL, HR: position = head (stable), otherPos = tail (changes)
    otherPos[b*3]=tx;     otherPos[b*3+1]=ty;     otherPos[b*3+2]=tz;
    otherPos[(b+1)*3]=tx; otherPos[(b+1)*3+1]=ty; otherPos[(b+1)*3+2]=tz;
    // TL, TR: position = tail (changes), otherPos = head (stable)
    positions[(b+2)*3]=tx; positions[(b+2)*3+1]=ty; positions[(b+2)*3+2]=tz;
    positions[(b+3)*3]=tx; positions[(b+3)*3+1]=ty; positions[(b+3)*3+2]=tz;
  }
  posAttr.needsUpdate      = true;
  otherPosAttr.needsUpdate = true;
}

// ─── Shared flow field ────────────────────────────────────────────────────────
const FLOW_GLSL = /* glsl */ `
  vec3 _flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }
  vec3 _animPt(vec3 pos, float seed, float t) {
    vec3 p = pos + _flow(pos * 0.5 + seed, t) * 0.6;
    float ang = t * 0.05 + seed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;
    return p;
  }
`;

// ─── Fat line shaders ─────────────────────────────────────────────────────────
const lineVertShader = /* glsl */ `
  uniform float uTime;
  uniform float uLineWidth;
  uniform vec2  uResolution;
  attribute vec3  aOtherPos;
  attribute float aSeed;
  attribute float aOtherSeed;
  attribute float aSide;
  varying float vSeed;

  ${FLOW_GLSL}

  void main() {
    vSeed = aSeed;

    vec3 thisWorld  = _animPt(position,  aSeed,       uTime);
    vec3 otherWorld = _animPt(aOtherPos, aOtherSeed,  uTime);

    vec4 clipThis  = projectionMatrix * modelViewMatrix * vec4(thisWorld,  1.0);
    vec4 clipOther = projectionMatrix * modelViewMatrix * vec4(otherWorld, 1.0);

    vec2 ndcDir = (clipOther.xy / clipOther.w) - (clipThis.xy / clipThis.w);
    vec2 pxDir  = vec2(ndcDir.x * uResolution.x, ndcDir.y * uResolution.y);
    if (length(pxDir) < 0.0001) pxDir = vec2(0.0, 1.0);
    pxDir = normalize(pxDir);

    vec2 pxPerp  = vec2(-pxDir.y, pxDir.x);
    vec2 ndcPerp = vec2(pxPerp.x / uResolution.x, pxPerp.y / uResolution.y);
    vec2 offset  = ndcPerp * uLineWidth * aSide * clipThis.w;

    gl_Position    = clipThis;
    gl_Position.xy += offset;
  }
`;

const lineFragShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uLineOpacity;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    float _sat    = clamp(uColorRange, 0.0, 1.0);
    float _spread = max(0.0, uColorRange - 1.0) / 2.0;
    float hue = 0.5 + fract(vSeed * _spread) * 0.33;
    vec3  col = hsl2rgb(hue, _sat, 0.6);
    gl_FragColor = vec4(col, uLineOpacity);
  }
`;

// ─── Glow-point shaders ───────────────────────────────────────────────────────
const glowVertShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vSeed;

  ${FLOW_GLSL}

  void main() {
    vSeed = aSeed;
    vec3 p  = _animPt(position, aSeed, uTime);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float sizeVar = 0.5 + fract(aSeed * 7.317) * 1.5;
    gl_PointSize  = uSize * sizeVar * (6.0 / -mv.z);
  }
`;

const glowFragShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uLineOpacity;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d) * 0.45 * uLineOpacity;

    float _sat    = clamp(uColorRange, 0.0, 1.0);
    float _spread = max(0.0, uColorRange - 1.0) / 2.0;
    float hue = 0.5 + fract(vSeed * _spread) * 0.33;
    vec3  col = hsl2rgb(hue, _sat, 0.7);
    gl_FragColor = vec4(col, alpha);
  }
`;

// ─── Geometry builder ─────────────────────────────────────────────────────────
function buildGeometry() {
  if (lineMesh   && sceneRef) sceneRef.remove(lineMesh);
  if (glowPoints && sceneRef) sceneRef.remove(glowPoints);
  lineGeo?.dispose();
  glowGeo?.dispose();

  const N = Math.round(lineCount);
  ensureStore(N);

  // 4 vertices per line (HL, HR, TL, TR), 6 indices per line
  const positions  = new Float32Array(N * 4 * 3);
  const otherPos   = new Float32Array(N * 4 * 3);
  const seeds      = new Float32Array(N * 4);
  const otherSeeds = new Float32Array(N * 4);
  const sides      = new Float32Array(N * 4);
  const indices    = new Uint32Array(N * 6);

  // Glow: one point per line-head
  const glowPositions = new Float32Array(N * 3);
  const glowSeeds     = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const { hx, hy, hz, tdx, tdy, tdz, hs } = lineStore[i];
    const tx = hx + tdx * tailLength;
    const ty = hy + tdy * tailLength;
    const tz = hz + tdz * tailLength;
    const headSeed = hs;
    const tailSeed = hs + 0.0001;

    // Layout: base=i*4  → HL(+0), HR(+1), TL(+2), TR(+3)
    const b = i * 4;
    // HL
    positions[b*3]=hx; positions[b*3+1]=hy; positions[b*3+2]=hz;
    otherPos[b*3]=tx;  otherPos[b*3+1]=ty;  otherPos[b*3+2]=tz;
    seeds[b]=headSeed; otherSeeds[b]=tailSeed; sides[b]=-1.0;
    // HR
    positions[(b+1)*3]=hx; positions[(b+1)*3+1]=hy; positions[(b+1)*3+2]=hz;
    otherPos[(b+1)*3]=tx;  otherPos[(b+1)*3+1]=ty;  otherPos[(b+1)*3+2]=tz;
    seeds[b+1]=headSeed; otherSeeds[b+1]=tailSeed; sides[b+1]=+1.0;
    // TL
    positions[(b+2)*3]=tx; positions[(b+2)*3+1]=ty; positions[(b+2)*3+2]=tz;
    otherPos[(b+2)*3]=hx;  otherPos[(b+2)*3+1]=hy;  otherPos[(b+2)*3+2]=hz;
    seeds[b+2]=tailSeed; otherSeeds[b+2]=headSeed; sides[b+2]=-1.0;
    // TR
    positions[(b+3)*3]=tx; positions[(b+3)*3+1]=ty; positions[(b+3)*3+2]=tz;
    otherPos[(b+3)*3]=hx;  otherPos[(b+3)*3+1]=hy;  otherPos[(b+3)*3+2]=hz;
    seeds[b+3]=tailSeed; otherSeeds[b+3]=headSeed; sides[b+3]=+1.0;

    // Indices: HL,HR,TL, HR,TR,TL
    const ii = i * 6;
    indices[ii]=b; indices[ii+1]=b+1; indices[ii+2]=b+2;
    indices[ii+3]=b+1; indices[ii+4]=b+3; indices[ii+5]=b+2;

    // Glow point at head
    glowPositions[i*3]=hx; glowPositions[i*3+1]=hy; glowPositions[i*3+2]=hz;
    glowSeeds[i]=headSeed;
  }

  posAttr      = new THREE.BufferAttribute(positions, 3);
  otherPosAttr = new THREE.BufferAttribute(otherPos,  3);

  lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position",   posAttr);
  lineGeo.setAttribute("aOtherPos",  otherPosAttr);
  lineGeo.setAttribute("aSeed",      new THREE.BufferAttribute(seeds,      1));
  lineGeo.setAttribute("aOtherSeed", new THREE.BufferAttribute(otherSeeds, 1));
  lineGeo.setAttribute("aSide",      new THREE.BufferAttribute(sides,      1));
  lineGeo.setIndex(new THREE.BufferAttribute(indices, 1));

  glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  glowGeo.setAttribute("aSeed",    new THREE.BufferAttribute(glowSeeds,     1));

  if (lineMat && sceneRef) {
    lineMesh = new THREE.Mesh(lineGeo, lineMat);
    sceneRef.add(lineMesh);
  }
  if (glowMat && sceneRef) {
    glowPoints = new THREE.Points(glowGeo, glowMat);
    sceneRef.add(glowPoints);
  }
}

export const particleLines: Pattern = {
  id: "particleLines",
  name: "Particle Lines",
  motionControlLabels: ["Flow Speed", "Line Width"],
  audioControlLabels:  ["Line Width"],
  controls: [
    { label: "Flow Speed",  type: "range", min: 0.0,  max: 3.0,  step: 0.05, default: 0.3,  get: () => flowSpeed,  set: (v) => { flowSpeed  = v; } },
    { label: "Line Count",  type: "range", min: 50,   max: 2000, step: 50,   default: 1000, get: () => lineCount,  set: (v) => { lineCount  = v; needsRebuild = true; } },
    { label: "Line Width",  type: "range", min: 1.5,  max: 14.0, step: 0.5,  default: 4.0,  get: () => lineWidth,  set: (v) => { lineWidth  = v; } },
    { label: "Tail Length", type: "range", min: 1.0,  max: 20.0, step: 0.5,  default: 6.0,  get: () => tailLength, set: (v) => { tailLength = v; needsTailUpdate = true; } },
    // Hidden control — used by audio wrapper only, not shown in UI
    { label: "Colors v2", type: "range", min: 0, max: 3, step: 0.1, default: 3,
      interactive: 'internal' as const,
      get: () => colorC2.colorsV2, set: (v) => { colorC2.colorsV2 = v; } },
  ],
  colorDefaults: { saturation: 0.9, brightness: 1.8 },

  init(ctx: PatternContext) {
    camera   = ctx.camera;
    sceneRef = ctx.scene;
    vpWidth  = ctx.size.width;
    vpHeight = ctx.size.height;
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    needsRebuild    = false;
    needsTailUpdate = false;

    lineMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uLineWidth:   { value: lineWidth },
        uResolution:  { value: new THREE.Vector2(vpWidth, vpHeight) },
        uColorRange:  { value: colorC2.colorsV2 },
        uLineOpacity: { value: 1.0 },
      },
      vertexShader:   lineVertShader,
      fragmentShader: lineFragShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.DoubleSide,
    });

    glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uSize:        { value: 10.0 },
        uColorRange:  { value: colorC2.colorsV2 },
        uLineOpacity: { value: 1.0 },
      },
      vertexShader:   glowVertShader,
      fragmentShader: glowFragShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    buildGeometry();
  },

  update(dt: number) {
    if (!lineMat || !glowMat) return;
    accTime += dt * flowSpeed;
    if (needsRebuild) {
      needsRebuild    = false;
      needsTailUpdate = false;
      buildGeometry();
      return;
    }
    if (needsTailUpdate) {
      needsTailUpdate = false;
      updateTailPositions();
    }

    // Auto-scale opacity so dense/wide configurations don't saturate to white.
    // Formula keeps total perceived brightness roughly constant across lineCount × lineWidth.
    const autoOpacity = Math.min(1.0, 4400 / (lineCount * lineWidth));

    lineMat.uniforms.uTime.value        = accTime;
    lineMat.uniforms.uLineWidth.value   = lineWidth;
    lineMat.uniforms.uColorRange.value  = colorC2.colorsV2;
    lineMat.uniforms.uLineOpacity.value = autoOpacity;

    glowMat.uniforms.uTime.value        = accTime;
    glowMat.uniforms.uColorRange.value  = colorC2.colorsV2;
    glowMat.uniforms.uLineOpacity.value = autoOpacity;
  },

  resize(w: number, h: number) {
    vpWidth = w; vpHeight = h;
    if (lineMat) lineMat.uniforms.uResolution.value.set(w, h);
  },

  dispose() {
    if (lineMesh   && sceneRef) sceneRef.remove(lineMesh);
    if (glowPoints && sceneRef) sceneRef.remove(glowPoints);
    lineGeo?.dispose(); glowGeo?.dispose();
    lineMat?.dispose(); glowMat?.dispose();
    lineMesh = null; glowPoints = null;
    lineGeo  = null; glowGeo    = null;
    lineMat  = null; glowMat    = null;
    camera   = null; sceneRef   = null;
    accTime  = 0; needsRebuild = false; needsTailUpdate = false;
    lineStore    = [];
    posAttr      = null;
    otherPosAttr = null;
  },
};
