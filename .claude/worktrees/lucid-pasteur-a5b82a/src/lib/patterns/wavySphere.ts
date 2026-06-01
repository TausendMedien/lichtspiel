import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";

let mesh: THREE.Mesh | null = null;
let geometry: THREE.SphereGeometry | null = null;
let material: THREE.ShaderMaterial | null = null;

let waveSpeed     = 0.04;
let amplitude     = 0.35;
let rotationSpeed = 0.4;
let colorShift    = 0.0;

let accTime = 0;
let rotX = 0, rotY = 0, rotZ = 0;

// ─── Vertex shader ────────────────────────────────────────────────────────────
// Deforms the sphere using wave functions; passes normalised position + wave
// intensity to the fragment shader for depth-based shading.
const vertexShader = /* glsl */ `
  varying vec3 vNorm;
  varying float vWave;
  uniform float uTime;
  uniform float uAmplitude;

  void main() {
    float angInc = 3.14159 / 1024.0;
    float angle  = (position.x + position.z) * angInc;

    // Primary wave + a secondary cross-wave for added complexity
    float w1 = cos(angle * uTime) * uAmplitude;
    float w2 = sin((position.y - position.x) * angInc * 0.7 * uTime) * uAmplitude * 0.5;
    float wave = w1 + w2;

    vec3 pos = position;
    pos.x *= w1 + 1.0;
    pos.z *= w1 + 1.0;
    pos.y *= (w2 + w1 * 0.5) + 1.0;

    vNorm = normalize(pos);
    vWave = wave; // pass to fragment for shading

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// ─── Fragment shader ──────────────────────────────────────────────────────────
// Blends gold ↔ cyan based on view position; applies wave-depth shadow so
// valleys are dark and crests are bright.
const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3  vNorm;
  varying float vWave;
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uColorShift;

  void main() {
    vec3 gold = vec3(0.95, 0.72, 0.05);
    vec3 cyan = vec3(0.0,  0.88, 1.0);
    vec3 dark = vec3(0.02, 0.04, 0.08);

    // Blend gold → dark → cyan to avoid the green midpoint that
    // a direct gold↔cyan lerp produces.
    float latitude  = clamp(vNorm.y * 0.5 + 0.5, 0.0, 1.0);
    float timeBlend = fract(uTime * 0.018 + uColorShift);
    float blend     = clamp(latitude + timeBlend * 0.6 - 0.3, 0.0, 1.0);
    vec3 col;
    if (blend < 0.5) {
      col = mix(gold, dark, blend * 2.0);
    } else {
      col = mix(dark, cyan, (blend - 0.5) * 2.0);
    }

    // Wave-depth shadow: valleys dark, crests bright — amplifies visibility
    float normalised = vWave / max(uAmplitude, 0.001);          // -1 .. +1
    float shadow = 0.25 + 0.75 * clamp(normalised * 0.5 + 0.5, 0.0, 1.0);
    col *= shadow;

    // Subtle edge darkening (rim)
    float rim = 1.0 - abs(dot(vNorm, vec3(0.0, 0.0, 1.0)));
    col = mix(col, dark, rim * rim * 0.4);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const wavySphere: Pattern = {
  id: "wavySphere",
  name: "Wavy Sphere",
  attribution: "Adapted from Mauricio Massaia — proto-02",
  controls: [
    { label: "Wave Speed",   type: "range", min: 0.0, max: 0.20, step: 0.005, default: 0.04, get: () => waveSpeed,     set: (v) => { waveSpeed = v; } },
    { label: "Amplitude",    type: "range", min: 0.0, max: 0.80, step: 0.01,  default: 0.35, get: () => amplitude,     set: (v) => { amplitude = v; } },
    { label: "Rotation",     type: "range", min: 0.0, max: 2.0,  step: 0.05,  default: 0.4,  get: () => rotationSpeed, set: (v) => { rotationSpeed = v; } },
    { label: "Color Shift",  type: "range", min: 0.0, max: 1.0,  step: 0.01,  default: 0.0,  get: () => colorShift,    set: (v) => { colorShift = v; } },
  ],

  init(ctx: PatternContext) {
    geometry = new THREE.SphereGeometry(1024, 128, 128);
    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uAmplitude:  { value: amplitude },
        uColorShift: { value: colorShift },
      },
      vertexShader, fragmentShader,
      side: THREE.FrontSide,
    });
    mesh = new THREE.Mesh(geometry, material);
    ctx.scene.add(mesh);

    ctx.camera.position.set(0, 0, 2800);
    ctx.camera.near = 1;
    ctx.camera.far  = 10000;
    ctx.camera.updateProjectionMatrix();
  },

  update(dt: number, _elapsed: number) {
    if (!material || !mesh) return;
    accTime += dt * waveSpeed * 25;
    rotY    += dt * rotationSpeed * 0.5;
    rotX    += dt * rotationSpeed * 0.1;
    rotZ    += dt * rotationSpeed * 0.3;
    material.uniforms.uTime.value       = accTime;
    material.uniforms.uAmplitude.value  = amplitude;
    material.uniforms.uColorShift.value = colorShift;
    mesh.rotation.set(rotX, rotY, rotZ);
  },

  resize(_width: number, _height: number) {},

  dispose() {
    geometry?.dispose(); material?.dispose();
    mesh = null; geometry = null; material = null;
    accTime = 0; rotX = 0; rotY = 0; rotZ = 0;
  },
};
