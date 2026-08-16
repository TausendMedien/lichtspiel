import * as THREE from "three";
import type { Pattern, PatternContext } from "./types";
import { cameraState } from "../globalCameraSettings.svelte";
import { colorC2 } from "../colorC2.svelte";
import { loadColorStops, RAMP_GLSL } from "../palette";
import { createHeatField, HEAT_DISPLACE_GLSL, pushActive, heatOrPushActive, type HeatField } from "../heatField";

// Volcano — an Etna-style paroxysm. Each particle's whole life is a closed-form
// trajectory (launch → ballistic flight → impact on the cone → sliding downhill,
// or, for the ash fraction, a buoyant rise) evaluated twice per frame in the
// vertex shader, at "now" and a little earlier along the same path — the gap
// between the two samples becomes a screen-space capsule (same fat-line trick as
// Gravity Lines), so the streak is a true motion-blur of the real trajectory, not
// a fake trail buffer. Nothing is integrated on the CPU; a particle's age simply
// loops every LIFE seconds, so the eruption is a continuous, self-recycling
// fountain rather than a one-shot burst.

const MAX_PARTICLES = 30000;
const LIFE = 6.0;             // seconds per particle life cycle
const VENT_Y = 0.75;
const RV = 0.16;              // vent radius
const R_MAX = 3.2;            // flows rest once they reach this radius
const CAM_Z = 6.0;
const HALF_H = CAM_Z * Math.tan((60 * Math.PI) / 360);   // renderer fov is 60°

let particleCount = 16000;
let trail         = 4.0;
let lineWidth     = 3.0;   // pixels
let jetPower      = 1.8;
let spread        = 0.5;   // radians, max angle off vertical
let gravity       = 1.6;
let pulse         = 0.35;
let pulseRate     = 0.35;  // Hz, capped well under flicker territory
let eruptionSpeed = 1.0;   // capped at 2.0 — photosensitivity: speed, not contrast
let coneSlope     = 0.42;
let downhillFlow  = 0.6;
let meander       = 0.5;
let cooling       = 0.6;
let ash           = 0.12;
let wind          = 0.15;
let mountainOn    = true;
let coneGlow      = 0.6;
let rotate        = 0.03;
let lavaColors    = 0.0;

let heatStrength = 0.5;
let heatGain     = 11.0;
let blurRadius   = 4.0;
let mirrorX      = true;

let group:        THREE.Group | null = null;
let mesh:         THREE.Mesh | null = null;
let geometry:     THREE.BufferGeometry | null = null;
let material:     THREE.ShaderMaterial | null = null;
let mountainMesh: THREE.Mesh | null = null;
let mountainGeo:  THREE.ConeGeometry | null = null;
let mountainMat:  THREE.ShaderMaterial | null = null;
let sceneRef:     THREE.Scene | null = null;
let heatField:    HeatField | null = null;
let heatWasOn     = false;
let accTime       = 0;
let vpWidth = 1, vpHeight = 1;

