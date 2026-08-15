import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";
import { loadColorStops, RAMP_GLSL } from "../palette";
import { createHeatField, HEAT_DISPLACE_GLSL, type HeatField } from "../heatField";

// Gravity Lines — a near-regular grid of short rounded capsules, each aligned to a
// gravity field made of drifting attractors and repellers. Nothing travels through
// the scene: the field moves *under* a static grid, so the picture is a vector field
// made visible. Where a mass passes, the capsules swing around it into vortices;
// close to its centre they shorten and fade, leaving the dark cores.
//
// Each capsule is a screen-space quad (same fat-line trick as Particle Lines) with a
// capsule SDF in the fragment shader for the rounded ends, so Line Width is in real
// pixels at any distance.

const MAX_SEGMENTS  = 12000;
const MAX_ATTRACTORS = 8;

let segmentCount = 6000;
let lineWidth    = 4.0;   // pixels
let lineLength   = 0.28;  // world units at full field strength
let flowSpeed    = 0.35;
let attractors   = 5;
let swirl        = 0.55;
let softening    = 0.5;
let depth        = 0.6;

let heatStrength = 0.5;
let heatGain     = 11.0;
let blurRadius   = 4.0;
let mirrorX      = true;
// Heat Mode: 0 = Attract (instantaneous), 1 = Push Away (persistent, relaxes back)
let heatMode     = 0;
let pushStrength = 1.2;
let solidity     = 1.0;
let returnSpeed  = 0.35;
let pushSpread   = 0.4;
let heatBend     = 1.0;

let mesh:     THREE.Mesh | null = null;
let geometry: THREE.BufferGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;
let sceneRef: THREE.Scene | null = null;
let heatField: HeatField | null = null;
let heatWasOn = false;

let gridAttr: THREE.BufferAttribute | null = null;
let accTime  = 0;
let vpWidth = 1, vpHeight = 1;
let gridAspect = 0;          // aspect the current grid layout was built for
let gridSegments = 0;        // segment count the current grid layout was built for
const CAM_Z = 4.0;
const HALF_H = CAM_Z * Math.tan((60 * Math.PI) / 360);   // renderer fov is 60°

