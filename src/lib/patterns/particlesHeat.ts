import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";
import { createHeatField, HEAT_DISPLACE_GLSL, pushActive, heatOrPushActive, type HeatField } from "../heatField";

let particleCount = 30000;
let pointSize     = 3.0;
let flowSpeed     = 0.2;
let heatStrength  = 0.5;
let heatGain      = 11.0;
let blurRadius    = 4.0;
let mirrorX       = true;

const MAX_PARTICLES = 50000;

let points:      THREE.Points | null = null;
let geometry:    THREE.BufferGeometry | null = null;
let material:    THREE.ShaderMaterial | null = null;
let heatField:   HeatField | null = null;
let heatWasOn    = false;
let accTime      = 0;
let currentAspect = 1;

const vertexShader = /* glsl */ `
  uniform float     uTime;
  uniform float     uSize;
  uniform float     uMirrorX;
  attribute float   aSeed;
  varying float     vSeed;

  ${HEAT_DISPLACE_GLSL}

  vec3 flow(vec3 p, float t) {
    float a = sin(p.y * 0.7 + t * 0.4) + cos(p.z * 0.6 - t * 0.3);
    float b = sin(p.z * 0.5 - t * 0.35) + cos(p.x * 0.7 + t * 0.25);
    float c = sin(p.x * 0.6 + t * 0.5) + cos(p.y * 0.5 - t * 0.4);
    return vec3(a, b, c);
  }

  void main() {
    vSeed = aSeed;
    vec3 p = position;
    p += flow(p * 0.5 + aSeed, uTime) * 0.6;
    float ang = uTime * 0.05 + aSeed * 0.0002;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;

    // Displace by the heat map at this particle's own screen position.
    // Heat takes the instantaneous gradient (the CPU blur already extends the
    // signal beyond the raw motion zone, so even distant particles see one);
    // Push reads the field with memory, which holds the cleared area open.
    vec4 mv0   = modelViewMatrix * vec4(p, 1.0);
    vec4 clip0 = projectionMatrix * mv0;
    if (clip0.w > 0.0) {
      vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
      uv.y = 1.0 - uv.y;
      if (uMirrorX > 0.5) uv.x = 1.0 - uv.x;

      vec2 disp = heatDisplace(uv);

      float depth = max(-mv0.z, 0.1);
      float halfH = depth * tan(radians(30.0));
      p.x += disp.x * halfH;
      p.y += disp.y * halfH;
    }

    vec4 mv      = modelViewMatrix * vec4(p, 1.0);
    gl_Position  = projectionMatrix * mv;
    gl_PointSize = uSize * (8.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uColorRange2;
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

    float sat2    = clamp(uColorRange2, 0.0, 1.0);
    float spread2 = max(0.0, uColorRange2 - 1.0) / 2.0;
    float hue     = 0.5 + fract(vSeed * spread2) * 0.33;
    vec3 col      = hsl2rgb(hue, sat2, 0.6);

    gl_FragColor = vec4(col, alpha);
  }
`;

// Persistent position/seed store — same strategy as particlesBody.
let posStore  = new Float32Array(MAX_PARTICLES * 3);
let seedStore = new Float32Array(MAX_PARTICLES);
let storedCount = 0;