// ─── Shaders ──────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uLineWidth;
  uniform float uTrail;
  uniform float uJet;
  uniform float uSpread;
  uniform float uGravity;
  uniform float uPulse;
  uniform float uPulseRate;
  uniform float uSlope;
  uniform float uFlow;
  uniform float uMeander;
  uniform float uCooling;
  uniform float uAsh;
  uniform float uWind;
  uniform float uHeatActive;
  uniform float uMirrorX;

  attribute vec4  aRand;    // x: phase seed, y: azimuth/meander seed, z: cone-sample, w: speed/ash seed
  attribute float aSide;
  attribute float aAlong;

  varying float vT;
  varying float vAsh;
  varying vec2  vCapsPx;
  varying float vHalfLenPx;

  const float LIFE   = ${LIFE.toFixed(1)};
  const float VENT_Y = ${VENT_Y.toFixed(2)};
  const float RV     = ${RV.toFixed(2)};
  const float R_MAX  = ${R_MAX.toFixed(2)};
  const float ASH_RISE = 0.55;
  const float SLIDE_FRICTION = 0.35;
  const float TAU = 6.28318530718;

  ${HEAT_DISPLACE_GLSL}

  void launch(vec4 rnd, float tL, out float vy, out float vr, out float r0) {
    float phi   = uSpread * sqrt(rnd.z);
    float pulse = 1.0 + uPulse * (pow(0.5 + 0.5 * sin(TAU * uPulseRate * tL), 4.0) - 0.3);
    float v     = uJet * max(pulse, 0.05) * (0.65 + 0.35 * rnd.w);
    vy = v * cos(phi);
    vr = v * sin(phi);
    r0 = RV * sqrt(rnd.z);
  }

  // Magma flight + downhill slide, blended with a buoyant ash rise by isAsh.
  vec3 particlePos(float t, float vy, float vr, float r0, float theta0, vec4 rnd, float isAsh, out float T, out float sizeScale) {
    float g = max(uGravity, 0.01);
    float s = uSlope;
    float A = vy + s * vr;
    float disc = max(A * A + 2.0 * g * s * (RV - r0), 0.0);
    float tHit = (A + sqrt(disc)) / g;

    float rFlight, yFlight;
    if (t < tHit) {
      rFlight = r0 + vr * t;
      yFlight = VENT_Y + vy * t - 0.5 * g * t * t;
    } else {
      float tau  = t - tHit;
      float rHit = r0 + vr * tHit;
      rFlight = min(rHit + vr * SLIDE_FRICTION * tau + 0.5 * uFlow * tau * tau, R_MAX);
      yFlight = VENT_Y - s * (rFlight - RV);
    }
    float thetaFlight = theta0 + sin(rnd.y * 37.0 + rFlight * 3.0) * uMeander * max(rFlight - RV, 0.0) * step(tHit, t);
    float Tflight = exp(-max(t - 0.3, 0.0) * uCooling);

    float rAsh     = r0 * 0.5 + uWind * pow(t, 1.5);
    float yAsh     = VENT_Y + ASH_RISE * pow(t, 0.6);
    float thetaAsh = theta0 + sin(rnd.y * 13.0 + t * 2.0) * 0.4;
    float Tash     = exp(-t * uCooling * 2.0);

    float r     = mix(rFlight, rAsh, isAsh);
    float y     = mix(yFlight, yAsh, isAsh);
    float theta = mix(thetaFlight, thetaAsh, isAsh);
    T = mix(Tflight, Tash, isAsh);
    sizeScale = mix(1.0, 1.0 + t * 0.6, isAsh);

    return vec3(r * cos(theta), y, r * sin(theta));
  }

  void main() {
    float age = fract(aRand.x + uTime / LIFE) * LIFE;
    float tL  = uTime - age;
    float isAsh = step(aRand.w, uAsh);

    float vy, vr, r0;
    launch(aRand, tL, vy, vr, r0);
    float theta0 = aRand.y * TAU;

    float trailBack = mix(uTrail * 0.08, 0.0, isAsh);
    float ageTail = max(age - trailBack, 0.0);

    float Thead, sizeHead, Ttail, sizeTail;
    vec3 posHead = particlePos(age,     vy, vr, r0, theta0, aRand, isAsh, Thead, sizeHead);
    vec3 posTail = particlePos(ageTail, vy, vr, r0, theta0, aRand, isAsh, Ttail, sizeTail);

    vT   = Thead;
    vAsh = isAsh;

    // Heat displacement sampled once at the head, applied to the whole capsule —
    // the flow gets shoved sideways as one piece rather than shearing internally.
    vec3 disp3 = vec3(0.0);
    if (uHeatActive > 0.5) {
      vec4 mv0   = modelViewMatrix * vec4(posHead, 1.0);
      vec4 clip0 = projectionMatrix * mv0;
      if (clip0.w > 0.0) {
        vec2 uv = clip0.xy / clip0.w * 0.5 + 0.5;
        uv.y = 1.0 - uv.y;
        if (uMirrorX > 0.5) uv.x = 1.0 - uv.x;
        vec2 disp = heatDisplace(uv);
        float halfH = max(-mv0.z, 0.1) * tan(radians(30.0));
        disp3 = vec3(disp * halfH, 0.0);
      }
    }
    posHead += disp3;
    posTail += disp3;

    vec4 clipA = projectionMatrix * modelViewMatrix * vec4(posTail, 1.0);
    vec4 clipB = projectionMatrix * modelViewMatrix * vec4(posHead, 1.0);
    float wA = max(clipA.w, 0.001);
    float wB = max(clipB.w, 0.001);

    vec2 halfRes = uResolution * 0.5;
    vec2 pxA = (clipA.xy / wA) * halfRes;
    vec2 pxB = (clipB.xy / wB) * halfRes;
    vec2 pxC = (pxA + pxB) * 0.5;
    vec2 seg = pxB - pxA;
    float lenPx = length(seg);
    vec2 axis = lenPx > 0.0001 ? seg / lenPx : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);

    float R = uLineWidth * 0.5 * sizeHead;
    vHalfLenPx = lenPx * 0.5;
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
  uniform float uLavaColors;

  varying float vT;
  varying float vAsh;
  varying vec2  vCapsPx;
  varying float vHalfLenPx;

  ${RAMP_GLSL}

  vec3 lavaRamp(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 white  = vec3(1.0, 0.95, 0.85);
    vec3 gold   = vec3(1.0, 0.78, 0.25);
    vec3 orange = vec3(1.0, 0.35, 0.05);
    vec3 red    = vec3(0.55, 0.05, 0.02);
    vec3 ember  = vec3(0.10, 0.02, 0.01);
    if (t > 0.85) return mix(gold, white, (t - 0.85) / 0.15);
    if (t > 0.55) return mix(orange, gold, (t - 0.55) / 0.3);
    if (t > 0.2)  return mix(red, orange, (t - 0.2) / 0.35);
    return mix(ember, red, clamp(t / 0.2, 0.0, 1.0));
  }

  void main() {
    float R = uLineWidth * 0.5;
    float d = length(vec2(max(abs(vCapsPx.x) - vHalfLenPx, 0.0), vCapsPx.y));
    float aa = clamp(R * 0.6, 0.5, 2.0);
    float cover = 1.0 - smoothstep(R - aa, R, d);
    if (cover <= 0.001) discard;

    float ph1  = clamp(uColorsV2, 0.0, 1.0);
    float ph2  = clamp(uColorsV2 - 1.0, 0.0, 2.0) * 0.5;
    vec3 flat1 = mix(vec3(1.0), uColors[0], ph1);
    vec3 pal   = mix(flat1, paletteRamp(vT), ph2);
    vec3 col   = mix(pal, lavaRamp(vT), uLavaColors);

    vec3 ashCol = vec3(0.5, 0.47, 0.45) * (0.35 + 0.4 * vT);
    col = mix(col, ashCol, vAsh);

    float bright = mix(0.55 + 0.9 * vT, 0.5, vAsh);
    float alpha  = cover * uOpacity * mix(1.0, 0.45, vAsh);

    gl_FragColor = vec4(col * bright, alpha);
  }