// ─── Shaders ──────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2  uExtent;        // half width/height of the grid in world units
  uniform vec2  uResolution;
  uniform float uLineWidth;     // pixels
  uniform float uLineLength;
  uniform float uSwirl;
  uniform float uSoftening;
  uniform float uDepth;
  uniform float uHeatActive;    // 1 while Heat is on — gates the heat sampling
  uniform float uHeatBend;
  uniform float uMirrorX;
  uniform vec3  uAttractors[${MAX_ATTRACTORS}];   // xy = position, z = signed mass

  attribute vec2  aGrid;    // cell centre in [-1,1]
  attribute float aSeed;
  attribute float aSide;    // -1 / +1 across the capsule
  attribute float aAlong;   // -1 / +1 along the capsule

  varying float vSeed;
  varying float vStrength;
  varying vec2  vCapsPx;    // fragment position relative to the capsule centre, px
  varying float vHalfLenPx;

  ${HEAT_DISPLACE_GLSL}

  vec2 gravField(vec2 p) {
    vec2 f = vec2(0.0);
    for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
      vec3 a = uAttractors[i];          // inactive masses are zeroed on the CPU
      vec2 d = a.xy - p;
      float r2 = dot(d, d) + uSoftening;
      vec2 radial  = d / r2;
      vec2 tangent = vec2(-d.y, d.x) / r2;
      f += a.z * mix(radial, tangent, uSwirl);
    }
    return f;
  }

  void main() {
    vSeed = aSeed;

    // Base position: the cell centre on an undulating sheet.
    vec3 base = vec3(aGrid * uExtent, 0.0);
    base.z = sin(base.x * 0.9 + uTime * 0.7) * cos(base.y * 0.8 - uTime * 0.5) * uDepth;

    // Heat displacement at this capsule's own screen position.
    vec2 disp = vec2(0.0);
    if (uHeatActive > 0.5) {
      vec4 mv0   = modelViewMatrix * vec4(base, 1.0);
      vec4 clip0 = projectionMatrix * mv0;
      if (clip0.w > 0.0) {
        vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
        uv.y = 1.0 - uv.y;
        if (uMirrorX > 0.5) uv.x = 1.0 - uv.x;
        disp = heatDisplace(uv);
        base.xy += disp * max(-mv0.z, 0.1) * tan(radians(30.0));
      }
    }

    // Field at the cell — heat bends the direction as well as shifting the cell.
    vec2 f = gravField(base.xy) + disp * uHeatBend;
    float m = length(f);
    vec2 dir = m > 1e-5 ? f / m : vec2(1.0, 0.0);

    // 0 near a core (short, dim) → 1 in the strong flow bands (long, bright).
    // Scale-free, so Masses / Softening can't blow the ramp out at either end.
    float t = m / (m + 0.45);
    vStrength = t;

    float halfLen = uLineLength * (0.15 + 0.85 * t) * 0.5;
    vec3 pA = base - vec3(dir * halfLen, 0.0);
    vec3 pB = base + vec3(dir * halfLen, 0.0);

    vec4 clipA = projectionMatrix * modelViewMatrix * vec4(pA, 1.0);
    vec4 clipB = projectionMatrix * modelViewMatrix * vec4(pB, 1.0);
    float wA = max(clipA.w, 0.001);
    float wB = max(clipB.w, 0.001);

    // Build the quad in pixel space around the capsule centre so both ends agree
    // on one frame — otherwise the two halves shear apart under perspective.
    vec2 halfRes = uResolution * 0.5;
    vec2 pxA = (clipA.xy / wA) * halfRes;
    vec2 pxB = (clipB.xy / wB) * halfRes;
    vec2 pxC = (pxA + pxB) * 0.5;
    vec2 seg = pxB - pxA;
    float lenPx = length(seg);
    vec2 axis = lenPx > 0.0001 ? seg / lenPx : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);

    float R = uLineWidth * 0.5;
    vHalfLenPx = lenPx * 0.5;
    // The quad runs past each end by R so the round caps have room to be drawn.
    vec2 offset = axis * aAlong * (vHalfLenPx + R) + perp * aSide * R;
    vCapsPx = vec2(aAlong * (vHalfLenPx + R), aSide * R);

    vec2 ndc = (pxC + offset) / halfRes;
    float w = (wA + wB) * 0.5;
    float zNdc = (clipA.z / wA + clipB.z / wB) * 0.5;
    gl_Position = vec4(ndc * w, zNdc * w, w);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uLineWidth;
  uniform float uOpacity;
  uniform float uColorsV2;
  uniform vec3  uColors[6];
  uniform float uColorCount;

  varying float vSeed;
  varying float vStrength;
  varying vec2  vCapsPx;
  varying float vHalfLenPx;

  ${RAMP_GLSL}

  void main() {
    // Capsule SDF: distance to the segment core, in pixels.
    float R = uLineWidth * 0.5;
    float d = length(vec2(max(abs(vCapsPx.x) - vHalfLenPx, 0.0), vCapsPx.y));
    float aa = clamp(R * 0.6, 0.5, 2.0);
    float cover = 1.0 - smoothstep(R - aa, R, d);
    if (cover <= 0.001) discard;

    // Colour: black → palette across field strength, collapsing toward a single
    // colour (and then white) as Colors v2 falls — same semantics as the other patterns.
    float ph1 = clamp(uColorsV2, 0.0, 1.0);
    float ph2 = clamp(uColorsV2 - 1.0, 0.0, 2.0) * 0.5;
    vec3 flat1 = mix(vec3(1.0), uColors[0], ph1);
    vec3 col   = mix(flat1, paletteRamp(vStrength), ph2);

    // Per-capsule brightness scatter — the grid reads as lit, not printed.
    float scatter = 0.7 + fract(vSeed * 7.317) * 0.3;
    float bright  = (0.45 + 0.85 * vStrength) * scatter;

    gl_FragColor = vec4(col * bright, cover * uOpacity);
  }
