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
//
// Launch time (vy, vr, r0) and the flight→slide transition (tHit, rHit) are solved
// once per particle in solveLaunch(); both the flight and slide branches of
// particlePos() are built to agree exactly at t = tHit (same r, same y, same theta),
// so a streak sampled across that boundary never tears.

const MAX_PARTICLES = 30000;
const LIFE = 6.0;             // seconds per particle life cycle
const RV = 0.16;              // vent radius
const R_MAX = 3.2;            // roughly where flows come to rest
const CAM_Z = 6.0;
const LOOKAT_Y = -0.1;
const HALF_H = CAM_Z * Math.tan((60 * Math.PI) / 360);   // renderer fov is 60°

let particleCount = 24000;
let trail         = 1.0;
let lineWidth     = 3.5;   // pixels
let jetPower      = 3.3;
let spread        = 0.54;  // radians, max angle off vertical
let gravity       = 1.8;
let pulse         = 0.9;
let pulseRate     = 0.5;   // Hz, capped well under flicker territory
let eruptionSpeed = 0.15;  // capped at 2.0 — photosensitivity: speed, not contrast
let coneSlope     = 0.62;
let downhillFlow  = 0.12;
let meander       = 0.18;
let cooling       = 0.55;
let ash           = 0.48;
let wind          = 0.66;
let craterHeight  = -0.39; // fraction of half-frame-height above/below screen centre
let mountainOn    = true;
let coneGlow      = 0.3;
let rotate        = 0.02;
let lavaColors    = 1.0;

let heatStrength = 0.8;
let heatGain     = 14.0;
let blurRadius   = 3.0;
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

