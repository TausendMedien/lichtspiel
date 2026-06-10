import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";

const W = 160;
const H = 90;

let camera: THREE.PerspectiveCamera | null = null;
let planeMesh: THREE.Mesh | null = null;
let material: THREE.ShaderMaterial | null = null;
let texture: THREE.DataTexture | null = null;
let texData: Float32Array | null = null;

let gainParam      = 12;
let thresholdParam = 0.008;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Palette-based ramp: 0 → black, stops evenly distributed through enabled colors.
// Constant indices only — compatible with GLSL ES 1.0.
const fragmentShader = /* glsl */ `
  uniform sampler2D uHeatMap;
  uniform float     uGain;
  uniform float     uThreshold;
  uniform vec3      uColors[6];
  uniform float     uColorCount;
  varying vec2      vUv;

  vec3 heatRamp(float t) {
    float pos = clamp(t * uColorCount, 0.0, uColorCount - 0.001);
    float lof = floor(pos);
    float f   = pos - lof;

    vec3 a = vec3(0.0);
    vec3 b = uColors[0];

    if (lof >= 1.0) { a = uColors[0]; b = uColors[1]; }
    if (lof >= 2.0) { a = uColors[1]; b = uColors[2]; }
    if (lof >= 3.0) { a = uColors[2]; b = uColors[3]; }
    if (lof >= 4.0) { a = uColors[3]; b = uColors[4]; }
    if (lof >= 5.0) { a = uColors[4]; b = uColors[5]; }

    return mix(a, b, f);
  }

  void main() {
    // Flip Y: diff buffer row 0 = top of frame, Three.js UV (0,0) = bottom-left
    float heat = texture2D(uHeatMap, vec2(vUv.x, 1.0 - vUv.y)).r;
    // Subtract noise floor before amplifying — keeps static dark areas black
    float t = clamp((heat - uThreshold) * uGain, 0.0, 1.0);
    gl_FragColor = vec4(heatRamp(t), 1.0);
  }
`;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function loadColorStops(colors: THREE.Vector3[]): number {
  let count = 0;
  const push = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    colors[count].set(r, g, b);
    count++;
  };
  push(colorC2.main);
  push(colorC2.contrast);
  push(colorC2.glow);
  if (colorC2.extra1on) push(colorC2.extra1);
  if (colorC2.extra2on) push(colorC2.extra2);
  if (colorC2.extra3on) push(colorC2.extra3);
  return count;
}

function fillPlane(width: number, height: number) {
  if (!planeMesh || !camera) return;
  const dist = Math.abs(camera.position.z);
  const h = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
  const w = h * (width / Math.max(height, 1));
  planeMesh.scale.set(w, h, 1);
}

export const heatMap: Pattern = {
  id: "heatMap",
  name: "Heat Map",
  controls: [
    {
      label: "Gain",
      type: "range" as const,
      min: 1, max: 50, step: 1, default: 12,
      get: () => gainParam,
      set: (v: number) => { gainParam = v; },
    },
    {
      label: "Threshold",
      type: "range" as const,
      min: 0, max: 0.05, step: 0.001, default: 0.008,
      get: () => thresholdParam,
      set: (v: number) => { thresholdParam = v; },
    },
  ],

  activate() {
    // Heat Map IS the camera — auto-enable so the user doesn't have to turn Motion on manually.
    cameraState.enabled = true;
  },

  init(ctx: PatternContext) {
    cameraState.enabled = true;
    camera = ctx.camera;
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);

    texData = new Float32Array(W * H);
    texture = new THREE.DataTexture(texData, W, H, THREE.RedFormat, THREE.FloatType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const colorVecs = Array.from({ length: 6 }, () => new THREE.Vector3());

    material = new THREE.ShaderMaterial({
      uniforms: {
        uHeatMap:    { value: texture },
        uGain:       { value: gainParam },
        uThreshold:  { value: thresholdParam },
        uColors:     { value: colorVecs },
        uColorCount: { value: 3.0 },
      },
      vertexShader,
      fragmentShader,
      depthWrite: false,
    });

    const geo = new THREE.PlaneGeometry(1, 1);
    planeMesh = new THREE.Mesh(geo, material);
    ctx.scene.add(planeMesh);
  },

  update(_dt: number, _elapsed: number) {
    if (!material || !texture || !texData) return;
    texData.set(cameraState.heatMap);
    texture.needsUpdate = true;

    material.uniforms.uGain.value      = gainParam;
    material.uniforms.uThreshold.value = thresholdParam;
    const colors = material.uniforms.uColors.value as THREE.Vector3[];
    material.uniforms.uColorCount.value = loadColorStops(colors);
  },

  resize(width: number, height: number) {
    fillPlane(width, height);
  },

  dispose() {
    texture?.dispose();
    material?.dispose();
    (planeMesh?.geometry as THREE.BufferGeometry | undefined)?.dispose();
    planeMesh = null;
    material = null;
    texture = null;
    texData = null;
    camera = null;
  },
};
