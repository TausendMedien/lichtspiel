// Factory for camera-reactive Particle Field variants.
// Matches the visual of the original "Particle Field" (particles.ts).
// Camera motion drives point size and flow speed; a camera-facing selector
// lets the user switch between rear/external and front cameras.

import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { MotionCamera, showMotionOverlay } from "./motionDetector";

const COUNT = 50000;
const FACING_KEY = 'pp:camera-facing';
const FACING_MODES = ['environment', 'user'] as const;

// ─── Shaders ──────────────────────────────────────────────────────────────────
// uTime is a JS-integrated accumulated time (dt * effectiveSpeed summed each
// frame). The shader never sees a speed uniform — changing speed therefore
// never jumps the wave phase.

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vSeed;

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    vec3 disp = flow(p * 0.5 + aSeed, uTime) * 0.6;
    p += disp;
    float ang = uTime * 0.05 + aSeed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uColorRange;
  uniform float uSaturation;
  varying float vSeed;

  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d);
    float hue = 0.5 + fract(vSeed * uColorRange) * 0.33;
    vec3 col = hsl2rgb(hue, 1.0, 0.6);
    float gray = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(gray), col, uSaturation);
    gl_FragColor = vec4(col, alpha);
  }
`;

// ─── Public interface ─────────────────────────────────────────────────────────

export interface MotionDetector {
  update(diff: Float32Array): number;
}

export function makeParticleFieldPattern(
  id: string,
  name: string,
  createDetector: () => MotionDetector,
): Pattern {

  // ── User-controlled base values ──────────────────────────────────────────
  let baseSize      = 2.0;
  let baseSpeed     = 0.2;
  let motionStrength = 0.5;
  let colorRange    = 1.0;
  let saturation    = 0.6;
  let facingIndex   = parseInt(localStorage.getItem(FACING_KEY) ?? '0');

  // ── Live effective values (base + motion boost) ──────────────────────────
  // get() returns these so sliders reflect current motion in real time.
  let effectiveSize  = baseSize;
  let effectiveSpeed = baseSpeed;

  // ── Internal state ───────────────────────────────────────────────────────
  let accTime = 0;          // accumulated time integrated at effectiveSpeed
  let smoothedMotion = 0;

  let points:  THREE.Points | null = null;
  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let motionCamera: MotionCamera | null = null;
  let detector: MotionDetector | null = null;
  let canvasRef: HTMLCanvasElement | null = null;
  let overlay: HTMLDivElement | null = null;

  function startCamera(facingMode: typeof FACING_MODES[number]) {
    motionCamera?.dispose();
    motionCamera = null;
    if (!canvasRef) return;
    MotionCamera.create(canvasRef, facingMode).then((cam) => {
      overlay?.remove();
      overlay = null;
      motionCamera = cam ?? null;
    });
  }

  return {
    id,
    name,

    controls: [
      {
        label: "Point Size",
        type: "range", min: 0.3, max: 12.0, step: 0.1,
        get: () => effectiveSize,          // live: moves with motion
        set: (v) => { baseSize = v; },
      },
      {
        label: "Flow Speed",
        type: "range", min: 0.05, max: 3.0, step: 0.05,
        get: () => effectiveSpeed,         // live: moves with motion
        set: (v) => { baseSpeed = v; },
      },
      {
        label: "Motion Strength",
        type: "range", min: 0.0, max: 2.0, step: 0.05,
        get: () => motionStrength,
        set: (v) => { motionStrength = v; },
      },
      {
        label: "Colors",
        type: "range", min: 0.0, max: 1.0, step: 0.05,
        get: () => colorRange,
        set: (v) => { colorRange = v; },
      },
      {
        label: "Saturation",
        type: "range", min: 0.0, max: 1.0, step: 0.05,
        get: () => saturation,
        set: (v) => { saturation = v; },
      },
      {
        label: "Camera",
        type: "select",
        options: ["Rear / External", "Front"],
        get: () => facingIndex,
        set: (v) => {
          facingIndex = v;
          localStorage.setItem(FACING_KEY, String(v));
          startCamera(FACING_MODES[v]);
        },
      },
    ],

    init(ctx: PatternContext) {
      ctx.camera.position.set(0, 0, 4);
      ctx.camera.lookAt(0, 0, 0);

      const positions = new Float32Array(COUNT * 3);
      const seeds     = new Float32Array(COUNT);
      for (let i = 0; i < COUNT; i++) {
        const r     = Math.cbrt(Math.random()) * 4;
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
        seeds[i] = Math.random();
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("aSeed",    new THREE.BufferAttribute(seeds, 1));

      material = new THREE.ShaderMaterial({
        uniforms: {
          uTime:       { value: 0 },
          uSize:       { value: baseSize },
          uColorRange: { value: colorRange },
          uSaturation: { value: saturation },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      points = new THREE.Points(geometry, material);
      ctx.scene.add(points);

      detector = createDetector();
      smoothedMotion = 0;
      accTime = 0;
      effectiveSize  = baseSize;
      effectiveSpeed = baseSpeed;
      canvasRef = ctx.renderer.domElement;

      overlay = showMotionOverlay(canvasRef, "Requesting camera…");
      startCamera(FACING_MODES[facingIndex]);
    },

    update(dt: number, _elapsed: number) {
      if (!material) return;

      // ── Motion detection ─────────────────────────────────────────────────
      if (motionCamera && detector) {
        const diff = motionCamera.tick();
        if (diff) {
          const raw = Math.min(detector.update(diff), 1.0);
          // Asymmetric smoothing: faster attack, slower decay
          smoothedMotion = raw > smoothedMotion
            ? 0.90 * smoothedMotion + 0.10 * raw
            : 0.97 * smoothedMotion + 0.03 * raw;
        }
      }

      // ── Effective values (base + motion boost) ───────────────────────────
      const boost    = smoothedMotion * motionStrength;
      effectiveSize  = baseSize  + boost * 4.0;
      effectiveSpeed = baseSpeed + boost * 0.8;

      // ── Accumulate time at effective speed — no phase jump on speed change ──
      accTime += dt * effectiveSpeed;

      material.uniforms.uTime.value       = accTime;
      material.uniforms.uSize.value       = effectiveSize;
      material.uniforms.uColorRange.value = colorRange;
      material.uniforms.uSaturation.value = saturation;
    },

    resize() {},

    dispose() {
      motionCamera?.dispose();
      motionCamera = null;
      detector = null;
      geometry?.dispose();
      material?.dispose();
      points    = null;
      geometry  = null;
      material  = null;
      canvasRef = null;
      overlay?.remove();
      overlay = null;
      smoothedMotion = 0;
      accTime = 0;
    },
  };
}
