import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { colorC2 } from "../colorC2.svelte";

// Pool: create this many lines at init; slider shows/hides a subset.
const MAX_LINES_POOL = 56;
const POINTS_PER_LINE = 64;
const TUBE_SEGMENTS   = 40;
const GLOW_SEGMENTS   = 20;
const TUBE_RADIAL     = 8;
const GLOW_RADIAL     = 6;

let numLines      = 28;
let rotationSpeed = 0.05;
let wobble        = 0.30;
let thickness     = 0.025;
let opacity       = 0.60;
let glow          = 0.45;

let rotationAngle = 0;

interface LineState {
  mesh:         THREE.Mesh;
  geometry:     THREE.BufferGeometry;
  material:     THREE.MeshBasicMaterial;
  glowMesh:     THREE.Mesh;
  glowGeometry: THREE.BufferGeometry;
  glowMaterial: THREE.MeshBasicMaterial;
  basePoints:   THREE.Vector3[];
  animPoints:   THREE.Vector3[];
  curve:        THREE.CatmullRomCurve3;
  tubePosArr:   Float32Array;
  glowPosArr:   Float32Array;
  phase:        number;
}

const lines: LineState[] = [];
let group:  THREE.Group | null = null;
let camera: THREE.PerspectiveCamera | null = null;

// Golden-ratio distribution: for any numLines, visible lines are spread
// evenly across the full radius range rather than all clustering at one end.
function buildBasePoints(seed: number, lineIndex: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const spreadFrac = (lineIndex * 1.6180339887 % MAX_LINES_POOL) / MAX_LINES_POOL;
  const baseR = 0.4 + spreadFrac * 3.2;  // 0.4 → 3.6, fills most of the screen
  for (let i = 0; i < POINTS_PER_LINE; i++) {
    const t = i / (POINTS_PER_LINE - 1);
    const a = t * Math.PI * 4 + seed;
    const r = baseR + Math.sin(seed * 1.7 + t * 6) * 0.5;
    pts.push(new THREE.Vector3(
      Math.cos(a) * r,
      (t - 0.5) * 7 + Math.sin(seed) * 0.5,
      Math.sin(a) * r,
    ));
  }
  return pts;
}

function makeTubeIndices(segments: number, radial: number): Uint32Array {
  const idx = new Uint32Array(segments * radial * 6);
  let i = 0;
  const stride = radial + 1;
  for (let j = 0; j < segments; j++) {
    for (let k = 0; k < radial; k++) {
      const a = stride * j + k;
      const b = stride * (j + 1) + k;
      idx[i++] = a;     idx[i++] = b;     idx[i++] = a + 1;
      idx[i++] = b;     idx[i++] = b + 1; idx[i++] = a + 1;
    }
  }
  return idx;
}