`;

// ─── Geometry ─────────────────────────────────────────────────────────────────
// Allocated once at MAX_SEGMENTS; Line Count only moves the draw range, and the
// grid coordinates are rewritten in place when count or aspect changes. Nothing
// is re-allocated at runtime, so no black frame on a slider drag or a resize.

const seedStore = new Float32Array(MAX_SEGMENTS);
for (let i = 0; i < MAX_SEGMENTS; i++) seedStore[i] = Math.random();
const jitterStore = new Float32Array(MAX_SEGMENTS * 2);
for (let i = 0; i < MAX_SEGMENTS * 2; i++) jitterStore[i] = Math.random() - 0.5;

function layoutGrid(count: number, aspect: number) {
  if (!gridAttr) return;
  const grid = gridAttr.array as Float32Array;
  const rows = Math.max(2, Math.round(Math.sqrt(count / Math.max(aspect, 0.2))));
  const cols = Math.max(2, Math.ceil(count / rows));
  const jx = 0.55 / cols, jy = 0.55 / rows;
  for (let i = 0; i < count; i++) {
    const cx = i % cols, cy = Math.floor(i / cols);
    // Cell centres over [-1,1]², nudged so the lattice doesn't read as a printed grid.
    const gx = ((cx + 0.5) / cols) * 2 - 1 + jitterStore[i * 2] * jx * 2;
    const gy = ((cy + 0.5) / rows) * 2 - 1 + jitterStore[i * 2 + 1] * jy * 2;
    const b = i * 4;
    for (let v = 0; v < 4; v++) {
      grid[(b + v) * 2]     = gx;
      grid[(b + v) * 2 + 1] = gy;
    }
  }
  gridAttr.needsUpdate = true;
  gridSegments = count;
  gridAspect   = aspect;
}

function buildGeometry(): THREE.BufferGeometry {
  const grid   = new Float32Array(MAX_SEGMENTS * 4 * 2);
  const seeds  = new Float32Array(MAX_SEGMENTS * 4);
  const sides  = new Float32Array(MAX_SEGMENTS * 4);
  const alongs = new Float32Array(MAX_SEGMENTS * 4);
  const index  = new Uint32Array(MAX_SEGMENTS * 6);

  for (let i = 0; i < MAX_SEGMENTS; i++) {
    const b = i * 4;
    // Corner layout: 0 = (-along,-side) 1 = (-along,+side) 2 = (+along,-side) 3 = (+along,+side)
    const alongSign = [-1, -1, 1, 1];
    const sideSign  = [-1, 1, -1, 1];
    for (let v = 0; v < 4; v++) {
      seeds[b + v]  = seedStore[i];
      sides[b + v]  = sideSign[v];
      alongs[b + v] = alongSign[v];
    }
    const ii = i * 6;
    index[ii]     = b;     index[ii + 1] = b + 1; index[ii + 2] = b + 2;
    index[ii + 3] = b + 1; index[ii + 4] = b + 3; index[ii + 5] = b + 2;
  }

  gridAttr = new THREE.BufferAttribute(grid, 2);
  gridAttr.setUsage(THREE.DynamicDrawUsage);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("aGrid",  gridAttr);
  geo.setAttribute("aSeed",  new THREE.BufferAttribute(seeds,  1));
  geo.setAttribute("aSide",  new THREE.BufferAttribute(sides,  1));
  geo.setAttribute("aAlong", new THREE.BufferAttribute(alongs, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Everything is positioned in the vertex shader — the default bounding sphere
  // would be empty and the mesh would be frustum-culled away.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
  return geo;
}

/** Drifting masses on Lissajous orbits — a mix of attractors and repellers. */
function updateAttractors(target: THREE.Vector3[], extentX: number, extentY: number) {
  const n = Math.round(attractors);
  for (let i = 0; i < MAX_ATTRACTORS; i++) {
    if (i >= n) { target[i].set(0, 0, 0); continue; }
    const s = i * 1.7;
    const x = Math.sin(accTime * (0.31 + 0.07 * i) + s)       * extentX * 0.75;
    const y = Math.cos(accTime * (0.23 + 0.05 * i) + s * 1.3) * extentY * 0.75;
    // Every third mass repels — that is what opens the fanned-out bands between vortices.
    const sign = i % 3 === 2 ? -1 : 1;
    const mass = sign * (0.7 + 0.3 * Math.sin(accTime * 0.4 + s));
    target[i].set(x, y, mass);
  }
}

export const gravityLines: Pattern = {
  id: "gravityLines",
  name: "Gravity Lines",
  heatReactive: true,
  motionControlLabels: ['Line Length', 'Flow Speed'],
  audioControlLabels:  ['Line Width', 'Flow Speed', 'Heat Strength'],
  colorDefaults: { saturation: 0.9, brightness: 1.4 },

  activate() {
    cameraState.heatEnabled = true;
    cameraState.enabled = true;
  },

  controls: [
    { label: "Line Count",    type: "range", min: 1000, max: MAX_SEGMENTS, step: 500,  default: 6000, tip: "How many capsules make up the grid. More = finer weave, heavier on GPU.", get: () => segmentCount, set: v => { segmentCount = Math.round(v); } },
    { label: "Line Width",    type: "range", min: 1.5,  max: 10,   step: 0.5,  default: 4,    tip: "Thickness of each capsule, in pixels.",                                   get: () => lineWidth,    set: v => { lineWidth = v; } },
    { label: "Line Length",   type: "range", min: 0.05, max: 0.6,  step: 0.01, default: 0.28, tip: "Length of each capsule. Short near the dark cores, full in the flow bands.", get: () => lineLength,   set: v => { lineLength = v; } },
    { label: "Flow Speed",    type: "range", min: 0,    max: 2,    step: 0.05, default: 0.35, tip: "How fast the masses drift, and with them the whole field.",                get: () => flowSpeed,    set: v => { flowSpeed = v; } },
    { label: "Masses",        type: "range", min: 2,    max: MAX_ATTRACTORS, step: 1, default: 5, tip: "Number of gravity centres. Every third one repels instead of attracts.", get: () => attractors,   set: v => { attractors = Math.round(v); } },
    { label: "Swirl",         type: "range", min: 0,    max: 1,    step: 0.05, default: 0.55, tip: "0 = capsules point straight at the masses, 1 = they orbit them as vortices.", get: () => swirl,        set: v => { swirl = v; } },
    { label: "Softening",     type: "range", min: 0.05, max: 2,    step: 0.05, default: 0.5,  tip: "Size of each mass's dark core — higher = wider, gentler wells.",           get: () => softening,    set: v => { softening = v; } },
    { label: "Depth",         type: "range", min: 0,    max: 1.5,  step: 0.05, default: 0.6,  tip: "Undulation of the sheet. 0 = flat grid, higher = a surface folding in 3D.", get: () => depth,        set: v => { depth = v; } },
    { label: "Colors v2",     type: "range", min: 0,    max: 3,    step: 0.1,  default: 3,    interactive: 'internal' as const, get: () => colorC2.colorsV2, set: v => { colorC2.colorsV2 = v; } },
    { label: "Heat Strength", type: "range", min: 0,    max: 1.5,  step: 0.05, default: 0.5,  interactive: 'heat' as const, tip: "How strongly the heat map shifts and bends the grid. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range", min: 4,    max: 20,   step: 0.5,  default: 11,   interactive: 'heat' as const, tip: "Amplify the heat signal — higher = reacts to subtler motion.",       get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Bend Strength", type: "range", min: 0,    max: 4,    step: 0.1,  default: 1,    interactive: 'heat' as const, tip: "How far your motion swings the capsules' direction, on top of moving them. High values snap the whole grid radially onto you and flatten the vortices.", get: () => heatBend, set: v => { heatBend = v; } },
    { label: "Blur Radius",   type: "range", min: 0,    max: 10,   step: 0.1,  default: 4,    interactive: 'heat' as const, tip: "Blur applied to the heat map before it drives the grid.",            get: () => blurRadius,   set: v => { blurRadius = v; } },
    { label: "Push Away",     type: "toggle", interactive: 'heat' as const, tip: "Off: the grid follows your motion and snaps back the moment you stop. On: your movement shoves the capsules aside and the gap only slowly fills in again. Requires Heat.", get: () => heatMode === 1, set: v => { heatMode = v ? 1 : 0; heatField?.reset(); } },
    { label: "Solidity",      type: "range", min: 0,    max: 1.5,  step: 0.05, default: 1,    interactive: 'heat' as const, tip: "How solid your body is as it sweeps through. 1 = everything you cover is cleared out to the edge of your silhouette in one pass. 0 = only a soft nudge from your outline. Push Away only.", get: () => solidity, set: v => { solidity = v; } },
    { label: "Push Strength", type: "range", min: 0,    max: 3,    step: 0.05, default: 1.2,  interactive: 'heat' as const, tip: "Extra soft shove from your outline, on top of Solidity — it builds up over repeated passes. Push Away only.", get: () => pushStrength, set: v => { pushStrength = v; } },
    { label: "Return Speed",  type: "range", min: 0.05, max: 2,    step: 0.05, default: 0.35, interactive: 'heat' as const, tip: "How fast the gap fills back in — lower = it stays open longer. Push Away only.", get: () => returnSpeed, set: v => { returnSpeed = v; } },
    { label: "Spread",        type: "range", min: 0,    max: 1,    step: 0.05, default: 0.4,  interactive: 'heat' as const, tip: "How softly the gap's edge melts back — neighbours roll in from the sides. Push Away only.", get: () => pushSpread, set: v => { pushSpread = v; } },
  ],

  init(ctx: PatternContext) {
    sceneRef = ctx.scene;
    vpWidth  = ctx.size.width;
    vpHeight = ctx.size.height;
    ctx.camera.position.set(0, 0, CAM_Z);
    ctx.camera.lookAt(0, 0, 0);

    heatField = createHeatField();
    heatWasOn = false;
    accTime   = 0;

    geometry = buildGeometry();
    const aspect = vpWidth / Math.max(vpHeight, 1);
    layoutGrid(segmentCount, aspect);
    geometry.setDrawRange(0, segmentCount * 6);

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        // A margin past the frustum edge keeps capsules from popping in at the border.
        uExtent:       { value: new THREE.Vector2(HALF_H * aspect * 1.15, HALF_H * 1.15) },
        uResolution:   { value: new THREE.Vector2(vpWidth, vpHeight) },
        uLineWidth:    { value: lineWidth },
        uLineLength:   { value: lineLength },
        uSwirl:        { value: swirl },
        uSoftening:    { value: softening },
        uDepth:        { value: depth },
        uOpacity:      { value: 1.0 },
        uColorsV2:     { value: colorC2.colorsV2 },
        uColors:       { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },
        uColorCount:   { value: 3.0 },
        uAttractors:   { value: Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector3()) },
        uHeatMap:      { value: heatField.heatTexture },
        uPushField:    { value: heatField.pushTexture },
        uHeatMode:     { value: 0 },
        uHeatGain:     { value: heatGain },
        uHeatStrength: { value: 0 },
        uHeatActive:   { value: 0 },
        // Heat perturbs the direction of the field; past ~1 it starts to replace it,
        // and the whole grid snaps radially onto the person as the vortices flatten.
        uHeatBend:     { value: heatBend },
        uMirrorX:      { value: mirrorX ? 1.0 : 0.0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.DoubleSide,
    });

    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
  },

  update(dt: number, _elapsed: number) {
    if (!material || !geometry) return;
    accTime += dt * flowSpeed;

    const aspect = vpWidth / Math.max(vpHeight, 1);
    if (segmentCount !== gridSegments || Math.abs(aspect - gridAspect) > 0.02) {
      layoutGrid(segmentCount, aspect);
      geometry.setDrawRange(0, segmentCount * 6);
    }

    const u = material.uniforms;
    u.uTime.value       = accTime;
    u.uLineWidth.value  = lineWidth;
    u.uLineLength.value = lineLength;
    u.uSwirl.value      = swirl;
    u.uSoftening.value  = softening;
    u.uDepth.value      = depth;
    u.uColorsV2.value   = colorC2.colorsV2;
    u.uMirrorX.value    = mirrorX ? 1.0 : 0.0;
    u.uColorCount.value = loadColorStops(u.uColors.value as THREE.Vector3[]);
    (u.uExtent.value as THREE.Vector2).set(HALF_H * aspect * 1.15, HALF_H * 1.15);
    updateAttractors(u.uAttractors.value as THREE.Vector3[], HALF_H * aspect, HALF_H);

    // Additive blending blows out once the capsules cover more than about half the
    // screen — which happens at high Line Count, at fat Line Width, and (the case
    // that is easy to miss) in a small viewport, where the same grid is packed into
    // far fewer pixels. Estimate the actual coverage and ease the opacity back.
    const avgLenPx = (lineLength * 0.6 / (2 * HALF_H)) * vpHeight;
    const coverage = (segmentCount * lineWidth * (avgLenPx + lineWidth)) / Math.max(vpWidth * vpHeight, 1);
    u.uOpacity.value = Math.min(1, Math.pow(0.55 / Math.max(coverage, 0.001), 0.7));

    // Heat reactivity must respect the "Heat" toggle — without this gate the pattern
    // keeps responding to heatMap data as long as the camera is running at all.
    if (cameraState.heatEnabled) {
      u.uHeatActive.value   = 1;
      u.uHeatStrength.value = heatStrength;
      u.uHeatGain.value     = heatGain;
      u.uHeatBend.value     = heatBend;
      u.uHeatMode.value     = heatMode;
      heatField?.update(dt, {
        blurRadius,
        pushStrength: heatMode === 1 ? pushStrength : 0,
        solidity:     heatMode === 1 ? solidity : 0,
        returnSpeed,
        spread: pushSpread,
        aspect,
        heatGain,
        heatStrength,
      });
      heatWasOn = true;
    } else {
      u.uHeatActive.value   = 0;
      u.uHeatMode.value     = 0;
      u.uHeatStrength.value = 0;
      u.uHeatGain.value     = 0;
      if (heatWasOn) { heatField?.reset(); heatWasOn = false; }
    }
  },

  resize(w: number, h: number) {
    vpWidth = w; vpHeight = h;
    if (material) (material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  },

  dispose() {
    if (mesh && sceneRef) sceneRef.remove(mesh);
    heatField?.dispose();
    geometry?.dispose();
    material?.dispose();
    mesh      = null;
    geometry  = null;
    material  = null;
    sceneRef  = null;
    heatField = null;
    heatWasOn = false;
    gridAttr  = null;
    gridAspect   = 0;
    gridSegments = 0;
    accTime   = 0;
  },
};