`;

const mountainVertexShader = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const mountainFragmentShader = /* glsl */ `
  uniform float uGlow;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    float fres = pow(1.0 - max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0), 2.5);
    vec3 base = vec3(0.03, 0.02, 0.02);
    vec3 rim  = vec3(1.0, 0.4, 0.1) * uGlow;
    gl_FragColor = vec4(base + rim * fres, 1.0);
  }
`;

// ─── Geometry ─────────────────────────────────────────────────────────────────
// Allocated once at MAX_PARTICLES; Particle Count only moves the draw range.

const randStore = new Float32Array(MAX_PARTICLES * 4);
for (let i = 0; i < MAX_PARTICLES; i++) {
  randStore[i * 4]     = Math.random();
  randStore[i * 4 + 1] = Math.random();
  randStore[i * 4 + 2] = Math.random();
  randStore[i * 4 + 3] = Math.random();
}

function buildGeometry(): THREE.BufferGeometry {
  const rand   = new Float32Array(MAX_PARTICLES * 4 * 4);
  const sides  = new Float32Array(MAX_PARTICLES * 4);
  const alongs = new Float32Array(MAX_PARTICLES * 4);
  const index  = new Uint32Array(MAX_PARTICLES * 6);

  const alongSign = [-1, -1, 1, 1];
  const sideSign  = [-1, 1, -1, 1];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const b = i * 4;
    for (let v = 0; v < 4; v++) {
      const ri = (b + v) * 4;
      rand[ri]     = randStore[i * 4];
      rand[ri + 1] = randStore[i * 4 + 1];
      rand[ri + 2] = randStore[i * 4 + 2];
      rand[ri + 3] = randStore[i * 4 + 3];
      sides[b + v]  = sideSign[v];
      alongs[b + v] = alongSign[v];
    }
    const ii = i * 6;
    index[ii]     = b;     index[ii + 1] = b + 1; index[ii + 2] = b + 2;
    index[ii + 3] = b + 1; index[ii + 4] = b + 3; index[ii + 5] = b + 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("aRand",  new THREE.BufferAttribute(rand, 4));
  geo.setAttribute("aSide",  new THREE.BufferAttribute(sides, 1));
  geo.setAttribute("aAlong", new THREE.BufferAttribute(alongs, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Everything is positioned in the vertex shader — the default bounding sphere
  // would be empty and the mesh would be frustum-culled away.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
  return geo;
}

function layoutMountain() {
  if (!mountainMesh) return;
  const height = coneSlope * R_MAX;
  const apexY  = VENT_Y + coneSlope * RV;
  const baseY  = apexY - height;
  mountainMesh.scale.set(R_MAX, height, R_MAX);
  mountainMesh.position.y = (apexY + baseY) / 2;
}

export const volcano: Pattern = {
  id: "volcano",
  name: "Volcano",
  attribution: "Idea — Loretta",
  heatReactive: true,
  motionControlLabels: ['Jet Power', 'Pulse'],
  audioControlLabels:  ['Jet Power', 'Pulse', 'Heat Strength'],
  colorDefaults: { saturation: 1.0, brightness: 1.3 },

  activate() {
    cameraState.heatEnabled = true;
    cameraState.enabled = true;
  },

  controls: [
    { label: "Particle Count", type: "range", min: 3000, max: MAX_PARTICLES, step: 500, default: 16000, tip: "Number of magma and ash particles. More = denser eruption, heavier on GPU.", get: () => particleCount, set: v => { particleCount = Math.round(v); geometry?.setDrawRange(0, particleCount * 6); } },
    { label: "Trail",          type: "range", min: 0,    max: 10,  step: 0.5,  default: 4,    tip: "Streak length behind each particle. 0 = round embers instead of streaks.", get: () => trail,         set: v => { trail = v; } },
    { label: "Streak Width",   type: "range", min: 1,    max: 8,   step: 0.5,  default: 3,    tip: "Thickness of each streak, in pixels.",                                   get: () => lineWidth,     set: v => { lineWidth = v; } },
    { label: "Jet Power",      type: "range", min: 0.5,  max: 4,   step: 0.1,  default: 1.8,  tip: "Launch speed out of the vent.",                                          get: () => jetPower,      set: v => { jetPower = v; } },
    { label: "Spread",         type: "range", min: 0,    max: 1.2, step: 0.02, default: 0.5,  tip: "Cone angle of the jet — 0 = a narrow vertical fountain, higher = a wide fan.", get: () => spread,       set: v => { spread = v; } },
    { label: "Gravity",        type: "range", min: 0.5,  max: 4,   step: 0.1,  default: 1.6,  tip: "How hard trajectories arc back down.",                                   get: () => gravity,       set: v => { gravity = v; } },
    { label: "Pulse",          type: "range", min: 0,    max: 1,   step: 0.02, default: 0.35, tip: "How strongly the eruption surges and eases, like a Strombolian burst.",  get: () => pulse,         set: v => { pulse = v; } },
    { label: "Pulse Rate",     type: "range", min: 0.05, max: 1.2, step: 0.05, default: 0.35, tip: "Speed of the surge cycle, in hertz.",                                    get: () => pulseRate,     set: v => { pulseRate = v; } },
    { label: "Eruption Speed", type: "range", min: 0,    max: 2,   step: 0.05, default: 1,    tip: "Overall time scale of the eruption.",                                    get: () => eruptionSpeed, set: v => { eruptionSpeed = v; } },
    { label: "Cone Slope",     type: "range", min: 0.15, max: 0.7, step: 0.01, default: 0.42, tip: "Steepness of the volcano's flank.",                                      get: () => coneSlope,     set: v => { coneSlope = v; } },
    { label: "Downhill Flow",  type: "range", min: 0,    max: 2,   step: 0.05, default: 0.6,  tip: "How much landed magma keeps accelerating down the slope.",              get: () => downhillFlow,  set: v => { downhillFlow = v; } },
    { label: "Meander",        type: "range", min: 0,    max: 1.5, step: 0.02, default: 0.5,  tip: "How much the flows braid into channels instead of running straight down.", get: () => meander,      set: v => { meander = v; } },
    { label: "Cooling",        type: "range", min: 0.15, max: 2,   step: 0.05, default: 0.6,  tip: "How fast magma dims from white-hot to dark as it ages.",                get: () => cooling,       set: v => { cooling = v; } },
    { label: "Ash",            type: "range", min: 0,    max: 0.6, step: 0.01, default: 0.12, tip: "Fraction of particles that rise as a buoyant ash plume instead of falling as magma.", get: () => ash, set: v => { ash = v; } },
    { label: "Wind",           type: "range", min: -1,   max: 1,   step: 0.02, default: 0.15, tip: "Sideways drift on the ash plume.",                                       get: () => wind,          set: v => { wind = v; } },
    { label: "", type: "separator" },
    { label: "Mountain",   type: "toggle", tip: "Show the cone as a solid occluder.", get: () => mountainOn, set: v => { mountainOn = v; if (mountainMesh) mountainMesh.visible = v; } },
    { label: "Cone Glow",  type: "range", min: 0, max: 2, step: 0.05, default: 0.6, tip: "Warm rim light on the volcano's silhouette.", get: () => coneGlow, set: v => { coneGlow = v; } },
    { label: "Rotate",     type: "range", min: -0.3, max: 0.3, step: 0.01, default: 0.03, tip: "Slow orbit of the whole scene around the vent.", get: () => rotate, set: v => { rotate = v; } },
    { label: "Lava Colors", type: "range", min: 0, max: 1, step: 0.05, default: 0, tip: "Crossfade from the app palette to a built-in white-hot → ember incandescent ramp.", get: () => lavaColors, set: v => { lavaColors = v; } },
    { label: "", type: "separator" },
    { label: "Colors v2",     type: "range", min: 0,    max: 3,    step: 0.1,  default: 3,   interactive: 'internal' as const, get: () => colorC2.colorsV2, set: v => { colorC2.colorsV2 = v; } },
    { label: "Heat Strength", type: "range", min: 0,    max: 1.5,  step: 0.05, default: 0.5, interactive: 'heat' as const, tip: "How strongly the heat map shoves the flows aside. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range", min: 4,    max: 20,   step: 0.5,  default: 11,  interactive: 'heat' as const, tip: "Amplify the heat signal — higher = reacts to subtler motion.",    get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Blur Radius",   type: "range", min: 0,    max: 10,   step: 0.1,  default: 4,   interactive: 'heat' as const, tip: "Blur applied to the heat map before it drives the flows.",        get: () => blurRadius,   set: v => { blurRadius = v; } },
  ],

  init(ctx: PatternContext) {
    sceneRef = ctx.scene;
    vpWidth  = ctx.size.width;
    vpHeight = ctx.size.height;
    ctx.camera.position.set(0, 0.35, CAM_Z);
    ctx.camera.lookAt(0, -0.1, 0);

    heatField = createHeatField();
    heatWasOn = false;
    accTime   = 0;

    group = new THREE.Group();

    geometry = buildGeometry();
    geometry.setDrawRange(0, particleCount * 6);

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uResolution:   { value: new THREE.Vector2(vpWidth, vpHeight) },
        uLineWidth:    { value: lineWidth },
        uTrail:        { value: trail },
        uJet:          { value: jetPower },
        uSpread:       { value: spread },
        uGravity:      { value: gravity },
        uPulse:        { value: pulse },
        uPulseRate:    { value: pulseRate },
        uSlope:        { value: coneSlope },
        uFlow:         { value: downhillFlow },
        uMeander:      { value: meander },
        uCooling:      { value: cooling },
        uAsh:          { value: ash },
        uWind:         { value: wind },
        uOpacity:      { value: 1.0 },
        uColorsV2:     { value: colorC2.colorsV2 },
        uColors:       { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },
        uColorCount:   { value: 3.0 },
        uLavaColors:   { value: lavaColors },
        uHeatMap:      { value: heatField.heatTexture },
        uPushField:    { value: heatField.pushTexture },
        uPushMode:     { value: 0 },
        uHeatGain:     { value: heatGain },
        uHeatStrength: { value: 0 },
        uHeatActive:   { value: 0 },
        uMirrorX:      { value: mirrorX ? 1.0 : 0.0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    mountainGeo = new THREE.ConeGeometry(1, 1, 72, 1, false);
    mountainMat = new THREE.ShaderMaterial({
      uniforms: { uGlow: { value: coneGlow } },
      vertexShader: mountainVertexShader,
      fragmentShader: mountainFragmentShader,
    });
    mountainMesh = new THREE.Mesh(mountainGeo, mountainMat);
    mountainMesh.visible = mountainOn;
    layoutMountain();
    group.add(mountainMesh);

    ctx.scene.add(group);
  },

  update(dt: number, _elapsed: number) {
    if (!material || !geometry || !group) return;
    accTime += dt * eruptionSpeed;
    group.rotation.y += dt * rotate;

    const u = material.uniforms;
    u.uTime.value       = accTime;
    u.uLineWidth.value  = lineWidth;
    u.uTrail.value      = trail;
    u.uJet.value        = jetPower;
    u.uSpread.value     = spread;
    u.uGravity.value    = gravity;
    u.uPulse.value      = pulse;
    u.uPulseRate.value  = pulseRate;
    u.uSlope.value      = coneSlope;
    u.uFlow.value       = downhillFlow;
    u.uMeander.value    = meander;
    u.uCooling.value    = cooling;
    u.uAsh.value        = ash;
    u.uWind.value       = wind;
    u.uColorsV2.value   = colorC2.colorsV2;
    u.uLavaColors.value = lavaColors;
    u.uMirrorX.value    = mirrorX ? 1.0 : 0.0;
    u.uColorCount.value = loadColorStops(u.uColors.value as THREE.Vector3[]);

    layoutMountain();
    if (mountainMat) mountainMat.uniforms.uGlow.value = coneGlow;

    // Additive blending blows out at high Particle Count / Streak Width / Trail —
    // estimate coverage from the rough average streak length and ease opacity back.
    const avgLenPx = ((trail * 0.08 * jetPower * 0.5) / (2 * HALF_H)) * vpHeight;
    const coverage = (particleCount * lineWidth * (avgLenPx + lineWidth)) / Math.max(vpWidth * vpHeight, 1);
    u.uOpacity.value = Math.min(1, Math.pow(0.5 / Math.max(coverage, 0.001), 0.7));

    // Heat reactivity must respect the "Heat" toggle — without this gate the pattern
    // keeps responding to heatMap data as long as the camera is running at all.
    if (heatOrPushActive()) {
      u.uHeatActive.value   = 1;
      u.uHeatStrength.value = cameraState.heatEnabled ? heatStrength : 0;
      u.uHeatGain.value     = heatGain;
      u.uPushMode.value     = pushActive() ? 1 : 0;
      heatField?.update(dt, blurRadius, vpWidth / Math.max(vpHeight, 1));
      heatWasOn = true;
    } else {
      u.uHeatActive.value   = 0;
      u.uPushMode.value     = 0;
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
    if (group && sceneRef) sceneRef.remove(group);
    heatField?.dispose();
    geometry?.dispose();
    material?.dispose();
    mountainGeo?.dispose();
    mountainMat?.dispose();
    group        = null;
    mesh         = null;
    geometry     = null;
    material     = null;
    mountainMesh = null;
    mountainGeo  = null;
    mountainMat  = null;
    sceneRef     = null;
    heatField    = null;
    heatWasOn    = false;
    accTime      = 0;
  },
};