function currentVentY(): number {
  return LOOKAT_Y + craterHeight * HALF_H;
}

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
  uniform float uVentY;
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
  const float RV     = ${RV.toFixed(2)};
  const float R_MAX  = ${R_MAX.toFixed(2)};
  const float ASH_RISE = 0.55;
  const float TAU = 6.28318530718;

  ${HEAT_DISPLACE_GLSL}

  // Launch velocity and the flight→slide transition, solved once per particle.
  // The transition time is where the ballistic arc y = uVentY + vy*t - 0.5*g*t^2
  // meets the cone surface y = uVentY - s*(r - RV); solving that intersection for t
  // gives the quadratic below (note the MINUS inside the discriminant — the plus
  // gives a spurious early root where the arc crosses the cone surface's own
  // upward extension through the crater bowl, landing the particle almost
  // instantly instead of after a real arc).
  void solveLaunch(vec4 rnd, float tL, out float vy, out float vr, out float r0, out float tHit, out float rHit) {
    float phi   = uSpread * sqrt(rnd.z);
    float pulse = 1.0 + uPulse * (pow(0.5 + 0.5 * sin(TAU * uPulseRate * tL), 4.0) - 0.3);
    float v     = uJet * max(pulse, 0.05) * (0.65 + 0.35 * rnd.w);
    vy = v * cos(phi);
    vr = v * sin(phi);
    r0 = RV * sqrt(rnd.z);

    float g = max(uGravity, 0.01);
    float s = uSlope;
    float A = vy + s * vr;
    float disc = max(A * A - 2.0 * g * s * (RV - r0), 0.0);
    tHit = (A + sqrt(disc)) / g;
    rHit = r0 + vr * tHit;
  }

  // Magma flight + downhill slide, blended with a buoyant ash rise by isAsh.
  // The slide branch's r and theta are written as offsets from (rHit, theta0) that
  // are exactly zero at tau = 0, so it always meets the flight branch continuously.
  vec3 particlePos(float t, float vy, float vr, float r0, float tHit, float rHit, float theta0, vec4 rnd, float isAsh, out float T, out float sizeScale) {
    float g = max(uGravity, 0.01);
    float s = uSlope;

    float rFlight, yFlight, thetaFlight;
    if (t < tHit) {
      rFlight     = r0 + vr * t;
      yFlight     = uVentY + vy * t - 0.5 * g * t * t;
      thetaFlight = theta0;
    } else {
      float tau = t - tHit;
      // A brief post-impact skid that decays hard within about a fifth of a second —
      // kept small and fast-damped so Jet Power (which sets vr) barely reaches the
      // slide at all. The sustained downhill creep is uFlow alone, at its own steady
      // pace, so raising Jet Power no longer erases the slow lava flow — it only
      // changes how far the fountain throws material before it lands and joins it.
      float splash = vr * 0.06 * exp(-tau * 5.0);
      float wobble  = sin(uTime * 0.12 + rnd.y * 53.0) * uMeander * 0.12;
      rFlight     = min(rHit + splash + uFlow * tau, R_MAX * 1.2);
      yFlight     = uVentY - s * (rFlight - RV);
      thetaFlight = theta0 + sin(rnd.y * 37.0 + rFlight * 3.0) * uMeander * (rFlight - rHit) + wobble;
    }
    float Tflight = exp(-max(t - 0.3, 0.0) * uCooling);

    float rAsh     = r0 * 0.5 + uWind * pow(t, 1.5);
    float yAsh     = uVentY + ASH_RISE * pow(t, 0.6);
    float thetaAsh = theta0 + sin(rnd.y * 13.0 + t * 2.0) * 0.4;
    float Tash     = exp(-t * uCooling * 2.0);

    float r     = mix(rFlight, rAsh, isAsh);
    float y     = mix(yFlight, yAsh, isAsh);
    float theta = mix(thetaFlight, thetaAsh, isAsh);
    T = mix(Tflight, Tash, isAsh);

    // Freshly landed magma stays prominent — a touch thicker than the airborne
    // streak, reading as an active flow — for a couple of seconds, then shrinks
    // into a small dark grain once it has actually come to rest. Driven by time
    // since landing, not temperature, so a flow stays visible while it is still
    // visibly creeping even after it has mostly cooled.
    float landed  = step(tHit, t);
    float settle  = smoothstep(1.5, 5.0, t - tHit) * landed;
    float flowSize = mix(1.15, 0.5, settle);
    sizeScale = mix(flowSize, 1.0 + t * 0.6, isAsh);

    return vec3(r * cos(theta), y, r * sin(theta));
  }

  void main() {
    float age = fract(aRand.x + uTime / LIFE) * LIFE;
    float tL  = uTime - age;
    float isAsh = step(aRand.w, uAsh);

    float vy, vr, r0, tHit, rHit;
    solveLaunch(aRand, tL, vy, vr, r0, tHit, rHit);
    float theta0 = aRand.y * TAU;

    // A freshly landed flow gets a LONGER streak than the airborne jet — that's
    // what reads as a continuous lava stream rather than a spray of dashes. It
    // only shrinks to a short speck once it has actually stopped creeping,
    // driven by time since landing rather than temperature.
    float landedNow   = step(tHit, age);
    float settleNow   = smoothstep(1.5, 5.0, age - tHit) * landedNow;
    float trailShrink = mix(1.3, 0.3, settleNow);
    float trailBack   = mix(uTrail * 0.08 * trailShrink, 0.0, isAsh);
    float ageTail      = max(age - trailBack, 0.0);

    float Thead, sizeHead, Ttail, sizeTail;
    vec3 posHead = particlePos(age,     vy, vr, r0, tHit, rHit, theta0, aRand, isAsh, Thead, sizeHead);
    vec3 posTail = particlePos(ageTail, vy, vr, r0, tHit, rHit, theta0, aRand, isAsh, Ttail, sizeTail);

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

    // Kept deliberately dim relative to a plain multiply, then soft-tonemapped —
    // additive blending stacks dozens of overlapping streaks right at the vent,
    // and without this it blows straight to a flat white blob.
    float bright  = mix(0.32 + 0.55 * vT, 0.32, vAsh);
    vec3  outCol  = col * bright;
    outCol = outCol / (1.0 + outCol * 0.5);
    float alpha  = cover * uOpacity * mix(1.0, 0.45, vAsh);

    gl_FragColor = vec4(outCol, alpha);
  }
