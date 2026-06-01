// Factory for camera-reactive Particle Field variants.
// Matches the visual of the original "Particle Field" (particles.ts).
// Camera motion drives point size and flow speed; a camera-facing selector
// lets the user switch between rear/external and front cameras.

import * as THREE from "three";
import type { Pattern, PatternContext } from "./patterns/types";
import { MotionCamera, showMotionOverlay } from "./motionDetector";

const COUNT = 50000;
const FACING_KEY   = 'pp:camera-facing';
const CAMERA_ON_KEY = 'pp:camera-on';

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
  let baseSize    = 2.0;
  let baseSpeed   = 0.2;
  let sensitivity = 10;      // 0–100; 10 = old default feel; exponential curve
  let colorRange  = 1.0;
  let saturation  = 0.6;
  let cameraEnabled = localStorage.getItem(CAMERA_ON_KEY) === '1';
  let deviceIndex   = parseInt(localStorage.getItem(FACING_KEY) ?? '0');

  // ── Live effective values (base + motion boost) ──────────────────────────
  let effectiveSize    = baseSize;
  let effectiveSpeed   = baseSpeed;
  let motionDisplay    = 0;   // smoothedMotion × 100, read-only display slider

  // ── Internal state ───────────────────────────────────────────────────────
  let accTime = 0;
  let smoothedMotion = 0;

  // Camera device list — populated after permission granted
  let cameraDevices: MediaDeviceInfo[] = [];
  const cameraNames = () => cameraDevices.length > 0
    ? cameraDevices.map((d) => d.label || `Camera ${cameraDevices.indexOf(d) + 1}`)
    : ['Rear / External', 'Front'];

  let points:  THREE.Points | null = null;
  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let motionCamera: MotionCamera | null = null;
  let detector: MotionDetector | null = null;
  let canvasRef: HTMLCanvasElement | null = null;
  let overlay: HTMLDivElement | null = null;

  async function refreshDeviceList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Keep all videoinput devices; filter out empty-label entries only if labelled ones exist
      const all = devices.filter((d) => d.kind === 'videoinput');
      const labelled = all.filter((d) => d.label);
      cameraDevices = labelled.length > 0 ? labelled : all;
    } catch { /* ignore */ }
  }

  const onDeviceChange = () => { refreshDeviceList(); };

  function startCamera() {
    motionCamera?.dispose();
    motionCamera = null;
    if (!canvasRef) return;
    const device = cameraDevices[deviceIndex];
    const constraints: MediaStreamConstraints = {
      video: device
        ? { deviceId: { exact: device.deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: false,
    };
    overlay = showMotionOverlay(canvasRef, "Requesting camera…");
    MotionCamera.createWithConstraints(canvasRef, constraints).then(async (cam) => {
      overlay?.remove();
      overlay = null;
      motionCamera = cam ?? null;
      if (cam) {
        await refreshDeviceList();  // labels are available after getUserMedia
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      }
    });
  }

  function enableCamera(on: boolean) {
    cameraEnabled = on;
    localStorage.setItem(CAMERA_ON_KEY, on ? '1' : '0');
    if (on) {
      startCamera();
    } else {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      motionCamera?.dispose();
      motionCamera = null;
      smoothedMotion = 0;
      motionDisplay = 0;
      overlay?.remove();
      overlay = null;
    }
  }

  return {
    id,
    name,

    controls: [
      {
        label: "Point Size",
        type: "range", min: 0.3, max: 20.0, step: 0.1,
        get: () => effectiveSize,
        set: (v) => { baseSize = v; },
      },
      {
        label: "Flow Speed",
        type: "range", min: 0.05, max: 5.0, step: 0.05,
        get: () => effectiveSpeed,
        set: (v) => { baseSpeed = v; },
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
      // ── Motion Detection Camera group ─────────────────────────────────────
      {
        label: "Motion Detection Camera",
        type: "section",
        get: () => cameraEnabled,
        set: (v) => enableCamera(v),
      },
      {
        label: "Motion Sensitivity",
        type: "range", min: 0, max: 100, step: 1,
        disabled: () => !cameraEnabled,
        get: () => sensitivity,
        set: (v) => { sensitivity = v; },
      },
      {
        label: "Motion Level",
        type: "range", min: 0, max: 100, step: 1,
        readonly: true,
        disabled: () => !cameraEnabled,
        get: () => motionDisplay,
        set: () => {},
      },
      {
        label: "Camera",
        type: "select",
        options: cameraNames,
        disabled: () => !cameraEnabled,
        get: () => deviceIndex,
        set: (v) => {
          deviceIndex = v;
          localStorage.setItem(FACING_KEY, String(v));
          if (cameraEnabled) startCamera();
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

      if (cameraEnabled) startCamera();
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
      // Exponential curve: sensitivity=10 ≈ old default; 100 is 6× stronger than old 100.
      motionDisplay  = Math.round(smoothedMotion * 100);
      const boost    = sensitivity > 0
        ? smoothedMotion * Math.pow(sensitivity / 10, 1.4) * 0.5
        : 0;
      effectiveSize  = baseSize  + boost * 8.0;
      effectiveSpeed = baseSpeed + boost * 1.6;

      // ── Accumulate time at effective speed — no phase jump on speed change ──
      accTime += dt * effectiveSpeed;

      material.uniforms.uTime.value       = accTime;
      material.uniforms.uSize.value       = effectiveSize;
      material.uniforms.uColorRange.value = colorRange;
      material.uniforms.uSaturation.value = saturation;
    },

    resize() {},

    dispose() {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
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