function makeTubeGeometry(segments: number, radial: number): { geo: THREE.BufferGeometry; posArr: Float32Array } {
  const vertCount = (segments + 1) * (radial + 1);
  const posArr = new Float32Array(vertCount * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setIndex(new THREE.BufferAttribute(makeTubeIndices(segments, radial), 1));
  return { geo, posArr };
}

function fillTube(
  posArr: Float32Array,
  pts: THREE.Vector3[],
  normals: THREE.Vector3[],
  binormals: THREE.Vector3[],
  radial: number,
  radius: number,
) {
  const stride = radial + 1;
  const TWO_PI = Math.PI * 2;
  for (let j = 0; j < pts.length; j++) {
    const pt = pts[j];
    const N  = normals[j];
    const B  = binormals[j];
    const base = j * stride * 3;
    for (let k = 0; k <= radial; k++) {
      const angle = (k / radial) * TWO_PI;
      const c = Math.cos(angle), s = Math.sin(angle);
      const vi = base + k * 3;
      posArr[vi]     = pt.x + radius * (c * N.x + s * B.x);
      posArr[vi + 1] = pt.y + radius * (c * N.y + s * B.y);
      posArr[vi + 2] = pt.z + radius * (c * N.z + s * B.z);
    }
  }
}

export const lines3d: Pattern = {
  id: "lines3d",
  name: "3D Lines",
  motionControlLabels: ["Rotation Speed", "Wobble", "Opacity"],
  audioControlLabels:  ["Rotation Speed"],  // Wobble is too jumpy with audio
  controls: [
    { label: "Line Count",    type: "range", min: 14,    max: 56,   step: 1,     default: 28,    get: () => numLines,      set: (v) => { numLines = v; } },
    { label: "Rotation Speed", type: "range", min: 0,    max: 0.5,  step: 0.01,  default: 0.05,  get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Wobble",         type: "range", min: 0,    max: 4.0,  step: 0.05,  default: 0.3,   get: () => wobble,        set: (v) => { wobble = v; } },
    { label: "Thickness",      type: "range", min: 0.005, max: 0.15, step: 0.005, default: 0.025, get: () => thickness,     set: (v) => { thickness = v; } },
    { label: "Glow",           type: "range", min: 0,    max: 1.0,  step: 0.05,  default: 0.45,  get: () => glow,          set: (v) => { glow = v; } },
    { label: "Opacity",        type: "range", min: 0.0,  max: 1.0,  step: 0.05,  default: 0.6,   get: () => opacity,       set: (v) => { opacity = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    rotationAngle = 0;

    group = new THREE.Group();
    ctx.scene.add(group);

    for (let i = 0; i < MAX_LINES_POOL; i++) {
      const seed       = i * 0.91;
      const basePoints = buildBasePoints(seed, i);
      const animPoints = basePoints.map(p => p.clone());
      const curve      = new THREE.CatmullRomCurve3(animPoints, true, "centripetal");

      const _sat2    = Math.min(1.0, colorC2.colorsV2);
      const _spread2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
      const hue      = 0.5 + (i / MAX_LINES_POOL * _spread2) * 0.5;
      const L        = Math.max(0.12, 0.5 - opacity * 0.32);

      const { geo: geometry, posArr: tubePosArr } = makeTubeGeometry(TUBE_SEGMENTS, TUBE_RADIAL);
      const material = new THREE.MeshBasicMaterial({
        color:       new THREE.Color().setHSL(hue, _sat2, L),
        transparent: true,
        opacity,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = i < numLines;
      group.add(mesh);

      const { geo: glowGeometry, posArr: glowPosArr } = makeTubeGeometry(GLOW_SEGMENTS, GLOW_RADIAL);
      const glowMaterial = new THREE.MeshBasicMaterial({
        color:       new THREE.Color().setHSL(hue, _sat2 * 0.85, Math.max(0.15, 0.55 - glow * 0.3)),
        transparent: true,
        opacity:     glow * 0.18,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      });
      const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
      glowMesh.visible = i < numLines;
      group.add(glowMesh);

      const pts    = curve.getPoints(TUBE_SEGMENTS);
      const frames = curve.computeFrenetFrames(TUBE_SEGMENTS, true);
      fillTube(tubePosArr, pts, frames.normals, frames.binormals, TUBE_RADIAL, thickness);
      fillTube(glowPosArr, pts, frames.normals, frames.binormals, GLOW_RADIAL, thickness * 2.8);
      (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (glowGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      lines.push({ mesh, geometry, material, glowMesh, glowGeometry, glowMaterial,
                   basePoints, animPoints, curve, tubePosArr, glowPosArr, phase: i * 0.4 });
    }
  },

  update(dt: number, elapsed: number) {
    if (!group) return;

    rotationAngle   += dt * rotationSpeed;
    group.rotation.y = rotationAngle;
    group.rotation.x = Math.sin(rotationAngle * 0.7) * 0.3;

    for (let i = 0; i < lines.length; i++) {
      const visible = i < numLines;
      const line = lines[i];
      line.mesh.visible     = visible;
      line.glowMesh.visible = visible;
      if (!visible) continue;

      const _sat2    = Math.min(1.0, colorC2.colorsV2);
      const _spread2 = Math.max(0, colorC2.colorsV2 - 1) / 2;
      const hue      = 0.5 + (i / MAX_LINES_POOL * _spread2) * 0.5;
      const L        = Math.max(0.12, 0.5 - opacity * 0.32);

      line.material.color.setHSL(hue, _sat2, L);
      line.material.opacity = opacity;
      line.glowMaterial.color.setHSL(hue, _sat2 * 0.85, Math.max(0.15, 0.55 - glow * 0.3));
      line.glowMaterial.opacity = glow * 0.18;

      for (let idx = 0; idx < POINTS_PER_LINE; idx++) {
        const p = line.basePoints[idx];
        const t = idx / (POINTS_PER_LINE - 1);
        const wob = (Math.sin(elapsed * 0.8 + line.phase + t * 6)
                   + Math.cos(elapsed * 0.5 + line.phase * 1.7 + t * 4) * 0.6) * wobble;
        line.animPoints[idx].set(p.x + wob, p.y, p.z + wob * 0.7);
      }

      const pts    = line.curve.getPoints(TUBE_SEGMENTS);
      const frames = line.curve.computeFrenetFrames(TUBE_SEGMENTS, true);

      fillTube(line.tubePosArr, pts, frames.normals, frames.binormals, TUBE_RADIAL, thickness);
      (line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      fillTube(line.glowPosArr, pts, frames.normals, frames.binormals, GLOW_RADIAL, thickness * 2.8);
      (line.glowGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  },

  resize() {},

  dispose() {
    for (const line of lines) {
      line.geometry.dispose();
      line.material.dispose();
      line.glowGeometry.dispose();
      line.glowMaterial.dispose();
    }
    lines.length = 0;
    group  = null;
    camera = null;
  },
};