`;

const mountainVertexShader = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  float bumpFn(float angle, float taper) {
    return (sin(angle * 3.0 + 1.3) * 0.09
          + sin(angle * 7.0 - 0.6) * 0.05
          + sin(angle * 13.0 + 2.7) * 0.03
          + sin(angle * 23.0 + 4.1) * 0.016) * taper;
  }

  void main() {
    // Break up the perfect circular cross-section with several overlaid angular
    // waves so the silhouette AND the shading read as an eroded, organic ridge
    // line rather than a geometric cone — rougher toward the base (scree and
    // gullies), smoothing out near the apex so the tip stays a clean point.
    vec3 pos = position;
    float angle = atan(pos.z, pos.x);
    float taper = smoothstep(-0.5, 0.3, pos.y);
    float radius = length(pos.xz);
    pos.xz *= 1.0 + bumpFn(angle, taper);
    vLocalPos = pos;

    // Tilt the normal by the bump field's angular slope, so the ridges actually
    // shade like ridges instead of a smooth cone with a wobbly outline.
    float deps = 0.015;
    float dB = (bumpFn(angle + deps, taper) - bumpFn(angle - deps, taper)) / (2.0 * deps);
    vec3 tangent = vec3(-sin(angle), 0.0, cos(angle));
    vec3 bumpedNormal = normalize(normal - tangent * dB * radius * 0.5);

    vNormalV = normalize(normalMatrix * bumpedNormal);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const mountainFragmentShader = /* glsl */ `
  uniform float uGlow;
  uniform vec2  uResolution;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;

  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Blotchy rock-texture mottling — without it the rim glow traces a perfectly
    // uniform ring regardless of the underlying bumpy mesh.
    float angle = atan(vLocalPos.z, vLocalPos.x);
    vec2 p = vec2(angle * 3.0, vLocalPos.y * 2.5);
    float mottle = noise2(p * 3.0) * 0.6 + noise2(p * 9.0) * 0.3 + noise2(p * 21.0) * 0.15;

    float fres = pow(1.0 - max(dot(normalize(vNormalV), normalize(vViewDir)), 0.0), 2.0 + mottle * 1.4);
    vec3 base = vec3(0.025, 0.018, 0.02) * (0.55 + 0.7 * mottle);
    vec3 rim  = vec3(1.0, 0.4, 0.1) * uGlow * (0.45 + 0.75 * mottle);
    vec3 col  = base + rim * fres;

    // Dissolve into darkness toward the bottom of the screen instead of showing a
    // hard elliptical base edge.
    float yFrac = gl_FragCoord.y / max(uResolution.y, 1.0);
    col *= smoothstep(0.0, 0.22, yFrac);

    gl_FragColor = vec4(col, 1.0);
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
  const ventY  = currentVentY();
  const height = coneSlope * R_MAX;
  const apexY  = ventY + coneSlope * RV;
  const baseY  = apexY - height;
  mountainMesh.scale.set(R_MAX, height, R_MAX);
  mountainMesh.position.y = (apexY + baseY) / 2;
}