function ensureStore(n: number) {
  while (storedCount < n) {
    const i     = storedCount;
    const r     = Math.cbrt(Math.random()) * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    posStore[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    posStore[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    posStore[i * 3 + 2] = r * Math.cos(phi);
    seedStore[i] = Math.random();
    storedCount++;
  }
}

function buildGeometry(): THREE.BufferGeometry {
  ensureStore(MAX_PARTICLES);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(posStore, 3));
  geo.setAttribute("aSeed",    new THREE.BufferAttribute(seedStore, 1));
  geo.setDrawRange(0, particleCount);
  return geo;
}

export const particlesHeat: Pattern = {
  id: "particlesHeat",
  name: "Particle Field",
  heatReactive: true,
  motionControlLabels: ['Point Size', 'Flow Speed'],
  audioControlLabels:  ['Point Size', 'Flow Speed', 'Heat Strength'],

  activate() {
    cameraState.heatEnabled = true;
    cameraState.enabled = true;
  },

  controls: [
    { label: "Point Size",    type: "range",  min: 1.0,  max: 6.0,   step: 0.1,  default: 3,     tip: "Radius of each particle dot.",                                              get: () => pointSize,    set: v => { pointSize = v; } },
    { label: "Flow Speed",    type: "range",  min: 0.0,  max: 3.0,   step: 0.1,  default: 0.2,   tip: "How fast particles drift through the scene.",                               get: () => flowSpeed,    set: v => { flowSpeed = v; } },
    { label: "Heat Strength", type: "range",  min: 0.35, max: 1.0,   step: 0.01, default: 0.5,   interactive: 'heat' as const, tip: "How strongly the heat map pushes particles. Requires Heat.",       get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range",  min: 4.0,  max: 20.0,  step: 0.5,  default: 11,    interactive: 'heat' as const, tip: "Amplify the heat signal — higher = reacts to subtler motion.",    get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Blur Radius",   type: "range",  min: 0,    max: 10,    step: 0.1,  default: 4,     interactive: 'heat' as const, tip: "Blur applied to the heat map before driving particles.",          get: () => blurRadius,   set: v => { blurRadius = v; } },
    { label: "Point Count",   type: "range",  min: 5000, max: 50000, step: 1000, default: 30000,  tip: "Number of particles. More = denser cloud, heavier on GPU.",                 get: () => particleCount, set: v => { particleCount = v; geometry?.setDrawRange(0, v); } },
  ],

  init(ctx: PatternContext) {
    ctx.camera.position.set(0, 0, 4);
    ctx.camera.lookAt(0, 0, 0);
    currentAspect = ctx.size.width / Math.max(ctx.size.height, 1);

    heatField = createHeatField();
    heatWasOn = false;

    geometry = buildGeometry();

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uSize:         { value: pointSize },
        uColorRange2:  { value: colorC2.colorsV2 },
        uHeatMap:      { value: heatField.heatTexture },
        uPushField:    { value: heatField.pushTexture },
        uPushMode:     { value: 0 },
        uHeatStrength: { value: heatStrength },
        uHeatGain:     { value: heatGain },
        uMirrorX:      { value: mirrorX ? 1.0 : 0.0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    points = new THREE.Points(geometry, material);
    ctx.scene.add(points);
  },

  update(dt: number, _elapsed: number) {
    if (!material) return;
    accTime += dt * flowSpeed;

    material.uniforms.uTime.value         = accTime;
    material.uniforms.uSize.value         = pointSize;
    material.uniforms.uColorRange2.value  = colorC2.colorsV2;
    material.uniforms.uMirrorX.value      = mirrorX ? 1.0 : 0.0;

    // Heat and Push are separate sensors and must each respect their own toggle —
    // without this gate the pattern keeps reacting as long as the camera runs at
    // all (e.g. via Motion), even with both explicitly switched off.
    const push = pushActive();
    if (heatOrPushActive()) {
      material.uniforms.uPushMode.value     = push ? 1 : 0;
      material.uniforms.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
      material.uniforms.uHeatGain.value     = heatGain;
      heatField?.update(dt, blurRadius, currentAspect);
      heatWasOn = true;
    } else {
      material.uniforms.uPushMode.value     = 0;
      material.uniforms.uHeatStrength.value = 0;
      material.uniforms.uHeatGain.value     = 0;
      // Drop any gap still open when the sensors go off, so switching back on later
      // doesn't bring a stale hole with it.
      if (heatWasOn) { heatField?.reset(); heatWasOn = false; }
    }
  },

  resize(w: number, h: number) {
    currentAspect = w / Math.max(h, 1);
  },

  dispose() {
    heatField?.dispose();
    geometry?.dispose();
    material?.dispose();
    points      = null;
    geometry    = null;
    material    = null;
    heatField   = null;
    heatWasOn   = false;
    accTime     = 0;
    storedCount = 0;
  },
};
