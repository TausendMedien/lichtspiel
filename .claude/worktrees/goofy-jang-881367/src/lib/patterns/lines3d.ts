import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

const NUM_LINES        = 14;
const POINTS_PER_LINE  = 64;
const TUBE_SEGMENTS    = 200;
const GLOW_SEGMENTS    = 100;

let rotationSpeed = 0.05;
let wobble        = 0.30;
let colorRange    = 1.0;
let saturation    = 1.0;
let opacity       = 0.60;
let glow          = 0.45;

let rotationAngle = 0;

interface LineState {
  mesh:         THREE.Mesh;
  geometry:     THREE.TubeGeometry;
  material:     THREE.MeshBasicMaterial;
  glowMesh:     THREE.Mesh;
  glowGeometry: THREE.TubeGeometry;
  glowMaterial: THREE.MeshBasicMaterial;
  basePoints:   THREE.Vector3[];
  phase:        number;
}

const lines: LineState[] = [];
let group:  THREE.Group | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function buildBasePoints(seed: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < POINTS_PER_LINE; i++) {
    const t = i / (POINTS_PER_LINE - 1);
    const a = t * Math.PI * 4 + seed;
    const r = 1.5 + Math.sin(seed * 1.7 + t * 6) * 0.6;
    pts.push(new THREE.Vector3(
      Math.cos(a) * r,
      (t - 0.5) * 5 + Math.sin(seed) * 0.5,
      Math.sin(a) * r,
    ));
  }
  return pts;
}

export const lines3d: Pattern = {
  id: "lines3d",
  name: "3D Lines",
  motionControlLabels: ["Rotation Speed", "Wobble", "Colors", "Saturation", "Opacity"],
  controls: [
    { label: "Rotation Speed", type: "range", min: 0,   max: 0.5, step: 0.01, default: 0.05, get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Wobble",         type: "range", min: 0,   max: 0.8, step: 0.01, default: 0.3, get: () => wobble,         set: (v) => { wobble = v; } },
    { label: "Glow",           type: "range", min: 0,   max: 1.0, step: 0.05, default: 0.45, get: () => glow,           set: (v) => { glow = v; } },
    { label: "Colors",         type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => colorRange,     set: (v) => { colorRange = v; } },
    { label: "Saturation",     type: "range", min: 0.0, max: 1.0, step: 0.05, default: 1, get: () => saturation,     set: (v) => { saturation = v; } },
    { label: "Opacity",        type: "range", min: 0.0, max: 1.0, step: 0.05, default: 0.6, get: () => opacity,        set: (v) => { opacity = v; } },
  ],

  init(ctx: PatternContext) {
    camera = ctx.camera;
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    rotationAngle = 0;

    group = new THREE.Group();
    ctx.scene.add(group);

    for (let i = 0; i < NUM_LINES; i++) {
      const seed       = i * 0.91;
      const basePoints = buildBasePoints(seed);
      const curve      = new THREE.CatmullRomCurve3(basePoints, true, "centripetal");
      const hue        = 0.5 + (i / NUM_LINES * colorRange) * 0.5;

      const geometry = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, 0.025, 8, true);
      const L = Math.max(0.12, 0.5 - opacity * 0.32);
      const material = new THREE.MeshBasicMaterial({
        color:      new THREE.Color().setHSL(hue, saturation, L),
        transparent: true,
        opacity,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      group.add(mesh);

      // Wider glow tube — additive blending creates bloom where lines intersect
      const glowGeometry = new THREE.TubeGeometry(curve, GLOW_SEGMENTS, 0.07, 6, true);
      const glowMaterial = new THREE.MeshBasicMaterial({
        color:      new THREE.Color().setHSL(hue, saturation * 0.85, Math.max(0.15, 0.55 - glow * 0.3)),
        transparent: true,
        opacity:    glow * 0.18,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
      group.add(glowMesh);

      lines.push({ mesh, geometry, material, glowMesh, glowGeometry, glowMaterial, basePoints, phase: i * 0.4 });
    }
  },

  update(dt: number, elapsed: number) {
    if (!group) return;

    // Accumulate rotation so speed=0 truly freezes the scene
    rotationAngle    += dt * rotationSpeed;
    group.rotation.y  = rotationAngle;
    group.rotation.x  = Math.sin(rotationAngle * 0.7) * 0.3;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hue  = 0.5 + (i / NUM_LINES * colorRange) * 0.5;

      const L = Math.max(0.12, 0.5 - opacity * 0.32);
      line.material.color.setHSL(hue, saturation, L);
      line.material.opacity = opacity;

      line.glowMaterial.color.setHSL(hue, saturation * 0.85, Math.max(0.15, 0.55 - glow * 0.3));
      line.glowMaterial.opacity = glow * 0.18;

      const animated = line.basePoints.map((p, idx) => {
        const t   = idx / (POINTS_PER_LINE - 1);
        const wob = Math.sin(elapsed * 0.8 + line.phase + t * 6) * wobble
                  + Math.cos(elapsed * 0.5 + line.phase * 1.7 + t * 4) * wobble * 0.6;
        return new THREE.Vector3(p.x + wob, p.y, p.z + wob * 0.7);
      });

      const curve = new THREE.CatmullRomCurve3(animated, true, "centripetal");

      const next = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, 0.025, 8, true);
      line.mesh.geometry.dispose();
      line.mesh.geometry = next;
      line.geometry = next;

      const glowNext = new THREE.TubeGeometry(curve, GLOW_SEGMENTS, 0.07, 6, true);
      line.glowMesh.geometry.dispose();
      line.glowMesh.geometry = glowNext;
      line.glowGeometry = glowNext;
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
