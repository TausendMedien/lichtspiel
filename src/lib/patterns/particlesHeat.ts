import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";
import { createHeatField, HEAT_DISPLACE_GLSL, type HeatField } from "../heatField";

let particleCount = 30000;
let pointSize     = 3.0;
let flowSpeed     = 0.2;
let heatStrength  = 0.5;
let heatGain      = 11.0;
let blurRadius    = 4.0;
let mirrorX       = true;
// Heat Mode: 0 = Attract (instantaneous), 1 = Push Away (persistent, relaxes back)
let heatMode      = 0;
let pushStrength  = 1.2;
let solidity      = 1.0;
let returnSpeed   = 0.35;
let pushSpread    = 0.4;

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
    // Attract mode takes the instantaneous gradient (the CPU blur already extends
    // the signal beyond the raw motion zone, so even distant particles see one);
    // Push Away reads the field with memory, which holds the hole open.
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
    { label: "Push Away",     type: "toggle", interactive: 'heat' as const, tip: "Off: particles follow your motion and snap back the moment you stop. On: your movement shoves them aside and the gap only slowly fills in again. Requires Heat.", get: () => heatMode === 1, set: v => { heatMode = v ? 1 : 0; heatField?.reset(); } },
    { label: "Solidity",      type: "range",  min: 0,    max: 1.5,   step: 0.05, default: 1,     interactive: 'heat' as const, tip: "How solid your body is as it sweeps through. 1 = everything you cover is cleared out to the edge of your silhouette in one pass. 0 = only a soft nudge from your outline. Push Away only.", get: () => solidity,     set: v => { solidity = v; } },
    { label: "Push Strength", type: "range",  min: 0,    max: 3,     step: 0.05, default: 1.2,   interactive: 'heat' as const, tip: "Extra soft shove from your outline, on top of Solidity — it builds up over repeated passes. Push Away only.", get: () => pushStrength, set: v => { pushStrength = v; } },
    { label: "Return Speed",  type: "range",  min: 0.05, max: 2,     step: 0.05, default: 0.35,  interactive: 'heat' as const, tip: "How fast the gap fills back in — lower = it stays open longer. Push Away only.", get: () => returnSpeed,  set: v => { returnSpeed = v; } },
    { label: "Spread",        type: "range",  min: 0,    max: 1,     step: 0.05, default: 0.4,   interactive: 'heat' as const, tip: "How softly the gap's edge melts back — neighbours roll in from the sides. Push Away only.", get: () => pushSpread,   set: v => { pushSpread = v; } },
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
        uHeatMode:     { value: 0 },
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

    // Heat reactivity must respect the "Heat" toggle — without this gate the pattern
    // keeps responding to heatMap data as long as the camera is running at all (e.g.
    // via Motion being on), even while Heat is explicitly switched off.
    if (cameraState.heatEnabled) {
      material.uniforms.uHeatStrength.value = heatStrength;
      material.uniforms.uHeatGain.value     = heatGain;
      material.uniforms.uHeatMode.value     = heatMode;
      heatField?.update(dt, {
        blurRadius,
        pushStrength: heatMode === 1 ? pushStrength : 0,
        solidity:     heatMode === 1 ? solidity : 0,
        returnSpeed,
        spread: pushSpread,
        aspect: currentAspect,
        heatGain,
        heatStrength,
      });
      heatWasOn = true;
    } else {
      // Push Away reads the field directly, so zeroing gain/strength isn't enough
      // to switch it off — fall back to Attract, which they do gate.
      material.uniforms.uHeatMode.value     = 0;
      material.uniforms.uHeatStrength.value = 0;
      material.uniforms.uHeatGain.value     = 0;
      // Drop any gap still open when Heat is switched off, so re-enabling it later
      // doesn't bring a stale hole back with it.
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