export const volcano: Pattern = {
  id: "volcano",
  name: "Volcano",
  attribution: "Idea — Loretta",
  heatReactive: true,
  motionControlLabels: ['Eruption Speed'],
  audioControlLabels:  ['Eruption Speed'],
  colorDefaults: { saturation: 1.0, brightness: 1.3 },

  activate() {
    cameraState.heatEnabled = true;
    cameraState.enabled = true;
  },

  controls: [
    { label: "Particle Count", type: "range", min: 3000, max: MAX_PARTICLES, step: 500, default: 24000, tip: "Number of magma and ash particles. More = denser eruption, heavier on GPU.", get: () => particleCount, set: v => { particleCount = Math.round(v); geometry?.setDrawRange(0, particleCount * 6); } },
    { label: "Trail",          type: "range", min: 0,     max: 10,  step: 0.5,  default: 1,     tip: "Streak length behind each particle. 0 = round embers instead of streaks.", get: () => trail,         set: v => { trail = v; } },
    { label: "Streak Width",   type: "range", min: 1,     max: 8,   step: 0.5,  default: 3.5,   tip: "Thickness of each streak, in pixels.",                                   get: () => lineWidth,     set: v => { lineWidth = v; } },
    { label: "Jet Power",      type: "range", min: 0.5,   max: 4,   step: 0.1,  default: 3.3,   tip: "Launch speed out of the vent.",                                          get: () => jetPower,      set: v => { jetPower = v; } },
    { label: "Spread",         type: "range", min: 0,     max: 1.2, step: 0.02, default: 0.54,  tip: "Cone angle of the jet — 0 = a narrow vertical fountain, higher = a wide fan.", get: () => spread,       set: v => { spread = v; } },
    { label: "Gravity",        type: "range", min: 0.5,   max: 4,   step: 0.1,  default: 1.8,   tip: "How hard trajectories arc back down.",                                   get: () => gravity,       set: v => { gravity = v; } },
    { label: "Pulse",          type: "range", min: 0,     max: 1,   step: 0.02, default: 0.9,   tip: "How strongly the eruption surges and eases, like a Strombolian burst.",  get: () => pulse,         set: v => { pulse = v; } },
    { label: "Pulse Rate",     type: "range", min: 0.05,  max: 1.2, step: 0.05, default: 0.5,   tip: "Speed of the surge cycle, in hertz.",                                    get: () => pulseRate,     set: v => { pulseRate = v; } },
    { label: "Eruption Speed", type: "range", min: 0,     max: 2,   step: 0.05, default: 0.15,  tip: "Overall time scale of the eruption. Motion and Audio drive this.",      get: () => eruptionSpeed, set: v => { eruptionSpeed = v; } },
    { label: "Crater Height",  type: "range", min: -1,    max: 1,   step: 0.01, default: -0.39, tip: "Vertical position of the crater — 0 is screen centre, negative is lower.", get: () => craterHeight,  set: v => { craterHeight = v; } },
    { label: "Cone Slope",     type: "range", min: 0.15,  max: 0.7, step: 0.01, default: 0.62,  tip: "Steepness of the volcano's flank.",                                      get: () => coneSlope,     set: v => { coneSlope = v; } },
    { label: "Downhill Flow",  type: "range", min: 0,     max: 1,   step: 0.02, default: 0.12,  tip: "Steady speed of the lava creeping down the cone once landed — independent of Jet Power, so it stays slow even in a tall fountain.", get: () => downhillFlow, set: v => { downhillFlow = v; } },
    { label: "Meander",        type: "range", min: 0,     max: 1.5, step: 0.02, default: 0.18,  tip: "How much the flows braid into channels — and gently sway once landed — instead of running straight down.", get: () => meander, set: v => { meander = v; } },
    { label: "Cooling",        type: "range", min: 0.15,  max: 2,   step: 0.05, default: 0.55,  tip: "How fast magma dims and shrinks from white-hot to dark, cooled grains.", get: () => cooling,       set: v => { cooling = v; } },
    { label: "Ash",            type: "range", min: 0,     max: 0.6, step: 0.01, default: 0.48,  tip: "Fraction of particles that rise as a buoyant ash plume instead of falling as magma.", get: () => ash, set: v => { ash = v; } },
    { label: "Wind",           type: "range", min: -1,    max: 1,   step: 0.02, default: 0.66,  tip: "Sideways drift on the ash plume.",                                       get: () => wind,          set: v => { wind = v; } },
    { label: "", type: "separator" },
    { label: "Mountain",   type: "toggle", tip: "Show the cone as a solid occluder.", get: () => mountainOn, set: v => { mountainOn = v; if (mountainMesh) mountainMesh.visible = v; } },
    { label: "Cone Glow",  type: "range", min: 0, max: 2, step: 0.05, default: 0.3,  tip: "Warm rim light on the volcano's silhouette.", get: () => coneGlow, set: v => { coneGlow = v; } },
    { label: "Rotate",     type: "range", min: -0.3, max: 0.3, step: 0.01, default: 0.02, tip: "Slow orbit of the whole scene around the vent.", get: () => rotate, set: v => { rotate = v; } },
    { label: "Lava Colors", type: "range", min: 0, max: 1, step: 0.05, default: 1, tip: "Crossfade from the app palette to a built-in white-hot → ember incandescent ramp.", get: () => lavaColors, set: v => { lavaColors = v; } },
    { label: "", type: "separator" },
    { label: "Colors v2",     type: "range", min: 0,    max: 3,    step: 0.1,  default: 3,   interactive: 'internal' as const, get: () => colorC2.colorsV2, set: v => { colorC2.colorsV2 = v; } },
    { label: "Heat Strength", type: "range", min: 0,    max: 1.5,  step: 0.05, default: 0.8, interactive: 'heat' as const, tip: "How strongly the heat map shoves the flows aside. Requires Heat.", get: () => heatStrength, set: v => { heatStrength = v; } },
    { label: "Heat Gain",     type: "range", min: 4,    max: 20,   step: 0.5,  default: 14,  interactive: 'heat' as const, tip: "Amplify the heat signal — higher = reacts to subtler motion.",    get: () => heatGain,     set: v => { heatGain = v; } },
    { label: "Blur Radius",   type: "range", min: 0,    max: 10,   step: 0.1,  default: 3,   interactive: 'heat' as const, tip: "Blur applied to the heat map before it drives the flows.",        get: () => blurRadius,   set: v => { blurRadius = v; } },
  ],

  init(ctx: PatternContext) {
    sceneRef = ctx.scene;
    vpWidth  = ctx.size.width;
    vpHeight = ctx.size.height;
    ctx.camera.position.set(0, 0.35, CAM_Z);
    ctx.camera.lookAt(0, LOOKAT_Y, 0);

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
        uVentY:        { value: currentVentY() },
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
      uniforms: {
        uGlow:       { value: coneGlow },
        uResolution: { value: new THREE.Vector2(vpWidth, vpHeight) },
      },
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
    u.uVentY.value      = currentVentY();
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
    if (mountainMat) (mountainMat.uniforms.uResolution.value as THREE.Vector2).set(w, h);
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
